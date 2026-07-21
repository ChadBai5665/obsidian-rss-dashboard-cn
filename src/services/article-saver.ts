import { App, Notice, TFile, moment } from "obsidian";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import {
  ArticleSavingSettings,
  type CollectionSettings,
  FeedItem,
} from "../types/types";
import type { ContentBasis } from "../collection/collected-item";
import { CollectionRepository } from "../collection/collection-repository";
import { ExplicitContentCoordinator } from "../collection/explicit-content-coordinator";
import { createCollectedItemId } from "../collection/item-identity";
import { type FullArticleFetchResult } from "../utils/fetch-helpers";
import {
  fetchFullArticleContentWithOutcome,
  RESTRICTED_ARTICLE_NOTICE,
  RESTRICTED_ARTICLE_REASON,
} from "../utils/full-article-fetch";
import { ensureUtf8Meta } from "../utils/platform-utils";
import { withSavedTagName } from "../utils/tag-utils";
import { isLikelyVideoItem } from "../utils/video-detection";
import {
  htmlToReadableText,
  stripNonContentHtmlNodes,
} from "../utils/html-text";
import { normalizeSubstackImageUrl } from "../utils/substack-image-url";
import { isYouTubeItem } from "../utils/youtube-detection";

const STABLE_ITEM_ID = /^[a-f0-9]{64}$/;
const savedNoteQueues = new WeakMap<object, Map<string, Promise<void>>>();
const SAVED_NOTE_SYNC_WARNING =
  "[RSS Dashboard] Saved-note metadata sync failed; the note remains valid and will be repaired later.";

export function sanitizeFilename(name: string): string {
  const sanitized = name
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return sanitized || "Untitled Article";
}

export class ArticleSaver {
  private app: App;
  private settings: ArticleSavingSettings;
  private turndownService: TurndownService;
  private corsProxyUrl: string | undefined;
  private collectionSettings: CollectionSettings | undefined;
  private explicitContentCoordinator: ExplicitContentCoordinator | undefined;

  constructor(
    app: App,
    settings: ArticleSavingSettings,
    corsProxyUrl?: string,
    collectionSettings?: CollectionSettings,
  ) {
    this.app = app;
    this.settings = settings;
    this.corsProxyUrl = corsProxyUrl;
    this.collectionSettings = collectionSettings;
    this.turndownService = new TurndownService();

    this.turndownService.addRule("math", {
      filter: (node: Node) =>
        node.nodeName === "SPAN" &&
        (node as Element).classList.contains("math"),
      replacement: (_content: string, node: Node) => node.textContent || "",
    });
  }

  private cleanHtml(html: string): string {
    try {
      const htmlWithMeta = ensureUtf8Meta(html);
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlWithMeta, "text/html");

      const elementsToRemove = doc.querySelectorAll(
        "script, style, iframe, noscript, template, svg, link, meta, base, object, embed, .ad, .ads, .advertisement, " +
          "div[class*='ad-'], div[id*='ad-'], div[class*='ads-'], div[id*='ads-']",
      );
      elementsToRemove.forEach((el) => el.remove());

      doc.querySelectorAll("img").forEach((img) => {
        const src = img.getAttribute("src");
        if (src && !src.startsWith("http") && !src.startsWith("data:")) {
          if (src.startsWith("/")) {
            const baseUrl = new URL(location.href);
            img.setAttribute("src", `${baseUrl.origin}${src}`);
          }
        }

        if (!img.hasAttribute("alt")) {
          img.setAttribute("alt", "Image");
        }
      });

      doc.querySelectorAll("a").forEach((link) => {
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
      });

      doc.querySelectorAll("table").forEach((table) => {
        table.classList.add("markdown-compatible-table");
      });

      return doc.body.innerHTML;
    } catch {
      return html;
    }
  }

  private getPreferredFeedHtml(item: FeedItem): string {
    return item.content || item.description || item.summary || "";
  }

  private shouldPreferFeedHtml(item: FeedItem, feedHtml: string): boolean {
    if (!feedHtml) return false;

    if (item.link) {
      try {
        const host = new URL(item.link).hostname.toLowerCase();
        if (host === "substack.com" || host.endsWith(".substack.com")) {
          return true;
        }
      } catch {
        // Fall through to markup-based detection.
      }
    }

    const lower = feedHtml.toLowerCase();
    return (
      lower.includes('data-component-name="image2todom"') ||
      lower.includes('class="image-link image2 is-viewable-img"') ||
      lower.includes("substackcdn.com/image/fetch/")
    );
  }

  private getReadableTextLength(html: string): number {
    return htmlToReadableText(html).length;
  }

  private normalizeBlockLinksForMarkdown(html: string): string {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");

      doc.querySelectorAll("a").forEach((link) => {
        const href = link.getAttribute("href") || "";
        const hasInlineImage = !!link.querySelector("img, picture img");
        const hasBlockContent = !!link.querySelector(
          "address, article, aside, blockquote, br, dd, div, dl, dt, figcaption, figure, footer, h1, h2, h3, h4, h5, h6, header, hr, li, main, nav, ol, p, pre, section, table, ul",
        );
        if (!hasBlockContent && !hasInlineImage) return;

        link.querySelectorAll("br").forEach((br) => {
          br.replaceWith(doc.createTextNode(" "));
        });

        const label = (link.textContent || "").replace(/\s+/g, " ").trim();
        if (label) {
          link.textContent = label;
          return;
        }

        if (hasInlineImage) {
          const fragment = doc.createDocumentFragment();
          while (link.firstChild) {
            fragment.appendChild(link.firstChild);
          }

          if (href) {
            link.setAttribute("href", normalizeSubstackImageUrl(href));
          }

          link.replaceWith(fragment);
        }
      });

      return doc.body.innerHTML;
    } catch {
      return html;
    }
  }

  private getFallbackHeroUrl(item: FeedItem): string {
    const enclosureImageUrl =
      item.enclosure?.type?.startsWith("image/") && item.enclosure.url
        ? item.enclosure.url
        : "";

    const heroUrl =
      item.coverImage ||
      item.image ||
      item.itunes?.image?.href ||
      enclosureImageUrl ||
      "";

    return normalizeSubstackImageUrl((heroUrl || "").trim());
  }

  private htmlAlreadyContainsImage(html: string, imageUrl: string): boolean {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      return Array.from(doc.querySelectorAll("img")).some(
        (img) =>
          normalizeSubstackImageUrl(img.getAttribute("src") || "") === imageUrl,
      );
    } catch {
      return false;
    }
  }

  private prependFallbackHeroHtml(item: FeedItem, html: string): string {
    if (!html) return html;

    const heroUrl = this.getFallbackHeroUrl(item);
    if (!heroUrl) return html;
    if (this.htmlAlreadyContainsImage(html, heroUrl)) return html;

    return `<p><img src="${heroUrl}" alt="Hero image" /></p>${html}`;
  }

  private prependFallbackHeroMarkdown(
    item: FeedItem,
    markdown: string,
    sourceHtml: string,
  ): string {
    if (!markdown) return markdown;

    const heroUrl = this.getFallbackHeroUrl(item);
    if (!heroUrl) return markdown;

    if (this.htmlAlreadyContainsImage(sourceHtml, heroUrl)) {
      return markdown;
    }

    if (markdown.includes(heroUrl)) {
      return markdown;
    }

    return `![Hero image](${heroUrl})\n\n${markdown}`;
  }

  private htmlToMarkdown(html: string): string {
    const cleaned = stripNonContentHtmlNodes(html);
    const normalized = this.normalizeBlockLinksForMarkdown(cleaned);
    return this.turndownService.turndown(normalized);
  }

  private generateFrontmatter(item: FeedItem): string {
    let frontmatter = this.settings.frontmatterTemplate;

    if (!frontmatter) {
      frontmatter = `---
        title: "{{title}}"
        date: "{{date}}"
        tags: [{{tags}}]
        source: "{{source}}"
        link: "{{link}}"
        author: "{{author}}"
        feedTitle: "{{feedTitle}}"
        guid: "{{guid}}"
        ---`;
    }

    const tagNames = (item.tags ?? [])
      .map((tag) => tag.name)
      .filter(
        (name): name is string =>
          typeof name === "string" && name.trim() !== "",
      );

    if (this.settings.addSavedTag) {
      tagNames.splice(0, tagNames.length, ...withSavedTagName(tagNames));
    }

    const tagsString = tagNames.join(", ");

    const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();

    frontmatter = this.replaceTemplateValues(
      this.replaceDatePlaceholders(frontmatter, pubDate),
      item,
      "",
      tagsString,
      true,
    );

    if (item.mediaType === "video" && item.videoId) {
      const injection = `mediaType: video\nvideoId: "${item.videoId}"\n`;
      frontmatter = frontmatter.replace(/^---\r?\n/, (m) => `${m}${injection}`);
    } else if (item.mediaType === "podcast" && item.audioUrl) {
      const injection = `mediaType: podcast\naudioUrl: "${item.audioUrl}"\n`;
      frontmatter = frontmatter.replace(/^---\r?\n/, (m) => `${m}${injection}`);
    }

    return frontmatter.endsWith("\n") ? frontmatter : `${frontmatter}\n`;
  }

  private sanitizeFilename(name: string): string {
    return sanitizeFilename(name);
  }

  private formatMoment(date: Date, formatStr: string): string {
    type MomentFactory = (input: Date) => { format: (fmt: string) => string };
    return (moment as unknown as MomentFactory)(date).format(formatStr);
  }

  private replaceDatePlaceholders(text: string, date: Date): string {
    const validDate = Number.isNaN(date.getTime()) ? new Date() : date;
    const isoDateTime = validDate.toISOString();

    const longFormattedDate = validDate.toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    let replaced = text
      .replace(/{{date}}/g, longFormattedDate)
      .replace(/{{dateShort}}/g, this.formatMoment(validDate, "YYYY-MM-DD"))
      .replace(/{{isoDate}}/g, isoDateTime)
      .replace(/{{isoDateTime}}/g, isoDateTime);

    // Handle dynamic formats: {{date:FORMAT}}
    replaced = replaced.replace(
      /{{date:(.+?)}}/g,
      (_match: string, format: string) => {
        return this.formatMoment(validDate, format);
      },
    );

    return replaced;
  }

  private applyTemplate(
    item: FeedItem,
    template: string,
    rawContent?: string,
  ): string {
    const content = rawContent !== undefined
      ? rawContent
      : this.prependFallbackHeroHtml(
          item,
          this.cleanHtml(this.getPreferredFeedHtml(item)),
        );

    const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();

    const tagNames = (item.tags ?? [])
      .map((tag) => tag.name)
      .filter(
        (name): name is string =>
          typeof name === "string" && name.trim() !== "",
      );
    const tagsString = this.settings.addSavedTag
      ? withSavedTagName(tagNames).join(", ")
      : tagNames.join(", ");

    const replacedWithDates = this.replaceDatePlaceholders(template, pubDate);
    const frontmatter = replacedWithDates.match(
      /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
    );
    if (!frontmatter) {
      return this.replaceTemplateValues(
        replacedWithDates,
        item,
        content,
        tagsString,
        false,
      );
    }
    return (
      this.replaceTemplateValues(
        frontmatter[0],
        item,
        content,
        tagsString,
        true,
      ) +
      this.replaceTemplateValues(
        replacedWithDates.slice(frontmatter[0].length),
        item,
        content,
        tagsString,
        false,
      )
    );
  }

  private replaceTemplateValues(
    template: string,
    item: FeedItem,
    content: string,
    tags: string,
    frontmatterSafe: boolean,
  ): string {
    const value = (raw: string): string =>
      frontmatterSafe ? this.escapeFrontmatterTemplateValue(raw) : raw;
    const replacements: Array<[RegExp, string]> = [
      [/{{title}}/g, value(item.title)],
      [/{{link}}/g, value(item.link)],
      [/{{author}}/g, value(item.author || "")],
      [/{{source}}/g, value(item.feedTitle)],
      [/{{feedTitle}}/g, value(item.feedTitle)],
      [/{{summary}}/g, value(item.summary || "")],
      [/{{content}}/g, value(content)],
      [/{{tags}}/g, value(tags)],
      [/{{guid}}/g, value(item.guid)],
      [/{{image}}/g, value(this.getFallbackHeroUrl(item))],
    ];
    return replacements.reduce(
      (result, [pattern, replacement]) =>
        result.replace(pattern, () => replacement),
      template,
    );
  }

  private escapeFrontmatterTemplateValue(value: string): string {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n");
  }

  private normalizePath(path: string): string {
    if (!path || path.trim() === "") {
      return "";
    }

    return path
      .replace(/[\\:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .replace(/^[/\s]+|[/\s]+$/g, "");
  }

  private isMissingPathError(error: unknown): boolean {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error);

    return (
      message.includes("enoent") ||
      message.includes("enonet") ||
      message.includes("no such file")
    );
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    if (!folderPath || folderPath.trim() === "") {
      return;
    }

    const cleanPath = this.normalizePath(folderPath);
    if (!cleanPath) {
      return;
    }

    try {
      const parts = cleanPath.split("/").filter((part) => part.trim() !== "");
      let currentPath = "";

      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        if (this.app.vault.getAbstractFileByPath(currentPath) === null) {
          await this.app.vault.createFolder(currentPath);
        }
      }
    } catch {
      throw new Error(`Failed to create folder: ${cleanPath}`);
    }
  }

  async fetchFullArticleContent(url: string): Promise<string> {
    const result = await this.fetchArticleContentWithOutcome(url);
    return result.content;
  }

  private async fetchArticleContentWithOutcome(
    url: string,
  ): Promise<FullArticleFetchResult> {
    return fetchFullArticleContentWithOutcome(url, this.corsProxyUrl);
  }

  private extractContentFromDocument(doc: Document, url: string): string {
    if (typeof Readability !== "undefined") {
      const article = new Readability(doc).parse();
      const content = article?.content || "";
      return this.convertRelativeUrlsInContent(content, url);
    }

    const mainContent = doc.querySelector(
      "main, article, .content, .post-content, .entry-content, .article-content, .full-text",
    );
    if (mainContent) {
      return this.convertRelativeUrlsInContent(
        new XMLSerializer().serializeToString(mainContent),
        url,
      );
    }

    const contentSelectors = [
      ".article-body",
      ".article-text",
      ".fulltext",
      ".full-text",
      ".content-body",
      ".main-content",
      'section[role="main"]',
      ".article",
    ];

    for (const selector of contentSelectors) {
      const element = doc.querySelector(selector);
      if (element) {
        return this.convertRelativeUrlsInContent(
          new XMLSerializer().serializeToString(element),
          url,
        );
      }
    }

    return this.convertRelativeUrlsInContent(
      new XMLSerializer().serializeToString(doc.body),
      url,
    );
  }

  private convertRelativeUrlsInContent(
    content: string,
    baseUrl: string,
  ): string {
    if (!content || !baseUrl) return content;

    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(content, "text/html");

      doc.querySelectorAll("img").forEach((img) => {
        let src = img.getAttribute("src");

        const dataAttrs = img.getAttribute("data-attrs");
        if (dataAttrs) {
          try {
            const attrs = JSON.parse(dataAttrs) as { src?: string };
            if (attrs.src && typeof attrs.src === "string") {
              src = attrs.src;
            }
          } catch {
            // ignore
          }
        }

        if (src) {
          img.setAttribute(
            "src",
            this.convertToAbsoluteUrl(src.trim(), baseUrl),
          );
        }

        const srcset = img.getAttribute("srcset");
        if (srcset) {
          img.setAttribute("srcset", this.processSrcset(srcset, baseUrl));
        }

        [
          "data-src",
          "data-srcset",
          "data-original",
          "data-delayed-url",
        ].forEach((attrName) => {
          const val = img.getAttribute(attrName);
          if (!val) return;

          if (attrName.includes("srcset")) {
            img.setAttribute(attrName, this.processSrcset(val, baseUrl));
          } else {
            img.setAttribute(
              attrName,
              this.convertToAbsoluteUrl(val.trim(), baseUrl),
            );
          }
        });
      });

      doc.querySelectorAll("source").forEach((source) => {
        const srcset = source.getAttribute("srcset");
        if (srcset) {
          source.setAttribute("srcset", this.processSrcset(srcset, baseUrl));
        }

        const dataSrcset = source.getAttribute("data-srcset");
        if (dataSrcset) {
          source.setAttribute(
            "data-srcset",
            this.processSrcset(dataSrcset, baseUrl),
          );
        }
      });

      doc.querySelectorAll("a").forEach((a) => {
        const href = a.getAttribute("href");
        if (href) {
          a.setAttribute("href", this.convertToAbsoluteUrl(href, baseUrl));
        }
      });

      doc.querySelectorAll("iframe").forEach((iframe) => {
        const src = iframe.getAttribute("src");
        if (src) {
          iframe.setAttribute("src", this.convertToAbsoluteUrl(src, baseUrl));
        }
      });

      return doc.body.innerHTML;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        "[RSS Dashboard] Failed to convert relative URLs in ArticleSaver:",
        errorMessage,
      );
      return content;
    }
  }

  private convertToAbsoluteUrl(relativeUrl: string, baseUrl: string): string {
    if (!relativeUrl || !baseUrl) return relativeUrl;

    if (relativeUrl.startsWith("app://")) {
      return relativeUrl.replace("app://", "https://");
    }

    if (relativeUrl.startsWith("//")) {
      return `https:${relativeUrl}`;
    }

    if (
      relativeUrl.startsWith("http://") ||
      relativeUrl.startsWith("https://")
    ) {
      return relativeUrl;
    }

    try {
      const base = new URL(baseUrl);

      if (relativeUrl.startsWith("/")) {
        return `${base.protocol}//${base.host}${relativeUrl}`;
      }

      return new URL(relativeUrl, base).href;
    } catch {
      return relativeUrl;
    }
  }

  private processSrcset(srcset: string, baseUrl: string): string {
    if (!srcset) return "";

    return srcset
      .split(/,\s+|,(?=https?:|\/\/)/)
      .map((part) => {
        const trimmedPart = part.trim();
        const urlMatch = trimmedPart.match(/^([^\s]+)(\s+\d+w|\s+\d+x)?$/);
        if (urlMatch) {
          const url = urlMatch[1];
          const sizeDescriptor = urlMatch[2] || "";
          return (
            this.convertToAbsoluteUrl(url.trim(), baseUrl) + sizeDescriptor
          );
        }
        return trimmedPart;
      })
      .join(", ");
  }

  async saveArticleWithFullContent(
    item: FeedItem,
    customFolder?: string,
    customTemplate?: string,
  ): Promise<TFile | null> {
    try {
      const folder = this.resolveSavedNoteFolder(customFolder);
      return await this.withSavedNoteLock(folder, async () => {
        const itemId = this.resolveStableItemId(item);
        const existing = await this.findNoteByStableId(folder, itemId);
        if (existing) {
          return await this.returnExistingNote(item, existing, itemId);
        }

        if (isYouTubeItem(item)) {
          const descriptionHtml = item.description || item.summary || "";
          const description = descriptionHtml
            ? this.htmlToMarkdown(descriptionHtml)
            : "";
          return await this.saveArticleUnlocked({
            item,
            folder,
            customTemplate,
            rawContent: description,
            contentBasis: "title-description",
            itemId,
          });
        }

        if (isLikelyVideoItem(item)) {
          return await this.saveArticleUnlocked({
            item,
            folder,
            customTemplate,
            contentBasis: "feed",
            itemId,
          });
        }

        const feedContent = this.getPreferredFeedHtml(item);
        const fetchExplicitly = async (): Promise<FullArticleFetchResult> => {
          const loadingNotice = new Notice(
            "Fetching full article content...",
            0,
          );
          try {
            return await this.fetchArticleContentWithOutcome(item.link);
          } catch {
            return { content: "", failureType: "network" };
          } finally {
            loadingNotice.hide();
          }
        };
        const fetchResult = this.collectionSettings
          ? await this.getExplicitContentCoordinator().readOrFetch({
              dataRoot: this.collectionSettings.dataFolder,
              itemId,
              sourceUrl: item.link || undefined,
              fetch: fetchExplicitly,
            })
          : await fetchExplicitly();

        if (!fetchResult.content) {
          if (fetchResult.failureType === "restricted") {
            new Notice(RESTRICTED_ARTICLE_NOTICE);
            item.restrictedReason = RESTRICTED_ARTICLE_REASON;
          } else {
            new Notice(
              "Could not fetch full content. Saving with available content.",
            );
          }
          const fallbackMarkdown = feedContent
            ? this.htmlToMarkdown(feedContent)
            : undefined;
          const fallbackWithHero = fallbackMarkdown
            ? this.prependFallbackHeroMarkdown(
                item,
                fallbackMarkdown,
                feedContent,
              )
            : undefined;
          return await this.saveArticleUnlocked({
            item,
            folder,
            customTemplate,
            rawContent: fallbackWithHero,
            contentBasis: "feed",
            itemId,
          });
        }

        const fetchedTextLength = this.getReadableTextLength(
          fetchResult.content,
        );
        const feedTextLength = this.getReadableTextLength(feedContent);
        const useFeedContent = this.shouldPreferFeedHtml(item, feedContent)
          ? Boolean(feedContent)
          : Boolean(feedContent && feedTextLength > fetchedTextLength);
        const contentSource = useFeedContent
          ? feedContent
          : fetchResult.content;
        const markdownContent = this.prependFallbackHeroMarkdown(
          item,
          this.htmlToMarkdown(contentSource),
          contentSource,
        );

        return await this.saveArticleUnlocked({
          item,
          folder,
          customTemplate,
          rawContent: markdownContent,
          contentBasis: useFeedContent ? "feed" : "full-text",
          itemId,
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Error saving article with full content: ${message}`);
      return null;
    }
  }

  async saveArticle(
    item: FeedItem,
    customFolder?: string,
    customTemplate?: string,
    rawContent?: string,
  ): Promise<TFile | null> {
    try {
      const folder = this.resolveSavedNoteFolder(customFolder);
      const youtube = isYouTubeItem(item);
      const safeRawContent = youtube
        ? this.htmlToMarkdown(item.description || item.summary || "")
        : rawContent;
      return await this.withSavedNoteLock(folder, async () =>
        await this.saveArticleUnlocked({
          item,
          folder,
          customTemplate,
          rawContent: safeRawContent,
          contentBasis: youtube ? "title-description" : "feed",
          itemId: this.resolveStableItemId(item),
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Error saving article: ${message}`);
      return null;
    }
  }

  private async saveArticleUnlocked(input: {
    item: FeedItem;
    folder: string;
    customTemplate?: string;
    rawContent?: string;
    contentBasis: ContentBasis;
    itemId: string;
  }): Promise<TFile> {
    const existing = await this.findNoteByStableId(input.folder, input.itemId);
    if (existing) {
      return await this.returnExistingNote(input.item, existing, input.itemId);
    }

    if (input.folder) await this.ensureFolderExists(input.folder);
    const filePath = await this.selectCollisionSafePath(
      input.folder,
      input.item.title,
      input.itemId,
    );
    const template =
      input.customTemplate ||
      this.settings.defaultTemplate ||
      "# {{title}}\n\n{{content}}\n\n[Source]({{link}})";
    let contentToWrite = "";
    const templateHasFrontmatter = template.trim().startsWith("---");
    if (this.settings.includeFrontmatter && !templateHasFrontmatter) {
      contentToWrite += this.generateFrontmatter(input.item);
    }
    contentToWrite += this.applyTemplate(
      input.item,
      template,
      input.rawContent,
    );
    contentToWrite = this.addOwnedFrontmatter(contentToWrite, {
      itemId: input.itemId,
      item: input.item,
      contentBasis: input.contentBasis,
    });

    let file: TFile;
    try {
      file = await this.app.vault.create(filePath, contentToWrite);
    } catch (error) {
      const raced = this.app.vault.getAbstractFileByPath(filePath);
      if (
        raced instanceof TFile &&
        (await this.readOwnedStableId(raced)) === input.itemId
      ) {
        return await this.returnExistingNote(input.item, raced, input.itemId);
      }
      if (!(input.folder && this.isMissingPathError(error))) throw error;
      await this.ensureFolderExists(input.folder);
      file = await this.app.vault.create(filePath, contentToWrite);
    }

    this.applySavedState(input.item, file.path);
    await this.syncSavedNoteMetadata(input.itemId, input.item, file.path);
    new Notice(
      "Article saved. Click/tap the icon again to open the article in your vault.",
    );
    return file;
  }

  private resolveSavedNoteFolder(customFolder?: string): string {
    const configured =
      customFolder ??
      this.collectionSettings?.savedNoteFolder ??
      this.settings.defaultFolder ??
      "";
    const trimmed = configured.trim();
    if (!trimmed) return "";
    if (
      trimmed.includes("\\") ||
      trimmed.includes("\0") ||
      /^[A-Za-z]:/.test(trimmed)
    ) {
      throw new Error("Invalid saved-note folder path.");
    }
    const withoutEdgeSlashes = trimmed.replace(/^\/+|\/+$/g, "");
    const segments = withoutEdgeSlashes.split("/");
    if (
      !withoutEdgeSlashes ||
      segments.some(
        (segment) => segment === "" || segment === "." || segment === "..",
      )
    ) {
      throw new Error("Invalid saved-note folder path.");
    }
    const normalized = this.normalizePath(withoutEdgeSlashes);
    if (!normalized) throw new Error("Invalid saved-note folder path.");
    return normalized;
  }

  private resolveStableItemId(item: FeedItem): string {
    if (item.rssDashboardId !== undefined) {
      if (!STABLE_ITEM_ID.test(item.rssDashboardId)) {
        throw new Error("Invalid RSS Dashboard item ID.");
      }
      return item.rssDashboardId;
    }
    const itemId = createCollectedItemId({
      sourceId: item.feedUrl || item.feedTitle || "rss-dashboard",
      guid: item.guid,
      url: item.link,
      title: item.title,
      author: item.author,
      publishedAt: item.pubDate,
    });
    item.rssDashboardId = itemId;
    return itemId;
  }

  private async withSavedNoteLock<T>(
    folder: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const queues =
      savedNoteQueues.get(this.app.vault) ??
      new Map<string, Promise<void>>();
    savedNoteQueues.set(this.app.vault, queues);
    const prior = queues.get(folder) ?? Promise.resolve();
    const running = prior.catch(() => undefined).then(operation);
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    queues.set(folder, settled);
    try {
      return await running;
    } finally {
      if (queues.get(folder) === settled) queues.delete(folder);
      if (queues.size === 0) savedNoteQueues.delete(this.app.vault);
    }
  }

  private async findNoteByStableId(
    folder: string,
    itemId: string,
  ): Promise<TFile | null> {
    const files = this.app.vault
      .getFiles()
      .filter(
        (file) =>
          file.extension === "md" && this.isPathInsideFolder(file.path, folder),
      )
      .sort((left, right) => left.path.localeCompare(right.path));
    for (const file of files) {
      if ((await this.readOwnedStableId(file)) === itemId) return file;
    }
    return null;
  }

  private isPathInsideFolder(path: string, folder: string): boolean {
    if (!folder) return !path.startsWith("/");
    return path.startsWith(`${folder}/`);
  }

  private async readOwnedStableId(file: TFile): Promise<string | null> {
    const raw = await this.app.vault.read(file);
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) return null;
    for (const line of match[1].split(/\r?\n/)) {
      const field = line.match(/^rssDashboardId:\s*(.+?)\s*$/);
      if (!field) continue;
      try {
        const parsed: unknown = JSON.parse(field[1]);
        return typeof parsed === "string" && STABLE_ITEM_ID.test(parsed)
          ? parsed
          : null;
      } catch {
        return STABLE_ITEM_ID.test(field[1]) ? field[1] : null;
      }
    }
    return null;
  }

  private async selectCollisionSafePath(
    folder: string,
    title: string,
    itemId: string,
  ): Promise<string> {
    const filename = sanitizeFilename(title);
    const candidates = [
      filename,
      `${filename}-${itemId.slice(0, 8)}`,
      `${filename}-${itemId.slice(0, 12)}`,
    ];
    for (const candidate of candidates) {
      const path = folder ? `${folder}/${candidate}.md` : `${candidate}.md`;
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing === null) return path;
      if (
        existing instanceof TFile &&
        (await this.readOwnedStableId(existing)) === itemId
      ) {
        return existing.path;
      }
    }
    throw new Error(
      `Cannot save article: all deterministic filenames for item ${itemId} are already occupied.`,
    );
  }

  private addOwnedFrontmatter(
    content: string,
    input: { itemId: string; item: FeedItem; contentBasis: ContentBasis },
  ): string {
    const ownedLines = [
      `rssDashboardId: ${JSON.stringify(input.itemId)}`,
      `source: ${JSON.stringify(input.item.feedTitle || "")}`,
      `sourceUrl: ${JSON.stringify(input.item.link || "")}`,
      `publishedAt: ${JSON.stringify(input.item.pubDate || "")}`,
      `savedAt: ${JSON.stringify(new Date().toISOString())}`,
      `contentBasis: ${JSON.stringify(input.contentBasis)}`,
    ];
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) return `---\n${ownedLines.join("\n")}\n---\n\n${content}`;
    const ownedKeys = new Set([
      "rssDashboardId",
      "source",
      "sourceUrl",
      "publishedAt",
      "savedAt",
      "contentBasis",
    ]);
    const retained = match[1].split(/\r?\n/).filter((line) => {
      const key = line.match(/^\s*([A-Za-z][A-Za-z0-9]*):/)?.[1];
      return !key || !ownedKeys.has(key);
    });
    const frontmatter = [...ownedLines, ...retained].join("\n");
    return `---\n${frontmatter}\n---\n${content.slice(match[0].length)}`;
  }

  private applySavedState(item: FeedItem, filePath: string): void {
    item.saved = true;
    item.savedFilePath = filePath;
    if (
      this.settings.addSavedTag &&
      (!item.tags || !item.tags.some((tag) => tag.name.toLowerCase() === "saved"))
    ) {
      const savedTag = { name: "Saved", color: "#3498db" };
      if (!item.tags) item.tags = [savedTag];
      else item.tags.push(savedTag);
    }
  }

  private async returnExistingNote(
    item: FeedItem,
    file: TFile,
    itemId: string,
  ): Promise<TFile> {
    this.applySavedState(item, file.path);
    await this.syncSavedNoteMetadata(itemId, item, file.path);
    const leaf = this.app.workspace.getLeaf(false) as unknown as {
      openFile?: (target: TFile) => Promise<void>;
    };
    if (typeof leaf.openFile === "function") await leaf.openFile(file);
    return file;
  }

  private async syncSavedNoteMetadata(
    itemId: string,
    item: FeedItem,
    filePath: string,
  ): Promise<void> {
    if (!this.collectionSettings) return;
    try {
      await new CollectionRepository(
        this.app.vault,
        this.collectionSettings.dataFolder,
        () => new Date(),
      ).updateFlags(itemId, {
        read: item.read ?? false,
        starred: item.starred ?? false,
        saved: true,
        savedNotePath: filePath,
      });
    } catch {
      console.warn(SAVED_NOTE_SYNC_WARNING);
    }
  }

  private getExplicitContentCoordinator(): ExplicitContentCoordinator {
    this.explicitContentCoordinator ??= new ExplicitContentCoordinator(
      this.app.vault,
    );
    return this.explicitContentCoordinator;
  }

  async fixSavedFilePaths(articles: FeedItem[]): Promise<void> {
    for (const article of articles) {
      if (!article.saved || !article.savedFilePath) continue;

      const oldPath = article.savedFilePath;
      const normalizedPath = this.normalizePath(oldPath);
      if (oldPath === normalizedPath) continue;

      if (this.app.vault.getAbstractFileByPath(normalizedPath) !== null) {
        article.savedFilePath = normalizedPath;
        continue;
      }

      const file = this.app.vault.getAbstractFileByPath(oldPath);
      if (!(file instanceof TFile)) {
        article.saved = false;
        article.savedFilePath = undefined;
        if (article.tags) {
          article.tags = article.tags.filter(
            (tag) => tag.name.toLowerCase() !== "saved",
          );
        }
        continue;
      }

      try {
        const normalizedFolder = this.normalizePath(
          this.settings.defaultFolder || "",
        );
        const filename = sanitizeFilename(article.title);
        const newName = `${filename}.md`;
        const newPath =
          normalizedFolder && normalizedFolder.trim() !== ""
            ? `${normalizedFolder}/${newName}`
            : newName;

        await this.app.fileManager.renameFile(file, newPath);
        article.savedFilePath = newPath;
      } catch {
        article.saved = false;
        article.savedFilePath = undefined;
        if (article.tags) {
          article.tags = article.tags.filter(
            (tag) => tag.name.toLowerCase() !== "saved",
          );
        }
      }
    }
  }

  verifySavedArticle(article: FeedItem): boolean {
    if (!article.saved || !article.savedFilePath) {
      return false;
    }

    try {
      const file = this.app.vault.getAbstractFileByPath(article.savedFilePath);
      if (file !== null) {
        return true;
      }

      article.saved = false;
      article.savedFilePath = undefined;

      if (article.tags) {
        article.tags = article.tags.filter(
          (tag) => tag.name.toLowerCase() !== "saved",
        );
      }

      return false;
    } catch {
      return false;
    }
  }

  verifyAllSavedArticles(articles: FeedItem[]): void {
    articles
      .filter((article) => article.saved)
      .forEach((article) => {
        this.verifySavedArticle(article);
      });
  }

  checkSavedFileExists(item: FeedItem): boolean {
    if (!item.saved) {
      return false;
    }

    try {
      const savedPath = this.normalizePath(item.savedFilePath || "");
      if (savedPath) {
        const savedFile = this.app.vault.getAbstractFileByPath(savedPath);
        if (savedFile instanceof TFile) {
          if (item.savedFilePath !== savedPath) {
            item.savedFilePath = savedPath;
          }
          return true;
        }
      }

      const fallbackPath = this.buildSavedArticleFilePath(item);
      if (!fallbackPath) {
        return false;
      }

      const fallbackFile = this.app.vault.getAbstractFileByPath(fallbackPath);
      if (fallbackFile instanceof TFile) {
        item.savedFilePath = fallbackPath;
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  async findSavedArticleFile(article: FeedItem): Promise<TFile | null> {
    if (!article.saved) {
      return null;
    }

    const savedPath = this.normalizePath(article.savedFilePath || "");
    if (savedPath) {
      const savedFile = this.app.vault.getAbstractFileByPath(savedPath);
      if (savedFile instanceof TFile) {
        if (article.savedFilePath !== savedPath) {
          article.savedFilePath = savedPath;
        }
        return savedFile;
      }
    }

    const fallbackPath = this.buildSavedArticleFilePath(article);
    if (!fallbackPath) {
      return null;
    }

    const fallbackFile = this.app.vault.getAbstractFileByPath(fallbackPath);
    if (fallbackFile instanceof TFile) {
      article.savedFilePath = fallbackPath;
      return fallbackFile;
    }

    return null;
  }

  private buildSavedArticleFilePath(item: FeedItem): string {
    const folder = this.normalizePath(this.settings.defaultFolder || "");
    const filename = this.sanitizeFilename(item.title);

    if (!filename) {
      return "";
    }

    return folder ? `${folder}/${filename}.md` : `${filename}.md`;
  }
}

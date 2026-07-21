import {
  App,
  Notice,
  TFile,
  TFolder,
  moment,
  type TAbstractFile,
} from "obsidian";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import {
  Document as YamlDocument,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  YAMLMap,
} from "yaml";
import {
  ArticleSavingSettings,
  type CollectionSettings,
  FeedItem,
} from "../types/types";
import type { ContentBasis } from "../collection/collected-item";
import { CollectionRepository } from "../collection/collection-repository";
import { ExplicitContentCoordinator } from "../collection/explicit-content-coordinator";
import {
  canonicalizeUrl,
  resolveFeedItemStableId,
} from "../collection/item-identity";
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
const OWNED_FRONTMATTER_KEYS = [
  "rssDashboardId",
  "source",
  "sourceUrl",
  "publishedAt",
  "savedAt",
  "contentBasis",
] as const;
const OWNED_FRONTMATTER_KEY_SET = new Set<string>(OWNED_FRONTMATTER_KEYS);
const savedNoteQueues = new WeakMap<object, Map<string, Promise<void>>>();
const SAVED_NOTE_SYNC_WARNING =
  "[RSS Dashboard] Saved-note metadata sync failed; the note remains valid and will be repaired later.";
const LEGACY_NOTE_MIGRATION_WARNING =
  "[RSS Dashboard] Saved note ownership could not be verified; the existing path was left unchanged for manual review.";

export function sanitizeFilename(name: string): string {
  const sanitized = name
    .normalize("NFC")
    .split("")
    .filter((character) => !isControlCharacter(character))
    .join("")
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");

  return sanitized || "Untitled Article";
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some(isControlCharacter);
}

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
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

    const tagNames = this.resolveTagNames(item);

    const additions: Record<string, string> = {};
    if (item.mediaType === "video" && item.videoId) {
      additions.mediaType = "video";
      additions.videoId = item.videoId;
    } else if (item.mediaType === "podcast" && item.audioUrl) {
      additions.mediaType = "podcast";
      additions.audioUrl = item.audioUrl;
    }

    return this.renderFrontmatterTemplate(
      frontmatter,
      item,
      "",
      tagNames,
      item.pubDate ? new Date(item.pubDate) : new Date(),
      additions,
    );
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

    const tagNames = this.resolveTagNames(item);
    const tagsString = tagNames.join(", ");

    const frontmatter = this.extractFrontmatter(template);
    if (!frontmatter) {
      return this.replaceTemplateValues(
        this.replaceDatePlaceholders(template, pubDate),
        item,
        content,
        tagsString,
      );
    }
    return (
      this.renderFrontmatterTemplate(
        frontmatter.yaml,
        item,
        content,
        tagNames,
        pubDate,
      ) +
      this.replaceTemplateValues(
        this.replaceDatePlaceholders(frontmatter.body, pubDate),
        item,
        content,
        tagsString,
      )
    );
  }

  private replaceTemplateValues(
    template: string,
    item: FeedItem,
    content: string,
    tags: string,
  ): string {
    const replacements: Array<[RegExp, string]> = [
      [/{{title}}/g, item.title],
      [/{{link}}/g, item.link],
      [/{{author}}/g, item.author || ""],
      [/{{source}}/g, item.feedTitle],
      [/{{feedTitle}}/g, item.feedTitle],
      [/{{summary}}/g, item.summary || ""],
      [/{{content}}/g, content],
      [/{{tags}}/g, tags],
      [/{{guid}}/g, item.guid],
      [/{{image}}/g, this.getFallbackHeroUrl(item)],
    ];
    return replacements.reduce(
      (result, [pattern, replacement]) =>
        result.replace(pattern, () => replacement),
      template,
    );
  }

  private renderFrontmatterTemplate(
    template: string,
    item: FeedItem,
    content: string,
    tags: string[],
    date: Date,
    additions: Record<string, string> = {},
  ): string {
    const extracted = this.extractFrontmatter(template);
    const yamlSource = extracted?.yaml ?? template;
    const replacements = new Map<string, string>();
    const tagTokens = new Set<string>();
    let sequence = 0;
    const tokenized = yamlSource.replace(/{{[^{}\r\n]+}}/g, (placeholder) => {
      const token = `RSSDASHBOARDPLACEHOLDER${sequence++}TOKEN`;
      replacements.set(
        token,
        this.resolveTemplatePlaceholder(
          placeholder,
          item,
          content,
          tags.join(", "),
          date,
        ),
      );
      if (placeholder === "{{tags}}") tagTokens.add(token);
      return token;
    });
    const yamlDocument = this.parseYamlMapping(
      tokenized,
      "frontmatter template",
    );
    const expandTagSequences = (node: unknown): void => {
      if (isMap(node)) {
        for (const pair of node.items) {
          if (
            isScalar(pair.value) &&
            typeof pair.value.value === "string" &&
            pair.value.type !== "BLOCK_LITERAL" &&
            pair.value.type !== "BLOCK_FOLDED" &&
            tagTokens.has(pair.value.value)
          ) {
            pair.value = yamlDocument.createNode(tags);
          } else {
            expandTagSequences(pair.value);
          }
        }
        return;
      }
      if (!isSeq(node)) return;
      for (let index = node.items.length - 1; index >= 0; index--) {
        const child = node.items[index];
        if (
          isScalar(child) &&
          typeof child.value === "string" &&
          child.type !== "BLOCK_LITERAL" &&
          child.type !== "BLOCK_FOLDED" &&
          tagTokens.has(child.value)
        ) {
          node.items.splice(
            index,
            1,
            ...tags.map((tag) => yamlDocument.createNode(tag)),
          );
        } else {
          expandTagSequences(child);
        }
      }
    };
    expandTagSequences(yamlDocument.contents);
    visit(yamlDocument, {
      Scalar: (key, node) => {
        if (typeof node.value !== "string") return;
        const scalarValue = node.value;
        const containsToken = Array.from(replacements.keys()).some((token) =>
          scalarValue.includes(token),
        );
        if (!containsToken) return;
        if (key === "key") {
          throw new Error(
            "Invalid frontmatter template: placeholders cannot be YAML keys.",
          );
        }
        let value = node.value;
        for (const [token, replacement] of replacements) {
          value = value.split(token).join(replacement);
        }
        node.value = value;
      },
    });
    for (const [key, value] of Object.entries(additions)) {
      yamlDocument.set(key, value);
    }
    return this.stringifyFrontmatter(yamlDocument);
  }

  private resolveTagNames(item: FeedItem): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const rawName of (item.tags ?? []).map((tag) => tag.name)) {
      if (typeof rawName !== "string") continue;
      const name = rawName.trim();
      const key = name.toLocaleLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      normalized.push(name);
    }
    const withSaved = this.settings.addSavedTag
      ? withSavedTagName(normalized)
      : normalized;
    const result: string[] = [];
    const resultSeen = new Set<string>();
    for (const rawName of withSaved) {
      const name = rawName.trim();
      const key = name.toLocaleLowerCase();
      if (!name || resultSeen.has(key)) continue;
      resultSeen.add(key);
      result.push(name);
    }
    return result;
  }

  private resolveTemplatePlaceholder(
    placeholder: string,
    item: FeedItem,
    content: string,
    tags: string,
    date: Date,
  ): string {
    const values: Record<string, string> = {
      "{{title}}": item.title,
      "{{link}}": item.link,
      "{{author}}": item.author || "",
      "{{source}}": item.feedTitle,
      "{{feedTitle}}": item.feedTitle,
      "{{summary}}": item.summary || "",
      "{{content}}": content,
      "{{tags}}": tags,
      "{{guid}}": item.guid,
      "{{image}}": this.getFallbackHeroUrl(item),
    };
    if (Object.prototype.hasOwnProperty.call(values, placeholder)) {
      return values[placeholder];
    }
    if (
      placeholder === "{{date}}" ||
      placeholder === "{{dateShort}}" ||
      placeholder === "{{isoDate}}" ||
      placeholder === "{{isoDateTime}}" ||
      /^{{date:.+}}$/.test(placeholder)
    ) {
      return this.replaceDatePlaceholders(placeholder, date);
    }
    return placeholder;
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

    const cleanPath = folderPath.normalize("NFC");
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
        const existing =
          (await this.findExactOwnedNote(item, itemId)) ??
          (await this.findNoteByStableId(folder, itemId));
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
    const existing =
      (await this.findExactOwnedNote(input.item, input.itemId)) ??
      (await this.findNoteByStableId(input.folder, input.itemId));
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
    const templateFrontmatter = this.extractFrontmatter(template);
    const frontmatterLike = template
      .replace(/^\uFEFF/, "")
      .trimStart()
      .startsWith("---");
    if (frontmatterLike && !templateFrontmatter) {
      throw new Error("Invalid frontmatter template boundary.");
    }
    const templateHasFrontmatter = templateFrontmatter !== null;
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
    if (customFolder !== undefined) {
      return this.normalizeSavedNoteFolder(customFolder, true);
    }
    if (this.collectionSettings) {
      return this.normalizeSavedNoteFolder(
        this.collectionSettings.savedNoteFolder,
        false,
      );
    }

    const configured = this.settings.defaultFolder ?? "";
    if (!configured.trim()) return "";
    return this.normalizePath(configured).normalize("NFC");
  }

  private normalizeSavedNoteFolder(
    configured: string,
    allowRoot: boolean,
  ): string {
    if (allowRoot && configured === "") return "";
    if (
      configured !== configured.trim() ||
      !configured ||
      configured.startsWith("/") ||
      configured.endsWith("/") ||
      configured.includes("\\") ||
      containsControlCharacter(configured) ||
      /^[A-Za-z]:/.test(configured)
    ) {
      throw new Error("Invalid saved-note folder path.");
    }
    const normalized = configured.normalize("NFC");
    const segments = normalized.split("/");
    if (
      segments.some(
        (segment) =>
          segment === "" ||
          segment.trim() === "" ||
          segment !== segment.trim() ||
          segment === "." ||
          segment === ".." ||
          containsControlCharacter(segment) ||
          /[:*?"<>|]/.test(segment),
      )
    ) {
      throw new Error("Invalid saved-note folder path.");
    }
    const revalidated = segments.join("/").normalize("NFC");
    if (!revalidated || revalidated !== normalized) {
      throw new Error("Invalid saved-note folder path.");
    }
    return revalidated;
  }

  private resolveSavedFilename(title: string): string {
    const normalized = title.normalize("NFC");
    if (containsControlCharacter(normalized)) {
      throw new Error("Invalid saved-note filename.");
    }
    const candidate = normalized
      .replace(/[/\\:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .normalize("NFC");
    if (!candidate || candidate === "." || candidate === "..") {
      throw new Error("Invalid saved-note filename.");
    }
    return candidate;
  }

  private resolveStableItemId(item: FeedItem): string {
    return resolveFeedItemStableId(item);
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
    if (!folder) return null;
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

  private async findExactOwnedNote(
    item: FeedItem,
    itemId: string,
  ): Promise<TFile | null> {
    const savedPath = item.savedFilePath?.normalize("NFC");
    if (!savedPath) return null;
    const file = this.getAbstractFileByCanonicalPath(savedPath);
    if (!(file instanceof TFile)) return null;
    return (await this.readOwnedStableId(file)) === itemId ? file : null;
  }

  private isPathInsideFolder(path: string, folder: string): boolean {
    if (!folder) return false;
    const normalizedPath = path.normalize("NFC");
    return normalizedPath.startsWith(`${folder.normalize("NFC")}/`);
  }

  private async readOwnedStableId(file: TFile): Promise<string | null> {
    try {
      const raw = await this.app.vault.read(file);
      const frontmatter = this.extractFrontmatter(raw);
      if (!frontmatter) return null;
      const yamlDocument = this.parseYamlMapping(
        frontmatter.yaml,
        "saved-note frontmatter",
      );
      if (!isMap(yamlDocument.contents)) return null;
      const matches = yamlDocument.contents.items.filter(
        (pair) =>
          isScalar(pair.key) &&
          typeof pair.key.value === "string" &&
          pair.key.value === "rssDashboardId",
      );
      if (matches.length !== 1) return null;
      const value = matches[0].value;
      return isScalar(value) &&
        typeof value.value === "string" &&
        STABLE_ITEM_ID.test(value.value)
        ? value.value
        : null;
    } catch {
      return null;
    }
  }

  private async selectCollisionSafePath(
    folder: string,
    title: string,
    itemId: string,
  ): Promise<string> {
    const filename = this.resolveSavedFilename(title);
    const candidates = [
      filename,
      `${filename}-${itemId.slice(0, 8)}`,
      `${filename}-${itemId.slice(0, 12)}`,
    ];
    for (const candidate of candidates) {
      const path = (folder ? `${folder}/${candidate}.md` : `${candidate}.md`)
        .normalize("NFC");
      const existing = this.getAbstractFileByCanonicalPath(path);
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

  private getAbstractFileByCanonicalPath(path: string): TAbstractFile | null {
    const canonicalPath = path.normalize("NFC");
    const direct = this.app.vault.getAbstractFileByPath(canonicalPath);
    if (direct !== null) return direct;
    const segments = canonicalPath.split("/").filter(Boolean);
    let folder = this.app.vault.getRoot();
    for (let index = 0; index < segments.length; index++) {
      const match = folder.children.find(
        (child) => child.name.normalize("NFC") === segments[index],
      );
      if (!match) return null;
      if (index === segments.length - 1) return match;
      if (!(match instanceof TFolder)) return null;
      folder = match;
    }
    return null;
  }

  private addOwnedFrontmatter(
    content: string,
    input: { itemId: string; item: FeedItem; contentBasis: ContentBasis },
  ): string {
    const extracted = this.extractFrontmatter(content);
    const yamlDocument = extracted
      ? this.parseYamlMapping(extracted.yaml, "saved-note frontmatter")
      : this.createEmptyYamlMapping();
    if (!isMap(yamlDocument.contents)) {
      throw new Error("Invalid saved-note frontmatter: expected a YAML mapping.");
    }
    yamlDocument.contents.items = yamlDocument.contents.items.filter(
      (pair) =>
        !(
          isScalar(pair.key) &&
          typeof pair.key.value === "string" &&
          OWNED_FRONTMATTER_KEY_SET.has(pair.key.value)
        ),
    );
    const ownedValues: Record<(typeof OWNED_FRONTMATTER_KEYS)[number], string> = {
      rssDashboardId: input.itemId,
      source: input.item.feedTitle || "",
      sourceUrl: input.item.link || "",
      publishedAt: input.item.pubDate || "",
      savedAt: new Date().toISOString(),
      contentBasis: input.contentBasis,
    };
    for (const key of OWNED_FRONTMATTER_KEYS) {
      yamlDocument.set(key, ownedValues[key]);
    }
    this.verifyOwnedFrontmatter(yamlDocument);
    return `${this.stringifyFrontmatter(yamlDocument)}${extracted?.body ?? `\n${content}`}`;
  }

  private injectLegacyOwnedFrontmatter(
    content: string,
    input: { itemId: string; item: FeedItem; contentBasis: ContentBasis },
  ): string {
    const boundary = content.match(
      /^(\uFEFF?---[ \t]*(\r\n|\n))([\s\S]*?)(\r\n|\n)(---[ \t]*)(\r\n|\n|$)/,
    );
    if (!boundary) {
      throw new Error("Invalid legacy saved-note frontmatter boundary.");
    }
    const yamlDocument = this.parseYamlMapping(
      boundary[3],
      "legacy saved-note frontmatter",
    );
    if (!isMap(yamlDocument.contents)) {
      throw new Error("Invalid legacy saved-note frontmatter.");
    }

    const ownedValues: Record<(typeof OWNED_FRONTMATTER_KEYS)[number], string> = {
      rssDashboardId: input.itemId,
      source: input.item.feedTitle || "",
      sourceUrl: input.item.link || "",
      publishedAt: input.item.pubDate || "",
      savedAt: new Date().toISOString(),
      contentBasis: input.contentBasis,
    };
    const allowedLegacySources = new Set(
      [input.item.feedTitle, input.item.feedUrl, input.item.rssDashboardSourceId]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    );
    const linesToInject: string[] = [];
    for (const key of OWNED_FRONTMATTER_KEYS) {
      const matches = yamlDocument.contents.items.filter(
        (pair) =>
          isScalar(pair.key) &&
          pair.key.value === key,
      );
      if (matches.length === 0) {
        linesToInject.push(`${key}: ${JSON.stringify(ownedValues[key])}`);
        continue;
      }
      if (
        matches.length !== 1 ||
        !isScalar(matches[0].value) ||
        typeof matches[0].value.value !== "string"
      ) {
        throw new Error(`Invalid legacy owned frontmatter field: ${key}.`);
      }
      const existingValue = matches[0].value.value;
      if (key === "source") {
        if (!allowedLegacySources.has(existingValue.trim())) {
          throw new Error("Legacy source provenance does not match.");
        }
        continue;
      }
      if (key === "sourceUrl") {
        const existingUrl = canonicalizeUrl(existingValue);
        const expectedUrl = canonicalizeUrl(ownedValues.sourceUrl);
        if (
          existingUrl && expectedUrl
            ? existingUrl !== expectedUrl
            : existingValue !== ownedValues.sourceUrl
        ) {
          throw new Error("Legacy source URL provenance does not match.");
        }
        continue;
      }
      if (
        key === "publishedAt" &&
        existingValue === ownedValues.publishedAt
      ) {
        continue;
      }
      throw new Error(`Legacy note already contains owned field: ${key}.`);
    }

    const newline = boundary[4];
    const insertedBlock = linesToInject.join(newline);
    if (!insertedBlock) {
      throw new Error("Legacy note has no safe ownership fields to inject.");
    }
    const migratedFrontmatter = `${boundary[1]}${boundary[3]}${newline}${insertedBlock}${newline}${boundary[5]}${boundary[6]}`;
    const migrated = `${migratedFrontmatter}${content.slice(boundary[0].length)}`;
    const extracted = this.extractFrontmatter(migrated);
    if (!extracted) {
      throw new Error("Failed to preserve legacy frontmatter boundary.");
    }
    const verified = this.parseYamlMapping(
      extracted.yaml,
      "migrated saved-note frontmatter",
    );
    this.verifyOwnedFrontmatter(verified);
    return migrated;
  }

  private extractFrontmatter(
    content: string,
  ): { yaml: string; body: string } | null {
    const match = content.match(
      /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/,
    );
    if (!match) return null;
    return { yaml: match[1], body: content.slice(match[0].length) };
  }

  private parseYamlMapping(
    yamlSource: string,
    context: string,
  ): ReturnType<typeof parseDocument> {
    const yamlDocument = parseDocument(yamlSource, {
      schema: "core",
      strict: true,
      uniqueKeys: true,
    });
    if (yamlDocument.errors.length > 0 || !isMap(yamlDocument.contents)) {
      throw new Error(`Invalid ${context}: expected a unique YAML mapping.`);
    }
    let containsAlias = false;
    visit(yamlDocument, {
      Alias: () => {
        containsAlias = true;
        return visit.BREAK;
      },
    });
    if (containsAlias) {
      throw new Error(`Invalid ${context}: YAML aliases are not supported.`);
    }
    for (const pair of yamlDocument.contents.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        throw new Error(`Invalid ${context}: YAML keys must be strings.`);
      }
    }
    return yamlDocument;
  }

  private createEmptyYamlMapping(): ReturnType<typeof parseDocument> {
    const yamlDocument = new YamlDocument();
    yamlDocument.contents = new YAMLMap();
    return yamlDocument as ReturnType<typeof parseDocument>;
  }

  private stringifyFrontmatter(
    yamlDocument: ReturnType<typeof parseDocument>,
  ): string {
    return `---\n${yamlDocument.toString({ lineWidth: 0 }).trimEnd()}\n---\n`;
  }

  private verifyOwnedFrontmatter(
    yamlDocument: ReturnType<typeof parseDocument>,
  ): void {
    const reparsed = this.parseYamlMapping(
      yamlDocument.toString({ lineWidth: 0 }),
      "generated saved-note frontmatter",
    );
    if (!isMap(reparsed.contents)) {
      throw new Error("Invalid generated saved-note frontmatter.");
    }
    for (const key of OWNED_FRONTMATTER_KEYS) {
      const matches = reparsed.contents.items.filter(
        (pair) =>
          isScalar(pair.key) &&
          pair.key.value === key,
      );
      if (
        matches.length !== 1 ||
        !isScalar(matches[0].value) ||
        typeof matches[0].value.value !== "string"
      ) {
        throw new Error(
          `Invalid generated saved-note frontmatter field: ${key}.`,
        );
      }
    }
  }

  private applySavedState(item: FeedItem, filePath: string): void {
    item.saved = true;
    item.savedFilePath = filePath;
    item.savedNoteMigrationPending = undefined;
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
    let folder: string;
    try {
      folder = this.resolveSavedNoteFolder();
    } catch {
      return;
    }
    for (const article of articles) {
      if (!article.saved) continue;
      await this.withSavedNoteLock(folder, async () => {
        try {
          const itemId = this.resolveStableItemId(article);
          const exactOwned = await this.findExactOwnedNote(article, itemId);
          if (exactOwned) {
            article.savedFilePath = exactOwned.path.normalize("NFC");
            article.savedNoteMigrationPending = undefined;
            return;
          }

          const ownedInFolder = await this.findNoteByStableId(folder, itemId);
          if (ownedInFolder) {
            article.savedFilePath = ownedInFolder.path;
            article.savedNoteMigrationPending = undefined;
            return;
          }

          const explicitPath = article.savedFilePath?.normalize("NFC");
          const explicitFile = explicitPath
            ? this.getAbstractFileByCanonicalPath(explicitPath)
            : null;
          if (!(explicitFile instanceof TFile)) {
            this.markLegacyMigrationPending(article);
            return;
          }
          const raw = await this.app.vault.read(explicitFile);
          if (!this.legacyNoteMatchesItem(raw, article)) {
            this.markLegacyMigrationPending(article);
            return;
          }

          const migrated = this.injectLegacyOwnedFrontmatter(raw, {
            itemId,
            item: article,
            contentBasis: "feed",
          });
          await this.app.vault.modify(explicitFile, migrated);
          await this.ensureFolderExists(folder);
          const targetPath = await this.selectCollisionSafePath(
            folder,
            article.title,
            itemId,
          );
          const target = this.app.vault.getAbstractFileByPath(targetPath);
          if (target instanceof TFile) {
            article.savedFilePath = target.path;
            article.savedNoteMigrationPending = undefined;
            return;
          }
          if (explicitFile.path !== targetPath) {
            await this.app.fileManager.renameFile(explicitFile, targetPath);
          }
          article.savedFilePath = targetPath;
          article.savedNoteMigrationPending = undefined;
        } catch {
          this.markLegacyMigrationPending(article);
        }
      });
    }
  }

  private legacyNoteMatchesItem(raw: string, item: FeedItem): boolean {
    const frontmatter = this.extractFrontmatter(raw);
    if (!frontmatter) return false;
    let yamlDocument: ReturnType<typeof parseDocument>;
    try {
      yamlDocument = this.parseYamlMapping(
        frontmatter.yaml,
        "legacy saved-note frontmatter",
      );
    } catch {
      return false;
    }
    if (!isMap(yamlDocument.contents)) return false;
    if (yamlDocument.has("rssDashboardId")) return false;

    const scalar = (key: string): string | undefined => {
      const value: unknown = yamlDocument.get(key);
      return typeof value === "string" && value.trim()
        ? value.trim()
        : undefined;
    };
    let guidMatches = false;
    const legacyGuid = scalar("guid");
    if (legacyGuid && item.guid?.trim()) {
      guidMatches = legacyGuid === item.guid.trim();
      if (!guidMatches) return false;
    }
    const urlEvidence: boolean[] = [];
    for (const key of ["link", "sourceUrl", "url"]) {
      const legacyUrl = scalar(key);
      if (!legacyUrl || !item.link?.trim()) continue;
      const canonicalLegacy = canonicalizeUrl(legacyUrl);
      const canonicalItem = canonicalizeUrl(item.link);
      if (canonicalLegacy && canonicalItem) {
        urlEvidence.push(canonicalLegacy === canonicalItem);
      } else if (canonicalLegacy || canonicalItem) {
        urlEvidence.push(false);
      }
    }
    if (urlEvidence.some((matches) => !matches)) return false;

    const allowedSources = new Set(
      [item.feedTitle, item.feedUrl, item.rssDashboardSourceId]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    );
    let matchingSourceCount = 0;
    for (const key of ["source", "feedTitle", "feedUrl"]) {
      const source = scalar(key);
      if (source && !allowedSources.has(source)) return false;
      if (source) matchingSourceCount += 1;
    }
    if (urlEvidence.some(Boolean)) return true;
    return guidMatches && matchingSourceCount > 0;
  }

  private markLegacyMigrationPending(article: FeedItem): void {
    if (article.savedNoteMigrationPending) return;
    article.savedNoteMigrationPending = true;
    console.warn(LEGACY_NOTE_MIGRATION_WARNING);
  }

  async verifySavedArticle(article: FeedItem): Promise<boolean> {
    if (!article.saved || !article.savedFilePath) {
      return false;
    }

    try {
      if (await this.findSavedArticleFile(article)) return true;
      this.clearSavedState(article);
      return false;
    } catch {
      return false;
    }
  }

  async verifyAllSavedArticles(articles: FeedItem[]): Promise<void> {
    for (const article of articles.filter((candidate) => candidate.saved)) {
      await this.verifySavedArticle(article);
    }
  }

  async checkSavedFileExists(item: FeedItem): Promise<boolean> {
    if (!item.saved) {
      return false;
    }
    return (await this.findSavedArticleFile(item)) !== null;
  }

  async findSavedArticleFile(article: FeedItem): Promise<TFile | null> {
    if (!article.saved) {
      return null;
    }

    let folder: string;
    let itemId: string;
    try {
      folder = this.resolveSavedNoteFolder();
      itemId = this.resolveStableItemId(article);
    } catch {
      return null;
    }
    const savedPath = article.savedFilePath?.normalize("NFC");
    if (savedPath) {
      const savedFile = this.getAbstractFileByCanonicalPath(savedPath);
      if (
        savedFile instanceof TFile &&
        (await this.readOwnedStableId(savedFile)) === itemId
      ) {
        article.savedFilePath = savedFile.path;
        return savedFile;
      }
      if (savedFile instanceof TFile && article.savedNoteMigrationPending) {
        return savedFile;
      }
    }
    const owned = await this.findNoteByStableId(folder, itemId);
    if (owned) {
      article.savedFilePath = owned.path;
      return owned;
    }
    return null;
  }

  private clearSavedState(article: FeedItem): void {
    article.saved = false;
    article.savedFilePath = undefined;
    if (article.tags) {
      article.tags = article.tags.filter(
        (tag) => tag.name.toLowerCase() !== "saved",
      );
    }
  }
}

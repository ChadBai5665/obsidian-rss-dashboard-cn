import { Menu, MenuItem, Notice } from "obsidian";
import type { FeedItem } from "../../../types/types";
import { createTranslator } from "../../../i18n";
import type { Locale } from "../../../i18n";
import type { AiOperation } from "../../../ai/prompts/prompt-types";
import { addAiOperationMenuItems } from "./article-actions";

export interface ArticleContext {
  callbacks: {
    onOpenSavedArticle?: (article: FeedItem) => Promise<void> | void;
    onOpenInReaderView?: (article: FeedItem) => void;
    onArticleUpdate?: (
      article: FeedItem,
      updates: Partial<FeedItem>,
      shouldRerender?: boolean,
    ) => void;
    onArticleSave?: (article: FeedItem) => Promise<void> | void;
    onArticleClick?: (article: FeedItem) => void;
    onAiOperation?: (article: FeedItem, operation: AiOperation) => unknown;
  };
  settings: {
    articleSaving: {
      saveFullContent: boolean;
    };
    locale?: Locale;
  };
}

export function showArticleContextMenu(
  event: MouseEvent,
  article: FeedItem,
  ctx: ArticleContext,
): void {
  const t = createTranslator(ctx.settings.locale ?? "zh-CN");
  const menu = new Menu();

  if (article.saved) {
    menu.addItem((item: MenuItem) => {
      item
        .setTitle(t("article.openSaved"))
        .setIcon("file-text")
        .onClick(() => {
          if (ctx.callbacks.onOpenSavedArticle) {
            void ctx.callbacks.onOpenSavedArticle(article);
          }
        });
    });

    menu.addItem((item: MenuItem) => {
      item
        .setTitle(t("article.openReader"))
        .setIcon("book-open")
        .onClick(() => {
          if (ctx.callbacks.onOpenInReaderView) {
            ctx.callbacks.onOpenInReaderView(article);
          }
        });
    });

    menu.addSeparator();
  }

  menu.addItem((item: MenuItem) => {
    item
      .setTitle(t("article.openBrowser"))
      .setIcon("external-link")
      .onClick(() => {
        activeWindow.open(article.link, "_blank");
      });
  });

  menu.addItem((item: MenuItem) => {
    item
      .setTitle(t("article.openSplit"))
      .setIcon("panel-left")
      .onClick(() => {
        if (ctx.callbacks.onArticleClick) {
          ctx.callbacks.onArticleClick(article);
        }
      });
  });

  menu.addItem((item: MenuItem) => {
    item
      .setTitle(t("article.copyUrl"))
      .setIcon("link")
      .onClick(() => {
        void navigator.clipboard.writeText(article.link);
        new Notice(t("article.urlCopied"));
      });
  });

  if (article.feedUrl) {
    menu.addItem((item: MenuItem) => {
      item
        .setTitle(t("article.copyFeedUrl"))
        .setIcon("rss")
        .onClick(() => {
          void navigator.clipboard.writeText(article.feedUrl);
          new Notice(t("article.feedUrlCopied"));
        });
    });
  }

  menu.addSeparator();

  menu.addItem((item: MenuItem) => {
    item
      .setTitle(article.read ? t("article.markUnread") : t("article.markRead"))
      .setIcon(article.read ? "circle" : "check-circle")
      .onClick(() => {
        ctx.callbacks.onArticleUpdate?.(
          article,
          { read: !article.read },
          false,
        );
      });
  });

  menu.addItem((item: MenuItem) => {
    item
      .setTitle(article.starred ? t("article.unstar") : t("article.star"))
      .setIcon("star")
      .onClick(() => {
        ctx.callbacks.onArticleUpdate?.(
          article,
          { starred: !article.starred },
          false,
        );
      });
  });

  menu.addSeparator();
  addAiOperationMenuItems(menu, ctx.settings.locale, (operation) => {
    ctx.callbacks.onAiOperation?.(article, operation);
  });

  if (!article.saved) {
    menu.addSeparator();
    menu.addItem((item: MenuItem) => {
      item
        .setTitle(
          ctx.settings.articleSaving.saveFullContent
            ? t("article.saveFullShort")
            : t("article.saveSummaryShort"),
        )
        .setIcon("save")
        .onClick(() => {
          if (ctx.callbacks.onArticleSave) {
            void ctx.callbacks.onArticleSave(article);
          }
        });
    });
  }

  menu.showAtMouseEvent(event);
}

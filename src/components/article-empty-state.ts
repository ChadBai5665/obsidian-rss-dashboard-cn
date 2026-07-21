import { setIcon } from "obsidian";
import type { FilterContext } from "../utils/filter-detection";
import { createTranslator } from "../i18n";
import type { Locale } from "../i18n";

interface ArticleEmptyStateOptions {
  onAction?: () => void;
  locale?: Locale;
}

/**
 * ArticleEmptyState - Renders empty article state UI
 *
 * Handles two scenarios:
 * 1. NoArticlesAtAll: Feed is genuinely empty or some articles pass filters
 * 2. AllArticlesFiltered: Feed has articles but all are hidden by active filters
 */
export class ArticleEmptyState {
  /**
   * Render the empty state UI into the provided container
   *
   * @param container - HTML element to render into
   * @param context - FilterContext describing why the article list is empty
   */
  render(
    container: HTMLElement,
    context: FilterContext,
    options?: ArticleEmptyStateOptions,
  ): void {
    // This standalone component historically rendered English when used
    // without settings. Dashboard callers always pass their persisted locale.
    const t = createTranslator(options?.locale ?? "zh-CN");
    const emptyState = container.createDiv({
      cls: "rss-dashboard-empty-state",
    });

    // Render icon
    const iconDiv = emptyState.createDiv({
      cls: "rss-dashboard-empty-state-icon",
    });
    setIcon(iconDiv, "rss");

    // Render heading and description based on context type
    if (context.type === "NoArticlesAtAll") {
      this.renderNoArticlesAtAll(emptyState, t);
    } else if (context.type === "AllArticlesFiltered") {
      this.renderAllArticlesFiltered(emptyState, context, options, t);
    } else if (context.type === "AllArticlesPrunedByRetention") {
      this.renderAllArticlesPrunedByRetention(emptyState, context, options, t);
    }
  }

  /**
   * Render UI for genuinely empty feed
   */
  private renderNoArticlesAtAll(
    emptyState: HTMLElement,
    t: ReturnType<typeof createTranslator>,
  ): void {
    const heading = emptyState.createEl("h2");
    heading.textContent = t("article.empty.none");

    const description = emptyState.createEl("p");
    description.textContent = t("article.empty.noneDesc");
  }

  /**
   * Render UI for articles filtered out by active filters
   */
  private renderAllArticlesFiltered(
    emptyState: HTMLElement,
    context: FilterContext,
    options?: ArticleEmptyStateOptions,
    t: ReturnType<typeof createTranslator> = createTranslator("en"),
  ): void {
    const heading = emptyState.createEl("h2");
    heading.textContent = t("article.empty.filtered");

    const description = emptyState.createEl("p");
    if (context.thresholdLabel && context.filterReason !== "view-filter") {
      description.textContent = t("article.empty.filteredOlder", {
        count: context.unfilteredCount,
        articleWord:
          context.unfilteredCount === 1
            ? t("article.article")
            : t("article.articles"),
        threshold: context.thresholdLabel,
      });
    } else {
      const reasonLabel =
        context.filterReasonLabel ?? "the current view filters";
      description.textContent = t("article.empty.filteredNoMatch", {
        count: context.unfilteredCount,
        articleWord:
          context.unfilteredCount === 1
            ? t("article.article")
            : t("article.articles"),
        reason: reasonLabel,
      });
    }

    this.renderActionButton(
      emptyState,
      context.actionLabel ?? t("article.empty.adjustFilters"),
      options?.onAction,
    );
  }

  private renderAllArticlesPrunedByRetention(
    emptyState: HTMLElement,
    context: FilterContext,
    options?: ArticleEmptyStateOptions,
    t: ReturnType<typeof createTranslator> = createTranslator("en"),
  ): void {
    const heading = emptyState.createEl("h2");
    heading.textContent = t("article.empty.refreshed");

    const description = emptyState.createEl("p");
    description.textContent = t("article.empty.pruned", {
      count: context.prunedCount ?? 0,
      articleWord:
        (context.prunedCount ?? 0) === 1
          ? t("article.article")
          : t("article.articles"),
      verb:
        (context.prunedCount ?? 0) === 1 ? t("article.was") : t("article.were"),
      retention: context.retentionLabel ?? "",
    });

    this.renderActionButton(
      emptyState,
      context.actionLabel ?? t("article.empty.adjustFeedFilters"),
      options?.onAction,
    );
  }

  private renderActionButton(
    emptyState: HTMLElement,
    label: string,
    onAction?: () => void,
  ): void {
    const button = emptyState.createDiv({
      cls: "rss-dashboard-empty-state-button",
      attr: {
        role: "button",
        tabindex: "0",
        "aria-label": label,
      },
    });
    button.textContent = label;

    if (!onAction) {
      return;
    }

    button.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onAction();
      }
    });

    button.addEventListener("click", () => {
      onAction();
    });
  }
}

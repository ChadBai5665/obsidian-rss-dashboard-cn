import { createTranslator, type Locale, type TranslationKey } from "../i18n";
import type {
  OperationEvent,
  OperationStatus,
} from "../operation-journal/operation-event";
import { snapshotOperationEvent } from "../operation-journal/operation-event";
import type { OperationJournalListResult } from "../operation-journal/operation-journal-service";
import type { OperationSummary } from "../operation-journal/operation-summary";
import { aggregateOperationEvents } from "../operation-journal/operation-summary";

export interface OperationJournalUiPort {
  load(days: 7 | 30): Promise<OperationJournalListResult>;
  subscribe(listener: () => void): () => void;
  exportSafe(days: 7 | 30): Promise<void>;
  requestClear(): void;
}

export interface OperationJournalPanelOptions extends OperationJournalUiPort {
  locale: Locale;
  onClose(): void;
}

type CategoryFilter = "all" | OperationSummary["category"];
type StatusFilter = "all" | "ongoing" | "succeeded" | "failed" | "interrupted";

const LIVE_RELOAD_DELAY_MS = 150;
const MAX_UI_OPERATIONS = 1_000;
const MAX_UI_EVENTS = 5_000;
const MAX_HEALTH_DATES = 30;
const NARROW_PANEL_WIDTH_PX = 720;

export class OperationJournalPanel {
  private readonly root = activeDocument.createElement("section");
  private host: HTMLElement;
  private days: 7 | 30 = 7;
  private category: CategoryFilter = "all";
  private status: StatusFilter = "all";
  private result: OperationJournalListResult | null = null;
  private resultDays: 7 | 30 | null = null;
  private loading = false;
  private loadFailed = false;
  private opened = false;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;
  private reloadTimer: number | null = null;
  private loadGeneration = 0;
  private resizeObserver: ResizeObserver | null = null;
  private locale: Locale;
  private t: ReturnType<typeof createTranslator>;

  constructor(
    host: HTMLElement,
    private readonly options: OperationJournalPanelOptions,
  ) {
    this.host = host;
    this.locale = options.locale;
    this.t = createTranslator(this.locale);
    this.root.className = "rss-operation-journal";
    this.root.setAttribute("aria-label", this.t("operationJournal.title"));
  }

  open(host: HTMLElement = this.host): void {
    if (this.disposed) return;
    this.host = host;
    if (this.root.parentElement !== host) host.appendChild(this.root);
    this.observeWidth();
    if (this.unsubscribe === null) {
      try {
        const unsubscribe = this.options.subscribe(() => this.scheduleReload());
        if (typeof unsubscribe === "function") this.unsubscribe = unsubscribe;
      } catch {
        // Live updates are optional; a later idempotent open retries subscribe.
      }
    }
    if (!this.opened) {
      this.opened = true;
      this.render();
      void this.reload();
    }
  }

  setLocale(locale: Locale): void {
    if (this.disposed || this.locale === locale) return;
    this.locale = locale;
    this.t = createTranslator(locale);
    this.root.setAttribute("aria-label", this.t("operationJournal.title"));
    this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadGeneration += 1;
    if (this.reloadTimer !== null) {
      window.clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    if (unsubscribe !== null) invokeSafely(unsubscribe);
    const resizeObserver = this.resizeObserver;
    this.resizeObserver = null;
    if (resizeObserver !== null)
      invokeSafely(() => resizeObserver.disconnect());
    this.root.remove();
  }

  private scheduleReload(): void {
    if (this.disposed) return;
    if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
    this.reloadTimer = window.setTimeout(() => {
      this.reloadTimer = null;
      void this.reload();
    }, LIVE_RELOAD_DELAY_MS);
  }

  private async reload(): Promise<void> {
    const generation = ++this.loadGeneration;
    const requestedDays = this.days;
    if (this.resultDays !== requestedDays) {
      this.result = null;
      this.resultDays = null;
    }
    this.loading = true;
    this.loadFailed = false;
    this.render();
    try {
      const result = normalizeListResult(
        await this.options.load(requestedDays),
        new Date(),
      );
      if (this.disposed || generation !== this.loadGeneration) return;
      this.result = result;
      this.resultDays = requestedDays;
    } catch {
      if (this.disposed || generation !== this.loadGeneration) return;
      this.loadFailed = true;
      this.result = null;
      this.resultDays = null;
    } finally {
      if (!this.disposed && generation === this.loadGeneration) {
        this.loading = false;
        this.render();
      }
    }
  }

  private render(): void {
    this.root.empty();
    this.renderHeader();
    this.renderFilters();
    this.renderWarnings();

    const body = this.root.createDiv({ cls: "rss-operation-journal-body" });
    if (this.loadFailed) {
      const state = body.createDiv({
        cls: "rss-operation-journal-state rss-operation-journal-error",
      });
      state.createDiv({
        cls: "rss-operation-journal-state-title",
        text: this.t("operationJournal.loadFailed"),
      });
      state.createDiv({
        cls: "rss-operation-journal-state-detail",
        text: this.t("operationJournal.loadFailedDetail"),
      });
      const retry = state.createEl("button", {
        cls: "rss-operation-journal-retry",
        text: this.t("common.retry"),
        attr: { type: "button" },
      });
      retry.addEventListener("click", () => void this.reload());
      return;
    }

    if (this.loading && this.result === null) {
      body.createDiv({
        cls: "rss-operation-journal-state",
        text: this.t("common.loading"),
      });
      return;
    }

    const operations = this.filteredOperations();
    if (operations.length === 0) {
      body.createDiv({
        cls: "rss-operation-journal-state",
        text: this.t("operationJournal.empty"),
      });
      return;
    }

    const list = body.createDiv({ cls: "rss-operation-journal-list" });
    for (const operation of operations) this.renderCard(list, operation);
  }

  private renderHeader(): void {
    const header = this.root.createDiv({ cls: "rss-operation-journal-header" });
    const titleGroup = header.createDiv({
      cls: "rss-operation-journal-title-group",
    });
    titleGroup.createEl("h2", {
      cls: "rss-operation-journal-title",
      text: this.t("operationJournal.title"),
    });
    titleGroup.createDiv({
      cls: "rss-operation-journal-subtitle",
      text: this.t("operationJournal.subtitle"),
    });

    const actions = header.createDiv({ cls: "rss-operation-journal-actions" });
    const exportButton = actions.createEl("button", {
      cls: "rss-operation-journal-action",
      text: this.t("operationJournal.exportSafe"),
      attr: { type: "button" },
    });
    exportButton.addEventListener("click", () => {
      invokeSafely(() => this.options.exportSafe(this.days));
    });
    const clearButton = actions.createEl("button", {
      cls: "rss-operation-journal-action rss-operation-journal-clear",
      text: this.t("operationJournal.clear"),
      attr: { type: "button" },
    });
    clearButton.addEventListener("click", () => {
      invokeSafely(() => this.options.requestClear());
    });
    const closeButton = actions.createEl("button", {
      cls: "rss-operation-journal-action rss-operation-journal-close",
      text: this.t("operationJournal.close"),
      attr: { type: "button" },
    });
    closeButton.addEventListener("click", () => {
      invokeSafely(() => this.options.onClose());
    });
  }

  private observeWidth(): void {
    if (
      this.resizeObserver !== null ||
      typeof ResizeObserver === "undefined"
    )
      return;
    try {
      const observer = new ResizeObserver((entries) => {
        if (this.disposed) return;
        const entry = entries.find((candidate) => candidate.target === this.root);
        if (entry === undefined) return;
        this.root.classList.toggle(
          "is-narrow",
          entry.contentRect.width <= NARROW_PANEL_WIDTH_PX,
        );
      });
      this.resizeObserver = observer;
      observer.observe(this.root);
    } catch {
      const observer = this.resizeObserver;
      this.resizeObserver = null;
      if (observer !== null) invokeSafely(() => observer.disconnect());
    }
  }

  private renderFilters(): void {
    const filters = this.root.createDiv({
      cls: "rss-operation-journal-filters",
    });
    this.renderSelect<CategoryFilter>(
      filters,
      "operationJournal.filterCategory",
      "rss-operation-journal-category-filter",
      this.category,
      [
        ["all", "operationJournal.categoryAll"],
        ["transcript", "operationJournal.categoryTranscript"],
        ["ai", "operationJournal.categoryAi"],
        ["refresh", "operationJournal.categoryRefresh"],
        ["subscription", "operationJournal.categorySubscription"],
      ],
      (value) => {
        this.category = value;
        this.render();
      },
    );
    this.renderSelect<StatusFilter>(
      filters,
      "operationJournal.filterStatus",
      "rss-operation-journal-status-filter",
      this.status,
      [
        ["all", "operationJournal.statusAll"],
        ["ongoing", "operationJournal.statusOngoing"],
        ["succeeded", "operationJournal.statusSucceeded"],
        ["failed", "operationJournal.statusFailed"],
        ["interrupted", "operationJournal.statusInterrupted"],
      ],
      (value) => {
        this.status = value;
        this.render();
      },
    );

    const range = filters.createDiv({ cls: "rss-operation-journal-range" });
    range.createSpan({
      cls: "rss-operation-journal-filter-label",
      text: this.t("operationJournal.filterRange"),
    });
    for (const days of [7, 30] as const) {
      const button = range.createEl("button", {
        cls: `rss-operation-journal-range-button${this.days === days ? " is-active" : ""}`,
        text: this.t(
          days === 7 ? "operationJournal.range7" : "operationJournal.range30",
        ),
        attr: {
          type: "button",
          "data-days": String(days),
          "aria-pressed": String(this.days === days),
        },
      });
      button.addEventListener("click", () => {
        if (this.days === days) return;
        this.days = days;
        void this.reload();
      });
    }
  }

  private renderSelect<T extends string>(
    parent: HTMLElement,
    labelKey: TranslationKey,
    className: string,
    value: T,
    options: readonly (readonly [T, TranslationKey])[],
    onChange: (value: T) => void,
  ): void {
    const label = parent.createEl("label", {
      cls: "rss-operation-journal-filter",
    });
    label.createSpan({
      cls: "rss-operation-journal-filter-label",
      text: this.t(labelKey),
    });
    const select = label.createEl("select", {
      cls: `rss-operation-journal-select ${className}`,
      attr: { "aria-label": this.t(labelKey) },
    });
    for (const [optionValue, optionKey] of options) {
      const option = select.createEl("option", {
        text: this.t(optionKey),
        attr: { value: optionValue },
      });
      option.selected = optionValue === value;
    }
    select.addEventListener("change", () => onChange(select.value as T));
  }

  private renderWarnings(): void {
    if (this.result === null) return;
    const warnings: string[] = [];
    if (this.result.incompleteDates.length > 0)
      warnings.push(this.t("operationJournal.warningIncomplete"));
    if (this.result.corruptDates.length > 0)
      warnings.push(this.t("operationJournal.warningCorrupt"));
    if (this.result.truncated)
      warnings.push(this.t("operationJournal.warningTruncated"));
    if (this.result.health.writeIncomplete)
      warnings.push(this.t("operationJournal.warningWrite"));
    if (this.result.health.maintenanceIncomplete)
      warnings.push(this.t("operationJournal.warningMaintenance"));
    if (warnings.length === 0) return;

    const region = this.root.createDiv({
      cls: "rss-operation-journal-warnings",
      attr: { "aria-live": "polite" },
    });
    for (const warning of warnings) {
      region.createDiv({
        cls: "rss-operation-journal-warning",
        text: warning,
      });
    }
  }

  private filteredOperations(): readonly OperationSummary[] {
    const unique = new Map<string, OperationSummary>();
    for (const operation of this.result?.operations ?? []) {
      if (!unique.has(operation.operationId))
        unique.set(operation.operationId, operation);
    }
    return [...unique.values()]
      .filter(
        (operation) =>
          (this.category === "all" || operation.category === this.category) &&
          (this.status === "all" ||
            statusGroup(operation.status) === this.status),
      )
      .sort(
        (left, right) =>
          right.startedAt.localeCompare(left.startedAt) ||
          left.operationId.localeCompare(right.operationId),
      );
  }

  private renderCard(parent: HTMLElement, operation: OperationSummary): void {
    const state = statusGroup(operation.status);
    const card = parent.createEl("article", {
      cls: `rss-operation-journal-card is-${state}`,
      attr: { "data-operation-id": operation.operationId },
    });
    const heading = card.createDiv({
      cls: "rss-operation-journal-card-heading",
    });
    const identity = heading.createDiv({
      cls: "rss-operation-journal-card-identity",
    });
    identity.createDiv({
      cls: "rss-operation-journal-card-kicker",
      text: this.categoryLabel(operation.category),
    });
    identity.createEl("h3", {
      cls: "rss-operation-journal-card-title",
      text: `${operation.subject.label ?? this.t("operationJournal.unknownSubject")} · ${this.actionLabel(operation.action)}`,
    });
    heading.createSpan({
      cls: "rss-operation-journal-status",
      text: this.statusLabel(operation.status),
    });

    const meta = card.createDiv({ cls: "rss-operation-journal-meta" });
    this.fact(
      meta,
      "operationJournal.startedAt",
      this.formatDate(operation.startedAt),
    );
    this.fact(
      meta,
      "operationJournal.trigger",
      this.triggerLabel(operation.trigger),
    );
    this.fact(
      meta,
      "operationJournal.duration",
      this.formatDuration(operation.durationMs),
    );

    const facts = card.createDiv({ cls: "rss-operation-journal-facts" });
    this.renderCategoryFacts(facts, operation);

    const expand = card.createEl("button", {
      cls: "rss-operation-journal-expand",
      text: this.t("operationJournal.showTimeline"),
      attr: {
        type: "button",
        "aria-expanded": "false",
        "aria-controls": `rss-operation-timeline-${operation.operationId}`,
      },
    });
    const timeline = card.createEl("ol", {
      cls: "rss-operation-journal-timeline",
      attr: {
        hidden: "",
        id: `rss-operation-timeline-${operation.operationId}`,
      },
    });
    this.renderTimeline(timeline, operation.events);
    expand.addEventListener("click", () => {
      const expanded = expand.getAttribute("aria-expanded") === "true";
      expand.setAttribute("aria-expanded", String(!expanded));
      expand.textContent = this.t(
        expanded
          ? "operationJournal.showTimeline"
          : "operationJournal.hideTimeline",
      );
      timeline.toggleAttribute("hidden", expanded);
    });
  }

  private renderCategoryFacts(
    parent: HTMLElement,
    operation: OperationSummary,
  ): void {
    const details = mergedDetails(operation.events);
    if (operation.category === "transcript") {
      this.fact(
        parent,
        "operationJournal.confirmedPaidRequests",
        String(operation.confirmedPaidRequests),
      );
      this.fact(
        parent,
        "operationJournal.possiblySent",
        this.yesNo(operation.possiblySent),
      );
      this.fact(
        parent,
        "operationJournal.jobId",
        this.t(
          details.jobId === undefined
            ? "operationJournal.jobIdMissing"
            : "operationJournal.jobIdPresent",
        ),
      );
      return;
    }
    if (operation.category === "ai") {
      this.fact(
        parent,
        "operationJournal.connection",
        textFact(
          details.connectionName,
          this.t("operationJournal.notAvailable"),
        ),
      );
      this.fact(
        parent,
        "operationJournal.model",
        textFact(details.model, this.t("operationJournal.notAvailable")),
      );
      this.fact(
        parent,
        "operationJournal.saveResult",
        this.aiSaveResult(operation),
      );
      return;
    }
    if (operation.category === "refresh") {
      this.fact(
        parent,
        "operationJournal.trigger",
        this.triggerLabel(operation.trigger),
      );
      this.fact(parent, "operationJournal.total", countFact(details.total));
      this.fact(
        parent,
        "operationJournal.succeeded",
        countFact(details.succeeded),
      );
      this.fact(parent, "operationJournal.failed", countFact(details.failed));
      this.fact(
        parent,
        "operationJournal.newItems",
        countFact(details.newItems),
      );
      this.fact(
        parent,
        "operationJournal.elapsed",
        typeof details.elapsedMs === "number"
          ? this.formatDuration(details.elapsedMs)
          : this.t("operationJournal.notAvailable"),
      );
      return;
    }
    this.fact(
      parent,
      "operationJournal.action",
      this.actionLabel(operation.action),
    );
    this.fact(
      parent,
      "operationJournal.sourceKind",
      this.sourceKindLabel(details.sourceKind),
    );
    this.fact(
      parent,
      "operationJournal.preserveHistory",
      typeof details.preserveHistory === "boolean"
        ? this.yesNo(details.preserveHistory)
        : this.t("operationJournal.notAvailable"),
    );
  }

  private fact(
    parent: HTMLElement,
    labelKey: TranslationKey,
    value: string,
  ): void {
    const item = parent.createDiv({ cls: "rss-operation-journal-fact" });
    item.createSpan({
      cls: "rss-operation-journal-fact-label",
      text: `${this.t(labelKey)}：`,
    });
    item.createSpan({ cls: "rss-operation-journal-fact-value", text: value });
  }

  private renderTimeline(
    parent: HTMLOListElement,
    events: readonly OperationEvent[],
  ): void {
    const ordered = [...events].sort(
      (left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) ||
        left.eventId.localeCompare(right.eventId),
    );
    for (const event of ordered) {
      const item = parent.createEl("li", {
        cls: "rss-operation-journal-timeline-item",
        attr: { "data-occurred-at": event.occurredAt },
      });
      item.createSpan({
        cls: "rss-operation-journal-timeline-time",
        text: this.formatTime(event.occurredAt),
      });
      item.createSpan({
        cls: "rss-operation-journal-timeline-stage",
        text: this.stageLabel(event.stage),
      });
      item.createSpan({
        cls: "rss-operation-journal-timeline-status",
        text: this.statusLabel(event.status),
      });
    }
  }

  private categoryLabel(category: OperationSummary["category"]): string {
    return this.t(`operationJournal.category.${category}` as TranslationKey);
  }

  private actionLabel(action: OperationSummary["action"]): string {
    return this.t(`operationJournal.action.${action}` as TranslationKey);
  }

  private triggerLabel(trigger: OperationSummary["trigger"]): string {
    return this.t(`operationJournal.trigger.${trigger}` as TranslationKey);
  }

  private stageLabel(stage: OperationEvent["stage"]): string {
    return this.t(`operationJournal.stage.${stage}` as TranslationKey);
  }

  private statusLabel(status: OperationStatus): string {
    if (status === "started" || status === "progress")
      return this.t("operationJournal.statusOngoing");
    if (status === "aborted") return this.t("operationJournal.statusAborted");
    return this.t(`operationJournal.status.${status}` as TranslationKey);
  }

  private sourceKindLabel(value: unknown): string {
    if (typeof value !== "string")
      return this.t("operationJournal.notAvailable");
    return this.t(`operationJournal.sourceKind.${value}` as TranslationKey);
  }

  private aiSaveResult(operation: OperationSummary): string {
    if (
      operation.events.some(
        (event) =>
          event.stage === "completed" &&
          event.status === "succeeded" &&
          "artifactPath" in event.details &&
          event.details.artifactPath !== undefined,
      )
    )
      return this.t("operationJournal.saveSucceeded");
    if (
      operation.events.some(
        (event) => event.stage === "saving" && event.status === "failed",
      )
    )
      return this.t("operationJournal.saveFailed");
    return this.t("operationJournal.savePending");
  }

  private yesNo(value: boolean): string {
    return this.t(value ? "operationJournal.yes" : "operationJournal.no");
  }

  private formatDate(value: string): string {
    return new Intl.DateTimeFormat(this.locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }

  private formatTime(value: string): string {
    return new Intl.DateTimeFormat(this.locale, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(value));
  }

  private formatDuration(milliseconds: number): string {
    if (milliseconds < 1_000)
      return this.t("operationJournal.durationMs", { count: milliseconds });
    const seconds = Math.round(milliseconds / 100) / 10;
    return this.t("operationJournal.durationSeconds", { count: seconds });
  }
}

function statusGroup(status: OperationStatus): Exclude<StatusFilter, "all"> {
  if (status === "started" || status === "progress") return "ongoing";
  if (status === "succeeded") return "succeeded";
  if (status === "interrupted") return "interrupted";
  return "failed";
}

function mergedDetails(
  events: readonly OperationEvent[],
): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  for (const event of events) {
    for (const [key, value] of Object.entries(event.details)) {
      if (value !== undefined) details[key] = value;
    }
  }
  return details;
}

function textFact(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function countFact(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "—";
}

function normalizeListResult(
  value: unknown,
  now: Date,
): OperationJournalListResult {
  const operationCandidates = boundedArray(
    ownDataValue(value, "operations"),
    MAX_UI_OPERATIONS,
  );
  const events: OperationEvent[] = [];
  let eventLimitReached = false;
  for (const operation of operationCandidates.values) {
    const eventCandidates = boundedArray(
      ownDataValue(operation, "events"),
      MAX_UI_EVENTS - events.length,
    );
    if (eventCandidates.truncated) eventLimitReached = true;
    for (const candidate of eventCandidates.values) {
      if (events.length >= MAX_UI_EVENTS) {
        eventLimitReached = true;
        break;
      }
      try {
        events.push(snapshotOperationEvent(candidate));
      } catch {
        // Invalid or secret-shaped event projections are dropped independently.
      }
    }
    if (events.length >= MAX_UI_EVENTS) break;
  }

  let operations: readonly OperationSummary[] = [];
  try {
    operations = aggregateOperationEvents(events, now);
  } catch {
    // A hostile clock or invalid aggregate fails closed to an empty list.
  }
  const healthValue = ownDataValue(value, "health");
  return Object.freeze({
    operations,
    incompleteDates: safeDates(
      ownDataValue(value, "incompleteDates"),
      MAX_HEALTH_DATES,
    ),
    corruptDates: safeDates(
      ownDataValue(value, "corruptDates"),
      MAX_HEALTH_DATES,
    ),
    truncated:
      ownDataValue(value, "truncated") === true ||
      operationCandidates.truncated ||
      eventLimitReached,
    health: Object.freeze({
      writeIncomplete:
        ownDataValue(healthValue, "writeIncomplete") === true,
      maintenanceIncomplete:
        ownDataValue(healthValue, "maintenanceIncomplete") === true,
    }),
  });
}

function ownDataValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      return undefined;
    }
    const dataValue: unknown = descriptor.value;
    return dataValue;
  } catch {
    return undefined;
  }
}

function boundedArray(
  value: unknown,
  limit: number,
): { readonly values: readonly unknown[]; readonly truncated: boolean } {
  if (limit <= 0) return { values: [], truncated: true };
  try {
    if (!Array.isArray(value)) return { values: [], truncated: false };
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length: unknown = lengthDescriptor?.value;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0
    )
      return { values: [], truncated: false };
    const boundedLength = Math.min(length, limit);
    const values: unknown[] = [];
    for (let index = 0; index < boundedLength; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor !== undefined &&
        Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        const itemValue: unknown = descriptor.value;
        values.push(itemValue);
      }
    }
    return { values, truncated: length > limit };
  } catch {
    return { values: [], truncated: false };
  }
}

function safeDates(value: unknown, limit: number): readonly string[] {
  const dates = boundedArray(value, limit).values.flatMap((candidate) => {
    if (typeof candidate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(candidate))
      return [];
    const timestamp = Date.parse(`${candidate}T00:00:00.000Z`);
    return Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString().slice(0, 10) === candidate
      ? [candidate]
      : [];
  });
  return Object.freeze(dates);
}

function invokeSafely(action: () => unknown): void {
  let result: unknown;
  try {
    result = action();
  } catch {
    return;
  }
  void Promise.resolve(result).catch(() => undefined);
}

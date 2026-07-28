import type {
  AiOperationTaskCoordinator,
  AiTaskSnapshot,
  StartAiTaskInput,
} from "../ai/ai-operation-task-coordinator";
import type {
  AiAnalysisArtifact,
  AiAnalysisHistoryRecord,
} from "../ai/analysis-markdown-parser";
import {
  MAX_AI_ANALYSIS_METADATA_CHARACTERS,
  MAX_AI_ANALYSIS_TEXT_CHARACTERS,
  isCanonicalAiAnalysisTimestamp,
  safeAnalysisText,
} from "../ai/analysis-result";
import type { AiConnection } from "../ai/ai-types";
import { normalizeAiConnection } from "../ai/connection-validation";
import type { AiOperationErrorCode } from "../ai/ai-operation-service";
import type { AiOperation } from "../ai/prompts/prompt-types";
import { getContentBasisLabel } from "../collection/content-basis-display";
import type { ContentBasis } from "../collection/collected-item";
import {
  createTranslator,
  type Locale,
  type TranslationKey,
  type Translator,
} from "../i18n";

export interface InlineAiPanelController {
  show(operation: AiOperation): Promise<void>;
  collapse(): void;
  expand(): void;
  destroy(): void;
}

export interface InlineAiPanelOptions {
  container: HTMLElement;
  locale: Locale;
  itemId: string;
  connections: readonly AiConnection[];
  defaultConnectionId?: string;
  coordinator: Pick<
    AiOperationTaskCoordinator,
    "loadLatest" | "start" | "regenerate" | "subscribe" | "abort"
  >;
  createStartInput(
    operation: AiOperation,
    connectionId: string,
  ): StartAiTaskInput;
  listHistory(
    itemId: string,
    operation: AiOperation,
  ): Promise<readonly AiAnalysisArtifact[]>;
  openArtifact(path: string): Promise<void> | void;
  openSettings(): Promise<void> | void;
  canInsertArtifact(path: string): boolean;
  insertArtifact(path: string): Promise<void> | void;
  renderMarkdown?(
    container: HTMLElement,
    text: string,
  ): Promise<void> | void;
}

type Coordinator = InlineAiPanelOptions["coordinator"];
type ResultOrigin = "current" | "history";

interface ConnectionDescriptor {
  id: string;
  name: string;
}

interface HistoryEntry {
  path: string;
  createdAt: string;
  connectionName: string;
  model: string;
}

const STABLE_ITEM_ID = /^[a-f0-9]{64}$/u;
const OPERATIONS: ReadonlySet<string> = new Set([
  "summary",
  "translate-zh-cn",
  "core-points",
  "deep-analysis",
]);
const STATUSES: ReadonlySet<string> = new Set([
  "idle",
  "preparing",
  "generating",
  "saving",
  "complete",
  "failed",
  "aborted",
]);
const ERROR_CODES: ReadonlySet<string> = new Set([
  "missing-key",
  "invalid-connection",
  "connection-disabled",
  "invalid-request",
  "invalid-key",
  "insufficient-balance",
  "timeout",
  "rate-limited",
  "provider-failure",
  "provider-rejected",
  "network-failure",
  "aborted",
  "malformed-response",
  "response-too-large",
  "empty-output",
  "secret-store-failure",
  "connection-not-found",
  "invalid-operation",
  "selection-failed",
]);
const OPERATION_LABELS: Readonly<Record<AiOperation, TranslationKey>> =
  Object.freeze({
    summary: "ai.operation.summary",
    "translate-zh-cn": "ai.operation.translateZhCn",
    "core-points": "ai.operation.corePoints",
    "deep-analysis": "ai.operation.deepAnalysis",
  });
const MAX_CONNECTION_NAME_CHARACTERS = 160;
const MAX_ARTIFACT_PATH_CHARACTERS = 20_000;
const MAX_HISTORY_ENTRIES = 256;

export function createInlineAiPanel(
  options: InlineAiPanelOptions,
): InlineAiPanelController {
  return new InlineAiPanel(options);
}

class InlineAiPanel implements InlineAiPanelController {
  private readonly locale: Locale;
  private readonly itemId: string;
  private readonly connections: readonly Readonly<ConnectionDescriptor>[];
  private readonly t: Translator;
  private readonly loadLatest: Coordinator["loadLatest"];
  private readonly start: Coordinator["start"];
  private readonly regenerateTask: Coordinator["regenerate"];
  private readonly subscribeTask: Coordinator["subscribe"];
  private readonly abortTask: Coordinator["abort"];
  private readonly createStartInput: InlineAiPanelOptions["createStartInput"];
  private readonly listHistory: InlineAiPanelOptions["listHistory"];
  private readonly openArtifact: InlineAiPanelOptions["openArtifact"];
  private readonly openSettings: InlineAiPanelOptions["openSettings"];
  private readonly canInsertArtifact: InlineAiPanelOptions["canInsertArtifact"];
  private readonly insertArtifact: InlineAiPanelOptions["insertArtifact"];
  private readonly renderMarkdown?: InlineAiPanelOptions["renderMarkdown"];
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly select: HTMLSelectElement;
  private readonly collapseButton: HTMLButtonElement;
  private readonly content: HTMLElement;
  private readonly status: HTMLElement;
  private readonly metadata: HTMLElement;
  private readonly body: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly history: HTMLElement;

  private operation?: AiOperation;
  private selectedConnectionId?: string;
  private snapshot?: Readonly<AiTaskSnapshot>;
  private origin?: ResultOrigin;
  private unsubscribe?: () => void;
  private epoch = 0;
  private renderEpoch = 0;
  private historyEpoch = 0;
  private loadingLatest = false;
  private collapsed = false;
  private destroyed = false;
  private actionSignature = "";
  private metadataSignature = "";

  constructor(options: InlineAiPanelOptions) {
    if (!(options.container instanceof HTMLElement)) {
      throw new TypeError("Invalid inline AI panel container");
    }
    if (options.locale !== "en" && options.locale !== "zh-CN") {
      throw new TypeError("Invalid inline AI panel locale");
    }
    if (typeof options.itemId !== "string" || !STABLE_ITEM_ID.test(options.itemId)) {
      throw new TypeError("Invalid inline AI panel item");
    }
    this.locale = options.locale;
    this.itemId = options.itemId;
    this.t = createTranslator(this.locale);
    this.connections = snapshotConnections(options.connections);
    this.selectedConnectionId = selectConnectionId(
      this.connections,
      options.defaultConnectionId,
    );

    const coordinator = options.coordinator;
    this.loadLatest = coordinator.loadLatest.bind(coordinator);
    this.start = coordinator.start.bind(coordinator);
    this.regenerateTask = coordinator.regenerate.bind(coordinator);
    this.subscribeTask = coordinator.subscribe.bind(coordinator);
    this.abortTask = coordinator.abort.bind(coordinator);
    this.createStartInput = options.createStartInput.bind(options);
    this.listHistory = options.listHistory.bind(options);
    this.openArtifact = options.openArtifact.bind(options);
    this.openSettings = options.openSettings.bind(options);
    this.canInsertArtifact = options.canInsertArtifact.bind(options);
    this.insertArtifact = options.insertArtifact.bind(options);
    this.renderMarkdown = options.renderMarkdown?.bind(options);

    const doc = options.container.ownerDocument;
    this.root = doc.createElement("section");
    this.root.className = "rss-dashboard-inline-ai";
    this.root.setAttribute("aria-label", this.t("ai.panel.regionLabel"));

    const header = doc.createElement("header");
    header.className = "rss-dashboard-inline-ai-header";
    this.title = doc.createElement("h3");
    this.title.className = "rss-dashboard-inline-ai-title";
    header.appendChild(this.title);

    const headerControls = doc.createElement("div");
    headerControls.className = "rss-dashboard-inline-ai-header-controls";
    const selectLabel = doc.createElement("label");
    selectLabel.className = "rss-dashboard-inline-ai-connection-label";
    selectLabel.textContent = this.t("ai.panel.connection");
    this.select = doc.createElement("select");
    this.select.className = "rss-dashboard-inline-ai-connection";
    this.select.setAttribute("aria-label", this.t("ai.panel.connection"));
    for (const connection of this.connections) {
      const option = doc.createElement("option");
      option.value = connection.id;
      option.textContent = connection.name;
      this.select.appendChild(option);
    }
    if (this.selectedConnectionId) this.select.value = this.selectedConnectionId;
    this.select.disabled = this.connections.length === 0;
    this.select.addEventListener("change", () => {
      if (this.destroyed) return;
      const selected = this.connections.find(({ id }) => id === this.select.value);
      if (selected) this.selectedConnectionId = selected.id;
    });
    selectLabel.appendChild(this.select);
    headerControls.appendChild(selectLabel);

    this.collapseButton = actionButton(
      doc,
      "collapse",
      this.t("ai.panel.collapse"),
    );
    this.collapseButton.setAttribute("aria-expanded", "true");
    this.collapseButton.addEventListener("click", () => {
      if (this.collapsed) this.expand();
      else this.collapse();
    });
    headerControls.appendChild(this.collapseButton);
    header.appendChild(headerControls);
    this.root.appendChild(header);

    this.content = doc.createElement("div");
    this.content.className = "rss-dashboard-inline-ai-content";
    this.status = doc.createElement("p");
    this.status.className = "rss-dashboard-inline-ai-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.status.setAttribute("aria-atomic", "true");
    this.metadata = doc.createElement("dl");
    this.metadata.className = "rss-dashboard-inline-ai-metadata";
    this.body = doc.createElement("div");
    this.body.className = "rss-dashboard-inline-ai-body";
    this.actions = doc.createElement("div");
    this.actions.className = "rss-dashboard-inline-ai-actions";
    this.history = doc.createElement("div");
    this.history.className = "rss-dashboard-inline-ai-history";
    this.history.hidden = true;
    this.content.append(
      this.status,
      this.metadata,
      this.body,
      this.actions,
      this.history,
    );
    this.root.appendChild(this.content);
    options.container.appendChild(this.root);
    this.renderHeader();
    this.renderNoConnectionOrIdle();
  }

  async show(operation: AiOperation): Promise<void> {
    if (this.destroyed || !OPERATIONS.has(operation)) return;
    const preservedOrigin = this.operation === operation
      ? this.origin
      : undefined;
    this.collapsed = false;
    this.operation = operation;
    this.origin = preservedOrigin;
    this.snapshot = undefined;
    this.loadingLatest = false;
    this.closeHistory();
    this.applyCollapsedState();
    this.renderHeader();
    const epoch = ++this.epoch;
    this.detach();

    if (!this.selectedConnectionId) {
      this.renderNoConnectionOrIdle();
      return;
    }

    try {
      this.attach(operation, epoch);
    } catch {
      this.renderFailure("invalid-request");
      return;
    }
    const replayed = this.currentSnapshot();
    if (replayed && replayed.status !== "idle") return;

    this.loadingLatest = true;
    let latest: AiTaskSnapshot;
    try {
      latest = await this.loadLatest(this.itemId, operation);
    } catch {
      if (this.isLive(epoch, operation)) this.renderFailure("provider-failure");
      return;
    } finally {
      if (this.isLive(epoch, operation)) this.loadingLatest = false;
    }
    if (!this.isLive(epoch, operation) || this.collapsed) return;
    const current = this.currentSnapshot();
    if (current && current.status !== "idle") return;
    const latestSnapshot = snapshotState(latest, this.itemId, operation);
    if (!latestSnapshot) {
      this.renderFailure("invalid-request");
      return;
    }
    if (latestSnapshot.status === "complete") this.origin = "history";
    this.receive(latestSnapshot, epoch, operation);
    if (latestSnapshot.status !== "idle") return;
    this.begin("start", epoch, operation);
  }

  collapse(): void {
    if (this.destroyed || this.collapsed) return;
    this.collapsed = true;
    this.epoch += 1;
    this.historyEpoch += 1;
    this.loadingLatest = false;
    this.detach();
    this.applyCollapsedState();
  }

  expand(): void {
    if (this.destroyed || !this.collapsed) return;
    const operation = this.operation;
    if (!operation) {
      this.collapsed = false;
      this.applyCollapsedState();
      this.renderNoConnectionOrIdle();
      return;
    }
    observeAsyncResult(
      this.show(operation),
      () => undefined,
      () => {
        if (!this.destroyed && this.operation === operation) {
          this.renderFailure("invalid-request");
        }
      },
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.epoch += 1;
    this.renderEpoch += 1;
    this.historyEpoch += 1;
    this.detach();
    this.root.remove();
  }

  private attach(operation: AiOperation, epoch: number): void {
    this.detach();
    const listener = (value: AiTaskSnapshot): void => {
      if (!this.isLive(epoch, operation)) return;
      const snapshot = snapshotState(value, this.itemId, operation);
      if (!snapshot) {
        this.renderFailure("invalid-request");
        return;
      }
      if (snapshot.status === "complete" && !this.origin) {
        this.origin = this.loadingLatest ||
            !snapshot.artifactPath ||
            !this.isVerifiedCurrentArtifact(snapshot.artifactPath)
          ? "history"
          : "current";
      }
      this.receive(snapshot, epoch, operation);
    };
    this.unsubscribe = this.subscribeTask(this.itemId, operation, listener);
  }

  private detach(): void {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    try {
      unsubscribe?.();
    } catch {
      // Detaching UI must never affect coordinator task lifetime.
    }
  }

  private receive(
    snapshot: Readonly<AiTaskSnapshot>,
    epoch: number,
    operation: AiOperation,
  ): void {
    if (!this.isLive(epoch, operation)) return;
    this.snapshot = snapshot;
    this.renderSnapshot(snapshot);
  }

  private begin(
    kind: "start" | "regenerate",
    epoch: number,
    operation: AiOperation,
  ): void {
    if (!this.isLive(epoch, operation) || !this.selectedConnectionId) return;
    let input: StartAiTaskInput;
    try {
      input = this.createStartInput(operation, this.selectedConnectionId);
      if (
        input.operation !== operation ||
        input.connectionId !== this.selectedConnectionId ||
        input.item?.id !== this.itemId ||
        typeof input.fetchFullText !== "boolean"
      ) {
        throw new TypeError("Invalid start input");
      }
    } catch {
      this.renderFailure("invalid-request");
      return;
    }
    this.origin = "current";
    let completion: Promise<AiTaskSnapshot>;
    try {
      completion = kind === "start" ? this.start(input) : this.regenerateTask(input);
    } catch {
      this.renderFailure("invalid-request");
      return;
    }
    observeAsyncResult(completion, (value) => {
      if (!this.isLive(epoch, operation)) return;
      const terminal = snapshotState(value, this.itemId, operation);
      if (terminal) this.receive(terminal, epoch, operation);
      else this.renderFailure("invalid-request");
    }, () => {
      if (this.isLive(epoch, operation)) this.renderFailure("provider-failure");
    });
  }

  private renderHeader(): void {
    const operationLabel = this.operation
      ? this.t(OPERATION_LABELS[this.operation])
      : this.t("ai.panel.defaultOperation");
    this.title.textContent = this.t("ai.panel.title", { operation: operationLabel });
  }

  private renderNoConnectionOrIdle(): void {
    this.status.textContent = this.selectedConnectionId
      ? this.t("ai.panel.status.idle")
      : this.t("ai.noEnabledConnection");
    this.status.dataset.status = this.selectedConnectionId ? "idle" : "no-connection";
    this.metadata.replaceChildren();
    this.body.replaceChildren();
    this.metadataSignature = "";
    this.renderActions();
  }

  private renderSnapshot(snapshot: Readonly<AiTaskSnapshot>): void {
    this.status.dataset.status = snapshot.status;
    this.status.textContent = statusText(this.t, snapshot, this.origin);
    this.renderMetadata(snapshot);
    this.renderBody(
      snapshot.status === "failed" || snapshot.status === "aborted"
        ? ""
        : snapshot.text,
    );
    this.renderActions();
  }

  private renderFailure(errorCode: AiOperationErrorCode): void {
    if (this.destroyed) return;
    const operation = this.operation ?? "summary";
    const failure = snapshotState({
      key: `${this.itemId}\0${operation}`,
      itemId: this.itemId,
      operation,
      status: "failed",
      text: "",
      errorCode,
    }, this.itemId, operation);
    if (!failure) return;
    this.snapshot = failure;
    this.origin = undefined;
    this.renderSnapshot(failure);
  }

  private renderMetadata(snapshot: Readonly<AiTaskSnapshot>): void {
    const signature = [
      snapshot.createdAt,
      snapshot.contentBasis,
      snapshot.connectionName,
      snapshot.model,
    ].join("\0");
    if (signature === this.metadataSignature) return;
    this.metadataSignature = signature;
    this.metadata.replaceChildren();
    addMetadata(
      this.metadata,
      this.t("ai.panel.generatedAt"),
      snapshot.createdAt,
    );
    addMetadata(
      this.metadata,
      this.t("ai.panel.contentBasis"),
      snapshot.contentBasis
        ? getContentBasisLabel(snapshot.contentBasis, this.locale)
        : undefined,
    );
    addMetadata(
      this.metadata,
      this.t("ai.panel.connection"),
      snapshot.connectionName ? boundedLabel(snapshot.connectionName) : undefined,
    );
    addMetadata(
      this.metadata,
      this.t("ai.panel.model"),
      snapshot.model ? boundedLabel(snapshot.model) : undefined,
    );
  }

  private renderBody(text: string): void {
    const renderEpoch = ++this.renderEpoch;
    this.body.textContent = text;
    if (!this.renderMarkdown || !text) return;
    const staging = this.body.ownerDocument.createElement("div");
    let result: Promise<void> | void;
    try {
      result = this.renderMarkdown(staging, text);
    } catch {
      return;
    }
    const commit = (): void => {
      if (
        this.destroyed ||
        renderEpoch !== this.renderEpoch ||
        this.snapshot?.text !== text
      ) {
        return;
      }
      this.body.replaceChildren(...Array.from(staging.childNodes));
    };
    try {
      if (!observeAsyncResult(result, commit, () => undefined)) commit();
    } catch {
      // A hostile thenable cannot replace the already-safe plain-text fallback.
    }
  }

  private renderActions(): void {
    const snapshot = this.snapshot;
    const status = snapshot?.status ?? (this.selectedConnectionId ? "idle" : "none");
    const path = snapshot?.artifactPath ?? "";
    let insertionAllowed = false;
    if (status === "complete" && this.origin === "current" && path) {
      insertionAllowed = this.isVerifiedCurrentArtifact(path);
    }
    const signature = [
      status,
      path,
      this.origin,
      insertionAllowed,
      this.selectedConnectionId,
    ].join("\0");
    if (signature === this.actionSignature) return;
    this.actionSignature = signature;
    this.actions.replaceChildren();
    if (!this.selectedConnectionId) {
      this.addAction("settings", this.t("ai.panel.configure"), () => {
        this.runAction(this.openSettings);
      });
      return;
    }
    if (status === "preparing" || status === "generating" || status === "saving") {
      this.addAction("stop", this.t("ai.panel.stop"), () => {
        if (this.destroyed || !this.operation) return;
        try {
          this.abortTask(this.itemId, this.operation);
        } catch {
          // Coordinator owns failure state; the UI never exposes raw errors.
        }
      });
      return;
    }
    if (status === "complete" && path) {
      this.addAction("regenerate", this.t("ai.panel.regenerate"), () => {
        this.regenerate();
      });
      this.addAction("open", this.t("ai.panel.openMarkdown"), () => {
        this.runPathAction(this.openArtifact, path);
      });
      if (insertionAllowed) {
        this.addAction("insert", this.t("ai.panel.insert"), () => {
          this.runPathAction(this.insertArtifact, path);
        });
      }
      this.addAction("history", this.t("ai.panel.history"), () => {
        this.toggleHistory();
      });
      return;
    }
    if (status === "failed" || status === "aborted") {
      this.addAction("retry", this.t("ai.retry"), () => {
        this.regenerate();
      });
      if (needsSettings(snapshot?.errorCode)) {
        this.addAction("settings", this.t("ai.panel.configure"), () => {
          this.runAction(this.openSettings);
        });
      }
    }
  }

  private addAction(
    action: string,
    label: string,
    listener: () => void,
  ): void {
    const button = actionButton(this.root.ownerDocument, action, label);
    button.addEventListener("click", () => {
      if (!this.destroyed) listener();
    });
    this.actions.appendChild(button);
  }

  private regenerate(): void {
    if (this.destroyed || !this.operation) return;
    const operation = this.operation;
    const epoch = ++this.epoch;
    this.closeHistory();
    try {
      this.attach(operation, epoch);
    } catch {
      this.renderFailure("invalid-request");
      return;
    }
    this.begin("regenerate", epoch, operation);
  }

  private toggleHistory(): void {
    if (this.destroyed || !this.operation) return;
    if (!this.history.hidden) {
      this.closeHistory();
      return;
    }
    const operation = this.operation;
    const epoch = ++this.historyEpoch;
    this.history.hidden = false;
    this.history.replaceChildren();
    const heading = this.root.ownerDocument.createElement("h4");
    heading.className = "rss-dashboard-inline-ai-history-title";
    heading.textContent = this.t("ai.panel.historyTitle");
    const loading = this.root.ownerDocument.createElement("p");
    loading.className = "rss-dashboard-inline-ai-history-message";
    loading.textContent = this.t("ai.panel.historyLoading");
    this.history.append(heading, loading);
    let request: Promise<readonly AiAnalysisArtifact[]>;
    try {
      request = this.listHistory(this.itemId, operation);
    } catch {
      this.renderHistoryFailure(epoch, operation);
      return;
    }
    observeAsyncResult(request, (value) => {
      if (!this.isHistoryLive(epoch, operation)) return;
      this.renderHistoryEntries(snapshotHistory(value, this.itemId, operation));
    }, () => this.renderHistoryFailure(epoch, operation));
  }

  private closeHistory(): void {
    this.historyEpoch += 1;
    this.history.hidden = true;
    this.history.replaceChildren();
  }

  private renderHistoryEntries(entries: readonly Readonly<HistoryEntry>[]): void {
    this.history.replaceChildren();
    const heading = this.root.ownerDocument.createElement("h4");
    heading.className = "rss-dashboard-inline-ai-history-title";
    heading.textContent = this.t("ai.panel.historyTitle");
    this.history.appendChild(heading);
    if (entries.length === 0) {
      const empty = this.root.ownerDocument.createElement("p");
      empty.className = "rss-dashboard-inline-ai-history-message";
      empty.textContent = this.t("ai.panel.historyEmpty");
      this.history.appendChild(empty);
      return;
    }
    const list = this.root.ownerDocument.createElement("div");
    list.className = "rss-dashboard-inline-ai-history-list";
    for (const entry of entries) {
      const row = actionButton(
        this.root.ownerDocument,
        "history-entry",
        entry.createdAt,
      );
      row.classList.add("rss-dashboard-inline-ai-history-entry");
      row.dataset.path = entry.path;
      const time = this.root.ownerDocument.createElement("span");
      time.className = "rss-dashboard-inline-ai-history-time";
      time.textContent = entry.createdAt;
      const detail = this.root.ownerDocument.createElement("span");
      detail.className = "rss-dashboard-inline-ai-history-detail";
      detail.textContent = [entry.connectionName, entry.model]
        .filter(Boolean)
        .join(" · ");
      row.replaceChildren(time, detail);
      row.addEventListener("click", () => {
        this.runPathAction(this.openArtifact, entry.path);
      });
      list.appendChild(row);
    }
    this.history.appendChild(list);
  }

  private renderHistoryFailure(epoch: number, operation: AiOperation): void {
    if (!this.isHistoryLive(epoch, operation)) return;
    this.history.replaceChildren();
    const message = this.root.ownerDocument.createElement("p");
    message.className = "rss-dashboard-inline-ai-history-message";
    message.textContent = this.t("ai.panel.historyFailed");
    this.history.appendChild(message);
  }

  private runPathAction(
    action: (path: string) => Promise<void> | void,
    path: string,
  ): void {
    if (this.destroyed) return;
    this.runAction(() => action(path));
  }

  private isVerifiedCurrentArtifact(path: string): boolean {
    try {
      return this.canInsertArtifact(path) === true;
    } catch {
      return false;
    }
  }

  private runAction(action: () => Promise<void> | void): void {
    if (this.destroyed) return;
    try {
      const result = action();
      observeAsyncResult(result, () => undefined, () => undefined);
    } catch {
      // User actions fail closed; Task 8 can surface host notices separately.
    }
  }

  private applyCollapsedState(): void {
    this.content.hidden = this.collapsed;
    this.root.classList.toggle("is-collapsed", this.collapsed);
    this.collapseButton.dataset.action = this.collapsed ? "expand" : "collapse";
    this.collapseButton.textContent = this.t(
      this.collapsed ? "ai.panel.expand" : "ai.panel.collapse",
    );
    this.collapseButton.setAttribute("aria-expanded", String(!this.collapsed));
  }

  private isLive(epoch: number, operation: AiOperation): boolean {
    return (
      !this.destroyed &&
      !this.collapsed &&
      this.epoch === epoch &&
      this.operation === operation
    );
  }

  private currentSnapshot(): Readonly<AiTaskSnapshot> | undefined {
    return this.snapshot;
  }

  private isHistoryLive(epoch: number, operation: AiOperation): boolean {
    return (
      !this.destroyed &&
      !this.collapsed &&
      !this.history.hidden &&
      this.historyEpoch === epoch &&
      this.operation === operation
    );
  }
}

function snapshotConnections(
  values: readonly AiConnection[],
): readonly Readonly<ConnectionDescriptor>[] {
  if (!Array.isArray(values) || values.length > 1_000) return Object.freeze([]);
  const result: Readonly<ConnectionDescriptor>[] = [];
  const ids = new Set<string>();
  for (const value of values) {
    const normalized = normalizeAiConnection(value);
    if (!normalized?.enabled || ids.has(normalized.id)) continue;
    ids.add(normalized.id);
    result.push(Object.freeze({
      id: normalized.id,
      name: boundedLabel(normalized.name),
    }));
  }
  return Object.freeze(result);
}

function selectConnectionId(
  connections: readonly Readonly<ConnectionDescriptor>[],
  defaultConnectionId: unknown,
): string | undefined {
  if (typeof defaultConnectionId === "string") {
    const selected = connections.find(({ id }) => id === defaultConnectionId);
    if (selected) return selected.id;
  }
  return connections[0]?.id;
}

function boundedLabel(value: string): string {
  return value.length <= MAX_CONNECTION_NAME_CHARACTERS
    ? value
    : `${value.slice(0, MAX_CONNECTION_NAME_CHARACTERS - 1)}…`;
}

function snapshotState(
  value: unknown,
  itemId: string,
  operation: AiOperation,
): Readonly<AiTaskSnapshot> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Partial<AiTaskSnapshot>;
  if (
    source.itemId !== itemId ||
    source.operation !== operation ||
    typeof source.status !== "string" ||
    !STATUSES.has(source.status) ||
    !safePanelText(source.text)
  ) {
    return undefined;
  }
  const status = source.status;
  const connectionId = optionalBoundedText(source.connectionId, 200);
  const connectionName = optionalBoundedText(
    source.connectionName,
    MAX_AI_ANALYSIS_METADATA_CHARACTERS,
  );
  const model = optionalBoundedText(
    source.model,
    MAX_AI_ANALYSIS_METADATA_CHARACTERS,
  );
  const contentBasis = optionalContentBasis(source.contentBasis);
  const artifactPath = optionalArtifactPath(source.artifactPath);
  const createdAt = source.createdAt === undefined
    ? undefined
    : typeof source.createdAt === "string" &&
        isCanonicalAiAnalysisTimestamp(source.createdAt)
      ? source.createdAt
      : null;
  const errorCode = source.errorCode === undefined
    ? undefined
    : typeof source.errorCode === "string" && ERROR_CODES.has(source.errorCode)
      ? source.errorCode
      : null;
  if (
    connectionId === null ||
    connectionName === null ||
    model === null ||
    contentBasis === null ||
    artifactPath === null ||
    createdAt === null ||
    errorCode === null
  ) {
    return undefined;
  }
  return Object.freeze({
    key: `${itemId}\0${operation}`,
    itemId,
    operation,
    status,
    text: source.text,
    ...(connectionId ? { connectionId } : {}),
    ...(connectionName ? { connectionName } : {}),
    ...(model ? { model } : {}),
    ...(contentBasis ? { contentBasis } : {}),
    ...(artifactPath ? { artifactPath } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(errorCode ? { errorCode } : {}),
  });
}

function safePanelText(value: unknown): value is string {
  return typeof value === "string" &&
    (value.length === 0 || safeAnalysisText(value, MAX_AI_ANALYSIS_TEXT_CHARACTERS));
}

function optionalBoundedText(
  value: unknown,
  maximum: number,
): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" &&
      value.length > 0 &&
      safeAnalysisText(value, maximum)
    ? value
    : null;
}

function optionalArtifactPath(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_ARTIFACT_PATH_CHARACTERS ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return null;
  }
  const segments = value.split("/");
  return segments.some((segment) => !segment || segment === "." || segment === "..")
    ? null
    : value;
}

function optionalContentBasis(value: unknown): ContentBasis | undefined | null {
  if (value === undefined) return undefined;
  return value === "feed" ||
      value === "full-text" ||
      value === "youtube-transcript" ||
      value === "title-description" ||
      value === "x-post" ||
      value === "linked-page"
    ? value
    : null;
}

function statusText(
  t: Translator,
  snapshot: Readonly<AiTaskSnapshot>,
  origin: ResultOrigin | undefined,
): string {
  switch (snapshot.status) {
    case "idle":
      return t("ai.panel.status.idle");
    case "preparing":
      return t("ai.panel.status.preparing");
    case "generating":
      return t("ai.panel.status.generating");
    case "saving":
      return t("ai.panel.status.saving");
    case "complete":
      return t(origin === "history"
        ? "ai.panel.status.completeHistory"
        : "ai.panel.status.completeCurrent");
    case "aborted":
      return t("ai.panel.status.aborted");
    case "failed":
      return errorText(t, snapshot.errorCode);
  }
}

function errorText(t: Translator, code: AiOperationErrorCode | undefined): string {
  switch (code) {
    case "missing-key":
      return t("ai.error.missingKey");
    case "invalid-key":
      return t("ai.error.invalidKey");
    case "insufficient-balance":
      return t("ai.error.insufficientBalance");
    case "rate-limited":
      return t("ai.error.rateLimited");
    case "timeout":
      return t("ai.error.timeout");
    case "invalid-connection":
    case "connection-disabled":
    case "connection-not-found":
    case "secret-store-failure":
      return t("ai.error.invalidConnection");
    case "invalid-request":
    case "invalid-operation":
    case "provider-rejected":
      return t("ai.error.invalidRequest");
    case "network-failure":
      return t("ai.error.network");
    case "empty-output":
      return t("ai.error.emptyOutput");
    case "aborted":
      return t("ai.panel.status.aborted");
    default:
      return t("ai.error.failed");
  }
}

function needsSettings(code: AiOperationErrorCode | undefined): boolean {
  return code === "missing-key" ||
    code === "invalid-key" ||
    code === "invalid-connection" ||
    code === "connection-disabled" ||
    code === "connection-not-found" ||
    code === "secret-store-failure";
}

function addMetadata(
  container: HTMLElement,
  label: string,
  value: string | undefined,
): void {
  if (!value) return;
  const row = container.ownerDocument.createElement("div");
  const term = container.ownerDocument.createElement("dt");
  const detail = container.ownerDocument.createElement("dd");
  term.textContent = label;
  detail.textContent = value;
  row.append(term, detail);
  container.appendChild(row);
}

function actionButton(
  doc: Document,
  action: string,
  label: string,
): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.dataset.action = action;
  button.textContent = label;
  return button;
}

function snapshotHistory(
  value: unknown,
  itemId: string,
  operation: AiOperation,
): readonly Readonly<HistoryEntry>[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const entries: Readonly<HistoryEntry>[] = [];
  for (const candidate of value.slice(0, MAX_HISTORY_ENTRIES)) {
    const entry = snapshotHistoryEntry(candidate, itemId, operation);
    if (entry) entries.push(entry);
  }
  entries.sort((left, right) =>
    compareText(right.createdAt, left.createdAt) ||
    compareText(left.path, right.path));
  return Object.freeze(entries);
}

function snapshotHistoryEntry(
  value: unknown,
  itemId: string,
  operation: AiOperation,
): Readonly<HistoryEntry> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const artifact = value as Partial<AiAnalysisArtifact>;
  const path = optionalArtifactPath(artifact.path);
  const record = artifact.record as Partial<AiAnalysisHistoryRecord> | undefined;
  if (
    !path ||
    !record ||
    record.itemId !== itemId ||
    record.operation !== operation ||
    typeof record.createdAt !== "string" ||
    !isCanonicalAiAnalysisTimestamp(record.createdAt)
  ) {
    return undefined;
  }
  const connectionName = optionalBoundedText(
    record.connectionName,
    MAX_AI_ANALYSIS_METADATA_CHARACTERS,
  );
  const model = optionalBoundedText(
    record.model,
    MAX_AI_ANALYSIS_METADATA_CHARACTERS,
  );
  if (!connectionName || !model) return undefined;
  return Object.freeze({
    path,
    createdAt: record.createdAt,
    connectionName: boundedLabel(connectionName),
    model: boundedLabel(model),
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function observeAsyncResult<T>(
  value: PromiseLike<T> | T | void,
  onFulfilled: (result: T) => void,
  onRejected: () => void,
): boolean {
  if (value === undefined) return false;
  let derived: Promise<unknown>;
  try {
    // Instance `.then` is intentionally bypassed to observe hostile Promises.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    derived = Reflect.apply(Promise.prototype.then, value, [
      onFulfilled,
      onRejected,
    ]) as Promise<unknown>;
  } catch {
    let assimilated: Promise<Awaited<T>>;
    try {
      assimilated = Promise.resolve(value);
    } catch {
      onRejected();
      return true;
    }
    try {
      // The assimilated native Promise is observed through the same intrinsic.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      derived = Reflect.apply(Promise.prototype.then, assimilated, [
        onFulfilled,
        onRejected,
      ]) as Promise<unknown>;
    } catch {
      onRejected();
      return true;
    }
  }
  sinkNativeRejection(derived);
  return true;
}

function sinkNativeRejection(value: Promise<unknown>): void {
  try {
    // Avoid property access while adding the terminal rejection sink.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    void Reflect.apply(Promise.prototype.then, value, [
      undefined,
      () => undefined,
    ]);
  } catch {
    // The original rejection is already observed; a hostile derived species
    // cannot expose its reason through this fire-and-forget boundary.
  }
}

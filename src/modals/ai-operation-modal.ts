import { App, Modal, Notice } from "obsidian";
import type { AiConnection } from "../ai/ai-types";
import {
  AiOperationError,
  type AiOperationResult,
  type AiOperationService,
} from "../ai/ai-operation-service";
import {
  snapshotAiAnalysisResult,
  type AiAnalysisResult,
} from "../ai/analysis-result";
import type { AnalysisRepository } from "../ai/analysis-repository";
import type {
  AiContentSelector,
  SelectedAiContent,
} from "../ai/content/ai-content-selector";
import { normalizeAiConnection } from "../ai/connection-validation";
import type { AnalysisNoteInsertResult } from "../ai/analysis-note-inserter";
import type { AiOperation } from "../ai/prompts/prompt-types";
import { waitForTrustedAbortWork } from "../ai/trusted-abort";
import { getContentBasisLabel } from "../collection/content-basis-display";
import type { CollectedItem, SourceType } from "../collection/collected-item";
import {
  createTranslator,
  type Locale,
  type TranslationKey,
  type Translator,
} from "../i18n";

const FETCHABLE_SOURCE_TYPES = new Set<SourceType>([
  "rss",
  "atom",
  "json",
  "podcast",
  "website",
]);

const OPERATION_LABEL_KEYS: Readonly<Record<AiOperation, TranslationKey>> =
  Object.freeze({
    summary: "ai.operation.summary",
    "translate-zh-cn": "ai.operation.translateZhCn",
    "core-points": "ai.operation.corePoints",
    "deep-analysis": "ai.operation.deepAnalysis",
  });

export interface AiOperationModalOptions {
  locale?: Locale;
  operation: AiOperation;
  item: CollectedItem;
  connections: AiConnection[];
  defaultConnectionId?: string;
  contentSelector: Pick<AiContentSelector, "select">;
  operationService: Pick<AiOperationService, "run">;
  analysisRepository: Pick<AnalysisRepository, "save">;
  createResultId?: () => string;
  now?: () => Date;
  openAnalysis(path: string): Promise<void> | void;
  getSavedNotePath(): string | undefined;
  insertIntoSavedNote(
    result: AiAnalysisResult,
    notePath: string,
  ): Promise<AnalysisNoteInsertResult>;
  openSavedNote(notePath: string, marker: string): Promise<void> | void;
  saveArticleFirst(): Promise<void> | void;
}

export interface OpenAiOperationModalOptions {
  connections: AiConnection[];
  locale?: Locale;
  openSettings(): void;
  createModal(enabledConnections: AiConnection[]): AiOperationModal;
  showNotice?: (message: string) => void;
}

/** Checks the optional-AI gate before constructing anything that can read a key. */
export function openAiOperationModal(
  options: OpenAiOperationModalOptions,
): AiOperationModal | null {
  const enabledConnections = options.connections
    .map((connection) => normalizeAiConnection(connection))
    .filter((connection): connection is AiConnection =>
      Boolean(connection?.enabled));
  if (enabledConnections.length === 0) {
    const message = createTranslator(options.locale ?? "zh-CN")(
      "ai.noEnabledConnection",
    );
    (options.showNotice ?? ((value) => { new Notice(value); }))(message);
    options.openSettings();
    return null;
  }
  const modal = options.createModal(enabledConnections);
  modal.open();
  return modal;
}

export class AiOperationModal extends Modal {
  private lifecycleEpoch = 0;
  private previewEpoch = 0;
  private requestInFlight = false;
  private storageInFlight = false;
  private closeAfterStorage = false;
  private activeController: AbortController | null = null;

  constructor(app: App, private readonly options: AiOperationModalOptions) {
    super(app);
  }

  override onOpen(): void {
    const lifecycle = ++this.lifecycleEpoch;
    this.previewEpoch = 0;
    this.requestInFlight = false;
    this.storageInFlight = false;
    this.closeAfterStorage = false;
    this.activeController = null;

    const locale = this.options.locale ?? "zh-CN";
    const t = createTranslator(locale);
    const connections = this.options.connections
      .map((connection) => normalizeAiConnection(connection))
      .filter((connection): connection is AiConnection =>
        Boolean(connection?.enabled));
    const selectedDefault = connections.find(
      ({ id }) => id === this.options.defaultConnectionId,
    );
    let selectedConnection = selectedDefault ?? connections[0];
    let preview: SelectedAiContent | null = null;
    let fetchFullText = false;
    let pendingResult: AiAnalysisResult | null = null;
    let savedPath: string | null = null;
    let cancelled = false;

    this.contentEl.empty();
    this.modalEl.addClass("rss-dashboard-modal");
    this.contentEl.createEl("h2", {
      text: t("ai.modal.title", {
        operation: t(OPERATION_LABEL_KEYS[this.options.operation]),
      }),
    });
    const connectionField = this.contentEl.createDiv({
      cls: "rss-dashboard-ai-operation-connection",
    });
    connectionField.createEl("label", {
      text: t("ai.preview.connection"),
      attr: { for: "rss-dashboard-ai-operation-connection" },
    });
    const connectionSelect = connectionField.createEl("select", {
      cls: "rss-dashboard-ai-connection-select",
      attr: { id: "rss-dashboard-ai-operation-connection" },
    });
    for (const connection of connections) {
      connectionSelect.createEl("option", {
        value: connection.id,
        text: connection.name,
      });
    }
    if (selectedConnection) connectionSelect.value = selectedConnection.id;

    this.contentEl.createEl("h3", { text: t("ai.preview.heading") });
    const previewEl = this.contentEl.createDiv({
      cls: "rss-dashboard-ai-operation-preview",
    });
    const statusEl = this.contentEl.createEl("p", {
      cls: "rss-dashboard-ai-operation-status",
    });
    statusEl.setAttribute("role", "status");
    statusEl.setAttribute("aria-live", "polite");
    const resultEl = this.contentEl.createDiv({
      cls: "rss-dashboard-ai-operation-result",
    });
    const controls = this.contentEl.createDiv({
      cls: "rss-dashboard-ai-operation-controls",
    });
    const cancelButton = controls.createEl("button", {
      text: t("ai.cancelGeneration"),
    });
    const confirmButton = controls.createEl("button", {
      text: t("ai.confirm"),
      cls: "mod-cta",
    });

    const isCurrent = (): boolean =>
      lifecycle === this.lifecycleEpoch && this.contentEl.isConnected;
    const setRequestBusy = (busy: boolean): void => {
      this.requestInFlight = busy;
      confirmButton.disabled = busy || !preview;
      confirmButton.setAttribute("aria-disabled", String(confirmButton.disabled));
      connectionSelect.disabled = busy;
      connectionSelect.setAttribute("aria-disabled", String(busy));
      cancelButton.disabled = !busy;
      cancelButton.setAttribute("aria-disabled", String(!busy));
    };

    const renderPreview = (): void => {
      if (!isCurrent() || !selectedConnection) return;
      previewEl.empty();
      if (!preview) {
        previewEl.createEl("p", { text: t("ai.preview.loading") });
        return;
      }
      addPreviewRow(previewEl, t("ai.preview.sourceTitle"), preview.title);
      addPreviewRow(previewEl, t("ai.preview.sourceName"), preview.sourceName);
      addPreviewRow(
        previewEl,
        t("ai.preview.contentBasis"),
        getContentBasisLabel(preview.basis, locale),
      );
      addPreviewRow(
        previewEl,
        t("ai.preview.characterCount", { count: preview.characterCount }),
        t(preview.truncated ? "ai.preview.truncated" : "ai.preview.notTruncated"),
      );
      addPreviewRow(
        previewEl,
        t("ai.preview.connection"),
        selectedConnection.name,
      );
      addPreviewRow(previewEl, t("ai.preview.model"), selectedConnection.model);

      if (
        preview.basis !== "full-text" &&
        FETCHABLE_SOURCE_TYPES.has(this.options.item.sourceType)
      ) {
        const toggleRow = previewEl.createDiv({
          cls: "rss-dashboard-ai-full-text-row",
        });
        const toggle = toggleRow.createEl("input", {
          cls: "rss-dashboard-ai-full-text-toggle",
          attr: { type: "checkbox" },
        });
        toggle.checked = fetchFullText;
        const label = toggleRow.createEl("label", {
          text: t("ai.preview.fullText"),
        });
        label.prepend(toggle);
        toggleRow.createEl("p", { text: t("ai.preview.fullTextDesc") });
        toggle.addEventListener("change", () => {
          fetchFullText = toggle.checked;
        });
      } else {
        fetchFullText = false;
      }
    };

    const loadPreview = async (): Promise<void> => {
      if (!selectedConnection || !isCurrent() || this.requestInFlight) return;
      const request = ++this.previewEpoch;
      preview = null;
      fetchFullText = false;
      confirmButton.disabled = true;
      renderPreview();
      try {
        const selected = await this.options.contentSelector.select({
          item: this.options.item,
          maxInputCharacters: selectedConnection.maxInputCharacters,
          fetchFullText: false,
        });
        if (!isCurrent() || request !== this.previewEpoch) return;
        preview = selected;
        statusEl.setText("");
        renderPreview();
        setRequestBusy(false);
      } catch {
        if (!isCurrent() || request !== this.previewEpoch) return;
        preview = null;
        previewEl.empty();
        statusEl.setText(t("ai.preview.failed"));
        setRequestBusy(false);
      }
    };

    const renderSavedActions = (): void => {
      if (!isCurrent() || !pendingResult || !savedPath) return;
      resultEl.empty();
      resultEl.createEl("p", {
        text: t("ai.result.saved", { path: savedPath }),
      });
      const openButton = resultEl.createEl("button", {
        text: t("ai.result.open"),
      });
      openButton.addEventListener("click", () => {
        void (async () => {
          try {
            await this.options.openAnalysis(savedPath as string);
          } catch {
            if (isCurrent()) statusEl.setText(t("ai.result.openFailed"));
          }
        })();
      });

      const savedNotePath = this.options.getSavedNotePath();
      if (!savedNotePath) {
        resultEl.createEl("p", { text: t("ai.result.savedNoteRequired") });
        const saveSourceButton = resultEl.createEl("button", {
          text: t("ai.result.saveSourceFirst"),
        });
        saveSourceButton.addEventListener("click", () => {
          if (saveSourceButton.disabled || this.storageInFlight) return;
          saveSourceButton.disabled = true;
          this.storageInFlight = true;
          statusEl.setText(t("ai.result.savingSource"));
          void (async () => {
            try {
              await this.options.saveArticleFirst();
              const closed = this.finishPersistence();
              if (closed || !isCurrent()) return;
              statusEl.setText("");
              renderSavedActions();
            } catch {
              const closed = this.finishPersistence();
              if (!closed && isCurrent()) {
                statusEl.setText(t("ai.result.saveSourceFailed"));
              }
            } finally {
              if (isCurrent() && !this.storageInFlight) {
                saveSourceButton.disabled = false;
              }
            }
          })();
        });
        return;
      }

      const insertButton = resultEl.createEl("button", {
        text: t("ai.result.insert"),
      });
      insertButton.addEventListener("click", () => {
        if (insertButton.disabled || !pendingResult || this.storageInFlight) return;
        insertButton.disabled = true;
        this.storageInFlight = true;
        statusEl.setText(t("ai.result.inserting"));
        const result = pendingResult;
        void (async () => {
          try {
            const outcome = await this.options.insertIntoSavedNote(
              result,
              savedNotePath,
            );
            const closed = this.finishPersistence();
            if (closed || !isCurrent()) return;
            statusEl.setText(t(outcome.status === "existing"
              ? "ai.result.alreadyInserted"
              : "ai.result.inserted"));
            if (outcome.status === "existing") {
              await this.options.openSavedNote(outcome.notePath, outcome.marker);
            }
          } catch {
            const closed = this.finishPersistence();
            if (!closed && isCurrent()) {
              statusEl.setText(t("ai.result.insertFailed"));
            }
          } finally {
            if (isCurrent() && !this.storageInFlight) {
              insertButton.disabled = false;
            }
          }
        })();
      });
    };

    const runOperation = async (): Promise<void> => {
      if (
        !isCurrent() ||
        this.requestInFlight ||
        this.storageInFlight ||
        !preview ||
        !selectedConnection
      ) return;
      cancelled = false;
      pendingResult = null;
      savedPath = null;
      resultEl.empty();
      statusEl.setText(t("ai.generating"));
      confirmButton.setText(t("ai.retry"));
      const controller = new AbortController();
      this.activeController = controller;
      setRequestBusy(true);
      try {
        const operationResult = await this.options.operationService.run({
          operation: this.options.operation,
          item: this.options.item,
          connectionId: selectedConnection.id,
          fetchFullText,
          signal: controller.signal,
        });
        if (!isCurrent() || cancelled || controller.signal.aborted) return;
        pendingResult = createAnalysisResult(
          operationResult,
          this.options.item,
          this.options.operation,
          selectedConnection,
          (this.options.createResultId ?? defaultResultId)(),
          (this.options.now ?? (() => new Date()))(),
        );
        this.storageInFlight = true;
        setRequestBusy(false);
        confirmButton.disabled = true;
        cancelButton.disabled = true;
        statusEl.setText(t("ai.saving"));
        try {
          savedPath = await this.options.analysisRepository.save(pendingResult);
        } catch {
          pendingResult = null;
          const closed = this.finishPersistence();
          if (!closed && isCurrent()) {
            statusEl.setText(t("ai.result.artifactSaveFailed"));
            confirmButton.disabled = false;
          }
          return;
        }
        if (this.finishPersistence()) return;
        if (!isCurrent()) return;
        statusEl.setText("");
        renderSavedActions();
      } catch (error) {
        if (!isCurrent()) return;
        if (cancelled || controller.signal.aborted) {
          statusEl.setText(t("ai.cancelled"));
          await waitForTrustedAbortWork(controller.signal);
        } else {
          statusEl.setText(t(operationErrorKey(error)));
        }
      } finally {
        if (this.activeController === controller) this.activeController = null;
        if (isCurrent() && !this.storageInFlight && !savedPath) {
          setRequestBusy(false);
        }
      }
    };

    connectionSelect.addEventListener("change", () => {
      if (this.requestInFlight) return;
      const connection = connections.find(({ id }) => id === connectionSelect.value);
      if (!connection) return;
      selectedConnection = connection;
      void loadPreview();
    });
    confirmButton.addEventListener("click", () => { void runOperation(); });
    cancelButton.addEventListener("click", () => {
      if (!this.requestInFlight || !this.activeController) return;
      cancelled = true;
      this.activeController.abort();
      cancelButton.disabled = true;
      statusEl.setText(t("ai.cancelled"));
    });
    setRequestBusy(false);
    renderPreview();
    void loadPreview();
  }

  override close(): void {
    if (this.storageInFlight) {
      this.closeAfterStorage = true;
      return;
    }
    super.close();
  }

  private finishPersistence(): boolean {
    this.storageInFlight = false;
    if (!this.closeAfterStorage) return false;
    super.close();
    return true;
  }

  override onClose(): void {
    this.lifecycleEpoch += 1;
    this.previewEpoch += 1;
    this.activeController?.abort();
    this.activeController = null;
    this.contentEl.empty();
  }
}

function addPreviewRow(
  container: HTMLElement,
  label: string,
  value: string,
): void {
  const row = container.createDiv({ cls: "rss-dashboard-ai-preview-row" });
  row.createSpan({ cls: "rss-dashboard-ai-preview-label", text: `${label}：` });
  row.createSpan({ text: value });
}

function createAnalysisResult(
  generated: AiOperationResult,
  item: CollectedItem,
  operation: AiOperation,
  connection: AiConnection,
  id: string,
  now: Date,
): AiAnalysisResult {
  if (
    generated.itemId !== item.id ||
    generated.operation !== operation ||
    generated.connectionId !== connection.id ||
    generated.connectionName !== connection.name ||
    generated.providerKind !== connection.providerKind ||
    generated.model !== connection.model
  ) {
    throw new Error("AI operation provenance mismatch");
  }
  return snapshotAiAnalysisResult({
    schemaVersion: 1,
    id,
    itemId: generated.itemId,
    ...(item.url ? { sourceUrl: item.url } : {}),
    operation: generated.operation,
    createdAt: now.toISOString(),
    connectionId: generated.connectionId,
    connectionName: generated.connectionName,
    providerKind: generated.providerKind,
    model: generated.model,
    contentBasis: generated.contentBasis,
    inputCharacterCount: generated.inputCharacterCount,
    inputTruncated: generated.inputTruncated,
    text: generated.text,
  });
}

function operationErrorKey(error: unknown): TranslationKey {
  const code = error instanceof AiOperationError ? error.code : "unknown";
  switch (code) {
    case "missing-key":
    case "secret-store-failure":
      return "ai.error.missingKey";
    case "invalid-key":
      return "ai.error.invalidKey";
    case "insufficient-balance":
      return "ai.error.insufficientBalance";
    case "rate-limited":
      return "ai.error.rateLimited";
    case "timeout":
      return "ai.error.timeout";
    case "connection-not-found":
    case "connection-disabled":
    case "invalid-connection":
      return "ai.error.invalidConnection";
    case "invalid-request":
    case "provider-rejected":
      return "ai.error.invalidRequest";
    case "network-failure":
      return "ai.error.network";
    case "empty-output":
      return "ai.error.emptyOutput";
    case "aborted":
      return "ai.error.cancelled";
    default:
      return "ai.error.failed";
  }
}

function defaultResultId(): string {
  const id = window.crypto?.randomUUID?.();
  if (!id) throw new Error("A secure UUID generator is required");
  return id;
}

export function aiOperationLabel(
  operation: AiOperation,
  t: Translator,
): string {
  return t(OPERATION_LABEL_KEYS[operation]);
}

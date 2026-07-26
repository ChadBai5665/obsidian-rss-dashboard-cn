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
import {
  AnalysisArtifactVerificationError,
  type AnalysisRepository,
} from "../ai/analysis-repository";
import type {
  AiContentSelector,
  SelectedAiContent,
} from "../ai/content/ai-content-selector";
import { normalizeAiConnection } from "../ai/connection-validation";
import { resolveAiConnectionForRequest } from "../ai/provider-presets";
import type { AnalysisNoteInsertResult } from "../ai/analysis-note-inserter";
import { buildAiPrompt } from "../ai/prompts/prompt-builder";
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

interface PreparedAiPreview {
  selectedContent: SelectedAiContent;
  contentBasis: SelectedAiContent["basis"];
  inputCharacterCount: number;
  inputTruncated: boolean;
}

export interface AiOperationModalOptions {
  locale?: Locale;
  operation: AiOperation;
  item: CollectedItem;
  connections: AiConnection[];
  defaultConnectionId?: string;
  contentSelector: Pick<AiContentSelector, "select">;
  operationService: Pick<AiOperationService, "runPrepared">;
  analysisRepository: Pick<AnalysisRepository, "save">;
  createResultId?: () => string;
  now?: () => Date;
  openAnalysis(path: string): Promise<void> | void;
  getSavedNotePath(): string | undefined;
  insertIntoSavedNote(
    result: AiAnalysisResult,
    artifactPath: string,
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
  private activePreviewController: AbortController | null = null;

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
    this.activePreviewController = null;

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
    let preview: PreparedAiPreview | null = null;
    let fetchFullText = false;
    let previewReadyForSend = false;
    let previewInFlight = false;
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
      const controlsBlocked = busy || previewInFlight;
      confirmButton.disabled = controlsBlocked || !preview;
      confirmButton.setAttribute("aria-disabled", String(confirmButton.disabled));
      connectionSelect.disabled = controlsBlocked;
      connectionSelect.setAttribute("aria-disabled", String(controlsBlocked));
      cancelButton.disabled = !busy;
      cancelButton.setAttribute("aria-disabled", String(!busy));
      const toggle = previewEl.querySelector<HTMLInputElement>(
        ".rss-dashboard-ai-full-text-toggle",
      );
      if (toggle) {
        toggle.disabled = controlsBlocked;
        toggle.setAttribute("aria-disabled", String(controlsBlocked));
      }
    };

    const renderPreview = (): void => {
      if (!isCurrent() || !selectedConnection) return;
      const effectiveConnection = resolveAiConnectionForRequest(selectedConnection);
      if (!effectiveConnection) return;
      previewEl.empty();
      if (!preview) {
        previewEl.createEl("p", { text: t("ai.preview.loading") });
        return;
      }
      addPreviewRow(
        previewEl,
        t("ai.preview.sourceTitle"),
        preview.selectedContent.title,
      );
      addPreviewRow(
        previewEl,
        t("ai.preview.sourceName"),
        preview.selectedContent.sourceName,
      );
      addPreviewRow(
        previewEl,
        t("ai.preview.contentBasis"),
        getContentBasisLabel(preview.contentBasis, locale),
      );
      addPreviewRow(
        previewEl,
        t("ai.preview.characterCount", { count: preview.inputCharacterCount }),
        t(preview.inputTruncated
          ? "ai.preview.truncated"
          : "ai.preview.notTruncated"),
      );
      addPreviewRow(
        previewEl,
        t("ai.preview.connection"),
        selectedConnection.name,
      );
      addPreviewRow(previewEl, t("ai.preview.model"), effectiveConnection.model);

      if (
        preview.contentBasis !== "full-text" &&
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
          previewReadyForSend = !fetchFullText;
          if (fetchFullText) {
            statusEl.setText(t("ai.preview.fullTextNeedsConfirmation"));
          } else {
            void loadPreview(false);
          }
        });
      } else {
        previewReadyForSend = true;
      }
      setRequestBusy(this.requestInFlight);
    };

    const loadPreview = async (requestFullText: boolean): Promise<boolean> => {
      if (
        !selectedConnection ||
        !isCurrent() ||
        this.requestInFlight ||
        previewInFlight
      ) return false;
      const request = ++this.previewEpoch;
      const connection = selectedConnection;
      const controller = new AbortController();
      this.activePreviewController?.abort();
      this.activePreviewController = controller;
      previewInFlight = true;
      previewReadyForSend = false;
      const previousPreview = preview;
      preview = null;
      renderPreview();
      setRequestBusy(false);
      try {
        const selected = await this.options.contentSelector.select({
          item: this.options.item,
          maxInputCharacters: connection.maxInputCharacters,
          fetchFullText: requestFullText,
          signal: controller.signal,
        });
        if (
          !isCurrent() ||
          request !== this.previewEpoch ||
          controller.signal.aborted
        ) return false;
        preview = preparePreview(
          selected,
          this.options.item.id,
          this.options.operation,
          connection.maxInputCharacters,
        );
        previewReadyForSend = true;
        statusEl.setText(requestFullText
          ? t(preview.contentBasis === "full-text"
            ? "ai.preview.fullTextReady"
            : "ai.preview.fullTextFallback")
          : "");
        renderPreview();
        return true;
      } catch {
        if (!isCurrent() || request !== this.previewEpoch) return false;
        preview = requestFullText ? previousPreview : null;
        if (preview) renderPreview();
        else previewEl.empty();
        statusEl.setText(t(requestFullText
          ? "ai.preview.fullTextFailed"
          : "ai.preview.failed"));
        return false;
      } finally {
        if (this.activePreviewController === controller) {
          this.activePreviewController = null;
        }
        if (request === this.previewEpoch) {
          previewInFlight = false;
          if (isCurrent()) setRequestBusy(false);
        }
      }
    };

    const renderSavedActions = (): void => {
      if (!isCurrent() || !pendingResult || !savedPath) return;
      const artifactPath = savedPath;
      resultEl.empty();
      resultEl.createEl("p", {
        text: t("ai.result.saved", { path: artifactPath }),
      });
      const openButton = resultEl.createEl("button", {
        text: t("ai.result.open"),
      });
      openButton.addEventListener("click", () => {
        void (async () => {
          try {
            await this.options.openAnalysis(artifactPath);
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
              artifactPath,
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
          } catch (error) {
            const closed = this.finishPersistence();
            if (!closed && isCurrent()) {
              statusEl.setText(t(error instanceof AnalysisArtifactVerificationError
                ? "ai.result.artifactInvalid"
                : "ai.result.insertFailed"));
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
        previewInFlight ||
        this.storageInFlight ||
        !preview ||
        !selectedConnection
      ) return;
      if (fetchFullText && !previewReadyForSend) {
        statusEl.setText(t("ai.preview.fetchingFullText"));
        await loadPreview(true);
        return;
      }
      if (!previewReadyForSend) return;
      const effectiveConnection = resolveAiConnectionForRequest(selectedConnection);
      if (!effectiveConnection) {
        statusEl.setText(t("ai.error.invalidConnection"));
        return;
      }
      const confirmedPreview = preview;
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
        const operationResult = await this.options.operationService.runPrepared({
          operation: this.options.operation,
          itemId: this.options.item.id,
          connectionId: selectedConnection.id,
          connection: selectedConnection,
          selectedContent: confirmedPreview.selectedContent,
          signal: controller.signal,
        });
        if (!isCurrent() || cancelled || controller.signal.aborted) return;
        pendingResult = createAnalysisResult(
          operationResult,
          this.options.item,
          this.options.operation,
          effectiveConnection,
          confirmedPreview,
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
      if (this.requestInFlight || previewInFlight) return;
      const connection = connections.find(({ id }) => id === connectionSelect.value);
      if (!connection) return;
      selectedConnection = connection;
      fetchFullText = false;
      previewReadyForSend = false;
      void loadPreview(false);
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
    void loadPreview(false);
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
    this.activePreviewController?.abort();
    this.activePreviewController = null;
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
  preview: PreparedAiPreview,
  id: string,
  now: Date,
): AiAnalysisResult {
  const effectiveConnection = resolveAiConnectionForRequest(connection);
  if (
    !effectiveConnection ||
    generated.itemId !== item.id ||
    generated.operation !== operation ||
    generated.connectionId !== connection.id ||
    generated.connectionName !== connection.name ||
    generated.providerKind !== connection.providerKind ||
    generated.model !== effectiveConnection.model ||
    generated.contentBasis !== preview.contentBasis ||
    generated.inputCharacterCount !== preview.inputCharacterCount ||
    generated.inputTruncated !== preview.inputTruncated
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

function preparePreview(
  selected: SelectedAiContent,
  expectedItemId: string,
  operation: AiOperation,
  maxInputCharacters: number,
): PreparedAiPreview {
  const selectedContent = Object.freeze({
    itemId: selected.itemId,
    title: selected.title,
    sourceName: selected.sourceName,
    ...(selected.sourceUrl === undefined ? {} : { sourceUrl: selected.sourceUrl }),
    content: selected.content,
    basis: selected.basis,
    characterCount: selected.content.length,
    truncated: selected.truncated,
  });
  if (selectedContent.itemId !== expectedItemId) {
    throw new Error("AI preview item provenance mismatch");
  }
  const prompt = buildAiPrompt({
    operation,
    selectedContent,
    maxContentCharacters: maxInputCharacters,
  });
  return Object.freeze({
    selectedContent,
    contentBasis: prompt.contentBasis,
    inputCharacterCount: prompt.inputCharacterCount,
    inputTruncated: prompt.inputTruncated,
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

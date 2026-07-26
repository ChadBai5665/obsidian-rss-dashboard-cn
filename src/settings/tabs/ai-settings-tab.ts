import { App, Modal, Setting } from "obsidian";
import type { AiConnection } from "../../ai/ai-types";
import { normalizeAiConnection } from "../../ai/connection-validation";
import { ProviderError } from "../../ai/providers/provider-error";
import { createTextGenerationProvider } from "../../ai/providers/provider-factory";
import { resolveAiConnectionForRequest } from "../../ai/provider-presets";
import type { TextGenerationProvider } from "../../ai/providers/text-generation-provider";
import { waitForTrustedAbortWork } from "../../ai/trusted-abort";
import { DesktopSecretStore } from "../../security/desktop-secret-store";
import {
  AiConnectionModal,
  type AiConnectionModalOptions,
} from "../../modals/ai-connection-modal";
import {
  createTranslator,
  type Locale,
  type TranslationKey,
  type Translator,
} from "../../i18n";
import type { RssDashboardSettings } from "../../types/types";

const TEST_USER_PROMPT = "回复 OK";
const TEST_OUTPUT_TOKENS = 8;
const RENDER_EPOCHS = new WeakMap<HTMLElement, number>();
const AI_OPERATION_QUEUES = new WeakMap<object, Promise<void>>();
const AI_RENDER_SUBSCRIBERS = new WeakMap<object, Set<() => void>>();
const AI_FLASH_MESSAGES = new WeakMap<object, TranslationKey>();
const AI_ACTIVE_TESTS = new WeakMap<object, ActiveAiTest>();
const AI_TEST_GATE_SUBSCRIBERS = new WeakMap<
  object,
  Set<(busy: boolean) => void>
>();

export interface AiSettingsPlugin {
  app: App;
  settings: RssDashboardSettings;
  saveSettings(): Promise<void>;
}

export interface AiSettingsSecretStore {
  getStatus(connectionId: string): Promise<{ hasSecret: boolean }>;
  get(connectionId: string): Promise<string | undefined>;
  set(connectionId: string, apiKey: string): Promise<void>;
  delete(connectionId: string): Promise<void>;
}

export interface AiEditorHandle {
  open(): void;
  close(): void;
}

interface ActiveAiTest {
  connectionId: string;
  controller: AbortController;
  cancelled: boolean;
  requestStarted: boolean;
}

export interface AiSettingsDependencies {
  secretStore?: AiSettingsSecretStore;
  providerFactory?: (
    connection: AiConnection,
    secretStore: Pick<AiSettingsSecretStore, "get">,
  ) => Promise<TextGenerationProvider>;
  confirmPaidRequest?: (connection: AiConnection) => Promise<boolean>;
  confirmDeleteKey?: (connection: AiConnection) => Promise<boolean>;
  confirmDeleteConnection?: (connection: AiConnection) => Promise<boolean>;
  createEditor?: (options: AiConnectionModalOptions) => AiEditorHandle;
}

export function renderAiSettingsTab(
  containerEl: HTMLElement,
  plugin: AiSettingsPlugin,
  dependencies: AiSettingsDependencies = {},
): void {
  const locale = plugin.settings.locale ?? "zh-CN";
  const t = createTranslator(locale);
  const secretStore = dependencies.secretStore ?? new DesktopSecretStore();
  const providerFactory = dependencies.providerFactory ??
    ((connection, store) => createTextGenerationProvider(connection, store));
  const confirmPaidRequest = dependencies.confirmPaidRequest ??
    ((connection) => confirmAiAction(plugin.app, locale, "test", connection));
  const confirmDeleteKey = dependencies.confirmDeleteKey ??
    ((connection) => confirmAiAction(plugin.app, locale, "delete-key", connection));
  const confirmDeleteConnection = dependencies.confirmDeleteConnection ??
    ((connection) =>
      confirmAiAction(plugin.app, locale, "delete-connection", connection));
  const createEditor = dependencies.createEditor ??
    ((options) => new AiConnectionModal(plugin.app, options));
  const renderEpoch = (RENDER_EPOCHS.get(containerEl) ?? 0) + 1;
  RENDER_EPOCHS.set(containerEl, renderEpoch);
  const isRenderCurrent = (): boolean =>
    RENDER_EPOCHS.get(containerEl) === renderEpoch && containerEl.isConnected;

  let disposed = false;
  let mutationInFlight = false;
  const actionGates = new Set<string>();
  const mutableButtons = new Set<HTMLButtonElement>();
  const testButtons = new Set<HTMLButtonElement>();
  const isCurrent = (): boolean => !disposed && isRenderCurrent();
  const refreshRenderer = (): void => {
    if (isCurrent()) {
      containerEl.dispatchEvent(new CustomEvent("rss-settings-refresh"));
    }
  };
  const renderSubscribers = AI_RENDER_SUBSCRIBERS.get(plugin) ?? new Set();
  renderSubscribers.add(refreshRenderer);
  AI_RENDER_SUBSCRIBERS.set(plugin, renderSubscribers);
  const setMutationBusy = (busy: boolean): void => {
    mutationInFlight = busy;
    for (const button of mutableButtons) {
      button.disabled = busy;
      button.setAttribute("aria-disabled", String(busy));
    }
  };
  const registerMutableButton = (button: HTMLButtonElement): void => {
    mutableButtons.add(button);
    button.disabled = mutationInFlight;
    button.setAttribute("aria-disabled", String(mutationInFlight));
  };
  const registerTestButton = (button: HTMLButtonElement): void => {
    testButtons.add(button);
    const busy = AI_ACTIVE_TESTS.has(plugin);
    button.disabled = busy;
    button.setAttribute("aria-disabled", String(busy));
  };
  const setTestBusy = (busy: boolean): void => {
    for (const button of testButtons) {
      button.disabled = busy;
      button.setAttribute("aria-disabled", String(busy));
    }
  };
  const testGateSubscriber = (busy: boolean): void => {
    if (isCurrent()) setTestBusy(busy);
  };
  const testGateSubscribers = AI_TEST_GATE_SUBSCRIBERS.get(plugin) ?? new Set();
  testGateSubscribers.add(testGateSubscriber);
  AI_TEST_GATE_SUBSCRIBERS.set(plugin, testGateSubscribers);

  new Setting(containerEl)
    .setName(t("settings.ai.heading"))
    .setDesc(t("settings.ai.description"))
    .setHeading();
  const flashMessage = AI_FLASH_MESSAGES.get(plugin);
  if (flashMessage) {
    AI_FLASH_MESSAGES.delete(plugin);
    const flashEl = containerEl.createEl("p", {
      text: t(flashMessage),
      cls: "rss-dashboard-validation-error",
    });
    flashEl.setAttribute("role", "alert");
    flashEl.setAttribute("aria-live", "assertive");
  }
  containerEl.createEl("p", {
    text: t("settings.ai.generalGuidance"),
    cls: "rss-dashboard-ai-guidance",
  });
  containerEl.createEl("p", {
    text: t("settings.ai.claudeGuidance"),
    cls: "rss-dashboard-ai-guidance",
  });

  const openEditor = (existing?: AiConnection): void => {
    if (!isCurrent()) return;
    let ownedConnectionId = existing?.id;
    let metadataPersisted = false;
    let refreshSent = false;
    const editor = createEditor({
      locale,
      ...(existing ? { existing } : {}),
      secretStore,
      runTransaction: (operation) =>
        runSerializedAiOperation(plugin, operation),
      testConnection: async (connection, pendingKey, controller) => {
        const signal = controller.signal;
        const normalized = normalizeAiConnection(connection);
        if (!normalized) {
          return {
            status: "error",
            message: "settings.ai.connectionInvalid",
          };
        }
        if (!normalized.enabled) {
          return {
            status: "error",
            message: "settings.ai.connectionDisabled",
          };
        }
        if (AI_ACTIVE_TESTS.has(plugin)) {
          return {
            status: "error",
            message: "settings.ai.connectionTestBusy",
          };
        }
        const operation: ActiveAiTest = {
          connectionId: normalized.id,
          controller,
          cancelled: false,
          requestStarted: false,
        };
        setActiveAiTest(plugin, operation);
        try {
          const confirmed = await confirmPaidRequest(normalized);
          if (!confirmed || signal.aborted) return { status: "cancelled" };
          const testSecretStore = overlayPendingAiKey(
            secretStore,
            normalized.id,
            pendingKey,
          );
          const provider = await providerFactory(normalized, testSecretStore);
          if (signal.aborted) return { status: "cancelled" };
          operation.requestStarted = true;
          await provider.generate({
            system: "",
            user: TEST_USER_PROMPT,
            maxOutputTokens: TEST_OUTPUT_TOKENS,
            signal,
          });
          if (signal.aborted) return { status: "cancelled" };
          return { status: "success" };
        } catch (error) {
          if (signal.aborted) return { status: "cancelled" };
          return {
            status: "error",
            message: getAiConnectionMessageKey(error),
          };
        } finally {
          await waitForTrustedAbortWork(signal);
          if (AI_ACTIVE_TESTS.get(plugin) === operation) {
            setActiveAiTest(plugin, undefined);
          }
        }
      },
      onSave: async (connection) => {
        const normalized = normalizeAiConnection(connection);
        if (!normalized) throw new Error("Invalid AI connection metadata.");
        await mutateAiSettingsUnlocked(plugin, () => {
          const connections = [...plugin.settings.ai.connections];
          const index = connections.findIndex(({ id }) => id === normalized.id);
          if (ownedConnectionId) {
            if (normalized.id !== ownedConnectionId || index < 0) {
              throw new Error("The edited AI connection identity is invalid.");
            }
            connections[index] = normalized;
          } else {
            if (index >= 0) throw new Error("The AI connection ID already exists.");
            connections.push(normalized);
          }
          return {
            ...plugin.settings.ai,
            connections,
            defaultConnectionId:
              plugin.settings.ai.defaultConnectionId ?? normalized.id,
          };
        });
        ownedConnectionId = normalized.id;
        metadataPersisted = true;
      },
      onPersisted: (_connection, status) => {
        if (status !== "key-failed") {
          refreshSent = true;
          notifyAiSettingsRenderers(plugin);
        }
      },
      onClose: () => {
        if (metadataPersisted && !refreshSent) {
          refreshSent = true;
          notifyAiSettingsRenderers(plugin);
        }
      },
    });
    editor.open();
  };

  const addSetting = new Setting(containerEl)
    .setName(t("settings.ai.connections"))
    .setDesc(t("settings.ai.connectionsDesc"))
    .addButton((button) => {
      registerMutableButton(button.buttonEl);
      button
        .setButtonText(t("settings.ai.addConnection"))
        .setCta()
        .onClick(() => openEditor());
    });
  addSetting.settingEl.addClass("rss-dashboard-ai-connections-heading");

  if (plugin.settings.ai.connections.length === 0) {
    containerEl.createEl("p", { text: t("settings.ai.empty") });
  }

  plugin.settings.ai.connections.forEach((rawConnection, index) => {
    const connection = normalizeAiConnection(rawConnection);
    if (!connection) return;
    renderConnection({
      containerEl,
      plugin,
      connection,
      index,
      t,
      secretStore,
      providerFactory,
      confirmPaidRequest,
      confirmDeleteKey,
      confirmDeleteConnection,
      openEditor,
      isCurrent,
      registerMutableButton,
      registerTestButton,
      setTestBusy,
      setMutationBusy,
      actionGates,
      getActiveTest: () => AI_ACTIVE_TESTS.get(plugin),
      setActiveTest: (value) => setActiveAiTest(plugin, value),
    });
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    const activeTest = AI_ACTIVE_TESTS.get(plugin);
    if (activeTest && !activeTest.cancelled) {
      activeTest.cancelled = true;
      activeTest.controller.abort();
    }
    renderSubscribers.delete(refreshRenderer);
    if (renderSubscribers.size === 0) {
      AI_RENDER_SUBSCRIBERS.delete(plugin);
    }
    testGateSubscribers.delete(testGateSubscriber);
    if (testGateSubscribers.size === 0) {
      AI_TEST_GATE_SUBSCRIBERS.delete(plugin);
    }
    containerEl.removeEventListener("rss-settings-dispose", dispose);
  };
  containerEl.addEventListener("rss-settings-dispose", dispose);
}

interface RenderConnectionInput {
  containerEl: HTMLElement;
  plugin: AiSettingsPlugin;
  connection: AiConnection;
  index: number;
  t: Translator;
  secretStore: AiSettingsSecretStore;
  providerFactory: (
    connection: AiConnection,
    secretStore: Pick<AiSettingsSecretStore, "get">,
  ) => Promise<TextGenerationProvider>;
  confirmPaidRequest(connection: AiConnection): Promise<boolean>;
  confirmDeleteKey(connection: AiConnection): Promise<boolean>;
  confirmDeleteConnection(connection: AiConnection): Promise<boolean>;
  openEditor(existing?: AiConnection): void;
  isCurrent(): boolean;
  registerMutableButton(button: HTMLButtonElement): void;
  registerTestButton(button: HTMLButtonElement): void;
  setTestBusy(busy: boolean): void;
  setMutationBusy(busy: boolean): void;
  actionGates: Set<string>;
  getActiveTest(): ActiveAiTest | undefined;
  setActiveTest(value: ActiveAiTest | undefined): void;
}

function renderConnection(input: RenderConnectionInput): void {
  const {
    containerEl,
    plugin,
    connection,
    index,
    t,
    secretStore,
  } = input;
  const isDefault = plugin.settings.ai.defaultConnectionId === connection.id;
  const resolved = resolveAiConnectionForRequest(connection);
  if (!resolved) return;
  const providerName = t(providerLabelKey(connection.providerKind));
  const modelLabel = connection.model
    ? connection.model
    : t("settings.ai.defaultModelLabel", { model: resolved.model });
  const setting = new Setting(containerEl)
    .setName(connection.name)
    .setDesc([
      providerName,
      modelLabel,
      isDefault ? t("settings.ai.defaultBadge") : "",
    ].filter(Boolean).join(" · "));
  setting.settingEl.addClass("rss-dashboard-ai-connection");
  const statusEl = setting.descEl.createEl("span", {
    cls: "rss-dashboard-ai-key-status",
  });
  statusEl.setAttribute("role", "status");
  statusEl.setAttribute("aria-live", "polite");
  const testStatusEl = setting.descEl.createEl("span", {
    cls: "rss-dashboard-ai-test-status",
  });
  testStatusEl.setAttribute("role", "status");
  testStatusEl.setAttribute("aria-live", "polite");

  let keyStatusEpoch = 0;
  const initialKeyStatusEpoch = ++keyStatusEpoch;
  void secretStore.getStatus(connection.id).then(
    ({ hasSecret }) => {
      if (input.isCurrent() && keyStatusEpoch === initialKeyStatusEpoch) {
        statusEl.setText(t(hasSecret
          ? "settings.ai.keyConfigured"
          : "settings.ai.keyNotConfigured"));
      }
    },
    () => {
      if (input.isCurrent() && keyStatusEpoch === initialKeyStatusEpoch) {
        statusEl.setText(t("settings.ai.keyStatusUnavailable"));
      }
    },
  );

  setting.addButton((button) => {
    input.registerMutableButton(button.buttonEl);
    button
      .setButtonText(t("common.edit"))
      .onClick(() => input.openEditor(connection));
  });
  if (!isDefault) {
    setting.addButton((button) => {
      input.registerMutableButton(button.buttonEl);
      button
        .setButtonText(t("settings.ai.setDefault"))
        .onClick(() => runMetadataMutation(input, testStatusEl, () => ({
          ...plugin.settings.ai,
          defaultConnectionId: connection.id,
        })));
    });
  }
  if (index > 0) {
    setting.addButton((button) => {
      input.registerMutableButton(button.buttonEl);
      button
        .setButtonText(t("settings.ai.moveUp"))
        .onClick(() => runMetadataMutation(input, testStatusEl, () => ({
          ...plugin.settings.ai,
          connections: moveConnection(
            plugin.settings.ai.connections,
            connection.id,
            -1,
          ),
        })));
    });
  }
  if (index < plugin.settings.ai.connections.length - 1) {
    setting.addButton((button) => {
      input.registerMutableButton(button.buttonEl);
      button
        .setButtonText(t("settings.ai.moveDown"))
        .onClick(() => runMetadataMutation(input, testStatusEl, () => ({
          ...plugin.settings.ai,
          connections: moveConnection(
            plugin.settings.ai.connections,
            connection.id,
            1,
          ),
        })));
    });
  }

  let testButton: HTMLButtonElement;
  let cancelTestButton: HTMLButtonElement;
  setting.addButton((button) => {
    testButton = button.buttonEl;
    input.registerTestButton(testButton);
    button
      .setButtonText(t("settings.ai.testConnection"))
      .onClick(() => {
        const active = input.getActiveTest();
        if (active || !input.isCurrent()) return;
        const normalized = normalizeAiConnection(connection);
        if (!normalized) {
          testStatusEl.setText(t("settings.ai.connectionInvalid"));
          return;
        }
        if (!normalized.enabled) {
          testStatusEl.setText(t("settings.ai.connectionDisabled"));
          return;
        }
        const controller = new AbortController();
        const operation = {
          connectionId: normalized.id,
          controller,
          cancelled: false,
          requestStarted: false,
        };
        input.setActiveTest(operation);
        input.setTestBusy(true);
        cancelTestButton.disabled = false;
        cancelTestButton.setAttribute("aria-disabled", "false");
        void (async () => {
          try {
            testStatusEl.setText("");
            const confirmed = await input.confirmPaidRequest(normalized);
            if (!confirmed || !input.isCurrent() || operation.cancelled) return;
            const provider = await input.providerFactory(normalized, secretStore);
            if (!input.isCurrent() || operation.cancelled) return;
            operation.requestStarted = true;
            await provider.generate({
              system: "",
              user: TEST_USER_PROMPT,
              maxOutputTokens: TEST_OUTPUT_TOKENS,
              signal: controller.signal,
            });
            if (input.isCurrent() && !operation.cancelled) {
              testStatusEl.setText(t("settings.ai.connectionSucceeded"));
            }
          } catch (error) {
            if (input.isCurrent()) {
              testStatusEl.setText(operation.cancelled
                ? t(operation.requestStarted
                  ? "settings.ai.connectionWaitCancelled"
                  : "settings.ai.connectionCancelledBeforeSend")
                : getAiConnectionMessage(error, t));
            }
          } finally {
            await waitForTrustedAbortWork(controller.signal);
            if (input.getActiveTest() === operation) {
              input.setActiveTest(undefined);
              if (input.isCurrent()) {
                input.setTestBusy(false);
                cancelTestButton.disabled = true;
                cancelTestButton.setAttribute("aria-disabled", "true");
              }
            }
          }
        })();
      });
  });
  setting.addButton((button) => {
    cancelTestButton = button.buttonEl;
    cancelTestButton.disabled = true;
    cancelTestButton.setAttribute("aria-disabled", "true");
    button
      .setButtonText(t("settings.ai.cancelTest"))
      .onClick(() => {
        const active = input.getActiveTest();
        if (!active || active.connectionId !== connection.id || active.cancelled) {
          return;
        }
        active.cancelled = true;
        active.controller.abort();
        testStatusEl.setText(t(active.requestStarted
          ? "settings.ai.connectionWaitCancelled"
          : "settings.ai.connectionCancelledBeforeSend"));
      });
  });

  setting.addButton((button) => {
    input.registerMutableButton(button.buttonEl);
    button
      .setButtonText(t("settings.ai.deleteKey"))
      .onClick(() => runDeleteKey(
        input,
        statusEl,
        testStatusEl,
        () => { keyStatusEpoch += 1; },
      ));
  });
  setting.addButton((button) => {
    input.registerMutableButton(button.buttonEl);
    button
      .setButtonText(t("settings.ai.deleteConnection"))
      .setWarning()
      .onClick(() => runDeleteConnection(input, testStatusEl));
  });
}

function runMetadataMutation(
  input: RenderConnectionInput,
  statusEl: HTMLElement,
  next: () => RssDashboardSettings["ai"],
): void {
  if (!input.isCurrent()) return;
  input.setMutationBusy(true);
  void mutateAiSettings(input.plugin, next).then(
    () => {},
    () => {
      if (input.isCurrent()) {
        statusEl.setText(input.t("settings.ai.metadataSaveFailed"));
        clearAiSettingsFlash(input.plugin, "settings.ai.metadataSaveFailed");
      }
    },
  ).finally(() => {
    if (input.isCurrent()) input.setMutationBusy(false);
  });
}

function runDeleteKey(
  input: RenderConnectionInput,
  keyStatusEl: HTMLElement,
  actionStatusEl: HTMLElement,
  invalidateKeyStatus: () => void,
): void {
  const gate = `${input.connection.id}:delete-key`;
  if (input.actionGates.has(gate) || !input.isCurrent()) return;
  input.actionGates.add(gate);
  input.setMutationBusy(true);
  void (async () => {
    try {
      const confirmed = await input.confirmDeleteKey(input.connection);
      if (!confirmed || !input.isCurrent()) return;
      await runSerializedAiOperation(
        input.plugin,
        () => input.secretStore.delete(input.connection.id),
      );
      if (input.isCurrent()) {
        invalidateKeyStatus();
        keyStatusEl.setText(input.t("settings.ai.keyNotConfigured"));
        actionStatusEl.setText(input.t("settings.ai.keyDeleted"));
      }
      notifyAiSettingsRenderers(input.plugin);
    } catch {
      if (input.isCurrent()) {
        actionStatusEl.setText(input.t("settings.ai.keyDeleteFailed"));
      }
    } finally {
      input.actionGates.delete(gate);
      if (input.isCurrent()) input.setMutationBusy(false);
    }
  })();
}

function runDeleteConnection(
  input: RenderConnectionInput,
  statusEl: HTMLElement,
): void {
  const gate = `${input.connection.id}:delete-connection`;
  if (input.actionGates.has(gate) || !input.isCurrent()) return;
  input.actionGates.add(gate);
  input.setMutationBusy(true);
  void (async () => {
    try {
      const confirmed = await input.confirmDeleteConnection(input.connection);
      if (!confirmed || !input.isCurrent()) return;
      const result = await runSerializedAiOperation(input.plugin, async () => {
        let keyBackup: string | undefined;
        try {
          keyBackup = await input.secretStore.get(input.connection.id);
          try {
            await input.secretStore.delete(input.connection.id);
          } catch {
            return await restoreDeletedConnectionKey(input, keyBackup);
          }
          try {
            await mutateAiSettingsUnlocked(input.plugin, () => {
              const connections = input.plugin.settings.ai.connections.filter(
                ({ id }) => id !== input.connection.id,
              );
              return {
                connections,
                ...(input.plugin.settings.ai.defaultConnectionId === input.connection.id
                  ? connections[0]
                    ? { defaultConnectionId: connections[0].id }
                    : {}
                  : input.plugin.settings.ai.defaultConnectionId
                    ? { defaultConnectionId: input.plugin.settings.ai.defaultConnectionId }
                    : {}),
              };
            });
          } catch {
            return await restoreDeletedConnectionKey(input, keyBackup);
          }
          return "deleted" as const;
        } finally {
          keyBackup = undefined;
        }
      });
      if (result === "deleted") {
        notifyAiSettingsRenderers(input.plugin);
        return;
      }
      const message = result === "retained"
        ? "settings.ai.connectionDeleteRetained" as const
        : "settings.ai.connectionDeleteKeyRestoreFailed" as const;
      refreshAiSettingsWithFlash(input.plugin, message);
      if (!input.isCurrent()) return;
      statusEl.setText(input.t(message));
      clearAiSettingsFlash(input.plugin, message);
    } catch {
      refreshAiSettingsWithFlash(
        input.plugin,
        "settings.ai.connectionDeleteRetained",
      );
      if (input.isCurrent()) {
        statusEl.setText(input.t("settings.ai.connectionDeleteRetained"));
        clearAiSettingsFlash(
          input.plugin,
          "settings.ai.connectionDeleteRetained",
        );
      }
    } finally {
      input.actionGates.delete(gate);
      if (input.isCurrent()) input.setMutationBusy(false);
    }
  })();
}

async function restoreDeletedConnectionKey(
  input: RenderConnectionInput,
  keyBackup: string | undefined,
): Promise<"retained" | "key-uncertain"> {
  if (keyBackup === undefined) return "retained";
  try {
    await input.secretStore.set(input.connection.id, keyBackup);
    return "retained";
  } catch {
    return "key-uncertain";
  }
}

async function mutateAiSettings(
  plugin: AiSettingsPlugin,
  next: () => RssDashboardSettings["ai"],
): Promise<void> {
  try {
    await runSerializedAiOperation(
      plugin,
      () => mutateAiSettingsUnlocked(plugin, next),
    );
  } catch (error) {
    AI_FLASH_MESSAGES.set(plugin, "settings.ai.metadataSaveFailed");
    throw error;
  } finally {
    notifyAiSettingsRenderers(plugin);
  }
}

async function mutateAiSettingsUnlocked(
  plugin: AiSettingsPlugin,
  next: () => RssDashboardSettings["ai"],
): Promise<void> {
  const original = structuredClone(plugin.settings.ai);
  const candidate = next();
  plugin.settings.ai = candidate;
  try {
    await plugin.saveSettings();
  } catch (error) {
    plugin.settings.ai = original;
    throw error;
  }
}

async function runSerializedAiOperation<T>(
  plugin: AiSettingsPlugin,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = AI_OPERATION_QUEUES.get(plugin) ?? Promise.resolve();
  const queued = previous.then(operation);
  const tail = queued.then(
    () => undefined,
    () => undefined,
  );
  AI_OPERATION_QUEUES.set(plugin, tail);
  try {
    return await queued;
  } finally {
    if (AI_OPERATION_QUEUES.get(plugin) === tail) {
      AI_OPERATION_QUEUES.delete(plugin);
    }
  }
}

function notifyAiSettingsRenderers(plugin: AiSettingsPlugin): void {
  const subscribers = AI_RENDER_SUBSCRIBERS.get(plugin);
  if (!subscribers) return;
  for (const subscriber of [...subscribers]) subscriber();
}

function refreshAiSettingsWithFlash(
  plugin: AiSettingsPlugin,
  message: TranslationKey,
): void {
  AI_FLASH_MESSAGES.set(plugin, message);
  notifyAiSettingsRenderers(plugin);
}

function clearAiSettingsFlash(
  plugin: AiSettingsPlugin,
  message: TranslationKey,
): void {
  if (AI_FLASH_MESSAGES.get(plugin) === message) {
    AI_FLASH_MESSAGES.delete(plugin);
  }
}

function setActiveAiTest(
  plugin: AiSettingsPlugin,
  activeTest: ActiveAiTest | undefined,
): void {
  if (activeTest) AI_ACTIVE_TESTS.set(plugin, activeTest);
  else AI_ACTIVE_TESTS.delete(plugin);
  const subscribers = AI_TEST_GATE_SUBSCRIBERS.get(plugin);
  if (!subscribers) return;
  for (const subscriber of [...subscribers]) subscriber(activeTest !== undefined);
}

function moveConnection(
  connections: readonly AiConnection[],
  connectionId: string,
  direction: -1 | 1,
): AiConnection[] {
  const result = connections.map((connection) => ({ ...connection }));
  const index = result.findIndex(({ id }) => id === connectionId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= result.length) return result;
  [result[index], result[target]] = [result[target], result[index]];
  return result;
}

export function getAiConnectionMessage(
  error: unknown,
  t: Translator,
): string {
  return t(getAiConnectionMessageKey(error));
}

function getAiConnectionMessageKey(error: unknown): TranslationKey {
  if (!(error instanceof ProviderError)) return "settings.ai.connectionFailed";
  const keys: Partial<Record<ProviderError["code"], TranslationKey>> = {
    "missing-key": "settings.ai.connectionMissingKey",
    "invalid-key": "settings.ai.connectionInvalidKey",
    "insufficient-balance": "settings.ai.connectionInsufficientBalance",
    "rate-limited": "settings.ai.connectionRateLimited",
    timeout: "settings.ai.connectionTimeout",
    aborted: "settings.ai.connectionWaitCancelled",
    "network-failure": "settings.ai.connectionNetworkFailed",
    "connection-disabled": "settings.ai.connectionDisabled",
    "invalid-connection": "settings.ai.connectionInvalid",
    "invalid-request": "settings.ai.connectionInvalidRequest",
    "secret-store-failure": "settings.ai.keyStatusUnavailable",
  };
  const key = keys[error.code];
  return key ?? "settings.ai.connectionFailed";
}

function overlayPendingAiKey(
  secretStore: Pick<AiSettingsSecretStore, "get">,
  connectionId: string,
  pendingKey: string | undefined,
): Pick<AiSettingsSecretStore, "get"> {
  return {
    get: async (requestedId) =>
      requestedId === connectionId && pendingKey !== undefined
        ? pendingKey
        : await secretStore.get(requestedId),
  };
}

function providerLabelKey(
  providerKind: AiConnection["providerKind"],
): TranslationKey {
  const keys: Readonly<Record<AiConnection["providerKind"], TranslationKey>> = {
    kimi: "settings.ai.provider.kimi",
    deepseek: "settings.ai.provider.deepseek",
    qwen: "settings.ai.provider.qwen",
    glm: "settings.ai.provider.glm",
    openai: "settings.ai.provider.openai",
    claude: "settings.ai.provider.claude",
    "minimax-cn": "settings.ai.provider.minimaxCn",
    "minimax-global": "settings.ai.provider.minimaxGlobal",
    "openai-compatible": "settings.ai.provider.openaiCompatible",
    "anthropic-compatible": "settings.ai.provider.anthropicCompatible",
  };
  return keys[providerKind];
}

type ConfirmationAction = "test" | "delete-key" | "delete-connection";

class AiConfirmationModal extends Modal {
  private confirmed = false;
  private resolve: ((value: boolean) => void) | undefined;

  constructor(
    app: App,
    private readonly locale: Locale,
    private readonly action: ConfirmationAction,
    private readonly connectionName: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const t = createTranslator(this.locale);
    const [titleKey, descriptionKey] = confirmationKeys(this.action);
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: t(titleKey) });
    this.contentEl.createEl("p", {
      text: t(descriptionKey, { name: this.connectionName }),
    });
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText(t("common.cancel"))
        .onClick(() => this.close()))
      .addButton((button) => {
        button.setButtonText(t("common.confirm")).onClick(() => {
          this.confirmed = true;
          this.close();
        });
        if (this.action === "test") button.setCta();
        else button.setWarning();
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve?.(this.confirmed);
    this.resolve = undefined;
  }

  waitForClose(): Promise<boolean> {
    return new Promise((resolve) => { this.resolve = resolve; });
  }
}

function confirmationKeys(
  action: ConfirmationAction,
): readonly [TranslationKey, TranslationKey] {
  if (action === "test") {
    return ["settings.ai.confirmTestTitle", "settings.ai.confirmTestDesc"];
  }
  if (action === "delete-key") {
    return ["settings.ai.confirmDeleteKeyTitle", "settings.ai.confirmDeleteKeyDesc"];
  }
  return [
    "settings.ai.confirmDeleteConnectionTitle",
    "settings.ai.confirmDeleteConnectionDesc",
  ];
}

async function confirmAiAction(
  app: App,
  locale: Locale,
  action: ConfirmationAction,
  connection: AiConnection,
): Promise<boolean> {
  const modal = new AiConfirmationModal(app, locale, action, connection.name);
  const result = modal.waitForClose();
  modal.open();
  return await result;
}

import { App, Modal, Setting } from "obsidian";
import { DesktopSecretStore } from "../../security/desktop-secret-store";
import { createTranslator, type Locale, type Translator } from "../../i18n";
import { TikHubRequestBudget } from "../../sources/tikhub/request-budget";
import { TikHubRequestLedger } from "../../sources/tikhub/request-ledger";
import {
  TikHubClient,
  TikHubClientError,
  type TikHubTransport,
} from "../../sources/tikhub/tikhub-client";
import { normalizeTikHubBaseUrl } from "../../sources/tikhub/tikhub-types";
import type { RssDashboardSettings } from "../../types/types";

const MAINLAND_BASE_URL = "https://api.tikhub.dev";
const OVERSEAS_BASE_URL = "https://api.tikhub.io";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RENDER_EPOCHS = new WeakMap<HTMLElement, number>();

interface RegisteredControl {
  element: HTMLElement;
  setDisabled(disabled: boolean): void;
}

interface TikHubSecretStoreLike {
  getStatus(connectionId: string): Promise<{ hasSecret: boolean }>;
  get(connectionId: string): Promise<string | undefined>;
  set(connectionId: string, apiKey: string): Promise<void>;
  delete(connectionId: string): Promise<void>;
}

export interface TikHubSettingsPlugin {
  app: App;
  settings: RssDashboardSettings;
  saveSettings(): Promise<void>;
}

export interface TikHubConnectionTestInput {
  app: App;
  connectionId: string;
  baseUrl: string;
  timeoutMs: number;
  dataFolder: string;
  maxRequestsPerRun: number;
  maxRequestsPerDay: number;
  /** Test seam; production always uses Obsidian's request transport. */
  transport?: TikHubTransport;
}

export interface TikHubSettingsDependencies {
  secretStore?: TikHubSecretStoreLike;
  testConnection?: (
    apiKey: string,
    input: TikHubConnectionTestInput,
  ) => Promise<void>;
  confirmPaidRequest?: () => Promise<boolean>;
  confirmDeleteSecret?: () => Promise<boolean>;
  createConnectionId?: () => string;
}

export function renderTikHubSettingsTab(
  containerEl: HTMLElement,
  plugin: TikHubSettingsPlugin,
  dependencies: TikHubSettingsDependencies = {},
): void {
  const locale = plugin.settings.locale ?? "zh-CN";
  const t = createTranslator(locale);
  const secretStore = dependencies.secretStore ?? new DesktopSecretStore();
  const testConnection = dependencies.testConnection ?? runTikHubConnectionTest;
  const confirmPaidRequest = dependencies.confirmPaidRequest ?? (() =>
    confirmTikHubAction(plugin.app, locale, "test"));
  const confirmDeleteSecret = dependencies.confirmDeleteSecret ?? (() =>
    confirmTikHubAction(plugin.app, locale, "delete"));
  const createConnectionId = dependencies.createConnectionId ?? defaultConnectionId;
  const renderEpoch = (RENDER_EPOCHS.get(containerEl) ?? 0) + 1;
  RENDER_EPOCHS.set(containerEl, renderEpoch);

  let operationSequence = 0;
  let activeOperation: number | undefined;
  let statusEpoch = 0;
  let hasSecret = false;
  const controls: RegisteredControl[] = [];
  const isRenderCurrent = (): boolean =>
    RENDER_EPOCHS.get(containerEl) === renderEpoch && containerEl.isConnected;
  const setBusy = (busy: boolean): void => {
    for (const control of controls) {
      control.setDisabled(busy);
      control.element.setAttribute("aria-disabled", String(busy));
    }
  };
  const registerControl = <T extends HTMLElement>(
    element: T,
    setDisabled?: (disabled: boolean) => void,
  ): T => {
    const registered: RegisteredControl = {
      element,
      setDisabled: setDisabled ?? ((disabled) => {
        (element as unknown as { disabled: boolean }).disabled = disabled;
      }),
    };
    controls.push(registered);
    registered.setDisabled(activeOperation !== undefined);
    element.setAttribute("aria-disabled", String(activeOperation !== undefined));
    return element;
  };
  const beginOperation = (invalidateSecretStatus = false): number | undefined => {
    if (activeOperation !== undefined) return undefined;
    if (invalidateSecretStatus) statusEpoch += 1;
    const operation = ++operationSequence;
    activeOperation = operation;
    setBusy(true);
    return operation;
  };
  const isOperationCurrent = (operation: number): boolean =>
    activeOperation === operation && isRenderCurrent();
  const finishOperation = (operation: number): void => {
    if (activeOperation !== operation) return;
    activeOperation = undefined;
    if (isRenderCurrent()) setBusy(false);
  };

  new Setting(containerEl)
    .setName(t("settings.tikhub.heading"))
    .setDesc(t("settings.tikhub.description"))
    .setHeading();

  const enabledSetting = new Setting(containerEl)
    .setName(t("settings.tikhub.enabled"))
    .setDesc(t("settings.tikhub.enabledDesc"));
  enabledSetting.addToggle((toggle) => {
    registerControl(toggle.toggleEl, (disabled) => {
      const setDisabled = (toggle as unknown as {
        setDisabled?: (value: boolean) => void;
      }).setDisabled;
      if (setDisabled) setDisabled.call(toggle, disabled);
      else (toggle.toggleEl as unknown as { disabled: boolean }).disabled = disabled;
    });
    toggle
      .setValue(plugin.settings.tikhub.enabled)
      .onChange((value) => {
        const operation = beginOperation();
        if (operation === undefined) return;
        const original = plugin.settings.tikhub.enabled;
        plugin.settings.tikhub.enabled = value;
        void (async () => {
          try {
            await plugin.saveSettings();
          } catch {
            plugin.settings.tikhub.enabled = original;
            if (isOperationCurrent(operation)) toggle.setValue(original);
          } finally {
            finishOperation(operation);
          }
        })();
      });
  });

  const youtubeTranscriptFallbackSetting = new Setting(containerEl)
    .setName(t("settings.tikhub.youtubeTranscriptFallbackEnabled"))
    .setDesc(t("settings.tikhub.youtubeTranscriptFallbackEnabledDesc"));
  youtubeTranscriptFallbackSetting.addToggle((toggle) => {
    registerControl(toggle.toggleEl, (disabled) => {
      const setDisabled = (toggle as unknown as {
        setDisabled?: (value: boolean) => void;
      }).setDisabled;
      if (setDisabled) setDisabled.call(toggle, disabled);
      else (toggle.toggleEl as unknown as { disabled: boolean }).disabled = disabled;
    });
    toggle
      .setValue(plugin.settings.tikhub.youtubeTranscriptFallbackEnabled)
      .onChange((value) => {
        const operation = beginOperation();
        if (operation === undefined) return;
        const original = plugin.settings.tikhub.youtubeTranscriptFallbackEnabled;
        plugin.settings.tikhub.youtubeTranscriptFallbackEnabled = value;
        void (async () => {
          try {
            await plugin.saveSettings();
          } catch {
            plugin.settings.tikhub.youtubeTranscriptFallbackEnabled = original;
            if (isOperationCurrent(operation)) toggle.setValue(original);
          } finally {
            finishOperation(operation);
          }
        })();
      });
  });

  let customBaseUrl = isPresetBaseUrl(plugin.settings.tikhub.baseUrl)
    ? ""
    : plugin.settings.tikhub.baseUrl;
  let setCustomBaseUrlVisible = (_visible: boolean): void => {};
  const customErrorEl = containerEl.createEl("p", {
    cls: "rss-dashboard-validation-error",
  });
  customErrorEl.setAttribute("role", "alert");
  customErrorEl.setAttribute("aria-live", "polite");
  const baseUrlSetting = new Setting(containerEl)
    .setName(t("settings.tikhub.baseUrl"))
    .setDesc(t("settings.tikhub.baseUrlDesc"));
  baseUrlSetting.addDropdown((dropdown) => {
    registerControl(dropdown.selectEl);
    dropdown
      .addOption(OVERSEAS_BASE_URL, t("settings.tikhub.presetOverseas"))
      .addOption(MAINLAND_BASE_URL, t("settings.tikhub.presetMainland"))
      .addOption("custom", t("settings.tikhub.presetCustom"))
      .setValue(isPresetBaseUrl(plugin.settings.tikhub.baseUrl)
        ? plugin.settings.tikhub.baseUrl
        : "custom")
      .onChange((value) => {
        setCustomBaseUrlVisible(value === "custom");
        if (value === "custom") return;
        const operation = beginOperation();
        if (operation === undefined) return;
        const original = plugin.settings.tikhub.baseUrl;
        plugin.settings.tikhub.baseUrl = value;
        customErrorEl.setText("");
        void (async () => {
          try {
            await plugin.saveSettings();
          } catch {
            plugin.settings.tikhub.baseUrl = original;
            if (isOperationCurrent(operation)) {
              dropdown.setValue(isPresetBaseUrl(original) ? original : "custom");
            }
          } finally {
            finishOperation(operation);
          }
        })();
      });
  });

  let customBaseUrlInput: HTMLInputElement | undefined;
  const customBaseSetting = new Setting(containerEl)
    .setName(t("settings.tikhub.customBaseUrl"))
    .setDesc(t("settings.tikhub.customBaseUrlDesc"));
  setCustomBaseUrlVisible = (visible: boolean): void => {
    customBaseSetting.settingEl.hidden = !visible;
    customBaseSetting.settingEl.style.display = visible ? "" : "none";
    customErrorEl.hidden = !visible;
    customErrorEl.style.display = visible ? "" : "none";
    if (!visible) customErrorEl.setText("");
  };
  setCustomBaseUrlVisible(!isPresetBaseUrl(plugin.settings.tikhub.baseUrl));
  customBaseSetting
    .addText((text) => {
      customBaseUrlInput = registerControl(text.inputEl);
      text
        .setPlaceholder("https://gateway.example.com")
        .setValue(customBaseUrl)
        .onChange((value) => { customBaseUrl = value; });
    })
    .addButton((button) => button
      .setButtonText(t("settings.tikhub.applyBaseUrl"))
      .onClick(() => {
        const normalized = normalizeTikHubBaseUrl(customBaseUrl);
        if (!normalized) {
          customErrorEl.setText(t("settings.tikhub.invalidBaseUrl"));
          return;
        }
        const operation = beginOperation();
        if (operation === undefined) return;
        const original = plugin.settings.tikhub.baseUrl;
        const originalCustomBaseUrl = customBaseUrl;
        plugin.settings.tikhub.baseUrl = normalized;
        customBaseUrl = normalized;
        if (customBaseUrlInput) customBaseUrlInput.value = normalized;
        customErrorEl.setText("");
        void (async () => {
          try {
            await plugin.saveSettings();
          } catch {
            plugin.settings.tikhub.baseUrl = original;
            customBaseUrl = originalCustomBaseUrl;
            if (isOperationCurrent(operation) && customBaseUrlInput) {
              customBaseUrlInput.value = originalCustomBaseUrl;
            }
          } finally {
            finishOperation(operation);
          }
        })();
      }));
  registerControl(customBaseSetting.controlEl.querySelector<HTMLButtonElement>("button")!);

  let currentRunCap = plugin.settings.tikhub.maxRequestsPerRun;
  let currentDayCap = plugin.settings.tikhub.maxRequestsPerDay;
  let lastValidRunCap = currentRunCap;
  let lastValidDayCap = currentDayCap;
  let connectionTestSetting: Setting | undefined;
  const capsEl = containerEl.createEl("p", {
    cls: "rss-dashboard-request-caps",
  });
  const renderCapDisplays = (): void => {
    capsEl.setText(t("settings.tikhub.requestCaps", {
      run: currentRunCap,
      day: currentDayCap,
    }));
    connectionTestSetting?.setDesc([
      t("settings.tikhub.testConnectionDesc"),
      t("settings.tikhub.estimatedTestRequests"),
      t("settings.tikhub.requestCaps", {
        run: currentRunCap,
        day: currentDayCap,
      }),
    ].join(" "));
  };
  const renderCapInput = (
    label: string,
    kind: "run" | "day",
  ): void => {
    new Setting(containerEl).setName(label).addText((text) => {
      const input = registerControl(text.inputEl);
      input.type = "number";
      input.min = "1";
      text.setValue(String(kind === "run" ? currentRunCap : currentDayCap));
      input.addEventListener("change", () => {
        const lastValid = kind === "run" ? lastValidRunCap : lastValidDayCap;
        const parsed = Number(input.value);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          input.value = String(lastValid);
          return;
        }
        const operation = beginOperation();
        if (operation === undefined) {
          input.value = String(lastValid);
          return;
        }
        const original = lastValid;
        if (kind === "run") {
          lastValidRunCap = parsed;
          currentRunCap = parsed;
          plugin.settings.tikhub.maxRequestsPerRun = parsed;
        } else {
          lastValidDayCap = parsed;
          currentDayCap = parsed;
          plugin.settings.tikhub.maxRequestsPerDay = parsed;
        }
        renderCapDisplays();
        void (async () => {
          try {
            await plugin.saveSettings();
          } catch {
            if (kind === "run") {
              lastValidRunCap = original;
              currentRunCap = original;
              plugin.settings.tikhub.maxRequestsPerRun = original;
            } else {
              lastValidDayCap = original;
              currentDayCap = original;
              plugin.settings.tikhub.maxRequestsPerDay = original;
            }
            if (isOperationCurrent(operation)) input.value = String(original);
            renderCapDisplays();
          } finally {
            finishOperation(operation);
          }
        })();
      });
    });
  };
  renderCapInput(t("settings.tikhub.maxRequestsPerRun"), "run");
  renderCapInput(t("settings.tikhub.maxRequestsPerDay"), "day");
  renderCapDisplays();

  const statusEl = containerEl.createEl("p", {
    cls: "rss-dashboard-secret-status",
  });
  statusEl.setAttribute("role", "status");
  statusEl.setAttribute("aria-live", "polite");
  statusEl.setAttribute("aria-atomic", "true");
  const updateStatus = (): void => {
    statusEl.setText(t(hasSecret
      ? "settings.tikhub.keyConfigured"
      : "settings.tikhub.keyNotConfigured"));
  };
  const refreshSecretStatus = (): void => {
    const connectionId = plugin.settings.tikhub.connectionId;
    const refreshEpoch = ++statusEpoch;
    if (!UUID_PATTERN.test(connectionId)) {
      hasSecret = false;
      updateStatus();
      return;
    }
    let statusPromise: Promise<{ hasSecret: boolean }>;
    try {
      statusPromise = secretStore.getStatus(connectionId);
    } catch {
      if (refreshEpoch === statusEpoch && isRenderCurrent()) {
        hasSecret = false;
        updateStatus();
      }
      return;
    }
    void statusPromise
      .then((status) => {
        if (refreshEpoch !== statusEpoch || !isRenderCurrent()) return;
        hasSecret = status.hasSecret;
        updateStatus();
      })
      .catch(() => {
        if (refreshEpoch !== statusEpoch || !isRenderCurrent()) return;
        hasSecret = false;
        updateStatus();
      });
  };
  updateStatus();

  const secretErrorEl = containerEl.createEl("p", {
    cls: "rss-dashboard-validation-error",
  });
  secretErrorEl.setAttribute("role", "status");
  secretErrorEl.setAttribute("aria-live", "polite");
  let secretInputEl: HTMLInputElement | undefined;
  const secretSetting = new Setting(containerEl)
    .setName(t("settings.tikhub.apiKey"))
    .setDesc(t("settings.tikhub.apiKeyDesc"));
  secretSetting
    .addText((text) => {
      secretInputEl = registerControl(text.inputEl);
      text.inputEl.type = "password";
      text.inputEl.autocomplete = "new-password";
      text.inputEl.value = "";
      text.setPlaceholder(t("settings.tikhub.apiKeyPlaceholder"));
    })
    .addButton((button) => button
      .setButtonText(t("settings.tikhub.saveKey"))
      .setCta()
      .onClick(() => {
        let apiKey: string | undefined = secretInputEl?.value ?? "";
        if (secretInputEl) secretInputEl.value = "";
        secretErrorEl.setText("");
        if (!apiKey.trim()) {
          apiKey = undefined;
          secretErrorEl.setText(t("settings.tikhub.keyRequired"));
          return;
        }
        const operation = beginOperation(true);
        if (operation === undefined) {
          apiKey = undefined;
          return;
        }
        let refreshAfter = false;
        void (async () => {
          try {
            try {
              let connectionId = plugin.settings.tikhub.connectionId;
              if (!UUID_PATTERN.test(connectionId)) {
                const originalConnectionId = connectionId;
                connectionId = createConnectionId();
                if (!UUID_PATTERN.test(connectionId)) throw new Error("invalid connection id");
                plugin.settings.tikhub.connectionId = connectionId;
                try {
                  await plugin.saveSettings();
                } catch (error) {
                  plugin.settings.tikhub.connectionId = originalConnectionId;
                  throw error;
                }
              }
              await secretStore.set(connectionId, apiKey);
              if (!isOperationCurrent(operation)) return;
              hasSecret = true;
              updateStatus();
              secretErrorEl.setText(t("settings.tikhub.keySaved"));
            } catch {
              refreshAfter = true;
              if (isOperationCurrent(operation)) {
                secretErrorEl.setText(t("settings.tikhub.keySaveFailed"));
              }
            }
          } finally {
            apiKey = undefined;
            finishOperation(operation);
            if (refreshAfter && isRenderCurrent()) refreshSecretStatus();
          }
        })();
      }))
    .addButton((button) => button
      .setButtonText(t("settings.tikhub.deleteKey"))
      .setWarning()
      .onClick(() => {
        if (secretInputEl) secretInputEl.value = "";
        const operation = beginOperation(true);
        if (operation === undefined) return;
        const connectionId = plugin.settings.tikhub.connectionId;
        const originalEnabled = plugin.settings.tikhub.enabled;
        let refreshAfter = false;
        void (async () => {
          try {
            if (!(await confirmDeleteSecret())) {
              refreshAfter = true;
              return;
            }
            if (!isOperationCurrent(operation)) return;
            if (UUID_PATTERN.test(connectionId)) await secretStore.delete(connectionId);
            hasSecret = false;
            if (isOperationCurrent(operation)) updateStatus();
            plugin.settings.tikhub.enabled = false;
            try {
              await plugin.saveSettings();
            } catch (error) {
              plugin.settings.tikhub.enabled = originalEnabled;
              throw error;
            }
            if (!isOperationCurrent(operation)) return;
            secretErrorEl.setText(t("settings.tikhub.keyDeleted"));
          } catch {
            if (!isOperationCurrent(operation)) return;
            refreshAfter = true;
            secretErrorEl.setText(t("settings.tikhub.keyDeleteFailed"));
          } finally {
            finishOperation(operation);
            if (refreshAfter && isRenderCurrent()) refreshSecretStatus();
          }
        })();
      }));
  secretSetting.controlEl.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    registerControl(button);
  });

  const connectionStatusEl = containerEl.createEl("p", {
    cls: "rss-dashboard-connection-status",
  });
  connectionStatusEl.setAttribute("role", "status");
  connectionStatusEl.setAttribute("aria-live", "polite");
  connectionStatusEl.setAttribute("aria-atomic", "true");
  connectionTestSetting = new Setting(containerEl)
    .setName(t("settings.tikhub.testConnection"))
    .setDesc("");
  renderCapDisplays();
  connectionTestSetting.addButton((button) => {
    registerControl(button.buttonEl);
    button
      .setButtonText(t("settings.tikhub.testConnectionButton"))
      .onClick(() => {
        if (secretInputEl) secretInputEl.value = "";
        const operation = beginOperation();
        if (operation === undefined) return;
        const snapshot: TikHubConnectionTestInput = {
          app: plugin.app,
          connectionId: plugin.settings.tikhub.connectionId,
          baseUrl: plugin.settings.tikhub.baseUrl,
          timeoutMs: plugin.settings.tikhub.timeoutMs,
          dataFolder: plugin.settings.collection.dataFolder,
          maxRequestsPerRun: currentRunCap,
          maxRequestsPerDay: currentDayCap,
        };
        let apiKey: string | undefined;
        void (async () => {
          try {
            connectionStatusEl.setText("");
            if (!(await confirmPaidRequest())) return;
            if (!isOperationCurrent(operation)) return;
            if (!UUID_PATTERN.test(snapshot.connectionId)) {
              connectionStatusEl.setText(t("settings.tikhub.keyNotConfigured"));
              return;
            }
            apiKey = await secretStore.get(snapshot.connectionId);
            if (!isOperationCurrent(operation)) return;
            if (!apiKey?.trim()) {
              connectionStatusEl.setText(t("settings.tikhub.keyNotConfigured"));
              return;
            }
            await testConnection(apiKey, snapshot);
            if (!isOperationCurrent(operation)) return;
            connectionStatusEl.setText(t("settings.tikhub.connectionSucceeded"));
          } catch (error) {
            if (isOperationCurrent(operation)) {
              connectionStatusEl.setText(getTikHubConnectionMessage(error, t));
            }
          } finally {
            apiKey = undefined;
            finishOperation(operation);
          }
        })();
      });
  });
}

export function getTikHubConnectionMessage(
  error: unknown,
  t: Translator,
): string {
  if (error instanceof TikHubClientError) {
    if (error.code === "invalid-key" || error.code === "missing-key") {
      return t("settings.tikhub.connectionInvalidKey");
    }
    if (error.code === "insufficient-balance") {
      return t("settings.tikhub.connectionInsufficientBalance");
    }
    if (error.code === "rate-limited") {
      return t("settings.tikhub.connectionRateLimited");
    }
  }
  return t("settings.tikhub.connectionFailed");
}

export async function runTikHubConnectionTest(
  apiKey: string,
  input: TikHubConnectionTestInput,
): Promise<void> {
  const ledger = new TikHubRequestLedger(input.app.vault, input.dataFolder, {
    storageIdentity: `vault:${input.connectionId.toLowerCase()}`,
  });
  const budget = new TikHubRequestBudget({
    ledger,
    maxRequestsPerRun: input.maxRequestsPerRun,
    maxRequestsPerDay: input.maxRequestsPerDay,
  });
  const client = new TikHubClient({
    baseUrl: input.baseUrl,
    timeoutMs: input.timeoutMs,
    budget,
    ...(input.transport ? { transport: input.transport } : {}),
  });
  await client.verifyAccount({ apiKey });
}

function isPresetBaseUrl(value: string): value is typeof MAINLAND_BASE_URL | typeof OVERSEAS_BASE_URL {
  return value === MAINLAND_BASE_URL || value === OVERSEAS_BASE_URL;
}

function defaultConnectionId(): string {
  const id = window.crypto?.randomUUID?.();
  if (!id) throw new Error("Secure connection identity is unavailable.");
  return id;
}

class TikHubConfirmationModal extends Modal {
  private confirmed = false;
  private resolve: ((value: boolean) => void) | undefined;

  constructor(
    app: App,
    private readonly locale: Locale,
    private readonly action: "test" | "delete",
  ) {
    super(app);
  }

  onOpen(): void {
    const t = createTranslator(this.locale);
    this.contentEl.empty();
    this.contentEl.createEl("h2", {
      text: t(this.action === "test"
        ? "settings.tikhub.confirmTestTitle"
        : "settings.tikhub.confirmDeleteTitle"),
    });
    this.contentEl.createEl("p", {
      text: t(this.action === "test"
        ? "settings.tikhub.confirmTestDesc"
        : "settings.tikhub.confirmDeleteDesc"),
    });
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText(t("common.cancel"))
        .onClick(() => this.close()))
      .addButton((button) => {
        button
          .setButtonText(t("common.confirm"))
          .onClick(() => {
            this.confirmed = true;
            this.close();
          });
        if (this.action === "delete") button.setWarning();
        else button.setCta();
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

async function confirmTikHubAction(
  app: App,
  locale: Locale,
  action: "test" | "delete",
): Promise<boolean> {
  const modal = new TikHubConfirmationModal(app, locale, action);
  const result = modal.waitForClose();
  modal.open();
  return await result;
}

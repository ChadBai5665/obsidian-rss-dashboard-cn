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
  let hasSecret = false;

  new Setting(containerEl)
    .setName(t("settings.tikhub.heading"))
    .setDesc(t("settings.tikhub.description"))
    .setHeading();

  new Setting(containerEl)
    .setName(t("settings.tikhub.enabled"))
    .setDesc(t("settings.tikhub.enabledDesc"))
    .addToggle((toggle) => toggle
      .setValue(plugin.settings.tikhub.enabled)
      .onChange(async (value) => {
        plugin.settings.tikhub.enabled = value;
        await plugin.saveSettings();
      }));

  let customBaseUrl = isPresetBaseUrl(plugin.settings.tikhub.baseUrl)
    ? ""
    : plugin.settings.tikhub.baseUrl;
  const customErrorEl = containerEl.createEl("p", {
    cls: "rss-dashboard-validation-error",
  });
  new Setting(containerEl)
    .setName(t("settings.tikhub.baseUrl"))
    .setDesc(t("settings.tikhub.baseUrlDesc"))
    .addDropdown((dropdown) => dropdown
      .addOption(MAINLAND_BASE_URL, t("settings.tikhub.presetMainland"))
      .addOption(OVERSEAS_BASE_URL, t("settings.tikhub.presetOverseas"))
      .addOption("custom", t("settings.tikhub.presetCustom"))
      .setValue(isPresetBaseUrl(plugin.settings.tikhub.baseUrl)
        ? plugin.settings.tikhub.baseUrl
        : "custom")
      .onChange(async (value) => {
        if (value === "custom") return;
        plugin.settings.tikhub.baseUrl = value;
        customErrorEl.setText("");
        await plugin.saveSettings();
      }));

  new Setting(containerEl)
    .setName(t("settings.tikhub.customBaseUrl"))
    .setDesc(t("settings.tikhub.customBaseUrlDesc"))
    .addText((text) => text
      .setPlaceholder("https://gateway.example.com")
      .setValue(customBaseUrl)
      .onChange((value) => { customBaseUrl = value; }))
    .addButton((button) => button
      .setButtonText(t("settings.tikhub.applyBaseUrl"))
      .onClick(() => {
        void (async () => {
          const normalized = normalizeTikHubBaseUrl(customBaseUrl);
          if (!normalized) {
            customErrorEl.setText(t("settings.tikhub.invalidBaseUrl"));
            return;
          }
          plugin.settings.tikhub.baseUrl = normalized;
          customBaseUrl = normalized;
          customErrorEl.setText("");
          await plugin.saveSettings();
        })();
      }));

  renderPositiveIntegerSetting(
    containerEl,
    t("settings.tikhub.maxRequestsPerRun"),
    plugin.settings.tikhub.maxRequestsPerRun,
    async (value) => {
      plugin.settings.tikhub.maxRequestsPerRun = value;
      await plugin.saveSettings();
    },
  );
  renderPositiveIntegerSetting(
    containerEl,
    t("settings.tikhub.maxRequestsPerDay"),
    plugin.settings.tikhub.maxRequestsPerDay,
    async (value) => {
      plugin.settings.tikhub.maxRequestsPerDay = value;
      await plugin.saveSettings();
    },
  );
  containerEl.createEl("p", {
    text: t("settings.tikhub.requestCaps", {
      run: plugin.settings.tikhub.maxRequestsPerRun,
      day: plugin.settings.tikhub.maxRequestsPerDay,
    }),
    cls: "rss-dashboard-request-caps",
  });

  const statusEl = containerEl.createEl("p", {
    cls: "rss-dashboard-secret-status",
  });
  const updateStatus = (): void => {
    statusEl.setText(t(hasSecret
      ? "settings.tikhub.keyConfigured"
      : "settings.tikhub.keyNotConfigured"));
  };
  updateStatus();
  if (UUID_PATTERN.test(plugin.settings.tikhub.connectionId)) {
    void secretStore.getStatus(plugin.settings.tikhub.connectionId)
      .then((status) => {
        hasSecret = status.hasSecret;
        updateStatus();
      })
      .catch(() => {
        hasSecret = false;
        updateStatus();
      });
  }

  const secretErrorEl = containerEl.createEl("p", {
    cls: "rss-dashboard-validation-error",
  });
  new Setting(containerEl)
    .setName(t("settings.tikhub.apiKey"))
    .setDesc(t("settings.tikhub.apiKeyDesc"))
    .addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.autocomplete = "new-password";
      text.inputEl.value = "";
      text.setPlaceholder(t("settings.tikhub.apiKeyPlaceholder"));
    })
    .addButton((button) => button
      .setButtonText(t("settings.tikhub.saveKey"))
      .setCta()
      .onClick(() => {
        void (async () => {
          const settingEl = button.buttonEl.closest(".setting-item");
          const inputEl = settingEl?.querySelector<HTMLInputElement>("input");
          if (!inputEl) return;
          const apiKey = inputEl.value;
          inputEl.value = "";
          secretErrorEl.setText("");
          if (!apiKey.trim()) {
            secretErrorEl.setText(t("settings.tikhub.keyRequired"));
            return;
          }
          try {
            let connectionId = plugin.settings.tikhub.connectionId;
            if (!UUID_PATTERN.test(connectionId)) {
              connectionId = createConnectionId();
              if (!UUID_PATTERN.test(connectionId)) throw new Error("invalid connection id");
              plugin.settings.tikhub.connectionId = connectionId;
              await plugin.saveSettings();
            }
            await secretStore.set(connectionId, apiKey);
            hasSecret = true;
            updateStatus();
            secretErrorEl.setText(t("settings.tikhub.keySaved"));
          } catch {
            hasSecret = false;
            updateStatus();
            secretErrorEl.setText(t("settings.tikhub.keySaveFailed"));
          }
        })();
      }))
    .addButton((button) => button
      .setButtonText(t("settings.tikhub.deleteKey"))
      .setWarning()
      .onClick(() => {
        void (async () => {
          if (!(await confirmDeleteSecret())) return;
          try {
            const connectionId = plugin.settings.tikhub.connectionId;
            if (UUID_PATTERN.test(connectionId)) await secretStore.delete(connectionId);
            plugin.settings.tikhub.enabled = false;
            await plugin.saveSettings();
            hasSecret = false;
            updateStatus();
            secretErrorEl.setText(t("settings.tikhub.keyDeleted"));
          } catch {
            secretErrorEl.setText(t("settings.tikhub.keyDeleteFailed"));
          }
        })();
      }));

  const connectionStatusEl = containerEl.createEl("p", {
    cls: "rss-dashboard-connection-status",
  });
  new Setting(containerEl)
    .setName(t("settings.tikhub.testConnection"))
    .setDesc([
      t("settings.tikhub.testConnectionDesc"),
      t("settings.tikhub.estimatedTestRequests"),
      t("settings.tikhub.requestCaps", {
        run: plugin.settings.tikhub.maxRequestsPerRun,
        day: plugin.settings.tikhub.maxRequestsPerDay,
      }),
    ].join(" "))
    .addButton((button) => button
      .setButtonText(t("settings.tikhub.testConnectionButton"))
      .onClick(() => {
        void (async () => {
          connectionStatusEl.setText("");
          if (!(await confirmPaidRequest())) return;
          const connectionId = plugin.settings.tikhub.connectionId;
          if (!UUID_PATTERN.test(connectionId)) {
            connectionStatusEl.setText(t("settings.tikhub.keyNotConfigured"));
            return;
          }
          let apiKey: string | undefined;
          try {
            apiKey = await secretStore.get(connectionId);
            if (!apiKey?.trim()) {
              connectionStatusEl.setText(t("settings.tikhub.keyNotConfigured"));
              return;
            }
            await testConnection(apiKey, {
              app: plugin.app,
              connectionId,
              baseUrl: plugin.settings.tikhub.baseUrl,
              timeoutMs: plugin.settings.tikhub.timeoutMs,
              dataFolder: plugin.settings.collection.dataFolder,
              maxRequestsPerRun: plugin.settings.tikhub.maxRequestsPerRun,
              maxRequestsPerDay: plugin.settings.tikhub.maxRequestsPerDay,
            });
            connectionStatusEl.setText(t("settings.tikhub.connectionSucceeded"));
          } catch (error) {
            connectionStatusEl.setText(getTikHubConnectionMessage(error, t));
          } finally {
            apiKey = undefined;
          }
        })();
      }));
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
  await client.fetchUserPosts({ apiKey, handle: "x" });
}

function renderPositiveIntegerSetting(
  containerEl: HTMLElement,
  label: string,
  value: number,
  onSave: (value: number) => Promise<void>,
): void {
  new Setting(containerEl).setName(label).addText((text) => {
    text.inputEl.type = "number";
    text.inputEl.min = "1";
    text.setValue(String(value));
    text.inputEl.addEventListener("change", () => {
      void (async () => {
        const parsed = Number(text.inputEl.value);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          text.setValue(String(value));
          return;
        }
        await onSave(parsed);
      })();
    });
  });
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

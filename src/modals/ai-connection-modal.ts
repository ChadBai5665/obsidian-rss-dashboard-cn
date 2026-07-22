import { App, Modal, Setting } from "obsidian";
import type { AiConnection, AiProviderKind } from "../ai/ai-types";
import {
  normalizeAiBaseUrl,
  normalizeAiConnection,
} from "../ai/connection-validation";
import {
  AI_PROVIDER_PRESETS,
  createAiConnection,
  getAiProviderPreset,
} from "../ai/provider-presets";
import { validApiKeyValue } from "../ai/providers/text-generation-provider";
import { normalizeConnectionId } from "../security/connection-id";
import type { DesktopSecretStore } from "../security/desktop-secret-store";
import {
  createTranslator,
  type Locale,
  type TranslationKey,
  type Translator,
} from "../i18n";

const MAX_NAME_CHARACTERS = 200;
const MAX_MODEL_CHARACTERS = 500;
const MAX_BASE_URL_CHARACTERS = 2_048;
const MAX_KEY_CHARACTERS = 16_384;

const PROVIDER_LABEL_KEYS: Readonly<Record<AiProviderKind, TranslationKey>> =
  Object.freeze({
    kimi: "settings.ai.provider.kimi",
    deepseek: "settings.ai.provider.deepseek",
    qwen: "settings.ai.provider.qwen",
    glm: "settings.ai.provider.glm",
    openai: "settings.ai.provider.openai",
    claude: "settings.ai.provider.claude",
    "openai-compatible": "settings.ai.provider.openaiCompatible",
    "anthropic-compatible": "settings.ai.provider.anthropicCompatible",
  });

export interface AiConnectionModalSecretStore {
  set(connectionId: string, apiKey: string): Promise<void>;
}

export interface AiConnectionModalOptions {
  locale?: Locale;
  existing?: AiConnection;
  secretStore: Pick<DesktopSecretStore, "set"> | AiConnectionModalSecretStore;
  createConnectionId?: () => string;
  onSave(connection: AiConnection): Promise<void> | void;
  onClose?(): void;
}

export class AiConnectionModal extends Modal {
  private lifecycleEpoch = 0;

  constructor(
    app: App,
    private readonly options: AiConnectionModalOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    const lifecycleToken = ++this.lifecycleEpoch;
    const t = createTranslator(this.options.locale ?? "zh-CN");
    const existing = this.options.existing
      ? normalizeAiConnection(this.options.existing)
      : undefined;
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("rss-dashboard-modal");
    contentEl.createEl("h2", {
      text: t(existing ? "settings.ai.editTitle" : "settings.ai.addTitle"),
    });

    let providerKind: AiProviderKind = existing?.providerKind ?? "kimi";
    let name = existing?.name ?? "";
    let model = existing?.model ?? "";
    let baseUrl = existing?.baseUrl ?? getAiProviderPreset(providerKind)?.baseUrl ?? "";
    let enabled = existing?.enabled ?? true;
    let pendingKey = "";
    let inFlight = false;

    const providerGuidanceEl = contentEl.createEl("p", {
      cls: "rss-dashboard-ai-provider-guidance",
    });
    const errorEl = contentEl.createEl("p", {
      cls: "rss-dashboard-validation-error",
    });
    errorEl.setAttribute("role", "alert");
    errorEl.setAttribute("aria-live", "polite");

    let protocolSetting: Setting;
    let baseUrlInput: HTMLInputElement;
    let modelInput: HTMLInputElement;
    let keyInput: HTMLInputElement;
    let cancelButton: HTMLButtonElement | undefined;
    let saveButton: HTMLButtonElement | undefined;

    new Setting(contentEl)
      .setName(t("settings.ai.provider"))
      .setDesc(t("settings.ai.providerDesc"))
      .addDropdown((dropdown) => {
        for (const preset of AI_PROVIDER_PRESETS) {
          dropdown.addOption(
            preset.providerKind,
            t(PROVIDER_LABEL_KEYS[preset.providerKind]),
          );
        }
        dropdown.setValue(providerKind).onChange((value) => {
          if (!isProviderKind(value) || inFlight) return;
          providerKind = value;
          const preset = getAiProviderPreset(providerKind);
          baseUrl = preset?.baseUrl ?? "";
          model = "";
          baseUrlInput.value = baseUrl;
          modelInput.value = "";
          renderProviderFields();
        });
      });

    new Setting(contentEl)
      .setName(t("settings.ai.connectionName"))
      .setDesc(t("settings.ai.connectionNameDesc"))
      .addText((text) => {
        text.setValue(name).onChange((value) => { name = value; });
        text.inputEl.maxLength = MAX_NAME_CHARACTERS;
      });

    protocolSetting = new Setting(contentEl)
      .setName(t("settings.ai.protocol"));

    new Setting(contentEl)
      .setName(t("settings.ai.baseUrl"))
      .setDesc(t("settings.ai.baseUrlDesc"))
      .addText((text) => {
        baseUrlInput = text.inputEl;
        text.setValue(baseUrl).onChange((value) => { baseUrl = value; });
        baseUrlInput.maxLength = MAX_BASE_URL_CHARACTERS;
      });

    new Setting(contentEl)
      .setName(t("settings.ai.model"))
      .setDesc(t("settings.ai.modelDesc"))
      .addText((text) => {
        modelInput = text.inputEl;
        text.setValue(model).onChange((value) => { model = value; });
        modelInput.maxLength = MAX_MODEL_CHARACTERS;
      });

    new Setting(contentEl)
      .setName(t("settings.ai.apiKey"))
      .setDesc(t(existing
        ? "settings.ai.apiKeyEditDesc"
        : "settings.ai.apiKeyDesc"))
      .addText((text) => {
        keyInput = text.inputEl;
        keyInput.type = "password";
        keyInput.autocomplete = "off";
        keyInput.maxLength = MAX_KEY_CHARACTERS;
        text.setPlaceholder(t("settings.ai.apiKeyPlaceholder"));
        text.onChange((value) => { pendingKey = value; });
      });

    new Setting(contentEl)
      .setName(t("settings.ai.enabled"))
      .setDesc(t("settings.ai.enabledDesc"))
      .addToggle((toggle) => toggle
        .setValue(enabled)
        .onChange((value) => { enabled = value; }));

    const isCurrent = (): boolean =>
      lifecycleToken === this.lifecycleEpoch && contentEl.isConnected;
    const setBusy = (busy: boolean): void => {
      for (const button of [cancelButton, saveButton]) {
        if (!button) continue;
        button.disabled = busy;
        button.setAttribute("aria-disabled", String(busy));
      }
    };
    const renderProviderFields = (): void => {
      const preset = getAiProviderPreset(providerKind);
      protocolSetting.setDesc(t(
        preset?.protocol === "anthropic-messages"
          ? "settings.ai.protocolAnthropic"
          : "settings.ai.protocolOpenAi",
      ));
      baseUrlInput.disabled = preset?.baseUrl !== undefined;
      baseUrlInput.setAttribute("aria-disabled", String(baseUrlInput.disabled));
      providerGuidanceEl.setText(providerGuidance(providerKind, t));
    };
    renderProviderFields();

    new Setting(contentEl)
      .addButton((button) => {
        cancelButton = button.buttonEl;
        button.setButtonText(t("common.cancel")).onClick(() => {
          if (!inFlight) this.close();
        });
      })
      .addButton((button) => {
        saveButton = button.buttonEl;
        button
          .setButtonText(t("common.save"))
          .setCta()
          .onClick(() => {
            if (inFlight || !isCurrent()) return;
            const submittedKey = pendingKey;
            pendingKey = "";
            keyInput.value = "";

            const connection = buildConnection({
              existing,
              providerKind,
              name,
              model,
              baseUrl,
              enabled,
              createConnectionId:
                this.options.createConnectionId ?? defaultConnectionId,
            });
            if (!connection.ok) {
              errorEl.setText(t(connection.error));
              return;
            }
            if (submittedKey && !validSubmittedKey(submittedKey)) {
              errorEl.setText(t("settings.ai.invalidKey"));
              return;
            }

            inFlight = true;
            setBusy(true);
            void (async () => {
              let keyForWrite: string | undefined = submittedKey || undefined;
              try {
                errorEl.setText("");
                await this.options.onSave(connection.connection);
                if (keyForWrite !== undefined) {
                  try {
                    await this.options.secretStore.set(
                      connection.connection.id,
                      keyForWrite,
                    );
                  } catch {
                    if (isCurrent()) {
                      errorEl.setText(t("settings.ai.keySaveAfterMetadataFailed"));
                    }
                    return;
                  }
                }
                if (isCurrent()) this.close();
              } catch {
                if (isCurrent()) {
                  errorEl.setText(t("settings.ai.metadataSaveFailed"));
                }
              } finally {
                keyForWrite = undefined;
                if (isCurrent()) {
                  inFlight = false;
                  setBusy(false);
                }
              }
            })();
          });
      });
  }

  onClose(): void {
    this.lifecycleEpoch += 1;
    try {
      this.contentEl.empty();
    } finally {
      this.options.onClose?.();
    }
  }
}

interface BuildConnectionInput {
  existing?: AiConnection;
  providerKind: AiProviderKind;
  name: string;
  model: string;
  baseUrl: string;
  enabled: boolean;
  createConnectionId(): string;
}

type BuildConnectionResult =
  | { ok: true; connection: AiConnection }
  | { ok: false; error: TranslationKey };

function buildConnection(input: BuildConnectionInput): BuildConnectionResult {
  const name = boundedText(input.name, MAX_NAME_CHARACTERS);
  if (!name) return { ok: false, error: "settings.ai.nameRequired" };
  const model = boundedText(input.model, MAX_MODEL_CHARACTERS);
  if (!model) return { ok: false, error: "settings.ai.modelRequired" };
  if (
    typeof input.baseUrl !== "string" ||
    input.baseUrl.length > MAX_BASE_URL_CHARACTERS
  ) {
    return { ok: false, error: "settings.ai.invalidBaseUrl" };
  }
  const baseUrl = normalizeAiBaseUrl(input.baseUrl, input.providerKind);
  if (!baseUrl) return { ok: false, error: "settings.ai.invalidBaseUrl" };

  let id: string | undefined;
  try {
    id = normalizeConnectionId(input.existing?.id ?? input.createConnectionId());
  } catch {
    id = undefined;
  }
  if (!id) return { ok: false, error: "settings.ai.invalidConnectionId" };

  try {
    const created = createAiConnection({
      id,
      name,
      providerKind: input.providerKind,
      baseUrl,
      model,
    });
    const connection = normalizeAiConnection({
      ...created,
      timeoutMs: input.existing?.timeoutMs ?? created.timeoutMs,
      maxInputCharacters:
        input.existing?.maxInputCharacters ?? created.maxInputCharacters,
      enabled: input.enabled,
    });
    return connection
      ? { ok: true, connection }
      : { ok: false, error: "settings.ai.invalidConnection" };
  } catch {
    return { ok: false, error: "settings.ai.invalidConnection" };
  }
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string" || value.length > maximum) return undefined;
  const normalized = value.normalize("NFC").trim();
  if (!normalized || hasControlCharacters(normalized)) {
    return undefined;
  }
  return normalized;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))
    ) {
      return true;
    }
  }
  return false;
}

function validSubmittedKey(value: string): boolean {
  return value.length <= MAX_KEY_CHARACTERS && validApiKeyValue(value);
}

function isProviderKind(value: string): value is AiProviderKind {
  return AI_PROVIDER_PRESETS.some((preset) => preset.providerKind === value);
}

function providerGuidance(
  providerKind: AiProviderKind,
  t: Translator,
): string {
  if (providerKind === "qwen") return t("settings.ai.qwenGuidance");
  if (providerKind === "claude") return t("settings.ai.claudeGuidance");
  if (
    providerKind === "openai-compatible" ||
    providerKind === "anthropic-compatible"
  ) {
    return t("settings.ai.relayGuidance");
  }
  return t("settings.ai.modelAccountGuidance");
}

function defaultConnectionId(): string {
  const id = window.crypto?.randomUUID?.();
  if (!id) throw new Error("Secure connection identity is unavailable.");
  return id;
}

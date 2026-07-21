import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import {
  formatStorageRepairResult,
  parseStorageRepairResult,
  renderStorageSettingsTab,
} from "../../../src/settings/tabs/storage-settings-tab";
import { createTranslator } from "../../../src/i18n";
import {
  ShardDeletionFailureModal,
  StorageTransitionModal,
} from "../../../src/settings/modals/storage-settings-modals";
import {
  ShardFolderDeletionError,
  type FeedStorageStatus,
} from "../../../src/services/feed-storage-repository";
import {
  DEFAULT_SETTINGS,
  type RssDashboardSettings,
} from "../../../src/types/types";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

function cloneSettings(): RssDashboardSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as RssDashboardSettings;
}

async function flushAsyncWork(cycles = 6) {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve();
  }
}

function resetDocumentBody(): void {
  document.body.innerHTML = "";
}

function createTestContainer(): HTMLDivElement {
  const containerEl = document.createElement("div");
  document.body.appendChild(containerEl);
  return containerEl;
}

function getSettingByName(containerEl: HTMLElement, name: string): HTMLElement {
  const settingEls = Array.from(containerEl.querySelectorAll(".setting-item"));
  const match = settingEls.find((el) => {
    const nameEl = el.querySelector(".setting-item-name");
    return nameEl?.textContent === name;
  });

  if (!match) {
    throw new Error(`Setting not found: ${name}`);
  }

  return match as HTMLElement;
}

function createPlugin() {
  return {
    app: obsidian.App.createMock() as unknown as obsidian.App,
    settingTab: {
      display: vi.fn(),
    },
    settings: { ...cloneSettings(), locale: "en" },
    saveSettings: vi.fn(async () => {}),
    getActiveDashboardView: vi.fn(async () => null),
    getStorageStatus: vi.fn(
      (): FeedStorageStatus => ({
        mode: "legacy-json" as const,
        folder: ".rss-dashboard-data/feeds",
        shardCount: 0,
        feedCount: 0,
        migrationReady: true,
        lastRepairResult: "Not yet run",
      }),
    ),
    migrateToVaultStorage: vi.fn(async () => {}),
    revertToLegacyJsonStorage: vi.fn(async () => {}),
    revertToLegacyJsonStorageWithOptions: vi.fn(async () => {}),
    isShardFolderDeletionError: (
      error: unknown,
    ): error is ShardFolderDeletionError =>
      error instanceof ShardFolderDeletionError,
    openStorageFolderInSystem: vi.fn(async () => {}),
    repairVaultStorage: vi.fn(async () => {}),
    importPortableDataBundleFromFile: vi.fn(async () => {}),
    exportDataJson: vi.fn(async () => {}),
    exportPortableDataBundle: vi.fn(async () => {}),
    migrateMetadataToVaultLocation: vi.fn(async () => {}),
    revertMetadataToPluginDefault: vi.fn(async () => {}),
    applyFeedLimitsToAllFeeds: vi.fn(async () => {}),
    refreshFeeds: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  installObsidianDomPolyfills();
  resetDocumentBody();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("General settings storage section", () => {
  it.each([
    ["Migration completed (v2)", "已迁移到分片存储 v2", "Migration to Shard Storage v2 completed"],
    ["Reverted to legacy JSON", "已恢复为旧版 JSON", "Reverted to Legacy JSON"],
    ["Last repair succeeded at 2026/7/22 09:30", "上次修复成功时间：2026/7/22 09:30", "Last repair succeeded at 2026/7/22 09:30"],
    ["Not yet run", "尚未执行", "Not yet run"],
    ["Legacy result from v1", "历史结果：Legacy result from v1", "Previous result: Legacy result from v1"],
  ])("formats persisted result %s in both locales", (result, zh, en) => {
    expect(formatStorageRepairResult(result, createTranslator("zh-CN"))).toBe(zh);
    expect(formatStorageRepairResult(result, createTranslator("en"))).toBe(en);
  });

  it("parses service repair timestamps and preserves unknown legacy values", () => {
    expect(parseStorageRepairResult("Last repair succeeded at 2026-07-22")).toEqual({
      kind: "repair-succeeded",
      time: "2026-07-22",
    });
    expect(parseStorageRepairResult("historic repair result")).toEqual({
      kind: "legacy",
      value: "historic repair result",
    });
  });
  it("renders storage controls in Chinese by default without changing storage identifiers", () => {
    const containerEl = createTestContainer();
    const plugin = createPlugin();
    plugin.settings.locale = "zh-CN";

    renderStorageSettingsTab(containerEl, plugin as never);

    expect(containerEl.textContent).toContain("本地存储");
    expect(containerEl.textContent).toContain("存储模式");
    expect(containerEl.textContent).toContain("存储状态");
    const select = getSettingByName(containerEl, "存储模式").querySelector("select");
    expect(select?.querySelector('option[value="legacy-json"]')?.textContent).toBe("旧版 JSON");
  });

  it("keeps English storage wording available when English is selected", () => {
    const containerEl = createTestContainer();
    const plugin = createPlugin();
    plugin.settings.locale = "en";

    renderStorageSettingsTab(containerEl, plugin as never);

    expect(containerEl.textContent).toContain("Storage");
    expect(containerEl.textContent).toContain("Storage mode");
  });

  it("keeps stored mode IDs stable while localizing status mode and repair result", () => {
    const containerEl = createTestContainer();
    const plugin = createPlugin();
    plugin.settings.locale = "zh-CN";
    vi.mocked(plugin.getStorageStatus).mockReturnValue({
      mode: "legacy-json",
      folder: ".rss-dashboard-data/feeds",
      feedCount: 2,
      shardCount: 0,
      migrationReady: false,
      lastRepairResult: "Migration completed",
    });

    renderStorageSettingsTab(containerEl, plugin as never);

    const select = getSettingByName(containerEl, "存储模式").querySelector("select");
    expect(select?.querySelector('option[value="legacy-json"]')).toBeTruthy();
    expect(containerEl.textContent).toContain("模式：旧版 JSON");
    expect(containerEl.textContent).toContain("上次结果：迁移已完成");
  });

  it("marks the storage transition modal for mobile safe-area positioning", () => {
    const app = obsidian.App.createMock();
    const modal = new StorageTransitionModal(app, {
      currentMode: "legacy-json",
      targetMode: "vault-shards",
      storageFolder: ".rss-dashboard-data/feeds",
    });

    modal.open();

    expect(
      modal.modalEl.classList.contains("rss-storage-transition-modal"),
    ).toBe(true);
    expect(
      modal.contentEl.querySelector(".rss-storage-transition-buttons"),
    ).toBeTruthy();
  });

  it("applies the pending legacy-to-shards storage change through the modal", async () => {
    const containerEl = createTestContainer();
    const plugin = createPlugin();
    plugin.settings.storageMode = "legacy-json";
    vi.spyOn(StorageTransitionModal.prototype, "open").mockImplementation(
      () => {},
    );
    vi.spyOn(
      StorageTransitionModal.prototype,
      "waitForClose",
    ).mockResolvedValue("apply");

    renderStorageSettingsTab(containerEl, plugin as never);

    const storageModeSetting = getSettingByName(containerEl, "Storage mode");
    const select = storageModeSetting.querySelector(
      "select",
    ) as HTMLSelectElement;
    select.value = "vault-shards";
    select.dispatchEvent(new Event("change"));

    const buttons = Array.from(containerEl.querySelectorAll("button"));
    const applyButton = buttons.find(
      (button) => button.textContent === "Apply",
    ) as HTMLButtonElement;
    const repairButton = buttons.find(
      (button) => button.textContent === "Repair/rebuild storage",
    ) as HTMLButtonElement;
    const importButton = buttons.find(
      (button) => button.textContent === "Import shard data",
    ) as HTMLButtonElement;
    const exportButton = buttons.find(
      (button) => button.textContent === "Export shard data",
    ) as HTMLButtonElement;

    applyButton.click();
    repairButton.click();
    importButton.click();
    exportButton.click();

    await Promise.resolve();

    expect(plugin.migrateToVaultStorage).toHaveBeenCalledTimes(1);
    expect(plugin.repairVaultStorage).toHaveBeenCalledTimes(1);
    expect(plugin.exportPortableDataBundle).toHaveBeenCalledTimes(1);
  });

  it("does not trigger migration when the storage mode dropdown changes", async () => {
    const containerEl = createTestContainer();
    const plugin = createPlugin();
    plugin.settings.storageMode = "legacy-json";

    renderStorageSettingsTab(containerEl, plugin as never);

    const storageModeSetting = getSettingByName(containerEl, "Storage mode");
    const select = storageModeSetting.querySelector(
      "select",
    ) as HTMLSelectElement;

    select.value = "vault-shards";
    select.dispatchEvent(new Event("change"));

    await Promise.resolve();

    expect(plugin.migrateToVaultStorage).not.toHaveBeenCalled();
    expect(plugin.revertToLegacyJsonStorage).not.toHaveBeenCalled();
    expect(select.value).toBe("vault-shards");
    expect(plugin.settings.storageMode).toBe("legacy-json");
  });

  it("exports data.json from the apply modal before migrating to shards", async () => {
    const containerEl = createTestContainer();
    const plugin = createPlugin();
    plugin.settings.storageMode = "legacy-json";
    vi.spyOn(StorageTransitionModal.prototype, "open").mockImplementation(
      () => {},
    );
    vi.spyOn(
      StorageTransitionModal.prototype,
      "waitForClose",
    ).mockResolvedValue("export-data-json");

    renderStorageSettingsTab(containerEl, plugin as never);

    const storageModeSetting = getSettingByName(containerEl, "Storage mode");
    const select = storageModeSetting.querySelector(
      "select",
    ) as HTMLSelectElement;
    select.value = "vault-shards";
    select.dispatchEvent(new Event("change"));

    const applyButton = Array.from(containerEl.querySelectorAll("button")).find(
      (button) => button.textContent === "Apply",
    ) as HTMLButtonElement;

    applyButton.click();
    await Promise.resolve();

    expect(plugin.exportDataJson).toHaveBeenCalledTimes(1);
    expect(plugin.migrateToVaultStorage).not.toHaveBeenCalled();
  });

  it("passes the delete-shard-folder choice when applying a shards-to-legacy change", async () => {
    const containerEl = createTestContainer();
    const plugin = createPlugin();
    plugin.settings.storageMode = "vault-shards";
    plugin.getStorageStatus = vi.fn(() => ({
      mode: "vault-shards" as const,
      folder: ".rss-dashboard-data/feeds",
      shardCount: 3,
      feedCount: 3,
      migrationReady: false,
      lastRepairResult: "Migration completed",
    }));
    vi.spyOn(StorageTransitionModal.prototype, "open").mockImplementation(
      () => {},
    );
    vi.spyOn(
      StorageTransitionModal.prototype,
      "waitForClose",
    ).mockResolvedValue("apply-delete-shards");

    renderStorageSettingsTab(containerEl, plugin as never);

    const storageModeSetting = getSettingByName(containerEl, "Storage mode");
    const select = storageModeSetting.querySelector(
      "select",
    ) as HTMLSelectElement;
    select.value = "legacy-json";
    select.dispatchEvent(new Event("change"));

    const applyButton = Array.from(containerEl.querySelectorAll("button")).find(
      (button) => button.textContent === "Apply",
    ) as HTMLButtonElement;

    applyButton.click();
    await Promise.resolve();

    expect(plugin.revertToLegacyJsonStorageWithOptions).toHaveBeenCalledWith({
      deleteShardFolder: true,
    });
  });

  it("pauses revert when shard deletion fails and can continue with apply anyway", async () => {
    const containerEl = createTestContainer();
    const plugin = createPlugin();
    plugin.settings.storageMode = "vault-shards";
    plugin.getStorageStatus = vi.fn(() => ({
      mode: "vault-shards" as const,
      folder: ".rss-dashboard-data/feeds",
      shardCount: 3,
      feedCount: 3,
      migrationReady: false,
      lastRepairResult: "Migration completed",
    }));
    plugin.revertToLegacyJsonStorageWithOptions = vi
      .fn()
      .mockRejectedValueOnce(
        new ShardFolderDeletionError(
          ".rss-dashboard-data/feeds",
          "Shard folder still exists after delete attempt",
        ),
      )
      .mockResolvedValueOnce(undefined);

    vi.spyOn(StorageTransitionModal.prototype, "open").mockImplementation(
      () => {},
    );
    vi.spyOn(
      StorageTransitionModal.prototype,
      "waitForClose",
    ).mockResolvedValue("apply-delete-shards");
    vi.spyOn(ShardDeletionFailureModal.prototype, "open").mockImplementation(
      () => {},
    );
    vi.spyOn(
      ShardDeletionFailureModal.prototype,
      "waitForClose",
    ).mockResolvedValue("apply-anyway");

    renderStorageSettingsTab(containerEl, plugin as never);

    const storageModeSetting = getSettingByName(containerEl, "Storage mode");
    const select = storageModeSetting.querySelector(
      "select",
    ) as HTMLSelectElement;
    select.value = "legacy-json";
    select.dispatchEvent(new Event("change"));

    const applyButton = Array.from(containerEl.querySelectorAll("button")).find(
      (button) => button.textContent === "Apply",
    ) as HTMLButtonElement;

    applyButton.click();
    await flushAsyncWork();

    expect(plugin.revertToLegacyJsonStorageWithOptions).toHaveBeenNthCalledWith(
      1,
      {
        deleteShardFolder: true,
      },
    );
    expect(plugin.revertToLegacyJsonStorageWithOptions).toHaveBeenNthCalledWith(
      2,
      {
        deleteShardFolder: false,
      },
    );
  });

  it("can open the shard folder after delete failure before the user decides", async () => {
    const containerEl = createTestContainer();
    const plugin = createPlugin();
    plugin.settings.storageMode = "vault-shards";
    plugin.getStorageStatus = vi.fn(() => ({
      mode: "vault-shards" as const,
      folder: ".rss-dashboard-data/feeds",
      shardCount: 3,
      feedCount: 3,
      migrationReady: false,
      lastRepairResult: "Migration completed",
    }));
    plugin.revertToLegacyJsonStorageWithOptions = vi
      .fn()
      .mockRejectedValueOnce(
        new ShardFolderDeletionError(
          ".rss-dashboard-data/feeds",
          "Shard folder still exists after delete attempt",
        ),
      );

    vi.spyOn(StorageTransitionModal.prototype, "open").mockImplementation(
      () => {},
    );
    vi.spyOn(
      StorageTransitionModal.prototype,
      "waitForClose",
    ).mockResolvedValue("apply-delete-shards");
    vi.spyOn(ShardDeletionFailureModal.prototype, "open").mockImplementation(
      () => {},
    );
    vi.spyOn(ShardDeletionFailureModal.prototype, "waitForClose")
      .mockResolvedValueOnce("open-folder")
      .mockResolvedValueOnce("cancel");

    renderStorageSettingsTab(containerEl, plugin as never);

    const storageModeSetting = getSettingByName(containerEl, "Storage mode");
    const select = storageModeSetting.querySelector(
      "select",
    ) as HTMLSelectElement;
    select.value = "legacy-json";
    select.dispatchEvent(new Event("change"));

    const applyButton = Array.from(containerEl.querySelectorAll("button")).find(
      (button) => button.textContent === "Apply",
    ) as HTMLButtonElement;

    applyButton.click();
    await flushAsyncWork();

    expect(plugin.openStorageFolderInSystem).toHaveBeenCalledWith(
      ".rss-dashboard-data/feeds",
    );
    expect(plugin.revertToLegacyJsonStorageWithOptions).toHaveBeenCalledTimes(
      1,
    );
  });

  it("updates the storage folder setting through a standard text input", async () => {
    const containerEl = createTestContainer();
    const plugin = createPlugin();
    plugin.settings.storageMode = "legacy-json";

    renderStorageSettingsTab(containerEl, plugin as never);

    const storageFolderSetting = getSettingByName(
      containerEl,
      "Storage folder",
    );
    const input = storageFolderSetting.querySelector(
      "input",
    ) as HTMLInputElement;

    input.value = ".rss-dashboard-data/custom-feeds";
    input.dispatchEvent(new Event("input"));

    const applyButton = Array.from(containerEl.querySelectorAll("button")).find(
      (button) => button.textContent === "Apply",
    ) as HTMLButtonElement;

    applyButton.click();
    await flushAsyncWork();

    expect(plugin.settings.storageFolder).toBe(
      ".rss-dashboard-data/custom-feeds",
    );
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  });
});

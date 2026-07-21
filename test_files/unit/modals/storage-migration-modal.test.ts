import { beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { StorageMigrationModal } from "../../../src/modals/storage-migration-modal";
import type RssDashboardPlugin from "../../../main";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

type MockApp = obsidian.App;

interface TestPlugin {
  settings: {
    storageMigrationDismissedPermanently?: boolean;
    storageMode: string;
  };
  saveSettings: () => Promise<void>;
  backupAndMigrateStorageToV2: () => Promise<void>;
}

function createMockApp(): MockApp {
  return new obsidian.App();
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
});

describe("StorageMigrationModal", () => {
  it("renders Chinese by default and closes statelessly on '稍后提醒'", async () => {
    const app = createMockApp();
    const plugin: TestPlugin = {
      settings: { storageMode: "legacy-json" },
      saveSettings: vi.fn(async () => {}),
      backupAndMigrateStorageToV2: vi.fn(async () => {}),
    };

    const modal = new StorageMigrationModal(app, plugin as unknown as RssDashboardPlugin);
    modal.open();

    const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
    const remindBtn = buttons.find((b) => b.textContent === "稍后提醒") as HTMLButtonElement;
    expect(remindBtn).toBeDefined();

    remindBtn.click();
    await flushPromises();

    expect(plugin.settings.storageMigrationDismissedPermanently).toBeUndefined();
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(plugin.backupAndMigrateStorageToV2).not.toHaveBeenCalled();
  });

  it("sets dismissed permanently on '不再提示'", async () => {
    const app = createMockApp();
    const plugin: TestPlugin = {
      settings: { storageMode: "legacy-json" },
      saveSettings: vi.fn(async () => {}),
      backupAndMigrateStorageToV2: vi.fn(async () => {}),
    };

    const modal = new StorageMigrationModal(app, plugin as unknown as RssDashboardPlugin);
    modal.open();

    const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
    const neverBtn = buttons.find((b) => b.textContent === "不再提示") as HTMLButtonElement;
    expect(neverBtn).toBeDefined();

    neverBtn.click();
    await flushPromises();

    expect(plugin.settings.storageMigrationDismissedPermanently).toBe(true);
    expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
    expect(plugin.backupAndMigrateStorageToV2).not.toHaveBeenCalled();
  });

  it("calls backupAndMigrateStorageToV2 from the Chinese upgrade action", async () => {
    const app = createMockApp();
    const plugin: TestPlugin = {
      settings: { storageMode: "legacy-json" },
      saveSettings: vi.fn(async () => {}),
      backupAndMigrateStorageToV2: vi.fn(async () => {}),
    };

    const modal = new StorageMigrationModal(app, plugin as unknown as RssDashboardPlugin);
    modal.open();

    const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
    const upgradeBtn = buttons.find((b) => b.textContent?.includes("立即升级")) as HTMLButtonElement;
    expect(upgradeBtn).toBeDefined();

    upgradeBtn.click();
    await flushPromises();

    // The method backupAndMigrateStorageToV2 itself handles setting the flag to true
    // In our test, we just check that the method was called
    expect(plugin.backupAndMigrateStorageToV2).toHaveBeenCalledTimes(1);
  });
});

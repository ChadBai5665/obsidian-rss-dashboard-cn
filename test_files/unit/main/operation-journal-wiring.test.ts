import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, type PluginManifest } from "obsidian";
import RssDashboardPlugin from "../../../main";
import { OperationJournalClearModal } from "../../../src/modals/operation-journal-clear-modal";
import { OperationJournalService } from "../../../src/operation-journal/operation-journal-service";
import type { OperationJournalPort } from "../../../src/operation-journal/operation-journal-service";
import { OperationJournalRepository } from "../../../src/operation-journal/operation-journal-repository";
import { DEFAULT_SETTINGS } from "../../../src/types/types";
import type { OperationJournalUiPort } from "../../../src/components/operation-journal-panel";
import type { OperationJournalSettingsPort } from "../../../src/settings/tabs/import-export-settings-tab";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

function manifest(): PluginManifest {
  return {
    id: "rss-dashboard",
    name: "RSS Dashboard",
    version: "1.0.0",
    author: "Test",
    description: "Test plugin",
    dir: ".",
  };
}

interface JournalWiringApi {
  getOperationJournalPort(): OperationJournalPort;
  getOperationJournalRuntime(): {
    dataRoot: string;
    service: OperationJournalService;
  };
  getOperationJournalUi(): OperationJournalUiPort;
  getOperationJournalSettings(): OperationJournalSettingsPort;
  getYouTubeTranscriptRuntime(): {
    service: {
      options: { operationJournal?: unknown };
      providers: ReadonlyArray<{
        provider: { options?: { operationJournal?: unknown } };
      }>;
      dispose(): void;
      readCached(request: unknown): Promise<unknown>;
    };
  };
  getSubscriptionService(): { dependencies: { operationJournal?: unknown } };
  getSourceRefreshLedger(): unknown;
  getCollectionService(): unknown;
  initializeSettingsBackedServices(): void;
  commitSettingsCandidateUnlocked(
    build: (previous: typeof DEFAULT_SETTINGS) => typeof DEFAULT_SETTINGS,
  ): Promise<void>;
  feedStorageRepository: {
    persistSettings(): Promise<unknown>;
    persistSettingsTransaction<T>(
      previous: typeof DEFAULT_SETTINGS,
      candidate: typeof DEFAULT_SETTINGS,
      plan: unknown,
      afterPersist: () => Promise<T>,
      options?: unknown,
    ): Promise<T>;
  };
  verifyImportedSettingsPersistence(): Promise<void>;
  beginRefreshJournalSafely(input: {
    trigger: "manual";
    action: "all";
  }): ReturnType<OperationJournalService["begin"]> | undefined;
}

function harness() {
  const app = App.createMock();
  const plugin = new RssDashboardPlugin(app, manifest());
  plugin.settings = structuredClone(DEFAULT_SETTINGS);
  return { app, plugin, api: plugin as unknown as JournalWiringApi };
}

function transcriptBegin() {
  return {
    category: "transcript" as const,
    action: "retrieve" as const,
    trigger: "manual" as const,
    subject: { itemId: "item-1" },
    stage: "requested" as const,
    details: { contentBasis: "youtube-transcript" as const },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function emptyList() {
  return Object.freeze({
    operations: Object.freeze([]),
    incompleteDates: Object.freeze([]),
    corruptDates: Object.freeze([]),
    truncated: false,
    health: Object.freeze({
      writeIncomplete: false,
      maintenanceIncomplete: false,
    }),
  });
}

function persistedResult() {
  return {
    metadataSaved: true,
    shardWriteCount: 0,
    shardDeleteCount: 0,
  };
}

beforeEach(() => {
  installObsidianDomPolyfills();
  vi.restoreAllMocks();
});

describe("operation journal runtime composition", () => {
  it("reuses one normalized-root service across transcript, TikHub, refresh, and subscriptions", async () => {
    const test = harness();
    test.plugin.settings.collection.dataFolder = ".rss-dashboard-data/";
    const service = test.api.getOperationJournalPort();
    expect(service).toBeInstanceOf(OperationJournalService);

    test.plugin.settings.collection.dataFolder = ".rss-dashboard-data";
    expect(test.api.getOperationJournalPort()).toBe(service);

    const transcript = test.api.getYouTubeTranscriptRuntime().service;
    expect(transcript.options.operationJournal).toBe(service);
    const tikhub = transcript.providers.find(({ provider }) =>
      provider.options?.operationJournal !== undefined
    );
    expect(tikhub?.provider.options?.operationJournal).toBe(service);
    expect(test.api.getSubscriptionService().dependencies.operationJournal)
      .toBe(service);
    const begin = vi.spyOn(service, "begin");
    const refreshScope = test.api.beginRefreshJournalSafely({
      trigger: "manual",
      action: "all",
    });
    expect(begin).toHaveBeenCalledWith(expect.objectContaining({
      category: "refresh",
      trigger: "manual",
      action: "all",
    }));
    await refreshScope?.succeed("completed", {
      total: 0,
      succeeded: 0,
      failed: 0,
      newItems: 0,
      elapsedMs: 0,
    });
  });

  it("constructs without creating folders and creates them only for the first event", async () => {
    const test = harness();
    const root = test.plugin.settings.collection.dataFolder;
    const service = test.api.getOperationJournalPort();

    await expect(test.app.vault.adapter.exists(root)).resolves.toBe(false);

    const scope = service.begin(transcriptBegin());
    await scope.succeed("completed", { contentBasis: "youtube-transcript" });

    await expect(test.app.vault.adapter.exists(root)).resolves.toBe(true);
    await expect(test.app.vault.adapter.exists(`${root}/state/operation-journal`))
      .resolves.toBe(true);
  });

  it("revokes old-root broadcasts and keeps one stable narrow facade", async () => {
    const test = harness();
    const ui = test.api.getOperationJournalUi();
    const listener = vi.fn();
    const unsubscribe = ui.subscribe(listener);
    const oldService = test.api.getOperationJournalPort();
    const oldScope = oldService.begin(transcriptBegin());
    await oldScope.progress("checking-cache", {
      provider: "cache",
      contentBasis: "youtube-transcript",
    });
    expect(listener).toHaveBeenCalled();
    listener.mockClear();

    vi.spyOn(test.api.feedStorageRepository, "persistSettings")
      .mockResolvedValue(persistedResult());
    test.plugin.settings.collection.dataFolder = ".rss-dashboard-data-next";
    await test.plugin.saveSettings();
    expect((test.plugin as unknown as {
      operationJournalRuntime: { dataRoot: string };
    }).operationJournalRuntime.dataRoot).toBe(".rss-dashboard-data-next");
    listener.mockClear();
    const staleScope = oldService.begin(transcriptBegin());
    await staleScope.succeed("completed", {
      contentBasis: "youtube-transcript",
    });
    expect(listener).not.toHaveBeenCalled();

    const nextService = test.api.getOperationJournalPort();
    expect(nextService).not.toBe(oldService);
    expect(test.api.getOperationJournalUi()).toBe(ui);
    listener.mockClear();

    const nextScope = nextService.begin(transcriptBegin());
    await nextScope.progress("checking-cache", {
      provider: "cache",
      contentBasis: "youtube-transcript",
    });
    expect(listener).toHaveBeenCalled();
    await expect(test.app.vault.adapter.exists(".rss-dashboard-data"))
      .resolves.toBe(true);
    await expect(test.app.vault.adapter.exists(".rss-dashboard-data-next"))
      .resolves.toBe(true);
    unsubscribe();
  });

  it("shares strict clear single-flight and refreshes the open panel before resolving", async () => {
    const test = harness();
    const service = test.api.getOperationJournalPort();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const strictClear = vi.spyOn(service, "clearOrThrow").mockReturnValue(pending);
    const bestEffortClear = vi.spyOn(service, "clear");
    const ui = test.api.getOperationJournalUi();
    const settings = test.api.getOperationJournalSettings();
    const panelRefresh = vi.fn();
    ui.subscribe(panelRefresh);
    const open = vi.spyOn(OperationJournalClearModal.prototype, "open")
      .mockImplementation(function openClear() {
        this.onOpen();
        return this;
      });

    const settingsClear = settings.clear();
    ui.requestClear();
    const modal = open.mock.instances[0] as OperationJournalClearModal;
    const confirm = Array.from(
      modal.contentEl.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.classList.contains("mod-warning"))!;
    confirm.click();
    await Promise.resolve();

    expect(strictClear).toHaveBeenCalledTimes(1);
    expect(bestEffortClear).not.toHaveBeenCalled();
    expect(panelRefresh).not.toHaveBeenCalled();
    release();
    await settingsClear;
    await Promise.resolve();
    expect(panelRefresh).toHaveBeenCalledTimes(1);
  });

  it("opens Dashboard clear confirmation and clears only after confirmation", async () => {
    const test = harness();
    const service = test.api.getOperationJournalPort();
    const strictClear = vi.spyOn(service, "clearOrThrow")
      .mockResolvedValue(undefined);
    const open = vi.spyOn(OperationJournalClearModal.prototype, "open")
      .mockImplementation(function openClear() {
        this.onOpen();
        return this;
      });
    const ui = test.api.getOperationJournalUi();

    ui.requestClear();
    expect(open).toHaveBeenCalledTimes(1);
    expect(strictClear).not.toHaveBeenCalled();
    const cancelled = open.mock.instances[0] as OperationJournalClearModal;
    const cancel = Array.from(
      cancelled.contentEl.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => !button.classList.contains("mod-warning"))!;
    cancel.click();
    await Promise.resolve();
    expect(strictClear).not.toHaveBeenCalled();

    ui.requestClear();
    const confirmed = open.mock.instances[1] as OperationJournalClearModal;
    const confirm = Array.from(
      confirmed.contentEl.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.classList.contains("mod-warning"))!;
    confirm.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(strictClear).toHaveBeenCalledTimes(1);
  });

  it("rejects failed strict clears without a fake refresh and permits retry", async () => {
    const test = harness();
    const service = test.api.getOperationJournalPort();
    const strictClear = vi.spyOn(service, "clearOrThrow")
      .mockRejectedValueOnce(new Error("controlled clear failed"))
      .mockResolvedValueOnce(undefined);
    const panelRefresh = vi.fn();
    test.api.getOperationJournalUi().subscribe(panelRefresh);

    await expect(test.api.getOperationJournalSettings().clear()).rejects
      .toThrow("controlled clear failed");
    expect(panelRefresh).not.toHaveBeenCalled();

    await expect(test.api.getOperationJournalSettings().clear()).resolves
      .toBeUndefined();
    expect(strictClear).toHaveBeenCalledTimes(2);
    expect(panelRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate live listeners or timers when settings services rebuild", () => {
    const test = harness();
    const listener = vi.fn();
    test.api.getOperationJournalUi().subscribe(listener);
    const service = test.api.getOperationJournalPort();
    const intervalCalls = vi.spyOn(window, "setInterval");

    test.api.initializeSettingsBackedServices();
    test.api.initializeSettingsBackedServices();

    expect((service as unknown as { listeners: Set<unknown> }).listeners.size)
      .toBe(1);
    expect(intervalCalls).not.toHaveBeenCalled();
  });

  it("releases live listeners on unload without changing journal scope behavior", async () => {
    const test = harness();
    (test.plugin as unknown as { backupService: unknown }).backupService = {
      performAutoBackups: async () => undefined,
    };
    const listener = vi.fn();
    test.api.getOperationJournalUi().subscribe(listener);
    const service = test.api.getOperationJournalPort();
    const scope = service.begin(transcriptBegin());
    await scope.progress("checking-cache", {
      provider: "cache",
      contentBasis: "youtube-transcript",
    });
    listener.mockClear();

    test.plugin.onunload();
    await scope.progress("trying-provider", {
      provider: "innertube",
      contentBasis: "youtube-transcript",
    });

    expect(listener).not.toHaveBeenCalled();
    expect((test.plugin as unknown as { operationJournalRuntime: unknown })
      .operationJournalRuntime).toBeNull();
  });

  it("contains hostile listener thenables without blocking other listeners or writes", async () => {
    const test = harness();
    const hostileThenable = Object.defineProperty({}, "then", {
      get: () => { throw new Error("hostile then getter"); },
    });
    test.api.getOperationJournalUi().subscribe((() =>
      hostileThenable) as unknown as () => void);
    const healthy = vi.fn();
    test.api.getOperationJournalUi().subscribe(healthy);
    const service = test.api.getOperationJournalPort();

    const scope = service.begin(transcriptBegin());
    await scope.succeed("completed", { contentBasis: "youtube-transcript" });

    expect(healthy).toHaveBeenCalled();
    await expect(test.app.vault.adapter.exists(
      ".rss-dashboard-data/state/operation-journal",
    )).resolves.toBe(true);
  });

  it("keeps the committed root during candidate publication rollback", async () => {
    const test = harness();
    test.api.initializeSettingsBackedServices();
    const previousSettings = test.plugin.settings;
    const previousService = test.api.getOperationJournalPort();
    const ui = test.api.getOperationJournalUi();
    const listener = vi.fn();
    ui.subscribe(listener);
    vi.spyOn(test.api, "verifyImportedSettingsPersistence")
      .mockResolvedValue(undefined);
    vi.spyOn(test.api.feedStorageRepository, "persistSettingsTransaction")
      .mockImplementation(async (_previous, _candidate, _plan, afterPersist) =>
        await afterPersist());
    let candidateTranscript: ReturnType<JournalWiringApi["getYouTubeTranscriptRuntime"]>["service"] | undefined;
    vi.spyOn(test.plugin, "refreshDashboardViews")
      .mockImplementationOnce(async () => {
        candidateTranscript = test.api.getYouTubeTranscriptRuntime().service;
        test.api.getSourceRefreshLedger();
        test.api.getCollectionService();
        throw new Error("candidate-view-failed");
      })
      .mockResolvedValueOnce(undefined);

    await expect(test.api.commitSettingsCandidateUnlocked((previous) => {
      const candidate = structuredClone(previous);
      candidate.collection.dataFolder = ".candidate-journal-root";
      return candidate;
    })).rejects.toThrow("candidate-view-failed");

    expect(test.plugin.settings).toBe(previousSettings);
    expect(test.api.getOperationJournalPort()).toBe(previousService);
    await expect(candidateTranscript!.readCached({} as never)).rejects
      .toMatchObject({ code: "aborted" });
    const authority = test.plugin as unknown as {
      sourceRefreshLedger: { dataRoot: string } | null;
      collectionService: { dataRoot: string } | null;
    };
    expect(authority.sourceRefreshLedger).toBeNull();
    expect(authority.collectionService).toBeNull();
    test.api.getSourceRefreshLedger();
    test.api.getCollectionService();
    expect(authority.sourceRefreshLedger?.dataRoot).toBe(".rss-dashboard-data");
    expect(authority.collectionService?.dataRoot).toBe(".rss-dashboard-data");
    listener.mockClear();
    const scope = previousService.begin(transcriptBegin());
    await scope.succeed("completed", { contentBasis: "youtube-transcript" });
    expect(listener).toHaveBeenCalled();
    await expect(test.app.vault.adapter.exists(".candidate-journal-root"))
      .resolves.toBe(false);
  });

  it("activates a changed root only after an ordinary settings save commits", async () => {
    const test = harness();
    const previousService = test.api.getOperationJournalPort();
    vi.spyOn(test.api.feedStorageRepository, "persistSettings")
      .mockResolvedValue(persistedResult());
    test.plugin.settings.collection.dataFolder = ".saved-journal-root";

    expect(test.api.getOperationJournalPort()).toBe(previousService);
    await test.plugin.saveSettings();

    expect(test.api.getOperationJournalPort()).not.toBe(previousService);
    expect((test.plugin as unknown as {
      operationJournalRuntime: { dataRoot: string };
    }).operationJournalRuntime.dataRoot).toBe(".saved-journal-root");
  });

  it("restores all data-root authorities when an ordinary settings save rejects", async () => {
    const test = harness();
    const previousService = test.api.getOperationJournalPort();
    const pendingPersist = deferred<ReturnType<typeof persistedResult>>();
    const persist = vi.spyOn(test.api.feedStorageRepository, "persistSettings")
      .mockReturnValue(pendingPersist.promise);
    test.plugin.settings.collection.dataFolder = ".rejected-journal-root";
    const saving = test.plugin.saveSettings();
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    const rejectedTranscript = test.api.getYouTubeTranscriptRuntime().service;
    const disposeRejectedTranscript = vi.spyOn(
      rejectedTranscript as { dispose(): void },
      "dispose",
    );
    test.api.getSourceRefreshLedger();
    test.api.getCollectionService();
    pendingPersist.reject(new Error("settings-save-failed"));

    await expect(saving).rejects.toThrow("settings-save-failed");

    expect(test.plugin.settings.collection.dataFolder)
      .toBe(".rss-dashboard-data");
    expect(disposeRejectedTranscript).toHaveBeenCalledTimes(1);
    expect(test.api.getOperationJournalPort()).toBe(previousService);
    const authority = test.plugin as unknown as {
      sourceRefreshLedger: { dataRoot: string } | null;
      collectionService: { dataRoot: string } | null;
    };
    expect(authority.sourceRefreshLedger).toBeNull();
    expect(authority.collectionService).toBeNull();
    test.api.getSourceRefreshLedger();
    test.api.getCollectionService();
    expect(authority.sourceRefreshLedger?.dataRoot).toBe(".rss-dashboard-data");
    expect(authority.collectionService?.dataRoot).toBe(".rss-dashboard-data");
    expect(test.api.getSubscriptionService().dependencies.operationJournal)
      .toBe(previousService);
    const begin = vi.spyOn(previousService, "begin");
    test.api.beginRefreshJournalSafely({ trigger: "manual", action: "all" });
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it("rolls back factory reset state and leaves local storage untouched on persistence failure", async () => {
    const test = harness();
    test.plugin.settings.collection.dataFolder = ".pre-reset-journal-root";
    const previousService = test.api.getOperationJournalPort();
    test.api.initializeSettingsBackedServices();
    const previousSettings = test.plugin.settings;
    const previousFeedParser = test.plugin.feedParser;
    const refreshMarker = { status: "refreshing" };
    test.plugin.activeRefreshState.set("source-a", refreshMarker as never);
    (test.plugin as unknown as { isMultiFeedRefreshRunning: boolean })
      .isMultiFeedRefreshRunning = true;
    test.app.saveLocalStorage("rss-discover-filters", { folder: "kept" });
    test.app.saveLocalStorage("rss-podcast-progress", { seconds: 42 });
    test.app.saveLocalStorage("rss-first-launch-coachmark-shown", "true");
    let resetTranscript: ReturnType<JournalWiringApi["getYouTubeTranscriptRuntime"]>["service"] | undefined;
    vi.spyOn(test.api.feedStorageRepository, "persistSettings")
      .mockImplementation(async () => {
        resetTranscript = test.api.getYouTubeTranscriptRuntime().service;
        throw new Error("factory-reset-save-failed");
      });

    await expect(test.plugin.performFactoryReset()).rejects
      .toThrow("factory-reset-save-failed");

    expect(test.plugin.settings).toBe(previousSettings);
    expect(test.plugin.settings.collection.dataFolder)
      .toBe(".pre-reset-journal-root");
    expect(test.plugin.feedParser).toBe(previousFeedParser);
    expect(test.plugin.activeRefreshState.get("source-a"))
      .toBe(refreshMarker);
    expect((test.plugin as unknown as { isMultiFeedRefreshRunning: boolean })
      .isMultiFeedRefreshRunning).toBe(true);
    expect(test.app.loadLocalStorage("rss-discover-filters"))
      .toEqual({ folder: "kept" });
    expect(test.app.loadLocalStorage("rss-podcast-progress"))
      .toEqual({ seconds: 42 });
    expect(test.app.loadLocalStorage("rss-first-launch-coachmark-shown"))
      .toBe("true");
    await expect(resetTranscript!.readCached({} as never)).rejects
      .toMatchObject({ code: "aborted" });
    expect(test.api.getOperationJournalPort()).toBe(previousService);
    const nextTranscript = test.api.getYouTubeTranscriptRuntime();
    expect(nextTranscript.service).not.toBe(resetTranscript);
    expect((test.plugin as unknown as {
      youtubeTranscriptRuntime: { dataRoot: string };
    }).youtubeTranscriptRuntime.dataRoot).toBe(".pre-reset-journal-root");
  });

  it("uses a stable unavailable port after committed-root activation fails and retries only B", async () => {
    const test = harness();
    const serviceA = test.api.getOperationJournalPort();
    const listener = vi.fn();
    test.api.getOperationJournalUi().subscribe(listener);
    listener.mockClear();
    vi.spyOn(test.api.feedStorageRepository, "persistSettings")
      .mockResolvedValue(persistedResult());
    const realGetRuntime = test.api.getOperationJournalRuntime.bind(test.api);
    let failB = true;
    vi.spyOn(test.api, "getOperationJournalRuntime")
      .mockImplementation(() => {
        const root = (test.plugin as unknown as {
          committedOperationJournalDataRoot: string;
        }).committedOperationJournalDataRoot;
        if (root === ".failed-activation-root" && failB) {
          throw new Error("private /vault/path activation failure");
        }
        return realGetRuntime();
      });
    test.plugin.settings.collection.dataFolder = ".failed-activation-root";

    await expect(test.plugin.saveSettings()).resolves.toBeUndefined();

    expect((test.plugin as unknown as {
      committedOperationJournalDataRoot: string;
      operationJournalRuntime: unknown;
    }).committedOperationJournalDataRoot).toBe(".failed-activation-root");
    expect((test.plugin as unknown as { operationJournalRuntime: unknown })
      .operationJournalRuntime).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    listener.mockClear();
    const unavailable = test.api.getOperationJournalPort();
    expect(unavailable).not.toBe(serviceA);
    expect(test.api.getOperationJournalPort()).toBe(unavailable);
    expect(Object.isFrozen(unavailable)).toBe(true);
    const hostileInput = new Proxy({}, {
      get() { throw new Error("hostile input"); },
    });
    expect(() => unavailable.begin(hostileInput as never)).not.toThrow();
    const firstUnavailable = unavailable.begin(hostileInput as never);
    const secondUnavailable = unavailable.begin(hostileInput as never);
    expect(firstUnavailable.operationId)
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    expect(secondUnavailable.operationId)
      .not.toBe(firstUnavailable.operationId);
    const attached = unavailable.attach(
      "123e4567-e89b-42d3-a456-426614174000",
      hostileInput as never,
    );
    expect(attached.operationId)
      .toBe("123e4567-e89b-42d3-a456-426614174000");
    await expect(attached.succeed("completed", {})).resolves.toBeUndefined();
    expect(test.api.getYouTubeTranscriptRuntime().service.options.operationJournal)
      .toBe(unavailable);
    expect(test.api.getSubscriptionService().dependencies.operationJournal)
      .toBe(unavailable);
    expect(test.api.beginRefreshJournalSafely({
      trigger: "manual",
      action: "all",
    })?.operationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(listener).not.toHaveBeenCalled();
    await expect(test.app.vault.adapter.exists(".failed-activation-root"))
      .resolves.toBe(false);
    await expect(test.api.getOperationJournalUi().load(7)).rejects
      .toMatchObject({ code: "operation-journal-unavailable" });
    await expect(test.api.getOperationJournalSettings().stats()).rejects
      .toMatchObject({ code: "operation-journal-unavailable" });

    failB = false;
    const serviceB = test.api.getOperationJournalPort();
    expect(serviceB).toBeInstanceOf(OperationJournalService);
    expect(serviceB).not.toBe(serviceA);
    expect((test.plugin as unknown as {
      operationJournalRuntime: { dataRoot: string };
    }).operationJournalRuntime.dataRoot).toBe(".failed-activation-root");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reloads journal health once when repository append fails", async () => {
    const test = harness();
    const service = test.api.getOperationJournalPort();
    vi.spyOn(OperationJournalRepository.prototype, "append")
      .mockRejectedValue(new Error("append-failed"));
    const listener = vi.fn();
    test.api.getOperationJournalUi().subscribe(listener);

    const scope = service.begin(transcriptBegin());
    await scope.succeed("completed", { contentBasis: "youtube-transcript" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(service.getHealth()).toMatchObject({ writeIncomplete: true });
  });

  it("rejects a completed stale clear after the committed root changes", async () => {
    const test = harness();
    const serviceA = test.api.getOperationJournalPort();
    const pending = deferred<void>();
    vi.spyOn(serviceA, "clearOrThrow").mockReturnValue(pending.promise);
    vi.spyOn(test.api.feedStorageRepository, "persistSettings")
      .mockResolvedValue(persistedResult());
    const listener = vi.fn();
    test.api.getOperationJournalUi().subscribe(listener);

    const clearA = test.api.getOperationJournalSettings().clear();
    await Promise.resolve();
    test.plugin.settings.collection.dataFolder = ".journal-root-b";
    await test.plugin.saveSettings();
    const serviceB = test.api.getOperationJournalPort();
    const clearB = vi.spyOn(serviceB, "clearOrThrow")
      .mockResolvedValue(undefined);
    listener.mockClear();
    pending.resolve();

    await expect(clearA).rejects.toMatchObject({
      code: "operation-journal-unavailable",
    });
    expect(clearB).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    await expect(test.api.getOperationJournalSettings().clear()).resolves
      .toBeUndefined();
    expect(clearB).toHaveBeenCalledTimes(1);
  });

  it("returns only the stable C list across A to B to C root changes", async () => {
    const test = harness();
    vi.spyOn(test.api.feedStorageRepository, "persistSettings")
      .mockResolvedValue(persistedResult());
    const serviceA = test.api.getOperationJournalPort();
    const listA = deferred<ReturnType<typeof emptyList>>();
    vi.spyOn(serviceA, "list").mockReturnValue(listA.promise);

    const loading = test.api.getOperationJournalUi().load(7);
    test.plugin.settings.collection.dataFolder = ".journal-root-b";
    await test.plugin.saveSettings();
    const serviceB = test.api.getOperationJournalPort();
    const listB = deferred<ReturnType<typeof emptyList>>();
    const listBSpy = vi.spyOn(serviceB, "list").mockReturnValue(listB.promise);
    listA.resolve(emptyList());
    await vi.waitFor(() => expect(listBSpy).toHaveBeenCalledTimes(1));

    test.plugin.settings.collection.dataFolder = ".journal-root-c";
    await test.plugin.saveSettings();
    const serviceC = test.api.getOperationJournalPort();
    const resultC = emptyList();
    const listCSpy = vi.spyOn(serviceC, "list").mockResolvedValue(resultC);
    listB.resolve(emptyList());

    await expect(loading).resolves.toBe(resultC);
    expect(listCSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects with a fixed error when list roots churn beyond the bound", async () => {
    const test = harness();
    vi.spyOn(test.api.feedStorageRepository, "persistSettings")
      .mockResolvedValue(persistedResult());
    const serviceA = test.api.getOperationJournalPort();
    const listA = deferred<ReturnType<typeof emptyList>>();
    vi.spyOn(serviceA, "list").mockReturnValue(listA.promise);
    const loading = test.api.getOperationJournalUi().load(7);

    test.plugin.settings.collection.dataFolder = ".churn-b";
    await test.plugin.saveSettings();
    const serviceB = test.api.getOperationJournalPort();
    const listB = deferred<ReturnType<typeof emptyList>>();
    const listBSpy = vi.spyOn(serviceB, "list").mockReturnValue(listB.promise);
    listA.resolve(emptyList());
    await vi.waitFor(() => expect(listBSpy).toHaveBeenCalledTimes(1));

    test.plugin.settings.collection.dataFolder = ".churn-c";
    await test.plugin.saveSettings();
    const serviceC = test.api.getOperationJournalPort();
    const listC = deferred<ReturnType<typeof emptyList>>();
    const listCSpy = vi.spyOn(serviceC, "list").mockReturnValue(listC.promise);
    listB.resolve(emptyList());
    await vi.waitFor(() => expect(listCSpy).toHaveBeenCalledTimes(1));

    test.plugin.settings.collection.dataFolder = ".churn-d";
    await test.plugin.saveSettings();
    listC.resolve(emptyList());

    await expect(loading).rejects.toMatchObject({
      code: "operation-journal-unavailable",
    });
  });

  it("keeps repository and paths outside both UI facades", () => {
    const test = harness();
    expect(Object.keys(test.api.getOperationJournalUi()).sort()).toEqual([
      "exportSafe", "load", "requestClear", "subscribe",
    ]);
    expect(Object.keys(test.api.getOperationJournalSettings()).sort()).toEqual([
      "clear", "copyPreview", "createPreview", "openDashboard", "revokePreview", "stats",
    ]);
  });
});

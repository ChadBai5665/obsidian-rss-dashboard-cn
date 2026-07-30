import { describe, expect, it, vi } from "vitest";
import type { OperationEvent } from "../../../src/operation-journal/operation-event";
import type {
  OperationJournalAppendResult,
  OperationJournalReadResult,
  OperationJournalStats,
} from "../../../src/operation-journal/operation-journal-repository";
import {
  OperationJournalService,
  type OperationJournalHealth,
} from "../../../src/operation-journal/operation-journal-service";

const NOW = new Date("2026-07-30T01:02:03.000Z");
const OPERATION_ID = "10000000-0000-4000-8000-000000000001";

interface JournalStore {
  append(event: OperationEvent): Promise<OperationJournalAppendResult>;
  readRange(input: {
    days: 7 | 30;
    now: Date;
    maxEvents?: number;
  }): Promise<OperationJournalReadResult>;
  stats(now: Date): Promise<OperationJournalStats>;
  prune(now: Date): Promise<void>;
  clear(): Promise<void>;
}

function createIds(): () => string {
  let next = 1;
  return () => `10000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}

function createStore(
  append: JournalStore["append"] = async () => ({
    maintenanceIncomplete: false,
  }),
): JournalStore {
  return {
    append,
    readRange: async () => ({
      events: [],
      incompleteDates: [],
      corruptDates: [],
      truncated: false,
    }),
    stats: async () => ({ bytes: 0, days: 0, eventCount: 0 }),
    prune: async () => undefined,
    clear: async () => undefined,
  };
}

function beginTranscript(service: OperationJournalService) {
  return service.begin({
    category: "transcript",
    action: "retrieve",
    trigger: "manual",
    subject: { itemId: "item-42", label: "Local title" },
    stage: "requested",
    details: { contentBasis: "youtube-transcript" },
  });
}

async function nextMicrotask(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("OperationJournalService scopes", () => {
  it("returns a stable operation UUID immediately and preserves unawaited event order", async () => {
    const appended: OperationEvent[] = [];
    const service = new OperationJournalService(
      createStore(async (event) => {
        appended.push(event);
        return { maintenanceIncomplete: false };
      }),
      { createId: createIds(), clock: () => new Date(NOW) },
    );

    const beginInput = {
      category: "transcript" as const,
      action: "retrieve" as const,
      trigger: "manual" as const,
      subject: { itemId: "item-42", label: "Local title" },
      stage: "requested" as const,
      details: { contentBasis: "youtube-transcript" as const },
    };
    const scope = service.begin(beginInput);
    beginInput.subject.label = "Mutated title";
    const progressDetails: { provider: "innertube" | "cache" } = {
      provider: "innertube",
    };
    void scope.progress("trying-provider", progressDetails);
    progressDetails.provider = "cache";
    const terminal = scope.succeed("completed", {
      provider: "innertube",
      contentBasis: "youtube-transcript",
    });

    expect(scope.operationId).toBe(OPERATION_ID);
    expect(appended).toEqual([]);
    await terminal;

    expect(appended.map((event) => event.status)).toEqual([
      "started",
      "progress",
      "succeeded",
    ]);
    expect(appended.map((event) => event.operationId)).toEqual([
      OPERATION_ID,
      OPERATION_ID,
      OPERATION_ID,
    ]);
    expect(appended[0]?.subject.label).toBe("Local title");
    expect(appended[1]?.details).toEqual({ provider: "innertube" });
  });

  it("accepts only the first terminal call and ignores later progress", async () => {
    const appended: OperationEvent[] = [];
    const service = new OperationJournalService(
      createStore(async (event) => {
        appended.push(event);
        return { maintenanceIncomplete: false };
      }),
      { createId: createIds(), clock: () => new Date(NOW) },
    );
    const scope = beginTranscript(service);

    await Promise.all([
      scope.fail("trying-provider", "network-failure", {
        provider: "innertube",
      }),
      scope.abort("completed"),
      scope.succeed("completed", { provider: "cache" }),
      scope.progress("polling", { provider: "tikhub", pollNumber: 1 }),
    ]);

    expect(appended.map((event) => event.status)).toEqual([
      "started",
      "failed",
    ]);
    expect(appended[1]?.details).toEqual({
      provider: "innertube",
      errorCode: "network-failure",
    });
  });

  it("attaches to a validated operation without emitting a second start", async () => {
    const appended: OperationEvent[] = [];
    const service = new OperationJournalService(
      createStore(async (event) => {
        appended.push(event);
        return { maintenanceIncomplete: false };
      }),
      { createId: createIds(), clock: () => new Date(NOW) },
    );

    const scope = service.attach(OPERATION_ID, {
      category: "transcript",
      action: "retrieve",
      trigger: "system",
      subject: { itemId: "item-42" },
    });
    await scope.progress("polling", { provider: "tikhub", pollNumber: 2 });

    expect(scope.operationId).toBe(OPERATION_ID);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      operationId: OPERATION_ID,
      status: "progress",
      stage: "polling",
    });
  });

  it("does not let a slow operation block a different scope", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const persisted: string[] = [];
    let appendCount = 0;
    const service = new OperationJournalService(
      createStore(async (event) => {
        appendCount += 1;
        if (appendCount === 1) await firstBarrier;
        persisted.push(event.operationId);
        return { maintenanceIncomplete: false };
      }),
      { createId: createIds(), clock: () => new Date(NOW) },
    );

    const first = beginTranscript(service);
    const second = beginTranscript(service);
    await nextMicrotask();

    expect(persisted).toEqual([second.operationId]);
    releaseFirst?.();
    await first.progress("checking-cache", { provider: "cache" });
    expect(persisted).toContain(first.operationId);
  });
});

describe("OperationJournalService failure isolation and live events", () => {
  it("always resolves scope writes, marks failures, and notifies once per scope", async () => {
    const healthChanges: OperationJournalHealth[] = [];
    const service = new OperationJournalService(
      createStore(async () => {
        throw new Error("injected append failure");
      }),
      {
        createId: createIds(),
        clock: () => new Date(NOW),
        onHealthChange: (health) => healthChanges.push(health),
      },
    );
    const scope = beginTranscript(service);

    await expect(
      scope.progress("checking-cache", { provider: "cache" }),
    ).resolves.toBeUndefined();
    await expect(
      scope.fail("completed", "no-transcript"),
    ).resolves.toBeUndefined();

    expect(service.getHealth()).toEqual({
      writeIncomplete: true,
      maintenanceIncomplete: false,
      lastWriteFailureAt: NOW.toISOString(),
    });
    expect(Object.isFrozen(service.getHealth())).toBe(true);
    expect(healthChanges).toHaveLength(1);
  });

  it("broadcasts maintenance-incomplete events after persistence and isolates listeners", async () => {
    const order: string[] = [];
    const healthChanges: OperationJournalHealth[] = [];
    const service = new OperationJournalService(
      createStore(async () => {
        order.push("persisted");
        return { maintenanceIncomplete: true };
      }),
      {
        createId: createIds(),
        clock: () => new Date(NOW),
        onHealthChange: (health) => healthChanges.push(health),
      },
    );
    const throwingListener = vi.fn(() => {
      order.push("throwing-listener");
      throw new Error("listener failure");
    });
    const survivingListener = vi.fn(() => order.push("surviving-listener"));
    const unsubscribe = service.subscribe(throwingListener);
    service.subscribe(survivingListener);

    const scope = beginTranscript(service);
    await scope.progress("checking-cache", { provider: "cache" });
    unsubscribe();
    await scope.succeed("completed", {
      provider: "cache",
      contentBasis: "youtube-transcript",
    });

    expect(order).toEqual([
      "persisted",
      "throwing-listener",
      "surviving-listener",
      "persisted",
      "throwing-listener",
      "surviving-listener",
      "persisted",
      "surviving-listener",
    ]);
    expect(throwingListener).toHaveBeenCalledTimes(2);
    expect(survivingListener).toHaveBeenCalledTimes(3);
    expect(service.getHealth()).toEqual({
      writeIncomplete: false,
      maintenanceIncomplete: true,
      lastMaintenanceFailureAt: NOW.toISOString(),
    });
    expect(healthChanges).toHaveLength(1);
  });

  it("delegates reads and controls while projecting list metadata", async () => {
    const readRange = vi.fn(
      async (): Promise<OperationJournalReadResult> => ({
        events: [],
        incompleteDates: ["2026-07-29"],
        corruptDates: ["2026-07-28"],
        truncated: true,
      }),
    );
    const stats = vi.fn(
      async (): Promise<OperationJournalStats> => ({
        bytes: 42,
        days: 1,
        eventCount: 2,
        earliestDate: "2026-07-29",
      }),
    );
    const prune = vi.fn(async () => undefined);
    const clear = vi.fn(async () => undefined);
    const store = { ...createStore(), readRange, stats, prune, clear };
    const service = new OperationJournalService(store, {
      createId: createIds(),
      clock: () => new Date(NOW),
    });

    await expect(service.list({ days: 7, now: NOW })).resolves.toEqual({
      operations: [],
      incompleteDates: ["2026-07-29"],
      corruptDates: ["2026-07-28"],
      truncated: true,
      health: {
        writeIncomplete: false,
        maintenanceIncomplete: false,
      },
    });
    await expect(service.stats(NOW)).resolves.toEqual({
      bytes: 42,
      days: 1,
      eventCount: 2,
      earliestDate: "2026-07-29",
    });
    await expect(service.prune(NOW)).resolves.toBeUndefined();
    await expect(service.clear()).resolves.toBeUndefined();
    const exported = JSON.parse(
      await service.createSafeExport({ days: 30, now: NOW }),
    ) as Record<string, unknown>;
    expect(exported).toMatchObject({
      schemaVersion: 1,
      generatedAt: NOW.toISOString(),
      rangeDays: 30,
      operations: [],
    });
    expect(readRange).toHaveBeenNthCalledWith(1, { days: 7, now: NOW });
    expect(readRange).toHaveBeenNthCalledWith(2, { days: 30, now: NOW });
    expect(stats).toHaveBeenCalledWith(NOW);
    expect(prune).toHaveBeenCalledWith(NOW);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

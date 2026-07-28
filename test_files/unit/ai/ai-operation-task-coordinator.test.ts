import process from "node:process";
import { setImmediate } from "node:timers";

import { describe, expect, it, vi } from "vitest";

import {
  AiOperationError,
  type AiOperationResult,
  type AiOperationRunInput,
} from "../../../src/ai/ai-operation-service";
import {
  AiOperationTaskCoordinator,
  type AiOperationTaskCoordinatorDependencies,
  type AiTaskSnapshot,
  type StartAiTaskInput,
} from "../../../src/ai/ai-operation-task-coordinator";
import type { AiAnalysisArtifact } from "../../../src/ai/analysis-markdown-parser";
import {
  MAX_AI_ANALYSIS_TEXT_CHARACTERS,
} from "../../../src/ai/analysis-result";
import type { CollectedItem } from "../../../src/collection/collected-item";

const ITEM_ID = "a".repeat(64);
const OTHER_ITEM_ID = "b".repeat(64);
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const RESULT_ID = "33333333-3333-4333-8333-333333333333";
const NEXT_RESULT_ID = "44444444-4444-4444-8444-444444444444";
const CREATED_AT = "2026-07-29T01:02:03.004Z";
const NEXT_CREATED_AT = "2026-07-29T01:03:04.005Z";
const API_KEY = "coordinator-external-secret";

function item(overrides: Partial<CollectedItem> = {}): CollectedItem {
  return {
    schemaVersion: 1,
    id: ITEM_ID,
    sourceType: "rss",
    sourceId: "source-1",
    sourceName: "研究机构",
    sourceBucket: "咨询",
    title: "研究标题",
    fetchedAt: "2026-07-29T00:00:00.000Z",
    firstSeenAt: "2026-07-29T00:00:00.000Z",
    lastSeenAt: "2026-07-29T00:00:00.000Z",
    url: "https://example.com/research",
    observationType: "new",
    topics: ["AI"],
    excerpt: "来源正文",
    contentBasis: "feed",
    read: false,
    starred: false,
    saved: false,
    collectionStatus: "collected",
    ...overrides,
  };
}

function startInput(
  overrides: Partial<StartAiTaskInput> = {},
): StartAiTaskInput {
  return {
    operation: "summary",
    item: item(),
    connectionId: CONNECTION_ID,
    fetchFullText: false,
    ...overrides,
  };
}

function operationResult(
  overrides: Partial<AiOperationResult> = {},
): AiOperationResult {
  return {
    operation: "summary",
    itemId: ITEM_ID,
    connectionId: CONNECTION_ID,
    connectionName: "DeepSeek",
    providerKind: "deepseek",
    model: "deepseek-chat",
    contentBasis: "feed",
    inputCharacterCount: 4,
    inputTruncated: false,
    text: "模型结果",
    ...overrides,
  };
}

function artifact(
  overrides: Partial<AiAnalysisArtifact["record"]> = {},
): AiAnalysisArtifact {
  const operation = overrides.operation ?? "summary";
  const itemId = overrides.itemId ?? ITEM_ID;
  const createdAt = overrides.createdAt ?? CREATED_AT;
  return Object.freeze({
    path:
      `rss-dashboard-cn/analysis/${itemId}/` +
      `${pathTimestamp(createdAt)}-${operation}.md`,
    record: Object.freeze({
      schemaVersion: 1,
      id: RESULT_ID,
      itemId,
      sourceUrl: "https://example.com/research",
      operation,
      createdAt,
      connectionId: CONNECTION_ID,
      connectionName: "DeepSeek",
      providerKind: "deepseek",
      model: "deepseek-chat",
      contentBasis: "feed",
      inputCharacterCount: 4,
      inputTruncated: false,
      text: "历史结果",
      ...overrides,
    }),
  });
}

function pathTimestamp(createdAt: string): string {
  return createdAt.replace(/[-:.Z]/gu, "");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function defaultArtifactPath(
  itemId = ITEM_ID,
  operation = "summary",
  createdAt = CREATED_AT,
): string {
  return (
    `rss-dashboard-cn/analysis/${itemId}/` +
    `${pathTimestamp(createdAt)}-${operation}.md`
  );
}

function harness(options: {
  run?: (input: AiOperationRunInput) => Promise<AiOperationResult>;
  latest?: (
    itemId: string,
    operation: StartAiTaskInput["operation"],
  ) => Promise<AiAnalysisArtifact | null>;
  save?: (result: unknown) => Promise<string>;
  resultIds?: string[];
  timestamps?: string[];
} = {}) {
  const run = vi.fn(options.run ?? (async () => operationResult()));
  const latest = vi.fn(options.latest ?? (async () => null));
  const save = vi.fn(options.save ?? (async () => defaultArtifactPath()));
  const ids = [...(options.resultIds ?? [RESULT_ID])];
  const times = [...(options.timestamps ?? [CREATED_AT])];
  const dependencies: AiOperationTaskCoordinatorDependencies = {
    service: { run },
    repository: { latest, save },
    createResultId: () => ids.shift() ?? RESULT_ID,
    now: () => times.shift() ?? CREATED_AT,
  };
  const coordinator = new AiOperationTaskCoordinator(dependencies);
  return {
    coordinator,
    run,
    latest,
    save,
  };
}

function snapshotNow(
  coordinator: AiOperationTaskCoordinator,
  itemId = ITEM_ID,
  operation: StartAiTaskInput["operation"] = "summary",
): AiTaskSnapshot {
  let current: AiTaskSnapshot | undefined;
  const unsubscribe = coordinator.subscribe(
    itemId,
    operation,
    (snapshot) => {
      current = snapshot;
    },
  );
  unsubscribe();
  if (!current) throw new Error("Coordinator did not replay current state");
  return current;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(message);
}

function uniqueStatuses(snapshots: readonly AiTaskSnapshot[]): string[] {
  const result: string[] = [];
  for (const snapshot of snapshots) {
    if (result.at(-1) !== snapshot.status) result.push(snapshot.status);
  }
  return result;
}

describe("persistent AI operation task coordinator", () => {
  it("deduplicates starts into one terminal promise and completes only after one save", async () => {
    const runGate = deferred<AiOperationResult>();
    const saveGate = deferred<string>();
    let request: AiOperationRunInput | undefined;
    const test = harness({
      run: async (input) => {
        request = input;
        return await runGate.promise;
      },
      save: async () => await saveGate.promise,
    });
    const states: AiTaskSnapshot[] = [];
    test.coordinator.subscribe(ITEM_ID, "summary", (state) => {
      states.push(state);
    });

    const first = test.coordinator.start(startInput());
    const second = test.coordinator.start(startInput({
      connectionId: "22222222-2222-4222-8222-222222222222",
      fetchFullText: true,
    }));

    expect(second).toBe(first);
    expect(test.run).toHaveBeenCalledTimes(1);
    await waitFor(() => request !== undefined, "service did not start");
    request?.onTextDelta?.("模型");
    request?.onTextDelta?.("结果");
    const lateStates: AiTaskSnapshot[] = [];
    test.coordinator.subscribe(ITEM_ID, "summary", (state) => {
      lateStates.push(state);
    });
    expect(lateStates).toHaveLength(1);
    expect(lateStates[0]).toMatchObject({
      status: "generating",
      text: "模型结果",
    });

    runGate.resolve(operationResult());
    await waitFor(
      () => snapshotNow(test.coordinator).status === "saving",
      "coordinator never entered saving",
    );
    expect(test.save).toHaveBeenCalledTimes(1);
    expect(snapshotNow(test.coordinator)).toMatchObject({
      status: "saving",
      text: "模型结果",
      connectionId: CONNECTION_ID,
      connectionName: "DeepSeek",
      model: "deepseek-chat",
      contentBasis: "feed",
      createdAt: CREATED_AT,
    });

    saveGate.resolve(defaultArtifactPath());
    const completed = await first;
    await expect(second).resolves.toBe(completed);
    expect(completed).toEqual({
      key: `${ITEM_ID}:summary`,
      itemId: ITEM_ID,
      operation: "summary",
      status: "complete",
      text: "模型结果",
      connectionId: CONNECTION_ID,
      connectionName: "DeepSeek",
      model: "deepseek-chat",
      contentBasis: "feed",
      artifactPath: defaultArtifactPath(),
      createdAt: CREATED_AT,
    });
    expect(completed.key).not.toContain("\0");
    expect(Object.isFrozen(completed)).toBe(true);
    expect(states.every(Object.isFrozen)).toBe(true);
    expect(uniqueStatuses(states)).toEqual([
      "idle",
      "preparing",
      "generating",
      "saving",
      "complete",
    ]);
    expect(test.save.mock.calls[0]?.[0]).toEqual({
      schemaVersion: 1,
      id: RESULT_ID,
      itemId: ITEM_ID,
      sourceUrl: "https://example.com/research",
      operation: "summary",
      createdAt: CREATED_AT,
      connectionId: CONNECTION_ID,
      connectionName: "DeepSeek",
      providerKind: "deepseek",
      model: "deepseek-chat",
      contentBasis: "feed",
      inputCharacterCount: 4,
      inputTruncated: false,
      text: "模型结果",
    });
  });

  it("unsubscribe and article switching detach listeners without aborting work", async () => {
    const runGate = deferred<AiOperationResult>();
    let request: AiOperationRunInput | undefined;
    const test = harness({
      run: async (input) => {
        request = input;
        return await runGate.promise;
      },
    });
    const firstStates: AiTaskSnapshot[] = [];
    const unsubscribe = test.coordinator.subscribe(
      ITEM_ID,
      "summary",
      (state) => firstStates.push(state),
    );
    const pending = test.coordinator.start(startInput());
    await waitFor(() => request !== undefined, "service did not start");
    unsubscribe();
    const countAfterDetach = firstStates.length;
    const otherStates: AiTaskSnapshot[] = [];
    const unsubscribeOther = test.coordinator.subscribe(
      OTHER_ITEM_ID,
      "summary",
      (state) => otherStates.push(state),
    );

    request?.onTextDelta?.("仍在运行");
    expect(request?.signal?.aborted).toBe(false);
    expect(firstStates).toHaveLength(countAfterDetach);
    expect(otherStates.at(-1)).toMatchObject({
      itemId: OTHER_ITEM_ID,
      status: "idle",
    });

    runGate.resolve(operationResult({ text: "仍在运行" }));
    await expect(pending).resolves.toMatchObject({
      status: "complete",
      text: "仍在运行",
    });
    unsubscribeOther();
  });

  it("loads immutable legacy history without provider/save and start reuses it", async () => {
    const historical = artifact({ connectionId: undefined });
    const test = harness({ latest: async () => historical });
    const loaded = await test.coordinator.loadLatest(ITEM_ID, "summary");

    expect(loaded).toEqual({
      key: `${ITEM_ID}:summary`,
      itemId: ITEM_ID,
      operation: "summary",
      status: "complete",
      text: "历史结果",
      connectionName: "DeepSeek",
      model: "deepseek-chat",
      contentBasis: "feed",
      artifactPath: historical.path,
      createdAt: CREATED_AT,
    });
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(test.latest).toHaveBeenCalledTimes(1);
    expect(test.run).not.toHaveBeenCalled();
    expect(test.save).not.toHaveBeenCalled();

    const reused = await test.coordinator.start(startInput());
    expect(reused).toBe(loaded);
    expect(test.run).not.toHaveBeenCalled();
    expect(test.save).not.toHaveBeenCalled();
  });

  it("regenerate replaces completed history with a distinct durable result", async () => {
    const historical = artifact();
    const test = harness({
      latest: async () => historical,
      save: async () => defaultArtifactPath(
        ITEM_ID,
        "summary",
        NEXT_CREATED_AT,
      ),
      resultIds: [NEXT_RESULT_ID],
      timestamps: [NEXT_CREATED_AT],
    });
    await test.coordinator.loadLatest(ITEM_ID, "summary");

    const regenerated = await test.coordinator.regenerate(startInput());

    expect(regenerated).toMatchObject({
      status: "complete",
      artifactPath: defaultArtifactPath(
        ITEM_ID,
        "summary",
        NEXT_CREATED_AT,
      ),
      createdAt: NEXT_CREATED_AT,
    });
    expect(regenerated.artifactPath).not.toBe(historical.path);
    expect(test.run).toHaveBeenCalledTimes(1);
    expect(test.save).toHaveBeenCalledTimes(1);
    expect(test.save.mock.calls[0]?.[0]).toMatchObject({
      id: NEXT_RESULT_ID,
      createdAt: NEXT_CREATED_AT,
    });
  });

  it("explicit start replaces failed and aborted entries but never a complete entry", async () => {
    let attempt = 0;
    const test = harness({
      run: async () => {
        attempt += 1;
        if (attempt === 1) throw new AiOperationError("rate-limited");
        return operationResult();
      },
      resultIds: [RESULT_ID],
      timestamps: [CREATED_AT],
    });

    const failed = await test.coordinator.start(startInput());
    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "rate-limited",
    });
    expect(test.save).not.toHaveBeenCalled();

    const completed = await test.coordinator.start(startInput());
    expect(completed.status).toBe("complete");
    expect(test.run).toHaveBeenCalledTimes(2);
    expect(test.save).toHaveBeenCalledTimes(1);

    const reused = await test.coordinator.start(startInput());
    expect(reused).toBe(completed);
    expect(test.run).toHaveBeenCalledTimes(2);
  });

  it("abort fires once, resolves aborted, and makes retained callbacks inert", async () => {
    const runGate = deferred<AiOperationResult>();
    let request: AiOperationRunInput | undefined;
    let abortEvents = 0;
    const test = harness({
      run: async (input) => {
        request = input;
        input.signal?.addEventListener("abort", () => {
          abortEvents += 1;
        });
        return await runGate.promise;
      },
    });
    const states: AiTaskSnapshot[] = [];
    test.coordinator.subscribe(ITEM_ID, "summary", (state) => {
      states.push(state);
    });
    const pending = test.coordinator.start(startInput());
    await waitFor(() => request !== undefined, "service did not start");

    test.coordinator.abort(ITEM_ID, "summary");
    test.coordinator.abort(ITEM_ID, "summary");
    const aborted = await pending;

    expect(abortEvents).toBe(1);
    expect(aborted).toMatchObject({
      status: "aborted",
      errorCode: "aborted",
    });
    expect(test.save).not.toHaveBeenCalled();
    const stateCount = states.length;
    request?.onTextDelta?.(`${API_KEY} late`);
    runGate.resolve(operationResult({ text: `${API_KEY} late` }));
    await flush();
    expect(states).toHaveLength(stateCount);
    expect(snapshotNow(test.coordinator)).toBe(aborted);
    expect(JSON.stringify(aborted)).not.toContain(API_KEY);
  });

  it("lets a saving-state listener abort before persistence begins", async () => {
    const test = harness();
    test.coordinator.subscribe(ITEM_ID, "summary", (state) => {
      if (state.status === "saving") {
        test.coordinator.abort(ITEM_ID, "summary");
      }
    });

    const aborted = await test.coordinator.start(startInput());

    expect(aborted).toMatchObject({
      status: "aborted",
      errorCode: "aborted",
      text: "模型结果",
    });
    expect(test.save).not.toHaveBeenCalled();
  });

  it("settles an irreversible save instead of publishing a false abort", async () => {
    const saveGate = deferred<string>();
    let abortEvents = 0;
    const test = harness({
      run: async (input) => {
        input.signal?.addEventListener("abort", () => {
          abortEvents += 1;
        });
        return operationResult();
      },
      save: async () => await saveGate.promise,
    });
    const pending = test.coordinator.start(startInput());
    await waitFor(
      () => test.save.mock.calls.length === 1,
      "repository save did not start",
    );

    test.coordinator.abort(ITEM_ID, "summary");
    test.coordinator.abort(ITEM_ID, "summary");
    await flush();

    expect(abortEvents).toBe(0);
    expect(snapshotNow(test.coordinator).status).toBe("saving");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    saveGate.resolve(defaultArtifactPath());
    await expect(pending).resolves.toMatchObject({
      status: "complete",
      artifactPath: defaultArtifactPath(),
    });
  });

  it("deduplicates concurrent regenerate calls behind an irreversible save", async () => {
    const firstSave = deferred<string>();
    let saveCount = 0;
    const test = harness({
      run: async (input) => operationResult({
        connectionId: input.connectionId,
      }),
      save: async () => {
        saveCount += 1;
        return saveCount === 1
          ? await firstSave.promise
          : defaultArtifactPath(ITEM_ID, "summary", NEXT_CREATED_AT);
      },
      resultIds: [RESULT_ID, NEXT_RESULT_ID],
      timestamps: [CREATED_AT, NEXT_CREATED_AT],
    });
    const states: AiTaskSnapshot[] = [];
    test.coordinator.subscribe(ITEM_ID, "summary", (state) => {
      states.push(state);
    });
    const first = test.coordinator.start(startInput());
    await waitFor(() => saveCount === 1, "first repository save did not start");

    const regenerated = test.coordinator.regenerate(startInput());
    const duplicate = test.coordinator.regenerate(startInput({
      connectionId: "22222222-2222-4222-8222-222222222222",
      fetchFullText: true,
    }));
    const third = test.coordinator.regenerate(startInput({
      connectionId: "55555555-5555-4555-8555-555555555555",
    }));
    expect(duplicate).toBe(regenerated);
    expect(third).toBe(regenerated);
    await flush();
    expect(test.run).toHaveBeenCalledTimes(1);

    firstSave.resolve(defaultArtifactPath());
    await expect(first).resolves.toMatchObject({
      status: "complete",
      createdAt: CREATED_AT,
    });
    await expect(regenerated).resolves.toMatchObject({
      status: "complete",
      createdAt: NEXT_CREATED_AT,
      artifactPath: defaultArtifactPath(
        ITEM_ID,
        "summary",
        NEXT_CREATED_AT,
      ),
    });
    await expect(duplicate).resolves.toBe(await regenerated);
    await expect(third).resolves.toBe(await regenerated);
    expect(test.run).toHaveBeenCalledTimes(2);
    expect(test.save).toHaveBeenCalledTimes(2);
    expect(test.run.mock.calls[1]?.[0]).toMatchObject({
      connectionId: CONNECTION_ID,
      fetchFullText: false,
    });
    expect(test.save.mock.calls[1]?.[0]).toMatchObject({
      id: NEXT_RESULT_ID,
      connectionId: CONNECTION_ID,
      createdAt: NEXT_CREATED_AT,
    });
    expect(uniqueStatuses(states)).toEqual([
      "idle",
      "preparing",
      "generating",
      "saving",
      "complete",
      "preparing",
      "generating",
      "saving",
      "complete",
    ]);
  });

  it("cancels queued regenerate on shutdown without a provider or unhandled rejection", async () => {
    const firstSave = deferred<string>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const test = harness({
        save: async () => await firstSave.promise,
      });
      const first = test.coordinator.start(startInput());
      await waitFor(
        () => test.save.mock.calls.length === 1,
        "repository save did not start",
      );
      const queued = test.coordinator.regenerate(startInput());
      const duplicate = test.coordinator.regenerate(startInput({
        connectionId: "22222222-2222-4222-8222-222222222222",
      }));
      expect(duplicate).toBe(queued);
      let queuedSettled = false;
      void queued.then(
        () => {
          queuedSettled = true;
        },
        () => {
          queuedSettled = true;
        },
      );

      const shutdown = test.coordinator.shutdown();
      await flush();
      expect(test.run).toHaveBeenCalledTimes(1);

      firstSave.resolve(defaultArtifactPath());
      await expect(first).resolves.toMatchObject({ status: "complete" });
      await shutdown;
      expect(queuedSettled).toBe(true);
      await expect(queued).resolves.toMatchObject({
        status: "aborted",
        errorCode: "aborted",
        connectionId: CONNECTION_ID,
      });
      await flush();

      expect(test.run).toHaveBeenCalledTimes(1);
      expect(test.save).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("shutdown aborts all active tasks and waits for their safe settlement", async () => {
    const gates = [
      deferred<AiOperationResult>(),
      deferred<AiOperationResult>(),
    ];
    const requests: AiOperationRunInput[] = [];
    const abortCounts = [0, 0];
    const test = harness({
      run: async (input) => {
        const index = requests.length;
        requests.push(input);
        input.signal?.addEventListener("abort", () => {
          abortCounts[index] += 1;
        });
        return await gates[index].promise;
      },
    });
    const first = test.coordinator.start(startInput());
    const second = test.coordinator.start(startInput({
      operation: "core-points",
      item: item({ id: OTHER_ITEM_ID }),
    }));
    await waitFor(() => requests.length === 2, "services did not start");

    let shutdownSettled = false;
    const shutdown = test.coordinator.shutdown().then(() => {
      shutdownSettled = true;
    });
    await flush();
    expect(abortCounts).toEqual([1, 1]);
    expect(shutdownSettled).toBe(false);
    await expect(first).resolves.toMatchObject({ status: "aborted" });
    await expect(second).resolves.toMatchObject({ status: "aborted" });

    gates[0].reject(new AiOperationError("aborted"));
    gates[1].reject(new AiOperationError("aborted"));
    await shutdown;
    expect(shutdownSettled).toBe(true);
    await expect(test.coordinator.start(startInput())).rejects.toMatchObject({
      code: "invalid-request",
    });
  });

  it("save failure retains generated text without an artifact path or raw error", async () => {
    const test = harness({
      run: async (input) => {
        input.onTextDelta?.("模型结果");
        return operationResult();
      },
      save: async () => {
        throw new Error(`${API_KEY} raw-save-error`);
      },
    });

    const failed = await test.coordinator.start(startInput());

    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "provider-failure",
      text: "模型结果",
    });
    expect(failed).not.toHaveProperty("artifactPath");
    expect(JSON.stringify(failed)).not.toContain(API_KEY);
    expect(JSON.stringify(failed)).not.toContain("raw-save-error");
    expect(test.save).toHaveBeenCalledTimes(1);
  });

  it("provider failure keeps bounded partial text but never saves or leaks causes", async () => {
    const test = harness({
      run: async (input) => {
        input.onTextDelta?.("部分结果");
        throw new Error(`${API_KEY} raw-provider-error`);
      },
    });

    const failed = await test.coordinator.start(startInput());

    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "provider-failure",
      text: "部分结果",
    });
    expect(test.save).not.toHaveBeenCalled();
    expect(JSON.stringify(failed)).not.toContain(API_KEY);
    expect(JSON.stringify(failed)).not.toContain("raw-provider-error");
  });

  it.each([
    ["operation", { operation: "core-points" }],
    ["item", { itemId: OTHER_ITEM_ID }],
    [
      "connection",
      { connectionId: "22222222-2222-4222-8222-222222222222" },
    ],
  ] as const)("rejects service %s provenance mismatch before persistence", async (
    _label,
    overrides,
  ) => {
    const test = harness({
      run: async () => operationResult(overrides),
    });

    const failed = await test.coordinator.start(startInput());

    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "invalid-request",
    });
    expect(test.save).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid UUID", () => API_KEY, () => CREATED_AT],
    ["invalid clock", () => RESULT_ID, () => "2026-07-29"],
    [
      "throwing UUID source",
      () => {
        throw new Error(`${API_KEY} raw-uuid-error`);
      },
      () => CREATED_AT,
    ],
  ] as const)("rejects %s before save with a static safe state", async (
    _label,
    createResultId,
    now,
  ) => {
    const run = vi.fn(async () => operationResult());
    const latest = vi.fn(async () => null);
    const save = vi.fn(async () => defaultArtifactPath());
    const coordinator = new AiOperationTaskCoordinator({
      service: { run },
      repository: { latest, save },
      createResultId,
      now,
    });

    const failed = await coordinator.start(startInput());

    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "invalid-request",
    });
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(failed)).not.toContain(API_KEY);
  });

  it("rejects oversized replay text, aborts the run, and ignores later output", async () => {
    let request: AiOperationRunInput | undefined;
    const oversized = "x".repeat(MAX_AI_ANALYSIS_TEXT_CHARACTERS + 1);
    const test = harness({
      run: async (input) => {
        request = input;
        input.onTextDelta?.(oversized);
        input.onTextDelta?.(`${API_KEY} late`);
        return operationResult({ text: oversized });
      },
    });

    const failed = await test.coordinator.start(startInput());

    expect(request?.signal?.aborted).toBe(true);
    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "invalid-request",
      text: "",
    });
    expect(JSON.stringify(failed).length).toBeLessThan(10_000);
    expect(JSON.stringify(failed)).not.toContain(API_KEY);
    expect(test.save).not.toHaveBeenCalled();
  });

  it("snapshots trusted item identity and URL before caller mutation", async () => {
    const runGate = deferred<AiOperationResult>();
    let serviceInput: AiOperationRunInput | undefined;
    const original = item();
    const test = harness({
      run: async (input) => {
        serviceInput = input;
        return await runGate.promise;
      },
    });
    const pending = test.coordinator.start(startInput({ item: original }));
    original.id = OTHER_ITEM_ID;
    original.url = `https://example.com/${API_KEY}`;
    original.title = `${API_KEY} mutated`;
    await waitFor(() => serviceInput !== undefined, "service did not start");

    expect(serviceInput?.item).toMatchObject({
      id: ITEM_ID,
      url: "https://example.com/research",
      title: "研究标题",
    });
    expect(Object.isFrozen(serviceInput?.item)).toBe(true);
    runGate.resolve(operationResult());
    await pending;

    expect(test.save.mock.calls[0]?.[0]).toMatchObject({
      itemId: ITEM_ID,
      sourceUrl: "https://example.com/research",
    });
    expect(JSON.stringify(test.save.mock.calls[0]?.[0])).not.toContain(API_KEY);
  });

  it("rejects hostile public inputs before allocation, listener, or history access", async () => {
    const test = harness();
    const inherited = Object.create(startInput()) as StartAiTaskInput;
    const getterInput = {} as StartAiTaskInput;
    let getterCalls = 0;
    Object.defineProperty(getterInput, "operation", {
      get() {
        getterCalls += 1;
        return "summary";
      },
    });

    await expect(test.coordinator.start(inherited)).rejects.toMatchObject({
      code: "invalid-request",
    });
    await expect(test.coordinator.start(getterInput)).rejects.toMatchObject({
      code: "invalid-request",
    });
    await expect(
      test.coordinator.loadLatest(ITEM_ID, "invalid" as "summary"),
    ).rejects.toMatchObject({ code: "invalid-operation" });
    expect(() => test.coordinator.subscribe(
      ITEM_ID,
      "summary",
      {} as (snapshot: AiTaskSnapshot) => void,
    )).toThrow();
    expect(() => test.coordinator.abort(
      ITEM_ID,
      "invalid" as "summary",
    )).toThrow();
    expect(getterCalls).toBe(0);
    expect(test.run).not.toHaveBeenCalled();
    expect(test.latest).not.toHaveBeenCalled();
    expect(test.save).not.toHaveBeenCalled();
  });

  it("isolates throwing and rejected listeners without blocking safe listeners", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const thenCalls = vi.fn();
    const safeStates: AiTaskSnapshot[] = [];
    const test = harness();
    try {
      test.coordinator.subscribe(ITEM_ID, "summary", () => {
        throw new Error(`${API_KEY} sync-listener`);
      });
      test.coordinator.subscribe(ITEM_ID, "summary", (() =>
        Promise.reject(new Error(`${API_KEY} promise-listener`))) as (
          snapshot: AiTaskSnapshot,
        ) => void);
      test.coordinator.subscribe(ITEM_ID, "summary", (() => ({
        then(_resolve: unknown, reject: (error: unknown) => void) {
          thenCalls();
          reject(new Error(`${API_KEY} thenable-listener`));
        },
      })) as (snapshot: AiTaskSnapshot) => void);
      test.coordinator.subscribe(ITEM_ID, "summary", (() => {
        const value = {};
        Object.defineProperty(value, "then", {
          get() {
            throw new Error(`${API_KEY} then-getter`);
          },
        });
        return value;
      }) as (snapshot: AiTaskSnapshot) => void);
      test.coordinator.subscribe(ITEM_ID, "summary", (() =>
        new Promise(() => undefined)) as (snapshot: AiTaskSnapshot) => void);
      test.coordinator.subscribe(ITEM_ID, "summary", (state) => {
        safeStates.push(state);
      });

      const completed = await test.coordinator.start(startInput());
      await flush();

      expect(completed.status).toBe("complete");
      expect(safeStates.at(-1)).toBe(completed);
      expect(thenCalls).toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("fails closed on oversized or accessor-backed history without provider/save", async () => {
    const oversized = artifact({
      text: "h".repeat(MAX_AI_ANALYSIS_TEXT_CHARACTERS + 1),
    });
    const test = harness({ latest: async () => oversized });

    const failed = await test.coordinator.loadLatest(ITEM_ID, "summary");

    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "invalid-request",
      text: "",
    });
    expect(test.run).not.toHaveBeenCalled();
    expect(test.save).not.toHaveBeenCalled();
  });

  it("makes old callbacks and completion inert when regenerate replaces an active task", async () => {
    const firstGate = deferred<AiOperationResult>();
    const secondGate = deferred<AiOperationResult>();
    const requests: AiOperationRunInput[] = [];
    const test = harness({
      run: async (input) => {
        const index = requests.length;
        requests.push(input);
        return await (index === 0 ? firstGate.promise : secondGate.promise);
      },
      resultIds: [NEXT_RESULT_ID],
      timestamps: [NEXT_CREATED_AT],
      save: async () => defaultArtifactPath(
        ITEM_ID,
        "summary",
        NEXT_CREATED_AT,
      ),
    });
    const first = test.coordinator.start(startInput());
    await waitFor(() => requests.length === 1, "first service did not start");
    const regenerated = test.coordinator.regenerate(startInput());
    await waitFor(() => requests.length === 2, "replacement did not start");
    expect(requests[0]?.signal?.aborted).toBe(true);

    requests[0]?.onTextDelta?.(`${API_KEY} old`);
    firstGate.resolve(operationResult({ text: `${API_KEY} old` }));
    requests[1]?.onTextDelta?.("新结果");
    secondGate.resolve(operationResult({ text: "新结果" }));

    await expect(first).resolves.toMatchObject({ status: "aborted" });
    const completed = await regenerated;
    expect(completed).toMatchObject({
      status: "complete",
      text: "新结果",
      createdAt: NEXT_CREATED_AT,
    });
    expect(JSON.stringify(completed)).not.toContain(API_KEY);
    expect(test.save).toHaveBeenCalledTimes(1);
  });
});

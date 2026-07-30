import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";
import {
  OperationJournalPanel,
  type OperationJournalPanelOptions,
} from "../../../src/components/operation-journal-panel";
import type { OperationJournalListResult } from "../../../src/operation-journal/operation-journal-service";
import type { OperationEvent } from "../../../src/operation-journal/operation-event";
import type { OperationSummary } from "../../../src/operation-journal/operation-summary";

const IDS = {
  transcript: "00000000-0000-4000-8000-000000000001",
  ai: "00000000-0000-4000-8000-000000000002",
  refresh: "00000000-0000-4000-8000-000000000003",
  subscription: "00000000-0000-4000-8000-000000000004",
  interrupted: "00000000-0000-4000-8000-000000000005",
};

const LABELS: Record<string, string> = {
  [IDS.transcript]: "演讲字幕",
  [IDS.ai]: "行业观察",
  [IDS.refresh]: "全部来源",
  [IDS.subscription]: "视频频道",
  [IDS.interrupted]: "行业文件夹",
};
const FIXTURE_BASE_TIME = Date.now() + 60_000;
const EVENT_TIMES = Array.from({ length: 8 }, (_, index) =>
  new Date(FIXTURE_BASE_TIME + index * 60_000).toISOString(),
);

function event(
  operationId: string,
  index: number,
  input: Pick<
    OperationEvent,
    "category" | "action" | "trigger" | "stage" | "status" | "details"
  >,
): OperationEvent {
  return {
    schemaVersion: 1,
    eventId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    operationId,
    occurredAt: EVENT_TIMES[index],
    subject: { label: LABELS[operationId] ?? `记录 ${index}` },
    ...input,
  };
}

function summary(input: {
  operationId: string;
  category: OperationSummary["category"];
  action: OperationSummary["action"];
  trigger?: OperationSummary["trigger"];
  status: OperationSummary["status"];
  startedAt: string;
  events: readonly OperationEvent[];
  label: string;
}): OperationSummary {
  const last = input.events[input.events.length - 1] ?? input.events[0];
  return {
    operationId: input.operationId,
    category: input.category,
    action: input.action,
    trigger: input.trigger ?? "manual",
    subject: { label: input.label },
    events: input.events,
    startedAt: input.startedAt,
    lastOccurredAt: last?.occurredAt ?? input.startedAt,
    ...(input.status === "succeeded" || input.status === "failed"
      ? { finishedAt: last?.occurredAt ?? input.startedAt }
      : {}),
    status: input.status,
    durationMs: 3_000,
    confirmedPaidRequests: input.events.reduce<0 | 1 | 2>((paid, item) => {
      const value =
        "confirmedPaidRequests" in item.details
          ? item.details.confirmedPaidRequests
          : undefined;
      return value !== undefined && value > paid ? value : paid;
    }, 0),
    possiblySent: input.events.some(
      (item) =>
        "possiblySent" in item.details && item.details.possiblySent === true,
    ),
  };
}

function fixture(): OperationJournalListResult {
  const transcriptEvents = [
    event(IDS.transcript, 1, {
      category: "transcript",
      action: "retrieve",
      trigger: "manual",
      stage: "requested",
      status: "started",
      details: { confirmedPaidRequests: 0, possiblySent: false },
    }),
    event(IDS.transcript, 3, {
      category: "transcript",
      action: "retrieve",
      trigger: "manual",
      stage: "job-received",
      status: "progress",
      details: {
        provider: "tikhub",
        confirmedPaidRequests: 1,
        possiblySent: true,
        jobId: "provider-job-4829",
      },
    }),
  ];
  const aiEvents = [
    event(IDS.ai, 2, {
      category: "ai",
      action: "summary",
      trigger: "manual",
      stage: "generating",
      status: "progress",
      details: {
        connectionName: "工作连接",
        providerKind: "minimax-cn",
        model: "MiniMax-M2.5",
      },
    }),
    event(IDS.ai, 4, {
      category: "ai",
      action: "summary",
      trigger: "manual",
      stage: "completed",
      status: "succeeded",
      details: { artifactPath: "analysis/item.md", elapsedMs: 3_000 },
    }),
  ];
  const refreshEvents = [
    event(IDS.refresh, 5, {
      category: "refresh",
      action: "all",
      trigger: "startup",
      stage: "completed",
      status: "succeeded",
      details: {
        total: 8,
        succeeded: 6,
        failed: 2,
        newItems: 14,
        elapsedMs: 6_500,
      },
    }),
  ];
  const subscriptionEvents = [
    event(IDS.subscription, 6, {
      category: "subscription",
      action: "remove",
      trigger: "manual",
      stage: "completed",
      status: "failed",
      details: { sourceKind: "youtube", preserveHistory: true },
    }),
  ];
  const interruptedEvents = [
    {
      ...event(IDS.interrupted, 7, {
        category: "refresh",
        action: "folder",
        trigger: "schedule",
        stage: "refreshing",
        status: "progress",
        details: { total: 3, succeeded: 1, failed: 0, newItems: 2 },
      }),
      occurredAt: "2000-01-01T00:00:00.000Z",
    },
  ];

  const operations = [
    summary({
      operationId: IDS.transcript,
      category: "transcript",
      action: "retrieve",
      status: "progress",
      startedAt: "2026-07-30T01:00:00.000Z",
      events: transcriptEvents,
      label: "演讲字幕",
    }),
    summary({
      operationId: IDS.ai,
      category: "ai",
      action: "summary",
      status: "succeeded",
      startedAt: "2026-07-30T02:00:00.000Z",
      events: aiEvents,
      label: "行业观察",
    }),
    summary({
      operationId: IDS.refresh,
      category: "refresh",
      action: "all",
      trigger: "startup",
      status: "succeeded",
      startedAt: "2026-07-30T05:00:00.000Z",
      events: refreshEvents,
      label: "全部来源",
    }),
    summary({
      operationId: IDS.subscription,
      category: "subscription",
      action: "remove",
      status: "failed",
      startedAt: "2026-07-30T06:00:00.000Z",
      events: subscriptionEvents,
      label: "视频频道",
    }),
    summary({
      operationId: IDS.interrupted,
      category: "refresh",
      action: "folder",
      trigger: "schedule",
      status: "interrupted",
      startedAt: "2026-07-30T07:00:00.000Z",
      events: interruptedEvents,
      label: "行业文件夹",
    }),
  ];

  return {
    operations: [operations[1], operations[0], ...operations, operations[0]],
    incompleteDates: ["2026-07-30"],
    corruptDates: ["2026-07-29"],
    truncated: true,
    health: {
      writeIncomplete: true,
      maintenanceIncomplete: true,
      lastWriteFailureAt: "2026-07-30T08:00:00.000Z",
    },
  };
}

function createHarness(overrides: Partial<OperationJournalPanelOptions> = {}): {
  root: HTMLElement;
  panel: OperationJournalPanel;
  options: OperationJournalPanelOptions;
  notify: () => void;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let listener = () => {};
  const unsubscribe = vi.fn();
  const options: OperationJournalPanelOptions = {
    locale: "zh-CN",
    load: vi.fn(async () => fixture()),
    subscribe: vi.fn((next) => {
      listener = next;
      return unsubscribe;
    }),
    exportSafe: vi.fn(async () => {}),
    requestClear: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  const root = document.body.createDiv();
  const panel = new OperationJournalPanel(root, options);
  return { root, panel, options, notify: () => listener(), unsubscribe };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function rejectingPromiseProbe(): {
  readonly promise: Promise<void>;
  handled(): boolean;
} {
  let handled = false;
  const promise = Promise.resolve();
  void Object.defineProperty(promise, "then", {
    configurable: true,
    value: (
      _resolve: (value: unknown) => void,
      reject: (reason: unknown) => void,
    ) => {
      handled = true;
      queueMicrotask(() => reject(new Error("asynchronous boundary failure")));
    },
  });
  return { promise, handled: () => handled };
}

describe("OperationJournalPanel", () => {
  beforeEach(() => {
    installObsidianDomPolyfills();
    vi.useRealTimers();
    document.body.empty();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads seven days, de-duplicates operations, and orders cards by start time", async () => {
    const { panel, root, options } = createHarness();
    panel.open();
    await settle();

    expect(options.load).toHaveBeenCalledWith(7);
    const cards = [
      ...root.querySelectorAll<HTMLElement>(".rss-operation-journal-card"),
    ];
    expect(cards).toHaveLength(5);
    expect(cards.map((card) => card.dataset.operationId)).toEqual([
      IDS.subscription,
      IDS.refresh,
      IDS.ai,
      IDS.transcript,
      IDS.interrupted,
    ]);
  });

  it("expands one ordered timeline and never renders a transcript job ID or AI artifact path", async () => {
    const { panel, root } = createHarness();
    panel.open();
    await settle();

    const transcript = root.querySelector<HTMLElement>(
      `[data-operation-id="${IDS.transcript}"]`,
    );
    expect(transcript?.textContent).toContain("已确认付费请求：1");
    expect(transcript?.textContent).toContain("请求可能已发送：是");
    expect(transcript?.textContent).toContain("任务 ID：已收到");
    expect(root.textContent).not.toContain("provider-job-4829");
    expect(root.textContent).not.toContain("analysis/item.md");

    transcript
      ?.querySelector<HTMLButtonElement>(".rss-operation-journal-expand")
      ?.click();
    const expand = transcript?.querySelector<HTMLButtonElement>(
      ".rss-operation-journal-expand",
    );
    const timeline = transcript?.querySelector<HTMLOListElement>(
      ".rss-operation-journal-timeline",
    );
    expect(timeline?.id).toBe(`rss-operation-timeline-${IDS.transcript}`);
    expect(expand?.getAttribute("aria-controls")).toBe(timeline?.id);
    expect(
      [
        ...(transcript?.querySelectorAll<HTMLElement>(
          ".rss-operation-journal-timeline-item",
        ) ?? []),
      ].map((item) => item.dataset.occurredAt),
    ).toEqual([EVENT_TIMES[1], EVENT_TIMES[3]]);
  });

  it("renders category facts and visibly distinct operation states", async () => {
    const { panel, root } = createHarness();
    panel.open();
    await settle();

    expect(root.textContent).toContain("工作连接");
    expect(root.textContent).toContain("MiniMax-M2.5");
    expect(root.textContent).toContain("保存结果：已保存");
    expect(root.textContent).toContain("触发方式：启动时");
    expect(root.textContent).toContain("总计：8");
    expect(root.textContent).toContain("成功：6");
    expect(root.textContent).toContain("失败：2");
    expect(root.textContent).toContain("新增：14");
    expect(root.textContent).toContain("耗时：6.5 秒");
    expect(root.textContent).toContain("操作：删除订阅");
    expect(root.textContent).toContain("来源类型：YouTube");
    expect(root.textContent).toContain("保留采集历史：是");
    expect(root.querySelector(".is-ongoing")?.textContent).toContain("进行中");
    expect(root.querySelector(".is-succeeded")?.textContent).toContain("成功");
    expect(root.querySelector(".is-failed")?.textContent).toContain("失败");
    expect(root.querySelector(".is-interrupted")?.textContent).toContain(
      "可能中断",
    );
  });

  it("filters by category, status, and 30-day range", async () => {
    const { panel, root, options } = createHarness();
    panel.open();
    await settle();

    const category = root.querySelector<HTMLSelectElement>(
      ".rss-operation-journal-category-filter",
    );
    category!.value = "ai";
    category!.dispatchEvent(new Event("change"));
    expect(root.querySelectorAll(".rss-operation-journal-card")).toHaveLength(
      1,
    );

    category!.value = "all";
    category!.dispatchEvent(new Event("change"));
    const status = root.querySelector<HTMLSelectElement>(
      ".rss-operation-journal-status-filter",
    );
    status!.value = "interrupted";
    status!.dispatchEvent(new Event("change"));
    expect(root.querySelectorAll(".rss-operation-journal-card")).toHaveLength(
      1,
    );
    expect(
      root
        .querySelector(".rss-operation-journal-card")
        ?.getAttribute("data-operation-id"),
    ).toBe(IDS.interrupted);

    root.querySelector<HTMLButtonElement>("[data-days='30']")?.click();
    await settle();
    expect(options.load).toHaveBeenLastCalledWith(30);
  });

  it("keeps valid records visible beside incomplete, corrupt, truncated, and write-health warnings", async () => {
    const { panel, root } = createHarness();
    panel.open();
    await settle();

    expect(
      root.querySelectorAll(".rss-operation-journal-warning"),
    ).toHaveLength(5);
    expect(root.querySelectorAll(".rss-operation-journal-card")).toHaveLength(
      5,
    );
    expect(root.textContent).toContain("部分日期的记录不完整");
    expect(root.textContent).toContain("部分记录已损坏");
    expect(root.textContent).toContain("记录较多，仅显示安全范围内的结果");
    expect(root.textContent).toContain("最近一次记录写入失败");
    expect(root.textContent).toContain("最近一次记录维护未完成");
  });

  it("isolates synchronous and asynchronous UI port failures", async () => {
    const subscribe = vi
      .fn<OperationJournalPanelOptions["subscribe"]>()
      .mockImplementationOnce(() => {
        throw new Error("subscribe failed");
      })
      .mockReturnValue(() => {
        throw new Error("unsubscribe failed");
      });
    const exportSafe = vi.fn(async () => {
      throw new Error("export failed");
    });
    const requestClear = vi.fn(() => {
      throw new Error("clear failed");
    });
    const onClose = vi.fn(() => {
      throw new Error("close failed");
    });
    const { panel, root } = createHarness({
      subscribe,
      exportSafe,
      requestClear,
      onClose,
    });

    expect(() => panel.open()).not.toThrow();
    await settle();
    expect(root.querySelectorAll(".rss-operation-journal-card")).toHaveLength(
      5,
    );
    expect(() => panel.open()).not.toThrow();
    expect(subscribe).toHaveBeenCalledTimes(2);

    expect(() =>
      root
        .querySelector<HTMLButtonElement>(".rss-operation-journal-action")
        ?.click(),
    ).not.toThrow();
    await settle();
    expect(exportSafe).toHaveBeenCalledWith(7);
    expect(() =>
      root
        .querySelector<HTMLButtonElement>(".rss-operation-journal-clear")
        ?.click(),
    ).not.toThrow();
    expect(() =>
      root
        .querySelector<HTMLButtonElement>(".rss-operation-journal-close")
        ?.click(),
    ).not.toThrow();
    expect(() => panel.dispose()).not.toThrow();
    expect(root.querySelector(".rss-operation-journal")).toBeNull();
  });

  it("consumes rejecting promise-like clear, close, and unsubscribe results without delaying disposal", async () => {
    const clearProbe = rejectingPromiseProbe();
    const closeProbe = rejectingPromiseProbe();
    const unsubscribeProbe = rejectingPromiseProbe();
    const unsubscribe =
      (() => unsubscribeProbe.promise) as unknown as () => void;
    const requestClearPromise = () => clearProbe.promise;
    const requestClear =
      requestClearPromise as unknown as OperationJournalPanelOptions["requestClear"];
    let panel!: OperationJournalPanel;
    const harness = createHarness({
      subscribe: () => unsubscribe,
      requestClear,
      onClose: (() => {
        panel.dispose();
        return closeProbe.promise;
      }) as unknown as OperationJournalPanelOptions["onClose"],
    });
    panel = harness.panel;
    const { root } = harness;
    panel.open();
    await settle();

    root
      .querySelector<HTMLButtonElement>(".rss-operation-journal-clear")
      ?.click();
    root
      .querySelector<HTMLButtonElement>(".rss-operation-journal-close")
      ?.click();

    expect(root.querySelector(".rss-operation-journal")).toBeNull();
    await settle();
    await settle();
    expect(clearProbe.handled()).toBe(true);
    expect(closeProbe.handled()).toBe(true);
    expect(unsubscribeProbe.handled()).toBe(true);
  });

  it("never presents seven-day cards while a 30-day request is pending and ignores stale completion", async () => {
    const lateSeven = deferred<OperationJournalListResult>();
    const lateThirty = deferred<OperationJournalListResult>();
    const latestThirty = deferred<OperationJournalListResult>();
    let sevenCalls = 0;
    let thirtyCalls = 0;
    const load = vi.fn((days: 7 | 30) => {
      if (days === 7) {
        sevenCalls += 1;
        return sevenCalls === 1 ? Promise.resolve(fixture()) : lateSeven.promise;
      }
      thirtyCalls += 1;
      return thirtyCalls === 1 ? lateThirty.promise : latestThirty.promise;
    });
    const { panel, root } = createHarness({ load });
    panel.open();
    await settle();
    expect(root.querySelectorAll(".rss-operation-journal-card")).toHaveLength(
      5,
    );
    root.querySelector<HTMLButtonElement>("[data-days='30']")?.click();

    expect(root.querySelector("[data-days='30']")?.getAttribute("aria-pressed"))
      .toBe("true");
    expect(root.querySelectorAll(".rss-operation-journal-card")).toHaveLength(
      0,
    );
    expect(root.textContent).toContain("正在加载");

    root.querySelector<HTMLButtonElement>("[data-days='7']")?.click();
    root.querySelector<HTMLButtonElement>("[data-days='30']")?.click();
    latestThirty.resolve(fixture());
    await settle();
    expect(root.querySelectorAll(".rss-operation-journal-card")).toHaveLength(
      5,
    );
    lateSeven.resolve({
      ...fixture(),
      operations: [],
    });
    lateThirty.resolve({
      ...fixture(),
      operations: [],
    });
    await settle();
    expect(root.querySelectorAll(".rss-operation-journal-card")).toHaveLength(
      5,
    );
  });

  it("ignores a late load completion after dispose", async () => {
    const pending = deferred<OperationJournalListResult>();
    const { panel, root } = createHarness({ load: () => pending.promise });
    panel.open();
    panel.dispose();
    pending.resolve(fixture());
    await settle();
    expect(root.querySelector(".rss-operation-journal")).toBeNull();
  });

  it("projects untrusted facade results through strict event validation", async () => {
    const valid = fixture().operations.find(
      (operation) => operation.operationId === IDS.transcript,
    )!;
    const unsafeSubjectLabel = [
      "https://",
      "token.example/",
      "?api_",
      "key=visible",
    ].join("");
    const unsafe = {
      ...valid,
      operationId: "00000000-0000-4000-8000-000000000099",
      startedAt: "not-a-date",
      subject: { label: unsafeSubjectLabel },
      events: [
        {
          ...valid.events[0],
          eventId: "20000000-0000-4000-8000-000000000099",
          occurredAt: "not-a-date",
          subject: { label: "https://token.example" },
        },
      ],
    };
    const getterOperation = {};
    Object.defineProperty(getterOperation, "events", {
      enumerable: true,
      get() {
        throw new Error("events getter must not run");
      },
    });
    const hostileHealth = {};
    Object.defineProperty(hostileHealth, "writeIncomplete", {
      enumerable: true,
      get() {
        throw new Error("health getter must not run");
      },
    });
    const result = {
      operations: [valid, unsafe, getterOperation, { events: 42 }, new Proxy({}, {
        get() {
          throw new Error("proxy get must not run");
        },
      })],
      incompleteDates: new Proxy([], {
        get() {
          throw new Error("date proxy must not run");
        },
      }),
      corruptDates: ["not-a-date", "2026-07-29"],
      truncated: false,
      health: hostileHealth,
    } as unknown as OperationJournalListResult;
    const { panel, root } = createHarness({ load: async () => result });

    panel.open();
    await settle();
    expect(root.querySelectorAll(".rss-operation-journal-card")).toHaveLength(
      1,
    );
    expect(root.textContent).toContain("演讲字幕");
    expect(root.textContent).not.toContain("token.example");
    expect(root.textContent).not.toContain("api_key");
    expect(root.textContent).not.toContain("not-a-date");
    expect(root.textContent).toContain("部分记录已损坏");
  });

  it("drops secret-shaped AI labels, connections, and models", async () => {
    const ai = fixture().operations.find(
      (operation) => operation.operationId === IDS.ai,
    )!;
    const unsafeConnection = ["to", "ken=do-not-render"].join("");
    const unsafeEvents = ai.events.map((item, index) => ({
      ...item,
      eventId: `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      subject: { label: "https://private.example" },
      details: {
        ...item.details,
        connectionName: unsafeConnection,
        model: "https://model.example",
      },
    }));
    const result = {
      ...fixture(),
      operations: [{ ...ai, events: unsafeEvents }],
    } as OperationJournalListResult;
    const { panel, root } = createHarness({ load: async () => result });

    panel.open();
    await settle();
    expect(root.querySelectorAll(".rss-operation-journal-card")).toHaveLength(
      0,
    );
    expect(root.textContent).not.toContain("do-not-render");
    expect(root.textContent).not.toContain("model.example");
    expect(root.textContent).not.toContain("private.example");
  });

  it("does not report an AI artifact as saved before a completed success", async () => {
    const saving = event(IDS.ai, 4, {
      category: "ai",
      action: "summary",
      trigger: "manual",
      stage: "saving",
      status: "succeeded",
      details: { artifactPath: "analysis/item.md", elapsedMs: 3_000 },
    });
    const { panel, root } = createHarness({
      load: async () => ({
        ...fixture(),
        operations: [{ ...fixture().operations[0], events: [saving] }],
      }),
    });

    panel.open();
    await settle();
    expect(root.textContent).toContain("保存结果：尚未保存");
    expect(root.textContent).not.toContain("保存结果：已保存");
  });

  it("bounds oversized operation candidates and reports the safe display limit", async () => {
    const valid = fixture().operations.find(
      (operation) => operation.operationId === IDS.transcript,
    )!;
    const operations = Array.from({ length: 1_001 }, () => valid);
    const { panel, root } = createHarness({
      load: async () => ({ ...fixture(), operations, truncated: false }),
    });
    panel.open();
    await settle();

    expect(root.querySelectorAll(".rss-operation-journal-card")).toHaveLength(
      1,
    );
    expect(root.textContent).toContain("仅显示安全范围内的结果");
  });

  it("keeps responsive controls on scoped wrapping and single-column hooks", () => {
    const css = readFileSync(
      "src/styles/operation-journal.css",
      "utf8",
    );
    expect(css).toContain(".rss-operation-journal-primary-actions");
    expect(css).toContain("flex-wrap: wrap");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("@media (max-width: 720px)");
    expect(css).toContain(
      ".rss-operation-journal.is-narrow .rss-operation-journal-timeline-item",
    );
    expect(css).not.toContain("!important");
  });

  it("tracks the panel width independently of the desktop viewport and disconnects its observer", async () => {
    let callback!: ResizeObserverCallback;
    let observer!: ResizeObserver;
    const observe = vi.fn();
    const disconnect = vi.fn();
    class CapturingResizeObserver {
      constructor(next: ResizeObserverCallback) {
        callback = next;
        observer = this as unknown as ResizeObserver;
      }
      observe = observe;
      unobserve = vi.fn();
      disconnect = disconnect;
    }
    vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
    const { panel, root } = createHarness();
    panel.open();
    await settle();
    const panelRoot = root.querySelector<HTMLElement>(
      ".rss-operation-journal",
    )!;

    expect(observe).toHaveBeenCalledWith(panelRoot);
    callback(
      [{ target: panelRoot, contentRect: { width: 600 } } as ResizeObserverEntry],
      observer,
    );
    expect(panelRoot.classList.contains("is-narrow")).toBe(true);
    expect(
      panelRoot
        .querySelector(".rss-operation-journal-actions")
        ?.closest(".rss-operation-journal.is-narrow"),
    ).toBe(panelRoot);
    expect(
      panelRoot
        .querySelector(".rss-operation-journal-timeline-item")
        ?.closest(".rss-operation-journal.is-narrow"),
    ).toBe(panelRoot);

    callback(
      [{ target: panelRoot, contentRect: { width: 721 } } as ResizeObserverEntry],
      observer,
    );
    expect(panelRoot.classList.contains("is-narrow")).toBe(false);
    panel.dispose();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("updates live locale without another load or subscription", async () => {
    const { panel, root, options } = createHarness();
    panel.open();
    await settle();
    expect(root.textContent).toContain("运行记录");

    panel.setLocale("en");
    expect(root.textContent).toContain("Operation journal");
    expect(options.load).toHaveBeenCalledTimes(1);
    expect(options.subscribe).toHaveBeenCalledTimes(1);
  });

  it("debounces live reloads and disposes its subscription and pending timer", async () => {
    vi.useFakeTimers();
    const { panel, options, notify, unsubscribe } = createHarness();
    panel.open();
    panel.open();
    await settle();
    expect(options.subscribe).toHaveBeenCalledTimes(1);
    expect(options.load).toHaveBeenCalledTimes(1);

    notify();
    notify();
    await vi.advanceTimersByTimeAsync(149);
    expect(options.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(options.load).toHaveBeenCalledTimes(2);

    notify();
    panel.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(options.load).toHaveBeenCalledTimes(2);
  });

  it("contains load failures and offers a retry", async () => {
    const load = vi
      .fn<OperationJournalPanelOptions["load"]>()
      .mockRejectedValueOnce(new Error("private failure"))
      .mockResolvedValueOnce(fixture());
    const { panel, root } = createHarness({ load });

    expect(() => panel.open()).not.toThrow();
    await settle();
    expect(root.textContent).toContain("暂时无法加载运行记录");
    expect(root.textContent).not.toContain("private failure");
    root
      .querySelector<HTMLButtonElement>(".rss-operation-journal-retry")
      ?.click();
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(root.querySelectorAll(".rss-operation-journal-card")).toHaveLength(
      5,
    );
  });
});

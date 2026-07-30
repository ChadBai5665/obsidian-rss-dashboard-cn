import { beforeEach, describe, expect, it, vi } from "vitest";
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
    occurredAt: `2026-07-30T0${index}:00:00.000Z`,
    subject: { label: `记录 ${index}` },
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
      stage: "saving",
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
    event(IDS.interrupted, 7, {
      category: "refresh",
      action: "folder",
      trigger: "schedule",
      stage: "refreshing",
      status: "progress",
      details: { total: 3, succeeded: 1, failed: 0, newItems: 2 },
    }),
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

describe("OperationJournalPanel", () => {
  beforeEach(() => {
    installObsidianDomPolyfills();
    vi.useRealTimers();
    document.body.empty();
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
      IDS.interrupted,
      IDS.subscription,
      IDS.refresh,
      IDS.ai,
      IDS.transcript,
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
    expect(
      [
        ...(transcript?.querySelectorAll<HTMLElement>(
          ".rss-operation-journal-timeline-item",
        ) ?? []),
      ].map((item) => item.dataset.occurredAt),
    ).toEqual(["2026-07-30T01:00:00.000Z", "2026-07-30T03:00:00.000Z"]);
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
    ).toHaveLength(4);
    expect(root.querySelectorAll(".rss-operation-journal-card")).toHaveLength(
      5,
    );
    expect(root.textContent).toContain("部分日期的记录不完整");
    expect(root.textContent).toContain("部分记录已损坏");
    expect(root.textContent).toContain("记录较多，仅显示安全范围内的结果");
    expect(root.textContent).toContain("最近一次记录写入失败");
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

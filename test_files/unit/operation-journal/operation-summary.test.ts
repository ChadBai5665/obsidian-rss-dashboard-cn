import { describe, expect, it } from "vitest";
import {
  snapshotOperationEvent,
  type OperationEvent,
} from "../../../src/operation-journal/operation-event";
import { aggregateOperationEvents } from "../../../src/operation-journal/operation-summary";

const OPERATION_ID = "22222222-2222-4222-8222-222222222222";

function event(input: {
  eventId: string;
  occurredAt: string;
  status?: "started" | "progress" | "succeeded" | "failed" | "aborted";
  operationId?: string;
  category?: "transcript" | "ai" | "refresh" | "subscription";
  action?: string;
  stage?: string;
  details?: Record<string, unknown>;
}): OperationEvent {
  return snapshotOperationEvent({
    schemaVersion: 1,
    eventId: input.eventId,
    operationId: input.operationId ?? OPERATION_ID,
    occurredAt: input.occurredAt,
    category: input.category ?? "transcript",
    action: input.action ?? "retrieve",
    trigger: "manual",
    stage: input.stage ?? "checking-cache",
    status: input.status ?? "progress",
    subject: { itemId: "item-42", label: "Local title" },
    details: input.details ?? { contentBasis: "youtube-transcript" },
  });
}

describe("aggregateOperationEvents", () => {
  it("sorts a cross-day operation, deduplicates event IDs, and freezes its summary", () => {
    const started = event({
      eventId: "11111111-1111-4111-8111-111111111111",
      occurredAt: "2026-07-29T23:59:00.000Z",
      status: "started",
    });
    const succeeded = event({
      eventId: "33333333-3333-4333-8333-333333333333",
      occurredAt: "2026-07-30T00:01:00.000Z",
      status: "succeeded",
      stage: "completed",
      details: { provider: "innertube", contentBasis: "youtube-transcript" },
    });

    const [summary] = aggregateOperationEvents(
      [succeeded, started, started],
      new Date("2026-07-30T01:00:00.000Z"),
    );

    expect(summary.events.map((entry) => entry.eventId)).toEqual([
      started.eventId,
      succeeded.eventId,
    ]);
    expect(summary.status).toBe("succeeded");
    expect(summary.durationMs).toBe(120_000);
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.events)).toBe(true);
  });

  it("merges conservative TikHub billing evidence without treating it as a bill", () => {
    const [summary] = aggregateOperationEvents(
      [
        event({
          eventId: "11111111-1111-4111-8111-111111111111",
          occurredAt: "2026-07-30T01:00:00.000Z",
          status: "started",
          stage: "tikhub-request",
          details: {
            provider: "tikhub",
            confirmedPaidRequests: 1,
            possiblySent: true,
          },
        }),
        event({
          eventId: "33333333-3333-4333-8333-333333333333",
          occurredAt: "2026-07-30T01:00:02.000Z",
          status: "succeeded",
          stage: "completed",
          details: {
            provider: "tikhub",
            confirmedPaidRequests: 2,
            possiblySent: false,
            contentBasis: "youtube-transcript",
          },
        }),
      ],
      new Date("2026-07-30T01:00:03.000Z"),
    );

    expect(summary.confirmedPaidRequests).toBe(2);
    expect(summary.possiblySent).toBe(true);
  });

  it("keeps a terminal result when a late progress event arrives", () => {
    const [summary] = aggregateOperationEvents(
      [
        event({
          eventId: "11111111-1111-4111-8111-111111111111",
          occurredAt: "2026-07-30T01:00:00.000Z",
          status: "succeeded",
          stage: "completed",
        }),
        event({
          eventId: "33333333-3333-4333-8333-333333333333",
          occurredAt: "2026-07-30T01:01:00.000Z",
          status: "progress",
          stage: "saving",
        }),
      ],
      new Date("2026-07-30T01:02:00.000Z"),
    );

    expect(summary.status).toBe("succeeded");
  });

  it.each([
    [
      "transcript",
      "retrieve",
      "checking-cache",
      "2026-07-30T00:30:00.000Z",
      false,
    ],
    ["ai", "summary", "preparing", "2026-07-30T00:30:00.000Z", false],
    ["refresh", "all", "refreshing", "2026-07-29T23:00:00.000Z", false],
    ["subscription", "add", "validating", "2026-07-30T00:50:00.000Z", false],
    [
      "transcript",
      "retrieve",
      "checking-cache",
      "2026-07-30T00:29:59.999Z",
      true,
    ],
    ["ai", "summary", "preparing", "2026-07-30T00:29:59.999Z", true],
    ["refresh", "all", "refreshing", "2026-07-29T22:59:59.999Z", true],
    ["subscription", "add", "validating", "2026-07-30T00:49:59.999Z", true],
  ] as const)(
    "derives interrupted only after the %s threshold",
    (category, action, stage, occurredAt, interrupted) => {
      const [summary] = aggregateOperationEvents(
        [
          event({
            eventId: "11111111-1111-4111-8111-111111111111",
            occurredAt,
            status: "started",
            category,
            action,
            stage,
            details:
              category === "ai"
                ? {
                    connectionName: "Local AI",
                    providerKind: "openai",
                    model: "gpt-5.6",
                    contentBasis: "feed",
                  }
                : category === "refresh"
                  ? { total: 0, succeeded: 0, failed: 0, newItems: 0 }
                  : category === "subscription"
                    ? { sourceKind: "rss" }
                    : { contentBasis: "youtube-transcript" },
          }),
        ],
        new Date("2026-07-30T01:00:00.000Z"),
      );

      expect(summary.status === "interrupted").toBe(interrupted);
    },
  );

  it("ignores a malformed event without hiding a valid operation summary", () => {
    const valid = event({
      eventId: "11111111-1111-4111-8111-111111111111",
      occurredAt: "2026-07-30T01:00:00.000Z",
      status: "succeeded",
      stage: "completed",
    });
    const malformed = {
      ...valid,
      schemaVersion: 2,
    } as unknown as OperationEvent;

    const summaries = aggregateOperationEvents(
      [malformed, valid],
      new Date("2026-07-30T01:01:00.000Z"),
    );

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.operationId).toBe(OPERATION_ID);
  });
});

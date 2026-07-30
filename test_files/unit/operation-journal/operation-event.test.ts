import { describe, expect, it } from "vitest";
import {
  snapshotOperationEvent,
  type OperationEvent,
} from "../../../src/operation-journal/operation-event";

const validTranscriptEvent = {
  schemaVersion: 1,
  eventId: "11111111-1111-4111-8111-111111111111",
  operationId: "22222222-2222-4222-8222-222222222222",
  occurredAt: "2026-07-30T01:02:03.000Z",
  category: "transcript",
  action: "retrieve",
  trigger: "manual",
  stage: "checking-cache",
  status: "started",
  subject: { itemId: "item-42", label: "A local video title" },
  details: { contentBasis: "youtube-transcript", provider: "cache" },
} as const;

function asUnknown(value: unknown): unknown {
  return value;
}

function eventWith(
  overrides: Partial<Record<keyof typeof validTranscriptEvent, unknown>>,
): unknown {
  return {
    ...validTranscriptEvent,
    ...overrides,
    subject:
      overrides.subject === undefined
        ? { ...validTranscriptEvent.subject }
        : overrides.subject,
    details:
      overrides.details === undefined
        ? { ...validTranscriptEvent.details }
        : overrides.details,
  };
}

describe("snapshotOperationEvent", () => {
  it("copies and deeply freezes a valid transcript event", () => {
    const snapshot = snapshotOperationEvent(validTranscriptEvent);

    expect(snapshot).toEqual(
      Object.freeze({
        ...validTranscriptEvent,
        subject: Object.freeze({ ...validTranscriptEvent.subject }),
        details: Object.freeze({ ...validTranscriptEvent.details }),
      }),
    );
    expect(snapshot).not.toBe(validTranscriptEvent);
    expect(snapshot.subject).not.toBe(validTranscriptEvent.subject);
    expect(snapshot.details).not.toBe(validTranscriptEvent.details);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.subject)).toBe(true);
    expect(Object.isFrozen(snapshot.details)).toBe(true);
  });

  it("rejects every field outside the public event contract", () => {
    expect(() =>
      snapshotOperationEvent(eventWith({ extra: "not allowed" })),
    ).toThrow();
    expect(() =>
      snapshotOperationEvent(
        eventWith({ details: { ...validTranscriptEvent.details, extra: 1 } }),
      ),
    ).toThrow();
  });

  it("rejects getters, inherited fields, and non-plain objects without reading them", () => {
    const getterEvent = {
      ...validTranscriptEvent,
      subject: { ...validTranscriptEvent.subject },
      details: { ...validTranscriptEvent.details },
    };
    Object.defineProperty(getterEvent, "status", {
      enumerable: true,
      get() {
        throw new Error("must not run");
      },
    });

    const inheritedEvent = Object.create(validTranscriptEvent) as object;
    const classEvent = new (class {
      schemaVersion = 1;
    })();

    expect(() => snapshotOperationEvent(getterEvent)).toThrow();
    expect(() => snapshotOperationEvent(inheritedEvent)).toThrow();
    expect(() => snapshotOperationEvent(classEvent)).toThrow();
  });

  it("rejects invalid UUIDs, ISO instants, labels, and numeric evidence", () => {
    expect(() =>
      snapshotOperationEvent(eventWith({ eventId: "not-a-uuid" })),
    ).toThrow();
    expect(() =>
      snapshotOperationEvent(eventWith({ occurredAt: "2026-07-30" })),
    ).toThrow();
    expect(() =>
      snapshotOperationEvent(
        eventWith({ subject: { itemId: "item-42", label: "x".repeat(201) } }),
      ),
    ).toThrow();
    for (const pollNumber of [-1, 1.5, Infinity]) {
      expect(() =>
        snapshotOperationEvent(
          eventWith({
            details: { ...validTranscriptEvent.details, pollNumber },
          }),
        ),
      ).toThrow();
    }
    expect(() =>
      snapshotOperationEvent(
        eventWith({
          details: {
            provider: "tikhub",
            confirmedPaidRequests: 3,
            possiblySent: true,
          },
        }),
      ),
    ).toThrow();
  });

  it("rejects category-incompatible actions, stages, and details", () => {
    expect(() =>
      snapshotOperationEvent(eventWith({ action: "summary" })),
    ).toThrow();
    expect(() =>
      snapshotOperationEvent(eventWith({ stage: "preparing" })),
    ).toThrow();
    expect(() =>
      snapshotOperationEvent(
        eventWith({
          details: { connectionName: "Local AI", model: "gpt-5.6" },
        }),
      ),
    ).toThrow();
  });

  it("does not allow the derived interrupted display state in persisted history", () => {
    expect(() =>
      snapshotOperationEvent(eventWith({ status: "interrupted" })),
    ).toThrow();
  });

  it("rejects URL-shaped and credential-shaped detail values", () => {
    for (const jobId of [
      "https://example.test/jobs/42",
      "Authorization: Bearer secret",
      "api_key=secret",
    ]) {
      expect(() =>
        snapshotOperationEvent(
          eventWith({ details: { provider: "tikhub", jobId } }),
        ),
      ).toThrow();
    }
  });

  it("accepts each closed category with only its own safe details", () => {
    const events: readonly unknown[] = [
      validTranscriptEvent,
      eventWith({
        eventId: "33333333-3333-4333-8333-333333333333",
        category: "ai",
        action: "summary",
        stage: "preparing",
        subject: { itemId: "item-42" },
        details: {
          connectionName: "Local AI",
          providerKind: "openai",
          model: "gpt-5.6",
          contentBasis: "feed",
        },
      }),
      eventWith({
        eventId: "44444444-4444-4444-8444-444444444444",
        category: "refresh",
        action: "all",
        trigger: "startup",
        stage: "refreshing",
        subject: {},
        details: {
          total: 3,
          succeeded: 2,
          failed: 1,
          newItems: 4,
          elapsedMs: 50,
        },
      }),
      eventWith({
        eventId: "55555555-5555-4555-8555-555555555555",
        category: "subscription",
        action: "remove",
        stage: "saving",
        subject: { sourceId: "source-42", label: "Local feed" },
        details: { sourceKind: "rss", preserveHistory: true },
      }),
    ];

    for (const event of events) {
      expect(snapshotOperationEvent(asUnknown(event))).toMatchObject({
        schemaVersion: 1,
      });
    }
  });
});

void (undefined as unknown as OperationEvent);

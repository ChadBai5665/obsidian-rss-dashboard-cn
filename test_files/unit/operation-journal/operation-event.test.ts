import { describe, expect, it } from "vitest";
import {
  projectSafeOperationSubject,
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
  it("accepts the dedicated local refresh-state failure code", () => {
    expect(
      snapshotOperationEvent(
        eventWith({
          category: "refresh",
          action: "source",
          stage: "completed",
          status: "failed",
          subject: { sourceId: "source-42" },
          details: { errorCode: "refresh-state-failed" },
        }),
      ).details,
    ).toEqual({ errorCode: "refresh-state-failed" });
  });

  it("projects safe subject fields independently instead of rejecting the identity", () => {
    const unsafeLabels = [
      "www.private.example/source",
      "sk-1234567890abcdef",
      "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      "feeds/credentials/token/source",
    ];

    expect(
      projectSafeOperationSubject({
        sourceId: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
        label: "Local feed",
      }),
    ).toEqual({ label: "Local feed" });
    for (const label of unsafeLabels) {
      expect(projectSafeOperationSubject({ sourceId: "source-42", label })).toEqual({
        sourceId: "source-42",
      });
    }

    let getterRuns = 0;
    const getterSubject = { sourceId: "source-42" };
    Object.defineProperty(getterSubject, "label", {
      enumerable: true,
      get() {
        getterRuns += 1;
        throw new Error("must not run");
      },
    });
    expect(projectSafeOperationSubject(getterSubject)).toEqual({
      sourceId: "source-42",
    });
    expect(getterRuns).toBe(0);
    expect(
      projectSafeOperationSubject(
        new Proxy({}, {
          ownKeys() {
            throw new Error("hostile object");
          },
        }),
      ),
    ).toEqual({});
  });

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

  it("accepts repository-relative AI analysis artifacts under default and configured data roots", () => {
    const artifacts = [
      ".rss-dashboard-data/analysis/item-42/20260730T010203000-summary.md",
      "自定义 数据/归档（本地）/analysis/项目 42/结果-摘要.md",
    ];

    for (const artifactPath of artifacts) {
      expect(
        snapshotOperationEvent(
          eventWith({
            category: "ai",
            action: "summary",
            stage: "saving",
            subject: { itemId: "item-42", label: "中文显示标题" },
            details: {
              connectionName: "本地模型（测试）",
              providerKind: "openai",
              model: "gpt-5.6",
              contentBasis: "feed",
              artifactPath,
            },
          }),
        ).details,
      ).toMatchObject({ artifactPath });
    }
  });

  it("rejects unsafe analysis artifact paths", () => {
    for (const artifactPath of [
      "/.rss-dashboard-data/analysis/item-42/result.md",
      "C:\\Users\\chad\\analysis\\item-42\\result.md",
      "../.rss-dashboard-data/analysis/item-42/result.md",
      ".rss-dashboard-data/../analysis/item-42/result.md",
      "file:///Users/chad/.secrets/api_key",
      "obsidian://open?vault=private",
      ".rss-dashboard-data/.secrets/analysis/item-42/result.md",
      ".rss-dashboard-data/analysis/api_key/item-42/result.md",
      ".rss-dashboard-data/analysis/item-42/result\u0000.md",
      `.rss-dashboard-data/analysis/item-42/${"x".repeat(201)}.md`,
    ]) {
      expect(() =>
        snapshotOperationEvent(
          eventWith({
            category: "ai",
            action: "summary",
            stage: "saving",
            subject: { itemId: "item-42" },
            details: {
              connectionName: "本地模型",
              providerKind: "openai",
              model: "gpt-5.6",
              contentBasis: "feed",
              artifactPath,
            },
          }),
        ),
      ).toThrow();
    }
  });

  it("rejects secrets from every free-text journal field while retaining ordinary Unicode labels", () => {
    const unsafeValues = [
      "file:///Users/chad/.secrets/api_key",
      "obsidian://open?vault=private",
      "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue",
      "Authorization: Bearer credential",
      "api_key=credential",
    ];

    for (const value of unsafeValues) {
      expect(() =>
        snapshotOperationEvent(
          eventWith({ subject: { itemId: "item-42", label: value } }),
        ),
      ).toThrow();
      expect(() =>
        snapshotOperationEvent(
          eventWith({
            category: "ai",
            action: "summary",
            stage: "preparing",
            subject: { itemId: "item-42", label: "正常中文标题" },
            details: {
              connectionName: value,
              providerKind: "openai",
              model: value,
              contentBasis: "feed",
            },
          }),
        ),
      ).toThrow();
      expect(() =>
        snapshotOperationEvent(
          eventWith({
            category: "subscription",
            action: "add",
            stage: "validating",
            subject: { sourceId: "source-42", label: value },
            details: { sourceKind: "rss" },
          }),
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

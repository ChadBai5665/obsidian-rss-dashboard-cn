import { describe, expect, it } from "vitest";
import {
  snapshotOperationEvent,
  type OperationEvent,
} from "../../../src/operation-journal/operation-event";
import { aggregateOperationEvents } from "../../../src/operation-journal/operation-summary";
import {
  createSafeOperationJournalExport,
  type SafeOperationJournalExport,
} from "../../../src/operation-journal/safe-operation-journal-export";
import type { OperationSummary } from "../../../src/operation-journal/operation-summary";

const NOW = new Date("2026-07-30T03:00:00.000Z");
const RAW_LOCAL_ID = "123e4567-e89b-12d3-a456-426614174000";
const PRIVATE_TITLE = "The Writing System";
const PRIVATE_PATH =
  ".rss-dashboard-data/content/PROMPT_OUTPUT_TRANSCRIPT_CANARY_81FA.md";
const PRIVATE_ARTIFACT_PATH =
  ".rss-dashboard-data/analysis/PROMPT_OUTPUT_TRANSCRIPT_CANARY_81FA.md";
const PRIVATE_CONNECTION = "CREDENTIAL_CANARY_81FA";
const PRIVATE_JOB_ID = "job-private-81fa";

function localEvent(input: {
  eventId: string;
  operationId: string;
  occurredAt: string;
  category: "transcript" | "ai";
  action: "retrieve" | "summary";
  stage: string;
  status: "started" | "progress" | "succeeded" | "failed";
  subject: Record<string, unknown>;
  details: Record<string, unknown>;
}): OperationEvent {
  return snapshotOperationEvent({
    schemaVersion: 1,
    trigger: "manual",
    ...input,
  });
}

function buildExport(): string {
  const events = [
    localEvent({
      eventId: "10000000-0000-4000-8000-000000000001",
      operationId: "20000000-0000-4000-8000-000000000001",
      occurredAt: "2026-07-30T02:20:00.000Z",
      category: "ai",
      action: "summary",
      stage: "preparing",
      status: "started",
      subject: {
        itemId: RAW_LOCAL_ID,
        label: `${PRIVATE_TITLE} ${PRIVATE_PATH}`,
      },
      details: {
        connectionName: PRIVATE_CONNECTION,
        providerKind: "openai",
        model: "gpt-5.6",
        contentBasis: "feed",
      },
    }),
    localEvent({
      eventId: "10000000-0000-4000-8000-000000000002",
      operationId: "20000000-0000-4000-8000-000000000001",
      occurredAt: "2026-07-30T02:20:05.000Z",
      category: "ai",
      action: "summary",
      stage: "saving",
      status: "failed",
      subject: {
        itemId: RAW_LOCAL_ID,
        label: `${PRIVATE_TITLE} ${PRIVATE_PATH}`,
      },
      details: {
        connectionName: PRIVATE_CONNECTION,
        providerKind: "openai",
        model: "gpt-5.6",
        contentBasis: "feed",
        artifactPath: PRIVATE_ARTIFACT_PATH,
        elapsedMs: 5_000,
        errorCode: "cache-save-failed",
      },
    }),
    localEvent({
      eventId: "10000000-0000-4000-8000-000000000003",
      operationId: "20000000-0000-4000-8000-000000000002",
      occurredAt: "2026-07-30T02:00:00.000Z",
      category: "transcript",
      action: "retrieve",
      stage: "job-received",
      status: "progress",
      subject: { sourceId: "source-private-81fa", label: PRIVATE_TITLE },
      details: {
        provider: "tikhub",
        jobId: PRIVATE_JOB_ID,
        confirmedPaidRequests: 1,
        possiblySent: true,
        pollNumber: 2,
        elapsedMs: 9_000,
      },
    }),
  ];

  return createSafeOperationJournalExport({
    generatedAt: NOW.toISOString(),
    rangeDays: 7,
    health: Object.freeze({
      writeIncomplete: false,
      maintenanceIncomplete: true,
      lastMaintenanceFailureAt: "2026-07-30T02:30:00.000Z",
    }),
    operations: aggregateOperationEvents(events, NOW),
  });
}

function exportModel(model: string): SafeOperationJournalExport {
  const event = localEvent({
    eventId: "30000000-0000-4000-8000-000000000001",
    operationId: "40000000-0000-4000-8000-000000000001",
    occurredAt: "2026-07-30T02:50:00.000Z",
    category: "ai",
    action: "summary",
    stage: "preparing",
    status: "started",
    subject: { itemId: "model-test-item" },
    details: {
      providerKind: "openai-compatible",
      model,
      contentBasis: "feed",
    },
  });
  return JSON.parse(
    createSafeOperationJournalExport({
      generatedAt: NOW.toISOString(),
      rangeDays: 7,
      health: Object.freeze({
        writeIncomplete: false,
        maintenanceIncomplete: false,
      }),
      operations: aggregateOperationEvents([event], NOW),
    }),
  ) as SafeOperationJournalExport;
}

describe("createSafeOperationJournalExport", () => {
  it("removes local identity, labels, paths, job IDs, and private content canaries", () => {
    const exported = buildExport();

    for (const privateValue of [
      PRIVATE_TITLE,
      RAW_LOCAL_ID,
      PRIVATE_PATH,
      PRIVATE_CONNECTION,
      PRIVATE_JOB_ID,
      "PROMPT_OUTPUT_TRANSCRIPT_CANARY_81FA",
      "CREDENTIAL_CANARY_81FA",
    ]) {
      expect(exported).not.toContain(privateValue);
    }
    const parsed = JSON.parse(exported) as SafeOperationJournalExport;
    expect(parsed.operations[0]?.subjectHash).toBe("05febd9c81f04221");
    expect(parsed.operations[0]?.subjectHash).toMatch(/^[a-f0-9]{16}$/u);
  });

  it("emits only the bounded stable diagnostic projection", () => {
    const exported = buildExport();
    const parsed = JSON.parse(exported) as SafeOperationJournalExport;

    expect(Object.keys(parsed)).toEqual([
      "schemaVersion",
      "generatedAt",
      "rangeDays",
      "health",
      "operations",
    ]);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      generatedAt: NOW.toISOString(),
      rangeDays: 7,
      health: {
        writeIncomplete: false,
        maintenanceIncomplete: true,
        lastMaintenanceFailureAt: "2026-07-30T02:30:00.000Z",
      },
    });
    expect(parsed.operations[0]).toEqual({
      category: "ai",
      action: "summary",
      trigger: "manual",
      subjectHash: "05febd9c81f04221",
      startedAt: "2026-07-30T02:20:00.000Z",
      lastOccurredAt: "2026-07-30T02:20:05.000Z",
      finishedAt: "2026-07-30T02:20:05.000Z",
      status: "failed",
      durationMs: 5_000,
      confirmedPaidRequests: 0,
      possiblySent: false,
      events: [
        {
          occurredAt: "2026-07-30T02:20:00.000Z",
          stage: "preparing",
          status: "started",
          details: {
            providerKind: "openai",
            model: "gpt-5.6",
            contentBasis: "feed",
          },
        },
        {
          occurredAt: "2026-07-30T02:20:05.000Z",
          stage: "saving",
          status: "failed",
          details: {
            providerKind: "openai",
            model: "gpt-5.6",
            contentBasis: "feed",
            elapsedMs: 5_000,
            errorCode: "cache-save-failed",
          },
        },
      ],
    });
    expect(parsed.operations[1]?.events[0]?.details).toEqual({
      provider: "tikhub",
      confirmedPaidRequests: 1,
      possiblySent: true,
      jobIdPresent: true,
      pollNumber: 2,
      elapsedMs: 9_000,
    });
    expect(exported.length).toBeLessThan(10_000);
    expect(buildExport()).toBe(exported);
  });

  it.each([
    ["C:", "Users", "local", "models", "model.gguf"].join("/"),
    ["C:", "Users", "local", "models", "model.gguf"].join("\\"),
    "/opt/models/model.gguf",
    "~/models/model.gguf",
    "Users/local/models/model.gguf",
    "vendor/model.safetensors",
    "vendor/../model-v1",
    "localhost/model-v1",
    "models.example.com/model-v1",
    "127.0.0.1/model-v1",
    "CREDENTIAL_CANARY_81FA",
    "PROMPT_CANARY_81FA",
    "OUTPUT_CANARY_81FA",
  ])("omits unsafe local, host, or private model value %s", (model) => {
    const parsed = exportModel(model);

    expect(parsed.operations[0]?.events[0]?.details).not.toHaveProperty(
      "model",
    );
    expect(JSON.stringify(parsed)).not.toContain(model);
  });

  it.each([
    "deepseek-chat",
    "kimi-k2-0711-preview",
    "MiniMax-M2.1",
    "deepseek/deepseek-chat",
    "moonshotai/kimi-k2",
    "MiniMaxAI/MiniMax-M2.1",
    "vendor/model-v1",
  ])("retains a bounded provider model identifier %s", (model) => {
    expect(exportModel(model).operations[0]?.events[0]?.details.model).toBe(
      model,
    );
  });

  it("rejects a forged URL model with a static non-leaking export error", () => {
    const validEvent = localEvent({
      eventId: "30000000-0000-4000-8000-000000000002",
      operationId: "40000000-0000-4000-8000-000000000002",
      occurredAt: "2026-07-30T02:50:00.000Z",
      category: "ai",
      action: "summary",
      stage: "preparing",
      status: "started",
      subject: { itemId: "model-test-item" },
      details: {
        providerKind: "openai-compatible",
        model: "vendor/model-v1",
        contentBasis: "feed",
      },
    });
    const [summary] = aggregateOperationEvents([validEvent], NOW);
    const unsafeUrl = "https://private.invalid/model";
    const forgedEvent = {
      ...validEvent,
      details: { ...validEvent.details, model: unsafeUrl },
    } as OperationEvent;
    const forgedSummary = {
      ...summary,
      events: [forgedEvent],
    } as OperationSummary;

    let thrown: unknown;
    try {
      createSafeOperationJournalExport({
        generatedAt: NOW.toISOString(),
        rangeDays: 7,
        health: Object.freeze({
          writeIncomplete: false,
          maintenanceIncomplete: false,
        }),
        operations: [forgedSummary],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "SafeOperationJournalExportError",
      message: "Unable to create safe operation journal export.",
    });
    expect(JSON.stringify(thrown)).not.toContain(unsafeUrl);
  });
});

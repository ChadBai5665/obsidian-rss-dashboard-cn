import { createHash } from "crypto";
import {
  snapshotOperationEvent,
  type OperationEvent,
  type OperationStatus,
} from "./operation-event";
import type { OperationJournalHealth } from "./operation-journal-service";
import {
  aggregateOperationEvents,
  type OperationSummary,
} from "./operation-summary";

const MAX_SAFE_EXPORT_EVENTS = 20_000;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface SafeOperationJournalEvent {
  readonly occurredAt: string;
  readonly stage: OperationEvent["stage"];
  readonly status: OperationStatus;
  readonly details: Readonly<Record<string, boolean | number | string>>;
}

export interface SafeOperationJournalOperation {
  readonly category: OperationEvent["category"];
  readonly action: OperationEvent["action"];
  readonly trigger: OperationEvent["trigger"];
  readonly subjectHash?: string;
  readonly startedAt: string;
  readonly lastOccurredAt: string;
  readonly finishedAt?: string;
  readonly status: OperationStatus;
  readonly durationMs: number;
  readonly confirmedPaidRequests: 0 | 1 | 2;
  readonly possiblySent: boolean;
  readonly events: readonly SafeOperationJournalEvent[];
}

export interface SafeOperationJournalExport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly rangeDays: 7 | 30;
  readonly health: OperationJournalHealth;
  readonly operations: readonly SafeOperationJournalOperation[];
}

export interface SafeOperationJournalExportInput {
  readonly generatedAt: string;
  readonly rangeDays: 7 | 30;
  readonly health: OperationJournalHealth;
  readonly operations: readonly OperationSummary[];
}

export class SafeOperationJournalExportError extends Error {
  constructor() {
    super("Unable to create safe operation journal export.");
    this.name = "SafeOperationJournalExportError";
  }
}

export function createSafeOperationJournalExport(
  input: SafeOperationJournalExportInput,
): string {
  try {
    const generatedAt = isoInstant(input.generatedAt);
    if (input.rangeDays !== 7 && input.rangeDays !== 30) throw unsafeExport();
    const health = snapshotHealth(input.health);
    const events = boundedEvents(input.operations);
    const operations = aggregateOperationEvents(events, new Date(generatedAt));

    const exported: SafeOperationJournalExport = Object.freeze({
      schemaVersion: 1,
      generatedAt,
      rangeDays: input.rangeDays,
      health,
      operations: Object.freeze(operations.map(projectOperation)),
    });
    return JSON.stringify(exported, null, 2);
  } catch (error) {
    if (error instanceof SafeOperationJournalExportError) throw error;
    throw unsafeExport();
  }
}

function boundedEvents(
  operations: readonly OperationSummary[],
): readonly OperationEvent[] {
  const events: OperationEvent[] = [];
  for (const operation of operations) {
    for (const event of operation.events) {
      if (events.length >= MAX_SAFE_EXPORT_EVENTS) return events;
      events.push(snapshotOperationEvent(event));
    }
  }
  return events;
}

function projectOperation(
  operation: OperationSummary,
): SafeOperationJournalOperation {
  const localId = operation.subject.itemId ?? operation.subject.sourceId;
  return Object.freeze({
    category: operation.category,
    action: operation.action,
    trigger: operation.trigger,
    ...(localId === undefined
      ? {}
      : { subjectHash: subjectHash(operation.category, localId) }),
    startedAt: operation.startedAt,
    lastOccurredAt: operation.lastOccurredAt,
    ...(operation.finishedAt === undefined
      ? {}
      : { finishedAt: operation.finishedAt }),
    status: operation.status,
    durationMs: operation.durationMs,
    confirmedPaidRequests: operation.confirmedPaidRequests,
    possiblySent: operation.possiblySent,
    events: Object.freeze(operation.events.map(projectEvent)),
  });
}

function projectEvent(event: OperationEvent): SafeOperationJournalEvent {
  const snapshot = snapshotOperationEvent(event);
  return Object.freeze({
    occurredAt: snapshot.occurredAt,
    stage: snapshot.stage,
    status: snapshot.status,
    details: projectDetails(snapshot),
  });
}

function projectDetails(
  event: OperationEvent,
): Readonly<Record<string, boolean | number | string>> {
  const details: Record<string, boolean | number | string> = {};
  const source = event.details;
  if ("provider" in source && source.provider !== undefined) {
    details.provider = source.provider;
  }
  if ("providerKind" in source && source.providerKind !== undefined) {
    details.providerKind = source.providerKind;
  }
  if ("model" in source && source.model !== undefined) {
    const model = safeModel(source.model);
    if (model !== undefined) details.model = model;
  }
  if ("contentBasis" in source && source.contentBasis !== undefined) {
    details.contentBasis = source.contentBasis;
  }
  if ("sourceKind" in source && source.sourceKind !== undefined) {
    details.sourceKind = source.sourceKind;
  }
  if ("preserveHistory" in source && source.preserveHistory !== undefined) {
    details.preserveHistory = source.preserveHistory;
  }
  if (
    "confirmedPaidRequests" in source &&
    source.confirmedPaidRequests !== undefined
  ) {
    details.confirmedPaidRequests = source.confirmedPaidRequests;
  }
  if ("possiblySent" in source && source.possiblySent !== undefined) {
    details.possiblySent = source.possiblySent;
  }
  if ("jobId" in source && source.jobId !== undefined) {
    details.jobIdPresent = true;
  }
  if ("pollNumber" in source && source.pollNumber !== undefined) {
    details.pollNumber = source.pollNumber;
  }
  if ("elapsedMs" in source && source.elapsedMs !== undefined) {
    details.elapsedMs = source.elapsedMs;
  }
  if ("total" in source && source.total !== undefined) {
    details.total = source.total;
  }
  if ("succeeded" in source && source.succeeded !== undefined) {
    details.succeeded = source.succeeded;
  }
  if ("failed" in source && source.failed !== undefined) {
    details.failed = source.failed;
  }
  if ("newItems" in source && source.newItems !== undefined) {
    details.newItems = source.newItems;
  }
  if ("errorCode" in source && source.errorCode !== undefined) {
    details.errorCode = source.errorCode;
  }
  return Object.freeze(details);
}

function subjectHash(
  category: OperationEvent["category"],
  localId: string,
): string {
  return createHash("sha256")
    .update(`${category}:${localId}`)
    .digest("hex")
    .slice(0, 16);
}

function safeModel(value: string): string | undefined {
  return SAFE_MODEL.test(value) && !value.includes("://") ? value : undefined;
}

function snapshotHealth(
  health: OperationJournalHealth,
): OperationJournalHealth {
  if (
    typeof health.writeIncomplete !== "boolean" ||
    typeof health.maintenanceIncomplete !== "boolean"
  ) {
    throw unsafeExport();
  }
  return Object.freeze({
    writeIncomplete: health.writeIncomplete,
    maintenanceIncomplete: health.maintenanceIncomplete,
    ...(health.lastWriteFailureAt === undefined
      ? {}
      : { lastWriteFailureAt: isoInstant(health.lastWriteFailureAt) }),
    ...(health.lastMaintenanceFailureAt === undefined
      ? {}
      : {
          lastMaintenanceFailureAt: isoInstant(health.lastMaintenanceFailureAt),
        }),
  });
}

function isoInstant(value: string): string {
  if (!ISO_UTC.test(value)) throw unsafeExport();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw unsafeExport();
  }
  return value;
}

function unsafeExport(): SafeOperationJournalExportError {
  return new SafeOperationJournalExportError();
}

import {
  snapshotOperationEvent,
  type OperationAction,
  type OperationCategory,
  type OperationDetails,
  type OperationErrorCode,
  type OperationEvent,
  type OperationStage,
  type OperationSubject,
  type OperationTrigger,
} from "./operation-event";
import type {
  OperationJournalAppendResult,
  OperationJournalReadResult,
  OperationJournalRepository,
  OperationJournalStats,
} from "./operation-journal-repository";
import { createSafeOperationJournalExport } from "./safe-operation-journal-export";
import {
  aggregateOperationEvents,
  type OperationSummary,
} from "./operation-summary";

export interface OperationIdentityInput {
  readonly category: OperationCategory;
  readonly action: OperationAction;
  readonly trigger: OperationTrigger;
  readonly subject: OperationSubject;
}

export interface OperationBeginInput extends OperationIdentityInput {
  readonly stage: OperationStage;
  readonly details: OperationDetails;
}

export interface OperationJournalScope {
  readonly operationId: string;
  progress(stage: OperationStage, details: OperationDetails): Promise<void>;
  succeed(stage: OperationStage, details: OperationDetails): Promise<void>;
  fail(
    stage: OperationStage,
    errorCode: OperationErrorCode,
    details?: OperationDetails,
  ): Promise<void>;
  abort(stage: OperationStage): Promise<void>;
}

export interface OperationJournalPort {
  begin(input: OperationBeginInput): OperationJournalScope;
  attach(
    operationId: string,
    input: OperationIdentityInput,
  ): OperationJournalScope;
}

export interface OperationJournalHealth {
  readonly writeIncomplete: boolean;
  readonly maintenanceIncomplete: boolean;
  readonly lastWriteFailureAt?: string;
  readonly lastMaintenanceFailureAt?: string;
}

export interface OperationJournalListResult {
  readonly operations: readonly OperationSummary[];
  readonly incompleteDates: readonly string[];
  readonly corruptDates: readonly string[];
  readonly truncated: boolean;
  readonly health: OperationJournalHealth;
}

export interface OperationJournalServiceOptions {
  readonly createId?: () => string;
  readonly clock?: () => Date;
  readonly onHealthChange?: (health: OperationJournalHealth) => void;
}

type OperationJournalStore = Pick<
  OperationJournalRepository,
  "append" | "readRange" | "stats" | "prune" | "clear"
>;

interface HealthContext {
  writeNotified: boolean;
  maintenanceNotified: boolean;
}

interface OperationIdResult {
  readonly operationId: string;
  readonly usable: boolean;
}

const VALIDATION_ID = "00000000-0000-4000-8000-000000000000";
const VALIDATION_TIME = "2000-01-01T00:00:00.000Z";
const EMPTY_HEALTH: OperationJournalHealth = Object.freeze({
  writeIncomplete: false,
  maintenanceIncomplete: false,
});
const EMPTY_STATS: OperationJournalStats = Object.freeze({
  bytes: 0,
  days: 0,
  eventCount: 0,
});

export class OperationJournalServiceError extends Error {
  readonly code = "operation-journal-unavailable";

  constructor() {
    super("Operation journal unavailable.");
    this.name = "OperationJournalServiceError";
  }
}

export class OperationJournalService implements OperationJournalPort {
  private readonly createId: () => string;
  private readonly clock: () => Date;
  private readonly onHealthChange?: (health: OperationJournalHealth) => void;
  private readonly listeners = new Set<(event: OperationEvent) => void>();
  private health: OperationJournalHealth = EMPTY_HEALTH;

  constructor(
    private readonly repository: OperationJournalStore,
    options: OperationJournalServiceOptions = {},
  ) {
    this.createId =
      options.createId ?? (() => activeWindow.crypto.randomUUID());
    this.clock = options.clock ?? (() => new Date());
    this.onHealthChange = options.onHealthChange;
  }

  begin(input: OperationBeginInput): OperationJournalScope {
    const id = this.createOperationId();
    const context = createHealthContext();
    if (!id.usable) {
      this.recordWriteFailure(context);
      return createNoopScope(id.operationId);
    }
    try {
      const identity = snapshotIdentity(input, id.operationId);
      const scope = this.createScope(id.operationId, identity);
      void scope.enqueue("started", input.stage, input.details);
      return scope.publicScope;
    } catch {
      this.recordWriteFailure(context);
      return createNoopScope(id.operationId);
    }
  }

  attach(
    operationId: string,
    input: OperationIdentityInput,
  ): OperationJournalScope {
    const context = createHealthContext();
    if (!isValidOperationId(operationId)) {
      this.recordWriteFailure(context);
      return createNoopScope(trustedFallbackOperationId());
    }
    try {
      const identity = snapshotIdentity(input, operationId);
      return this.createScope(operationId, identity).publicScope;
    } catch {
      this.recordWriteFailure(context);
      return createNoopScope(operationId);
    }
  }

  async list(input: {
    days: 7 | 30;
    now: Date;
  }): Promise<OperationJournalListResult> {
    try {
      const result = await this.repository.readRange(input);
      return snapshotListResult(result, input.now, this.health);
    } catch {
      this.recordMaintenanceFailure(createHealthContext());
      return emptyListResult(this.health);
    }
  }

  subscribe(listener: (event: OperationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getHealth(): OperationJournalHealth {
    return this.health;
  }

  async stats(now: Date): Promise<OperationJournalStats> {
    try {
      return await this.repository.stats(now);
    } catch {
      this.recordMaintenanceFailure(createHealthContext());
      return EMPTY_STATS;
    }
  }

  async prune(now: Date): Promise<void> {
    try {
      await this.repository.prune(now);
    } catch {
      this.recordMaintenanceFailure({
        writeNotified: false,
        maintenanceNotified: false,
      });
    }
  }

  async clear(): Promise<void> {
    try {
      await this.repository.clear();
    } catch {
      this.recordMaintenanceFailure({
        writeNotified: false,
        maintenanceNotified: false,
      });
    }
  }

  async createSafeExport(input: { days: 7 | 30; now: Date }): Promise<string> {
    try {
      const result = await this.list(input);
      return createSafeOperationJournalExport({
        generatedAt: input.now.toISOString(),
        rangeDays: input.days,
        health: result.health,
        operations: result.operations,
      });
    } catch {
      this.recordMaintenanceFailure(createHealthContext());
      throw new OperationJournalServiceError();
    }
  }

  private createOperationId(): OperationIdResult {
    try {
      const operationId = this.createId();
      if (isValidOperationId(operationId)) {
        return Object.freeze({ operationId, usable: true });
      }
    } catch {
      // Fall back to a trusted UUID only for a non-persisting scope.
    }
    return Object.freeze({
      operationId: trustedFallbackOperationId(),
      usable: false,
    });
  }

  private createScope(
    operationId: string,
    identity: OperationIdentityInput,
  ): {
    readonly publicScope: OperationJournalScope;
    enqueue(
      status: "started",
      stage: OperationStage,
      details: OperationDetails,
    ): Promise<void>;
  } {
    const context = createHealthContext();
    let tail = Promise.resolve();
    let terminal = false;

    const enqueue = (
      status: "started" | "progress" | "succeeded" | "failed" | "aborted",
      stage: OperationStage,
      details: OperationDetails,
    ): Promise<void> => {
      let event: OperationEvent;
      try {
        event = snapshotOperationEvent({
          schemaVersion: 1,
          eventId: this.createId(),
          operationId,
          occurredAt: this.clock().toISOString(),
          ...identity,
          stage,
          status,
          details,
        });
      } catch {
        this.recordWriteFailure(context);
        return Promise.resolve();
      }
      const queued = tail.then(async () => this.safeAppend(event, context));
      tail = queued;
      return queued;
    };

    const ignored = (): Promise<void> => Promise.resolve();
    const publicScope: OperationJournalScope = Object.freeze({
      operationId,
      progress: (stage: OperationStage, details: OperationDetails) =>
        terminal ? ignored() : enqueue("progress", stage, details),
      succeed: (stage: OperationStage, details: OperationDetails) => {
        if (terminal) return ignored();
        terminal = true;
        return enqueue("succeeded", stage, details);
      },
      fail: (
        stage: OperationStage,
        errorCode: OperationErrorCode,
        details: OperationDetails = {},
      ) => {
        if (terminal) return ignored();
        terminal = true;
        return enqueue("failed", stage, detailsWithError(details, errorCode));
      },
      abort: (stage: OperationStage) => {
        if (terminal) return ignored();
        terminal = true;
        return enqueue("aborted", stage, { errorCode: "aborted" });
      },
    });

    return { publicScope, enqueue };
  }

  private async safeAppend(
    event: OperationEvent,
    context: HealthContext,
  ): Promise<void> {
    let result: OperationJournalAppendResult;
    try {
      result = await this.repository.append(event);
    } catch {
      this.recordWriteFailure(context);
      return;
    }
    if (result.maintenanceIncomplete) {
      this.recordMaintenanceFailure(context);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A view listener cannot affect persistence or other listeners.
      }
    }
  }

  private recordWriteFailure(context: HealthContext): void {
    const occurredAt = safeClockIso(this.clock);
    this.health = Object.freeze({
      ...this.health,
      writeIncomplete: true,
      lastWriteFailureAt: occurredAt,
    });
    if (!context.writeNotified) {
      context.writeNotified = true;
      this.notifyHealthChange();
    }
  }

  private recordMaintenanceFailure(context: HealthContext): void {
    const occurredAt = safeClockIso(this.clock);
    this.health = Object.freeze({
      ...this.health,
      maintenanceIncomplete: true,
      lastMaintenanceFailureAt: occurredAt,
    });
    if (!context.maintenanceNotified) {
      context.maintenanceNotified = true;
      this.notifyHealthChange();
    }
  }

  private notifyHealthChange(): void {
    try {
      this.onHealthChange?.(this.health);
    } catch {
      // Health reporting is best-effort and must not recurse into the journal.
    }
  }
}

function snapshotIdentity(
  input: OperationIdentityInput,
  operationId: string,
): OperationIdentityInput {
  const stage = validationStage(input.category);
  const event = snapshotOperationEvent({
    schemaVersion: 1,
    eventId: VALIDATION_ID,
    operationId,
    occurredAt: VALIDATION_TIME,
    category: input.category,
    action: input.action,
    trigger: input.trigger,
    subject: input.subject,
    stage,
    status: "started",
    details: {},
  });
  return Object.freeze({
    category: event.category,
    action: event.action,
    trigger: event.trigger,
    subject: event.subject,
  });
}

function isValidOperationId(operationId: string): boolean {
  try {
    snapshotOperationEvent({
      schemaVersion: 1,
      eventId: VALIDATION_ID,
      operationId,
      occurredAt: VALIDATION_TIME,
      category: "transcript",
      action: "retrieve",
      trigger: "system",
      subject: {},
      stage: "requested",
      status: "started",
      details: {},
    });
    return true;
  } catch {
    return false;
  }
}

function trustedFallbackOperationId(): string {
  const candidates = [
    () => globalThis.crypto.randomUUID(),
    () => activeWindow.crypto.randomUUID(),
  ];
  for (const candidate of candidates) {
    try {
      const operationId = candidate();
      if (isValidOperationId(operationId)) return operationId;
    } catch {
      // Try the next bounded trusted source.
    }
  }
  return VALIDATION_ID;
}

function createNoopScope(operationId: string): OperationJournalScope {
  const resolved = (): Promise<void> => Promise.resolve();
  return Object.freeze({
    operationId,
    progress: resolved,
    succeed: resolved,
    fail: resolved,
    abort: resolved,
  });
}

function createHealthContext(): HealthContext {
  return { writeNotified: false, maintenanceNotified: false };
}

function validationStage(category: OperationCategory): OperationStage {
  switch (category) {
    case "transcript":
      return "requested";
    case "ai":
    case "refresh":
      return "preparing";
    case "subscription":
      return "validating";
  }
}

function detailsWithError(
  details: OperationDetails,
  errorCode: OperationErrorCode,
): OperationDetails {
  try {
    if (
      typeof details !== "object" ||
      details === null ||
      Object.getPrototypeOf(details) !== Object.prototype
    ) {
      return details;
    }
    const output: Record<PropertyKey, unknown> = {};
    for (const key of Reflect.ownKeys(details)) {
      if (key === "errorCode") continue;
      const descriptor = Object.getOwnPropertyDescriptor(details, key);
      if (descriptor === undefined || !("value" in descriptor)) return details;
      Object.defineProperty(output, key, descriptor);
    }
    output.errorCode = errorCode;
    return output as OperationDetails;
  } catch {
    return Object.create(null) as OperationDetails;
  }
}

function snapshotListResult(
  result: OperationJournalReadResult,
  now: Date,
  health: OperationJournalHealth,
): OperationJournalListResult {
  return Object.freeze({
    operations: aggregateOperationEvents(result.events, now),
    incompleteDates: Object.freeze([...result.incompleteDates]),
    corruptDates: Object.freeze([...result.corruptDates]),
    truncated: result.truncated,
    health,
  });
}

function emptyListResult(
  health: OperationJournalHealth,
): OperationJournalListResult {
  return Object.freeze({
    operations: Object.freeze([]),
    incompleteDates: Object.freeze([]),
    corruptDates: Object.freeze([]),
    truncated: true,
    health,
  });
}

function safeClockIso(clock: () => Date): string {
  try {
    const now = clock();
    if (Number.isFinite(now.getTime())) return now.toISOString();
  } catch {
    // Fall through to a bounded valid sentinel instant.
  }
  return VALIDATION_TIME;
}

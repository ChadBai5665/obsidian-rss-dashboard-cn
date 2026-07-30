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

const VALIDATION_ID = "00000000-0000-4000-8000-000000000000";
const VALIDATION_TIME = "2000-01-01T00:00:00.000Z";
const EMPTY_HEALTH: OperationJournalHealth = Object.freeze({
  writeIncomplete: false,
  maintenanceIncomplete: false,
});

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
    const identity = snapshotIdentity(input);
    const operationId = this.createId();
    const scope = this.createScope(operationId, identity);
    void scope.enqueue("started", input.stage, input.details);
    return scope.publicScope;
  }

  attach(
    operationId: string,
    input: OperationIdentityInput,
  ): OperationJournalScope {
    const identity = snapshotIdentity(input, operationId);
    return this.createScope(operationId, identity).publicScope;
  }

  async list(input: {
    days: 7 | 30;
    now: Date;
  }): Promise<OperationJournalListResult> {
    const result = await this.repository.readRange(input);
    return snapshotListResult(result, input.now, this.health);
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

  stats(now: Date): Promise<OperationJournalStats> {
    return this.repository.stats(now);
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
    const result = await this.list(input);
    return createSafeOperationJournalExport({
      generatedAt: input.now.toISOString(),
      rangeDays: input.days,
      health: result.health,
      operations: result.operations,
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
    const context: HealthContext = {
      writeNotified: false,
      maintenanceNotified: false,
    };
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
  operationId = VALIDATION_ID,
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

function safeClockIso(clock: () => Date): string {
  try {
    const now = clock();
    if (Number.isFinite(now.getTime())) return now.toISOString();
  } catch {
    // Fall through to a bounded valid sentinel instant.
  }
  return VALIDATION_TIME;
}

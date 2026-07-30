import {
  snapshotOperationEvent,
  type OperationEvent,
  type OperationStatus,
  type OperationSubject,
} from "./operation-event";

export interface OperationSummary {
  readonly operationId: string;
  readonly category: OperationEvent["category"];
  readonly action: OperationEvent["action"];
  readonly trigger: OperationEvent["trigger"];
  readonly subject: Readonly<OperationSubject>;
  readonly events: readonly OperationEvent[];
  readonly startedAt: string;
  readonly lastOccurredAt: string;
  readonly finishedAt?: string;
  readonly status: OperationStatus;
  readonly durationMs: number;
  readonly confirmedPaidRequests: 0 | 1 | 2;
  readonly possiblySent: boolean;
}

const INTERRUPTION_WINDOWS_MS: Readonly<
  Record<OperationEvent["category"], number>
> = Object.freeze({
  transcript: 30 * 60 * 1_000,
  ai: 30 * 60 * 1_000,
  refresh: 2 * 60 * 60 * 1_000,
  subscription: 10 * 60 * 1_000,
});

export function aggregateOperationEvents(
  events: readonly OperationEvent[],
  now: Date,
): readonly OperationSummary[] {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs))
    throw new TypeError("Invalid operation journal time.");

  const ordered = events
    .flatMap((event) => {
      try {
        return [snapshotOperationEvent(event)];
      } catch {
        return [];
      }
    })
    .sort(compareEvents);
  const seenEventIds = new Set<string>();
  const byOperation = new Map<string, OperationEventGroup>();
  for (const event of ordered) {
    if (seenEventIds.has(event.eventId)) continue;
    seenEventIds.add(event.eventId);
    const operation = byOperation.get(event.operationId);
    if (operation === undefined) {
      byOperation.set(event.operationId, {
        identity: identityOf(event),
        events: [event],
        conflicted: false,
      });
    } else if (!sameIdentity(operation.identity, event)) {
      operation.conflicted = true;
    } else {
      operation.events.push(event);
    }
  }

  return Object.freeze(
    [...byOperation.values()]
      .filter((operation) => !operation.conflicted)
      .map((operation) => summarize(operation.events, nowMs))
      .sort(
        (left, right) =>
          right.lastOccurredAt.localeCompare(left.lastOccurredAt) ||
          left.operationId.localeCompare(right.operationId),
      ),
  );
}

interface OperationIdentity {
  readonly category: OperationEvent["category"];
  readonly action: OperationEvent["action"];
  readonly trigger: OperationEvent["trigger"];
  readonly itemId?: string;
  readonly sourceId?: string;
  readonly label?: string;
}

interface OperationEventGroup {
  readonly identity: OperationIdentity;
  readonly events: OperationEvent[];
  conflicted: boolean;
}

function identityOf(event: OperationEvent): OperationIdentity {
  return {
    category: event.category,
    action: event.action,
    trigger: event.trigger,
    ...event.subject,
  };
}

function sameIdentity(
  identity: OperationIdentity,
  event: OperationEvent,
): boolean {
  return (
    identity.category === event.category &&
    identity.action === event.action &&
    identity.trigger === event.trigger &&
    identity.itemId === event.subject.itemId &&
    identity.sourceId === event.subject.sourceId &&
    identity.label === event.subject.label
  );
}

function summarize(
  events: readonly OperationEvent[],
  nowMs: number,
): OperationSummary {
  const first = events[0];
  if (first === undefined)
    throw new TypeError("Cannot summarize an empty operation.");
  const terminal = [...events]
    .reverse()
    .find((event) => isTerminal(event.status));
  const status =
    terminal?.status ?? derivedStatus(first.category, events, nowMs);
  const startedAt = first.occurredAt;
  const lastOccurredAt = events[events.length - 1]?.occurredAt ?? startedAt;
  const finishedAt = terminal?.occurredAt;
  const durationEnd = finishedAt ?? lastOccurredAt;
  const confirmedPaidRequests = events.reduce<0 | 1 | 2>((current, event) => {
    const paid =
      "confirmedPaidRequests" in event.details
        ? event.details.confirmedPaidRequests
        : undefined;
    return paid === undefined || paid <= current ? current : paid;
  }, 0);
  const possiblySent = events.some(
    (event) =>
      "possiblySent" in event.details && event.details.possiblySent === true,
  );

  return Object.freeze({
    operationId: first.operationId,
    category: first.category,
    action: first.action,
    trigger: first.trigger,
    subject: first.subject,
    events: Object.freeze([...events]),
    startedAt,
    lastOccurredAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    status,
    durationMs: Math.max(0, Date.parse(durationEnd) - Date.parse(startedAt)),
    confirmedPaidRequests,
    possiblySent,
  });
}

function derivedStatus(
  category: OperationEvent["category"],
  events: readonly OperationEvent[],
  nowMs: number,
): OperationStatus {
  const latest = events[events.length - 1];
  if (latest === undefined) throw new TypeError("Operation event is missing.");
  if (latest.status === "interrupted") return "interrupted";
  const latestMs = Date.parse(latest.occurredAt);
  return nowMs - latestMs > INTERRUPTION_WINDOWS_MS[category]
    ? "interrupted"
    : latest.status;
}

function isTerminal(status: OperationStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "aborted" ||
    status === "interrupted"
  );
}

function compareEvents(left: OperationEvent, right: OperationEvent): number {
  return (
    left.occurredAt.localeCompare(right.occurredAt) ||
    left.eventId.localeCompare(right.eventId)
  );
}

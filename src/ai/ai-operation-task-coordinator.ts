import {
  AiOperationError,
  type AiOperationErrorCode,
  type AiOperationResult,
  type AiOperationRunInput,
  type AiOperationService,
} from "./ai-operation-service";
import type {
  AiAnalysisArtifact,
} from "./analysis-markdown-parser";
import type { AnalysisRepository } from "./analysis-repository";
import {
  AI_ANALYSIS_CONTENT_BASES,
  AI_ANALYSIS_OPERATIONS,
  AI_ANALYSIS_PROVIDER_KINDS,
  MAX_AI_ANALYSIS_INPUT_CHARACTER_COUNT,
  MAX_AI_ANALYSIS_METADATA_CHARACTERS,
  MAX_AI_ANALYSIS_TEXT_CHARACTERS,
  isCanonicalAiAnalysisTimestamp,
  isValidAiAnalysisSourceUrl,
  safeAnalysisText,
  snapshotAiAnalysisResult,
  type AiAnalysisResult,
} from "./analysis-result";
import type { AiProviderKind } from "./ai-types";
import type { AiOperation } from "./prompts/prompt-types";
import type {
  CollectedItem,
  ContentBasis,
  SourceType,
} from "../collection/collected-item";
import {
  snapshotOperationEvent,
  type AiOperationDetails,
  type OperationDetails,
  type OperationErrorCode,
  type OperationStage,
} from "../operation-journal/operation-event";
import type {
  OperationBeginInput,
  OperationJournalPort,
} from "../operation-journal/operation-journal-service";
import { normalizeConnectionId } from "../security/connection-id";

export type AiTaskStatus =
  | "idle"
  | "preparing"
  | "generating"
  | "saving"
  | "complete"
  | "failed"
  | "aborted";

export interface AiTaskSnapshot {
  key: string;
  itemId: string;
  operation: AiOperation;
  status: AiTaskStatus;
  text: string;
  connectionId?: string;
  connectionName?: string;
  model?: string;
  contentBasis?: ContentBasis;
  artifactPath?: string;
  createdAt?: string;
  errorCode?: AiOperationErrorCode;
}

export interface StartAiTaskInput {
  operation: AiOperation;
  item: CollectedItem;
  connectionId: string;
  fetchFullText: boolean;
}

export interface AiOperationTaskCoordinatorDependencies {
  service: Pick<AiOperationService, "run">;
  repository: Pick<AnalysisRepository, "latest" | "save">;
  createResultId?: () => string;
  now?: () => string;
  operationJournal?: OperationJournalPort;
}

type TaskListener = (state: AiTaskSnapshot) => void;

interface StartInputSnapshot {
  operation: AiOperation;
  item: CollectedItem;
  itemId: string;
  sourceUrl?: string;
  connectionId: string;
  fetchFullText: boolean;
}

interface DeferredSnapshot {
  promise: Promise<AiTaskSnapshot>;
  resolve: (snapshot: AiTaskSnapshot) => void;
}

interface QueuedRegeneration {
  request: StartInputSnapshot;
  promise: Promise<AiTaskSnapshot>;
}

interface TaskRecord {
  internalKey: string;
  itemId: string;
  operation: AiOperation;
  listeners: Set<TaskListener>;
  snapshot: AiTaskSnapshot;
  promise: Promise<AiTaskSnapshot>;
  resolveTerminal?: (snapshot: AiTaskSnapshot) => void;
  controller?: AbortController;
  historyPromise?: Promise<AiTaskSnapshot>;
  queuedRegeneration?: QueuedRegeneration;
  active: boolean;
  saveStarted: boolean;
  sawDelta: boolean;
  receivedFirstDelta: boolean;
  journalTimeline?: AiOperationJournalTimeline;
}

interface AiOperationJournalTimeline {
  scope?: SafeOperationJournalScope;
  details: Readonly<AiOperationDetails>;
  stage: OperationStage;
  started: boolean;
  prepared: boolean;
  terminal: boolean;
}

interface SafeOperationJournalScope {
  readonly operationId: string;
  readonly progress: (stage: OperationStage, details: OperationDetails) => unknown;
  readonly succeed: (stage: OperationStage, details: OperationDetails) => unknown;
  readonly fail: (
    stage: OperationStage,
    errorCode: OperationErrorCode,
    details?: OperationDetails,
  ) => unknown;
  readonly abort: (stage: OperationStage) => unknown;
}

const STABLE_ITEM_ID = /^[a-f0-9]{64}$/u;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OPERATIONS: ReadonlySet<string> = new Set(AI_ANALYSIS_OPERATIONS);
const PROVIDER_KINDS: ReadonlySet<string> =
  new Set(AI_ANALYSIS_PROVIDER_KINDS);
const CONTENT_BASES: ReadonlySet<string> =
  new Set(AI_ANALYSIS_CONTENT_BASES);
const SOURCE_TYPES: ReadonlySet<string> = new Set([
  "rss",
  "atom",
  "json",
  "podcast",
  "website",
  "youtube",
  "x-account",
  "x-topic",
]);
const OBSERVATION_TYPES = new Set(["new", "updated", "rediscovered"]);
const COLLECTION_STATUSES = new Set(["collected", "partial", "parse-error"]);
const MAX_ITEM_METADATA_CHARACTERS = 20_000;
const MAX_ITEM_TOPICS = 10_000;
const MAX_ARTIFACT_PATH_CHARACTERS = 20_000;
const PUBLIC_ERROR_CODES: ReadonlySet<string> = new Set([
  "missing-key",
  "invalid-connection",
  "connection-disabled",
  "invalid-request",
  "invalid-key",
  "insufficient-balance",
  "timeout",
  "rate-limited",
  "provider-failure",
  "provider-rejected",
  "network-failure",
  "aborted",
  "malformed-response",
  "response-too-large",
  "empty-output",
  "secret-store-failure",
  "connection-not-found",
  "invalid-operation",
  "selection-failed",
]);
const OPERATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const JOURNAL_VALIDATION_ID = "00000000-0000-4000-8000-000000000000";
const JOURNAL_VALIDATION_TIME = "2000-01-01T00:00:00.000Z";

/**
 * Owns one durable generation task per canonical item and operation. UI
 * listeners never own task lifetime and can safely detach or reattach.
 */
export class AiOperationTaskCoordinator {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly executions = new Set<Promise<void>>();
  private readonly runOperation: (
    input: AiOperationRunInput,
  ) => Promise<AiOperationResult>;
  private readonly latestArtifact: (
    itemId: string,
    operation: AiOperation,
  ) => Promise<AiAnalysisArtifact | null>;
  private readonly saveAnalysis: (result: unknown) => Promise<string>;
  private readonly createResultId: () => string;
  private readonly now: () => string;
  private readonly beginOperationJournal?: (
    input: OperationBeginInput,
  ) => unknown;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;

  constructor(dependencies: AiOperationTaskCoordinatorDependencies) {
    const root = plainDataRecord(dependencies);
    const service = ownData(root, "service");
    const repository = ownData(root, "repository");
    const run = dataMethod(service, "run");
    const latest = dataMethod(repository, "latest");
    const save = dataMethod(repository, "save");
    const createResultId = ownData(root, "createResultId");
    const now = ownData(root, "now");
    const operationJournal = ownData(root, "operationJournal");
    const beginOperationJournal = dataMethod(operationJournal, "begin");
    if (
      !root ||
      !run ||
      !latest ||
      !save ||
      (createResultId !== undefined && typeof createResultId !== "function") ||
      (now !== undefined && typeof now !== "function")
    ) {
      throw new AiOperationError("invalid-request");
    }
    this.runOperation = (input) =>
      Reflect.apply(run, service, [input]) as Promise<AiOperationResult>;
    this.latestArtifact = (itemId, operation) =>
      Reflect.apply(latest, repository, [itemId, operation]) as Promise<
        AiAnalysisArtifact | null
      >;
    this.saveAnalysis = (result) =>
      Reflect.apply(save, repository, [result]) as Promise<string>;
    this.createResultId = (createResultId as (() => string) | undefined) ??
      defaultResultId;
    this.now = (now as (() => string) | undefined) ?? defaultNow;
    if (beginOperationJournal) {
      this.beginOperationJournal = (input) =>
        Reflect.apply(beginOperationJournal, operationJournal, [input]);
    }
  }

  loadLatest(
    itemId: string,
    operation: AiOperation,
  ): Promise<AiTaskSnapshot> {
    let identity: ReturnType<typeof snapshotTaskIdentity>;
    try {
      this.assertRunning();
      identity = snapshotTaskIdentity(itemId, operation);
    } catch (error) {
      return Promise.reject(publicInputError(error));
    }
    const existing = this.getOrCreateIdle(identity.itemId, identity.operation);
    if (existing.snapshot.status !== "idle") return existing.promise;
    if (existing.historyPromise) return existing.historyPromise;

    const historyPromise = this.readLatest(existing);
    existing.historyPromise = historyPromise;
    void historyPromise.finally(() => {
      if (existing.historyPromise === historyPromise) {
        existing.historyPromise = undefined;
      }
    }).catch(() => undefined);
    return historyPromise;
  }

  start(input: StartAiTaskInput): Promise<AiTaskSnapshot> {
    let request: StartInputSnapshot;
    try {
      this.assertRunning();
      request = snapshotStartInput(input);
    } catch (error) {
      return Promise.reject(publicInputError(error));
    }
    const key = internalTaskKey(request.itemId, request.operation);
    const existing = this.tasks.get(key);
    if (
      existing &&
      (existing.snapshot.status === "preparing" ||
        existing.snapshot.status === "generating" ||
        existing.snapshot.status === "saving" ||
        existing.snapshot.status === "complete")
    ) {
      return existing.promise;
    }
    return this.beginGeneration(request, existing);
  }

  regenerate(input: StartAiTaskInput): Promise<AiTaskSnapshot> {
    let request: StartInputSnapshot;
    try {
      this.assertRunning();
      request = snapshotStartInput(input);
    } catch (error) {
      return Promise.reject(publicInputError(error));
    }
    const existing = this.tasks.get(
      internalTaskKey(request.itemId, request.operation),
    );
    if (existing?.active && existing.saveStarted) {
      return this.queueRegeneration(existing, request);
    }
    return this.beginGeneration(request, existing);
  }

  subscribe(
    itemId: string,
    operation: AiOperation,
    listener: (state: AiTaskSnapshot) => void,
  ): () => void {
    this.assertRunning();
    const identity = snapshotTaskIdentity(itemId, operation);
    if (typeof listener !== "function") {
      throw new AiOperationError("invalid-request");
    }
    const task = this.getOrCreateIdle(identity.itemId, identity.operation);
    task.listeners.add(listener);
    notifyListener(listener, task.snapshot);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      task.listeners.delete(listener);
    };
  }

  abort(itemId: string, operation: AiOperation): void {
    const identity = snapshotTaskIdentity(itemId, operation);
    const task = this.tasks.get(
      internalTaskKey(identity.itemId, identity.operation),
    );
    if (task) this.abortTask(task, true);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    for (const task of this.tasks.values()) this.abortTask(task, true);
    const executions = [...this.executions];
    this.shutdownPromise = Promise.allSettled(executions).then(() => undefined);
    return this.shutdownPromise;
  }

  private assertRunning(): void {
    if (this.shuttingDown) throw new AiOperationError("invalid-request");
  }

  private getOrCreateIdle(
    itemId: string,
    operation: AiOperation,
  ): TaskRecord {
    const key = internalTaskKey(itemId, operation);
    const existing = this.tasks.get(key);
    if (existing) return existing;
    const snapshot = createSnapshot({
      itemId,
      operation,
      status: "idle",
      text: "",
    });
    const task: TaskRecord = {
      internalKey: key,
      itemId,
      operation,
      listeners: new Set(),
      snapshot,
      promise: Promise.resolve(snapshot),
      active: false,
      saveStarted: false,
      sawDelta: false,
      receivedFirstDelta: false,
    };
    this.tasks.set(key, task);
    return task;
  }

  private beginGeneration(
    request: StartInputSnapshot,
    existing: TaskRecord | undefined,
  ): Promise<AiTaskSnapshot> {
    const listeners = existing?.listeners ?? new Set<TaskListener>();
    if (existing?.active) this.abortTask(existing, false);
    const terminal = deferredSnapshot();
    const controller = new AbortController();
    const snapshot = createSnapshot({
      itemId: request.itemId,
      operation: request.operation,
      status: "preparing",
      text: "",
      connectionId: request.connectionId,
    });
    const task: TaskRecord = {
      internalKey: internalTaskKey(request.itemId, request.operation),
      itemId: request.itemId,
      operation: request.operation,
      listeners,
      snapshot,
      promise: terminal.promise,
      resolveTerminal: terminal.resolve,
      controller,
      active: true,
      saveStarted: false,
      sawDelta: false,
      receivedFirstDelta: false,
      journalTimeline: {
        details: Object.freeze({}),
        stage: "preparing",
        started: false,
        prepared: false,
        terminal: false,
      },
    };
    this.tasks.set(task.internalKey, task);
    this.notify(task);
    const execution = this.executeGeneration(task, request);
    this.executions.add(execution);
    void execution.finally(() => {
      this.executions.delete(execution);
    }).catch(() => undefined);
    return task.promise;
  }

  private queueRegeneration(
    savingTask: TaskRecord,
    request: StartInputSnapshot,
  ): Promise<AiTaskSnapshot> {
    if (savingTask.queuedRegeneration) {
      return savingTask.queuedRegeneration.promise;
    }
    const promise = savingTask.promise.then(() => {
      if (this.shuttingDown) {
        return createSnapshot({
          itemId: request.itemId,
          operation: request.operation,
          status: "aborted",
          text: "",
          connectionId: request.connectionId,
          errorCode: "aborted",
        });
      }
      try {
        return this.beginGeneration(
          request,
          this.tasks.get(savingTask.internalKey),
        );
      } catch {
        return createSnapshot({
          itemId: request.itemId,
          operation: request.operation,
          status: "failed",
          text: "",
          connectionId: request.connectionId,
          errorCode: "invalid-request",
        });
      }
    });
    savingTask.queuedRegeneration = { request, promise };
    void promise.finally(() => {
      if (savingTask.queuedRegeneration?.promise === promise) {
        savingTask.queuedRegeneration = undefined;
      }
    }).catch(() => undefined);
    return promise;
  }

  private async executeGeneration(
    task: TaskRecord,
    request: StartInputSnapshot,
  ): Promise<void> {
    this.updateActive(task, {
      status: "generating",
      text: task.snapshot.text,
    });
    let result: AiOperationResult;
    try {
      result = await this.runOperation({
        operation: request.operation,
        item: request.item,
        connectionId: request.connectionId,
        fetchFullText: request.fetchFullText,
        signal: task.controller?.signal,
        onPrepared: (metadata) => this.receivePrepared(task, metadata),
        onTextDelta: (delta) => this.receiveDelta(task, delta),
      });
    } catch (error) {
      if (!this.isCurrentActive(task)) return;
      const errorCode = operationErrorCode(error);
      if (errorCode === "aborted") {
        this.abortTask(task, true);
      } else {
        this.failTask(task, errorCode, false);
      }
      return;
    }
    if (!this.isCurrentActive(task)) return;

    let analysis: Readonly<AiAnalysisResult>;
    try {
      analysis = this.analysisResult(request, result, task);
    } catch {
      this.failTask(task, "invalid-request", true);
      return;
    }
    if (!this.isCurrentActive(task)) return;

    this.receivePrepared(task, {
      connectionName: analysis.connectionName,
      providerKind: analysis.providerKind,
      model: analysis.model,
      contentBasis: analysis.contentBasis,
    });
    if (!task.sawDelta) {
      this.updateActive(task, {
        status: "generating",
        text: analysis.text,
        connectionId: analysis.connectionId,
        connectionName: analysis.connectionName,
        model: analysis.model,
        contentBasis: analysis.contentBasis,
      });
    }
    this.recordJournalProgress(task, "saving", task.journalTimeline?.details ?? {});
    this.updateActive(task, {
      status: "saving",
      text: analysis.text,
      connectionId: analysis.connectionId,
      connectionName: analysis.connectionName,
      model: analysis.model,
      contentBasis: analysis.contentBasis,
      createdAt: analysis.createdAt,
    });
    if (!this.isCurrentActive(task)) return;
    task.saveStarted = true;

    let artifactPath: unknown;
    try {
      artifactPath = await this.saveAnalysis(analysis);
    } catch {
      if (this.isCurrentActive(task)) {
        this.failTask(task, "provider-failure", false, "cache-save-failed");
      }
      return;
    }
    if (!this.isCurrentActive(task)) return;
    if (!safeArtifactPath(artifactPath, analysis)) {
      this.failTask(task, "invalid-request", false, "cache-save-failed");
      return;
    }
    this.recordJournalSuccess(task, artifactPath);
    this.completeTask(task, createSnapshot({
      itemId: task.itemId,
      operation: task.operation,
      status: "complete",
      text: analysis.text,
      connectionId: analysis.connectionId,
      connectionName: analysis.connectionName,
      model: analysis.model,
      contentBasis: analysis.contentBasis,
      artifactPath,
      createdAt: analysis.createdAt,
    }));
  }

  private analysisResult(
    request: StartInputSnapshot,
    value: unknown,
    task: TaskRecord,
  ): Readonly<AiAnalysisResult> {
    const record = plainDataRecord(value);
    if (!record) throw new AiOperationError("invalid-request");
    const operation = ownData(record, "operation");
    const itemId = ownData(record, "itemId");
    const connectionId = ownData(record, "connectionId");
    const text = ownData(record, "text");
    if (
      operation !== request.operation ||
      itemId !== request.itemId ||
      connectionId !== request.connectionId ||
      typeof text !== "string" ||
      (task.sawDelta && text !== task.snapshot.text)
    ) {
      throw new AiOperationError("invalid-request");
    }
    const id = this.createSafeResultId();
    const createdAt = this.createSafeTimestamp();
    const result = snapshotAiAnalysisResult({
      schemaVersion: 1,
      id,
      itemId,
      ...(request.sourceUrl ? { sourceUrl: request.sourceUrl } : {}),
      operation,
      createdAt,
      connectionId,
      connectionName: ownData(record, "connectionName"),
      providerKind: ownData(record, "providerKind"),
      model: ownData(record, "model"),
      contentBasis: ownData(record, "contentBasis"),
      inputCharacterCount: ownData(record, "inputCharacterCount"),
      inputTruncated: ownData(record, "inputTruncated"),
      text,
    });
    return Object.freeze(result);
  }

  private createSafeResultId(): string {
    try {
      const id = this.createResultId();
      if (typeof id !== "string" || !CANONICAL_UUID.test(id)) {
        throw new AiOperationError("invalid-request");
      }
      return id;
    } catch {
      throw new AiOperationError("invalid-request");
    }
  }

  private createSafeTimestamp(): string {
    try {
      const timestamp = this.now();
      if (
        typeof timestamp !== "string" ||
        !isCanonicalAiAnalysisTimestamp(timestamp)
      ) {
        throw new AiOperationError("invalid-request");
      }
      return timestamp;
    } catch {
      throw new AiOperationError("invalid-request");
    }
  }

  private receivePrepared(task: TaskRecord, value: unknown): void {
    if (!this.isCurrentActive(task)) return;
    const timeline = task.journalTimeline;
    if (!timeline || timeline.terminal || timeline.prepared) return;
    const details = snapshotAiOperationJournalDetails(task.operation, value);
    if (!details) return;
    timeline.details = details;
    timeline.prepared = true;
    this.ensureJournalStarted(task, details);
    this.recordJournalProgress(task, "generating", details);
  }

  private ensureJournalStarted(
    task: TaskRecord,
    details: Readonly<AiOperationDetails>,
  ): void {
    const timeline = task.journalTimeline;
    if (!timeline || timeline.started) return;
    timeline.started = true;
    if (!this.beginOperationJournal) return;
    let scope: unknown;
    try {
      scope = this.beginOperationJournal({
        category: "ai",
        action: task.operation,
        trigger: "manual",
        subject: { itemId: task.itemId },
        stage: "preparing",
        details,
      });
    } catch {
      return;
    }
    timeline.scope = snapshotJournalScope(scope);
  }

  private recordJournalProgress(
    task: TaskRecord,
    stage: OperationStage,
    details: Readonly<AiOperationDetails>,
  ): void {
    const timeline = task.journalTimeline;
    if (!timeline || timeline.terminal) return;
    this.ensureJournalStarted(task, details);
    timeline.stage = stage;
    const scope = timeline.scope;
    if (scope) safelyRecordJournal(() => scope.progress(stage, details));
  }

  private recordJournalFailure(
    task: TaskRecord,
    errorCode: OperationErrorCode,
  ): void {
    const timeline = task.journalTimeline;
    if (!timeline || timeline.terminal) return;
    this.ensureJournalStarted(task, timeline.details);
    timeline.terminal = true;
    const scope = timeline.scope;
    if (scope) {
      safelyRecordJournal(() =>
        scope.fail(timeline.stage, errorCode, timeline.details));
    }
  }

  private recordJournalAbort(task: TaskRecord): void {
    const timeline = task.journalTimeline;
    if (!timeline || timeline.terminal) return;
    this.ensureJournalStarted(task, timeline.details);
    timeline.terminal = true;
    const scope = timeline.scope;
    if (scope) safelyRecordJournal(() => scope.abort(timeline.stage));
  }

  private recordJournalSuccess(task: TaskRecord, artifactPath: string): void {
    const timeline = task.journalTimeline;
    if (!timeline || timeline.terminal) return;
    this.ensureJournalStarted(task, timeline.details);
    const completedDetails = projectAiOperationJournalDetails(task.operation, {
      ...timeline.details,
      artifactPath,
    }) ?? timeline.details;
    timeline.terminal = true;
    timeline.stage = "completed";
    const scope = timeline.scope;
    if (scope) {
      safelyRecordJournal(() => scope.succeed("completed", completedDetails));
    }
  }

  private receiveDelta(task: TaskRecord, value: unknown): void {
    if (!this.isCurrentActive(task)) return;
    if (typeof value !== "string" || value.length === 0) {
      this.failTask(task, "invalid-request", true);
      return;
    }
    const nextLength = task.snapshot.text.length + value.length;
    if (
      !Number.isSafeInteger(nextLength) ||
      nextLength > MAX_AI_ANALYSIS_TEXT_CHARACTERS
    ) {
      this.failTask(task, "invalid-request", true);
      return;
    }
    if (!task.receivedFirstDelta) {
      task.receivedFirstDelta = true;
      this.recordJournalProgress(
        task,
        "streaming",
        task.journalTimeline?.details ?? {},
      );
    }
    task.sawDelta = true;
    this.updateActive(task, {
      status: "generating",
      text: task.snapshot.text + value,
    });
  }

  private async readLatest(task: TaskRecord): Promise<AiTaskSnapshot> {
    let artifact: unknown;
    try {
      artifact = await this.latestArtifact(task.itemId, task.operation);
    } catch {
      if (this.isCurrent(task) && task.snapshot.status === "idle") {
        return this.replaceNonActiveSnapshot(
          task,
          createFailureSnapshot(task, "provider-failure"),
        );
      }
      return this.tasks.get(task.internalKey)?.snapshot ?? task.snapshot;
    }
    if (!this.isCurrent(task) || task.snapshot.status !== "idle") {
      return this.tasks.get(task.internalKey)?.snapshot ?? task.snapshot;
    }
    if (artifact === null) return task.snapshot;
    const historical = snapshotHistoryArtifact(
      artifact,
      task.itemId,
      task.operation,
    );
    if (!historical) {
      return this.replaceNonActiveSnapshot(
        task,
        createFailureSnapshot(task, "invalid-request"),
      );
    }
    return this.replaceNonActiveSnapshot(task, historical);
  }

  private updateActive(
    task: TaskRecord,
    changes: {
      status: "generating" | "saving";
      text: string;
      connectionId?: string;
      connectionName?: string;
      model?: string;
      contentBasis?: ContentBasis;
      createdAt?: string;
    },
  ): void {
    if (!this.isCurrentActive(task)) return;
    task.snapshot = createSnapshot({
      itemId: task.itemId,
      operation: task.operation,
      ...changes,
    });
    this.notify(task);
  }

  private failTask(
    task: TaskRecord,
    errorCode: AiOperationErrorCode,
    abort: boolean,
    journalErrorCode: OperationErrorCode = errorCode,
  ): void {
    if (!this.isCurrentActive(task)) return;
    if (abort && !task.controller?.signal.aborted) task.controller?.abort();
    this.recordJournalFailure(task, journalErrorCode);
    task.active = false;
    task.snapshot = createFailureSnapshot(task, errorCode);
    this.notify(task);
    this.resolveTerminal(task);
  }

  private abortTask(task: TaskRecord, notify: boolean): void {
    if (!task.active) return;
    // Repository writes have no cancellation contract. Once save starts, the
    // only truthful terminal state is its actual durable outcome.
    if (task.saveStarted) return;
    if (!task.controller?.signal.aborted) task.controller?.abort();
    this.recordJournalAbort(task);
    task.active = false;
    task.snapshot = createFailureSnapshot(task, "aborted", "aborted");
    if (notify && this.isCurrent(task)) this.notify(task);
    this.resolveTerminal(task);
  }

  private completeTask(task: TaskRecord, snapshot: AiTaskSnapshot): void {
    if (!this.isCurrentActive(task)) return;
    task.active = false;
    task.snapshot = snapshot;
    this.notify(task);
    this.resolveTerminal(task);
  }

  private replaceNonActiveSnapshot(
    task: TaskRecord,
    snapshot: AiTaskSnapshot,
  ): AiTaskSnapshot {
    if (!this.isCurrent(task)) {
      return this.tasks.get(task.internalKey)?.snapshot ?? task.snapshot;
    }
    task.snapshot = snapshot;
    task.promise = Promise.resolve(snapshot);
    this.notify(task);
    return snapshot;
  }

  private resolveTerminal(task: TaskRecord): void {
    const resolve = task.resolveTerminal;
    task.resolveTerminal = undefined;
    resolve?.(task.snapshot);
  }

  private notify(task: TaskRecord): void {
    for (const listener of [...task.listeners]) {
      notifyListener(listener, task.snapshot);
    }
  }

  private isCurrent(task: TaskRecord): boolean {
    return this.tasks.get(task.internalKey) === task;
  }

  private isCurrentActive(task: TaskRecord): boolean {
    return task.active && this.isCurrent(task);
  }
}

function snapshotStartInput(value: unknown): StartInputSnapshot {
  const record = exactDataRecord(value, [
    "operation",
    "item",
    "connectionId",
    "fetchFullText",
  ]);
  if (!record) throw new AiOperationError("invalid-request");
  const operation = ownData(record, "operation");
  if (typeof operation !== "string" || !OPERATIONS.has(operation)) {
    throw new AiOperationError("invalid-operation");
  }
  const connectionId = normalizeConnectionId(ownData(record, "connectionId"));
  if (!connectionId) throw new AiOperationError("connection-not-found");
  const fetchFullText = ownData(record, "fetchFullText");
  if (typeof fetchFullText !== "boolean") {
    throw new AiOperationError("invalid-request");
  }
  const item = snapshotCollectedItem(ownData(record, "item"));
  return {
    operation: operation as AiOperation,
    item,
    itemId: item.id,
    ...(item.url ? { sourceUrl: item.url } : {}),
    connectionId,
    fetchFullText,
  };
}

function snapshotCollectedItem(value: unknown): CollectedItem {
  const record = plainDataRecord(value);
  if (!record) throw new AiOperationError("invalid-request");
  const schemaVersion = ownData(record, "schemaVersion");
  const id = ownData(record, "id");
  const sourceType = ownData(record, "sourceType");
  const sourceId = ownData(record, "sourceId");
  const sourceName = ownData(record, "sourceName");
  const sourceBucket = ownData(record, "sourceBucket");
  const title = ownData(record, "title");
  const fetchedAt = ownData(record, "fetchedAt");
  const firstSeenAt = ownData(record, "firstSeenAt");
  const lastSeenAt = ownData(record, "lastSeenAt");
  const url = ownData(record, "url");
  const observationType = ownData(record, "observationType");
  const topics = snapshotTopics(ownData(record, "topics"));
  const excerpt = ownData(record, "excerpt");
  const contentBasis = ownData(record, "contentBasis");
  const read = ownData(record, "read");
  const starred = ownData(record, "starred");
  const saved = ownData(record, "saved");
  const collectionStatus = ownData(record, "collectionStatus");
  if (
    schemaVersion !== 1 ||
    typeof id !== "string" ||
    !STABLE_ITEM_ID.test(id) ||
    typeof sourceType !== "string" ||
    !SOURCE_TYPES.has(sourceType) ||
    !safeItemText(sourceId) ||
    !safeItemText(sourceName) ||
    !safeItemText(sourceBucket) ||
    !safeItemText(title) ||
    !safeTimestamp(fetchedAt) ||
    !safeTimestamp(firstSeenAt) ||
    !safeTimestamp(lastSeenAt) ||
    (url !== undefined && !isValidAiAnalysisSourceUrl(url)) ||
    typeof observationType !== "string" ||
    !OBSERVATION_TYPES.has(observationType) ||
    !topics ||
    (excerpt !== undefined && !safeOptionalItemText(excerpt)) ||
    typeof contentBasis !== "string" ||
    !CONTENT_BASES.has(contentBasis) ||
    typeof read !== "boolean" ||
    typeof starred !== "boolean" ||
    typeof saved !== "boolean" ||
    typeof collectionStatus !== "string" ||
    !COLLECTION_STATUSES.has(collectionStatus)
  ) {
    throw new AiOperationError("invalid-request");
  }
  const snapshot: CollectedItem = {
    schemaVersion: 1,
    id,
    sourceType: sourceType as SourceType,
    sourceId,
    sourceName,
    sourceBucket,
    title,
    fetchedAt,
    firstSeenAt,
    lastSeenAt,
    ...(url === undefined ? {} : { url }),
    observationType: observationType as CollectedItem["observationType"],
    topics,
    ...(excerpt === undefined || excerpt === "" ? {} : { excerpt }),
    contentBasis: contentBasis as ContentBasis,
    read,
    starred,
    saved,
    collectionStatus: collectionStatus as CollectedItem["collectionStatus"],
  };
  return Object.freeze(snapshot);
}

function snapshotTopics(value: unknown): string[] | undefined {
  try {
    if (
      !Array.isArray(value) ||
      Reflect.getPrototypeOf(value) !== Array.prototype ||
      value.length > MAX_ITEM_TOPICS
    ) {
      return undefined;
    }
    const topics: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        !descriptor ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string" ||
        descriptor.value.length > MAX_ITEM_METADATA_CHARACTERS
      ) {
        return undefined;
      }
      topics.push(descriptor.value);
    }
    Object.freeze(topics);
    return topics;
  } catch {
    return undefined;
  }
}

function snapshotTaskIdentity(
  itemId: unknown,
  operation: unknown,
): { itemId: string; operation: AiOperation } {
  if (typeof itemId !== "string" || !STABLE_ITEM_ID.test(itemId)) {
    throw new AiOperationError("invalid-request");
  }
  if (typeof operation !== "string" || !OPERATIONS.has(operation)) {
    throw new AiOperationError("invalid-operation");
  }
  return { itemId, operation: operation as AiOperation };
}

function snapshotHistoryArtifact(
  value: unknown,
  expectedItemId: string,
  expectedOperation: AiOperation,
): AiTaskSnapshot | undefined {
  const artifact = plainDataRecord(value);
  const path = ownData(artifact, "path");
  const record = plainDataRecord(ownData(artifact, "record"));
  if (!record) return undefined;
  const schemaVersion = ownData(record, "schemaVersion");
  const id = ownData(record, "id");
  const itemId = ownData(record, "itemId");
  const operation = ownData(record, "operation");
  const createdAt = ownData(record, "createdAt");
  const connectionIdValue = ownData(record, "connectionId");
  const connectionName = ownData(record, "connectionName");
  const providerKind = ownData(record, "providerKind");
  const model = ownData(record, "model");
  const contentBasis = ownData(record, "contentBasis");
  const inputCharacterCount = ownData(record, "inputCharacterCount");
  const inputTruncated = ownData(record, "inputTruncated");
  const text = ownData(record, "text");
  const connectionId = connectionIdValue === undefined
    ? undefined
    : normalizeConnectionId(connectionIdValue);
  if (
    schemaVersion !== 1 ||
    typeof id !== "string" ||
    !CANONICAL_UUID.test(id) ||
    itemId !== expectedItemId ||
    operation !== expectedOperation ||
    typeof createdAt !== "string" ||
    !isCanonicalAiAnalysisTimestamp(createdAt) ||
    (connectionIdValue !== undefined && connectionId !== connectionIdValue) ||
    !safeAnalysisText(connectionName, MAX_AI_ANALYSIS_METADATA_CHARACTERS) ||
    typeof providerKind !== "string" ||
    !PROVIDER_KINDS.has(providerKind) ||
    !safeAnalysisText(model, MAX_AI_ANALYSIS_METADATA_CHARACTERS) ||
    typeof contentBasis !== "string" ||
    !CONTENT_BASES.has(contentBasis) ||
    typeof inputCharacterCount !== "number" ||
    !Number.isSafeInteger(inputCharacterCount) ||
    inputCharacterCount < 0 ||
    inputCharacterCount > MAX_AI_ANALYSIS_INPUT_CHARACTER_COUNT ||
    typeof inputTruncated !== "boolean" ||
    !safeAnalysisText(text, MAX_AI_ANALYSIS_TEXT_CHARACTERS)
  ) {
    return undefined;
  }
  const pathCandidate: AiAnalysisResult = {
    schemaVersion: 1,
    id,
    itemId: expectedItemId,
    operation: expectedOperation,
    createdAt,
    connectionId: connectionId ?? "00000000-0000-4000-8000-000000000000",
    connectionName,
    providerKind: providerKind as AiProviderKind,
    model,
    contentBasis: contentBasis as ContentBasis,
    inputCharacterCount,
    inputTruncated,
    text,
  };
  if (!safeArtifactPath(path, pathCandidate)) return undefined;
  return createSnapshot({
    itemId: expectedItemId,
    operation: expectedOperation,
    status: "complete",
    text,
    ...(connectionId ? { connectionId } : {}),
    connectionName,
    model,
    contentBasis: contentBasis as ContentBasis,
    artifactPath: path,
    createdAt,
  });
}

function createFailureSnapshot(
  task: TaskRecord,
  errorCode: AiOperationErrorCode,
  status: "failed" | "aborted" = "failed",
): AiTaskSnapshot {
  return createSnapshot({
    itemId: task.itemId,
    operation: task.operation,
    status,
    text: task.snapshot.text,
    ...(task.snapshot.connectionId
      ? { connectionId: task.snapshot.connectionId }
      : {}),
    ...(task.snapshot.connectionName
      ? { connectionName: task.snapshot.connectionName }
      : {}),
    ...(task.snapshot.model ? { model: task.snapshot.model } : {}),
    ...(task.snapshot.contentBasis
      ? { contentBasis: task.snapshot.contentBasis }
      : {}),
    ...(task.snapshot.createdAt ? { createdAt: task.snapshot.createdAt } : {}),
    errorCode,
  });
}

function createSnapshot(input: {
  itemId: string;
  operation: AiOperation;
  status: AiTaskStatus;
  text: string;
  connectionId?: string;
  connectionName?: string;
  model?: string;
  contentBasis?: ContentBasis;
  artifactPath?: string;
  createdAt?: string;
  errorCode?: AiOperationErrorCode;
}): AiTaskSnapshot {
  return Object.freeze({
    key: publicTaskKey(input.itemId, input.operation),
    itemId: input.itemId,
    operation: input.operation,
    status: input.status,
    text: input.text,
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    ...(input.connectionName ? { connectionName: input.connectionName } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.contentBasis ? { contentBasis: input.contentBasis } : {}),
    ...(input.artifactPath ? { artifactPath: input.artifactPath } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  });
}

function snapshotAiOperationJournalDetails(
  operation: AiOperation,
  value: unknown,
): Readonly<AiOperationDetails> | undefined {
  const record = exactDataRecord(value, [
    "connectionName",
    "providerKind",
    "model",
    "contentBasis",
  ]);
  if (!record) return undefined;
  return projectAiOperationJournalDetails(operation, {
    connectionName: ownData(record, "connectionName") as string,
    providerKind: ownData(record, "providerKind") as AiProviderKind,
    model: ownData(record, "model") as string,
    contentBasis: ownData(record, "contentBasis") as ContentBasis,
  });
}

function projectAiOperationJournalDetails(
  operation: AiOperation,
  details: OperationDetails,
): Readonly<AiOperationDetails> | undefined {
  try {
    return snapshotOperationEvent({
      schemaVersion: 1,
      eventId: JOURNAL_VALIDATION_ID,
      operationId: JOURNAL_VALIDATION_ID,
      occurredAt: JOURNAL_VALIDATION_TIME,
      category: "ai",
      action: operation,
      trigger: "manual",
      stage: "preparing",
      status: "started",
      subject: {},
      details,
    }).details as Readonly<AiOperationDetails>;
  } catch {
    return undefined;
  }
}

function snapshotJournalScope(value: unknown): SafeOperationJournalScope | undefined {
  const operationId = ownObjectData(value, "operationId");
  const progress = dataMethod(value, "progress");
  const succeed = dataMethod(value, "succeed");
  const fail = dataMethod(value, "fail");
  const abort = dataMethod(value, "abort");
  if (
    typeof operationId !== "string" ||
    !OPERATION_ID.test(operationId) ||
    !progress ||
    !succeed ||
    !fail ||
    !abort
  ) {
    return undefined;
  }
  return Object.freeze({
    operationId,
    progress: (stage: OperationStage, details: OperationDetails) =>
      Reflect.apply(progress, value, [stage, details]),
    succeed: (stage: OperationStage, details: OperationDetails) =>
      Reflect.apply(succeed, value, [stage, details]),
    fail: (
      stage: OperationStage,
      errorCode: OperationErrorCode,
      details?: OperationDetails,
    ) => Reflect.apply(fail, value, [stage, errorCode, details]),
    abort: (stage: OperationStage) => Reflect.apply(abort, value, [stage]),
  });
}

function ownObjectData(value: unknown, key: string): unknown {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safelyRecordJournal(operation: () => unknown): void {
  try {
    const outcome = operation();
    if (
      outcome === null ||
      (typeof outcome !== "object" && typeof outcome !== "function")
    ) {
      return;
    }
    const assimilated = Promise.resolve(outcome);
    void Promise.prototype.then.call(
      assimilated,
      undefined,
      () => undefined,
    );
  } catch {
    // Operation history is optional and cannot alter generation or persistence.
  }
}

function safeArtifactPath(
  value: unknown,
  result: Pick<AiAnalysisResult, "itemId" | "operation" | "createdAt">,
): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_ARTIFACT_PATH_CHARACTERS ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  const analysisIndex = segments.length - 3;
  if (
    segments.some(
      (segment) => !segment || segment === "." || segment === "..",
    ) ||
    segments.length < 4 ||
    segments[analysisIndex] !== "analysis" ||
    segments[analysisIndex + 1] !== result.itemId
  ) {
    return false;
  }
  const filename = segments[segments.length - 1];
  if (!filename) return false;
  const stem = `${utcPathTimestamp(result.createdAt)}-${result.operation}`;
  if (filename === `${stem}.md`) return true;
  if (!filename.startsWith(`${stem}-`) || !filename.endsWith(".md")) {
    return false;
  }
  const collision = filename.slice(stem.length + 1, -3);
  const index = Number(collision);
  return (
    Number.isSafeInteger(index) &&
    index >= 2 &&
    index <= 10_000 &&
    String(index) === collision
  );
}

function utcPathTimestamp(value: string): string {
  return value.replace(/[-:.Z]/gu, "");
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | undefined {
  const record = plainDataRecord(value);
  if (!record) return undefined;
  try {
    const keys = Reflect.ownKeys(record);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) {
      return undefined;
    }
    return record;
  } catch {
    return undefined;
  }
}

function plainDataRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
    }
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function ownData(
  record: Record<string, unknown> | undefined,
  key: string,
): unknown {
  if (!record) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

type UnknownMethod = (this: unknown, ...args: unknown[]) => unknown;

function dataMethod(value: unknown, key: string): UnknownMethod | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    let current: object | null = value;
    while (current) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        return "value" in descriptor && typeof descriptor.value === "function"
          ? descriptor.value as UnknownMethod
          : undefined;
      }
      current = Reflect.getPrototypeOf(current);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function safeItemText(value: unknown): value is string {
  return safeAnalysisText(value, MAX_ITEM_METADATA_CHARACTERS);
}

function safeOptionalItemText(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= MAX_AI_ANALYSIS_TEXT_CHARACTERS &&
    (value.length === 0 ||
      safeAnalysisText(value, MAX_AI_ANALYSIS_TEXT_CHARACTERS));
}

function safeTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= 100 &&
    Number.isFinite(Date.parse(value));
}

function operationErrorCode(error: unknown): AiOperationErrorCode {
  if (
    error instanceof AiOperationError &&
    typeof error.code === "string" &&
    PUBLIC_ERROR_CODES.has(error.code)
  ) {
    return error.code;
  }
  return "provider-failure";
}

function publicInputError(error: unknown): AiOperationError {
  return error instanceof AiOperationError &&
      typeof error.code === "string" &&
      PUBLIC_ERROR_CODES.has(error.code)
    ? new AiOperationError(error.code)
    : new AiOperationError("invalid-request");
}

function notifyListener(listener: TaskListener, snapshot: AiTaskSnapshot): void {
  try {
    const outcome = Reflect.apply(listener, undefined, [snapshot]) as unknown;
    void Promise.resolve(outcome).catch(() => undefined);
  } catch {
    // Listener failures never affect task ownership or settlement.
  }
}

function deferredSnapshot(): DeferredSnapshot {
  let resolve!: (snapshot: AiTaskSnapshot) => void;
  const promise = new Promise<AiTaskSnapshot>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function internalTaskKey(itemId: string, operation: AiOperation): string {
  return `${itemId}\0${operation}`;
}

function publicTaskKey(itemId: string, operation: AiOperation): string {
  return `${itemId}:${operation}`;
}

function defaultResultId(): string {
  const id = window.crypto?.randomUUID?.();
  if (!id) throw new AiOperationError("invalid-request");
  return id;
}

function defaultNow(): string {
  return new Date().toISOString();
}

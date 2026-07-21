import { normalizePath, type Vault } from "obsidian";
import { toLocalCalendarDate } from "./local-calendar-day";

export interface SourceRefreshState {
  sourceId: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastSuccessDate?: string;
  status: "idle" | "success" | "error";
  errorCode?: string;
  errorMessage?: string;
}

interface PersistedSourceRefreshLedger {
  schemaVersion: 1;
  sources: Record<string, SourceRefreshState>;
}

const EMPTY_LEDGER = (): PersistedSourceRefreshLedger => ({
  schemaVersion: 1,
  sources: {},
});

export class SourceRefreshLedger {
  private readonly dataRoot: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly vault: Vault,
    dataRoot: string,
  ) {
    const trimmedRoot = dataRoot.trim();
    assertSafeDataRoot(trimmedRoot);
    this.dataRoot = normalizePath(trimmedRoot);
  }

  async getState(sourceId: string): Promise<SourceRefreshState | undefined> {
    const state = (await this.readLedger()).sources[sourceId];
    return state ? { ...state } : undefined;
  }

  async getStates(): Promise<SourceRefreshState[]> {
    return Object.values((await this.readLedger()).sources).map((state) => ({
      ...state,
    }));
  }

  async getSharedSuccessDate(sourceIds: string[]): Promise<string | undefined> {
    if (sourceIds.length === 0) {
      return undefined;
    }

    const sources = (await this.readLedger()).sources;
    const firstState = sources[sourceIds[0]];
    const firstDate =
      firstState?.status === "success" ? firstState.lastSuccessDate : undefined;
    if (!firstDate) {
      return undefined;
    }

    return sourceIds.every((sourceId) => {
      const state = sources[sourceId];
      return state?.status === "success" && state.lastSuccessDate === firstDate;
    })
      ? firstDate
      : undefined;
  }

  async haveAllSourcesSucceededOnDate(
    sourceIds: string[],
    localDate: string,
  ): Promise<boolean> {
    return (await this.getSharedSuccessDate(sourceIds)) === localDate;
  }

  async getSourceIdsWithStatus(
    status: SourceRefreshState["status"],
  ): Promise<string[]> {
    return (await this.getStates())
      .filter((state) => state.status === status)
      .map((state) => state.sourceId);
  }

  async recordAttempt(sourceId: string, attemptedAt: Date): Promise<void> {
    await this.update((ledger) => {
      const previous = ledger.sources[sourceId];
      ledger.sources[sourceId] = {
        ...previous,
        sourceId,
        lastAttemptAt: attemptedAt.toISOString(),
        status: "idle",
        errorCode: undefined,
        errorMessage: undefined,
      };
    });
  }

  async recordSuccess(sourceId: string, succeededAt: Date): Promise<void> {
    await this.update((ledger) => {
      const previous = ledger.sources[sourceId];
      ledger.sources[sourceId] = {
        ...previous,
        sourceId,
        lastAttemptAt: previous?.lastAttemptAt ?? succeededAt.toISOString(),
        lastSuccessAt: succeededAt.toISOString(),
        lastSuccessDate: toLocalCalendarDate(succeededAt),
        status: "success",
        errorCode: undefined,
        errorMessage: undefined,
      };
    });
  }

  async recordError(
    sourceId: string,
    attemptedAt: Date,
    error: { code: string; message: string },
  ): Promise<void> {
    await this.update((ledger) => {
      const previous = ledger.sources[sourceId];
      ledger.sources[sourceId] = {
        ...previous,
        sourceId,
        lastAttemptAt: attemptedAt.toISOString(),
        status: "error",
        errorCode: error.code.slice(0, 80),
        errorMessage: sanitizeErrorMessage(error.message),
      };
    });
  }

  private get statePath(): string {
    return normalizePath(`${this.dataRoot}/state`);
  }

  private get ledgerPath(): string {
    return normalizePath(`${this.statePath}/source-refresh.json`);
  }

  private async readLedger(): Promise<PersistedSourceRefreshLedger> {
    if (!(await this.vault.adapter.exists(this.ledgerPath))) {
      return EMPTY_LEDGER();
    }

    try {
      const parsed: unknown = JSON.parse(
        await this.vault.adapter.read(this.ledgerPath),
      );
      return isPersistedLedger(parsed) ? parsed : EMPTY_LEDGER();
    } catch {
      return EMPTY_LEDGER();
    }
  }

  private async writeLedger(ledger: PersistedSourceRefreshLedger): Promise<void> {
    await this.ensureDirectory(this.dataRoot);
    await this.ensureDirectory(this.statePath);
    await this.vault.adapter.write(
      this.ledgerPath,
      `${JSON.stringify(ledger, null, 2)}\n`,
    );
  }

  private async update(
    apply: (ledger: PersistedSourceRefreshLedger) => void,
  ): Promise<void> {
    const mutation = this.mutationQueue.then(async () => {
      const ledger = await this.readLedger();
      apply(ledger);
      await this.writeLedger(ledger);
    });
    this.mutationQueue = mutation.catch(() => undefined);
    await mutation;
  }

  private async ensureDirectory(path: string): Promise<void> {
    if (!(await this.vault.adapter.exists(path))) {
      await this.vault.adapter.mkdir(path);
    }
  }
}

function isPersistedLedger(value: unknown): value is PersistedSourceRefreshLedger {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.sources)) {
    return false;
  }

  return Object.entries(value.sources).every(
    ([sourceId, state]) =>
      isRecord(state) &&
      state.sourceId === sourceId &&
      (state.status === "idle" || state.status === "success" || state.status === "error") &&
      optionalString(state.lastAttemptAt) &&
      optionalString(state.lastSuccessAt) &&
      optionalString(state.lastSuccessDate) &&
      optionalString(state.errorCode) &&
      optionalString(state.errorMessage),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function assertSafeDataRoot(folder: string): void {
  if (
    !folder ||
    folder.startsWith("/") ||
    folder.includes("\\") ||
    folder.includes("\0") ||
    /^[A-Za-z]:/.test(folder)
  ) {
    throw new Error("Invalid refresh ledger data folder");
  }

  if (folder.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Invalid refresh ledger data folder");
  }
}

function sanitizeErrorMessage(message: string): string {
  const withoutUrlQueries = message.replace(
    /https?:\/\/[^\s]+/gi,
    (rawUrl) => redactUrlQuery(rawUrl),
  );
  const withoutHeaderSecrets = withoutUrlQueries.replace(
    /\b(authorization|proxy-authorization|x-api-key|api[-_]?key|token|cookie|set-cookie)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi,
    "$1: [redacted]",
  );

  return withoutHeaderSecrets.replace(/\s+/g, " ").trim().slice(0, 300);
}

function redactUrlQuery(rawUrl: string): string {
  const punctuation = /[),.;]+$/.exec(rawUrl)?.[0] ?? "";
  const candidate = punctuation ? rawUrl.slice(0, -punctuation.length) : rawUrl;
  try {
    const url = new URL(candidate);
    return `${url.origin}${url.pathname}${punctuation}`;
  } catch {
    return candidate.replace(/\?[^\s]*/, "") + punctuation;
  }
}

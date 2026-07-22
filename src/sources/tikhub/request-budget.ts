import type {
  TikHubLedgerReservation,
  TikHubRequestLedgerLike,
} from "./request-ledger";

export interface TikHubBudgetReservation {
  readonly total: number;
  readonly remaining: number;
  markAttempted(): void;
  releaseUnused(): Promise<number>;
}

export interface TikHubRequestBudgetLike {
  reserve(count: number): Promise<TikHubBudgetReservation>;
}

export class TikHubRequestBudgetError extends Error {
  readonly code = "run-limit";

  constructor(message = "TikHub per-run request limit reached.") {
    super(message);
    this.name = "TikHubRequestBudgetError";
  }
}

export interface TikHubRequestBudgetOptions {
  ledger: TikHubRequestLedgerLike;
  maxRequestsPerRun: number;
  maxRequestsPerDay: number;
}

export class TikHubRequestBudget implements TikHubRequestBudgetLike {
  private readonly ledger: TikHubRequestLedgerLike;
  private readonly maxRequestsPerRun: number;
  private readonly maxRequestsPerDay: number;
  private reservedForRun = 0;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: TikHubRequestBudgetOptions) {
    assertPositiveInteger(options.maxRequestsPerRun, "per-run request limit");
    assertPositiveInteger(options.maxRequestsPerDay, "daily request limit");
    this.ledger = options.ledger;
    this.maxRequestsPerRun = options.maxRequestsPerRun;
    this.maxRequestsPerDay = options.maxRequestsPerDay;
  }

  get remainingForRun(): number {
    return Math.max(0, this.maxRequestsPerRun - this.reservedForRun);
  }

  async reserve(count: number): Promise<TikHubBudgetReservation> {
    assertPositiveInteger(count, "reservation count");
    return await this.withLock(async () => {
      if (this.reservedForRun + count > this.maxRequestsPerRun) {
        throw new TikHubRequestBudgetError();
      }

      this.reservedForRun += count;
      let ledgerReservation: TikHubLedgerReservation;
      try {
        ledgerReservation = await this.ledger.reserve(count, this.maxRequestsPerDay);
      } catch (error) {
        this.reservedForRun -= count;
        throw error;
      }

      return new BudgetReservation(this, ledgerReservation);
    });
  }

  async releaseRunCount(count: number): Promise<void> {
    if (count === 0) return;
    await this.withLock(async () => {
      this.reservedForRun = Math.max(0, this.reservedForRun - count);
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.mutationQueue.catch(() => undefined).then(operation);
    this.mutationQueue = running.then(() => undefined, () => undefined);
    return await running;
  }
}

class BudgetReservation implements TikHubBudgetReservation {
  constructor(
    private readonly budget: TikHubRequestBudget,
    private readonly ledgerReservation: TikHubLedgerReservation,
  ) {}

  get total(): number {
    return this.ledgerReservation.total;
  }

  get remaining(): number {
    return this.ledgerReservation.remaining;
  }

  markAttempted(): void {
    this.ledgerReservation.markAttempted();
  }

  async releaseUnused(): Promise<number> {
    const released = await this.ledgerReservation.releaseUnused();
    await this.budget.releaseRunCount(released);
    return released;
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`TikHub ${label} must be a positive integer.`);
  }
}

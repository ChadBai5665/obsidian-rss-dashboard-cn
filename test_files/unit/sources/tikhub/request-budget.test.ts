import { describe, expect, it, vi } from "vitest";
import {
  TikHubRequestBudget,
  TikHubRequestBudgetError,
} from "../../../../src/sources/tikhub/request-budget";
import type {
  TikHubLedgerReservation,
  TikHubRequestLedgerLike,
} from "../../../../src/sources/tikhub/request-ledger";

function createHarness(options: { runLimit?: number; dayLimit?: number } = {}) {
  let remaining = 0;
  const markAttempted = vi.fn(() => {
    if (remaining === 0) throw new Error("No unused reservations");
    remaining -= 1;
  });
  const releaseUnused = vi.fn(async () => {
    const released = remaining;
    remaining = 0;
    return released;
  });
  const reserve = vi.fn(async (count: number, _maximum: number) => {
    remaining = count;
    const reservation: TikHubLedgerReservation = {
      total: count,
      get remaining() {
        return remaining;
      },
      markAttempted,
      releaseUnused,
    };
    return reservation;
  });
  const ledger: TikHubRequestLedgerLike = { reserve };
  const budget = new TikHubRequestBudget({
    ledger,
    maxRequestsPerRun: options.runLimit ?? 4,
    maxRequestsPerDay: options.dayLimit ?? 10,
  });
  return { budget, ledger, markAttempted, releaseUnused, reserve };
}

describe("TikHubRequestBudget", () => {
  it("reserves a complete batch in both the run and daily budgets", async () => {
    const test = createHarness();

    const reservation = await test.budget.reserve(3);

    expect(test.reserve).toHaveBeenCalledWith(3, 10);
    expect(test.budget.remainingForRun).toBe(1);
    expect(reservation).toMatchObject({ total: 3, remaining: 3 });
  });

  it("rejects a batch atomically when the per-run limit cannot cover it", async () => {
    const test = createHarness({ runLimit: 2 });

    await expect(test.budget.reserve(3)).rejects.toMatchObject({
      name: "TikHubRequestBudgetError",
      code: "run-limit",
    });
    expect(test.reserve).not.toHaveBeenCalled();
    expect(test.budget.remainingForRun).toBe(2);
  });

  it("rolls back the run reservation when the durable daily reservation fails", async () => {
    const test = createHarness();
    test.reserve.mockRejectedValueOnce(new Error("daily unavailable"));

    await expect(test.budget.reserve(2)).rejects.toThrow("daily unavailable");
    expect(test.budget.remainingForRun).toBe(4);
  });

  it("keeps attempted requests counted and releases only the unused batch tail", async () => {
    const test = createHarness();
    const reservation = await test.budget.reserve(3);

    reservation.markAttempted();
    const released = await reservation.releaseUnused();

    expect(released).toBe(2);
    expect(test.markAttempted).toHaveBeenCalledTimes(1);
    expect(test.releaseUnused).toHaveBeenCalledTimes(1);
    expect(test.budget.remainingForRun).toBe(3);
    expect(reservation.remaining).toBe(0);
  });

  it("serializes concurrent reservations so the per-run cap cannot be overspent", async () => {
    const test = createHarness({ runLimit: 2 });

    const outcomes = await Promise.allSettled([
      test.budget.reserve(2),
      test.budget.reserve(1),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(TikHubRequestBudgetError);
    expect(rejected?.reason).toMatchObject({ code: "run-limit" });
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects an invalid reservation count %s", async (count) => {
    const test = createHarness();
    await expect(test.budget.reserve(count)).rejects.toThrow("positive integer");
    expect(test.reserve).not.toHaveBeenCalled();
  });
});

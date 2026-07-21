import { describe, expect, it } from "vitest";
import {
  shouldRunDailyRefresh,
  toLocalCalendarDate,
} from "../../../src/refresh/local-calendar-day";

describe("local calendar refresh dates", () => {
  it("formats dates from local calendar parts rather than UTC serialization", () => {
    const date = new Date(2026, 6, 21, 0, 30, 0);

    expect(toLocalCalendarDate(date)).toBe("2026-07-21");
  });

  it("does not refresh twice on the same local calendar day", () => {
    const now = new Date(2026, 6, 21, 23, 50, 0);

    expect(shouldRunDailyRefresh("2026-07-21", now)).toBe(false);
  });

  it("refreshes after local midnight even when fewer than 24 hours elapsed", () => {
    const now = new Date(2026, 6, 22, 0, 5, 0);

    expect(shouldRunDailyRefresh("2026-07-21", now)).toBe(true);
  });
});

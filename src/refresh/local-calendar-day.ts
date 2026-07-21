/**
 * Formats a date using the machine's local calendar, which matches the
 * user's Obsidian session. Deliberately avoid UTC serialization here: a
 * refresh shortly after local midnight still belongs to the new local day.
 */
export function toLocalCalendarDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function shouldRunDailyRefresh(
  lastSuccessDate: string | undefined,
  now: Date,
): boolean {
  return lastSuccessDate !== toLocalCalendarDate(now);
}

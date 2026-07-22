const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Returns the one canonical lowercase UUID representation shared by settings and secrets. */
export function normalizeConnectionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : undefined;
}

export function isCanonicalConnectionId(value: unknown): value is string {
  return typeof value === "string" && normalizeConnectionId(value) === value;
}

export function requireConnectionId(value: unknown): string {
  const normalized = normalizeConnectionId(value);
  if (!normalized) {
    throw new Error("External secret connection ID must be a UUID.");
  }
  return normalized;
}

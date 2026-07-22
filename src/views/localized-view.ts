/** A plugin view whose currently rendered interface can adopt a new locale. */
export interface LocalizedView {
  refreshLocalization(): void;
}

export function isLocalizedView(value: unknown): value is LocalizedView {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { refreshLocalization?: unknown }).refreshLocalization ===
      "function"
  );
}

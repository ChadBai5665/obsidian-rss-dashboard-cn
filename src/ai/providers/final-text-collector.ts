import {
  ProviderError,
  providerResponseTooLarge,
} from "./provider-error";
import type { TextDeltaHandler } from "./text-generation-provider";

/**
 * Collects one bounded final answer while ensuring streamed callbacks observe
 * exactly the same trim-normalized text returned from finish().
 */
export class FinalTextCollector {
  private value = "";
  private pending = "";
  private started = false;

  constructor(
    private readonly maximum: number,
    private readonly apiKey: string,
    private readonly onTextDelta?: TextDeltaHandler,
  ) {}

  append(delta: string): void {
    const nextLength = this.value.length + delta.length;
    if (!Number.isSafeInteger(nextLength) || nextLength > this.maximum) {
      throw providerResponseTooLarge();
    }
    this.value += delta;
    this.pending += delta;
    if (this.value.includes(this.apiKey)) throw emptyOutput();

    if (!this.started) {
      this.pending = this.pending.trimStart();
      if (this.pending.length === 0) return;
      this.started = true;
    }
    this.flush(false);
  }

  finish(): string {
    const text = this.value.trim();
    if (!text) throw emptyOutput();
    this.flush(true);
    return text;
  }

  private flush(finishing: boolean): void {
    const contentEnd = this.pending.trimEnd().length;
    const emitEnd = finishing
      ? contentEnd
      : Math.min(
          Math.max(0, this.pending.length - Math.max(0, this.apiKey.length - 1)),
          contentEnd,
        );
    if (emitEnd === 0) return;
    emitSafely(this.onTextDelta, this.pending.slice(0, emitEnd));
    this.pending = this.pending.slice(emitEnd);
  }
}

function emptyOutput(): ProviderError {
  return new ProviderError("empty-output", "The AI provider returned no text.");
}

function emitSafely(handler: TextDeltaHandler | undefined, text: string): void {
  if (!handler || text.length === 0) return;
  try {
    handler(text);
  } catch {
    // UI callback failures never affect provider protocol completion.
  }
}

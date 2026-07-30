export const MAX_SSE_LINE_CHARACTERS = 64 * 1024;
export const MAX_SSE_CARRY_CHARACTERS = 64 * 1024;
export const MAX_SSE_DATA_CHARACTERS = 256 * 1024;
export const MAX_SSE_EVENT_CHARACTERS = 512 * 1024;
export const MAX_SSE_EVENTS = 10_000;

export interface ServerSentEvent {
  event?: string;
  data: string;
}

type DecoderState = "open" | "finished" | "failed";

export class BoundedSseDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private state: DecoderState = "open";
  private carry = "";
  private skipLeadingLf = false;
  private eventName: string | undefined;
  private dataLines: string[] = [];
  private dataCharacters = 0;
  private eventCharacters = 0;
  private eventCount = 0;

  push(chunk: Uint8Array): ServerSentEvent[] {
    this.assertOpen();

    let decoded: string;
    try {
      decoded = this.decoder.decode(chunk, { stream: true });
    } catch {
      return this.fail("Invalid SSE UTF-8");
    }

    return this.consumeDecoded(decoded);
  }

  finish(): ServerSentEvent[] {
    this.assertOpen();

    let decoded: string;
    try {
      decoded = this.decoder.decode();
    } catch {
      return this.fail("Invalid SSE UTF-8");
    }

    const events = this.consumeDecoded(decoded);
    if (this.carry.length > 0) {
      const finalLine = this.carry;
      this.carry = "";
      this.consumeLine(finalLine, events);
    }
    this.skipLeadingLf = false;
    this.dispatchEvent(events);
    this.state = "finished";
    return events;
  }

  private consumeDecoded(decoded: string): ServerSentEvent[] {
    const events: ServerSentEvent[] = [];
    let segmentStart = 0;

    if (this.skipLeadingLf && decoded.length > 0) {
      if (decoded.charCodeAt(0) === 0x0a) segmentStart = 1;
      this.skipLeadingLf = false;
    }

    for (let index = segmentStart; index < decoded.length; index += 1) {
      const codeUnit = decoded.charCodeAt(index);
      if (codeUnit !== 0x0a && codeUnit !== 0x0d) continue;

      this.appendSegment(decoded, segmentStart, index, true, events);
      if (codeUnit === 0x0d) {
        if (decoded.charCodeAt(index + 1) === 0x0a) {
          index += 1;
        } else if (index + 1 === decoded.length) {
          this.skipLeadingLf = true;
        }
      }
      segmentStart = index + 1;
    }

    this.appendSegment(decoded, segmentStart, decoded.length, false, events);
    return events;
  }

  private appendSegment(
    source: string,
    start: number,
    end: number,
    terminatesLine: boolean,
    events: ServerSentEvent[],
  ): void {
    const combinedLength = this.carry.length + (end - start);
    const limit = terminatesLine
      ? MAX_SSE_LINE_CHARACTERS
      : MAX_SSE_CARRY_CHARACTERS;
    if (combinedLength > limit) {
      this.fail(
        terminatesLine
          ? "SSE line limit exceeded"
          : "SSE carry limit exceeded",
      );
    }

    if (end > start) this.carry += source.slice(start, end);
    if (!terminatesLine) return;

    const line = this.carry;
    this.carry = "";
    this.consumeLine(line, events);
  }

  private consumeLine(line: string, events: ServerSentEvent[]): void {
    if (line.length > MAX_SSE_LINE_CHARACTERS) {
      this.fail("SSE line limit exceeded");
    }
    if (line.length === 0) {
      this.dispatchEvent(events);
      return;
    }

    this.eventCharacters += line.length + 1;
    if (this.eventCharacters > MAX_SSE_EVENT_CHARACTERS) {
      this.fail("SSE event limit exceeded");
    }
    if (line.startsWith(":")) return;

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") {
      this.eventName = value;
      return;
    }
    if (field !== "data") return;

    const separatorCharacters = this.dataLines.length === 0 ? 0 : 1;
    const nextDataCharacters =
      this.dataCharacters + separatorCharacters + value.length;
    if (nextDataCharacters > MAX_SSE_DATA_CHARACTERS) {
      this.fail("SSE data limit exceeded");
    }
    this.dataLines.push(value);
    this.dataCharacters = nextDataCharacters;
  }

  private dispatchEvent(events: ServerSentEvent[]): void {
    if (this.dataLines.length > 0) {
      this.eventCount += 1;
      if (this.eventCount > MAX_SSE_EVENTS) {
        this.fail("SSE event count limit exceeded");
      }
      const event: ServerSentEvent = { data: this.dataLines.join("\n") };
      if (this.eventName) event.event = this.eventName;
      events.push(event);
    }

    this.eventName = undefined;
    this.dataLines = [];
    this.dataCharacters = 0;
    this.eventCharacters = 0;
  }

  private assertOpen(): void {
    if (this.state !== "open") {
      throw new Error("SSE decoder is not open");
    }
  }

  private fail(message: string): never {
    this.state = "failed";
    this.carry = "";
    this.skipLeadingLf = false;
    this.eventName = undefined;
    this.dataLines = [];
    this.dataCharacters = 0;
    this.eventCharacters = 0;
    this.eventCount = 0;
    throw new Error(message);
  }
}

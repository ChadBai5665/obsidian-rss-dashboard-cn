import { describe, expect, it } from "vitest";

import {
  BoundedSseDecoder,
  MAX_SSE_CARRY_CHARACTERS,
  MAX_SSE_DATA_CHARACTERS,
  MAX_SSE_EVENT_CHARACTERS,
  MAX_SSE_EVENTS,
  MAX_SSE_LINE_CHARACTERS,
} from "../../../../src/ai/providers/sse-decoder";

const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function captureFailure(operation: () => unknown, message: string): Error {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
    return error as Error;
  }
  throw new Error("expected SSE decoding to fail");
}

function expectFailure(operation: () => unknown, message: string): void {
  captureFailure(operation, message);
}

describe("BoundedSseDecoder", () => {
  it("decodes split UTF-8 code points and CRLF boundaries incrementally", () => {
    const decoder = new BoundedSseDecoder();
    const encoded = bytes("event: answer\r\ndata: 你🙂好\r\n\r\n");
    const emojiStart = bytes("event: answer\r\ndata: 你").byteLength;

    expect(decoder.push(encoded.slice(0, emojiStart + 1))).toEqual([]);
    expect(decoder.push(new Uint8Array())).toEqual([]);
    expect(
      decoder.push(encoded.slice(emojiStart + 1, encoded.length - 1)),
    ).toEqual([
      { event: "answer", data: "你🙂好" },
    ]);
    expect(decoder.push(encoded.slice(encoded.length - 1))).toEqual([]);
    expect(decoder.finish()).toEqual([]);
  });

  it("joins multiline data while ignoring comments, id, retry, and unknown fields", () => {
    const decoder = new BoundedSseDecoder();

    expect(
      decoder.push(
        bytes(
          ": keepalive\n" +
            "id: private-cursor\n" +
            "retry: 1000\n" +
            "unknown: ignored\n" +
            "event: delta\n" +
            "data: first\n" +
            "data:second\n\n" +
            "data: [DONE]\n\n",
        ),
      ),
    ).toEqual([
      { event: "delta", data: "first\nsecond" },
      { data: "[DONE]" },
    ]);
  });

  it("emits an explicitly empty data field but not field-only blocks", () => {
    const decoder = new BoundedSseDecoder();

    expect(
      decoder.push(bytes("event: ignored\n\nid: cursor\n\ndata:\n\n")),
    ).toEqual([{ data: "" }]);
  });

  it("flushes a final event without a terminal blank line", () => {
    const decoder = new BoundedSseDecoder();

    expect(decoder.push(bytes("event: final\ndata: tail"))).toEqual([]);
    expect(decoder.finish()).toEqual([{ event: "final", data: "tail" }]);
  });

  it("treats bare CR as a line ending and dispatches on a bare CR blank line", () => {
    const decoder = new BoundedSseDecoder();

    expect(
      decoder.push(bytes("event: first\rdata: one\r\rdata: two\r")),
    ).toEqual([{ event: "first", data: "one" }]);
    expect(decoder.finish()).toEqual([{ data: "two" }]);
  });

  it("accepts an exact-ceiling line across split CRLF without retaining CR", () => {
    const decoder = new BoundedSseDecoder();
    const value = "x".repeat(MAX_SSE_LINE_CHARACTERS - "data: ".length);

    expect(decoder.push(bytes(`data: ${value}`))).toEqual([]);
    expect(decoder.push(bytes("\r"))).toEqual([]);
    expect(decoder.push(new Uint8Array())).toEqual([]);
    expect(decoder.push(bytes("\n"))).toEqual([]);
    expect(decoder.push(bytes("\r"))).toEqual([{ data: value }]);
    expect(decoder.push(bytes("\n"))).toEqual([]);
    expect(decoder.finish()).toEqual([]);
  });

  it("rejects a split CRLF line one character above the line ceiling", () => {
    const decoder = new BoundedSseDecoder();
    const exactLine = "x".repeat(MAX_SSE_LINE_CHARACTERS);

    expect(decoder.push(bytes(exactLine))).toEqual([]);
    expectFailure(
      () => decoder.push(bytes("x\r\n")),
      "SSE line limit exceeded",
    );
  });

  it("applies an initial BOM once and preserves NUL as ordinary data", () => {
    const decoder = new BoundedSseDecoder();

    expect(
      decoder.push(
        bytes("\uFEFFdata: a\u0000b\n\uFEFFdata: ignored\ndata: c\n\n"),
      ),
    ).toEqual([{ data: "a\u0000b\nc" }]);
  });

  it("uses the last event field and omits an explicitly empty event name", () => {
    const decoder = new BoundedSseDecoder();

    expect(
      decoder.push(
        bytes(
          "event: first\nevent: second\ndata: one\n\n" +
            "event: retained\nevent:\ndata: two\n\n",
        ),
      ),
    ).toEqual([{ event: "second", data: "one" }, { data: "two" }]);
  });

  it("rejects malformed and incomplete UTF-8 without exposing input bytes", () => {
    const malformed = new BoundedSseDecoder();
    expectFailure(
      () => malformed.push(new Uint8Array([0xc3, 0x28])),
      "Invalid SSE UTF-8",
    );

    const incomplete = new BoundedSseDecoder();
    expect(incomplete.push(new Uint8Array([0xe2, 0x82]))).toEqual([]);
    expectFailure(() => incomplete.finish(), "Invalid SSE UTF-8");
  });

  it("rejects a completed line above the line ceiling", () => {
    const decoder = new BoundedSseDecoder();
    const line = `data: ${"x".repeat(MAX_SSE_LINE_CHARACTERS - 5)}\n`;

    expectFailure(() => decoder.push(bytes(line)), "SSE line limit exceeded");
  });

  it("rejects an unterminated carry above the carry ceiling", () => {
    const decoder = new BoundedSseDecoder();

    expectFailure(
      () =>
        decoder.push(bytes("x".repeat(MAX_SSE_CARRY_CHARACTERS + 1))),
      "SSE carry limit exceeded",
    );
  });

  it("rejects an event block above the event ceiling", () => {
    const decoder = new BoundedSseDecoder();
    const ignoredLine = "id: x\n";
    const repetitions =
      Math.floor(MAX_SSE_EVENT_CHARACTERS / ignoredLine.length) + 1;

    expectFailure(
      () => decoder.push(bytes(ignoredLine.repeat(repetitions))),
      "SSE event limit exceeded",
    );
  });

  it("rejects joined data above the per-event data ceiling", () => {
    const decoder = new BoundedSseDecoder();
    const value = "x".repeat(MAX_SSE_LINE_CHARACTERS - "data: ".length);
    const dataLine = `data: ${value}\n`;
    const addedDataCharacters = value.length + 1;
    const repetitions =
      Math.floor(MAX_SSE_DATA_CHARACTERS / addedDataCharacters) + 1;

    expectFailure(
      () => decoder.push(bytes(dataLine.repeat(repetitions))),
      "SSE data limit exceeded",
    );
  });

  it("rejects streams that dispatch more than the event-count ceiling", () => {
    const decoder = new BoundedSseDecoder();

    expectFailure(
      () => decoder.push(bytes("data: x\n\n".repeat(MAX_SSE_EVENTS + 1))),
      "SSE event count limit exceeded",
    );
  });

  it("rejects finish or push after successful finish with a stable error", () => {
    const decoder = new BoundedSseDecoder();

    expect(decoder.finish()).toEqual([]);
    expectFailure(() => decoder.finish(), "SSE decoder is not open");
    expectFailure(
      () => decoder.push(bytes("data: ignored\n\n")),
      "SSE decoder is not open",
    );
  });

  it("clears bounded state after failure and remains terminal", () => {
    const decoder = new BoundedSseDecoder();
    const sentinel = "private-payload-sentinel";
    expect(
      decoder.push(bytes(`event: answer\ndata: ${sentinel}\n`)),
    ).toEqual([]);

    const failure = captureFailure(
      () =>
        decoder.push(bytes("x".repeat(MAX_SSE_CARRY_CHARACTERS + 1))),
      "SSE carry limit exceeded",
    );
    expect(failure.message).not.toContain(sentinel);
    expect(JSON.stringify(decoder)).not.toContain(sentinel);
    expect(JSON.stringify(decoder).length).toBeLessThan(1_024);
    expectFailure(
      () => decoder.push(bytes("data: ignored\n\n")),
      "SSE decoder is not open",
    );
    expectFailure(() => decoder.finish(), "SSE decoder is not open");
  });
});

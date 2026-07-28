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

function expectFailure(operation: () => unknown, message: string): void {
  try {
    operation();
    throw new Error("expected SSE decoding to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
  }
}

describe("BoundedSseDecoder", () => {
  it("decodes split UTF-8 code points and CRLF boundaries incrementally", () => {
    const decoder = new BoundedSseDecoder();
    const encoded = bytes("event: answer\r\ndata: 你🙂好\r\n\r\n");
    const emojiStart = bytes("event: answer\r\ndata: 你").byteLength;

    expect(decoder.push(encoded.slice(0, emojiStart + 1))).toEqual([]);
    expect(decoder.push(new Uint8Array())).toEqual([]);
    expect(decoder.push(encoded.slice(emojiStart + 1, encoded.length - 1))).toEqual(
      [],
    );
    expect(decoder.push(encoded.slice(encoded.length - 1))).toEqual([
      { event: "answer", data: "你🙂好" },
    ]);
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
});

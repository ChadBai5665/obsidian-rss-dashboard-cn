import { describe, expect, it } from "vitest";

import {
  parseJson3Transcript,
  parseSrvTranscript,
  parseTranscriptPayload,
  parseWebVttTranscript,
} from "../../../src/youtube-transcript/transcript-parser";
import { YouTubeTranscriptError } from "../../../src/youtube-transcript/transcript-types";

function expectTranscriptFailure(
  operation: () => unknown,
  code: YouTubeTranscriptError["code"] = "temporarily-unavailable",
): void {
  try {
    operation();
    throw new Error("expected transcript parsing to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(YouTubeTranscriptError);
    expect((error as YouTubeTranscriptError).code).toBe(code);
    expect((error as Error).message).toBe(code);
  }
}

describe("parseJson3Transcript", () => {
  it("normalizes segments, formatting tags, HTML entities, Unicode, and rolling captions", () => {
    const payload = JSON.stringify({
      events: [
        {
          tStartMs: 0,
          dDurationMs: 1_000,
          segs: [{ utf8: "  Cafe\u0301 &amp; " }, { utf8: "<b>tea</b>  " }],
        },
        { tStartMs: 1_000, dDurationMs: 1_000, segs: [{ utf8: "Café & tea" }] },
        {
          tStartMs: 2_000,
          dDurationMs: 1_000,
          segs: [{ utf8: "Café & tea today" }],
        },
        { tStartMs: 3_000, dDurationMs: 1_000, segs: [{ utf8: "Next\nline" }] },
      ],
    });

    expect(parseJson3Transcript(payload)).toBe("Café & tea today\nNext\nline");
  });

  it("ignores empty events without inventing transcript text", () => {
    const payload = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 500 },
        { tStartMs: 500, dDurationMs: 500, segs: [] },
        { tStartMs: 1_000, dDurationMs: 500, segs: [{ utf8: "  " }] },
        { tStartMs: 1_500, dDurationMs: 500, segs: [{ utf8: "Kept" }] },
      ],
    });

    expect(parseJson3Transcript(payload)).toBe("Kept");
  });

  it("collapses progressive rolling captions in languages without spaces", () => {
    const payload = JSON.stringify({
      events: [
        { segs: [{ utf8: "你好" }] },
        { segs: [{ utf8: "你好世界" }] },
        { segs: [{ utf8: "下一句" }] },
      ],
    });

    expect(parseJson3Transcript(payload)).toBe("你好世界\n下一句");
  });

  it("deduplicates an overlapping multi-line rolling-caption window", () => {
    const payload = JSON.stringify({
      events: [{ segs: [{ utf8: "A\nB" }] }, { segs: [{ utf8: "A\nB\nC" }] }],
    });

    expect(parseJson3Transcript(payload)).toBe("A\nB\nC");
  });

  it.each([
    { events: [{ tStartMs: -1, segs: [{ utf8: "text" }] }] },
    { events: [{ tStartMs: "0", segs: [{ utf8: "text" }] }] },
    { events: [{ tStartMs: 0, dDurationMs: -1, segs: [{ utf8: "text" }] }] },
    {
      events: [
        { tStartMs: 0, dDurationMs: Number.NaN, segs: [{ utf8: "text" }] },
      ],
    },
  ])("rejects invalid event timestamps", (payload) => {
    expectTranscriptFailure(() =>
      parseJson3Transcript(JSON.stringify(payload)),
    );
  });

  it("rejects unsafe controls even when JSON escapes them", () => {
    const payload = JSON.stringify({
      events: [{ tStartMs: 0, segs: [{ utf8: "safe\u0000unsafe" }] }],
    });

    expectTranscriptFailure(() => parseJson3Transcript(payload));
  });

  it.each([
    [
      "JSON3 bidi override",
      () =>
        parseJson3Transcript(
          JSON.stringify({
            events: [{ segs: [{ utf8: "safe\u202Eunsafe" }] }],
          }),
        ),
    ],
    [
      "JSON3 unpaired high surrogate",
      () =>
        parseJson3Transcript(
          JSON.stringify({
            events: [{ segs: [{ utf8: "safe\uD800unsafe" }] }],
          }),
        ),
    ],
    [
      "WebVTT isolate control",
      () =>
        parseWebVttTranscript(
          "WEBVTT\n\n00:00.000 --> 00:01.000\nsafe\u2066unsafe\n",
        ),
    ],
    [
      "SRV encoded isolate control",
      () =>
        parseSrvTranscript(
          '<transcript><text start="0">safe&#x2069;unsafe</text></transcript>',
        ),
    ],
    [
      "SRV unpaired low surrogate",
      () =>
        parseSrvTranscript(
          '<transcript><text start="0">safe\uDFFFunsafe</text></transcript>',
        ),
    ],
  ])("rejects unsafe Unicode in %s", (_label, parse) => {
    expectTranscriptFailure(parse);
  });

  it("preserves paired emoji surrogates and legal zero-width joiners", () => {
    const payload = JSON.stringify({
      events: [{ segs: [{ utf8: "Family 👨‍👩‍👧‍👦" }] }],
    });

    expect(parseJson3Transcript(payload)).toBe("Family 👨‍👩‍👧‍👦");
  });

  it("rejects malformed JSON and non-object event structures", () => {
    expectTranscriptFailure(() => parseJson3Transcript('{"events":['));
    expectTranscriptFailure(() => parseJson3Transcript('{"events":{}}'));
    expectTranscriptFailure(() => parseJson3Transcript('{"events":[null]}'));
    expectTranscriptFailure(() =>
      parseJson3Transcript('{"events":[{"segs":[{"utf8":7}]}]}'),
    );
  });

  it("rejects a payload over the two-million-byte input ceiling", () => {
    expectTranscriptFailure(() => parseJson3Transcript(" ".repeat(2_000_001)));
  });

  it("rejects more than twenty thousand caption events", () => {
    const payload = JSON.stringify({
      events: Array.from({ length: 20_001 }, () => ({ segs: [] })),
    });

    expectTranscriptFailure(() => parseJson3Transcript(payload));
  });

  it("rejects more than ten thousand segments", () => {
    const payload = JSON.stringify({
      events: [
        {
          segs: Array.from({ length: 10_001 }, () => ({ utf8: "" })),
        },
      ],
    });

    expectTranscriptFailure(() => parseJson3Transcript(payload));
  });

  it("rejects a segment over sixteen thousand characters", () => {
    const payload = JSON.stringify({
      events: [{ segs: [{ utf8: "a".repeat(16_001) }] }],
    });

    expectTranscriptFailure(() => parseJson3Transcript(payload));
  });

  it("rejects final normalized text over one million characters", () => {
    const payload = JSON.stringify({
      events: Array.from({ length: 63 }, (_, index) => ({
        segs: [
          { utf8: `${String(index).padStart(2, "0")}-${"a".repeat(15_996)}` },
        ],
      })),
    });

    expectTranscriptFailure(() => parseJson3Transcript(payload));
  });

  it("reports an empty normalized result as temporarily unavailable", () => {
    expectTranscriptFailure(() => parseJson3Transcript('{"events":[]}'));
  });
});

describe("parseWebVttTranscript", () => {
  it("allows one byte-order mark only at the start of a WebVTT document", () => {
    expect(
      parseWebVttTranscript(
        "\uFEFFWEBVTT\n\n00:00.000 --> 00:01.000\nVisible\n",
      ),
    ).toBe("Visible");
    expectTranscriptFailure(() =>
      parseWebVttTranscript(
        "WEBVTT\n\n00:00.000 --> 00:01.000\nNot\uFEFFsafe\n",
      ),
    );
  });

  it("removes cue identifiers, timestamps, settings, tags, entities, and duplicate rolling lines", () => {
    const payload = [
      "WEBVTT",
      "Kind: captions",
      "Language: en",
      "",
      "cue-one",
      "00:00:00.000 --> 00:00:01.000 align:start position:0%",
      "<v Speaker><c.green>Hello &amp; welcome</c></v>",
      "",
      "00:01.000 --> 00:02.000",
      "Hello &amp; welcome",
      "",
      "00:02.000 --> 00:03.000",
      "Hello &amp; welcome aboard",
      "second line",
      "",
    ].join("\n");

    expect(parseWebVttTranscript(payload)).toBe(
      "Hello & welcome aboard\nsecond line",
    );
  });

  it("ignores NOTE, STYLE, and REGION blocks", () => {
    const payload = [
      "WEBVTT",
      "",
      "NOTE this is metadata",
      "not a cue",
      "",
      "STYLE",
      "::cue { color: red; }",
      "",
      "REGION",
      "id:fred",
      "",
      "00:00.000 --> 00:01.000",
      "Visible",
      "",
    ].join("\n");

    expect(parseWebVttTranscript(payload)).toBe("Visible");
  });

  it.each([
    "00:60.000 --> 00:61.000",
    "00:02.000 --> 00:01.000",
    "not-a-time --> 00:01.000",
    "00:00.000 --> not-a-time",
  ])("rejects an invalid cue timing line: %s", (timing) => {
    expectTranscriptFailure(() =>
      parseWebVttTranscript(`WEBVTT\n\n${timing}\nText\n`),
    );
  });

  it("rejects malformed cue markup instead of leaking it into plain text", () => {
    expectTranscriptFailure(() =>
      parseWebVttTranscript(
        "WEBVTT\n\n00:00.000 --> 00:01.000\n<b>unfinished\n",
      ),
    );
  });

  it("rejects a single WebVTT cue over sixteen thousand characters", () => {
    const payload = `WEBVTT\n\n00:00.000 --> 00:01.000\n${"a".repeat(16_001)}\n`;

    expectTranscriptFailure(() => parseWebVttTranscript(payload));
  });

  it("rejects missing headers and empty cue sets", () => {
    expectTranscriptFailure(() =>
      parseWebVttTranscript("00:00.000 --> 00:01.000\nText\n"),
    );
    expectTranscriptFailure(() => parseWebVttTranscript("WEBVTT\n\n"));
  });
});

describe("parseSrvTranscript", () => {
  it("parses text nodes, timestamps, tags, entities, newlines, and rolling duplicates", () => {
    const payload = [
      "<transcript>",
      '<text start="0" dur="1"><font color="#fff">Hello &amp; welcome</font></text>',
      '<text start="1" dur="1">Hello &amp; welcome</text>',
      '<text start="2" dur="1">Hello &amp; welcome aboard<br/>Second line</text>',
      "</transcript>",
    ].join("");

    expect(parseSrvTranscript(payload)).toBe(
      "Hello & welcome aboard\nSecond line",
    );
  });

  it("also parses SRV3 paragraph and segment nodes", () => {
    const payload = [
      '<timedtext format="3"><body>',
      '<p t="0" d="1000"><s ac="0">One </s><s t="500">two</s></p>',
      '<p t="1000" d="1000">Three</p>',
      "</body></timedtext>",
    ].join("");

    expect(parseSrvTranscript(payload)).toBe("One two\nThree");
  });

  it.each([
    [
      "SRV text node",
      `<transcript><text start="0">${"a".repeat(16_001)}</text></transcript>`,
    ],
    [
      "SRV3 paragraph",
      `<timedtext><body><p t="0">${"a".repeat(16_001)}</p></body></timedtext>`,
    ],
    [
      "SRV3 segment",
      `<timedtext><body><p t="0"><s>${"a".repeat(16_001)}</s></p></body></timedtext>`,
    ],
  ])("rejects a single overlong %s", (_label, payload) => {
    expectTranscriptFailure(() => parseSrvTranscript(payload));
  });

  it("rejects more than ten thousand SRV3 segment nodes", () => {
    const oneHundredSegments = "<s>x</s>".repeat(100);
    const paragraphs = Array.from(
      { length: 101 },
      (_, index) => `<p t="${index}">${oneHundredSegments}</p>`,
    ).join("");

    expectTranscriptFailure(() =>
      parseSrvTranscript(`<timedtext><body>${paragraphs}</body></timedtext>`),
    );
  });

  it.each([
    '<transcript><text start="-1" dur="1">Text</text></transcript>',
    '<transcript><text start="zero" dur="1">Text</text></transcript>',
    '<transcript><text start="0" dur="-1">Text</text></transcript>',
    '<timedtext><body><p t="-1" d="1000">Text</p></body></timedtext>',
  ])("rejects invalid XML timestamps", (payload) => {
    expectTranscriptFailure(() => parseSrvTranscript(payload));
  });

  it("rejects malformed, unclosed, and empty XML", () => {
    expectTranscriptFailure(() =>
      parseSrvTranscript('<transcript><text start="0">Text</transcript>'),
    );
    expectTranscriptFailure(() => parseSrvTranscript("<transcript/>"));
    expectTranscriptFailure(() => parseSrvTranscript("not xml"));
  });

  it.each([
    [
      "two consecutive roots",
      '<transcript><text start="0">One</text></transcript><transcript><text start="1">Two</text></transcript>',
    ],
    [
      "an SRV3 paragraph under an SRV root",
      '<transcript><p t="0">Text</p></transcript>',
    ],
    [
      "an SRV3 paragraph outside its body",
      '<timedtext><p t="0">Text</p></timedtext>',
    ],
    [
      "an SRV text node under an SRV3 body",
      '<timedtext><body><text start="0">Text</text></body></timedtext>',
    ],
    [
      "two SRV3 bodies",
      '<timedtext><body><p t="0">One</p></body><body><p t="1">Two</p></body></timedtext>',
    ],
    [
      "two SRV3 heads",
      '<timedtext><head></head><head></head><body><p t="0">Text</p></body></timedtext>',
    ],
    [
      "a structural body nested inside SRV text",
      '<transcript><text start="0"><body>Text</body></text></transcript>',
    ],
  ])("rejects malformed XML structure with %s", (_label, payload) => {
    expectTranscriptFailure(() => parseSrvTranscript(payload));
  });

  it("rejects more than twenty thousand caption nodes", () => {
    const node = '<text start="0" dur="1"></text>';
    expectTranscriptFailure(() =>
      parseSrvTranscript(`<transcript>${node.repeat(20_001)}</transcript>`),
    );
  });
});

describe("parseTranscriptPayload", () => {
  it("dispatches each supported provider format to the bounded parser", () => {
    expect(
      parseTranscriptPayload(
        "json3",
        '{"events":[{"segs":[{"utf8":"JSON"}]}]}',
      ),
    ).toBe("JSON");
    expect(
      parseTranscriptPayload("vtt", "WEBVTT\n\n00:00.000 --> 00:01.000\nVTT\n"),
    ).toBe("VTT");
    expect(
      parseTranscriptPayload(
        "srv3",
        '<transcript><text start="0" dur="1">XML</text></transcript>',
      ),
    ).toBe("XML");
  });
});

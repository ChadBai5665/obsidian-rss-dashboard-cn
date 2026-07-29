import { describe, expect, it, vi } from "vitest";
import { TikHubRequestBudgetError } from "../../../src/sources/tikhub/request-budget";
import { TikHubRequestLedgerError } from "../../../src/sources/tikhub/request-ledger";
import { TikHubClientError } from "../../../src/sources/tikhub/tikhub-client";
import type { TikHubResult } from "../../../src/sources/tikhub/tikhub-types";
import type { TikHubSettings } from "../../../src/types/types";
import {
  captionJobKey,
  type TikHubCaptionJobRecord,
} from "../../../src/youtube-transcript/tikhub-caption-job-repository";
import {
  TikHubTranscriptProvider,
  type TikHubCaptionClient,
  type TikHubCaptionJobStore,
} from "../../../src/youtube-transcript/tikhub-transcript-provider";
import {
  YouTubeTranscriptError,
  type TranscriptProviderOperationContext,
  type YouTubeCaptionTrack,
  type YouTubeTranscript,
  type YouTubeTranscriptErrorCode,
} from "../../../src/youtube-transcript/transcript-types";

const ITEM_ID = "a".repeat(64);
const VIDEO_ID = "dQw4w9WgXcQ";
const CONNECTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_CONNECTION_ID = "223e4567-e89b-42d3-a456-426614174000";
const JOB_ID = "123e4567-e89b-12d3-a456-426614174000";
const OTHER_JOB_ID = "223e4567-e89b-12d3-a456-426614174000";
const NOW = "2026-07-29T10:00:00.000Z";
const EARLIER = "2026-07-29T09:55:00.000Z";
const INVALID_LANGUAGE_CODES = [
  ["empty", ""],
  ["control", "en\u0000"],
  ["whitespace", "a.zh Hans"],
  ["slash", "a.zh/Hans"],
  ["query", "a.zh?format=txt"],
  ["leading separator", ".zh-Hans"],
  ["trailing separator", "zh-Hans."],
  ["consecutive separators", "a..zh-Hans"],
  ["mixed empty segment", "a.-zh-Hans"],
  ["trailing hyphen", "en-"],
  ["repeated hyphen", "en--US"],
  ["overlong", "a".repeat(65)],
] as const;
const CONTEXT: TranscriptProviderOperationContext = Object.freeze({
  itemId: ITEM_ID,
  videoId: VIDEO_ID,
});

type ClientOutcome = TikHubResult<unknown> | Error;

class FakeCaptionClient implements TikHubCaptionClient {
  readonly paidInputs: unknown[] = [];
  readonly resultInputs: unknown[] = [];

  constructor(
    readonly paid: ClientOutcome[] = [],
    readonly results: ClientOutcome[] = [],
    private readonly events?: string[],
  ) {}

  async fetchYouTubeCaptions(input: unknown): Promise<TikHubResult<unknown>> {
    this.events?.push("paid");
    this.paidInputs.push(input);
    return takeOutcome(this.paid, "paid TikHub caption response");
  }

  async fetchYouTubeCaptionResult(input: unknown): Promise<TikHubResult<unknown>> {
    this.events?.push("result");
    this.resultInputs.push(input);
    return takeOutcome(this.results, "free TikHub caption result");
  }
}

class FakeJobs implements TikHubCaptionJobStore {
  readonly records = new Map<string, TikHubCaptionJobRecord>();
  readonly readKeys: string[] = [];
  readonly writes: TikHubCaptionJobRecord[] = [];
  readonly removes: string[] = [];
  readFailure?: Error;
  writeFailure?: Error;
  removeFailure?: Error;

  constructor(private readonly events?: string[]) {}

  async read(key: string): Promise<TikHubCaptionJobRecord | null> {
    this.events?.push("read-job");
    this.readKeys.push(key);
    if (this.readFailure) throw this.readFailure;
    const record = this.records.get(key);
    return record ? { ...record } : null;
  }

  async write(record: TikHubCaptionJobRecord): Promise<void> {
    this.events?.push("write-job");
    this.writes.push({ ...record });
    if (this.writeFailure) throw this.writeFailure;
    this.records.set(keyFor(record), { ...record });
  }

  async remove(key: string): Promise<void> {
    this.events?.push("remove-job");
    this.removes.push(key);
    if (this.removeFailure) throw this.removeFailure;
    this.records.delete(key);
  }
}

interface HarnessOptions {
  settings?: Partial<TikHubSettings>;
  client?: FakeCaptionClient;
  jobs?: FakeJobs;
  getApiKey?: (connectionId: string) => Promise<string | undefined>;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  clock?: () => Date;
  events?: string[];
}

function createHarness(options: HarnessOptions = {}) {
  let settings: TikHubSettings = {
    enabled: true,
    youtubeTranscriptFallbackEnabled: true,
    connectionId: CONNECTION_ID,
    baseUrl: "https://api.tikhub.io",
    timeoutMs: 20_000,
    maxRequestsPerRun: 40,
    maxRequestsPerDay: 100,
    ...options.settings,
  };
  const events = options.events ?? [];
  const client = options.client ?? new FakeCaptionClient([], [], events);
  const jobs = options.jobs ?? new FakeJobs(events);
  const getSettings = vi.fn(() => settings);
  const getApiKey = vi.fn(
    options.getApiKey ?? (async () => "synthetic-caption-auth"),
  );
  const createClient = vi.fn((_current: TikHubSettings) => client);
  const delay = vi.fn(
    options.delay ?? (async () => undefined),
  );
  const provider = new TikHubTranscriptProvider({
    getSettings,
    getApiKey,
    createClient,
    jobs,
    clock: options.clock ?? (() => new Date(NOW)),
    delay,
    pollIntervalMs: 3_000,
    maxPolls: 10,
  });
  return {
    provider,
    client,
    jobs,
    getSettings,
    getApiKey,
    createClient,
    delay,
    events,
    setSettings(next: TikHubSettings) {
      settings = next;
    },
    get settings() {
      return settings;
    },
  };
}

function takeOutcome(
  outcomes: ClientOutcome[],
  label: string,
): TikHubResult<unknown> {
  const outcome = outcomes.shift();
  if (!outcome) throw new Error(`Unexpected ${label}.`);
  if (outcome instanceof Error) throw outcome;
  return outcome;
}

function tracksData(
  captions: Array<Record<string, unknown>> = [
    { language_code: "en", language_name: "English" },
  ],
): TikHubResult<unknown> {
  return { data: { video_id: VIDEO_ID, captions } };
}

function contentData(
  overrides: Record<string, unknown> = {},
): TikHubResult<unknown> {
  return {
    data: {
      video_id: VIDEO_ID,
      language_code: "en",
      language_name: "English",
      format: "txt",
      content: "Complete caption text.",
      ...overrides,
    },
  };
}

function processingData(jobId = JOB_ID): TikHubResult<unknown> {
  return {
    data: { video_id: VIDEO_ID, status: "processing", job_id: jobId },
  };
}

function pendingData(jobId = JOB_ID): TikHubResult<unknown> {
  return { data: { status: "active", job_id: jobId } };
}

function completedTracksData(
  jobId = JOB_ID,
  captions: Array<Record<string, unknown>> = [
    { language_code: "en", language_name: "English" },
  ],
): TikHubResult<unknown> {
  return {
    data: {
      job_id: jobId,
      status: "completed",
      video_id: VIDEO_ID,
      captions,
    },
  };
}

function completedContentData(
  jobId = JOB_ID,
  overrides: Record<string, unknown> = {},
): TikHubResult<unknown> {
  return {
    data: {
      job_id: jobId,
      status: "completed",
      language_code: "en",
      language_name: "English",
      format: "txt",
      content: "Completed from the free result endpoint.",
      available_languages: ["en"],
      ...overrides,
    },
  };
}

function jobRecord(
  stage: "tracks" | "content",
  overrides: Partial<TikHubCaptionJobRecord> = {},
): TikHubCaptionJobRecord {
  const record: TikHubCaptionJobRecord = {
    schemaVersion: 1,
    itemId: ITEM_ID,
    videoId: VIDEO_ID,
    stage,
    ...(stage === "content" ? { languageCode: "en" } : {}),
    format: "txt",
    jobId: JOB_ID,
    connectionId: CONNECTION_ID,
    createdAt: EARLIER,
    lastCheckedAt: EARLIER,
    status: "processing",
    ...overrides,
  };
  return record;
}

function keyFor(record: TikHubCaptionJobRecord): string {
  return captionJobKey(
    record.itemId,
    record.videoId,
    record.stage,
    record.languageCode,
  );
}

function putJob(jobs: FakeJobs, record: TikHubCaptionJobRecord): void {
  jobs.records.set(keyFor(record), { ...record });
}

function decodeLocator(track: YouTubeCaptionTrack): Record<string, unknown> {
  expect(track.url.startsWith("tikhub:")).toBe(true);
  return JSON.parse(decodeURIComponent(track.url.slice("tikhub:".length))) as
    Record<string, unknown>;
}

async function listedTrack(
  harness = createHarness({
    client: new FakeCaptionClient([tracksData()]),
  }),
): Promise<{ harness: ReturnType<typeof createHarness>; track: YouTubeCaptionTrack }> {
  const tracks = await harness.provider.listTracks(VIDEO_ID, undefined, CONTEXT);
  return { harness, track: tracks[0] };
}

function expectCode(
  pending: Promise<unknown>,
  code: YouTubeTranscriptErrorCode,
): Promise<void> {
  return expect(pending).rejects.toMatchObject({
    name: "YouTubeTranscriptError",
    code,
    message: code,
  });
}

describe("TikHubTranscriptProvider", () => {
  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])(
    "is unavailable only when enabled=%s or caption opt-in=%s is false",
    async (enabled, youtubeTranscriptFallbackEnabled) => {
      const test = createHarness({
        settings: { enabled, youtubeTranscriptFallbackEnabled },
      });

      await expect(test.provider.isAvailable()).resolves.toBe(false);
      expect(test.getApiKey).not.toHaveBeenCalled();
      expect(test.createClient).not.toHaveBeenCalled();
      expect(test.jobs.readKeys).toEqual([]);
    },
  );

  it("remains available when enabled even if the connection configuration is invalid", async () => {
    const test = createHarness({ settings: { connectionId: "../invalid" } });

    await expect(test.provider.isAvailable()).resolves.toBe(true);
    await expectCode(
      test.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
      "tikhub-missing-key",
    );
    expect(test.getApiKey).not.toHaveBeenCalled();
    expect(test.createClient).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])(
    "surfaces a missing current external key without creating a client (%s)",
    async (value) => {
      const test = createHarness({
        getApiKey: async () => value,
      });

      await expectCode(
        test.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
        "tikhub-missing-key",
      );
      expect(test.getApiKey).toHaveBeenCalledWith(CONNECTION_ID);
      expect(test.createClient).not.toHaveBeenCalled();
      expect(test.jobs.readKeys).toEqual([]);
    },
  );

  it("projects synchronous manual and a. tracks into frozen credential-free txt locators", async () => {
    const client = new FakeCaptionClient([
      tracksData([
        { language_code: "en", language_name: "English" },
        { language_code: "a.zh-Hans", language_name: "Chinese (auto)" },
      ]),
    ]);
    const test = createHarness({ client });

    const tracks = await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT);

    expect(tracks).toHaveLength(2);
    expect(tracks.map(({ languageCode, languageName, isGenerated, source, format }) => ({
      languageCode,
      languageName,
      isGenerated,
      source,
      format,
    }))).toEqual([
      {
        languageCode: "en",
        languageName: "English",
        isGenerated: false,
        source: "tikhub",
        format: "txt",
      },
      {
        languageCode: "a.zh-Hans",
        languageName: "Chinese (auto)",
        isGenerated: true,
        source: "tikhub",
        format: "txt",
      },
    ]);
    expect(decodeLocator(tracks[1])).toEqual({
      videoId: VIDEO_ID,
      languageCode: "a.zh-Hans",
      languageName: "Chinese (auto)",
      isGenerated: true,
      format: "txt",
    });
    expect(Object.isFrozen(tracks[0])).toBe(true);
    expect(JSON.stringify(tracks)).not.toContain("synthetic-caption-auth");
    expect(JSON.stringify(tracks)).not.toContain("api.tikhub");
    expect(client.paidInputs).toEqual([{
      apiKey: "synthetic-caption-auth",
      videoId: VIDEO_ID,
      signal: undefined,
    }]);
    expect(test.jobs.readKeys).toEqual([
      captionJobKey(ITEM_ID, VIDEO_ID, "tracks"),
    ]);
  });

  it("fetches a safe a.zh-Hans automatic caption through the txt content path", async () => {
    const client = new FakeCaptionClient([
      tracksData([{
        language_code: "a.zh-Hans",
        language_name: "Chinese (auto)",
      }]),
      contentData({
        language_code: "a.zh-Hans",
        language_name: "Chinese (auto)",
        is_generated: true,
      }),
    ]);
    const test = createHarness({ client });
    const [track] = await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT);

    await expect(
      test.provider.fetchTrack(track, undefined, CONTEXT),
    ).resolves.toEqual({
      videoId: VIDEO_ID,
      languageCode: "a.zh-Hans",
      languageName: "Chinese (auto)",
      isGenerated: true,
      provider: "tikhub",
      text: "Complete caption text.",
    });
    expect(client.paidInputs[1]).toMatchObject({
      languageCode: "a.zh-Hans",
      format: "txt",
    });
  });

  it.each(INVALID_LANGUAGE_CODES)(
    "fails closed on an unsafe provider language code before creating a locator: %s",
    async (_label, languageCode) => {
      const test = createHarness({
        client: new FakeCaptionClient([
          tracksData([{ language_code: languageCode, language_name: "Unsafe" }]),
        ]),
      });

      await expectCode(
        test.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
        "tikhub-malformed-response",
      );
    },
  );

  it("returns an explicit empty caption list after one paid list response", async () => {
    const client = new FakeCaptionClient([tracksData([])]);
    const test = createHarness({ client });

    await expect(
      test.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
    ).resolves.toEqual([]);
    expect(client.paidInputs).toHaveLength(1);
    expect(client.resultInputs).toHaveLength(0);
  });

  it("reads the current key separately for paid list and content calls", async () => {
    const client = new FakeCaptionClient([
      tracksData(),
      contentData(),
    ]);
    const test = createHarness({ client });
    const [track] = await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT);

    const transcript = await test.provider.fetchTrack(
      track,
      undefined,
      CONTEXT,
    );

    expect(transcript).toEqual({
      videoId: VIDEO_ID,
      languageCode: "en",
      languageName: "English",
      isGenerated: false,
      provider: "tikhub",
      text: "Complete caption text.",
    });
    expect(test.getApiKey).toHaveBeenCalledTimes(2);
    expect(test.createClient).toHaveBeenCalledTimes(2);
    expect(client.paidInputs).toEqual([
      {
        apiKey: "synthetic-caption-auth",
        videoId: VIDEO_ID,
        signal: undefined,
      },
      {
        apiKey: "synthetic-caption-auth",
        videoId: VIDEO_ID,
        languageCode: "en",
        format: "txt",
        signal: undefined,
      },
    ]);
    expect(client.resultInputs).toHaveLength(0);
  });

  it("accepts a self-contained cloned TikHub locator but rejects tampered or foreign locators", async () => {
    const listed = await listedTrack();
    const clone = { ...listed.track };
    listed.harness.getApiKey.mockClear();
    listed.harness.createClient.mockClear();

    listed.harness.client.paid.push(contentData());
    await expect(
      listed.harness.provider.fetchTrack(clone, undefined, CONTEXT),
    ).resolves.toMatchObject({ provider: "tikhub", videoId: VIDEO_ID });
    listed.harness.getApiKey.mockClear();
    listed.harness.createClient.mockClear();

    const unsafeLanguageCode = "a..zh-Hans";
    const unsafeLocator = {
      ...decodeLocator(clone),
      languageCode: unsafeLanguageCode,
    };
    await expectCode(
      listed.harness.provider.fetchTrack(
        {
          ...clone,
          languageCode: unsafeLanguageCode,
          url: `tikhub:${encodeURIComponent(JSON.stringify(unsafeLocator))}`,
        },
        undefined,
        CONTEXT,
      ),
      "tikhub-malformed-response",
    );
    await expectCode(
      listed.harness.provider.fetchTrack(
        { ...clone, url: `${clone.url}tampered` },
        undefined,
        CONTEXT,
      ),
      "tikhub-malformed-response",
    );
    await expectCode(
      listed.harness.provider.fetchTrack(
        {
          ...listed.track,
          source: "innertube",
          format: "json3",
        },
        undefined,
        CONTEXT,
      ),
      "tikhub-malformed-response",
    );
    expect(listed.harness.getApiKey).not.toHaveBeenCalled();
    expect(listed.harness.createClient).not.toHaveBeenCalled();
  });

  it("saves a processing track job before polling and accepts strict completed tracks", async () => {
    const events: string[] = [];
    const client = new FakeCaptionClient(
      [processingData()],
      [completedTracksData()],
      events,
    );
    const jobs = new FakeJobs(events);
    const test = createHarness({
      client,
      jobs,
      events,
      delay: async (milliseconds) => {
        events.push(`delay:${milliseconds}`);
      },
    });

    const tracks = await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT);

    expect(tracks).toHaveLength(1);
    expect(events).toEqual([
      "read-job",
      "paid",
      "write-job",
      "delay:3000",
      "result",
    ]);
    expect(jobs.writes[0]).toEqual({
      schemaVersion: 1,
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      stage: "tracks",
      format: "txt",
      jobId: JOB_ID,
      connectionId: CONNECTION_ID,
      createdAt: NOW,
      lastCheckedAt: NOW,
      status: "processing",
    });
    expect(jobs.records.has(captionJobKey(ITEM_ID, VIDEO_ID, "tracks"))).toBe(true);
  });

  it("saves a processing content job before polling and normalizes completed content with trusted context", async () => {
    const events: string[] = [];
    const client = new FakeCaptionClient(
      [tracksData(), processingData(OTHER_JOB_ID)],
      [completedContentData(OTHER_JOB_ID)],
      events,
    );
    const jobs = new FakeJobs(events);
    const test = createHarness({
      client,
      jobs,
      events,
      delay: async (milliseconds) => {
        events.push(`delay:${milliseconds}`);
      },
    });
    const [track] = await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT);
    events.length = 0;

    const transcript = await test.provider.fetchTrack(
      track,
      undefined,
      CONTEXT,
    );

    expect(transcript.videoId).toBe(VIDEO_ID);
    expect(transcript.text).toBe("Completed from the free result endpoint.");
    expect(events).toEqual([
      "read-job",
      "paid",
      "write-job",
      "delay:3000",
      "result",
    ]);
    expect(jobs.writes.at(-1)).toMatchObject({
      itemId: ITEM_ID,
      videoId: VIDEO_ID,
      stage: "content",
      languageCode: "en",
      jobId: OTHER_JOB_ID,
      connectionId: CONNECTION_ID,
    });
  });

  it("resumes a matching track job through the free result endpoint before any paid call", async () => {
    const client = new FakeCaptionClient([], [completedTracksData()]);
    const jobs = new FakeJobs();
    putJob(jobs, jobRecord("tracks"));
    const test = createHarness({ client, jobs });

    const tracks = await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT);

    expect(tracks).toHaveLength(1);
    expect(client.paidInputs).toHaveLength(0);
    expect(client.resultInputs).toEqual([{
      apiKey: "synthetic-caption-auth",
      jobId: JOB_ID,
      format: "txt",
      signal: undefined,
    }]);
  });

  it("resumes matching content with no paid call and validates the saved track language", async () => {
    const listed = await listedTrack();
    const client = new FakeCaptionClient([], [completedContentData()]);
    const jobs = new FakeJobs();
    putJob(jobs, jobRecord("content"));
    const test = createHarness({ client, jobs });

    const transcript = await test.provider.fetchTrack(
      listed.track,
      undefined,
      CONTEXT,
    );

    expect(transcript).toMatchObject({
      videoId: VIDEO_ID,
      languageCode: "en",
      provider: "tikhub",
    });
    expect(client.paidInputs).toHaveLength(0);
    expect(client.resultInputs).toHaveLength(1);
  });

  it("polls exactly ten times at three-second intervals, retains a pending job, and surfaces processing", async () => {
    const client = new FakeCaptionClient(
      [],
      Array.from({ length: 10 }, () => pendingData()),
    );
    const jobs = new FakeJobs();
    const record = jobRecord("content");
    putJob(jobs, record);
    const listed = await listedTrack();
    const test = createHarness({ client, jobs });

    await expectCode(
      test.provider.fetchTrack(listed.track, undefined, CONTEXT),
      "tikhub-processing",
    );

    expect(client.paidInputs).toHaveLength(0);
    expect(client.resultInputs).toHaveLength(10);
    expect(test.delay).toHaveBeenCalledTimes(10);
    expect(test.delay.mock.calls.map(([milliseconds]) => milliseconds)).toEqual(
      Array.from({ length: 10 }, () => 3_000),
    );
    expect(jobs.records.get(keyFor(record))).toMatchObject({
      jobId: JOB_ID,
      status: "processing",
    });
    expect(jobs.removes).toEqual([]);
  });

  it("retains the atomically saved job when polling is aborted", async () => {
    const controller = new AbortController();
    const client = new FakeCaptionClient([tracksData(), processingData()], []);
    const jobs = new FakeJobs();
    const test = createHarness({
      client,
      jobs,
      delay: async () => {
        controller.abort();
      },
    });
    const [track] = await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT);

    await expectCode(
      test.provider.fetchTrack(track, controller.signal, CONTEXT),
      "aborted",
    );

    expect(jobs.records.has(
      captionJobKey(ITEM_ID, VIDEO_ID, "content", "en"),
    )).toBe(true);
    expect(jobs.removes).toEqual([]);
    expect(client.resultInputs).toHaveLength(0);
  });

  it("does not recreate a paid job after the configured connection changes", async () => {
    const jobs = new FakeJobs();
    putJob(jobs, jobRecord("tracks", { connectionId: OTHER_CONNECTION_ID }));
    const client = new FakeCaptionClient();
    const test = createHarness({ client, jobs });

    await expectCode(
      test.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
      "tikhub-job-expired",
    );

    expect(client.paidInputs).toHaveLength(0);
    expect(client.resultInputs).toHaveLength(0);
    expect(jobs.removes).toEqual([]);
  });

  it.each([
    new TikHubClientError("invalid-query", "private expired detail", 422),
    new TikHubClientError("provider-rejected", "private expired detail", 404),
  ])("maps an invalid or expired saved result to tikhub-job-expired without a paid retry", async (failure) => {
    const jobs = new FakeJobs();
    putJob(jobs, jobRecord("tracks"));
    const client = new FakeCaptionClient([], [failure]);
    const test = createHarness({ client, jobs });

    let caught: unknown;
    try {
      await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT);
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(new YouTubeTranscriptError("tikhub-job-expired"));
    expect(JSON.stringify(caught)).not.toContain("private expired detail");
    expect(client.paidInputs).toHaveLength(0);
    expect(jobs.removes).toEqual([]);
  });

  it("maps malformed paid and free data without retaining either provider payload", async () => {
    const paid = createHarness({
      client: new FakeCaptionClient([{
        data: { video_id: VIDEO_ID, captions: "private paid payload" },
      }]),
    });
    await expectCode(
      paid.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
      "tikhub-malformed-response",
    );

    const jobs = new FakeJobs();
    putJob(jobs, jobRecord("tracks"));
    const resumed = createHarness({
      jobs,
      client: new FakeCaptionClient([], [{
        data: { status: "completed", job_id: JOB_ID, private: "payload" },
      }]),
    });
    let caught: unknown;
    try {
      await resumed.provider.listTracks(VIDEO_ID, undefined, CONTEXT);
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(new YouTubeTranscriptError("tikhub-malformed-response"));
    expect(JSON.stringify(caught)).not.toContain("payload");
  });

  it("rejects completed content for another language as a malformed response", async () => {
    const listed = await listedTrack();
    const jobs = new FakeJobs();
    putJob(jobs, jobRecord("content"));
    const test = createHarness({
      jobs,
      client: new FakeCaptionClient([], [completedContentData(JOB_ID, {
        language_code: "ja",
        language_name: "Japanese",
        available_languages: ["ja"],
      })]),
    });

    await expectCode(
      test.provider.fetchTrack(listed.track, undefined, CONTEXT),
      "tikhub-malformed-response",
    );
  });

  it.each<[
    string,
    Error,
    YouTubeTranscriptErrorCode,
  ]>([
    ["missing key", new TikHubClientError("missing-key", "private"), "tikhub-missing-key"],
    ["invalid key", new TikHubClientError("invalid-key", "private"), "tikhub-invalid-key"],
    ["balance", new TikHubClientError("insufficient-balance", "private"), "tikhub-insufficient-balance"],
    ["rate limit", new TikHubClientError("rate-limited", "private"), "tikhub-rate-limited"],
    ["timeout", new TikHubClientError("timeout", "private"), "timeout"],
    ["abort", new TikHubClientError("aborted", "private"), "aborted"],
    ["malformed", new TikHubClientError("malformed-response", "private"), "tikhub-malformed-response"],
    ["invalid query", new TikHubClientError("invalid-query", "private"), "tikhub-malformed-response"],
    ["provider failure", new TikHubClientError("provider-failure", "private"), "temporarily-unavailable"],
    ["provider rejection", new TikHubClientError("provider-rejected", "private"), "temporarily-unavailable"],
    ["network", new TikHubClientError("network-failure", "private"), "temporarily-unavailable"],
    ["invalid batch", new TikHubClientError("invalid-batch", "private"), "tikhub-budget-unavailable"],
    ["run budget", new TikHubRequestBudgetError("private"), "tikhub-budget-unavailable"],
    ["daily ledger", new TikHubRequestLedgerError("daily-limit", "private"), "tikhub-budget-unavailable"],
    ["corrupt ledger", new TikHubRequestLedgerError("corrupt-ledger", "private"), "tikhub-budget-unavailable"],
    ["atomic ledger", new TikHubRequestLedgerError("atomic-write-unavailable", "private"), "tikhub-budget-unavailable"],
    ["unknown transport", new Error("private transport detail"), "temporarily-unavailable"],
  ])("maps %s failures to the stable sanitized code %s", async (_label, failure, code) => {
    const test = createHarness({
      client: new FakeCaptionClient([failure]),
    });
    let caught: unknown;

    try {
      await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT);
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(new YouTubeTranscriptError(code));
    expect(JSON.stringify(caught)).not.toContain("private");
  });

  it("blocks a paid call when the durable job store cannot be read or written", async () => {
    const unreadable = new FakeJobs();
    unreadable.readFailure = new Error("private job bytes");
    const readTest = createHarness({
      jobs: unreadable,
      client: new FakeCaptionClient([tracksData()]),
    });
    await expectCode(
      readTest.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
      "tikhub-budget-unavailable",
    );
    expect(readTest.client.paidInputs).toHaveLength(0);

    const unwritable = new FakeJobs();
    unwritable.writeFailure = new Error("private job bytes");
    const writeTest = createHarness({
      jobs: unwritable,
      client: new FakeCaptionClient([processingData()]),
    });
    await expectCode(
      writeTest.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
      "tikhub-budget-unavailable",
    );
    expect(writeTest.client.resultInputs).toHaveLength(0);
  });

  it("uses the latest connection, endpoint, timeout, and caps on the next explicit call", async () => {
    const client = new FakeCaptionClient([tracksData(), tracksData()]);
    const test = createHarness({ client });
    await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT);
    const nextSettings: TikHubSettings = {
      ...test.settings,
      connectionId: OTHER_CONNECTION_ID,
      baseUrl: "https://api.tikhub.dev",
      timeoutMs: 9_000,
      maxRequestsPerRun: 2,
      maxRequestsPerDay: 3,
    };
    test.setSettings(nextSettings);

    await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT);

    expect(test.getApiKey.mock.calls.map(([connectionId]) => connectionId)).toEqual([
      CONNECTION_ID,
      OTHER_CONNECTION_ID,
    ]);
    expect(test.createClient).toHaveBeenLastCalledWith(nextSettings);
  });

  it("removes only the exact content job after the service reports durable persistence", async () => {
    const listed = await listedTrack();
    const jobs = new FakeJobs();
    const contentJob = jobRecord("content");
    const tracksJob = jobRecord("tracks", { jobId: OTHER_JOB_ID });
    putJob(jobs, contentJob);
    putJob(jobs, tracksJob);
    const test = createHarness({ jobs });
    const transcript: YouTubeTranscript = {
      videoId: VIDEO_ID,
      languageCode: "en",
      languageName: "English",
      isGenerated: false,
      provider: "tikhub",
      text: "Durably cached caption.",
    };

    await test.provider.onPersisted(listed.track, transcript, CONTEXT);

    const contentKey = captionJobKey(ITEM_ID, VIDEO_ID, "content", "en");
    const tracksKey = captionJobKey(ITEM_ID, VIDEO_ID, "tracks");
    expect(jobs.removes).toEqual([contentKey]);
    expect(jobs.records.has(contentKey)).toBe(false);
    expect(jobs.records.has(tracksKey)).toBe(true);
    expect(test.getApiKey).not.toHaveBeenCalled();
  });
});

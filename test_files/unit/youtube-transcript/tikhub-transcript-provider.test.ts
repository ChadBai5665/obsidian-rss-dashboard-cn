import { describe, expect, it, vi } from "vitest";
import { TikHubRequestBudgetError } from "../../../src/sources/tikhub/request-budget";
import { TikHubRequestLedgerError } from "../../../src/sources/tikhub/request-ledger";
import { TikHubClientError } from "../../../src/sources/tikhub/tikhub-client";
import type { TikHubResult } from "../../../src/sources/tikhub/tikhub-types";
import type { TikHubSettings } from "../../../src/types/types";
import {
  captionJobKey,
  type TikHubCaptionJobIdentity,
  type TikHubCaptionJobRecord,
} from "../../../src/youtube-transcript/tikhub-caption-job-repository";
import {
  TikHubTranscriptProvider,
  type TikHubCaptionClient,
  type TikHubCaptionJobStore,
} from "../../../src/youtube-transcript/tikhub-transcript-provider";
import {
  isTranscriptProviderOperationResult,
  YouTubeTranscriptError,
  type TranscriptProviderOperationContext,
  type TranscriptProviderOperationEvidence,
  type TranscriptProviderOperationResult,
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
const FREE_EVIDENCE: TranscriptProviderOperationEvidence = Object.freeze({
  tikhubPaidRequests: 0,
  paidRequestAttempted: false,
});
const PAID_EVIDENCE: TranscriptProviderOperationEvidence = Object.freeze({
  tikhubPaidRequests: 1,
  paidRequestAttempted: true,
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

class AbortAfterPaidResponseClient extends FakeCaptionClient {
  constructor(private readonly controller: AbortController) {
    super([tracksData()]);
  }

  override fetchYouTubeCaptions(
    input: unknown,
  ): Promise<TikHubResult<unknown>> {
    const response = super.fetchYouTubeCaptions(input);
    void response.then(() => this.controller.abort());
    return response;
  }
}

class FakeJobs implements TikHubCaptionJobStore {
  readonly records = new Map<string, TikHubCaptionJobRecord>();
  readonly readKeys: string[] = [];
  readonly creates: TikHubCaptionJobRecord[] = [];
  readonly replacements: Array<{
    identity: TikHubCaptionJobIdentity;
    replacement: TikHubCaptionJobRecord;
  }> = [];
  readonly conditionalRemoves: TikHubCaptionJobIdentity[] = [];
  readFailure?: Error;
  createFailure?: Error;
  replaceFailure?: Error;
  conditionalRemoveFailure?: Error;
  beforeCreate?: (record: TikHubCaptionJobRecord) => void | Promise<void>;
  beforeReplace?: (
    identity: TikHubCaptionJobIdentity,
    replacement: TikHubCaptionJobRecord,
  ) => void | Promise<void>;
  beforeConditionalRemove?: (
    identity: TikHubCaptionJobIdentity,
  ) => void | Promise<void>;

  constructor(private readonly events?: string[]) {}

  async read(key: string): Promise<TikHubCaptionJobRecord | null> {
    this.events?.push("read-job");
    this.readKeys.push(key);
    if (this.readFailure) throw this.readFailure;
    const record = this.records.get(key);
    return record ? { ...record } : null;
  }

  async createIfAbsent(record: TikHubCaptionJobRecord): Promise<boolean> {
    this.events?.push("create-job");
    this.creates.push({ ...record });
    await this.beforeCreate?.(record);
    if (this.createFailure) throw this.createFailure;
    const key = keyFor(record);
    if (this.records.has(key)) return false;
    this.records.set(key, { ...record });
    return true;
  }

  async replaceIfCurrent(
    identity: TikHubCaptionJobIdentity,
    replacement: TikHubCaptionJobRecord,
  ): Promise<boolean> {
    this.events?.push("replace-job");
    this.replacements.push({
      identity: { ...identity },
      replacement: { ...replacement },
    });
    await this.beforeReplace?.(identity, replacement);
    if (this.replaceFailure) throw this.replaceFailure;
    const current = this.records.get(identity.key);
    if (!current || !matchesJobIdentity(current, identity)) return false;
    this.records.set(identity.key, { ...replacement });
    return true;
  }

  async removeIfCurrent(
    identity: TikHubCaptionJobIdentity,
  ): Promise<boolean> {
    this.events?.push("remove-current-job");
    this.conditionalRemoves.push({ ...identity });
    await this.beforeConditionalRemove?.(identity);
    if (this.conditionalRemoveFailure) throw this.conditionalRemoveFailure;
    const current = this.records.get(identity.key);
    if (!current || !matchesJobIdentity(current, identity)) return false;
    this.records.delete(identity.key);
    return true;
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

function identityFor(record: TikHubCaptionJobRecord): TikHubCaptionJobIdentity {
  return {
    key: keyFor(record),
    jobId: record.jobId,
    connectionId: record.connectionId,
  };
}

function matchesJobIdentity(
  record: TikHubCaptionJobRecord,
  identity: TikHubCaptionJobIdentity,
): boolean {
  return keyFor(record) === identity.key &&
    record.jobId === identity.jobId &&
    record.connectionId === identity.connectionId;
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
  const operation = expectOperationEnvelope<YouTubeCaptionTrack[]>(
    await harness.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
    PAID_EVIDENCE,
  );
  return { harness, track: operation.value[0] };
}

function expectCode(
  pending: Promise<unknown>,
  code: YouTubeTranscriptErrorCode,
  operationEvidence: TranscriptProviderOperationEvidence = FREE_EVIDENCE,
): Promise<void> {
  return expect(pending).rejects.toMatchObject({
    name: "YouTubeTranscriptError",
    code,
    message: code,
    operationEvidence,
  });
}

function expectOperationEnvelope<T>(
  value: unknown,
  expectedEvidence: TranscriptProviderOperationEvidence,
): TranscriptProviderOperationResult<T> {
  expect(isTranscriptProviderOperationResult(value)).toBe(true);
  expect(Object.isFrozen(value)).toBe(true);
  if (!isTranscriptProviderOperationResult(value)) {
    throw new Error("Expected a strict transcript provider operation result.");
  }
  expect(value.evidence).toEqual(expectedEvidence);
  expect(Object.isFrozen(value.evidence)).toBe(true);
  return value as TranscriptProviderOperationResult<T>;
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

    const tracks = expectOperationEnvelope<YouTubeCaptionTrack[]>(
      await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
      PAID_EVIDENCE,
    ).value;

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
    const [track] = expectOperationEnvelope<YouTubeCaptionTrack[]>(
      await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
      PAID_EVIDENCE,
    ).value;

    const transcript = expectOperationEnvelope<YouTubeTranscript>(
      await test.provider.fetchTrack(track, undefined, CONTEXT),
      PAID_EVIDENCE,
    ).value;
    expect(transcript).toEqual({
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
        PAID_EVIDENCE,
      );
    },
  );

  it("returns an explicit empty caption list after one paid list response", async () => {
    const client = new FakeCaptionClient([tracksData([])]);
    const test = createHarness({ client });

    const result = expectOperationEnvelope<YouTubeCaptionTrack[]>(
      await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
      PAID_EVIDENCE,
    );
    expect(result.value).toEqual([]);
    expect(client.paidInputs).toHaveLength(1);
    expect(client.resultInputs).toHaveLength(0);
  });

  it("reads the current key separately for paid list and content calls", async () => {
    const client = new FakeCaptionClient([
      tracksData(),
      contentData(),
    ]);
    const test = createHarness({ client });
    const [track] = expectOperationEnvelope<YouTubeCaptionTrack[]>(
      await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
      PAID_EVIDENCE,
    ).value;

    const transcript = expectOperationEnvelope<YouTubeTranscript>(
      await test.provider.fetchTrack(track, undefined, CONTEXT),
      PAID_EVIDENCE,
    ).value;

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
    const clonedFetch = expectOperationEnvelope<YouTubeTranscript>(
      await listed.harness.provider.fetchTrack(clone, undefined, CONTEXT),
      PAID_EVIDENCE,
    );
    expect(clonedFetch.value).toMatchObject({
      provider: "tikhub",
      videoId: VIDEO_ID,
    });
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

    const tracks = expectOperationEnvelope<YouTubeCaptionTrack[]>(
      await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
      PAID_EVIDENCE,
    ).value;

    expect(tracks).toHaveLength(1);
    expect(events).toEqual([
      "read-job",
      "paid",
      "create-job",
      "delay:3000",
      "result",
    ]);
    expect(jobs.creates[0]).toEqual({
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
    const [track] = expectOperationEnvelope<YouTubeCaptionTrack[]>(
      await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
      PAID_EVIDENCE,
    ).value;
    events.length = 0;

    const transcript = expectOperationEnvelope<YouTubeTranscript>(
      await test.provider.fetchTrack(track, undefined, CONTEXT),
      PAID_EVIDENCE,
    ).value;

    expect(transcript.videoId).toBe(VIDEO_ID);
    expect(transcript.text).toBe("Completed from the free result endpoint.");
    expect(events).toEqual([
      "read-job",
      "paid",
      "create-job",
      "delay:3000",
      "result",
    ]);
    expect(jobs.creates.at(-1)).toMatchObject({
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

    const tracks = expectOperationEnvelope<YouTubeCaptionTrack[]>(
      await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
      FREE_EVIDENCE,
    ).value;

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

    const transcript = expectOperationEnvelope<YouTubeTranscript>(
      await test.provider.fetchTrack(listed.track, undefined, CONTEXT),
      FREE_EVIDENCE,
    ).value;

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
      FREE_EVIDENCE,
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
    expect(jobs.conditionalRemoves).toEqual([]);
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
    const [track] = expectOperationEnvelope<YouTubeCaptionTrack[]>(
      await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
      PAID_EVIDENCE,
    ).value;

    await expectCode(
      test.provider.fetchTrack(track, controller.signal, CONTEXT),
      "aborted",
      PAID_EVIDENCE,
    );

    expect(jobs.records.has(
      captionJobKey(ITEM_ID, VIDEO_ID, "content", "en"),
    )).toBe(true);
    expect(jobs.conditionalRemoves).toEqual([]);
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
    expect(jobs.conditionalRemoves).toHaveLength(1);
    expect(jobs.records.size).toBe(0);
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
    expect(caught).toEqual(new YouTubeTranscriptError(
      "tikhub-job-expired",
      FREE_EVIDENCE,
    ));
    expect(JSON.stringify(caught)).not.toContain("private expired detail");
    expect(client.paidInputs).toHaveLength(0);
    expect(jobs.conditionalRemoves).toHaveLength(1);
    expect(jobs.records.size).toBe(0);
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
      PAID_EVIDENCE,
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
    expect(caught).toEqual(new YouTubeTranscriptError(
      "tikhub-malformed-response",
      FREE_EVIDENCE,
    ));
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

    expect(caught).toEqual(new YouTubeTranscriptError(code, FREE_EVIDENCE));
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
    unwritable.createFailure = new Error("private job bytes");
    const writeTest = createHarness({
      jobs: unwritable,
      client: new FakeCaptionClient([processingData()]),
    });
    await expectCode(
      writeTest.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
      "tikhub-budget-unavailable",
      PAID_EVIDENCE,
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

    await test.provider.onPersisted(
      listed.track,
      transcript,
      CONTEXT,
      identityFor(contentJob),
    );

    const contentKey = captionJobKey(ITEM_ID, VIDEO_ID, "content", "en");
    const tracksKey = captionJobKey(ITEM_ID, VIDEO_ID, "tracks");
    expect(jobs.conditionalRemoves).toEqual([identityFor(contentJob)]);
    expect(jobs.records.has(contentKey)).toBe(false);
    expect(jobs.records.has(tracksKey)).toBe(true);
    expect(test.getApiKey).not.toHaveBeenCalled();
  });

  describe("operation-bound paid request evidence", () => {
    it("attaches zero evidence to a stable validation error before any provider work", async () => {
      const test = createHarness();

      const error = await test.provider
        .listTracks("../invalid", undefined, {
          itemId: ITEM_ID,
          videoId: "../invalid",
        })
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "invalid-video-id",
        operationEvidence: FREE_EVIDENCE,
      });
      expect(test.getApiKey).not.toHaveBeenCalled();
      expect(test.jobs.readKeys).toEqual([]);
    });

    it("returns strict paid and free list envelopes without persistence tokens", async () => {
      const paid = createHarness({
        client: new FakeCaptionClient([tracksData()]),
      });
      const paidResult = expectOperationEnvelope<YouTubeCaptionTrack[]>(
        await paid.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
        { tikhubPaidRequests: 1, paidRequestAttempted: true },
      );
      expect(paidResult.value).toHaveLength(1);
      expect(Object.prototype.hasOwnProperty.call(
        paidResult,
        "persistenceToken",
      )).toBe(false);

      const jobs = new FakeJobs();
      putJob(jobs, jobRecord("tracks"));
      const resumed = createHarness({
        jobs,
        client: new FakeCaptionClient([], [completedTracksData()]),
      });
      const freeResult = expectOperationEnvelope<YouTubeCaptionTrack[]>(
        await resumed.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
        { tikhubPaidRequests: 0, paidRequestAttempted: false },
      );
      expect(freeResult.value).toHaveLength(1);
      expect(Object.prototype.hasOwnProperty.call(
        freeResult,
        "persistenceToken",
      )).toBe(false);
    });

    it("preserves one confirmed paid response when processing remains pending", async () => {
      const test = createHarness({
        client: new FakeCaptionClient(
          [processingData()],
          Array.from({ length: 10 }, () => pendingData()),
        ),
      });

      const error = await test.provider
        .listTracks(VIDEO_ID, undefined, CONTEXT)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "tikhub-processing",
        operationEvidence: {
          tikhubPaidRequests: 1,
          paidRequestAttempted: true,
        },
      });
    });

    it("preserves confirmed paid evidence when local job timestamping fails after processing", async () => {
      const test = createHarness({
        client: new FakeCaptionClient([processingData()]),
        clock: () => new Date(Number.NaN),
      });

      const error = await test.provider
        .listTracks(VIDEO_ID, undefined, CONTEXT)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "tikhub-malformed-response",
        operationEvidence: PAID_EVIDENCE,
      });
      expect(test.jobs.creates).toEqual([]);
    });

    it("counts a successful paid client response even when the caller aborts before domain parsing", async () => {
      const controller = new AbortController();
      const test = createHarness({
        client: new AbortAfterPaidResponseClient(controller),
      });

      const error = await test.provider
        .listTracks(VIDEO_ID, controller.signal, CONTEXT)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "aborted",
        operationEvidence: PAID_EVIDENCE,
      });
    });

    it.each([false, true])(
      "keeps a paid client failure before successful resolution unconfirmed when attempted=%s",
      async (paidRequestAttempted) => {
        const test = createHarness({
          client: new FakeCaptionClient([
            new TikHubClientError(
              "network-failure",
              "private transport detail",
              undefined,
              undefined,
              paidRequestAttempted,
            ),
          ]),
        });

        const error = await test.provider
          .listTracks(VIDEO_ID, undefined, CONTEXT)
          .catch((caught: unknown) => caught);

        expect(error).toMatchObject({
          code: "temporarily-unavailable",
          operationEvidence: {
            tikhubPaidRequests: 0,
            paidRequestAttempted,
          },
        });
        expect(JSON.stringify(error)).not.toContain("private transport detail");
      },
    );
  });

  describe("expired job recovery", () => {
    it("clears a changed-connection job, ends the current call, and allows only the next explicit call to pay", async () => {
      const jobs = new FakeJobs();
      const expired = jobRecord("tracks", {
        connectionId: OTHER_CONNECTION_ID,
      });
      putJob(jobs, expired);
      const client = new FakeCaptionClient([tracksData()]);
      const test = createHarness({ client, jobs });

      const firstError = await test.provider
        .listTracks(VIDEO_ID, undefined, CONTEXT)
        .catch((caught: unknown) => caught);

      expect(firstError).toMatchObject({
        code: "tikhub-job-expired",
        operationEvidence: {
          tikhubPaidRequests: 0,
          paidRequestAttempted: false,
        },
      });
      expect(client.paidInputs).toHaveLength(0);
      expect(jobs.conditionalRemoves).toEqual([identityFor(expired)]);
      expect(jobs.records.has(keyFor(expired))).toBe(false);

      const second = expectOperationEnvelope<YouTubeCaptionTrack[]>(
        await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
        { tikhubPaidRequests: 1, paidRequestAttempted: true },
      );
      expect(second.value).toHaveLength(1);
      expect(client.paidInputs).toHaveLength(1);
    });

    it.each([
      new TikHubClientError("invalid-query", "private expired detail", 422),
      new TikHubClientError("provider-rejected", "private expired detail", 404),
    ])("conditionally clears an expired free-result job without paying", async (failure) => {
      const jobs = new FakeJobs();
      const expired = jobRecord("tracks");
      putJob(jobs, expired);
      const client = new FakeCaptionClient([], [failure]);
      const test = createHarness({ client, jobs });

      const error = await test.provider
        .listTracks(VIDEO_ID, undefined, CONTEXT)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "tikhub-job-expired",
        operationEvidence: {
          tikhubPaidRequests: 0,
          paidRequestAttempted: false,
        },
      });
      expect(client.paidInputs).toHaveLength(0);
      expect(jobs.conditionalRemoves).toEqual([identityFor(expired)]);
      expect(jobs.records.has(keyFor(expired))).toBe(false);
    });

    it("preserves paid evidence while clearing a job rejected by the first free poll", async () => {
      const jobs = new FakeJobs();
      const client = new FakeCaptionClient(
        [processingData()],
        [new TikHubClientError("provider-rejected", "private expired detail", 404)],
      );
      const test = createHarness({ client, jobs });

      const error = await test.provider
        .listTracks(VIDEO_ID, undefined, CONTEXT)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "tikhub-job-expired",
        operationEvidence: PAID_EVIDENCE,
      });
      expect(client.paidInputs).toHaveLength(1);
      expect(client.resultInputs).toHaveLength(1);
      expect(jobs.conditionalRemoves).toEqual([
        identityFor(jobs.creates[0]),
      ]);
      expect(jobs.records.size).toBe(0);
    });

    it("fails closed without paying when expired cleanup cannot become durable", async () => {
      const jobs = new FakeJobs();
      const expired = jobRecord("tracks", {
        connectionId: OTHER_CONNECTION_ID,
      });
      putJob(jobs, expired);
      jobs.conditionalRemoveFailure = new Error("private storage failure");
      const client = new FakeCaptionClient([tracksData()]);
      const test = createHarness({ client, jobs });

      const error = await test.provider
        .listTracks(VIDEO_ID, undefined, CONTEXT)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "tikhub-budget-unavailable",
        operationEvidence: {
          tikhubPaidRequests: 0,
          paidRequestAttempted: false,
        },
      });
      expect(client.paidInputs).toHaveLength(0);
      expect(jobs.records.get(keyFor(expired))).toEqual(expired);
    });

    it("preserves a newer winner when expired cleanup loses the CAS", async () => {
      const jobs = new FakeJobs();
      const expired = jobRecord("tracks", {
        connectionId: OTHER_CONNECTION_ID,
      });
      const winner = jobRecord("tracks", {
        jobId: OTHER_JOB_ID,
        lastCheckedAt: NOW,
      });
      putJob(jobs, expired);
      jobs.beforeConditionalRemove = () => putJob(jobs, winner);
      const client = new FakeCaptionClient([tracksData()]);
      const test = createHarness({ client, jobs });

      const error = await test.provider
        .listTracks(VIDEO_ID, undefined, CONTEXT)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: "tikhub-job-expired" });
      expect(client.paidInputs).toHaveLength(0);
      expect(jobs.records.get(keyFor(winner))).toEqual(winner);
    });
  });

  describe("job CAS and durable cleanup tokens", () => {
    it("preserves the create-if-absent winner and returns paid processing without polling", async () => {
      const jobs = new FakeJobs();
      const winner = jobRecord("tracks", {
        jobId: OTHER_JOB_ID,
        lastCheckedAt: NOW,
      });
      jobs.beforeCreate = () => putJob(jobs, winner);
      const client = new FakeCaptionClient([processingData()]);
      const test = createHarness({ client, jobs });

      const error = await test.provider
        .listTracks(VIDEO_ID, undefined, CONTEXT)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "tikhub-processing",
        operationEvidence: {
          tikhubPaidRequests: 1,
          paidRequestAttempted: true,
        },
      });
      expect(jobs.creates).toHaveLength(1);
      expect(client.resultInputs).toHaveLength(0);
      expect(test.delay).not.toHaveBeenCalled();
      expect(jobs.records.get(keyFor(winner))).toEqual(winner);
    });

    it("stops a stale poll when replace-if-current loses without overwriting the winner", async () => {
      const jobs = new FakeJobs();
      const stale = jobRecord("tracks");
      const winner = jobRecord("tracks", {
        jobId: OTHER_JOB_ID,
        lastCheckedAt: NOW,
      });
      putJob(jobs, stale);
      jobs.beforeReplace = () => putJob(jobs, winner);
      const client = new FakeCaptionClient([], [pendingData()]);
      const test = createHarness({ client, jobs });

      const error = await test.provider
        .listTracks(VIDEO_ID, undefined, CONTEXT)
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: "tikhub-job-expired",
        operationEvidence: {
          tikhubPaidRequests: 0,
          paidRequestAttempted: false,
        },
      });
      expect(client.paidInputs).toHaveLength(0);
      expect(client.resultInputs).toHaveLength(1);
      expect(jobs.replacements).toHaveLength(1);
      expect(jobs.records.get(keyFor(winner))).toEqual(winner);
    });

    it("carries the exact completed content job token and removes only that identity after persistence", async () => {
      const listHarness = createHarness({
        client: new FakeCaptionClient([tracksData()]),
      });
      const listed = expectOperationEnvelope<YouTubeCaptionTrack[]>(
        await listHarness.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
        { tikhubPaidRequests: 1, paidRequestAttempted: true },
      );
      const jobs = new FakeJobs();
      const contentJob = jobRecord("content");
      putJob(jobs, contentJob);
      const test = createHarness({
        jobs,
        client: new FakeCaptionClient([], [completedContentData()]),
      });

      const fetched = expectOperationEnvelope<YouTubeTranscript>(
        await test.provider.fetchTrack(listed.value[0], undefined, CONTEXT),
        { tikhubPaidRequests: 0, paidRequestAttempted: false },
      );
      expect(fetched.persistenceToken).toEqual(identityFor(contentJob));
      expect(Object.keys(fetched.persistenceToken as object).sort()).toEqual([
        "connectionId",
        "jobId",
        "key",
      ]);

      await test.provider.onPersisted(
        listed.value[0],
        fetched.value,
        CONTEXT,
        fetched.persistenceToken,
      );

      expect(jobs.conditionalRemoves).toEqual([identityFor(contentJob)]);
      expect(jobs.records.has(keyFor(contentJob))).toBe(false);
    });

    it("keeps a newer content replacement when an old persistence token loses the CAS", async () => {
      const listHarness = createHarness({
        client: new FakeCaptionClient([tracksData()]),
      });
      const listed = expectOperationEnvelope<YouTubeCaptionTrack[]>(
        await listHarness.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
        { tikhubPaidRequests: 1, paidRequestAttempted: true },
      );
      const jobs = new FakeJobs();
      const completed = jobRecord("content");
      const winner = jobRecord("content", {
        jobId: OTHER_JOB_ID,
        lastCheckedAt: NOW,
      });
      putJob(jobs, completed);
      const test = createHarness({
        jobs,
        client: new FakeCaptionClient([], [completedContentData()]),
      });
      const fetched = expectOperationEnvelope<YouTubeTranscript>(
        await test.provider.fetchTrack(listed.value[0], undefined, CONTEXT),
        { tikhubPaidRequests: 0, paidRequestAttempted: false },
      );
      jobs.beforeConditionalRemove = () => putJob(jobs, winner);

      await test.provider.onPersisted(
        listed.value[0],
        fetched.value,
        CONTEXT,
        fetched.persistenceToken,
      );

      expect(jobs.records.get(keyFor(winner))).toEqual(winner);
    });

    it("does not delete a later content job after synchronous content without a token", async () => {
      const client = new FakeCaptionClient([tracksData(), contentData()]);
      const jobs = new FakeJobs();
      const test = createHarness({ client, jobs });
      const listed = expectOperationEnvelope<YouTubeCaptionTrack[]>(
        await test.provider.listTracks(VIDEO_ID, undefined, CONTEXT),
        { tikhubPaidRequests: 1, paidRequestAttempted: true },
      );
      const fetched = expectOperationEnvelope<YouTubeTranscript>(
        await test.provider.fetchTrack(listed.value[0], undefined, CONTEXT),
        { tikhubPaidRequests: 1, paidRequestAttempted: true },
      );
      expect(Object.prototype.hasOwnProperty.call(
        fetched,
        "persistenceToken",
      )).toBe(false);
      const later = jobRecord("content", {
        jobId: OTHER_JOB_ID,
        lastCheckedAt: NOW,
      });
      putJob(jobs, later);

      await test.provider.onPersisted(
        listed.value[0],
        fetched.value,
        CONTEXT,
        undefined,
      );

      expect(jobs.conditionalRemoves).toEqual([]);
      expect(jobs.records.get(keyFor(later))).toEqual(later);
    });

    it("rejects an expanded persistence token without touching the stored content job", async () => {
      const listed = await listedTrack();
      const jobs = new FakeJobs();
      const contentJob = jobRecord("content");
      putJob(jobs, contentJob);
      const test = createHarness({ jobs });
      const transcript: YouTubeTranscript = {
        videoId: VIDEO_ID,
        languageCode: "en",
        languageName: "English",
        isGenerated: false,
        provider: "tikhub",
        text: "Durably cached caption.",
      };

      await expectCode(
        test.provider.onPersisted(
          listed.track,
          transcript,
          CONTEXT,
          { ...identityFor(contentJob), unexpected: "not-allowed" },
        ),
        "tikhub-malformed-response",
      );

      expect(jobs.conditionalRemoves).toEqual([]);
      expect(jobs.records.get(keyFor(contentJob))).toEqual(contentJob);
    });
  });
});

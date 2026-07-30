import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedItemContent } from "../../../src/collection/content-repository";
import { YouTubeTranscriptPanel } from "../../../src/components/youtube-transcript-panel";
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
import { YouTubeTranscriptError } from "../../../src/youtube-transcript/transcript-types";
import {
  YouTubeTranscriptService,
  type TranscriptCacheRepository,
  type TranscriptMetadataRepository,
} from "../../../src/youtube-transcript/youtube-transcript-service";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

installObsidianDomPolyfills();

const ITEM_ID = "a".repeat(64);
const VIDEO_ID = "dQw4w9WgXcQ";
const CONNECTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const JOB_ID = "223e4567-e89b-12d3-a456-426614174000";

class DurableFakeJobs implements TikHubCaptionJobStore {
  readonly records = new Map<string, TikHubCaptionJobRecord>();

  async read(key: string): Promise<TikHubCaptionJobRecord | null> {
    return clone(this.records.get(key));
  }

  async findPendingContentJob(
    itemId: string,
    videoId: string,
  ): Promise<TikHubCaptionJobRecord | null> {
    const matches = [...this.records.values()].filter(
      (record) =>
        record.stage === "content" &&
        record.itemId === itemId &&
        record.videoId === videoId,
    );
    if (matches.length > 1) throw new Error("ambiguous test fixture");
    return clone(matches[0]);
  }

  async createIfAbsent(record: TikHubCaptionJobRecord): Promise<boolean> {
    const key = jobKey(record);
    if (this.records.has(key)) return false;
    this.records.set(key, { ...record });
    return true;
  }

  async replaceIfCurrent(
    identity: TikHubCaptionJobIdentity,
    replacement: TikHubCaptionJobRecord,
  ): Promise<boolean> {
    const current = this.records.get(identity.key);
    if (!current || !sameIdentity(current, identity)) return false;
    this.records.set(identity.key, { ...replacement });
    return true;
  }

  async removeIfCurrent(identity: TikHubCaptionJobIdentity): Promise<boolean> {
    const current = this.records.get(identity.key);
    if (!current || !sameIdentity(current, identity)) return false;
    this.records.delete(identity.key);
    return true;
  }
}

class CountingFakeClient implements TikHubCaptionClient {
  paidCalls = 0;
  freeCalls = 0;
  readonly paidResponses: TikHubResult<unknown>[] = [];
  readonly freeResponses: TikHubResult<unknown>[] = [];

  async fetchYouTubeCaptions(): Promise<TikHubResult<unknown>> {
    this.paidCalls += 1;
    const next = this.paidResponses.shift();
    if (!next) throw new Error("missing paid test response");
    return next;
  }

  async fetchYouTubeCaptionResult(): Promise<TikHubResult<unknown>> {
    this.freeCalls += 1;
    const next = this.freeResponses.shift();
    if (!next) throw new Error("missing free test response");
    return next;
  }
}

class MemoryContent implements TranscriptCacheRepository {
  value: CachedItemContent | null = null;

  async transaction<T>(
    _itemId: string,
    operation: (transaction: {
      read(): Promise<CachedItemContent | null>;
      write(content: CachedItemContent): Promise<string>;
      pathFor(): string;
    }) => Promise<T>,
  ): Promise<T> {
    return await operation({
      read: async () => this.value,
      write: async (content) => {
        this.value = content;
        return `.rss-dashboard-data/content/${ITEM_ID}.md`;
      },
      pathFor: () => `.rss-dashboard-data/content/${ITEM_ID}.md`,
    });
  }
}

const metadata: TranscriptMetadataRepository = {
  async updateContentMetadata() {
    return await Promise.resolve();
  },
};

function settings(): TikHubSettings {
  return {
    enabled: true,
    youtubeTranscriptFallbackEnabled: true,
    connectionId: CONNECTION_ID,
    baseUrl: "https://api.tikhub.io",
    timeoutMs: 20_000,
    maxRequestsPerRun: 40,
    maxRequestsPerDay: 100,
  };
}

function createRuntime(
  jobs: DurableFakeJobs,
  client: CountingFakeClient,
  content: MemoryContent,
  getApiKey = vi.fn(async () => "synthetic-test-key"),
) {
  const provider = new TikHubTranscriptProvider({
    getSettings: settings,
    getApiKey,
    createClient: () => client,
    jobs,
    clock: () => new Date("2026-07-30T03:00:00.000Z"),
    delay: async () => undefined,
  });
  const service = new YouTubeTranscriptService({
    providers: [
      {
        source: "innertube",
        provider: {
          async listTracks() {
            throw new YouTubeTranscriptError("no-captions");
          },
          async fetchTrack() {
            throw new Error("unreachable");
          },
        },
      },
      {
        source: "tikhub",
        provider,
        isAvailable: async () => await provider.isAvailable(),
      },
      {
        source: "yt-dlp",
        provider: {
          async listTracks() {
            throw new Error("unreachable");
          },
          async fetchTrack() {
            throw new Error("unreachable");
          },
        },
        isAvailable: async () => false,
      },
    ],
    contentRepository: content,
    metadataRepository: metadata,
    clock: () => new Date("2026-07-30T03:00:00.000Z"),
  });
  return { service, getApiKey };
}

function createPanel(service: YouTubeTranscriptService) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const panel = new YouTubeTranscriptPanel({
    container,
    locale: "en",
    request: { itemId: ITEM_ID, videoId: VIDEO_ID },
    resolveRuntime: () => ({ identity: "test-root", service }),
    openExternal: vi.fn(),
  });
  return { panel, container };
}

async function startPaidContentJob(
  panel: YouTubeTranscriptPanel,
  container: HTMLElement,
  client: CountingFakeClient,
): Promise<void> {
  client.paidResponses.push(
    {
      data: {
        video_id: VIDEO_ID,
        captions: [
          { language_code: "en", language_name: "English" },
          { language_code: "ja", language_name: "Japanese" },
        ],
      },
    },
    { data: { video_id: VIDEO_ID, status: "processing", job_id: JOB_ID } },
  );
  client.freeResponses.push(
    ...Array.from({ length: 10 }, () => ({
      data: { status: "active", job_id: JOB_ID },
    })),
  );

  await panel.fetch();
  const language = container.querySelector<HTMLButtonElement>(
    ".rss-youtube-transcript-language",
  );
  language?.click();
  await vi.waitFor(() => {
    expect(container.querySelector(".rss-youtube-transcript-continue")).not
      .toBeNull();
  });
  expect(container.textContent).toContain("$0.016");
  expect(client.paidCalls).toBe(2);
}

function completedContent(): TikHubResult<unknown> {
  return {
    data: {
      status: "completed",
      job_id: JOB_ID,
      language_code: "en",
      language_name: "English",
      format: "txt",
      content: "Completed by the free continuation.",
      available_languages: ["en"],
    },
  };
}

describe("TikHub durable continuation integration", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("continues a two-request content job in the same panel without relisting", async () => {
    const jobs = new DurableFakeJobs();
    const client = new CountingFakeClient();
    const content = new MemoryContent();
    const runtime = createRuntime(jobs, client, content);
    const { panel, container } = createPanel(runtime.service);
    await startPaidContentJob(panel, container, client);
    client.freeResponses.push(completedContent());

    container
      .querySelector<HTMLButtonElement>(".rss-youtube-transcript-continue")
      ?.click();
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Completed by the free continuation.");
    });

    expect(container.textContent).toContain("$0.016");
    expect(client.paidCalls).toBe(2);
    expect(content.value).toMatchObject({ provider: "tikhub" });
    expect(jobs.records.size).toBe(0);
  });

  it("passively detects and explicitly continues the same durable job after recreation", async () => {
    const jobs = new DurableFakeJobs();
    const client = new CountingFakeClient();
    const content = new MemoryContent();
    const firstRuntime = createRuntime(jobs, client, content);
    const firstPanel = createPanel(firstRuntime.service);
    await startPaidContentJob(firstPanel.panel, firstPanel.container, client);
    firstPanel.panel.destroy();
    firstRuntime.service.dispose();
    const freeCallsBeforeOpen = client.freeCalls;
    const keyReads = vi.fn(async () => "synthetic-test-key");
    const recreated = createRuntime(jobs, client, content, keyReads);
    const secondPanel = createPanel(recreated.service);

    await secondPanel.panel.showCached();

    expect(secondPanel.container.querySelector(
      ".rss-youtube-transcript-continue",
    )).not.toBeNull();
    expect(keyReads).not.toHaveBeenCalled();
    expect(client.paidCalls).toBe(2);
    expect(client.freeCalls).toBe(freeCallsBeforeOpen);
    expect(secondPanel.container.textContent).not.toContain("$0.016");

    client.freeResponses.push(completedContent());
    secondPanel.container
      .querySelector<HTMLButtonElement>(".rss-youtube-transcript-continue")
      ?.click();
    await vi.waitFor(() => {
      expect(secondPanel.container.textContent).toContain(
        "Completed by the free continuation.",
      );
    });

    expect(keyReads).toHaveBeenCalledTimes(1);
    expect(client.paidCalls).toBe(2);
    expect(jobs.records.size).toBe(0);
    expect(secondPanel.container.textContent).not.toContain("$0.016");
  });
});

function jobKey(record: TikHubCaptionJobRecord): string {
  return captionJobKey(
    record.itemId,
    record.videoId,
    record.stage,
    record.languageCode,
  );
}

function sameIdentity(
  record: TikHubCaptionJobRecord,
  identity: TikHubCaptionJobIdentity,
): boolean {
  return jobKey(record) === identity.key &&
    record.jobId === identity.jobId &&
    record.connectionId === identity.connectionId;
}

function clone(
  record: TikHubCaptionJobRecord | undefined,
): TikHubCaptionJobRecord | null {
  return record ? { ...record } : null;
}

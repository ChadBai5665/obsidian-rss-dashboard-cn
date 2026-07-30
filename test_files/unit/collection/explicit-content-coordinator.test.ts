import type { Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { CollectionRepository } from "../../../src/collection/collection-repository";
import { ContentRepository } from "../../../src/collection/content-repository";
import { ExplicitContentCoordinator } from "../../../src/collection/explicit-content-coordinator";
import {
  YouTubeTranscriptService,
  type TranscriptMetadataRepository,
  type TranscriptProvider,
} from "../../../src/youtube-transcript/youtube-transcript-service";
import type { YouTubeCaptionTrack } from "../../../src/youtube-transcript/transcript-types";

const DATA_ROOT = ".rss-dashboard-data";
const ITEM_ID = "f".repeat(64);

class InMemoryAdapter {
  readonly files = new Map<string, string>();
  private readonly directories = new Set<string>();
  private renameBarrier:
    | {
        predicate: (from: string, to: string) => boolean;
        reached: () => void;
        wait: Promise<void>;
      }
    | null = null;

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async mkdir(path: string): Promise<void> {
    const parent = parentPath(path);
    if (parent && !this.directories.has(parent)) {
      throw new Error(`Missing parent directory: ${parent}`);
    }
    this.directories.add(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing file: ${path}`);
    return value;
  }

  async write(path: string, value: string): Promise<void> {
    const parent = parentPath(path);
    if (parent && !this.directories.has(parent)) {
      throw new Error(`Missing parent directory: ${parent}`);
    }
    this.files.set(path, value);
  }

  async rename(from: string, to: string): Promise<void> {
    const barrier = this.renameBarrier;
    if (barrier?.predicate(from, to)) {
      this.renameBarrier = null;
      barrier.reached();
      await barrier.wait;
    }
    const value = this.files.get(from);
    if (value === undefined) throw new Error(`Missing rename source: ${from}`);
    if (this.files.has(to)) throw new Error(`Destination exists: ${to}`);
    this.files.set(to, value);
    this.files.delete(from);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`;
    return {
      files: [...this.files.keys()].filter(
        (candidate) =>
          candidate.startsWith(prefix) &&
          !candidate.slice(prefix.length).includes("/"),
      ),
      folders: [...this.directories].filter(
        (candidate) =>
          candidate.startsWith(prefix) &&
          !candidate.slice(prefix.length).includes("/"),
      ),
    };
  }

  pauseNextRenameWhere(
    predicate: (from: string, to: string) => boolean,
  ): { reached: Promise<void>; release: () => void } {
    let markReached!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.renameBarrier = { predicate, reached: markReached, wait };
    return { reached, release };
  }
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

const CAPTION_TRACK: YouTubeCaptionTrack = {
  languageCode: "en",
  languageName: "English",
  isGenerated: false,
  source: "innertube",
  url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
  format: "json3",
};

function createTranscriptService(
  repository: ContentRepository,
  metadataRepository: TranscriptMetadataRepository,
): YouTubeTranscriptService {
  const innerTube: TranscriptProvider = {
    async listTracks() {
      return [CAPTION_TRACK];
    },
    async fetchTrack() {
      return {
        videoId: "dQw4w9WgXcQ",
        languageCode: "en",
        languageName: "English",
        isGenerated: false,
        provider: "innertube",
        text: "Fresh transcript wins only with matching metadata.",
      };
    },
  };
  return new YouTubeTranscriptService({
    innerTube,
    ytDlp: {
      ...innerTube,
      async isAvailable() {
        return false;
      },
    },
    contentRepository: repository,
    metadataRepository,
    clock: () => new Date("2026-07-28T06:00:00.000Z"),
  });
}

function fullTextFetch() {
  return Promise.resolve({
    content: "<p>" + "Publisher article content ".repeat(20) + "</p>",
    failureType: "none" as const,
  });
}

describe("ExplicitContentCoordinator", () => {
  it("ignores a transcript artifact when ordinary article full text is requested", async () => {
    const adapter = new InMemoryAdapter();
    const vault = { adapter } as unknown as Vault;
    const repository = new ContentRepository(vault, DATA_ROOT, () => new Date());
    await repository.write({
      schemaVersion: 2,
      contentBasis: "youtube-transcript",
      itemId: ITEM_ID,
      sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      fetchedAt: "2026-07-21T12:00:00.000Z",
      videoId: "dQw4w9WgXcQ",
      languageCode: "en",
      languageName: "English",
      isGenerated: false,
      provider: "innertube",
      text: "Cached transcript must not be returned as an article body.",
    });
    let fetches = 0;

    const result = await new ExplicitContentCoordinator(vault).readOrFetch({
      dataRoot: DATA_ROOT,
      itemId: ITEM_ID,
      fetch: async () => {
        fetches += 1;
        return {
          content: "<p>" + "Publisher article content ".repeat(20) + "</p>",
          failureType: "none",
        };
      },
    });

    expect(fetches).toBe(1);
    expect(result.content).toContain("Publisher article content");
    expect((await repository.read(ITEM_ID))?.contentBasis).toBe("full-text");
  });

  it("keeps transcript metadata consistent when full-text sync starts first", async () => {
    const adapter = new InMemoryAdapter();
    const vault = { adapter } as unknown as Vault;
    const repository = new ContentRepository(vault, DATA_ROOT, () => new Date());
    let metadataBasis: "full-text" | "youtube-transcript" | undefined;
    let markFullSync!: () => void;
    const fullSyncReached = new Promise<void>((resolve) => {
      markFullSync = resolve;
    });
    let releaseFullSync!: () => void;
    const holdFullSync = new Promise<void>((resolve) => {
      releaseFullSync = resolve;
    });
    const updateSpy = vi
      .spyOn(CollectionRepository.prototype, "updateContentMetadata")
      .mockImplementation(async (_id, _path, basis = "full-text") => {
        markFullSync();
        await holdFullSync;
        metadataBasis = basis;
      });
    const transcriptService = createTranscriptService(repository, {
      async updateContentMetadata(_id, _path, basis) {
        metadataBasis = basis;
      },
    });

    try {
      const fullText = new ExplicitContentCoordinator(vault).readOrFetch({
        dataRoot: DATA_ROOT,
        itemId: ITEM_ID,
        fetch: fullTextFetch,
      });
      await fullSyncReached;
      let transcriptFinished = false;
      const transcript = transcriptService.get({
        itemId: ITEM_ID,
        videoId: "dQw4w9WgXcQ",
        refresh: true,
      }).then((result) => {
        transcriptFinished = true;
        return result;
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(transcriptFinished).toBe(false);

      releaseFullSync();
      await Promise.all([fullText, transcript]);
      expect((await repository.read(ITEM_ID))?.contentBasis).toBe(
        "youtube-transcript",
      );
      expect(metadataBasis).toBe("youtube-transcript");
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("keeps full-text metadata consistent when transcript sync starts first", async () => {
    const adapter = new InMemoryAdapter();
    const vault = { adapter } as unknown as Vault;
    const repository = new ContentRepository(vault, DATA_ROOT, () => new Date());
    let metadataBasis: "full-text" | "youtube-transcript" | undefined;
    let markTranscriptSync!: () => void;
    const transcriptSyncReached = new Promise<void>((resolve) => {
      markTranscriptSync = resolve;
    });
    let releaseTranscriptSync!: () => void;
    const holdTranscriptSync = new Promise<void>((resolve) => {
      releaseTranscriptSync = resolve;
    });
    const updateSpy = vi
      .spyOn(CollectionRepository.prototype, "updateContentMetadata")
      .mockImplementation(async (_id, _path, basis = "full-text") => {
        metadataBasis = basis;
      });
    const transcriptService = createTranscriptService(repository, {
      async updateContentMetadata(_id, _path, basis) {
        markTranscriptSync();
        await holdTranscriptSync;
        metadataBasis = basis;
      },
    });

    try {
      const transcript = transcriptService.get({
        itemId: ITEM_ID,
        videoId: "dQw4w9WgXcQ",
        refresh: true,
      });
      await transcriptSyncReached;
      let fullTextFinished = false;
      const fullText = new ExplicitContentCoordinator(vault).readOrFetch({
        dataRoot: DATA_ROOT,
        itemId: ITEM_ID,
        fetch: fullTextFetch,
      }).then((result) => {
        fullTextFinished = true;
        return result;
      });
      await Promise.resolve();
      expect(fullTextFinished).toBe(false);

      releaseTranscriptSync();
      await Promise.all([transcript, fullText]);
      expect((await repository.read(ITEM_ID))?.contentBasis).toBe("full-text");
      expect(metadataBasis).toBe("full-text");
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("serializes transcript cache repair with a competing full-text write", async () => {
    const adapter = new InMemoryAdapter();
    const vault = { adapter } as unknown as Vault;
    const repository = new ContentRepository(vault, DATA_ROOT, () => new Date());
    await repository.write({
      schemaVersion: 2,
      contentBasis: "youtube-transcript",
      itemId: ITEM_ID,
      fetchedAt: "2026-07-28T05:00:00.000Z",
      videoId: "dQw4w9WgXcQ",
      languageCode: "en",
      languageName: "English",
      isGenerated: false,
      provider: "innertube",
      text: "Cached transcript awaiting metadata repair.",
    });
    let metadataBasis: "full-text" | "youtube-transcript" | undefined;
    let markRepair!: () => void;
    const repairReached = new Promise<void>((resolve) => {
      markRepair = resolve;
    });
    let releaseRepair!: () => void;
    const holdRepair = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    const updateSpy = vi
      .spyOn(CollectionRepository.prototype, "updateContentMetadata")
      .mockImplementation(async (_id, _path, basis = "full-text") => {
        metadataBasis = basis;
      });
    const transcriptService = createTranscriptService(repository, {
      async updateContentMetadata(_id, _path, basis) {
        markRepair();
        await holdRepair;
        metadataBasis = basis;
      },
    });

    try {
      const repair = transcriptService.get({
        itemId: ITEM_ID,
        videoId: "dQw4w9WgXcQ",
      });
      await repairReached;
      let fullTextFinished = false;
      const fullText = new ExplicitContentCoordinator(vault).readOrFetch({
        dataRoot: DATA_ROOT,
        itemId: ITEM_ID,
        fetch: fullTextFetch,
      }).then((result) => {
        fullTextFinished = true;
        return result;
      });
      await Promise.resolve();
      expect(fullTextFinished).toBe(false);

      releaseRepair();
      await Promise.all([repair, fullText]);
      expect((await repository.read(ITEM_ID))?.contentBasis).toBe("full-text");
      expect(metadataBasis).toBe("full-text");
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("syncs transcript metadata after an atomic write commits despite a newer intent", async () => {
    const adapter = new InMemoryAdapter();
    const vault = { adapter } as unknown as Vault;
    const contentRepository = new ContentRepository(
      vault,
      DATA_ROOT,
      () => new Date("2026-07-28T06:00:00.000Z"),
    );
    const collectionRepository = new CollectionRepository(
      vault,
      DATA_ROOT,
      () => new Date("2026-07-28T06:00:00.000Z"),
    );
    await collectionRepository.upsertDaily(
      [
        {
          schemaVersion: 1,
          id: ITEM_ID,
          sourceType: "youtube",
          sourceId: "youtube-source",
          sourceName: "YouTube source",
          sourceBucket: "Videos",
          title: "Transcript race",
          fetchedAt: "2026-07-28T06:00:00.000Z",
          firstSeenAt: "2026-07-28T06:00:00.000Z",
          lastSeenAt: "2026-07-28T06:00:00.000Z",
          observationType: "new",
          topics: [],
          contentBasis: "feed",
          read: false,
          starred: false,
          saved: false,
          collectionStatus: "collected",
        },
      ],
      "2026-07-28",
    );
    const chineseTracks: YouTubeCaptionTrack[] = [
      {
        ...CAPTION_TRACK,
        languageCode: "zh-CN",
        languageName: "中文 A",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=zh-CN",
      },
      {
        ...CAPTION_TRACK,
        languageCode: "zh-TW",
        languageName: "中文 B",
        url: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=zh-TW",
      },
    ];
    let listCalls = 0;
    const innerTube: TranscriptProvider = {
      async listTracks() {
        listCalls += 1;
        return listCalls === 1 ? [CAPTION_TRACK] : chineseTracks;
      },
      async fetchTrack(selectedTrack) {
        return {
          videoId: "dQw4w9WgXcQ",
          languageCode: selectedTrack.languageCode,
          languageName: selectedTrack.languageName,
          isGenerated: selectedTrack.isGenerated,
          provider: selectedTrack.source,
          text: `Durable ${selectedTrack.languageName} transcript.`,
        };
      },
    };
    const service = new YouTubeTranscriptService({
      innerTube,
      ytDlp: {
        ...innerTube,
        async isAvailable() {
          return false;
        },
      },
      contentRepository,
      metadataRepository: collectionRepository,
      clock: () => new Date("2026-07-28T06:00:00.000Z"),
    });
    const contentPath = `${DATA_ROOT}/content/${ITEM_ID}.md`;
    const barrier = adapter.pauseNextRenameWhere(
      (from, to) => from.includes(".tmp-") && to === contentPath,
    );
    const older = service.get({
      itemId: ITEM_ID,
      videoId: "dQw4w9WgXcQ",
      refresh: true,
      preferredLanguage: "en",
    });
    await barrier.reached;
    const newer = await service.get({
      itemId: ITEM_ID,
      videoId: "dQw4w9WgXcQ",
      refresh: true,
      preferredLanguage: "zh",
    });
    if (newer.status !== "selection-required") throw new Error("expected choices");
    barrier.release();

    await expect(older).rejects.toMatchObject({
      code: "temporarily-unavailable",
    });
    await expect(contentRepository.read(ITEM_ID)).resolves.toMatchObject({
      contentBasis: "youtube-transcript",
      languageName: "English",
    });
    await expect(collectionRepository.findById(ITEM_ID)).resolves.toMatchObject({
      contentBasis: "youtube-transcript",
      contentPath,
    });

    await expect(
      service.get({
        itemId: ITEM_ID,
        videoId: "dQw4w9WgXcQ",
        trackId: newer.tracks[0].id,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      content: { languageName: "中文 A" },
    });
    await expect(contentRepository.read(ITEM_ID)).resolves.toMatchObject({
      contentBasis: "youtube-transcript",
      languageName: "中文 A",
    });
    await expect(collectionRepository.findById(ITEM_ID)).resolves.toMatchObject({
      contentBasis: "youtube-transcript",
      contentPath,
    });
  });
});

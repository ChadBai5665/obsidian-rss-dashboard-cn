import type { Vault } from "obsidian";
import { describe, expect, it } from "vitest";
import { ContentRepository } from "../../../src/collection/content-repository";
import { ExplicitContentCoordinator } from "../../../src/collection/explicit-content-coordinator";

const DATA_ROOT = ".rss-dashboard-data";
const ITEM_ID = "f".repeat(64);

class InMemoryAdapter {
  readonly files = new Map<string, string>();
  private readonly directories = new Set<string>();

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
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
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
});

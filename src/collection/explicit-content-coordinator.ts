import type { Vault } from "obsidian";
import type { FullArticleFetchResult } from "../utils/fetch-helpers";
import { CollectionRepository } from "./collection-repository";
import { ContentRepository } from "./content-repository";

export interface ExplicitContentRequest {
  dataRoot: string;
  itemId: string;
  sourceUrl?: string;
  fetch: () => Promise<FullArticleFetchResult>;
}

const inFlightRequests = new WeakMap<object, Map<string, Promise<FullArticleFetchResult>>>();

/** Shared, explicit-only cache coordination for both inline and leaf readers. */
export class ExplicitContentCoordinator {
  constructor(private readonly vault: Vault) {}

  async readOrFetch(input: ExplicitContentRequest): Promise<FullArticleFetchResult> {
    const root = input.dataRoot.trim();
    const key = `${root}\0${input.itemId}`;
    const queue = inFlightRequests.get(this.vault) ?? new Map<string, Promise<FullArticleFetchResult>>();
    inFlightRequests.set(this.vault, queue);
    const active = queue.get(key);
    if (active) return await active;

    const operation = this.readOrFetchInternal({ ...input, dataRoot: root });
    queue.set(key, operation);
    try {
      return await operation;
    } finally {
      if (queue.get(key) === operation) queue.delete(key);
      if (queue.size === 0) inFlightRequests.delete(this.vault);
    }
  }

  private async readOrFetchInternal(
    input: ExplicitContentRequest,
  ): Promise<FullArticleFetchResult> {
    const contentRepository = new ContentRepository(
      this.vault,
      input.dataRoot,
      () => new Date(),
    );
    try {
      const cached = await contentRepository.read(input.itemId);
      // ContentRepository already validates that a cached artifact is non-empty
      // and belongs to this stable ID. Once durable, it is the cache truth even
      // when the publisher article itself is intentionally short.
      if (cached) {
        await this.syncMetadata(input, contentRepository.pathFor(input.itemId));
        return { content: cached.text, failureType: "none" };
      }
    } catch {
      // A cache read problem must not block a user-requested article open.
    }

    const fetched = await input.fetch();
    if (!hasMeaningfulFullText(fetched.content)) return fetched;

    try {
      const contentPath = await contentRepository.write({
        schemaVersion: 1,
        itemId: input.itemId,
        sourceUrl: input.sourceUrl,
        fetchedAt: new Date().toISOString(),
        contentBasis: "full-text",
        text: fetched.content,
      });
      await this.syncMetadata(input, contentPath);
    } catch {
      console.warn(
        "[RSS Dashboard] Content cache write failed; showing fetched article without caching.",
      );
    }
    return fetched;
  }

  private async syncMetadata(
    input: ExplicitContentRequest,
    contentPath: string,
  ): Promise<void> {
    try {
      await new CollectionRepository(this.vault, input.dataRoot, () => new Date())
        .updateContentMetadata(input.itemId, contentPath);
    } catch {
      console.warn(
        "[RSS Dashboard] Content metadata sync failed; cached content will be repaired on next access.",
      );
    }
  }
}

export function hasMeaningfulFullText(html: string): boolean {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().length > 200;
}

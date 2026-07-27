import {
  parseFeedPreviewFromText,
  type FeedPreviewData,
} from "../feed-parser/feed-preview.js";
import { normalizeRssWebsiteInput } from "./source-identifier.js";

const COMMON_FEED_PATHS = [
  "/feed",
  "/feed.xml",
  "/rss",
  "/rss.xml",
  "/atom.xml",
  "/index.xml",
] as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const SUPPORTED_ALTERNATE_TYPES = new Set([
  "application/rss+xml",
  "application/atom+xml",
  "application/feed+json",
]);

export type FeedCandidate = {
  url: string;
  title: string;
  format: "rss" | "atom" | "json";
};

export type RssWebsiteVerification = {
  inputUrl: string;
  siteUrl: string;
  candidates: FeedCandidate[];
  selected?: FeedCandidate;
  latestTitle?: string;
  latestPubDate?: string;
  hasEntries: boolean;
};

export type RssWebsiteRequest = (
  url: string,
) => Promise<{ url: string; text: string; contentType?: string }>;

export type RssWebsiteDiscoveryOptions = {
  request: RssWebsiteRequest;
  timeoutMs?: number;
};

export class RssWebsiteDiscoveryError extends Error {
  constructor(readonly code: "network-timeout" | "network-request-failed") {
    super(code);
    this.name = "RssWebsiteDiscoveryError";
  }
}

type ValidatedCandidate = FeedCandidate & { preview: FeedPreviewData };

export async function discoverRssWebsite(
  input: string,
  options: RssWebsiteDiscoveryOptions,
): Promise<RssWebsiteVerification> {
  const inputUrl = canonicalUrl(normalizeRssWebsiteInput(input));
  const initial = await requestWithTimeout(inputUrl, options);
  const siteUrl = canonicalUrl(normalizeRssWebsiteInput(initial.url));
  const directPreview = parseFeedPreviewFromText(initial.text, siteUrl);

  if (directPreview) {
    const candidate = toCandidate(siteUrl, directPreview);
    return withSelection(inputUrl, siteUrl, [{ ...candidate, preview: directPreview }]);
  }

  const declaredUrls = declaredFeedUrls(initial.text, siteUrl);
  if (declaredUrls.length > 0) {
    const candidates = await validateCandidates(declaredUrls, options);
    return withSelection(inputUrl, siteUrl, candidates);
  }

  for (const path of COMMON_FEED_PATHS) {
    const candidateUrl = canonicalUrl(new URL(path, siteUrl));
    const candidate = await validateCandidate(candidateUrl, "", options);
    if (candidate) {
      return withSelection(inputUrl, siteUrl, [candidate]);
    }
  }

  return {
    inputUrl,
    siteUrl,
    candidates: [],
    hasEntries: false,
  };
}

async function validateCandidates(
  urls: Array<{ url: string; title: string }>,
  options: RssWebsiteDiscoveryOptions,
): Promise<ValidatedCandidate[]> {
  const candidates: ValidatedCandidate[] = [];
  const seenFinalUrls = new Set<string>();
  for (const candidate of urls) {
    const validated = await validateCandidate(candidate.url, candidate.title, options);
    if (validated && !seenFinalUrls.has(validated.url)) {
      seenFinalUrls.add(validated.url);
      candidates.push(validated);
    }
  }
  return candidates;
}

async function validateCandidate(
  url: string,
  declaredTitle: string,
  options: RssWebsiteDiscoveryOptions,
): Promise<ValidatedCandidate | undefined> {
  try {
    const response = await requestWithTimeout(url, options);
    const candidateUrl = canonicalUrl(normalizeRssWebsiteInput(response.url));
    const preview = parseFeedPreviewFromText(response.text, candidateUrl);
    if (!preview) return undefined;
    return {
      ...toCandidate(candidateUrl, preview, declaredTitle),
      preview,
    };
  } catch (error) {
    if (error instanceof RssWebsiteDiscoveryError) throw error;
    return undefined;
  }
}

function declaredFeedUrls(
  html: string,
  siteUrl: string,
): Array<{ url: string; title: string }> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const seen = new Set<string>();
  const candidates: Array<{ url: string; title: string }> = [];

  for (const link of Array.from(doc.querySelectorAll("link[rel][type][href]"))) {
    const rel = (link.getAttribute("rel") || "").toLowerCase().split(/\s+/u);
    const type = (link.getAttribute("type") || "").toLowerCase().split(";", 1)[0].trim();
    if (!rel.includes("alternate") || !SUPPORTED_ALTERNATE_TYPES.has(type)) continue;

    const url = resolveSafeCandidateUrl(link.getAttribute("href") || "", siteUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    candidates.push({ url, title: link.getAttribute("title")?.trim() || "" });
  }

  return candidates;
}

function resolveSafeCandidateUrl(value: string, siteUrl: string): string | undefined {
  try {
    return canonicalUrl(normalizeRssWebsiteInput(new URL(value, siteUrl).href));
  } catch {
    return undefined;
  }
}

function canonicalUrl(url: URL): string {
  url.hash = "";
  return url.href;
}

function toCandidate(
  url: string,
  preview: FeedPreviewData,
  declaredTitle = "",
): FeedCandidate {
  return {
    url,
    title: declaredTitle || preview.title || url,
    format: preview.format,
  };
}

function withSelection(
  inputUrl: string,
  siteUrl: string,
  candidates: ValidatedCandidate[],
): RssWebsiteVerification {
  const selected = candidates.length === 1 ? candidates[0] : undefined;
  return {
    inputUrl,
    siteUrl,
    candidates: candidates.map(({ preview: _preview, ...candidate }) => candidate),
    selected: selected
      ? { url: selected.url, title: selected.title, format: selected.format }
      : undefined,
    latestTitle: selected?.preview.latestTitle || undefined,
    latestPubDate: selected?.preview.latestPubDate || undefined,
    hasEntries: selected?.preview.hasEntries || false,
  };
}

async function requestWithTimeout(
  url: string,
  options: RssWebsiteDiscoveryOptions,
): Promise<{ url: string; text: string; contentType?: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timeout: number | undefined;
  try {
    return await Promise.race([
      options.request(url),
      new Promise<never>((_resolve, reject) => {
        timeout = window.setTimeout(
          () => reject(new RssWebsiteDiscoveryError("network-timeout")),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof RssWebsiteDiscoveryError) throw error;
    throw new RssWebsiteDiscoveryError("network-request-failed");
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

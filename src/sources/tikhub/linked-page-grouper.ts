import { canonicalizeUrl } from "../../collection/item-identity";
import type { XPost } from "./x-post";

export interface LinkedPageGroup {
  url: string;
  postCount: number;
  authors: string[];
  postIds: string[];
}

interface MutableGroup {
  url: string;
  authors: Set<string>;
  postIds: Set<string>;
}

/** Groups only objectively shared external pages; it makes no quality judgment. */
export function groupLinkedPages(posts: readonly XPost[]): LinkedPageGroup[] {
  const grouped = new Map<string, MutableGroup>();
  for (const post of posts) {
    const perPostUrls = new Set<string>();
    for (const rawUrl of post.externalUrls) {
      const url = canonicalExternalPageUrl(rawUrl);
      if (url) perPostUrls.add(url);
    }
    for (const url of perPostUrls) {
      const group = grouped.get(url) ?? {
        url,
        authors: new Set<string>(),
        postIds: new Set<string>(),
      };
      group.authors.add(post.authorHandle.toLowerCase());
      group.postIds.add(post.id);
      grouped.set(url, group);
    }
  }

  return [...grouped.values()]
    .filter((group) => group.postIds.size > 1)
    .map((group) => ({
      url: group.url,
      postCount: group.postIds.size,
      authors: [...group.authors].sort(compareText),
      postIds: [...group.postIds].sort(compareText),
    }))
    .sort((left, right) => compareText(left.url, right.url));
}

export function canonicalExternalPageUrl(rawUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password
  ) {
    return undefined;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "t.co" ||
    hostname === "x.com" ||
    hostname.endsWith(".x.com") ||
    hostname === "twitter.com" ||
    hostname.endsWith(".twitter.com")
  ) {
    return undefined;
  }
  for (const name of [...parsed.searchParams.keys()]) {
    if (isTrackingParameter(name)) parsed.searchParams.delete(name);
  }
  const canonical = canonicalizeUrl(parsed.toString());
  return canonical || undefined;
}

const TRACKING_PARAMETERS = new Set([
  "dclid",
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "twclid",
]);

function isTrackingParameter(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.startsWith("utm_") || TRACKING_PARAMETERS.has(normalized);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

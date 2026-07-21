import type { CollectedItem } from "./collected-item";

export const DAILY_INDEX_START_MARKER = "<!-- RSS-DASHBOARD-CN:AUTO:START -->";
export const DAILY_INDEX_END_MARKER = "<!-- RSS-DASHBOARD-CN:AUTO:END -->";

export function renderDailyIndex(input: {
  localDate: string;
  items: CollectedItem[];
  existingMarkdown?: string;
}): string {
  const generatedBlock = renderGeneratedBlock(input.items);
  const existingMarkdown = input.existingMarkdown;

  if (existingMarkdown === undefined) {
    return [renderFrontmatter(input.localDate), generatedBlock, ""].join("\n");
  }

  const markers = findOwnedMarkerPair(existingMarkdown);
  if (markers) {
    return `${existingMarkdown.slice(0, markers.start)}${generatedBlock}${existingMarkdown.slice(markers.end)}`;
  }

  if (!existingMarkdown) {
    return `${generatedBlock}\n`;
  }
  return `${existingMarkdown}${existingMarkdown.endsWith("\n") ? "\n" : "\n\n"}${generatedBlock}\n`;
}

function renderFrontmatter(localDate: string): string {
  return [
    "---",
    `date: ${localDate}`,
    "type: rss-collection",
    "generatedBy: rss-dashboard-cn",
    "---",
  ].join("\n");
}

function renderGeneratedBlock(items: CollectedItem[]): string {
  const lines = [DAILY_INDEX_START_MARKER];
  const buckets = new Map<string, CollectedItem[]>();

  for (const item of items) {
    const bucketName = normalizeExternalText(item.sourceBucket);
    const bucket = buckets.get(bucketName) ?? [];
    bucket.push(item);
    buckets.set(bucketName, bucket);
  }

  for (const [bucket, bucketItems] of [...buckets.entries()].sort(
    ([left], [right]) => compareText(left, right),
  )) {
    lines.push(`## ${escapeMarkdownText(bucket)}`);
    for (const item of bucketItems.sort(compareItems)) {
      const time = escapeMarkdownText(item.publishedAt ?? item.fetchedAt);
      const title = escapeMarkdownText(item.title);
      const sourceName = escapeMarkdownText(item.sourceName);
      const observationType = escapeMarkdownText(item.observationType);
      const originalUrl = normalizeExternalText(item.url);
      const linkDestination = safeHttpLinkDestination(originalUrl);
      lines.push(`- 来源：${sourceName} ｜ 时间：${time} ｜ 类型：${observationType}`);
      lines.push(
        linkDestination ? `  - [${title}](<${linkDestination}>)` : `  - 标题：${title}`,
      );
      lines.push(`  - 原始链接：${escapeMarkdownText(originalUrl || "无")}`);
    }
  }

  lines.push(DAILY_INDEX_END_MARKER);
  return lines.join("\n");
}

function compareItems(left: CollectedItem, right: CollectedItem): number {
  const leftPublishedAt = normalizeExternalText(left.publishedAt);
  const rightPublishedAt = normalizeExternalText(right.publishedAt);
  const leftTimestamp = parseTimestamp(leftPublishedAt);
  const rightTimestamp = parseTimestamp(rightPublishedAt);

  if (leftTimestamp !== null && rightTimestamp !== null) {
    const timestampOrder = rightTimestamp - leftTimestamp;
    if (timestampOrder !== 0) return timestampOrder;
  } else if (leftTimestamp !== null) {
    return -1;
  } else if (rightTimestamp !== null) {
    return 1;
  } else {
    const invalidDateOrder = compareText(leftPublishedAt, rightPublishedAt);
    if (invalidDateOrder !== 0) return invalidDateOrder;
  }

  return (
    compareText(normalizeExternalText(left.title), normalizeExternalText(right.title)) ||
    compareText(left.id, right.id) ||
    compareText(normalizeExternalText(left.sourceName), normalizeExternalText(right.sourceName)) ||
    compareText(normalizeExternalText(left.url), normalizeExternalText(right.url)) ||
    compareText(normalizeExternalText(left.observationType), normalizeExternalText(right.observationType)) ||
    compareText(normalizeExternalText(left.fetchedAt), normalizeExternalText(right.fetchedAt))
  );
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "zh-Hans-CN");
}

function parseTimestamp(value: string): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function normalizeExternalText(value: string | undefined): string {
  return (value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeMarkdownText(value: string | undefined): string {
  return normalizeExternalText(value)
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/`/g, "\\`");
}

function safeHttpLinkDestination(url: string): string | null {
  if (!url || /\s/.test(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function findOwnedMarkerPair(existingMarkdown: string): {
  start: number;
  end: number;
} | null {
  const startMarkers = findWholeLineMarkers(existingMarkdown, DAILY_INDEX_START_MARKER);
  const endMarkers = findWholeLineMarkers(existingMarkdown, DAILY_INDEX_END_MARKER);
  const startTokens = countTokens(existingMarkdown, DAILY_INDEX_START_MARKER);
  const endTokens = countTokens(existingMarkdown, DAILY_INDEX_END_MARKER);
  const startMarker = startMarkers[0];
  const endMarker = endMarkers[0];

  if (startTokens === 0 && endTokens === 0) return null;

  if (
    startTokens !== 1 ||
    endTokens !== 1 ||
    !startMarker ||
    !endMarker ||
    startMarkers.length !== 1 ||
    endMarkers.length !== 1 ||
    startMarker.index === undefined ||
    endMarker.index === undefined ||
    startMarker.index >= endMarker.index
  ) {
    throw new Error(
      "Invalid daily index ownership markers; expected one complete standalone marker pair",
    );
  }

  return {
    start: startMarker.index,
    end: endMarker.index + endMarker[0].length,
  };
}

function findWholeLineMarkers(content: string, marker: string): RegExpMatchArray[] {
  const expression = new RegExp(`^${escapeRegularExpression(marker)}\\r?$`, "gm");
  return [...content.matchAll(expression)];
}

function countTokens(content: string, token: string): number {
  return content.split(token).length - 1;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

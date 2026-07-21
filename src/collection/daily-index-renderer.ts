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

  if (!existingMarkdown) {
    return [renderFrontmatter(input.localDate), generatedBlock, ""].join("\n");
  }

  const start = existingMarkdown.indexOf(DAILY_INDEX_START_MARKER);
  const end = existingMarkdown.indexOf(DAILY_INDEX_END_MARKER, start);
  if (start !== -1 && end !== -1) {
    const endOfMarker = end + DAILY_INDEX_END_MARKER.length;
    return `${existingMarkdown.slice(0, start)}${generatedBlock}${existingMarkdown.slice(endOfMarker)}`;
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
    const bucket = buckets.get(item.sourceBucket) ?? [];
    bucket.push(item);
    buckets.set(item.sourceBucket, bucket);
  }

  for (const [bucket, bucketItems] of [...buckets.entries()].sort(
    ([left], [right]) => compareText(left, right),
  )) {
    lines.push(`## ${bucket}`);
    for (const item of bucketItems.sort(compareItems)) {
      const time = item.publishedAt ?? item.fetchedAt;
      const title = escapeMarkdownLinkText(item.title);
      const url = item.url?.trim();
      lines.push(`- 来源：${item.sourceName} ｜ 时间：${time} ｜ 类型：${item.observationType}`);
      lines.push(
        url ? `  - [${title}](${url})` : `  - 标题：${title}`,
      );
      lines.push(`  - 原始链接：${url || "无"}`);
    }
  }

  lines.push(DAILY_INDEX_END_MARKER);
  return lines.join("\n");
}

function compareItems(left: CollectedItem, right: CollectedItem): number {
  const publishedAtOrder = (right.publishedAt ?? "").localeCompare(
    left.publishedAt ?? "",
  );
  return publishedAtOrder || compareText(left.title, right.title);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "zh-Hans-CN");
}

function escapeMarkdownLinkText(title: string): string {
  return title
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

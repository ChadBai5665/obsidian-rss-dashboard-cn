import { createTranslator, type Locale } from "../i18n";
import { normalizeXPostSourceMetadata } from "../collection/source-metadata";
import { canonicalExternalPageUrl } from "../sources/tikhub/linked-page-grouper";

type TopicSectionId = "latest" | "platform-top" | "priority-account";
type MetricName = "replies" | "reposts" | "likes" | "quotes" | "views";

export interface TopicDiscoveryItemModel {
  id: string;
  title: string;
  sourceName: string;
  fetchedAt: string;
  metrics: Record<MetricName, string>;
}

export interface TopicDiscoverySectionModel {
  id: TopicSectionId;
  label: string;
  items: TopicDiscoveryItemModel[];
}

export interface TopicLinkedPageModel {
  url: string;
  postCount: number;
  sources: string[];
}

export interface TopicDiscoveryModel {
  sections: TopicDiscoverySectionModel[];
  linkedPages: TopicLinkedPageModel[];
}

interface SafeTopicItem {
  id: string;
  title: string;
  sourceName: string;
  fetchedAt: string;
  observationTags: TopicSectionId[];
  externalUrls: string[];
  metrics: Partial<Record<MetricName, number>>;
}

const SECTION_IDS: TopicSectionId[] = [
  "latest",
  "platform-top",
  "priority-account",
];
const METRIC_NAMES: MetricName[] = [
  "replies",
  "reposts",
  "likes",
  "quotes",
  "views",
];

/** Builds a neutral display model from a defensive, getter-free snapshot. */
export function createTopicDiscoveryModel(
  value: unknown,
  locale: Locale,
): TopicDiscoveryModel {
  const t = createTranslator(locale);
  const items = snapshotDenseArray(value, snapshotTopicItem) ?? [];
  const unavailable = t("dashboard.metricUnavailable");
  const sections = SECTION_IDS.map((id) => ({
    id,
    label: sectionLabel(id, locale),
    items: items
      .filter((item) => item.observationTags.includes(id))
      .map((item) => ({
        id: item.id,
        title: item.title,
        sourceName: item.sourceName,
        fetchedAt: item.fetchedAt,
        metrics: Object.fromEntries(
          METRIC_NAMES.map((name) => [
            name,
            item.metrics[name] === undefined
              ? unavailable
              : String(item.metrics[name]),
          ]),
        ) as Record<MetricName, string>,
      })),
  }));

  return { sections, linkedPages: buildLinkedPages(items) };
}

export function renderTopicDiscoverySection(
  container: HTMLElement,
  items: unknown,
  locale: Locale,
): void {
  const t = createTranslator(locale);
  const model = createTopicDiscoveryModel(items, locale);
  container.empty();
  const root = container.createDiv({ cls: "rss-dashboard-topic-discovery" });
  for (const section of model.sections) {
    const sectionEl = root.createDiv({
      cls: "rss-dashboard-topic-discovery-group",
      attr: { "data-topic-observation": section.id },
    });
    sectionEl.createEl("h4", { text: section.label });
    for (const item of section.items) {
      const row = sectionEl.createDiv({
        cls: "rss-dashboard-topic-discovery-item",
      });
      row.createDiv({ text: item.title });
      row.createDiv({
        cls: "rss-dashboard-topic-discovery-fetched",
        text: t("dashboard.fetchedAt", {
          time: formatFetchedAt(item.fetchedAt, locale),
        }),
      });
      const metrics = row.createDiv({
        cls: "rss-dashboard-topic-discovery-metrics",
      });
      for (const name of METRIC_NAMES) {
        metrics.createSpan({
          text: `${metricLabel(name, locale)}: ${item.metrics[name]}`,
        });
      }
    }
  }

  if (model.linkedPages.length > 0) {
    const linked = root.createDiv({ cls: "rss-dashboard-topic-linked-pages" });
    linked.createEl("h4", { text: t("dashboard.linkedPages") });
    for (const group of model.linkedPages) {
      linked.createDiv({
        text: t("dashboard.linkedPageFacts", {
          count: group.postCount,
          sources: group.sources.join(", "),
        }),
        attr: { "data-linked-page-url": group.url },
      });
    }
  }
}

function snapshotTopicItem(value: unknown): SafeTopicItem | undefined {
  const record = plainRecord(value);
  if (!record) return undefined;
  const sourceType = ownData(record, "sourceType");
  const sourceBucket = ownString(record, "sourceBucket");
  const legacyObservationTag = sourceBucket === "topic-latest"
    ? "latest"
    : sourceBucket === "topic-top"
      ? "platform-top"
      : undefined;
  const id = ownString(record, "id");
  const title = ownString(record, "title");
  const sourceName = ownString(record, "sourceName");
  const fetchedAt = ownString(record, "fetchedAt");
  if (!id || title === undefined || sourceName === undefined || !fetchedAt) {
    return undefined;
  }
  const metadata = normalizeXPostSourceMetadata(
    ownData(record, "sourceMetadata"),
  );
  const observedByTopic = metadata?.observedSources?.some(
    (source) => source.type === "x-topic",
  ) ?? false;
  if (sourceType !== "x-topic" && !observedByTopic && !legacyObservationTag) {
    return undefined;
  }
  if (!metadata && !legacyObservationTag) return undefined;
  const observationTags = metadata?.observationTags ??
    (legacyObservationTag ? [legacyObservationTag] : []);
  const externalUrls = metadata?.externalUrls ?? [];
  return {
    id,
    title,
    sourceName,
    fetchedAt,
    observationTags: [...new Set(observationTags)],
    externalUrls,
    metrics: snapshotMetrics(ownData(record, "metrics")),
  };
}

function buildLinkedPages(items: SafeTopicItem[]): TopicLinkedPageModel[] {
  const groups = new Map<string, { postIds: Set<string>; sources: Set<string> }>();
  for (const item of items) {
    const perPost = new Set<string>();
    for (const rawUrl of item.externalUrls) {
      const url = canonicalExternalPageUrl(rawUrl);
      if (url) perPost.add(url);
    }
    for (const url of perPost) {
      const group = groups.get(url) ?? {
        postIds: new Set<string>(),
        sources: new Set<string>(),
      };
      group.postIds.add(item.id);
      group.sources.add(item.sourceName);
      groups.set(url, group);
    }
  }
  return [...groups.entries()]
    .filter(([, group]) => group.postIds.size > 1)
    .map(([url, group]) => ({
      url,
      postCount: group.postIds.size,
      sources: [...group.sources].sort(compareText),
    }))
    .sort((left, right) => compareText(left.url, right.url));
}

function snapshotMetrics(value: unknown): Partial<Record<MetricName, number>> {
  const record = plainRecord(value);
  if (!record) return {};
  const result: Partial<Record<MetricName, number>> = {};
  for (const name of METRIC_NAMES) {
    const metric = ownData(record, name);
    if (
      typeof metric === "number" &&
      Number.isSafeInteger(metric) &&
      metric >= 0
    ) {
      result[name] = metric;
    }
  }
  return result;
}

function snapshotDenseArray<T>(
  value: unknown,
  snapshotEntry: (entry: unknown) => T | undefined,
): T[] | undefined {
  try {
    if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) {
      return undefined;
    }
    const lengthValue: unknown = Object.getOwnPropertyDescriptor(
      value,
      "length",
    )?.value;
    if (
      typeof lengthValue !== "number" ||
      !Number.isSafeInteger(lengthValue) ||
      lengthValue < 0 ||
      lengthValue > 100_000
    ) {
      return undefined;
    }
    const length = lengthValue;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes("length")) return undefined;
    const result: T[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return undefined;
      const entry = snapshotEntry(descriptor.value);
      if (entry === undefined) return undefined;
      result.push(entry);
    }
    return result;
  } catch {
    return undefined;
  }
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const prototype = Reflect.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function ownData(record: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function ownString(record: Record<string, unknown>, key: string): string | undefined {
  const value = ownData(record, key);
  return typeof value === "string" ? value : undefined;
}

function sectionLabel(id: TopicSectionId, locale: Locale): string {
  const t = createTranslator(locale);
  return t(
    id === "latest"
      ? "dashboard.topicLatest"
      : id === "platform-top"
        ? "dashboard.topicPlatformTop"
        : "dashboard.topicPriorityAccount",
  );
}

function metricLabel(name: MetricName, locale: Locale): string {
  const t = createTranslator(locale);
  const keys = {
    replies: "dashboard.metricReplies",
    reposts: "dashboard.metricReposts",
    likes: "dashboard.metricLikes",
    quotes: "dashboard.metricQuotes",
    views: "dashboard.metricViews",
  } as const;
  return t(keys[name]);
}

function formatFetchedAt(value: string, locale: Locale): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date(timestamp));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

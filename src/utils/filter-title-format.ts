import { createTranslator, type Locale, type Translator } from "../i18n";

export type DashboardFilterLogic = "AND" | "OR";

const STATUS_ORDER: string[] = [
  "unread",
  "read",
  "saved",
  "starred",
  "podcasts",
  "videos",
  "tagged",
  "untagged",
];

const STATUS_LABEL_KEYS = {
  unread: "filter.unread",
  read: "filter.read",
  saved: "filter.saved",
  starred: "filter.starred",
  podcasts: "filter.podcasts",
  videos: "filter.videos",
  tagged: "filter.tagged",
  untagged: "filter.untagged",
} as const;

function translatorFor(options: { t?: Translator; locale?: Locale }): Translator {
  return options.t ?? createTranslator(options.locale ?? "en");
}

function getLogicWord(logic: DashboardFilterLogic, t: Translator): string {
  return t(logic === "AND" ? "filter.and" : "filter.or");
}

function normalizeStringSet(values: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    if (typeof v === "string") out.add(v);
  }
  return out;
}

function getSortedTagNames(tagFilters: Iterable<string>): string[] {
  return Array.from(tagFilters).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

function hasMediaTypeStatuses(statusFilters: Set<string>): boolean {
  return statusFilters.has("podcasts") || statusFilters.has("videos");
}

export function formatDashboardMultiFiltersTitle(options: {
  baseTitle: string;
  statusFilters: Iterable<string>;
  tagFilters: Iterable<string>;
  logic: DashboardFilterLogic;
  t?: Translator;
  locale?: Locale;
}): { title: string; tooltip: string | null } {
  const t = translatorFor(options);
  const status = normalizeStringSet(options.statusFilters);
  const tags = normalizeStringSet(options.tagFilters);
  const logicWord = getLogicWord(options.logic, t);

  const hasTagNames = tags.size > 0;
  if (hasTagNames) {
    // Avoid redundant/confusing combinations in the title when explicit tag names
    // are present.
    status.delete("tagged");
    status.delete("untagged");
  }

  const parts: string[] = [];
  for (const id of STATUS_ORDER) {
    if (!status.has(id)) continue;
    const key = STATUS_LABEL_KEYS[id as keyof typeof STATUS_LABEL_KEYS];
    if (key) parts.push(t(key));
  }

  if (hasTagNames) {
    const tagNames = getSortedTagNames(tags);
    parts.push(t("filter.tagsNamed", { tags: tagNames.join(", ") }));
  }

  if (parts.length === 0) {
    return { title: options.baseTitle, tooltip: null };
  }

  const phrase = parts.join(` ${logicWord} `);
  const noun = hasMediaTypeStatuses(status) ? t("filter.items") : t("filter.articles");

  const base = options.baseTitle.trim();
  const lowerBase = base.toLowerCase();
  const title =
    lowerBase === "all articles" || lowerBase === "all items" || base === t("filter.all")
      ? t("filter.allWithPhrase", { phrase, noun })
      : `${base} — ${phrase}`;

  const tooltip = t("filter.activeFilters", { logic: options.logic, filters: parts.join(", ") });
  return { title, tooltip };
}

export function formatDashboardMultiFiltersSummary(options: {
  statusFilters: Iterable<string>;
  tagFilters: Iterable<string>;
  logic: DashboardFilterLogic;
  t?: Translator;
  locale?: Locale;
}): { text: string; tooltip: string | null } {
  const t = translatorFor(options);
  const status = normalizeStringSet(options.statusFilters);
  const tags = normalizeStringSet(options.tagFilters);
  const { tooltip } = formatDashboardMultiFiltersTitle({
    baseTitle: t("filter.all"),
    statusFilters: status,
    tagFilters: tags,
    logic: options.logic,
    t,
  });

  // For settings buttons, avoid repeating the "All ..." prefix.
  if (tooltip === null) {
    return { text: t("filter.all"), tooltip: null };
  }

  if (tags.size > 0) {
    status.delete("tagged");
    status.delete("untagged");
  }
  const parts: string[] = [];
  for (const id of STATUS_ORDER) {
    if (!status.has(id)) continue;
    const key = STATUS_LABEL_KEYS[id as keyof typeof STATUS_LABEL_KEYS];
    if (key) parts.push(t(key));
  }
  if (tags.size > 0) {
    parts.push(t("filter.tagsNamed", { tags: getSortedTagNames(tags).join(", ") }));
  }

  return { text: parts.join(` ${getLogicWord(options.logic, t)} `), tooltip };
}

export function formatDashboardMultiFiltersSummaryCompact(options: {
  statusFilters: Iterable<string>;
  tagFilters: Iterable<string>;
  logic: DashboardFilterLogic;
  maxItems?: number;
  t?: Translator;
  locale?: Locale;
}): { text: string; tooltip: string | null } {
  const t = translatorFor(options);
  const status = normalizeStringSet(options.statusFilters);
  const tags = normalizeStringSet(options.tagFilters);
  const logicWord = getLogicWord(options.logic, t);
  const maxItems = Math.max(1, options.maxItems ?? 2);

  const { tooltip } = formatDashboardMultiFiltersTitle({
    baseTitle: t("filter.all"),
    statusFilters: status,
    tagFilters: tags,
    logic: options.logic,
    t,
  });

  if (tooltip === null) {
    return { text: t("filter.all"), tooltip: null };
  }

  const hasTagNames = tags.size > 0;
  if (hasTagNames) {
    // Keep compact summaries readable by collapsing tag names into a single
    // short token, and avoid redundant tagged/untagged statuses.
    status.delete("tagged");
    status.delete("untagged");
  }

  const parts: Array<{ label: string; isTags: boolean }> = [];
  for (const id of STATUS_ORDER) {
    if (!status.has(id)) continue;
    const key = STATUS_LABEL_KEYS[id as keyof typeof STATUS_LABEL_KEYS];
    if (key) parts.push({ label: t(key), isTags: false });
  }

  if (hasTagNames) {
    const tagCount = tags.size;
    parts.push({ label: t("filter.tagsCount", { count: tagCount }), isTags: true });
  }

  if (parts.length === 0) {
    return { text: t("filter.all"), tooltip };
  }

  let displayed: Array<{ label: string; isTags: boolean }> = [];
  if (parts.length <= maxItems) {
    displayed = parts;
  } else {
    const tagPart = parts.find((p) => p.isTags);
    if (tagPart && maxItems >= 2) {
      const firstNonTag = parts.find((p) => !p.isTags);
      displayed = firstNonTag ? [firstNonTag, tagPart] : [tagPart];
    } else {
      displayed = parts.slice(0, maxItems);
    }
  }

  const remaining = Math.max(0, parts.length - displayed.length);
  const baseText = displayed.map((p) => p.label).join(` ${logicWord} `);
  const text = remaining > 0 ? `${baseText} +${remaining}` : baseText;

  return { text: text.trim(), tooltip };
}

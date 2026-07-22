import { normalizePath, TFile, type DataAdapter, type Vault } from "obsidian";
import {
  snapshotAiAnalysisResult,
  type AiAnalysisResult,
} from "./analysis-result";

const MARKER_NAMESPACE = "RSS-DASHBOARD-CN:AI:";
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MARKER_PATTERN =
  /<!-- RSS-DASHBOARD-CN:AI:([^:\s>]+):(START|END) -->/gu;
const MAX_NOTE_PATH_CHARACTERS = 4_096;
const MAX_LABEL_CHARACTERS = 500;

type BoundNoteAdapter = Required<Pick<DataAdapter, "read" | "process">> & {
  identity: object;
};

const noteQueues = new WeakMap<object, Map<string, Promise<void>>>();

export interface AnalysisNoteInsertInput {
  notePath: string;
  result: AiAnalysisResult;
  operationLabel: string;
  contentBasisLabel: string;
}

export interface AnalysisNoteInsertResult {
  status: "inserted" | "existing";
  notePath: string;
  marker: string;
}

/** Appends one validated AI result block to an already-existing Markdown note. */
export class AnalysisNoteInserter {
  constructor(private readonly vault: Vault) {}

  async insert(input: AnalysisNoteInsertInput): Promise<AnalysisNoteInsertResult> {
    // Snapshot every externally supplied value before touching the vault.
    const result = snapshotAiAnalysisResult(input.result);
    const notePath = safeNotePath(input.notePath);
    const operationLabel = safeLabel(input.operationLabel, "operation label");
    const contentBasisLabel = safeLabel(
      input.contentBasisLabel,
      "content basis label",
    );
    if (
      result.text.includes(MARKER_NAMESPACE) ||
      result.model.includes(MARKER_NAMESPACE) ||
      operationLabel.includes(MARKER_NAMESPACE) ||
      contentBasisLabel.includes(MARKER_NAMESPACE)
    ) {
      throw new Error("AI analysis marker namespace is reserved");
    }

    const file = this.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile) || file.path !== notePath) {
      throw new Error("The saved source note does not exist");
    }
    const adapter = this.atomicAdapter();
    const marker = `${MARKER_NAMESPACE}${result.id}`;

    return await this.withNoteLock(adapter.identity, notePath, async () => {
      const before = await adapter.read(notePath);
      const beforeMarkers = inspectMarkers(before);
      if (beforeMarkers.has(result.id)) {
        return { status: "existing", notePath, marker };
      }

      let status: AnalysisNoteInsertResult["status"] = "inserted";
      let exactInsertedBlock: string | undefined;
      let committed: string;
      try {
        committed = await adapter.process(notePath, (current) => {
          const currentMarkers = inspectMarkers(current);
          if (currentMarkers.has(result.id)) {
            status = "existing";
            return current;
          }
          const currentNewline = detectNewline(current);
          exactInsertedBlock = renderResultBlock(
            result,
            operationLabel,
            contentBasisLabel,
            currentNewline,
          );
          return appendBlock(current, exactInsertedBlock, currentNewline);
        });
      } catch (error) {
        // Some adapters can commit process() bytes and then reject. Verify the
        // exact block before deciding whether the durable insertion failed.
        const afterError = await adapter.read(notePath);
        const afterErrorMarkers = inspectMarkers(afterError);
        if (
          exactInsertedBlock &&
          afterErrorMarkers.has(result.id) &&
          afterError.includes(exactInsertedBlock)
        ) {
          return { status: "inserted", notePath, marker };
        }
        if (!exactInsertedBlock && afterErrorMarkers.has(result.id)) {
          return { status: "existing", notePath, marker };
        }
        throw error;
      }
      const verified = await adapter.read(notePath);
      const verifiedMarkers = inspectMarkers(verified);
      if (!verifiedMarkers.has(result.id)) {
        throw new Error("AI analysis note insertion was not durably verified");
      }
      if (
        status === "inserted" &&
        (!exactInsertedBlock || !verified.includes(exactInsertedBlock))
      ) {
        throw new Error("AI analysis note insertion could not be verified");
      }
      if (!inspectMarkers(committed).has(result.id)) {
        throw new Error("AI analysis note process result could not be verified");
      }
      return { status, notePath, marker };
    });
  }

  private atomicAdapter(): BoundNoteAdapter {
    const identity = this.vault.adapter as object;
    const adapter = identity as Partial<DataAdapter>;
    const read = adapter.read;
    const process = adapter.process;
    if (typeof read !== "function" || typeof process !== "function") {
      throw new Error("AI note insertion requires atomic process support");
    }
    return {
      identity,
      read: read.bind(identity),
      process: process.bind(identity),
    };
  }

  private async withNoteLock<T>(
    adapterIdentity: object,
    notePath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const queues = noteQueues.get(adapterIdentity) ?? new Map<string, Promise<void>>();
    noteQueues.set(adapterIdentity, queues);
    const previous = queues.get(notePath) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(operation);
    const settled = running.then(() => undefined, () => undefined);
    queues.set(notePath, settled);
    try {
      return await running;
    } finally {
      if (queues.get(notePath) === settled) queues.delete(notePath);
      if (queues.size === 0) noteQueues.delete(adapterIdentity);
    }
  }
}

function safeNotePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_NOTE_PATH_CHARACTERS ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/u.test(value) ||
    !value.toLowerCase().endsWith(".md")
  ) {
    throw new Error("Invalid saved note path");
  }
  const segments = value.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    segments.some((segment) => segment.toLowerCase() === ".rss-dashboard-data")
  ) {
    throw new Error("Invalid saved note path");
  }
  const normalized = normalizePath(value);
  if (normalized !== value) throw new Error("Invalid saved note path");
  return normalized;
}

function safeLabel(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_LABEL_CHARACTERS ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined &&
        (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
    })
  ) {
    throw new Error(`Invalid ${name}`);
  }
  return value.trim();
}

function inspectMarkers(markdown: string): Set<string> {
  const completed = new Set<string>();
  let activeId: string | undefined;
  let markerCount = 0;
  MARKER_PATTERN.lastIndex = 0;
  for (const match of markdown.matchAll(MARKER_PATTERN)) {
    markerCount += 1;
    const id = match[1];
    const edge = match[2];
    if (!CANONICAL_UUID.test(id)) {
      throw new Error("Invalid AI analysis marker ID");
    }
    if (edge === "START") {
      if (activeId || completed.has(id)) {
        throw new Error("Ambiguous AI analysis marker structure");
      }
      activeId = id;
    } else {
      if (!activeId || activeId !== id) {
        throw new Error("Crossed or partial AI analysis marker structure");
      }
      completed.add(id);
      activeId = undefined;
    }
  }
  if (activeId) throw new Error("Partial AI analysis marker structure");
  if (countOccurrences(markdown, MARKER_NAMESPACE) !== markerCount) {
    throw new Error("Malformed AI analysis marker structure");
  }
  return completed;
}

function countOccurrences(value: string, token: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(token, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + token.length;
  }
}

function detectNewline(markdown: string): "\r\n" | "\n" {
  return markdown.includes("\r\n") ? "\r\n" : "\n";
}

function renderResultBlock(
  result: AiAnalysisResult,
  operationLabel: string,
  contentBasisLabel: string,
  newline: "\r\n" | "\n",
): string {
  return [
    `<!-- ${MARKER_NAMESPACE}${result.id}:START -->`,
    `## AI 分析：${operationLabel}`,
    "",
    `> 生成时间：${result.createdAt} · 模型：${result.model} · 内容依据：${contentBasisLabel}`,
    "",
    result.text.replace(/\r?\n/gu, newline),
    `<!-- ${MARKER_NAMESPACE}${result.id}:END -->`,
  ].join(newline);
}

function appendBlock(
  current: string,
  block: string,
  newline: "\r\n" | "\n",
): string {
  if (!current) return block;
  if (current.endsWith(`${newline}${newline}`)) return `${current}${block}`;
  if (current.endsWith(newline)) return `${current}${newline}${block}`;
  return `${current}${newline}${newline}${block}`;
}

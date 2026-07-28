import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AiOperationTaskCoordinator,
  AiTaskSnapshot,
  StartAiTaskInput,
} from "../../../src/ai/ai-operation-task-coordinator";
import type { AiAnalysisArtifact } from "../../../src/ai/analysis-markdown-parser";
import type { AiConnection } from "../../../src/ai/ai-types";
import type { AiOperation } from "../../../src/ai/prompts/prompt-types";
import type { CollectedItem } from "../../../src/collection/collected-item";
import {
  createInlineAiPanel,
  type InlineAiPanelOptions,
} from "../../../src/components/inline-ai-panel";

const ITEM_ID = "a".repeat(64);
const OTHER_ITEM_ID = "b".repeat(64);
const CONNECTION_ID = "2dfccb63-2250-4a52-b18c-9c9fb06293a9";
const OTHER_CONNECTION_ID = "e161b524-b52c-4ce9-bbb9-8886e2319aa9";
const CURRENT_PATH =
  `.rss-dashboard-data/analysis/${ITEM_ID}/20260721T123456789-summary.md`;
const HISTORY_PATH =
  `.rss-dashboard-data/analysis/${ITEM_ID}/20260720T123456789-summary.md`;

type Coordinator = Pick<
  AiOperationTaskCoordinator,
  "loadLatest" | "start" | "regenerate" | "subscribe" | "abort"
>;

function connection(overrides: Partial<AiConnection> = {}): AiConnection {
  return {
    id: CONNECTION_ID,
    name: "Quiet Research",
    providerKind: "openai",
    protocol: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6",
    timeoutMs: 60_000,
    maxInputCharacters: 100_000,
    enabled: true,
    ...overrides,
  };
}

function item(): CollectedItem {
  return {
    schemaVersion: 1,
    id: ITEM_ID,
    sourceType: "rss",
    sourceId: "source-1",
    sourceName: "Example source",
    sourceBucket: "default",
    title: "A source item",
    fetchedAt: "2026-07-21T12:00:00.000Z",
    firstSeenAt: "2026-07-21T12:00:00.000Z",
    lastSeenAt: "2026-07-21T12:00:00.000Z",
    observationType: "new",
    topics: [],
    contentBasis: "feed",
    read: false,
    starred: false,
    saved: false,
    collectionStatus: "collected",
  };
}

function state(
  status: AiTaskSnapshot["status"],
  overrides: Partial<AiTaskSnapshot> = {},
): AiTaskSnapshot {
  const operation = overrides.operation ?? "summary";
  const itemId = overrides.itemId ?? ITEM_ID;
  return Object.freeze({
    key: `${itemId}\0${operation}`,
    itemId,
    operation,
    status,
    text: "",
    ...overrides,
  });
}

function artifact(
  path = HISTORY_PATH,
  createdAt = "2026-07-20T12:34:56.789Z",
): AiAnalysisArtifact {
  return Object.freeze({
    path,
    record: Object.freeze({
      schemaVersion: 1 as const,
      id: "4d0bfd9a-a9d4-41c2-9130-625636d4dc5a",
      itemId: ITEM_ID,
      operation: "summary" as const,
      createdAt,
      connectionId: CONNECTION_ID,
      connectionName: "Quiet Research",
      providerKind: "openai" as const,
      model: "gpt-5.6",
      contentBasis: "feed" as const,
      inputCharacterCount: 42,
      inputTruncated: false,
      text: "Historical result",
    }),
  });
}

class FakeCoordinator implements Coordinator {
  snapshot: AiTaskSnapshot;
  readonly listeners = new Set<(value: AiTaskSnapshot) => void>();
  readonly calls = {
    subscribe: [] as Array<[string, AiOperation]>,
    loadLatest: [] as Array<[string, AiOperation]>,
    start: [] as StartAiTaskInput[],
    regenerate: [] as StartAiTaskInput[],
    abort: [] as Array<[string, AiOperation]>,
    unsubscribe: 0,
  };
  loadLatestImpl?: (
    itemId: string,
    operation: AiOperation,
  ) => Promise<AiTaskSnapshot>;
  startImpl?: (input: StartAiTaskInput) => Promise<AiTaskSnapshot>;
  regenerateImpl?: (input: StartAiTaskInput) => Promise<AiTaskSnapshot>;

  constructor(initial = state("idle")) {
    this.snapshot = initial;
  }

  subscribe(
    itemId: string,
    operation: AiOperation,
    listener: (value: AiTaskSnapshot) => void,
  ): () => void {
    this.calls.subscribe.push([itemId, operation]);
    this.listeners.add(listener);
    listener(this.snapshot);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.calls.unsubscribe += 1;
      this.listeners.delete(listener);
    };
  }

  loadLatest(itemId: string, operation: AiOperation): Promise<AiTaskSnapshot> {
    this.calls.loadLatest.push([itemId, operation]);
    return this.loadLatestImpl?.(itemId, operation) ??
      Promise.resolve(this.snapshot);
  }

  start(input: StartAiTaskInput): Promise<AiTaskSnapshot> {
    this.calls.start.push(input);
    this.emit(state("preparing", {
      operation: input.operation,
      connectionId: input.connectionId,
    }));
    return this.startImpl?.(input) ?? new Promise(() => undefined);
  }

  regenerate(input: StartAiTaskInput): Promise<AiTaskSnapshot> {
    this.calls.regenerate.push(input);
    this.emit(state("preparing", {
      operation: input.operation,
      connectionId: input.connectionId,
    }));
    return this.regenerateImpl?.(input) ?? new Promise(() => undefined);
  }

  abort(itemId: string, operation: AiOperation): void {
    this.calls.abort.push([itemId, operation]);
  }

  emit(next: AiTaskSnapshot): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener(next);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function button(container: HTMLElement, action: string): HTMLButtonElement {
  const result = container.querySelector<HTMLButtonElement>(
    `button[data-action="${action}"]`,
  );
  if (!result) throw new Error(`Missing action button: ${action}`);
  return result;
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createPanel(
  coordinator: FakeCoordinator,
  overrides: Partial<InlineAiPanelOptions> = {},
) {
  const container = document.body.appendChild(document.createElement("div"));
  const options: InlineAiPanelOptions = {
    container,
    locale: "en",
    itemId: ITEM_ID,
    connections: [connection()],
    defaultConnectionId: CONNECTION_ID,
    coordinator,
    createStartInput: (operation, connectionId) => ({
      operation,
      item: item(),
      connectionId,
      fetchFullText: false,
    }),
    listHistory: async () => [],
    openArtifact: () => undefined,
    openSettings: () => undefined,
    canInsertArtifact: () => false,
    insertArtifact: () => undefined,
    ...overrides,
  };
  return { container, controller: createInlineAiPanel(options), options };
}

afterEach(() => {
  document.body.textContent = "";
  vi.restoreAllMocks();
});

describe("createInlineAiPanel", () => {
  it("shows configure guidance without touching the coordinator when no enabled connection exists", async () => {
    const coordinator = new FakeCoordinator();
    const openSettings = vi.fn();
    const { container, controller } = createPanel(coordinator, {
      connections: [connection({ enabled: false })],
      openSettings,
    });

    await controller.show("summary");

    expect(container.textContent).toContain(
      "Enable an AI connection in Settings before using this action.",
    );
    expect(coordinator.calls.subscribe).toEqual([]);
    expect(coordinator.calls.loadLatest).toEqual([]);
    expect(coordinator.calls.start).toEqual([]);
    click(button(container, "settings"));
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it("subscribes before history, then starts exactly once with the default connection", async () => {
    const coordinator = new FakeCoordinator();
    const order: string[] = [];
    const originalSubscribe = coordinator.subscribe.bind(coordinator);
    coordinator.subscribe = (itemId, operation, listener) => {
      order.push("subscribe");
      return originalSubscribe(itemId, operation, listener);
    };
    coordinator.loadLatestImpl = async () => {
      order.push("history");
      return state("idle");
    };
    coordinator.startImpl = async () => {
      order.push("start");
      return state("aborted", { errorCode: "aborted" });
    };
    const { controller } = createPanel(coordinator);

    await Promise.all([controller.show("summary"), controller.show("summary")]);

    expect(order[0]).toBe("subscribe");
    expect(order.filter((entry) => entry === "start")).toHaveLength(1);
    expect(coordinator.calls.start).toHaveLength(1);
    expect(coordinator.calls.start[0]).toMatchObject({
      operation: "summary",
      connectionId: CONNECTION_ID,
    });
  });

  it("reattaches active streaming text without loading history or stealing focus", async () => {
    const coordinator = new FakeCoordinator(state("generating", {
      text: "Live <img src=x onerror=alert(1)>",
      connectionId: CONNECTION_ID,
      connectionName: "Quiet Research",
      model: "gpt-5.6",
      contentBasis: "feed",
    }));
    const focusTarget = document.body.appendChild(document.createElement("button"));
    focusTarget.focus();
    const { container, controller } = createPanel(coordinator);

    await controller.show("summary");

    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(container.querySelector(".rss-dashboard-inline-ai-body")?.textContent)
      .toBe("Live <img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
    expect(document.activeElement).toBe(focusTarget);
    expect(coordinator.calls.loadLatest).toEqual([]);
    expect(coordinator.calls.start).toEqual([]);
    expect(button(container, "stop").textContent).toBe("Stop generating");
  });

  it("renders current completion actions and guards insertion by the exact verified path", async () => {
    const coordinator = new FakeCoordinator(state("complete", {
      text: "Current answer",
      artifactPath: CURRENT_PATH,
      createdAt: "2026-07-21T12:34:56.789Z",
      connectionId: CONNECTION_ID,
      connectionName: "Quiet Research",
      model: "gpt-5.6",
      contentBasis: "feed",
    }));
    const opened: string[] = [];
    const inserted: string[] = [];
    const checked: string[] = [];
    const { container, controller } = createPanel(coordinator, {
      openArtifact: (path) => { opened.push(path); },
      canInsertArtifact: (path) => {
        checked.push(path);
        return path === CURRENT_PATH;
      },
      insertArtifact: (path) => { inserted.push(path); },
    });

    await controller.show("summary");
    click(button(container, "open"));
    click(button(container, "insert"));

    expect(opened).toEqual([CURRENT_PATH]);
    expect(checked).toContain(CURRENT_PATH);
    expect(inserted).toEqual([CURRENT_PATH]);
    expect(container.textContent).toContain("Current result");
  });

  it("treats an unverified replayed completion as history on a fresh mount", async () => {
    const coordinator = new FakeCoordinator(state("complete", {
      text: "Previously loaded result",
      artifactPath: HISTORY_PATH,
      createdAt: "2026-07-20T12:34:56.789Z",
    }));
    const canInsertArtifact = vi.fn(() => {
      throw new Error("verification unavailable");
    });
    const { container, controller } = createPanel(coordinator, {
      canInsertArtifact,
    });

    await controller.show("summary");

    expect(canInsertArtifact).toHaveBeenCalledWith(HISTORY_PATH);
    expect(container.textContent).toContain("Saved history");
    expect(container.querySelector('[data-action="insert"]')).toBeNull();
    expect(coordinator.calls.loadLatest).toEqual([]);
    expect(coordinator.calls.start).toEqual([]);
  });

  it("reopens history without starting and never enables history insertion", async () => {
    const coordinator = new FakeCoordinator();
    coordinator.loadLatestImpl = async () => {
      const historical = state("complete", {
        text: "Cached answer",
        artifactPath: HISTORY_PATH,
        createdAt: "2026-07-20T12:34:56.789Z",
        connectionName: "Quiet Research",
        model: "gpt-5.6",
        contentBasis: "feed",
      });
      coordinator.emit(historical);
      return historical;
    };
    const canInsertArtifact = vi.fn(() => true);
    const { container, controller } = createPanel(coordinator, {
      canInsertArtifact,
    });

    await controller.show("summary");

    expect(container.textContent).toContain("Saved history");
    expect(container.textContent).toContain("Cached answer");
    expect(container.querySelector('[data-action="insert"]')).toBeNull();
    expect(canInsertArtifact).not.toHaveBeenCalled();
    expect(coordinator.calls.start).toEqual([]);
  });

  it("preserves the history origin across repeated show calls", async () => {
    const coordinator = new FakeCoordinator();
    coordinator.loadLatestImpl = async () => {
      const historical = state("complete", {
        text: "Cached answer",
        artifactPath: HISTORY_PATH,
        createdAt: "2026-07-20T12:34:56.789Z",
      });
      coordinator.emit(historical);
      return historical;
    };
    const { container, controller } = createPanel(coordinator, {
      canInsertArtifact: () => true,
    });

    await controller.show("summary");
    await controller.show("summary");

    expect(container.textContent).toContain("Saved history");
    expect(container.querySelector('[data-action="insert"]')).toBeNull();
    expect(coordinator.calls.start).toEqual([]);
  });

  it("changes the compact selector without starting and uses it only for explicit regeneration", async () => {
    const coordinator = new FakeCoordinator(state("complete", {
      text: "Done",
      artifactPath: CURRENT_PATH,
    }));
    const { container, controller } = createPanel(coordinator, {
      connections: [
        connection(),
        connection({
          id: OTHER_CONNECTION_ID,
          name: "Second connection",
          providerKind: "deepseek",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-pro",
        }),
      ],
    });

    await controller.show("summary");
    const select = container.querySelector<HTMLSelectElement>("select");
    expect(select?.value).toBe(CONNECTION_ID);
    if (!select) throw new Error("Missing connection selector");
    select.value = OTHER_CONNECTION_ID;
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(coordinator.calls.start).toEqual([]);
    expect(coordinator.calls.regenerate).toEqual([]);
    click(button(container, "regenerate"));
    expect(coordinator.calls.regenerate[0]?.connectionId)
      .toBe(OTHER_CONNECTION_ID);
  });

  it("maps failed states to localized safe copy and offers retry or settings without raw errors", async () => {
    const coordinator = new FakeCoordinator(state("failed", {
      errorCode: "missing-key",
      text: "",
    }));
    const openSettings = vi.fn();
    const { container, controller } = createPanel(coordinator, { openSettings });

    await controller.show("summary");

    expect(container.textContent).toContain(
      "No API key is configured for this connection.",
    );
    expect(container.textContent).not.toContain("stack");
    click(button(container, "settings"));
    expect(openSettings).toHaveBeenCalledOnce();

    coordinator.emit(state("failed", {
      errorCode: "network-failure",
      text: "secret raw provider error",
    }));
    expect(container.textContent).toContain("The AI network request failed.");
    expect(container.textContent).not.toContain("secret raw provider error");
    click(button(container, "retry"));
    expect(coordinator.calls.regenerate).toHaveLength(1);
  });

  it("stops only on explicit action and treats aborted work as retryable", async () => {
    const coordinator = new FakeCoordinator(state("saving", {
      text: "Finished text awaiting storage",
    }));
    const { container, controller } = createPanel(coordinator);

    await controller.show("summary");
    expect(coordinator.calls.abort).toEqual([]);
    click(button(container, "stop"));
    expect(coordinator.calls.abort).toEqual([[ITEM_ID, "summary"]]);

    coordinator.emit(state("aborted", { errorCode: "aborted" }));
    expect(container.textContent).toContain("Generation stopped");
    click(button(container, "retry"));
    expect(coordinator.calls.regenerate).toHaveLength(1);
  });

  it("collapses by unsubscribing and expands into the replayed state without aborting or restarting", async () => {
    const coordinator = new FakeCoordinator(state("generating", { text: "one" }));
    const { container, controller } = createPanel(coordinator);
    await controller.show("summary");

    controller.collapse();
    coordinator.snapshot = state("generating", { text: "one two" });

    expect(coordinator.calls.unsubscribe).toBe(1);
    expect(coordinator.calls.abort).toEqual([]);
    expect(container.querySelector<HTMLElement>(".rss-dashboard-inline-ai-content")?.hidden)
      .toBe(true);

    controller.expand();

    expect(container.querySelector(".rss-dashboard-inline-ai-body")?.textContent)
      .toBe("one two");
    expect(coordinator.calls.start).toEqual([]);
    expect(coordinator.calls.loadLatest).toEqual([]);
  });

  it("destroys only owned DOM, never aborts, and invalidates pending work and old actions", async () => {
    const coordinator = new FakeCoordinator(state("complete", {
      text: "Done",
      artifactPath: CURRENT_PATH,
    }));
    const history = deferred<readonly AiAnalysisArtifact[]>();
    const openArtifact = vi.fn();
    const { container, controller } = createPanel(coordinator, {
      listHistory: () => history.promise,
      openArtifact,
    });
    await controller.show("summary");
    const oldOpen = button(container, "open");
    click(button(container, "history"));

    controller.destroy();
    history.reject(new Error("late history failure"));
    click(oldOpen);
    await flush();

    expect(container.childElementCount).toBe(0);
    expect(openArtifact).not.toHaveBeenCalled();
    expect(coordinator.calls.abort).toEqual([]);
    expect(coordinator.calls.unsubscribe).toBe(1);
  });

  it("lists immutable history newest first and opens exact rows without replacing current work", async () => {
    const coordinator = new FakeCoordinator(state("complete", {
      text: "Current answer",
      artifactPath: CURRENT_PATH,
    }));
    const older = artifact(HISTORY_PATH, "2026-07-20T12:34:56.789Z");
    const newerPath =
      `.rss-dashboard-data/analysis/${ITEM_ID}/20260721T113456789-summary-2.md`;
    const newer = artifact(newerPath, "2026-07-21T11:34:56.789Z");
    const source = [older, newer];
    const opened: string[] = [];
    const { container, controller } = createPanel(coordinator, {
      listHistory: async () => source,
      openArtifact: (path) => { opened.push(path); },
    });
    await controller.show("summary");

    click(button(container, "history"));
    await flush();
    const rows = [...container.querySelectorAll<HTMLButtonElement>(
      'button[data-action="history-entry"]',
    )];

    expect(rows).toHaveLength(2);
    expect(rows[0]?.dataset.path).toBe(newerPath);
    click(rows[1]);
    expect(opened).toEqual([HISTORY_PATH]);
    expect(container.querySelector(".rss-dashboard-inline-ai-body")?.textContent)
      .toBe("Current answer");
    expect(source).toEqual([older, newer]);
    expect(coordinator.calls.start).toEqual([]);
    expect(coordinator.calls.regenerate).toEqual([]);
  });

  it("ignores stale history and listener events after an operation switch", async () => {
    const coordinator = new FakeCoordinator();
    const summaryHistory = deferred<AiTaskSnapshot>();
    coordinator.loadLatestImpl = (_itemId, operation) =>
      operation === "summary"
        ? summaryHistory.promise
        : Promise.resolve(state("generating", {
          operation: "deep-analysis",
          text: "Deep stream",
        }));
    const { container, controller } = createPanel(coordinator);

    const firstShow = controller.show("summary");
    await flush();
    const staleListener = [...coordinator.listeners][0];
    await controller.show("deep-analysis");
    staleListener?.(state("complete", {
      text: "Wrong summary",
      artifactPath: HISTORY_PATH,
    }));
    summaryHistory.resolve(state("idle"));
    await firstShow;

    expect(container.textContent).toContain("Deep analysis");
    expect(container.textContent).not.toContain("Wrong summary");
    expect(coordinator.calls.start.some(({ operation }) => operation === "summary"))
      .toBe(false);
  });

  it("uses an injected safe Markdown renderer and consumes rejected action promises", async () => {
    const coordinator = new FakeCoordinator(state("complete", {
      text: "**Rendered safely**",
      artifactPath: CURRENT_PATH,
    }));
    const renderMarkdown = vi.fn((container: HTMLElement, text: string) => {
      const strong = container.appendChild(document.createElement("strong"));
      strong.textContent = text;
    });
    const { container, controller } = createPanel(coordinator, {
      renderMarkdown,
      openArtifact: () => Promise.reject(new Error("expected rejection")),
    });

    await controller.show("summary");
    click(button(container, "open"));
    await flush();

    expect(renderMarkdown).toHaveBeenCalled();
    expect(container.querySelector("strong")?.textContent)
      .toBe("**Rendered safely**");
  });

  it("ignores an old start completion after explicit regeneration begins", async () => {
    const coordinator = new FakeCoordinator();
    const oldStart = deferred<AiTaskSnapshot>();
    coordinator.startImpl = () => oldStart.promise;
    const { container, controller } = createPanel(coordinator);

    await controller.show("summary");
    coordinator.emit(state("complete", {
      text: "First result",
      artifactPath: CURRENT_PATH,
    }));
    click(button(container, "regenerate"));
    oldStart.resolve(state("complete", {
      text: "Stale first result",
      artifactPath: CURRENT_PATH,
    }));
    await flush();

    expect(container.textContent).toContain("Preparing the selected item");
    expect(container.textContent).not.toContain("Stale first result");
  });

  it("defensively snapshots connection names and ignores later option mutation", async () => {
    const coordinator = new FakeCoordinator(state("complete", {
      text: "Done",
      artifactPath: CURRENT_PATH,
      connectionName: "B".repeat(2_000),
      model: "M".repeat(2_000),
    }));
    const mutable = connection({ name: "A".repeat(2_000) });
    const connections = [mutable];
    const { container, controller } = createPanel(coordinator, { connections });
    mutable.name = "MUTATED";
    connections.length = 0;

    await controller.show("summary");

    const option = container.querySelector("option");
    expect(option?.textContent).not.toContain("MUTATED");
    expect(option?.textContent?.length).toBeLessThanOrEqual(160);
    for (const detail of container.querySelectorAll("dd")) {
      expect(detail.textContent?.length).toBeLessThanOrEqual(160);
    }
  });

  it("rejects snapshots for another item instead of repainting foreign content", async () => {
    const coordinator = new FakeCoordinator(state("generating", {
      itemId: OTHER_ITEM_ID,
      text: "Foreign private result",
    }));
    const { container, controller } = createPanel(coordinator);

    await controller.show("summary");

    expect(container.textContent).not.toContain("Foreign private result");
    expect(container.textContent).toContain(
      "The provider rejected the model or request.",
    );
  });
});

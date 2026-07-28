import type { YouTubeTranscriptCachedItemContent } from "../collection/content-repository";
import { createTranslator, type Locale, type Translator } from "../i18n";
import {
  YouTubeTranscriptServiceError,
  type YouTubeTranscriptRequest,
  type YouTubeTranscriptServiceResult,
} from "../youtube-transcript/youtube-transcript-service";

export interface YouTubeTranscriptPanelService {
  get(request: YouTubeTranscriptRequest): Promise<YouTubeTranscriptServiceResult>;
  revokeChoiceSet(choiceSetId: string): void;
}

export interface YouTubeTranscriptPanelRuntime {
  identity: string;
  service: YouTubeTranscriptPanelService;
  loadCached(): Promise<YouTubeTranscriptCachedItemContent | null>;
}

export interface YouTubeTranscriptPanelController {
  showCached(): Promise<void>;
  fetch(): Promise<void>;
  refresh(): Promise<void>;
  selectTrack(trackId: string): Promise<void>;
  refreshLocalization(translator: Translator, locale: Locale): void;
  abort(): void;
  destroy(): void;
}

export interface YouTubeTranscriptPanelOptions {
  container: HTMLElement;
  locale: Locale;
  request: Omit<YouTubeTranscriptRequest, "refresh" | "trackId" | "signal">;
  resolveRuntime: () => YouTubeTranscriptPanelRuntime;
  openExternal: (url: string) => void;
  onReady?: (content: YouTubeTranscriptCachedItemContent) => void;
}

type PanelState =
  | "idle"
  | "cached"
  | "checking"
  | "language-choice"
  | "fetching"
  | "complete-manual"
  | "complete-auto"
  | "no-captions"
  | "fallback-unavailable"
  | "temporarily-unavailable"
  | "unavailable"
  | "timeout"
  | "aborted"
  | "destroyed";

type StatusTranslationKey =
  | "transcript.status.checking"
  | "transcript.status.fetching"
  | "transcript.status.aborted"
  | "transcript.error.noCaptions"
  | "transcript.error.fallbackUnavailable"
  | "transcript.error.timeout"
  | "transcript.error.unavailable"
  | "transcript.error.temporary";

type PanelSnapshot =
  | { kind: "idle" }
  | {
      kind: "status";
      state: PanelState;
      key: StatusTranslationKey;
      isError: boolean;
    }
  | {
      kind: "choice";
      tracks: YouTubeTranscriptServiceResult & { status: "selection-required" };
    }
  | {
      kind: "ready";
      content: YouTubeTranscriptCachedItemContent;
      state: "cached" | undefined;
    };

/** Compact, non-modal UI for one explicit YouTube transcript action. */
export class YouTubeTranscriptPanel implements YouTubeTranscriptPanelController {
  private readonly root: HTMLElement;
  private readonly dom: Document;
  private t: Translator;
  private locale: Locale;
  private activeController: AbortController | null = null;
  private runtimeIdentity: string | null = null;
  private choiceLease: {
    service: YouTubeTranscriptPanelService;
    choiceSetId: string;
  } | null = null;
  private snapshot: PanelSnapshot = { kind: "idle" };
  private operationSequence = 0;
  private destroyed = false;

  constructor(private readonly options: YouTubeTranscriptPanelOptions) {
    this.t = createTranslator(options.locale);
    this.locale = options.locale;
    this.dom = options.container.ownerDocument;
    this.root = this.dom.createElement("section");
    this.root.className = "rss-youtube-transcript-panel";
    this.root.setAttribute("aria-live", "polite");
    this.options.container.replaceChildren(this.root);
    this.renderIdle();
  }

  async showCached(): Promise<void> {
    if (this.destroyed) return;
    const { runtime } = this.resolveRuntime();
    const operation = ++this.operationSequence;
    let content: YouTubeTranscriptCachedItemContent | null;
    try {
      content = await runtime.loadCached();
    } catch {
      content = null;
    }
    if (!this.confirmRuntime(runtime, operation)) return;
    if (!content || !this.matchesRequest(content)) {
      this.renderIdle();
      return;
    }
    this.renderReady(content, "cached");
  }

  async fetch(): Promise<void> {
    await this.runRequest({ refresh: false }, "checking");
  }

  async refresh(): Promise<void> {
    await this.runRequest({ refresh: true }, "checking");
  }

  async selectTrack(trackId: string): Promise<void> {
    if (!trackId) return;
    const resolved = this.resolveRuntime();
    await this.runRequest(
      resolved.changed ? {} : { trackId },
      resolved.changed ? "checking" : "fetching",
      resolved.runtime,
    );
  }

  refreshLocalization(translator: Translator, locale: Locale): void {
    if (this.destroyed) return;
    this.t = translator;
    this.locale = locale;
    this.renderSnapshot();
  }

  abort(): void {
    if (this.destroyed) return;
    this.operationSequence += 1;
    this.activeController?.abort();
    this.activeController = null;
    this.revokeChoiceLease();
    this.renderStatus("aborted", "transcript.status.aborted", true);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.operationSequence += 1;
    this.activeController?.abort();
    this.activeController = null;
    this.revokeChoiceLease();
    this.root.replaceChildren();
    this.root.setAttribute("data-state", "destroyed");
    this.root.removeAttribute("aria-live");
  }

  private async runRequest(
    request: Pick<YouTubeTranscriptRequest, "refresh" | "trackId">,
    pendingState: "checking" | "fetching",
    fixedRuntime?: YouTubeTranscriptPanelRuntime,
  ): Promise<void> {
    if (this.destroyed) return;
    const runtime = fixedRuntime ?? this.resolveRuntime().runtime;
    this.activeController?.abort();
    if (request.trackId === undefined) this.revokeChoiceLease();
    const controller = new AbortController();
    this.activeController = controller;
    const operation = ++this.operationSequence;
    this.renderStatus(
      pendingState,
      pendingState === "checking"
        ? "transcript.status.checking"
        : "transcript.status.fetching",
    );
    try {
      const result = await runtime.service.get({
        ...this.options.request,
        ...(request.refresh === undefined ? {} : { refresh: request.refresh }),
        ...(request.trackId === undefined ? {} : { trackId: request.trackId }),
        signal: controller.signal,
      });
      if (!this.confirmRuntime(runtime, operation)) return;
      this.activeController = null;
      this.renderResult(result, runtime.service);
    } catch (error) {
      if (!this.confirmRuntime(runtime, operation)) return;
      this.activeController = null;
      this.renderError(error);
    }
  }

  private renderResult(
    result: YouTubeTranscriptServiceResult,
    service: YouTubeTranscriptPanelService,
  ): void {
    if (result.status === "ready") {
      this.choiceLease = null;
      this.renderReady(result.content, result.source === "cache" ? "cached" : undefined);
      return;
    }
    this.revokeChoiceLease();
    this.choiceLease = { service, choiceSetId: result.choiceSetId };
    this.renderChoice(result);
  }

  private renderChoice(
    result: YouTubeTranscriptServiceResult & { status: "selection-required" },
    remember = true,
  ): void {
    if (remember) this.snapshot = { kind: "choice", tracks: result };
    this.prepare("language-choice");
    this.root.appendChild(this.heading());
    const prompt = this.dom.createElement("p");
    prompt.className = "rss-youtube-transcript-status";
    prompt.textContent = this.t("transcript.status.chooseLanguage");
    this.root.appendChild(prompt);
    const choices = this.dom.createElement("div");
    choices.className = "rss-youtube-transcript-languages";
    for (const track of result.tracks) {
      const button = this.actionButton(
        `${track.languageName} · ${this.t(
          track.isGenerated ? "transcript.kind.generated" : "transcript.kind.manual",
        )}`,
        "rss-youtube-transcript-language",
      );
      button.addEventListener("click", () => void this.selectTrack(track.id));
      choices.appendChild(button);
    }
    this.root.appendChild(choices);
  }

  private renderReady(
    content: YouTubeTranscriptCachedItemContent,
    state: "cached" | undefined,
    notify = true,
    remember = true,
  ): void {
    if (!this.matchesRequest(content)) {
      this.renderError(new YouTubeTranscriptServiceError("temporarily-unavailable"));
      return;
    }
    if (remember) this.snapshot = { kind: "ready", content, state };
    this.prepare(state ?? (content.isGenerated ? "complete-auto" : "complete-manual"));
    const header = this.dom.createElement("div");
    header.className = "rss-youtube-transcript-header";
    header.appendChild(this.heading());
    const badge = this.dom.createElement("span");
    badge.className = "rss-youtube-transcript-badge";
    badge.textContent = this.t(
      content.isGenerated ? "transcript.kind.generated" : "transcript.kind.manual",
    );
    header.appendChild(badge);
    this.root.appendChild(header);

    const meta = this.dom.createElement("div");
    meta.className = "rss-youtube-transcript-meta";
    const fetched = new Date(content.fetchedAt);
    const fetchedText = Number.isNaN(fetched.getTime())
      ? content.fetchedAt
      : fetched.toLocaleString(this.locale);
    meta.textContent = this.t("transcript.meta", {
      language: content.languageName,
      time: fetchedText,
    });
    this.root.appendChild(meta);

    const details = this.dom.createElement("details");
    details.className = "rss-youtube-transcript-details";
    details.open = true;
    const summary = this.dom.createElement("summary");
    summary.textContent = this.t("transcript.toggle");
    details.appendChild(summary);
    const body = this.dom.createElement("div");
    body.className = "rss-youtube-transcript-body";
    body.textContent = content.text;
    details.appendChild(body);
    this.root.appendChild(details);

    const actions = this.dom.createElement("div");
    actions.className = "rss-youtube-transcript-actions";
    const refresh = this.actionButton(
      this.t("transcript.refresh"),
      "rss-youtube-transcript-refresh",
    );
    refresh.addEventListener("click", () => void this.refresh());
    actions.appendChild(refresh);
    const external = this.actionButton(
      this.t("transcript.playExternal"),
      "rss-youtube-transcript-external",
    );
    external.addEventListener("click", () => {
      this.options.openExternal(
        `https://www.youtube.com/watch?v=${this.options.request.videoId}`,
      );
    });
    actions.appendChild(external);
    this.root.appendChild(actions);
    if (notify) this.options.onReady?.(content);
  }

  private renderIdle(remember = true): void {
    if (remember) this.snapshot = { kind: "idle" };
    this.prepare("idle");
    this.root.appendChild(this.heading());
    const button = this.actionButton(
      this.t("transcript.fetch"),
      "rss-youtube-transcript-fetch",
    );
    button.addEventListener("click", () => void this.fetch());
    this.root.appendChild(button);
  }

  private renderError(error: unknown): void {
    const code = error instanceof YouTubeTranscriptServiceError
      ? error.code
      : "temporarily-unavailable";
    switch (code) {
      case "no-captions":
        this.renderStatus("no-captions", "transcript.error.noCaptions", true);
        return;
      case "fallback-unavailable":
        this.renderStatus(
          "fallback-unavailable",
          "transcript.error.fallbackUnavailable",
          true,
        );
        return;
      case "timeout":
        this.renderStatus("timeout", "transcript.error.timeout", true);
        return;
      case "aborted":
        this.renderStatus("aborted", "transcript.status.aborted", true);
        return;
      case "video-unavailable":
      case "login-required":
      case "invalid-video-id":
        this.renderStatus("unavailable", "transcript.error.unavailable", true);
        return;
      default:
        this.renderStatus(
          "temporarily-unavailable",
          "transcript.error.temporary",
          true,
        );
    }
  }

  private renderStatus(
    state: PanelState,
    key: StatusTranslationKey,
    isError = false,
    remember = true,
  ): void {
    if (remember) this.snapshot = { kind: "status", state, key, isError };
    this.prepare(state);
    this.root.appendChild(this.heading());
    const status = this.dom.createElement("p");
    status.className = isError
      ? "rss-youtube-transcript-status rss-youtube-transcript-error"
      : "rss-youtube-transcript-status";
    status.textContent = this.t(key);
    this.root.appendChild(status);
    if (isError && state !== "aborted") {
      const retry = this.actionButton(
        this.t("transcript.fetch"),
        "rss-youtube-transcript-fetch",
      );
      retry.addEventListener("click", () => void this.fetch());
      this.root.appendChild(retry);
    }
  }

  private heading(): HTMLElement {
    const heading = this.dom.createElement("strong");
    heading.className = "rss-youtube-transcript-title";
    heading.textContent = this.t("transcript.title");
    return heading;
  }

  private prepare(state: PanelState): void {
    this.root.replaceChildren();
    this.root.setAttribute("data-state", state);
  }

  private actionButton(text: string, className: string): HTMLButtonElement {
    const button = this.dom.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    return button;
  }

  private matchesRequest(content: YouTubeTranscriptCachedItemContent): boolean {
    return (
      content.schemaVersion === 2 &&
      content.contentBasis === "youtube-transcript" &&
      content.itemId === this.options.request.itemId &&
      content.videoId === this.options.request.videoId &&
      content.text.trim().length > 0
    );
  }

  private isCurrent(operation: number): boolean {
    return !this.destroyed && operation === this.operationSequence;
  }

  private confirmRuntime(
    expected: YouTubeTranscriptPanelRuntime,
    operation: number,
  ): boolean {
    if (!this.isCurrent(operation)) return false;
    let resolved: {
      runtime: YouTubeTranscriptPanelRuntime;
      changed: boolean;
    };
    try {
      resolved = this.resolveRuntime();
    } catch {
      if (!this.isCurrent(operation)) return false;
      this.operationSequence += 1;
      this.activeController?.abort();
      this.activeController = null;
      this.revokeChoiceLease();
      this.renderError(
        new YouTubeTranscriptServiceError("temporarily-unavailable"),
      );
      return false;
    }
    if (
      resolved.changed ||
      resolved.runtime.identity !== expected.identity ||
      resolved.runtime.service !== expected.service
    ) {
      this.activeController = null;
      if (!this.destroyed) this.renderIdle();
      return false;
    }
    return this.isCurrent(operation);
  }

  private resolveRuntime(): {
    runtime: YouTubeTranscriptPanelRuntime;
    changed: boolean;
  } {
    const runtime = this.options.resolveRuntime();
    const changed =
      this.runtimeIdentity !== null && this.runtimeIdentity !== runtime.identity;
    if (changed) {
      this.operationSequence += 1;
      this.activeController?.abort();
      this.activeController = null;
      this.revokeChoiceLease();
    }
    this.runtimeIdentity = runtime.identity;
    return { runtime, changed };
  }

  private revokeChoiceLease(): void {
    const lease = this.choiceLease;
    this.choiceLease = null;
    if (!lease) return;
    lease.service.revokeChoiceSet(lease.choiceSetId);
  }

  private renderSnapshot(): void {
    switch (this.snapshot.kind) {
      case "idle":
        this.renderIdle(false);
        return;
      case "status":
        this.renderStatus(
          this.snapshot.state,
          this.snapshot.key,
          this.snapshot.isError,
          false,
        );
        return;
      case "choice":
        this.renderChoice(this.snapshot.tracks, false);
        return;
      case "ready":
        this.renderReady(
          this.snapshot.content,
          this.snapshot.state,
          false,
          false,
        );
    }
  }
}

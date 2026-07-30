import type { YouTubeTranscriptCachedItemContent } from "../collection/content-repository";
import { createTranslator, type Locale, type Translator } from "../i18n";
import {
  YouTubeTranscriptServiceError,
  type YouTubeTranscriptCacheRequest,
  type YouTubeTranscriptContinuationRequest,
  type YouTubeTranscriptRequest,
  type YouTubeTranscriptServiceResult,
} from "../youtube-transcript/youtube-transcript-service";
import type {
  YouTubeTranscriptProgress,
  YouTubeTranscriptProvider,
} from "../youtube-transcript/transcript-types";

export interface YouTubeTranscriptPanelService {
  get(request: YouTubeTranscriptRequest): Promise<YouTubeTranscriptServiceResult>;
  readCached(
    request: YouTubeTranscriptCacheRequest,
  ): Promise<YouTubeTranscriptCachedItemContent | null>;
  hasPendingContinuation?(
    request: YouTubeTranscriptCacheRequest,
  ): Promise<boolean>;
  continuePending?(
    request: YouTubeTranscriptContinuationRequest,
  ): Promise<YouTubeTranscriptServiceResult & { status: "ready" }>;
  revokeChoiceSet(choiceSetId: string): void;
}

export interface YouTubeTranscriptPanelRuntime {
  identity: string;
  service: YouTubeTranscriptPanelService;
}

export interface YouTubeTranscriptRuntimeOptions {
  resolveRuntime(): YouTubeTranscriptPanelRuntime;
  openExternalUrl?: (url: string) => void;
  openTikHubSettings?: () => void | Promise<void>;
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
  openTikHubSettings?: () => void | Promise<void>;
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
  | "login-required"
  | "unavailable"
  | "timeout"
  | "tikhub-processing"
  | "tikhub-invalid-key"
  | "tikhub-missing-key"
  | "tikhub-insufficient-balance"
  | "tikhub-budget-unavailable"
  | "tikhub-rate-limited"
  | "tikhub-job-expired"
  | "tikhub-malformed-response"
  | "aborted"
  | "destroyed";

type StatusTranslationKey =
  | "transcript.status.checking"
  | "transcript.status.fetching"
  | "transcript.status.tryingInnerTube"
  | "transcript.status.tryingTikHub"
  | "transcript.status.waitingTikHub"
  | "transcript.status.tryingYtDlp"
  | "transcript.status.saving"
  | "transcript.status.aborted"
  | "transcript.error.noCaptions"
  | "transcript.error.fallbackUnavailable"
  | "transcript.error.loginRequired"
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
      confirmedUsage: 0 | 1 | 2;
      possiblySent: boolean;
    }
  | {
      kind: "choice";
      tracks: YouTubeTranscriptServiceResult & { status: "selection-required" };
    }
  | {
      kind: "ready";
      content: YouTubeTranscriptCachedItemContent;
      state: "cached" | undefined;
      freshTikHubUsage: 0 | 1 | 2;
    }
  | {
      kind: "tikhub-failure";
      code: Extract<
        PanelState,
        | "tikhub-processing"
        | "tikhub-invalid-key"
        | "tikhub-missing-key"
        | "tikhub-insufficient-balance"
        | "tikhub-budget-unavailable"
        | "tikhub-rate-limited"
        | "tikhub-job-expired"
        | "tikhub-malformed-response"
      >;
      possiblySent: boolean;
      confirmedUsage: 0 | 1 | 2;
    };

/** Compact, non-modal UI for one explicit YouTube transcript action. */
export class YouTubeTranscriptPanel implements YouTubeTranscriptPanelController {
  private readonly root: HTMLElement;
  private readonly dom: Document;
  private t: Translator;
  private locale: Locale;
  private activeController: AbortController | null = null;
  private runtimeIdentity: string | null = null;
  private runtimeService: YouTubeTranscriptPanelService | null = null;
  private choiceLease: {
    service: YouTubeTranscriptPanelService;
    choiceSetId: string;
  } | null = null;
  private snapshot: PanelSnapshot = { kind: "idle" };
  private operationSequence = 0;
  private confirmedTikHubUsage: 0 | 1 | 2 = 0;
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
    const resolved = this.resolveRuntimeEntry();
    if (!resolved) return;
    const { runtime } = resolved;
    this.activeController?.abort();
    const controller = new AbortController();
    this.activeController = controller;
    const operation = ++this.operationSequence;
    let content: YouTubeTranscriptCachedItemContent | null;
    let hasPendingContinuation = false;
    try {
      content = await runtime.service.readCached({
        itemId: this.options.request.itemId,
        videoId: this.options.request.videoId,
        signal: controller.signal,
      });
      if (!content && runtime.service.hasPendingContinuation) {
        hasPendingContinuation = await runtime.service.hasPendingContinuation({
          itemId: this.options.request.itemId,
          videoId: this.options.request.videoId,
          signal: controller.signal,
        });
      }
    } catch {
      content = null;
    }
    if (!this.confirmRuntime(runtime, operation)) return;
    this.activeController = null;
    if (!content || !this.matchesRequest(content)) {
      if (hasPendingContinuation) {
        this.confirmedTikHubUsage = 0;
        this.renderTikHubFailure("tikhub-processing", false, 0);
        return;
      }
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
    if (this.destroyed || !trackId) return;
    const resolved = this.resolveRuntimeEntry();
    if (!resolved) return;
    await this.runRequest(
      resolved.changed ? {} : { trackId },
      resolved.changed ? "checking" : "fetching",
      resolved.runtime,
    );
  }

  private async continuePending(): Promise<void> {
    if (this.destroyed) return;
    const resolved = this.resolveRuntimeEntry();
    if (!resolved) return;
    const { runtime } = resolved;
    this.activeController?.abort();
    this.revokeChoiceLease();
    const controller = new AbortController();
    this.activeController = controller;
    const operation = ++this.operationSequence;
    this.renderStatus("fetching", "transcript.status.waitingTikHub");
    if (!runtime.service.continuePending) {
      this.activeController = null;
      this.renderError(new YouTubeTranscriptServiceError("tikhub-job-expired"));
      return;
    }
    try {
      const result = await runtime.service.continuePending({
        ...this.options.request,
        signal: controller.signal,
        onProgress: (progress) => this.onProgress(runtime, operation, progress),
      });
      if (!this.confirmRuntime(runtime, operation)) return;
      this.activeController = null;
      this.renderResult(result, runtime.service, true);
    } catch (error) {
      if (!this.confirmRuntime(runtime, operation)) return;
      this.activeController = null;
      this.renderError(error);
    }
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
    const resolved = fixedRuntime === undefined
      ? this.resolveRuntimeEntry()
      : { runtime: fixedRuntime, changed: false };
    if (!resolved) return;
    const { runtime } = resolved;
    if (request.trackId === undefined) this.confirmedTikHubUsage = 0;
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
        onProgress: (progress) => this.onProgress(runtime, operation, progress),
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
    preserveUsage = false,
  ): void {
    if (result.status === "ready") {
      this.choiceLease = null;
      const resultUsage = result.source === "fresh"
        ? result.usage?.tikhubPaidRequests ?? 0
        : 0;
      this.confirmedTikHubUsage = preserveUsage
        ? maxUsage(this.confirmedTikHubUsage, resultUsage)
        : resultUsage;
      this.renderReady(
        result.content,
        result.source === "cache" ? "cached" : undefined,
        true,
        true,
        this.confirmedTikHubUsage,
      );
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
    freshTikHubUsage: 0 | 1 | 2 = 0,
  ): void {
    if (state === "cached") this.confirmedTikHubUsage = 0;
    if (!this.matchesRequest(content)) {
      this.renderError(new YouTubeTranscriptServiceError("temporarily-unavailable"));
      return;
    }
    if (remember) {
      this.snapshot = { kind: "ready", content, state, freshTikHubUsage };
    }
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
    const provider = this.dom.createElement("span");
    provider.className = "rss-youtube-transcript-badge rss-youtube-transcript-provider";
    provider.textContent = this.providerName(content.provider);
    header.appendChild(provider);
    this.root.appendChild(header);

    const meta = this.dom.createElement("div");
    meta.className = "rss-youtube-transcript-meta";
    const fetched = new Date(content.fetchedAt);
    const fetchedText = Number.isNaN(fetched.getTime())
      ? content.fetchedAt
      : fetched.toLocaleString(this.locale);
    meta.textContent = this.t("transcript.meta", {
      language: content.languageName,
      kind: this.t(
        content.isGenerated ? "transcript.kind.generated" : "transcript.kind.manual",
      ),
      source: this.providerName(content.provider),
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
    const refreshWarning = this.dom.createElement("p");
    refreshWarning.className = "rss-youtube-transcript-cost-warning";
    refreshWarning.textContent = this.t("transcript.cost.refreshWarning");
    actions.appendChild(refreshWarning);
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
    if (freshTikHubUsage > 0) {
      const usage = this.dom.createElement("p");
      usage.className = "rss-youtube-transcript-usage";
      usage.textContent = this.t("transcript.cost.confirmedUsage", {
        count: freshTikHubUsage,
        cost: freshTikHubUsage === 1 ? "$0.008" : "$0.016",
      });
      this.root.appendChild(usage);
    }
    if (notify) this.options.onReady?.(content);
  }

  private renderIdle(remember = true): void {
    this.confirmedTikHubUsage = 0;
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
    const serviceError = error instanceof YouTubeTranscriptServiceError
      ? error
      : undefined;
    const code = serviceError?.code ?? "temporarily-unavailable";
    const confirmedUsage = serviceError?.usage.tikhubPaidRequests ?? 0;
    this.confirmedTikHubUsage = maxUsage(
      this.confirmedTikHubUsage,
      confirmedUsage,
    );
    const possiblySent = serviceError?.tikhubPaidRequestPossiblySent === true;
    if (isTikHubPanelState(code)) {
      this.renderTikHubFailure(
        code,
        possiblySent,
        this.confirmedTikHubUsage,
      );
      return;
    }
    switch (code) {
      case "no-captions":
        this.renderStatus("no-captions", "transcript.error.noCaptions", true, true, this.confirmedTikHubUsage, possiblySent);
        return;
      case "fallback-unavailable":
        this.renderStatus(
          "fallback-unavailable",
          "transcript.error.fallbackUnavailable",
          true,
          true,
          this.confirmedTikHubUsage,
          possiblySent,
        );
        return;
      case "timeout":
        this.renderStatus("timeout", "transcript.error.timeout", true, true, this.confirmedTikHubUsage, possiblySent);
        return;
      case "aborted":
        this.renderStatus("aborted", "transcript.status.aborted", true, true, this.confirmedTikHubUsage, possiblySent);
        return;
      case "login-required":
        this.renderStatus(
          "login-required",
          "transcript.error.loginRequired",
          true,
          true,
          this.confirmedTikHubUsage,
          possiblySent,
        );
        return;
      case "video-unavailable":
      case "invalid-video-id":
        this.renderStatus("unavailable", "transcript.error.unavailable", true, true, this.confirmedTikHubUsage, possiblySent);
        return;
      default:
        this.renderStatus(
          "temporarily-unavailable",
          "transcript.error.temporary",
          true,
          true,
          this.confirmedTikHubUsage,
          possiblySent,
        );
    }
  }

  private onProgress(
    runtime: YouTubeTranscriptPanelRuntime,
    operation: number,
    progress: YouTubeTranscriptProgress,
  ): void {
    if (!this.confirmRuntime(runtime, operation)) return;
    this.confirmedTikHubUsage = maxUsage(
      this.confirmedTikHubUsage,
      progress.usage.tikhubPaidRequests,
    );
    const key = progressKey(progress.stage);
    this.renderStatus("fetching", key);
  }

  private renderTikHubFailure(
    code: Extract<PanelState, `tikhub-${string}`>,
    possiblySent: boolean,
    confirmedUsage: 0 | 1 | 2,
    remember = true,
  ): void {
    if (remember) {
      this.snapshot = {
        kind: "tikhub-failure",
        code,
        possiblySent,
        confirmedUsage,
      };
    }
    this.prepare(code);
    this.root.appendChild(this.heading());
    const status = this.dom.createElement("p");
    status.className = code === "tikhub-processing"
      ? "rss-youtube-transcript-status"
      : "rss-youtube-transcript-status rss-youtube-transcript-error";
    status.textContent = this.t(tikHubErrorKey(code));
    this.root.appendChild(status);

    const source = this.dom.createElement("p");
    source.className = "rss-youtube-transcript-source";
    source.textContent = this.t("transcript.sourceLine", { source: "TikHub" });
    this.root.appendChild(source);

    this.appendFailureEvidence(confirmedUsage, possiblySent);

    const actions = this.dom.createElement("div");
    actions.className = "rss-youtube-transcript-actions";
    const action = tikHubAction(code);
    if (action.kind === "settings" && !this.options.openTikHubSettings) return;
    const button = this.actionButton(this.t(action.key), action.className);
    button.addEventListener("click", () => {
      if (action.kind === "continuation") {
        void this.continuePending();
      } else if (action.kind === "fetch") {
        void this.fetch();
      } else if (action.kind === "refresh") {
        void this.refresh();
      } else {
        void this.options.openTikHubSettings?.();
      }
    });
    actions.appendChild(button);
    this.root.appendChild(actions);
  }

  private renderStatus(
    state: PanelState,
    key: StatusTranslationKey,
    isError = false,
    remember = true,
    confirmedUsage: 0 | 1 | 2 = 0,
    possiblySent = false,
  ): void {
    if (remember) {
      this.snapshot = {
        kind: "status",
        state,
        key,
        isError,
        confirmedUsage,
        possiblySent,
      };
    }
    this.prepare(state);
    this.root.appendChild(this.heading());
    const status = this.dom.createElement("p");
    status.className = isError
      ? "rss-youtube-transcript-status rss-youtube-transcript-error"
      : "rss-youtube-transcript-status";
    status.textContent = this.t(key);
    this.root.appendChild(status);
    if (isError) this.appendFailureEvidence(confirmedUsage, possiblySent);
    if (isError && state !== "aborted") {
      const retry = this.actionButton(
        this.t("transcript.fetch"),
        "rss-youtube-transcript-fetch",
      );
      retry.addEventListener("click", () => void this.fetch());
      this.root.appendChild(retry);
    }
  }

  private appendFailureEvidence(
    confirmedUsage: 0 | 1 | 2,
    possiblySent: boolean,
  ): void {
    if (confirmedUsage > 0) {
      const usage = this.dom.createElement("p");
      usage.className = "rss-youtube-transcript-usage";
      usage.textContent = this.t("transcript.cost.confirmedUsage", {
        count: confirmedUsage,
        cost: confirmedUsage === 1 ? "$0.008" : "$0.016",
      });
      this.root.appendChild(usage);
    }
    if (possiblySent) {
      const warning = this.dom.createElement("p");
      warning.className = "rss-youtube-transcript-cost-warning";
      warning.textContent = this.t("transcript.cost.possiblySent");
      this.root.appendChild(warning);
    }
  }

  private heading(): HTMLElement {
    const heading = this.dom.createElement("strong");
    heading.className = "rss-youtube-transcript-title";
    heading.textContent = this.t("transcript.title");
    return heading;
  }

  private providerName(provider: YouTubeTranscriptProvider): string {
    return this.t(`transcript.provider.${provider}`);
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
    const current = this.resolveRuntimeEntry();
    if (!current) return false;
    resolved = current;
    if (
      resolved.changed ||
      resolved.runtime.identity !== expected.identity ||
      resolved.runtime.service !== expected.service
    ) {
      if (!resolved.changed) {
        this.invalidateRuntime("idle");
        this.rememberRuntime(resolved.runtime);
      }
      return false;
    }
    return this.isCurrent(operation);
  }

  private resolveRuntimeEntry(): {
    runtime: YouTubeTranscriptPanelRuntime;
    changed: boolean;
  } | null {
    if (this.destroyed) return null;
    let runtime: YouTubeTranscriptPanelRuntime;
    try {
      runtime = this.options.resolveRuntime();
    } catch {
      this.invalidateRuntime("error");
      return null;
    }
    const changed = this.runtimeService !== null && (
      this.runtimeIdentity !== runtime.identity ||
      this.runtimeService !== runtime.service
    );
    if (changed) {
      this.invalidateRuntime("idle");
    }
    this.rememberRuntime(runtime);
    return { runtime, changed };
  }

  private rememberRuntime(runtime: YouTubeTranscriptPanelRuntime): void {
    this.runtimeIdentity = runtime.identity;
    this.runtimeService = runtime.service;
  }

  private invalidateRuntime(nextState: "idle" | "error"): void {
    this.operationSequence += 1;
    this.activeController?.abort();
    this.activeController = null;
    this.revokeChoiceLease();
    this.runtimeIdentity = null;
    this.runtimeService = null;
    if (this.destroyed) return;
    if (nextState === "idle") {
      this.renderIdle();
      return;
    }
    this.renderError(
      new YouTubeTranscriptServiceError("temporarily-unavailable"),
    );
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
          this.snapshot.confirmedUsage,
          this.snapshot.possiblySent,
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
          this.snapshot.freshTikHubUsage,
        );
        return;
      case "tikhub-failure":
        this.renderTikHubFailure(
          this.snapshot.code,
          this.snapshot.possiblySent,
          this.snapshot.confirmedUsage,
          false,
        );
    }
  }
}

function isTikHubPanelState(
  code: string,
): code is Extract<PanelState, `tikhub-${string}`> {
  return new Set<Extract<PanelState, `tikhub-${string}`>>([
    "tikhub-processing",
    "tikhub-invalid-key",
    "tikhub-missing-key",
    "tikhub-insufficient-balance",
    "tikhub-budget-unavailable",
    "tikhub-rate-limited",
    "tikhub-job-expired",
    "tikhub-malformed-response",
  ]).has(code as Extract<PanelState, `tikhub-${string}`>);
}

function progressKey(
  stage: YouTubeTranscriptProgress["stage"],
): StatusTranslationKey {
  switch (stage) {
    case "trying-innertube":
      return "transcript.status.tryingInnerTube";
    case "trying-tikhub":
      return "transcript.status.tryingTikHub";
    case "waiting-tikhub":
      return "transcript.status.waitingTikHub";
    case "trying-yt-dlp":
      return "transcript.status.tryingYtDlp";
    case "saving":
      return "transcript.status.saving";
    case "checking-cache":
      return "transcript.status.checking";
  }
}

function tikHubErrorKey(
  code: Extract<PanelState, `tikhub-${string}`>,
): import("../i18n").TranslationKey {
  switch (code) {
    case "tikhub-processing": return "transcript.error.tikhubProcessing";
    case "tikhub-invalid-key": return "transcript.error.tikhubInvalidKey";
    case "tikhub-missing-key": return "transcript.error.tikhubMissingKey";
    case "tikhub-insufficient-balance": return "transcript.error.tikhubBalance";
    case "tikhub-budget-unavailable": return "transcript.error.tikhubBudget";
    case "tikhub-rate-limited": return "transcript.error.tikhubRateLimit";
    case "tikhub-job-expired": return "transcript.error.tikhubExpired";
    case "tikhub-malformed-response": return "transcript.error.tikhubMalformed";
  }
}

function tikHubAction(
  code: Extract<PanelState, `tikhub-${string}`>,
): {
  key: import("../i18n").TranslationKey;
  className: string;
  kind: "continuation" | "fetch" | "refresh" | "settings";
} {
  switch (code) {
    case "tikhub-processing":
      return { key: "transcript.action.continueQuery", className: "rss-youtube-transcript-continue", kind: "continuation" };
    case "tikhub-job-expired":
      return { key: "transcript.action.refetchWithCost", className: "rss-youtube-transcript-refresh", kind: "refresh" };
    case "tikhub-invalid-key":
    case "tikhub-missing-key":
    case "tikhub-insufficient-balance":
      return { key: code === "tikhub-insufficient-balance" ? "transcript.action.checkTikHubBalance" : "transcript.action.openTikHubSettings", className: "rss-youtube-transcript-tikhub-settings", kind: "settings" };
    case "tikhub-budget-unavailable":
      return { key: "transcript.action.retryTomorrow", className: "rss-youtube-transcript-fetch", kind: "fetch" };
    case "tikhub-rate-limited":
      return { key: "transcript.action.retryLater", className: "rss-youtube-transcript-fetch", kind: "fetch" };
    case "tikhub-malformed-response":
      return { key: "transcript.refresh", className: "rss-youtube-transcript-refresh", kind: "refresh" };
  }
}

function maxUsage(
  left: 0 | 1 | 2,
  right: 0 | 1 | 2,
): 0 | 1 | 2 {
  return Math.max(left, right) as 0 | 1 | 2;
}

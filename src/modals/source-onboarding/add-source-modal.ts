import { App, Modal } from "obsidian";
import { createTranslator, type Locale, type TranslationKey } from "../../i18n";
import type {
  VerifiedSubscriptionRequest,
} from "../../services/subscription-service";
import type { RssWebsiteVerification } from "../../services/source-verification/rss-website-discovery";
import type { VerificationFailureCode } from "../../services/source-verification/verification-state";
import { VerificationController } from "../../services/source-verification/verification-state";
import type { YouTubeChannelVerification } from "../../services/source-verification/youtube-channel-resolver";
import type { InitialImportPolicy } from "../../sources/initial-import-policy";
import type { VerifiedXProfile } from "../../sources/tikhub/x-profile-resolver";
import {
  renderInitialImportControl,
  type InitialImportControl,
  type SourceOnboardingKind,
} from "./initial-import-control";
import {
  projectRssWebsiteVerification,
  projectVerifiedXProfile,
  projectYouTubeVerification,
  renderVerificationCard,
  type VerifiedSourceSnapshot,
} from "./verification-card";

export interface AddSourceModalOptions {
  initialKind?: SourceOnboardingKind;
  initialInput?: string;
  initialFolder?: string;
  locale?: Locale;
  verifyRss: (
    input: string,
    signal: AbortSignal,
  ) => Promise<RssWebsiteVerification>;
  verifyYouTube: (
    input: string,
    signal: AbortSignal,
  ) => Promise<YouTubeChannelVerification>;
  verifyX: (input: string, signal: AbortSignal) => Promise<VerifiedXProfile>;
  onSubscribe: (request: VerifiedSubscriptionRequest) => Promise<boolean | void>;
  onSubscribed?: () => void;
  onOpenSettings: () => void;
  xRequestCaps?: Readonly<{ run: number; day: number }>;
  defaultAutoDeleteDuration?: number;
  defaultMaxItems?: number;
}

type ModalStage = "choose" | "identify" | "checking" | "confirmed" | "failed";

const FAILURE_KEYS: Readonly<Partial<Record<VerificationFailureCode, TranslationKey>>> = {
  "input-empty": "sourceOnboarding.failure.inputEmpty",
  "input-too-long": "sourceOnboarding.failure.inputTooLong",
  "input-unsafe": "sourceOnboarding.failure.inputUnsafe",
  "url-invalid": "sourceOnboarding.failure.invalidUrl",
  "url-not-http": "sourceOnboarding.failure.invalidUrl",
  "url-credentials": "sourceOnboarding.failure.invalidUrl",
  "x-unsupported-host": "sourceOnboarding.failure.xInvalid",
  "x-not-profile": "sourceOnboarding.failure.xInvalid",
  "x-invalid-handle": "sourceOnboarding.failure.xInvalid",
  "youtube-unsupported-host": "sourceOnboarding.failure.youtubeInvalid",
  "youtube-not-channel": "sourceOnboarding.failure.youtubeInvalid",
  "youtube-invalid-handle": "sourceOnboarding.failure.youtubeInvalid",
  "tikhub-disabled": "sourceOnboarding.failure.tikhubDisabled",
  "missing-key": "sourceOnboarding.failure.missingKey",
  "invalid-key": "sourceOnboarding.failure.invalidKey",
  "insufficient-balance": "sourceOnboarding.failure.insufficientBalance",
  "rate-limited": "sourceOnboarding.failure.rateLimited",
  "not-found": "sourceOnboarding.failure.notFound",
  "network-timeout": "sourceOnboarding.failure.timeout",
  "provider-failure": "sourceOnboarding.failure.provider",
  "network-request-failed": "sourceOnboarding.failure.network",
  "youtube-channel-not-found": "sourceOnboarding.failure.youtubeNotFound",
  "youtube-request-failed": "sourceOnboarding.failure.network",
  "youtube-feed-invalid": "sourceOnboarding.failure.feedInvalid",
  "feed-not-found": "sourceOnboarding.failure.feedNotFound",
};

export class AddSourceModal extends Modal {
  private readonly locale: Locale;
  private readonly t: ReturnType<typeof createTranslator>;
  private readonly verification = new VerificationController<VerifiedSourceSnapshot>();
  private lifecycle = new AbortController();
  private lifecycleEpoch = 0;
  private stage: ModalStage;
  private kind?: SourceOnboardingKind;
  private input: string;
  private verificationToken = 0;
  private rssCandidates?: RssWebsiteVerification;
  private importControl?: InitialImportControl;
  private includeReplies = false;
  private includeReposts = false;
  private subscribing = false;
  private folder: string;
  private tags: string[] = [];
  private historyConfirmation?: Modal;

  constructor(app: App, private readonly options: AddSourceModalOptions) {
    super(app);
    this.locale = options.locale ?? "zh-CN";
    this.t = createTranslator(this.locale);
    this.kind = options.initialKind;
    this.input = options.initialInput?.trim() ?? "";
    this.folder = options.initialFolder?.trim() ?? "";
    this.stage = this.kind ? "identify" : "choose";
  }

  onOpen(): void {
    this.lifecycleEpoch += 1;
    if (this.lifecycle.signal.aborted) {
      this.lifecycle = new AbortController();
    }
    this.modalEl.addClass(
      "rss-dashboard-modal",
      "rss-dashboard-modal-container",
      "rss-source-onboarding-modal",
    );
    this.render();
    if (this.kind) this.focusIdentityInput();
  }

  onClose(): void {
    this.lifecycleEpoch += 1;
    this.lifecycle.abort();
    this.verification.invalidate();
    this.verificationToken += 1;
    this.rssCandidates = undefined;
    this.historyConfirmation?.close();
    this.historyConfirmation = undefined;
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.dataset.stage = this.stage;
    this.contentEl.addClass("rss-source-onboarding-content");
    if (this.stage === "choose") {
      this.renderChoose();
      return;
    }
    if (this.stage === "checking") {
      this.renderChecking();
      return;
    }
    this.renderIdentify();
  }

  private renderChoose(): void {
    this.contentEl.createEl("h2", { text: this.t("sourceOnboarding.chooseTitle") });
    this.contentEl.createEl("p", { text: this.t("sourceOnboarding.chooseDesc") });
    const grid = this.contentEl.createDiv({ cls: "rss-source-kind-grid" });
    for (const kind of ["rss-website", "youtube", "x-account"] as const) {
      const button = grid.createEl("button", {
        cls: "rss-source-kind-card",
        attr: {
          type: "button",
          "data-source-kind": kind,
          "aria-label": this.t(kindKey(kind)),
        },
      });
      button.createEl("strong", { text: this.t(kindKey(kind)) });
      button.createDiv({ text: this.t(kindDescriptionKey(kind)) });
      button.addEventListener("click", () => {
        this.kind = kind;
        this.stage = "identify";
        this.render();
        this.focusIdentityInput();
      });
    }
  }

  private renderChecking(): void {
    this.renderHeader();
    this.contentEl.createDiv({
      cls: "rss-source-checking",
      attr: { role: "status", "aria-live": "polite" },
      text: this.t("sourceOnboarding.status.checking"),
    });
    this.renderCancelFooter();
  }

  private renderIdentify(): void {
    if (!this.kind) return;
    this.importControl = undefined;
    this.renderHeader();
    const body = this.contentEl.createDiv({ cls: "rss-source-onboarding-body" });
    const identityRow = body.createDiv({ cls: "rss-source-identity-row" });
    const label = identityRow.createEl("label", {
      cls: "rss-source-field-label",
      text: this.t(inputLabelKey(this.kind)),
    });
    const input = label.createEl("input", {
      type: "text",
      cls: "rss-source-identity-input",
      value: this.input,
      attr: {
        autocomplete: "off",
        spellcheck: "false",
        placeholder: this.t(inputPlaceholderKey(this.kind)),
      },
    });
    input.value = this.input;
    input.addEventListener("input", () => {
      const next = input.value;
      if (next === this.input) return;
      this.input = next;
      this.invalidateVisibleVerification();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.detect();
      } else if (event.key === "Escape") {
        this.close();
      }
    });

    const detect = identityRow.createEl("button", {
      cls: "rss-source-detect-button",
      text: this.t("sourceOnboarding.detect"),
      attr: { type: "button" },
    });
    detect.disabled = !this.input.trim();
    detect.addEventListener("click", () => void this.detect());

    const feedback = body.createDiv({
      cls: "rss-source-feedback",
      attr: { "aria-live": "polite" },
    });
    this.renderVerificationResult(body, feedback);
    if (this.canConfigureSubscription()) {
      this.renderSourceOptions(body);
      this.importControl = renderInitialImportControl(body, {
        locale: this.locale,
        sourceKind: this.kind,
        onChange: () => this.updateSubscribeButton(),
      });
      this.renderAdvancedSettings(body);
      this.renderFooter();
    }
  }

  private renderHeader(): void {
    const header = this.contentEl.createDiv({ cls: "rss-source-onboarding-header" });
    const back = header.createEl("button", {
      cls: "rss-source-back-button",
      text: this.t("sourceOnboarding.back"),
      attr: { type: "button", "aria-label": this.t("sourceOnboarding.back") },
    });
    back.addEventListener("click", () => {
      this.verification.invalidate();
      this.verificationToken += 1;
      this.rssCandidates = undefined;
      this.kind = undefined;
      this.input = "";
      this.stage = "choose";
      this.render();
    });
    header.createEl("h2", { text: this.t(titleKey(this.kind)) });
  }

  private renderVerificationResult(body: HTMLElement, feedback: HTMLElement): void {
    const state = this.verification.snapshot();
    if (state.status === "failure") {
      feedback.addClass("is-error");
      feedback.setText(this.t(FAILURE_KEYS[state.code] ?? "sourceOnboarding.failure.unknown"));
      if (["missing-key", "invalid-key", "tikhub-disabled"].includes(state.code)) {
        const settings = feedback.createEl("button", {
          cls: "rss-source-open-settings-button",
          text: this.t("sourceOnboarding.openSettings"),
          attr: { type: "button" },
        });
        settings.addEventListener("click", this.options.onOpenSettings);
      }
      return;
    }
    if (this.rssCandidates && !this.rssCandidates.selected) {
      feedback.setText(this.t("sourceOnboarding.rss.chooseCandidate"));
      this.renderRssCandidates(body, this.rssCandidates);
      return;
    }
    if (state.status !== "success" && state.status !== "warning") return;
    renderVerificationCard(body, state.value, this.locale);
    if (state.status === "warning" && state.code === "empty-feed") {
      const warning = body.createEl("label", { cls: "rss-source-empty-warning" });
      const checkbox = warning.createEl("input", { type: "checkbox" });
      checkbox.checked = state.accepted;
      warning.createSpan({ text: this.t("sourceOnboarding.rss.emptyWarning") });
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          this.verification.acceptWarning(this.verificationToken);
        } else {
          const current = this.verification.snapshot();
          if (current.status === "warning" && current.code === "empty-feed") {
            this.verification.invalidate();
            this.verificationToken = this.verification.begin(this.input);
            this.verification.warn(
              this.verificationToken,
              current.value,
              "empty-feed",
            );
          }
        }
        this.render();
      });
    }
  }

  private renderRssCandidates(body: HTMLElement, verification: RssWebsiteVerification): void {
    const list = body.createDiv({
      cls: "rss-source-candidate-list",
      attr: { role: "radiogroup", "aria-label": this.t("sourceOnboarding.rss.chooseCandidate") },
    });
    for (const candidate of verification.candidates) {
      const label = list.createEl("label", { cls: "rss-source-candidate-option" });
      const radio = label.createEl("input", {
        type: "radio",
        attr: { name: "rss-source-candidate", value: candidate.url },
      });
      label.createSpan({ text: candidate.title });
      label.createDiv({ text: candidate.url });
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        void this.verifySelectedRssCandidate(candidate.url);
      });
    }
  }

  private renderSourceOptions(body: HTMLElement): void {
    if (this.kind !== "x-account") return;
    const options = body.createDiv({ cls: "rss-source-x-options" });
    this.renderCheckboxOption(
      options,
      "include-replies",
      "sourceOnboarding.x.includeReplies",
      this.includeReplies,
      (checked) => { this.includeReplies = checked; },
    );
    this.renderCheckboxOption(
      options,
      "include-reposts",
      "sourceOnboarding.x.includeReposts",
      this.includeReposts,
      (checked) => { this.includeReposts = checked; },
    );
  }

  private renderCheckboxOption(
    container: HTMLElement,
    option: string,
    key: TranslationKey,
    checked: boolean,
    update: (checked: boolean) => void,
  ): void {
    const label = container.createEl("label", { cls: "rss-source-checkbox-option" });
    const input = label.createEl("input", {
      type: "checkbox",
      attr: { "data-option": option },
    });
    input.checked = checked;
    label.createSpan({ text: this.t(key) });
    input.addEventListener("change", () => update(input.checked));
  }

  private renderAdvancedSettings(body: HTMLElement): void {
    const details = body.createEl("details", { cls: "rss-source-advanced" });
    details.createEl("summary", { text: this.t("sourceOnboarding.advanced") });
    const fields = details.createDiv({ cls: "rss-source-advanced-fields" });
    const folder = fields.createEl("label", {
      cls: "rss-source-field-label",
      text: this.t("sourceOnboarding.folder"),
    });
    const folderInput = folder.createEl("input", { type: "text", value: this.folder });
    folderInput.value = this.folder;
    folderInput.addEventListener("input", () => { this.folder = folderInput.value; });
    const tags = fields.createEl("label", {
      cls: "rss-source-field-label",
      text: this.t("sourceOnboarding.tags"),
    });
    const tagInput = tags.createEl("input", {
      type: "text",
      value: this.tags.join(", "),
    });
    tagInput.value = this.tags.join(", ");
    tagInput.addEventListener("input", () => {
      this.tags = tagInput.value.split(",").map((tag) => tag.trim()).filter(Boolean);
    });
  }

  private renderFooter(): void {
    const footer = this.contentEl.createDiv({ cls: "rss-source-onboarding-footer" });
    const cancel = footer.createEl("button", {
      text: this.t("common.cancel"),
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => this.close());
    const subscribe = footer.createEl("button", {
      cls: "rss-source-subscribe-button mod-cta",
      text: this.t("sourceOnboarding.subscribe"),
      attr: { type: "button" },
    });
    subscribe.disabled = !this.canSubscribe();
    subscribe.addEventListener("click", () => void this.subscribe());
  }

  private renderCancelFooter(): void {
    const footer = this.contentEl.createDiv({ cls: "rss-source-onboarding-footer" });
    const cancel = footer.createEl("button", {
      text: this.t("common.cancel"),
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => this.close());
  }

  private async detect(): Promise<void> {
    if (!this.kind || !this.input.trim() || this.stage === "checking") return;
    const kind = this.kind;
    const input = this.input.trim();
    const epoch = this.lifecycleEpoch;
    this.rssCandidates = undefined;
    this.verificationToken = this.verification.begin(input);
    const token = this.verificationToken;
    this.stage = "checking";
    this.render();

    try {
      if (kind === "rss-website") {
        const value = projectRssWebsiteVerification(
          await this.options.verifyRss(input, this.lifecycle.signal),
        );
        if (!this.isCurrent(epoch, token)) return;
        if (value.candidates.length === 0) {
          this.verification.fail(token, "feed-not-found");
        } else if (!value.selected) {
          this.rssCandidates = value;
          this.verification.warn(token, Object.freeze({
            kind,
            verification: value,
          }), "feed-selection-required");
        } else {
          const snapshot = Object.freeze({
            kind,
            verification: value,
            selectedCandidateUrl: value.selected.url,
          });
          if (value.hasEntries) this.verification.succeed(token, snapshot);
          else this.verification.warn(token, snapshot, "empty-feed");
        }
      } else if (kind === "youtube") {
        const value = projectYouTubeVerification(
          await this.options.verifyYouTube(input, this.lifecycle.signal),
        );
        if (!this.isCurrent(epoch, token)) return;
        const snapshot = Object.freeze({ kind, verification: value });
        if (value.hasEntries) this.verification.succeed(token, snapshot);
        else this.verification.warn(token, snapshot, "empty-feed");
      } else {
        const value = projectVerifiedXProfile(
          await this.options.verifyX(input, this.lifecycle.signal),
        );
        if (!this.isCurrent(epoch, token)) return;
        this.verification.succeed(token, Object.freeze({ kind, verification: value }));
      }
    } catch (error) {
      if (!this.isCurrent(epoch, token)) return;
      this.verification.fail(token, failureCode(error, kind));
    }
    if (!this.isCurrent(epoch, token)) return;
    this.stage = this.verification.snapshot().status === "failure"
      ? "failed"
      : "confirmed";
    this.render();
  }

  private async verifySelectedRssCandidate(candidateUrl: string): Promise<void> {
    const epoch = this.lifecycleEpoch;
    this.rssCandidates = undefined;
    this.verification.invalidate();
    this.verificationToken = this.verification.begin(candidateUrl);
    const token = this.verificationToken;
    this.stage = "checking";
    this.render();
    try {
      const value = projectRssWebsiteVerification(
        await this.options.verifyRss(candidateUrl, this.lifecycle.signal),
      );
      if (!this.isCurrent(epoch, token)) return;
      const selected = value.selected ??
        (value.candidates.length === 1
          ? value.candidates[0]
          : value.candidates.find((candidate) => candidate.url === candidateUrl));
      if (!selected) {
        this.verification.fail(token, "feed-not-found");
      } else {
        const selectedVerification = value.selected
          ? value
          : projectRssWebsiteVerification({ ...value, selected });
        const snapshot = Object.freeze({
          kind: "rss-website" as const,
          verification: selectedVerification,
          selectedCandidateUrl: selected.url,
        });
        if (selectedVerification.hasEntries) {
          this.verification.succeed(token, snapshot);
        } else {
          this.verification.warn(token, snapshot, "empty-feed");
        }
      }
    } catch (error) {
      if (!this.isCurrent(epoch, token)) return;
      this.verification.fail(token, failureCode(error, "rss-website"));
    }
    if (!this.isCurrent(epoch, token)) return;
    this.stage = this.verification.snapshot().status === "failure"
      ? "failed"
      : "confirmed";
    this.render();
  }

  private isCurrent(epoch: number, token: number): boolean {
    return epoch === this.lifecycleEpoch && token === this.verificationToken && !this.lifecycle.signal.aborted;
  }

  private invalidateVisibleVerification(): void {
    this.verification.invalidate();
    this.verificationToken += 1;
    this.rssCandidates = undefined;
    this.stage = "identify";
    this.contentEl.dataset.stage = "identify";
    this.contentEl.querySelector(".rss-source-verification-card")?.remove();
    this.contentEl.querySelector(".rss-source-candidate-list")?.remove();
    this.contentEl.querySelector(".rss-source-empty-warning")?.remove();
    this.contentEl.querySelector(".rss-source-x-options")?.remove();
    this.contentEl.querySelector(".rss-source-initial-import")?.remove();
    this.contentEl.querySelector(".rss-source-advanced")?.remove();
    this.contentEl.querySelector(".rss-source-onboarding-footer")?.remove();
    this.importControl = undefined;
    const feedback = this.contentEl.querySelector<HTMLElement>(".rss-source-feedback");
    feedback?.empty();
    this.updateSubscribeButton();
    const detect = this.contentEl.querySelector<HTMLButtonElement>(".rss-source-detect-button");
    if (detect) detect.disabled = !this.input.trim();
  }

  private updateSubscribeButton(): void {
    const button = this.contentEl.querySelector<HTMLButtonElement>(".rss-source-subscribe-button");
    if (button) button.disabled = !this.canSubscribe();
  }

  private canSubscribe(): boolean {
    return !this.subscribing && this.verification.canSubscribe() && this.importControl?.getPolicy() !== undefined;
  }

  private canConfigureSubscription(): boolean {
    const state = this.verification.snapshot();
    return state.status === "success" || (
      state.status === "warning" &&
      state.code === "empty-feed" &&
      state.accepted
    );
  }

  private async subscribe(): Promise<void> {
    const policy = this.importControl?.getPolicy();
    const state = this.verification.snapshot();
    if (!policy || !this.verification.canSubscribe() ||
      (state.status !== "success" && state.status !== "warning")) return;
    if (state.value.kind === "x-account" && policy.mode === "all-available") {
      this.openAllHistoryConfirmation();
      return;
    }
    await this.submitSnapshot(state.value, policy, false);
  }

  private openAllHistoryConfirmation(): void {
    if (this.historyConfirmation) return;
    const caps = this.options.xRequestCaps ?? { run: 40, day: 100 };
    const confirm = new Modal(this.app);
    this.historyConfirmation = confirm;
    confirm.onClose = () => {
      if (this.historyConfirmation === confirm) {
        this.historyConfirmation = undefined;
      }
      confirm.contentEl.empty();
    };
    confirm.modalEl.addClass(
      "rss-source-onboarding-modal",
      "rss-source-history-confirm-modal",
    );
    confirm.contentEl.createEl("h2", { text: this.t("sourceOnboarding.x.historyConfirmTitle") });
    confirm.contentEl.createEl("p", { text: this.t("sourceOnboarding.x.historyConfirmDesc") });
    confirm.contentEl.createEl("p", {
      text: this.t("sourceOnboarding.x.requestCaps", { run: caps.run, day: caps.day }),
    });
    const footer = confirm.contentEl.createDiv({ cls: "rss-source-onboarding-footer" });
    const cancel = footer.createEl("button", { text: this.t("common.cancel") });
    cancel.addEventListener("click", () => confirm.close());
    const accept = footer.createEl("button", {
      cls: "rss-source-history-confirm-button mod-warning",
      text: this.t("sourceOnboarding.x.confirmPaidHistory"),
    });
    accept.addEventListener("click", () => {
      const state = this.verification.snapshot();
      const policy = this.importControl?.getPolicy();
      if ((state.status === "success" || state.status === "warning") &&
        state.value.kind === "x-account" && policy?.mode === "all-available") {
        confirm.close();
        void this.submitSnapshot(state.value, policy, true);
      }
    });
    confirm.open();
  }

  private async submitSnapshot(
    snapshot: VerifiedSourceSnapshot,
    policy: InitialImportPolicy,
    confirmedAllAvailable: boolean,
  ): Promise<void> {
    if (this.subscribing) return;
    this.subscribing = true;
    this.updateSubscribeButton();
    const common = {
      folder: this.folder,
      tags: [...this.tags],
      initialImportPolicy: policy,
      autoDeleteDuration: this.options.defaultAutoDeleteDuration,
      maxItemsLimit: this.options.defaultMaxItems,
    };
    let request: VerifiedSubscriptionRequest;
    if (snapshot.kind === "rss-website") {
      const selectedCandidateUrl = snapshot.selectedCandidateUrl ?? snapshot.verification.selected?.url;
      if (!selectedCandidateUrl) {
        this.subscribing = false;
        this.updateSubscribeButton();
        return;
      }
      request = {
        kind: snapshot.kind,
        verification: snapshot.verification,
        selectedCandidateUrl,
        displayName: snapshot.verification.selected?.title,
        acceptedEmptyFeedWarning: !snapshot.verification.hasEntries,
        ...common,
      };
    } else if (snapshot.kind === "youtube") {
      request = {
        kind: snapshot.kind,
        verification: snapshot.verification,
        displayName: snapshot.verification.channelName,
        mediaType: "video",
        acceptedEmptyFeedWarning: !snapshot.verification.hasEntries,
        ...common,
      };
    } else {
      request = {
        kind: snapshot.kind,
        profile: snapshot.verification.profile,
        verificationProof: snapshot.verification.proof,
        displayName: snapshot.verification.profile.displayName,
        includeReplies: this.includeReplies,
        includeReposts: this.includeReposts,
        ...(confirmedAllAvailable ? { confirmedAllAvailable: true } : {}),
        ...common,
      };
    }
    try {
      const result = await this.options.onSubscribe(request);
      if (result !== false) {
        try {
          this.options.onSubscribed?.();
        } catch {
          console.error(
            "[RSS Dashboard] Subscription owner refresh callback failed.",
          );
        }
        this.close();
      } else {
        this.showSubscribeFailure();
      }
    } catch {
      this.showSubscribeFailure();
    } finally {
      this.subscribing = false;
      this.updateSubscribeButton();
    }
  }

  private showSubscribeFailure(): void {
    const feedback = this.contentEl.querySelector<HTMLElement>(".rss-source-feedback");
    if (!feedback) return;
    feedback.addClass("is-error");
    feedback.setText(this.t("sourceOnboarding.failure.subscribe"));
  }

  private focusIdentityInput(): void {
    window.setTimeout(() => {
      this.contentEl.querySelector<HTMLInputElement>(".rss-source-identity-input")?.focus();
    }, 0);
  }
}

function kindKey(kind: SourceOnboardingKind): TranslationKey {
  return kind === "rss-website"
    ? "sourceOnboarding.kind.rss"
    : kind === "youtube"
      ? "sourceOnboarding.kind.youtube"
      : "sourceOnboarding.kind.x";
}

function kindDescriptionKey(kind: SourceOnboardingKind): TranslationKey {
  return kind === "rss-website"
    ? "sourceOnboarding.kind.rssDesc"
    : kind === "youtube"
      ? "sourceOnboarding.kind.youtubeDesc"
      : "sourceOnboarding.kind.xDesc";
}

function titleKey(kind: SourceOnboardingKind | undefined): TranslationKey {
  return kind === "rss-website"
    ? "sourceOnboarding.title.rss"
    : kind === "youtube"
      ? "sourceOnboarding.title.youtube"
      : "sourceOnboarding.title.x";
}

function inputLabelKey(kind: SourceOnboardingKind): TranslationKey {
  return kind === "rss-website"
    ? "sourceOnboarding.input.rss"
    : kind === "youtube"
      ? "sourceOnboarding.input.youtube"
      : "sourceOnboarding.input.x";
}

function inputPlaceholderKey(kind: SourceOnboardingKind): TranslationKey {
  return kind === "rss-website"
    ? "sourceOnboarding.placeholder.rss"
    : kind === "youtube"
      ? "sourceOnboarding.placeholder.youtube"
      : "sourceOnboarding.placeholder.x";
}

function failureCode(error: unknown, kind: SourceOnboardingKind): VerificationFailureCode {
  if (typeof error === "object" && error !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    if (descriptor && "value" in descriptor &&
      typeof descriptor.value === "string" &&
      Object.prototype.hasOwnProperty.call(FAILURE_KEYS, descriptor.value)) {
      return descriptor.value as VerificationFailureCode;
    }
  }
  return kind === "youtube"
    ? "youtube-request-failed"
    : kind === "x-account"
      ? "provider-failure"
      : "network-request-failed";
}

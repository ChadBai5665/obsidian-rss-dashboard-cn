import { createTranslator, type Locale } from "../../i18n";
import type { RssWebsiteVerification } from "../../services/source-verification/rss-website-discovery";
import type { YouTubeChannelVerification } from "../../services/source-verification/youtube-channel-resolver";
import type { VerifiedXProfile } from "../../sources/tikhub/x-profile-resolver";
import type { SourceOnboardingKind } from "./initial-import-control";

export type VerifiedSourceSnapshot =
  | Readonly<{ kind: "rss-website"; verification: RssWebsiteVerification; selectedCandidateUrl?: string }>
  | Readonly<{ kind: "youtube"; verification: YouTubeChannelVerification }>
  | Readonly<{ kind: "x-account"; verification: VerifiedXProfile }>;

export function renderVerificationCard(
  container: HTMLElement,
  snapshot: VerifiedSourceSnapshot,
  locale: Locale = "zh-CN",
): HTMLElement {
  const t = createTranslator(locale);
  const card = container.createDiv({
    cls: "rss-source-verification-card",
    attr: { "aria-live": "polite", role: "status" },
  });
  card.createDiv({
    cls: "rss-source-verification-success",
    text: t("sourceOnboarding.status.success"),
  });

  if (snapshot.kind === "x-account") {
    const profile = snapshot.verification.profile;
    const identity = card.createDiv({ cls: "rss-source-profile" });
    if (profile.avatarUrl) {
      identity.createEl("img", {
        cls: "rss-source-profile-avatar",
        attr: { src: profile.avatarUrl, alt: "" },
      });
    }
    const text = identity.createDiv({ cls: "rss-source-profile-text" });
    text.createEl("strong", { text: profile.displayName });
    text.createDiv({ text: `@${profile.handle}` });
    if (profile.description) text.createDiv({ text: profile.description });
    return card;
  }

  const verification = snapshot.verification;
  let title: string;
  let url: string;
  if (snapshot.kind === "youtube") {
    title = snapshot.verification.channelName;
    url = snapshot.verification.feedUrl;
  } else {
    title = snapshot.verification.selected?.title || snapshot.verification.candidates.find(
      (candidate) => candidate.url === snapshot.selectedCandidateUrl,
    )?.title || snapshot.verification.siteUrl;
    url = snapshot.selectedCandidateUrl || snapshot.verification.selected?.url ||
      snapshot.verification.siteUrl;
  }
  card.createEl("strong", { text: title });
  card.createDiv({ cls: "rss-source-verified-url", text: url });
  if (verification.latestTitle) {
    card.createDiv({
      cls: "rss-source-latest-entry",
      text: t("sourceOnboarding.status.latest", { title: verification.latestTitle }),
    });
  }
  return card;
}

export function sourceKindLabel(kind: SourceOnboardingKind, locale: Locale): string {
  const t = createTranslator(locale);
  return t(kind === "rss-website"
    ? "sourceOnboarding.kind.rss"
    : kind === "youtube"
      ? "sourceOnboarding.kind.youtube"
      : "sourceOnboarding.kind.x");
}

import { createTranslator, type Locale } from "../../i18n";
import type { RssWebsiteVerification } from "../../services/source-verification/rss-website-discovery";
import type { YouTubeChannelVerification } from "../../services/source-verification/youtube-channel-resolver";
import type { VerifiedXProfile } from "../../sources/tikhub/x-profile-resolver";
import type { SourceOnboardingKind } from "./initial-import-control";

export type VerifiedSourceSnapshot =
  | Readonly<{ kind: "rss-website"; verification: RssWebsiteVerification; selectedCandidateUrl?: string }>
  | Readonly<{ kind: "youtube"; verification: YouTubeChannelVerification }>
  | Readonly<{ kind: "x-account"; verification: VerifiedXProfile }>;

export function projectRssWebsiteVerification(
  value: RssWebsiteVerification,
): RssWebsiteVerification {
  const candidates = value.candidates.map((candidate) => Object.freeze({
    url: candidate.url,
    title: candidate.title,
    format: candidate.format,
  }));
  Object.freeze(candidates);
  const selected = value.selected
    ? Object.freeze({
        url: value.selected.url,
        title: value.selected.title,
        format: value.selected.format,
      })
    : undefined;
  return Object.freeze({
    inputUrl: value.inputUrl,
    siteUrl: value.siteUrl,
    candidates,
    ...(selected ? { selected } : {}),
    ...(value.latestTitle ? { latestTitle: value.latestTitle } : {}),
    ...(value.latestPubDate ? { latestPubDate: value.latestPubDate } : {}),
    hasEntries: value.hasEntries,
  });
}

export function projectYouTubeVerification(
  value: YouTubeChannelVerification,
): YouTubeChannelVerification {
  return Object.freeze({
    channelId: value.channelId,
    channelName: value.channelName,
    channelUrl: value.channelUrl,
    feedUrl: value.feedUrl,
    ...(value.latestTitle ? { latestTitle: value.latestTitle } : {}),
    ...(value.latestPubDate ? { latestPubDate: value.latestPubDate } : {}),
    hasEntries: value.hasEntries,
  });
}

export function projectVerifiedXProfile(value: VerifiedXProfile): VerifiedXProfile {
  return Object.freeze({
    profile: Object.freeze({
      restId: value.profile.restId,
      handle: value.profile.handle,
      displayName: value.profile.displayName,
      ...(value.profile.avatarUrl ? { avatarUrl: value.profile.avatarUrl } : {}),
      ...(value.profile.description ? { description: value.profile.description } : {}),
      verified: value.profile.verified,
    }),
    // The proof is an opaque, process-local capability and is frozen when minted.
    // Preserve its identity so the subscription service can validate it.
    proof: value.proof,
  });
}

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
    card.createDiv({
      cls: "rss-source-verification-meta",
      text: t("sourceOnboarding.status.xAvailable"),
    });
    card.createDiv({
      cls: "rss-source-verification-meta",
      text: t(profile.verified
        ? "sourceOnboarding.status.xVerified"
        : "sourceOnboarding.status.xNotVerified"),
    });
    return card;
  }

  const verification = snapshot.verification;
  let title: string;
  let url: string;
  if (snapshot.kind === "youtube") {
    title = snapshot.verification.channelName;
    url = snapshot.verification.channelUrl;
  } else {
    title = snapshot.verification.selected?.title || snapshot.verification.candidates.find(
      (candidate) => candidate.url === snapshot.selectedCandidateUrl,
    )?.title || snapshot.verification.siteUrl;
    url = snapshot.selectedCandidateUrl || snapshot.verification.selected?.url ||
      snapshot.verification.siteUrl;
  }
  card.createDiv({
    cls: "rss-source-verification-meta",
    text: t("sourceOnboarding.status.sourceType", {
      type: t(snapshot.kind === "youtube"
        ? "sourceOnboarding.status.type.youtube"
        : "sourceOnboarding.status.type.rss"),
    }),
  });
  card.createEl("strong", { text: title });
  card.createDiv({ cls: "rss-source-verified-url", text: url });
  if (verification.latestTitle) {
    card.createDiv({
      cls: "rss-source-latest-entry",
      text: t("sourceOnboarding.status.latest", { title: verification.latestTitle }),
    });
  }
  if (verification.latestPubDate) {
    card.createDiv({
      cls: "rss-source-latest-pub-date",
      text: t("sourceOnboarding.status.latestPubDate", {
        date: verification.latestPubDate,
      }),
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

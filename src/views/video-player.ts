import { Notice, Setting, setIcon } from "obsidian";
import { FeedItem } from "../types/types";
import { MediaService } from "../services/media-service";
import { createTranslator, type Locale } from "../i18n";

interface YouTubeMessagePayload {
  id?: string | number;
  event?: string;
  info?: unknown;
}

export class VideoPlayer {
  private container: HTMLElement;
  private currentItem: FeedItem | null = null;
  private playerEl: HTMLElement | null = null;
  private iframeEl: HTMLIFrameElement | null = null;
  private progressInterval: number | null = null;
  private lastTrackedPosition: number | null = null;
  private progressTrackingEnabled: boolean;
  private onVideoSelect?: (item: FeedItem) => void;
  private onPlaybackProgress?: (
    item: FeedItem,
    position: number,
    duration: number,
    flush?: boolean,
  ) => void;
  private relatedVideos: FeedItem[] = [];
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private playStartTime: number | null = null;
  private videoDuration: number | null = null;
  private locale: Locale;

  private t(key: Parameters<ReturnType<typeof createTranslator>>[0], params?: Record<string, string | number>): string {
    return createTranslator(this.locale)(key, params);
  }

  constructor(
    container: HTMLElement,
    onVideoSelect?: (item: FeedItem) => void,
    onPlaybackProgress?: (
      item: FeedItem,
      position: number,
      duration: number,
      flush?: boolean,
    ) => void,
    progressTrackingEnabled = true,
    locale: Locale = "zh-CN",
  ) {
    this.container = container;
    this.onVideoSelect = onVideoSelect;
    this.onPlaybackProgress = onPlaybackProgress;
    this.progressTrackingEnabled = progressTrackingEnabled;
    this.locale = locale;
    this.setupMessageListener();
  }

  loadVideo(item: FeedItem): void {
    if (!item.videoId) {
      new Notice(this.t("video.noId"));
      console.debug("[Stub Notice]", "No video ID provided");
      return;
    }

    try {
      this.currentItem = item;
      this.lastTrackedPosition = item.playbackProgress?.position ?? null;
      this.render();
    } catch (error) {
      console.error("[RSS Dashboard] Video player failed to render:", error);
      const msg = this.t("video.loadError");
      new Notice(msg);
      console.debug("[Stub Notice]", msg);
    }
  }

  /** Update localized links/headings without recreating the YouTube iframe. */
  public refreshLocalization(locale: Locale): void {
    this.locale = locale;
    this.playerEl
      ?.querySelector<HTMLElement>(".rss-video-youtube-button span:last-child")
      ?.setText(this.t("video.watch"));
    this.playerEl
      ?.querySelector<HTMLElement>(".rss-video-tos-link")
      ?.setText(this.t("settings.media.youtubeTos"));
    this.renderRelatedVideos();
  }

  private render(): void {
    if (!this.currentItem || !this.currentItem.videoId) return;
    const embed = MediaService.buildYouTubeEmbed(this.currentItem.videoId);

    this.container.empty();
    this.playerEl = this.container.createDiv({ cls: "rss-video-player" });

    const videoContainer = this.playerEl.createDiv({
      cls: "rss-video-container",
    });
    const iframeId = `yt-player-${Math.random().toString(36).substring(2, 11)}`;

    this.iframeEl = activeDocument.createElement("iframe");
    this.iframeEl.id = iframeId;
    this.iframeEl.src = `${embed.embedUrl}&id=${iframeId}`;
    this.iframeEl.setAttribute("allow", embed.allow);
    this.iframeEl.setAttribute("referrerpolicy", embed.referrerPolicy);
    this.iframeEl.allowFullscreen = true;

    videoContainer.appendChild(this.iframeEl);

    this.initPlayer(iframeId);

    const details = this.playerEl.createDiv({ cls: "rss-video-details" });
    const titleSetting = new Setting(details)
      .setName(this.currentItem.title)
      .setHeading();
    titleSetting.settingEl.addClass("rss-video-title");

    const metaContainer = details.createDiv({ cls: "rss-video-meta" });
    metaContainer.createDiv({
      cls: "rss-video-channel",
      text: this.currentItem.feedTitle,
    });
    metaContainer.createDiv({
      cls: "rss-video-date",
      text: new Date(this.currentItem.pubDate).toLocaleDateString(),
    });

    if (this.currentItem.description) {
      const descriptionContainer = details.createDiv({
        cls: "rss-video-description",
      });
      const sanitizeAndAppend = (html: string, target: HTMLElement): void => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        doc.querySelectorAll("script").forEach((s) => s.remove());
        doc.querySelectorAll("a").forEach((link) => {
          link.target = "_blank";
          link.rel = "noopener noreferrer";
        });
        const fragment = activeDocument.createDocumentFragment();
        while (doc.body.firstChild) {
          fragment.appendChild(doc.body.firstChild);
        }
        target.appendChild(fragment);
      };
      sanitizeAndAppend(this.currentItem.description, descriptionContainer);
    }

    const linksContainer = this.playerEl.createDiv({ cls: "rss-video-links" });
    const youtubeButton = linksContainer.createEl("a", {
      cls: "rss-video-youtube-button",
      href: embed.watchUrl,
    });
    youtubeButton.target = "_blank";
    youtubeButton.rel = "noopener noreferrer";
    const youtubeIcon = youtubeButton.createSpan({
      cls: "rss-video-youtube-button-icon",
    });
    setIcon(youtubeIcon, "youtube");
    youtubeButton.createSpan({ text: this.t("video.watch") });

    const tosLink = linksContainer.createEl("a", {
      cls: "rss-video-tos-link",
      href: "https://www.youtube.com/t/terms",
      text: this.t("settings.media.youtubeTos"),
    });
    tosLink.target = "_blank";
    tosLink.rel = "noopener noreferrer";

    this.playerEl.createDiv({ cls: "rss-video-related" });
    this.renderRelatedVideos();
  }

  private sendCommand(func: string, args: unknown[] = []): void {
    if (!this.iframeEl || !this.iframeEl.contentWindow) return;
    try {
      const message = JSON.stringify({
        event: "command",
        func: func,
        args: args,
        id: this.iframeEl.id,
      });
      const url = new URL(this.iframeEl.src);
      this.iframeEl.contentWindow.postMessage(message, url.origin);
    } catch {
      // Ignore errors
    }
  }

  private setupMessageListener(): void {
    this.messageHandler = (event: MessageEvent) => {
      if (
        event.origin !== "https://www.youtube.com" &&
        event.origin !== "https://www.youtube-nocookie.com"
      ) {
        return;
      }

      try {
        let parsedData: unknown;
        if (typeof event.data === "string") {
          parsedData = JSON.parse(event.data);
        } else {
          parsedData = event.data;
        }

        if (!parsedData || typeof parsedData !== "object") return;
        const payload = parsedData as YouTubeMessagePayload;

        // Verify it belongs to this player's iframe
        if (
          payload.id !== undefined &&
          String(payload.id) !== this.iframeEl?.id
        ) {
          return;
        }

        if (payload.event === "onReady") {
          this.handlePlayerReady();
        } else if (payload.event === "onStateChange") {
          if (typeof payload.info === "number") {
            this.handleStateChange(payload.info);
          }
        } else if (
          payload.event === "infoDelivery" &&
          payload.info &&
          typeof payload.info === "object"
        ) {
          const info = payload.info as Record<string, unknown>;
          if (typeof info.duration === "number") {
            this.videoDuration = info.duration;
          }
          if (typeof info.currentTime === "number") {
            this.lastTrackedPosition = info.currentTime;
            if (this.playStartTime !== null) {
              this.playStartTime = Date.now();
            }
          }
          if (typeof info.playerState === "number") {
            this.handleStateChange(info.playerState);
          }
        }
      } catch {
        // Parse/JSON error
      }
    };

    window.addEventListener("message", this.messageHandler);
  }

  private handlePlayerReady(): void {
    if (
      this.progressTrackingEnabled &&
      this.currentItem?.playbackProgress?.position
    ) {
      this.sendCommand("seekTo", [
        this.currentItem.playbackProgress.position,
        true,
      ]);
    }
  }

  private initPlayer(_iframeId: string): void {
    this.playStartTime = null;
    this.videoDuration = null;

    if (
      this.progressTrackingEnabled &&
      this.currentItem?.playbackProgress?.position
    ) {
      window.setTimeout(() => {
        this.sendCommand("seekTo", [
          this.currentItem!.playbackProgress!.position,
          true,
        ]);
      }, 1000);
    }
  }

  private handleStateChange(state: number): void {
    if (state === 1) {
      // PLAYING
      if (this.playStartTime === null) {
        this.playStartTime = Date.now();
      }
      this.startTracking();
      return;
    }

    if (state === 2 || state === 0) {
      // PAUSED or ENDED
      this.saveProgress(true);
      this.stopTracking();
      this.playStartTime = null;
    }
  }

  private startTracking(): void {
    if (!this.progressTrackingEnabled) return;
    if (this.progressInterval) return;
    this.progressInterval = window.setInterval(() => {
      this.saveProgress();
    }, 5000);
  }

  private stopTracking(): void {
    if (this.progressInterval) {
      window.clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
  }

  private saveProgress(flush = false): void {
    if (!this.progressTrackingEnabled) return;
    if (!this.currentItem || !this.onPlaybackProgress) return;

    try {
      let position = this.lastTrackedPosition ?? 0;
      if (this.playStartTime !== null) {
        const elapsed = (Date.now() - this.playStartTime) / 1000;
        position += elapsed;
      }

      const duration =
        this.videoDuration ?? this.currentItem.playbackProgress?.duration ?? 0;

      if (!(position >= 0) || !(duration > 0)) {
        return;
      }

      if (
        !flush &&
        this.lastTrackedPosition !== null &&
        Math.abs(position - this.lastTrackedPosition) < 1
      ) {
        return;
      }

      this.lastTrackedPosition = position;
      if (this.playStartTime !== null) {
        this.playStartTime = Date.now();
      }

      this.onPlaybackProgress(this.currentItem, position, duration, flush);
    } catch {
      // Player might not be ready or detached
    }
  }

  private flushProgress(): void {
    this.saveProgress(true);
  }

  setRelatedVideos(videos: FeedItem[]): void {
    this.relatedVideos = videos;
    this.renderRelatedVideos();
  }

  private renderRelatedVideos(): void {
    const relatedContainer = this.playerEl?.querySelector(".rss-video-related");
    if (!relatedContainer || !this.currentItem) return;

    relatedContainer.empty();

    const filtered = this.relatedVideos
      .filter(
        (v) =>
          this.currentItem &&
          v.guid !== this.currentItem.guid &&
          v.videoId &&
          v.feedUrl === this.currentItem.feedUrl,
      )
      .slice(0, 5);

    relatedContainer.createEl("h4", { text: this.t("video.related") });

    if (filtered.length > 0) {
      const relatedList = relatedContainer.createDiv({
        cls: "rss-video-related-list",
      });
      filtered.forEach((video) => {
        const videoItem = relatedList.createDiv({
          cls: "rss-video-related-item",
        });

        if (video.videoId) {
          const thumbnail = videoItem.createDiv({
            cls: "rss-video-related-thumbnail",
          });
          thumbnail.createEl("img", {
            attr: {
              src: `https://img.youtube.com/vi/${video.videoId}/mqdefault.jpg`,
              alt: video.title,
            },
          });
        }

        const videoInfo = videoItem.createDiv({
          cls: "rss-video-related-info",
        });
        videoInfo.createDiv({
          cls: "rss-video-related-title",
          text: video.title,
        });
        videoInfo.createDiv({
          cls: "rss-video-related-date",
          text: new Date(video.pubDate).toLocaleDateString(),
        });

        videoItem.addEventListener("click", () => {
          if (this.onVideoSelect) {
            this.onVideoSelect(video);
          } else {
            this.loadVideo(video);
          }
        });
      });
    } else {
      relatedContainer.createDiv({
        cls: "rss-video-related-empty",
        text: this.t("video.noRelated"),
      });
    }
  }

  destroy(): void {
    this.stopTracking();
    this.flushProgress();
    if (this.messageHandler) {
      window.removeEventListener("message", this.messageHandler);
      this.messageHandler = null;
    }
    if (this.iframeEl) {
      this.iframeEl.remove();
      this.iframeEl = null;
    }
    this.playerEl = null;
  }
}

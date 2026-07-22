/**
 * About Settings Tab renderer.
 *
 * Extracted from the monolithic settings-tab.ts.
 * Exports:
 *   - renderAboutTab(containerEl, plugin)
 */
import RssDashboardPlugin from "../../../main";
import { createTranslator } from "../../i18n";

export function renderAboutTab(
  containerEl: HTMLElement,
  plugin: RssDashboardPlugin,
): void {
  const t = createTranslator(plugin.settings?.locale ?? "zh-CN");
  const aboutContainer = containerEl.createDiv({
    cls: "rss-dashboard-about-tab",
  });

  aboutContainer.createDiv({
    cls: "rss-dashboard-about-title",
    text: plugin.manifest.name,
  });
  aboutContainer.createDiv({
    cls: "rss-dashboard-about-version",
    text: `v${plugin.manifest.version}`,
  });

  const descriptionContainer = aboutContainer.createDiv({
    cls: "rss-dashboard-about-description",
  });

  descriptionContainer.createEl("p", {
    text: t("settings.about.description"),
  });

  const featuresList = descriptionContainer.createEl("ul", {
    cls: "rss-dashboard-about-features-list",
  });
  featuresList.createEl("li", { text: t("settings.about.local") });
  featuresList.createEl("li", {
    text: t("settings.about.save"),
  });
  featuresList.createEl("li", { text: t("settings.about.noAds") });

  const attributionParagraph = descriptionContainer.createEl("p");
  attributionParagraph.createSpan({
    text: t("settings.about.created"),
  });
  const originalCreatorLink = attributionParagraph.createEl("a", {
    text: "Amatya-aditya",
    href: "https://github.com/amatya-aditya/",
    cls: "rss-dashboard-about-link",
  });
  originalCreatorLink.target = "_blank";
  originalCreatorLink.rel = "noopener noreferrer";
  attributionParagraph.createSpan({
    text: t("settings.about.maintained"),
  });
  const maintainerLink = attributionParagraph.createEl("a", {
    text: "Marcd35",
    href: "https://github.com/marcd35",
    cls: "rss-dashboard-about-link",
  });
  maintainerLink.target = "_blank";
  maintainerLink.rel = "noopener noreferrer";
  attributionParagraph.createSpan({
    text: t("settings.about.community"),
  });

  const createLinkButton = (
    parent: HTMLElement,
    label: string,
    href: string,
  ): void => {
    const link = parent.createEl("a", {
      text: label,
      href,
      cls: "rss-dashboard-about-btn",
    });
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  };

  const actionsRow = aboutContainer.createDiv({
    cls: "rss-dashboard-about-btn-row",
  });
  createLinkButton(
    actionsRow,
    "GitHub",
    "https://github.com/amatya-aditya/obsidian-rss-dashboard",
  );
  createLinkButton(
    actionsRow,
    t("settings.about.reportIssue"),
    "https://github.com/amatya-aditya/obsidian-rss-dashboard/issues",
  );
  createLinkButton(actionsRow, "Discord", "https://discord.gg/9bu7V9BBbs");

  aboutContainer.createDiv({
    cls: "rss-dashboard-about-section-title",
    text: t("settings.about.support"),
  });
  const supportRow = aboutContainer.createDiv({
    cls: "rss-dashboard-about-btn-row",
  });
  createLinkButton(
    supportRow,
    t("settings.about.coffee"),
    "https://www.buymeacoffee.com/amatya_aditya",
  );
  createLinkButton(supportRow, "Ko-fi", "https://ko-fi.com/Y8Y41FV4WI");

  aboutContainer.createDiv({
    cls: "rss-dashboard-about-section-title",
    text: t("settings.about.other"),
  });
  const otherPluginsRow = aboutContainer.createDiv({
    cls: "rss-dashboard-about-btn-row",
  });
  createLinkButton(
    otherPluginsRow,
    "Advanced Multi Column",
    "https://github.com/amatya-aditya/advanced-multi-column",
  );
  createLinkButton(
    otherPluginsRow,
    "Media Slider",
    "https://github.com/amatya-aditya/obsidian-media-slider",
  );
  createLinkButton(
    otherPluginsRow,
    "Zen Space",
    "https://github.com/amatya-aditya/obsidian-zen-space",
  );
}

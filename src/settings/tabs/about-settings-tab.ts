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
  featuresList.createEl("li", { text: t("settings.about.manualAi") });

  descriptionContainer.createEl("p", {
    text: t("settings.about.upstreamAttribution"),
  });
  descriptionContainer.createEl("p", {
    text: t("settings.about.upstreamChannels"),
  });

  const actionsRow = aboutContainer.createDiv({
    cls: "rss-dashboard-about-btn-row",
  });
  const upstreamLink = actionsRow.createEl("a", {
    text: t("settings.about.upstreamProject"),
    href: "https://github.com/amatya-aditya/obsidian-rss-dashboard",
    cls: "rss-dashboard-about-btn",
  });
  upstreamLink.target = "_blank";
  upstreamLink.rel = "noopener noreferrer";
}

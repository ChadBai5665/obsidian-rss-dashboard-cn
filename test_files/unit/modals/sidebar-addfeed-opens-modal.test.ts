import { describe, it, expect, vi, beforeEach } from "vitest";
import { App } from "obsidian";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

type ObsidianHTMLElement = HTMLElement & {
  createDiv(opts?: string | { cls?: string; text?: string; attr?: Record<string, string> }): HTMLDivElement;
  empty(): void;
};

describe("Sidebar addFeed icon", () => {
  beforeEach(() => {
    installObsidianDomPolyfills();
    (document.body as unknown as ObsidianHTMLElement).empty();
  });

  it("opens the plugin's verified onboarding entry", async () => {
    const { Sidebar } = await import("../../../src/components/sidebar");

    const app = new App();
    const container = (document.body as unknown as ObsidianHTMLElement).createDiv();

    const openAddSourceModal = vi.fn();
    const plugin = {
      manifest: { id: "rss-dashboard" },
      openAddSourceModal,
    } as unknown;
    const settings = { folders: [], display: {} } as unknown;
    const options = {} as unknown;
    const callbacks = {
      onAddFeed: vi.fn(async () => {}),
    } as unknown;

    const sidebar = new Sidebar(
      app,
      container,
      plugin as never,
      settings as never,
      options as never,
      callbacks as never,
    );

    // showAddFeedModal is private; access for regression protection
    (sidebar as unknown as { showAddFeedModal: (folder?: string) => void }).showAddFeedModal(
      "Uncategorized",
    );

    expect(openAddSourceModal).toHaveBeenCalledWith({
      initialFolder: "Uncategorized",
    });
  });
});

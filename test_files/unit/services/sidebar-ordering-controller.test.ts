import { describe, expect, it } from "vitest";
import {
  moveFeedAndInsert,
  moveFeedToFolderAppend,
  moveFolder,
  setFolderFeedSortCustom,
  setFolderSortCustom,
} from "../../../src/services/sidebar-ordering-controller";
import {
  DEFAULT_SETTINGS,
  type Feed,
  type Folder,
  type RssDashboardSettings,
} from "../../../src/types/types";

function cloneSettings(): RssDashboardSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as RssDashboardSettings;
}

function makeFeed(title: string, url: string, folder: unknown = ""): Feed {
  return { title, url, folder, items: [], lastUpdated: 0 } as Feed;
}

function folder(name: string, subfolders: Folder[] = []): Folder {
  return { name, subfolders };
}

describe("sidebar-ordering-controller helpers", () => {
  it("setFolderFeedSortCustom creates map and normalizes empty folder key", () => {
    const settings = cloneSettings();
    delete settings.folderFeedSortOrders;

    setFolderFeedSortCustom(settings, "" as string);
    const updatedSettings = settings;
    expect(updatedSettings.folderFeedSortOrders).toBeTruthy();
    expect(updatedSettings.folderFeedSortOrders?.[""]?.by).toBe("custom");
  });

  it("setFolderSortCustom switches to custom and preserves ascending", () => {
    const settings = cloneSettings();
    settings.folderSortOrder = { by: "name", ascending: false };
    setFolderSortCustom(settings);
    expect(settings.folderSortOrder).toEqual({ by: "custom", ascending: false });
  });
});

describe("moveFeedAndInsert", () => {
  it("returns an isolated candidate without mutating the live settings", () => {
    const settings = cloneSettings();
    settings.feeds = [
      makeFeed("A", "a", "Work"),
      makeFeed("B", "b", "Home"),
    ];
    const before = structuredClone(settings);

    const result = moveFeedAndInsert(settings, {
      draggedUrl: "a",
      targetUrl: "b",
      placement: "before",
    });

    expect(settings).toEqual(before);
    expect(result.ok).toBe(true);
    expect((result as unknown as { settings: RssDashboardSettings }).settings.feeds)
      .toEqual([
        expect.objectContaining({ url: "a", folder: "Home" }),
        expect.objectContaining({ url: "b", folder: "Home" }),
      ]);
  });

  it("rejects missing urls and no-op drops", () => {
    const settings = cloneSettings();
    settings.feeds = [makeFeed("A", "a", "Work"), makeFeed("B", "b", "Work")];

    expect(
      moveFeedAndInsert(settings, { draggedUrl: "", targetUrl: "b", placement: "before" }),
    ).toEqual({ ok: false, reason: "missing-drag-source" });

    expect(
      moveFeedAndInsert(settings, { draggedUrl: "a", targetUrl: "", placement: "before" }),
    ).toEqual({ ok: false, reason: "missing-drop-target" });

    expect(
      moveFeedAndInsert(settings, { draggedUrl: "a", targetUrl: "a", placement: "before" }),
    ).toEqual({ ok: false, reason: "no-op-drop" });
  });

  it("rejects when dragged or target feed is missing", () => {
    const settings = cloneSettings();
    settings.feeds = [makeFeed("A", "a", "Work")];

    expect(
      moveFeedAndInsert(settings, { draggedUrl: "missing", targetUrl: "a", placement: "before" }),
    ).toEqual({ ok: false, reason: "dragged-feed-not-found" });

    expect(
      moveFeedAndInsert(settings, { draggedUrl: "a", targetUrl: "missing", placement: "before" }),
    ).toEqual({ ok: false, reason: "target-feed-not-found" });
  });

  it("moves the dragged feed into the target folder and inserts before/after", () => {
    const settings = cloneSettings();
    settings.feeds = [
      makeFeed("A", "a", "Work"),
      makeFeed("B", "b", "Home"),
      makeFeed("C", "c", "Home"),
    ];

    const before = moveFeedAndInsert(settings, {
      draggedUrl: "a",
      targetUrl: "b",
      placement: "before",
    });

    expect(before.ok).toBe(true);
    if (!before.ok) throw new Error(before.reason);
    expect(before.settings.feeds.map((f) => f.url)).toEqual(["a", "b", "c"]);
    expect(before.settings.feeds.find((f) => f.url === "a")?.folder).toBe("Home");
    expect(before.settings.folderFeedSortOrders?.["Home"]?.by).toBe("custom");

    const after = moveFeedAndInsert(before.settings, {
      draggedUrl: "a",
      targetUrl: "c",
      placement: "after",
    });

    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error(after.reason);
    expect(after.settings.feeds.map((f) => f.url)).toEqual(["b", "c", "a"]);
  });

  it("normalizes undefined target folder to root (empty string) and writes sort key", () => {
    const settings = cloneSettings();
    settings.feeds = [
      makeFeed("Dragged", "d", "SomeFolder"),
      makeFeed("Target", "t", undefined),
    ];

    const result = moveFeedAndInsert(settings, {
      draggedUrl: "d",
      targetUrl: "t",
      placement: "before",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.settings.feeds.find((f) => f.url === "d")?.folder).toBe("");
    expect(result.settings.folderFeedSortOrders?.[""]?.by).toBe("custom");
  });
});

describe("moveFeedToFolderAppend", () => {
  it("rejects missing dragged url and missing dragged feed", () => {
    const settings = cloneSettings();
    settings.feeds = [makeFeed("A", "a", "Work")];

    expect(
      moveFeedToFolderAppend(settings, { draggedUrl: "", destinationFolderPath: "Work" }),
    ).toEqual({ ok: false, reason: "missing-drag-source" });

    expect(
      moveFeedToFolderAppend(settings, { draggedUrl: "missing", destinationFolderPath: "Work" }),
    ).toEqual({ ok: false, reason: "dragged-feed-not-found" });
  });

  it("moves and appends after the last feed in the destination folder", () => {
    const settings = cloneSettings();
    settings.feeds = [
      makeFeed("A", "a", "Work"),
      makeFeed("B", "b", "Home"),
      makeFeed("C", "c", "Home"),
      makeFeed("D", "d", "Work"),
    ];

    const result = moveFeedToFolderAppend(settings, {
      draggedUrl: "a",
      destinationFolderPath: "Home",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.settings.feeds.find((f) => f.url === "a")?.folder).toBe("Home");
    expect(result.settings.feeds.map((f) => f.url)).toEqual(["b", "c", "a", "d"]);
    expect(result.settings.folderFeedSortOrders?.["Home"]?.by).toBe("custom");
  });
});

describe("moveFolder", () => {
  it("rejects missing required inputs and invalid nesting", () => {
    const settings = cloneSettings();
    settings.folders = [folder("Alpha", [folder("Child")])];
    settings.feeds = [];

    expect(
      moveFolder(settings, { draggedPath: "", targetPath: "Alpha", placement: "before" }),
    ).toEqual({ ok: false, reason: "missing-drag-source" });

    expect(
      moveFolder(settings, { draggedPath: "Alpha", targetPath: "", placement: "before" }),
    ).toEqual({ ok: false, reason: "missing-drop-target" });

    expect(
      moveFolder(settings, { draggedPath: "Alpha", targetPath: "Alpha/Child", placement: "nest" }),
    ).toEqual({
      ok: false,
      reason: "invalid-descendant-move",
    });
  });

  it("rejects when dragged or target folder is not found", () => {
    const settings = cloneSettings();
    settings.folders = [folder("Alpha"), folder("Beta")];
    settings.feeds = [];

    expect(
      moveFolder(settings, { draggedPath: "Missing", targetPath: "Beta", placement: "nest" }),
    ).toEqual({ ok: false, reason: "dragged-folder-not-found" });

    expect(
      moveFolder(settings, { draggedPath: "Alpha", targetPath: "Missing", placement: "nest" }),
    ).toEqual({ ok: false, reason: "target-folder-not-found" });
  });

  it("rejects duplicate sibling names at destination", () => {
    const settings = cloneSettings();
    settings.folders = [
      folder("Alpha"),
      folder("Beta", [folder("Alpha")]),
    ];
    settings.feeds = [];

    const result = moveFolder(settings, {
      draggedPath: "Alpha",
      targetPath: "Beta",
      placement: "nest",
    });

    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false, reason: "duplicate-folder-target" });
  });

  it("moves within root and adjusts insertion index when moving forward", () => {
    const settings = cloneSettings();
    settings.folders = [folder("A"), folder("B"), folder("C")];
    settings.feeds = [];

    const result = moveFolder(settings, {
      draggedPath: "A",
      targetPath: "C",
      placement: "after",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.settings.folders.map((f) => f.name)).toEqual(["B", "C", "A"]);
    expect(result.settings.folderSortOrder?.by).toBe("custom");
    expect(result.newPath).toBe("A");
  });

  it("nests into target and remaps feeds + collapsedFolders + sort keys", () => {
    const settings = cloneSettings();
    settings.folders = [
      folder("Alpha", [folder("Child")]),
      folder("Beta"),
    ];
    settings.feeds = [
      makeFeed("Feed", "f", "Alpha/Child"),
      makeFeed("Other", "o", "Beta"),
    ];
    settings.collapsedFolders = ["Alpha", "Alpha/Child"];
    settings.folderFeedSortOrders = {
      "Alpha/Child": { by: "name", ascending: true },
    };

    const result = moveFolder(settings, {
      draggedPath: "Alpha",
      targetPath: "Beta",
      placement: "nest",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.newPath).toBe("Beta/Alpha");
    expect(result.settings.feeds.find((f) => f.url === "f")?.folder).toBe("Beta/Alpha/Child");
    expect(result.settings.collapsedFolders).toEqual(["Beta/Alpha", "Beta/Alpha/Child"]);
    expect(result.settings.folderFeedSortOrders?.["Beta/Alpha/Child"]?.by).toBe("name");
    expect(result.settings.folderFeedSortOrders?.["Alpha/Child"]).toBeUndefined();
    expect(result.settings.folderSortOrder?.by).toBe("custom");
  });
});

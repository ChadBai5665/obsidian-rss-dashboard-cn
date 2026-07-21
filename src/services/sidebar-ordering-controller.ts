import type { Folder, RssDashboardSettings } from "../types/types";

export type FeedInsertPlacement = "before" | "after";
export type FolderDropPlacement = "before" | "after" | "nest" | "rootAppend";

export type OrderingFailureReason =
  | "missing-drag-source"
  | "missing-drop-target"
  | "no-op-drop"
  | "dragged-feed-not-found"
  | "target-feed-not-found"
  | "dragged-folder-not-found"
  | "target-folder-not-found"
  | "invalid-descendant-move"
  | "duplicate-folder-target"
  | "target-location-drifted"
  | "unknown";

export type OperationResult =
  | { ok: true }
  | { ok: false; reason: OrderingFailureReason };

export type FolderOperationResult =
  | { ok: true; newPath: string }
  | { ok: false; reason: OrderingFailureReason };

function normalizeFolderPath(folderPath: string | null | undefined): string {
  return folderPath ? folderPath : "";
}

function ensureFolderFeedSortOrders(settings: RssDashboardSettings): NonNullable<RssDashboardSettings["folderFeedSortOrders"]> {
  if (!settings.folderFeedSortOrders) settings.folderFeedSortOrders = {};
  return settings.folderFeedSortOrders;
}

export function setFolderFeedSortCustom(
  settings: RssDashboardSettings,
  folderPath: string,
): void {
  const map = ensureFolderFeedSortOrders(settings);
  map[normalizeFolderPath(folderPath)] = { by: "custom", ascending: true };
}

export function setFolderSortCustom(settings: RssDashboardSettings): void {
  const prev = settings.folderSortOrder;
  settings.folderSortOrder = { by: "custom", ascending: prev?.ascending ?? true };
}

export function moveFeedAndInsert(
  settings: RssDashboardSettings,
  opts: {
    draggedUrl: string;
    targetUrl: string;
    placement: FeedInsertPlacement;
  },
): OperationResult {
  const draggedUrl = opts.draggedUrl;
  const targetUrl = opts.targetUrl;
  if (!draggedUrl) return { ok: false, reason: "missing-drag-source" };
  if (!targetUrl) return { ok: false, reason: "missing-drop-target" };
  if (draggedUrl === targetUrl) return { ok: false, reason: "no-op-drop" };

  const dragged = settings.feeds.find((f) => f.url === draggedUrl);
  const target = settings.feeds.find((f) => f.url === targetUrl);
  if (!dragged) return { ok: false, reason: "dragged-feed-not-found" };
  if (!target) return { ok: false, reason: "target-feed-not-found" };

  const destinationFolderPath = normalizeFolderPath(target.folder);
  dragged.folder = destinationFolderPath;

  const withoutDragged = settings.feeds.filter((f) => f.url !== draggedUrl);
  const targetIndex = withoutDragged.findIndex((f) => f.url === targetUrl);
  if (targetIndex === -1) return { ok: false, reason: "target-feed-not-found" };

  const insertIndex = opts.placement === "before" ? targetIndex : targetIndex + 1;
  const next = [...withoutDragged];
  next.splice(insertIndex, 0, dragged);
  settings.feeds = next;

  setFolderFeedSortCustom(settings, destinationFolderPath);

  return { ok: true };
}

export function moveFeedToFolderAppend(
  settings: RssDashboardSettings,
  opts: {
    draggedUrl: string;
    destinationFolderPath: string;
  },
): OperationResult {
  const draggedUrl = opts.draggedUrl;
  const destinationFolderPath = normalizeFolderPath(opts.destinationFolderPath);
  if (!draggedUrl) return { ok: false, reason: "missing-drag-source" };

  const dragged = settings.feeds.find((f) => f.url === draggedUrl);
  if (!dragged) return { ok: false, reason: "dragged-feed-not-found" };

  dragged.folder = destinationFolderPath;

  const withoutDragged = settings.feeds.filter((f) => f.url !== draggedUrl);
  let lastIndexInDestination = -1;
  for (let i = 0; i < withoutDragged.length; i++) {
    const folderPath = normalizeFolderPath(withoutDragged[i].folder);
    if (folderPath === destinationFolderPath) lastIndexInDestination = i;
  }

  const insertIndex = lastIndexInDestination + 1;
  const next = [...withoutDragged];
  next.splice(insertIndex, 0, dragged);
  settings.feeds = next;

  setFolderFeedSortCustom(settings, destinationFolderPath);
  return { ok: true };
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function joinPath(parts: string[]): string {
  return parts.join("/");
}

function isSameOrDescendant(basePath: string, maybeDescendant: string): boolean {
  return (
    maybeDescendant === basePath ||
    maybeDescendant.startsWith(basePath.endsWith("/") ? basePath : `${basePath}/`)
  );
}

function remapPathPrefix(path: string, fromBase: string, toBase: string): string {
  if (path === fromBase) return toBase;
  if (path.startsWith(`${fromBase}/`)) return `${toBase}${path.substring(fromBase.length)}`;
  return path;
}

interface FolderLocation {
  folder: Folder;
  parentArray: Folder[];
  index: number;
  parentPathParts: string[];
}

function findFolderLocation(
  root: Folder[],
  folderPath: string,
): FolderLocation | null {
  const parts = splitPath(folderPath);
  if (parts.length === 0) return null;

  const walk = (
    currentArray: Folder[],
    depth: number,
    parentPathParts: string[],
  ): FolderLocation | null => {
    const name = parts[depth];
    const idx = currentArray.findIndex((f) => f.name === name);
    if (idx === -1) return null;
    const folder = currentArray[idx];

    if (depth === parts.length - 1) {
      return {
        folder,
        parentArray: currentArray,
        index: idx,
        parentPathParts,
      };
    }

    return walk(folder.subfolders ?? [], depth + 1, [...parentPathParts, folder.name]);
  };

  return walk(root, 0, []);
}

function ensureSubfolders(folder: Folder): Folder[] {
  if (!folder.subfolders) folder.subfolders = [];
  return folder.subfolders;
}

function findIndexByRefOrName(arr: Folder[], ref: Folder, name: string): number {
  const byRef = arr.indexOf(ref);
  if (byRef !== -1) return byRef;
  return arr.findIndex((f) => f.name === name);
}

export function moveFolder(
  settings: RssDashboardSettings,
  opts: {
    draggedPath: string;
    targetPath: string;
    placement: FolderDropPlacement;
  },
): FolderOperationResult {
  const draggedPath = opts.draggedPath;
  const targetPath = opts.targetPath;
  const placement = opts.placement;

  if (!draggedPath) return { ok: false, reason: "missing-drag-source" };
  if (placement !== "rootAppend" && !targetPath) {
    return { ok: false, reason: "missing-drop-target" };
  }

  if (placement !== "rootAppend" && isSameOrDescendant(draggedPath, targetPath)) {
    return { ok: false, reason: "invalid-descendant-move" };
  }

  const draggedLoc = findFolderLocation(settings.folders, draggedPath);
  if (!draggedLoc) return { ok: false, reason: "dragged-folder-not-found" };

  const targetLoc =
    placement === "rootAppend" ? null : findFolderLocation(settings.folders, targetPath);
  if (placement !== "rootAppend" && !targetLoc) {
    return { ok: false, reason: "target-folder-not-found" };
  }

  const draggedFolder = draggedLoc.folder;
  const draggedName = draggedFolder.name;

  let destinationParentArray: Folder[];
  let destinationParentPath = "";
  let insertIndex = 0;

  if (placement === "rootAppend") {
    destinationParentArray = settings.folders;
    destinationParentPath = "";
    insertIndex = destinationParentArray.length;
  } else if (placement === "nest") {
    const targetFolder = targetLoc!.folder;
    destinationParentArray = ensureSubfolders(targetFolder);
    destinationParentPath = targetPath;
    insertIndex = destinationParentArray.length;
  } else {
    destinationParentArray = targetLoc!.parentArray;
    destinationParentPath = joinPath(targetLoc!.parentPathParts);
    const targetIndex = findIndexByRefOrName(
      destinationParentArray,
      targetLoc!.folder,
      targetLoc!.folder.name,
    );
    if (targetIndex === -1) return { ok: false, reason: "target-location-drifted" };
    insertIndex = placement === "before" ? targetIndex : targetIndex + 1;
  }

  // Duplicate sibling name validation (post-removal).
  if (
    destinationParentArray.some(
      (f) => f.name === draggedName && f !== draggedFolder,
    )
  ) {
    return {
      ok: false,
      reason: "duplicate-folder-target",
    };
  }

  const sourceParentArray = draggedLoc.parentArray;
  const sourceIndex = draggedLoc.index;

  // Remove dragged from its current parent
  sourceParentArray.splice(sourceIndex, 1);

  // If moving within the same array and the removal occurred before the insertion point,
  // the insertion index should shift back by 1.
  if (destinationParentArray === sourceParentArray && sourceIndex < insertIndex) {
    insertIndex -= 1;
  }

  destinationParentArray.splice(insertIndex, 0, draggedFolder);

  const newBasePath = destinationParentPath
    ? `${destinationParentPath}/${draggedName}`
    : draggedName;

  if (newBasePath !== draggedPath) {
    // Remap feed folder paths (in-place to preserve object identity)
    for (const feed of settings.feeds) {
      if (!feed.folder) continue;
      if (feed.folder === draggedPath || feed.folder.startsWith(`${draggedPath}/`)) {
        feed.folder = remapPathPrefix(feed.folder, draggedPath, newBasePath);
      }
    }

    // Remap collapsed folders
    settings.collapsedFolders = (settings.collapsedFolders ?? []).map((p) =>
      remapPathPrefix(p, draggedPath, newBasePath),
    );

    // Remap folder feed sort-order keys
    if (settings.folderFeedSortOrders) {
      const next: NonNullable<RssDashboardSettings["folderFeedSortOrders"]> = {};
      for (const [key, value] of Object.entries(settings.folderFeedSortOrders)) {
        const mappedKey = remapPathPrefix(key, draggedPath, newBasePath);
        next[mappedKey] = value;
      }
      settings.folderFeedSortOrders = next;
    }
  }

  setFolderSortCustom(settings);
  return { ok: true, newPath: newBasePath };
}

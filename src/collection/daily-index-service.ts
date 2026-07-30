import { type Vault } from "obsidian";
import type { CollectedItem } from "./collected-item";
import { renderDailyIndex } from "./daily-index-renderer";

export interface DailyIndexSnapshot {
  localDate: string;
  path: string;
  existed: boolean;
  content?: string;
}

export class DailyIndexService {
  private readonly dailyIndexFolder: string;

  constructor(
    private readonly vault: Vault,
    dailyIndexFolder: string,
  ) {
    assertSafeDailyIndexFolder(dailyIndexFolder);
    this.dailyIndexFolder = dailyIndexFolder;
  }

  async writeDailyIndex(input: {
    localDate: string;
    items: CollectedItem[];
  }): Promise<string> {
    assertLocalDate(input.localDate);
    const path = `${this.dailyIndexFolder}/${input.localDate}.md`;
    const existingMarkdown = (await this.vault.adapter.exists(path))
      ? await this.vault.adapter.read(path)
      : undefined;
    const markdown = renderDailyIndex({ ...input, existingMarkdown });

    await this.ensureParentFolders();
    await this.vault.adapter.write(path, markdown);
    return path;
  }

  async snapshotDailyIndex(localDate: string): Promise<DailyIndexSnapshot> {
    assertLocalDate(localDate);
    const path = `${this.dailyIndexFolder}/${localDate}.md`;
    const existed = await this.vault.adapter.exists(path);
    return {
      localDate,
      path,
      existed,
      ...(existed ? { content: await this.vault.adapter.read(path) } : {}),
    };
  }

  async restoreDailyIndex(snapshot: DailyIndexSnapshot): Promise<void> {
    assertLocalDate(snapshot.localDate);
    const expectedPath = `${this.dailyIndexFolder}/${snapshot.localDate}.md`;
    if (snapshot.path !== expectedPath) throw new Error("Invalid daily index snapshot");
    if (snapshot.existed) {
      if (typeof snapshot.content !== "string") {
        throw new Error("Invalid daily index snapshot");
      }
      await this.ensureParentFolders();
      await this.vault.adapter.write(snapshot.path, snapshot.content);
      return;
    }
    if (snapshot.content !== undefined) throw new Error("Invalid daily index snapshot");
    if (await this.vault.adapter.exists(snapshot.path)) {
      await this.vault.adapter.remove(snapshot.path);
    }
  }

  private async ensureParentFolders(): Promise<void> {
    let currentPath = "";
    for (const segment of this.dailyIndexFolder.split("/")) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      if (!(await this.vault.adapter.exists(currentPath))) {
        await this.vault.adapter.mkdir(currentPath);
      }
    }
  }
}

function assertLocalDate(localDate: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) {
    throw new Error("Invalid local collection date");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = new Date(year, month, 0).getDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) {
    throw new Error("Invalid local collection date");
  }
}

function assertSafeDailyIndexFolder(folder: string): void {
  if (
    !folder ||
    folder.startsWith("/") ||
    folder.includes("\\") ||
    folder.includes("\0") ||
    /^[A-Za-z]:/.test(folder)
  ) {
    throw new Error("Invalid daily index folder");
  }

  const segments = folder.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Invalid daily index folder");
  }
}

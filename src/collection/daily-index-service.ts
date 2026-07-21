import { normalizePath, type Vault } from "obsidian";
import type { CollectedItem } from "./collected-item";
import { renderDailyIndex } from "./daily-index-renderer";

export class DailyIndexService {
  private readonly dailyIndexFolder: string;

  constructor(
    private readonly vault: Vault,
    dailyIndexFolder: string,
  ) {
    const trimmedFolder = dailyIndexFolder.trim().replace(/^\/+|\/+$/g, "");
    if (!trimmedFolder) {
      throw new Error("Daily index folder cannot be empty");
    }
    this.dailyIndexFolder = normalizePath(trimmedFolder);
  }

  async writeDailyIndex(input: {
    localDate: string;
    items: CollectedItem[];
  }): Promise<string> {
    const path = normalizePath(`${this.dailyIndexFolder}/${input.localDate}.md`);
    const existingMarkdown = (await this.vault.adapter.exists(path))
      ? await this.vault.adapter.read(path)
      : undefined;
    const markdown = renderDailyIndex({ ...input, existingMarkdown });

    await this.ensureParentFolders();
    await this.vault.adapter.write(path, markdown);
    return path;
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

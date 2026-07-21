import { Modal, App, setIcon, Notice } from "obsidian";
import type { RssDashboardSettings } from "../types/types";
import { createTranslator } from "../i18n";

export class ShortcutHelpModal extends Modal {
  private settings?: RssDashboardSettings;

  /** Shortcut labels are data, not command values; keys remain unchanged. */
  private readonly chineseShortcutText: Readonly<Record<string, string>> = {
    "General Navigation": "常规导航",
    "Open Help Dialog": "打开帮助对话框",
    "Close Dialog / Clear Selection": "关闭对话框 / 清除选择",
    "Refresh Feed": "刷新订阅源",
    "Dashboard View": "仪表盘视图",
    "Focus sidebar": "聚焦侧边栏",
    "Focus reader view": "聚焦阅读器视图",
    "All articles filter": "全部文章筛选",
    "Unread articles filter": "未读文章筛选",
    "Read articles filter": "已读文章筛选",
    "List view": "列表视图",
    "Card view": "卡片视图",
    "Feed view": "订阅源视图",
    "Reader View": "阅读器视图",
    "Focus dashboard view": "聚焦仪表盘视图",
    "Scroll article up/down": "向上/向下滚动文章",
    "Scroll article left/right": "向左/向右滚动文章",
    "Scroll by one page": "按一页滚动",
    "Jump to start/end of article": "跳至文章开头/结尾",
    "Increase font size": "增大字体",
    "Decrease font size": "减小字体",
    "Reset font size": "重置字体大小",
    "Article Manipulation": "文章操作",
    "Card view navigation": "卡片视图导航",
    "Open article in reader pane": "在阅读器窗格中打开文章",
    "Close reader pane": "关闭阅读器窗格",
    "Open prior article in feed": "打开订阅源中的上一篇文章",
    "Open next article in feed": "打开订阅源中的下一篇文章",
    "Mark article read/unread toggle": "切换文章已读/未读状态",
    "Mark article read and open next": "标记文章为已读并打开下一篇",
    "Mark all as read": "全部标为已读",
    "Star/Unstar article": "添加/取消文章星标",
    "Add tags to article": "为文章添加标签",
    "Save full content to notes": "将完整内容保存到笔记",
    "Sidebar Navigation": "侧边栏导航",
    "Next item": "下一项",
    "Previous item": "上一项",
    "Move focused item": "移动聚焦项",
    "Jump between folders": "在文件夹间跳转",
    "Open focused item": "打开聚焦项",
    "Open/Collapse folder": "打开/折叠文件夹",
    "Delete folder/feed": "删除文件夹/订阅源",
    "Rename folder/feed": "重命名文件夹/订阅源",
  };

  constructor(app: App, settings?: RssDashboardSettings) {
    super(app);
    this.settings = settings;
  }

  onOpen() {
    const t = createTranslator(this.settings?.locale ?? "en");
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("rss-dashboard-modal");
    this.modalEl.addClass("rss-dashboard-modal-container");
    this.modalEl.addClass("rss-shortcut-help-modal");

    const header = contentEl.createDiv({ cls: "rss-dashboard-header" });
    header.createDiv({
      cls: "rss-dashboard-header-title",
      text: t("modal.shortcuts.title"),
    });

    // Add save link below title
    const saveLink = header.createEl("a", {
      cls: "rss-dashboard-save-shortcuts-link",
      text: t("modal.shortcuts.save"),
      href: "#",
    });
    saveLink.addEventListener("click", (e: Event) => {
      e.preventDefault();
      void this.saveShortcutsToVault();
    });

    const closeBtn = header.createDiv({
      cls: "rss-dashboard-header-close-button clickable-icon",
      attr: {
        role: "button",
        tabindex: "0",
        "aria-label": t("common.close"),
      },
    });
    setIcon(closeBtn, "x");
    const handleClose = (e: Event) => {
      e.preventDefault();
      this.close();
    };
    closeBtn.addEventListener("click", handleClose);
    closeBtn.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        handleClose(e);
      }
    });

    const body = contentEl.createDiv({ cls: "rss-dashboard-modal-content" });

    this.renderSection(body, "General Navigation", [
      { key: "?", desc: "Open Help Dialog" },
      { key: "Esc", desc: "Close Dialog / Clear Selection" },
      { key: "r", desc: "Refresh Feed" },
    ]);

    this.renderSection(body, "Dashboard View", [
      { key: "Shift + s", desc: "Focus sidebar" },
      { key: "Shift + r", desc: "Focus reader view" },
      { key: "Shift + 1", desc: "All articles filter" },
      { key: "Shift + 2", desc: "Unread articles filter" },
      { key: "Shift + 3", desc: "Read articles filter" },
      { key: "1", desc: "List view" },
      { key: "2", desc: "Card view" },
      { key: "3", desc: "Feed view" },
    ]);

    this.renderSection(body, "Reader View", [
      { key: "Shift + d", desc: "Focus dashboard view" },
      { key: "Shift + s", desc: "Focus sidebar" },
      { key: "Shift + r", desc: "Focus reader view" },
      { key: "ArrowUp / ArrowDown", desc: "Scroll article up/down" },
      { key: "ArrowLeft / ArrowRight", desc: "Scroll article left/right" },
      { key: "PageUp / PageDown", desc: "Scroll by one page" },
      { key: "Home / End", desc: "Jump to start/end of article" },
      { key: "= / +", desc: "Increase font size" },
      { key: "- / _", desc: "Decrease font size" },
      { key: "0", desc: "Reset font size" },
    ]);

    this.renderSection(body, "Article Manipulation", [
      { key: "Arrow keys", desc: "Card view navigation" },
      { key: "o / Enter", desc: "Open article in reader pane" },
      { key: "k", desc: "Close reader pane" },
      { key: "j", desc: "Open prior article in feed" },
      { key: "l", desc: "Open next article in feed" },
      { key: "m", desc: "Mark article read/unread toggle" },
      { key: ",", desc: "Mark article read and open next" },
      { key: "Shift + a", desc: "Mark all as read" },
      { key: "f", desc: "Star/Unstar article" },
      { key: "t", desc: "Add tags to article" },
      { key: "s", desc: "Save full content to notes" },
    ]);

    this.renderSection(body, "Sidebar Navigation", [
      { key: "Shift + l", desc: "Next item" },
      { key: "Shift + j", desc: "Previous item" },
      { key: "ArrowUp / ArrowDown", desc: "Move focused item" },
      { key: "ArrowLeft / ArrowRight", desc: "Jump between folders" },
      { key: "Shift + o / Shift + Enter", desc: "Open focused item" },
      { key: "Shift + x", desc: "Open/Collapse folder" },
      { key: "Shift + d", desc: "Delete folder/feed" },
      { key: "Shift + r", desc: "Rename folder/feed" },
    ]);
  }

  private async saveShortcutsToVault(): Promise<void> {
    const t = createTranslator(this.settings?.locale ?? "en");
    try {
      // Build the markdown content
      const shortcutsData = [
        {
          section: "General Navigation",
          items: [
            { key: "?", desc: "Open Help Dialog" },
            { key: "Esc", desc: "Close Dialog / Clear Selection" },
            { key: "r", desc: "Refresh Feed" },
          ],
        },
        {
          section: "Dashboard View",
          items: [
            { key: "Shift + s", desc: "Focus sidebar" },
            { key: "Shift + r", desc: "Focus reader view" },
            { key: "Shift + 1", desc: "All articles filter" },
            { key: "Shift + 2", desc: "Unread articles filter" },
            { key: "Shift + 3", desc: "Read articles filter" },
            { key: "1", desc: "List view" },
            { key: "2", desc: "Card view" },
            { key: "3", desc: "Feed view" },
          ],
        },
        {
          section: "Reader View",
          items: [
            { key: "Shift + d", desc: "Focus dashboard view" },
            { key: "Shift + s", desc: "Focus sidebar" },
            { key: "Shift + r", desc: "Focus reader view" },
            { key: "ArrowUp / ArrowDown", desc: "Scroll article up/down" },
            {
              key: "ArrowLeft / ArrowRight",
              desc: "Scroll article left/right",
            },
            { key: "PageUp / PageDown", desc: "Scroll by one page" },
            { key: "Home / End", desc: "Jump to start/end of article" },
            { key: "= / +", desc: "Increase font size" },
            { key: "- / _", desc: "Decrease font size" },
            { key: "0", desc: "Reset font size" },
          ],
        },
        {
          section: "Article Manipulation",
          items: [
            { key: "Arrow keys", desc: "Card view navigation" },
            { key: "o / Enter", desc: "Open article in reader pane" },
            { key: "k", desc: "Close reader pane" },
            { key: "j", desc: "Open prior article in feed" },
            { key: "l", desc: "Open next article in feed" },
            { key: "m", desc: "Mark article read/unread toggle" },
            { key: ",", desc: "Mark article read and open next" },
            { key: "Shift + a", desc: "Mark all as read" },
            { key: "f", desc: "Star/Unstar article" },
            { key: "t", desc: "Add tags to article" },
            { key: "s", desc: "Save full content to notes" },
          ],
        },
        {
          section: "Sidebar Navigation",
          items: [
            { key: "Shift + l", desc: "Next item" },
            { key: "Shift + j", desc: "Previous item" },
            { key: "ArrowUp / ArrowDown", desc: "Move focused item" },
            { key: "ArrowLeft / ArrowRight", desc: "Jump between folders" },
            { key: "Shift + o / Shift + Enter", desc: "Open focused item" },
            { key: "Shift + x", desc: "Open/Collapse folder" },
            { key: "Shift + d", desc: "Delete folder/feed" },
            { key: "Shift + r", desc: "Rename folder/feed" },
          ],
        },
      ];

      let content = `# ${t("modal.shortcuts.markdownTitle")}\n\n`;
      shortcutsData.forEach((section) => {
        content += `## ${this.localizeShortcut(section.section)}\n\n`;
        content += `| ${t("modal.shortcuts.shortcut")} | ${t("modal.shortcuts.action")} |\n`;
        content += "|----------|--------|\n";
        section.items.forEach((item) => {
          content += `| ${item.key} | ${this.localizeShortcut(item.desc)} |\n`;
        });
        content += "\n";
      });

      // Determine the save folder - default to vault root if not configured
      let saveFolder = this.settings?.articleSaving.defaultFolder;
      if (!saveFolder || saveFolder.trim() === "") {
        saveFolder = "/";
      }

      // Normalize the path
      const vault = this.app.vault;
      const folderPath =
        saveFolder === "/" ? "" : saveFolder.replace(/^\/|\/$/g, "");

      // Ensure folder exists (skip if saving to root)
      if (folderPath) {
        try {
          const folderExists = vault.getAbstractFileByPath(folderPath);
          if (!folderExists) {
            await vault.createFolder(folderPath);
          }
        } catch (folderError) {
          console.error(
            "[RSS Dashboard] Failed to create folder:",
            folderPath,
            folderError,
          );
          throw new Error(`Could not create folder: ${folderPath}`);
        }
      }

      // Create or overwrite the file
      const filePath = folderPath
        ? `${folderPath}/keyboard-shortcuts.md`
        : "keyboard-shortcuts.md";

      // Check if file exists and delete it first
      try {
        const existingFile = vault.getAbstractFileByPath(filePath);
        if (existingFile) {
          await this.app.fileManager.trashFile(existingFile);
        }
      } catch (deleteError) {
        console.warn(
          "[RSS Dashboard] Could not delete existing file:",
          filePath,
          deleteError,
        );
        // Continue anyway - vault.create might overwrite
      }

      // Create the file
      const file = await vault.create(filePath, content);

      new Notice(t("modal.shortcuts.saved", { path: file.path }));
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(
        "[RSS Dashboard] Failed to save keyboard shortcuts:",
        errorMsg,
      );
      new Notice(t("modal.shortcuts.saveFailed", { error: errorMsg }));
    }
  }

  private renderSection(
    container: HTMLElement,
    title: string,
    items: Array<{ key: string; desc: string }>,
  ) {
    const section = container.createDiv({ cls: "rss-shortcut-section" });
    section.createEl("h3", { text: this.localizeShortcut(title) });

    const grid = section.createDiv({ cls: "rss-shortcut-grid" });
    items.forEach((item) => {
      const row = grid.createDiv({ cls: "rss-shortcut-row" });
      row.createDiv({ cls: "rss-shortcut-desc", text: this.localizeShortcut(item.desc) });
      const keyContainer = row.createDiv({
        cls: "rss-shortcut-key-container",
      });
      keyContainer.createEl("kbd", { text: item.key });
    });
  }

  onClose() {
    this.contentEl.empty();
  }

  private localizeShortcut(value: string): string {
    return this.settings?.locale === "zh-CN"
      ? this.chineseShortcutText[value] ?? value
      : value;
  }
}

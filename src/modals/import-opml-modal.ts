import { Modal, App, Setting, Notice, setIcon } from "obsidian";
import type RssDashboardPlugin from "../../main";
import type { Feed, Folder } from "../types/types";
import { OpmlManager } from "../services/opml-manager";
import { shouldUseMobileSidebarLayout } from "../utils/platform-utils";
import type { OpmlImportPreviewFolderSnapshot } from "../services/opml-import-preview-model";
import { OpmlImportPreviewModel } from "../services/opml-import-preview-model";
import { isValidFeedTitle, isValidFolderName } from "../utils/validation";
import { createTranslator } from "../i18n";

/**
 * Import OPML Modal - Provides a preview-based import experience
 * Allows users to select, validate, preview, and import OPML files
 */
export class ImportOpmlModal extends Modal {
  plugin: RssDashboardPlugin;
  private readonly onImportStarted?: () => void;

  private static readonly OPML_CLEANER_URL =
    "https://www.freecodeformat.com/opml-to-format.php";

  // State
  private selectedFile: File | null = null;
  private opmlContent: string | null = null;
  private parsedFeeds: Feed[] = [];
  private parsedFolders: Folder[] = [];
  private validationError: string | null = null;
  private importMode: "update" | "overwrite" = "update";
  private validationErrorKind:
    | "invalid_extension"
    | "invalid_xml"
    | "missing_opml"
    | "missing_body"
    | "parse_failed"
    | "no_feeds"
    | null = null;
  private previewModel: OpmlImportPreviewModel | null = null;
  private collapsedFolderPaths = new Set<string>();

  // UI References
  private filePathInput!: HTMLInputElement;
  private previewContainer!: HTMLDivElement;
  private errorContainer!: HTMLDivElement;
  private importButton!: HTMLButtonElement;
  private modeSelectorContainer!: HTMLDivElement;

  constructor(
    app: App,
    plugin: RssDashboardPlugin,
    onImportStarted?: () => void,
  ) {
    super(app);
    this.plugin = plugin;
    this.onImportStarted = onImportStarted;
  }

  private t = (
    key: Parameters<ReturnType<typeof createTranslator>>[0],
    params?: Record<string, string | number>,
  ) => createTranslator(this.plugin.settings.locale ?? "zh-CN")(key, params);

  onOpen() {
    const { contentEl } = this;
    const isMobile = shouldUseMobileSidebarLayout();

    this.modalEl.addClasses([
      "rss-dashboard-modal",
      "rss-dashboard-modal-container",
    ]);
    this.modalEl.addClass("rss-import-opml-modal");
    if (isMobile) {
      this.modalEl.addClass("rss-mobile-import-opml-modal");
    }

    contentEl.empty();
    new Setting(contentEl).setName(this.t("modal.opml.title")).setHeading();

    // Add subtitle
    const subtitle = contentEl.createDiv({ cls: "add-feed-subtitle" });
    subtitle.textContent = this.t("modal.opml.desc");

    // File selector row
    this.createFileSelector(contentEl);

    // Error container (hidden by default)
    this.errorContainer = contentEl.createDiv({
      cls: "import-error-container import-hidden",
    });

    // Preview container (hidden by default)
    this.previewContainer = contentEl.createDiv({
      cls: "import-preview-container import-hidden",
    });

    // Import mode selector (hidden by default)
    this.modeSelectorContainer = contentEl.createDiv({
      cls: "import-mode-selector import-hidden",
    });
    this.createModeSelector(this.modeSelectorContainer);

    // Button container
    const buttonContainer = contentEl.createDiv({
      cls: "rss-dashboard-modal-buttons",
    });

    const cancelButton = buttonContainer.createEl("button", {
      text: this.t("common.cancel"),
    });
    cancelButton.onclick = () => this.close();

    this.importButton = buttonContainer.createEl("button", {
      text: this.t("modal.opml.importFeeds"),
      cls: "rss-dashboard-primary-button",
    });
    this.importButton.disabled = true;
    this.importButton.onclick = () => {
      if (this.importMode === "overwrite") {
        this.showOverwriteWarning();
      } else {
        void this.executeImport();
      }
    };
  }

  private createFileSelector(contentEl: HTMLElement) {
    const fileSelector = contentEl.createDiv({
      cls: "import-file-selector",
    });

    // File path input (disabled, shows selected file path)
    this.filePathInput = fileSelector.createEl("input", {
      type: "text",
      cls: "import-file-path-input",
      attr: {
        placeholder: this.t("modal.opml.noFile"),
        disabled: "true",
      },
    });

    // Import file button
    const fileButton = fileSelector.createEl("button", {
      cls: "import-file-button",
    });
    setIcon(fileButton, "folder-open");
    fileButton.createSpan({ text: ` ${this.t("modal.opml.importFile")}` });
    fileButton.onclick = () => this.openFilePicker();
  }

  private openFilePicker() {
    const input = activeDocument.body.createEl("input", {
      attr: { type: "file", accept: ".opml,.xml,.backup" },
    });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) {
        await this.handleFileSelection(file);
      }
      input.remove();
    };
    input.click();
  }
  private async handleFileSelection(file: File) {
    this.selectedFile = file;
    this.filePathInput.value = file.name;

    // Clear previous state
    this.validationError = null;
    this.validationErrorKind = null;
    this.parsedFeeds = [];
    this.parsedFolders = [];
    this.opmlContent = null;
    this.previewModel = null;
    this.collapsedFolderPaths.clear();

    // Validate and parse
    await this.validateAndParseFile(file);

    // Update UI
    this.updateUI();
  }

  private async validateAndParseFile(file: File): Promise<void> {
    // Check file extension
    const fileName = file.name.toLowerCase();
    if (
      !fileName.endsWith(".opml") &&
      !fileName.endsWith(".xml") &&
      !fileName.endsWith(".backup")
    ) {
      this.validationError = this.t("modal.opml.invalidExtension");
      this.validationErrorKind = "invalid_extension";
      return;
    }

    try {
      const content = await file.text();

      // Basic XML validation
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(content, "text/xml");

      // Check for parsing errors
      const parseError = xmlDoc.querySelector("parsererror");
      if (parseError) {
        this.validationError = this.t("modal.opml.invalidXml");
        this.validationErrorKind = "invalid_xml";
        return;
      }

      // Check for OPML structure
      const opmlRoot = xmlDoc.querySelector("opml");
      if (!opmlRoot) {
        this.validationError = this.t("modal.opml.missingRoot");
        this.validationErrorKind = "missing_opml";
        return;
      }

      const body = xmlDoc.querySelector("body");
      if (!body) {
        this.validationError = this.t("modal.opml.missingBody");
        this.validationErrorKind = "missing_body";
        return;
      }

      // Parse the valid OPML
      try {
        const result = OpmlManager.parseOpml(content);
        this.parsedFeeds = result.feeds;
        this.parsedFolders = result.folders;
        this.opmlContent = content;
        this.validationError = null;
        this.validationErrorKind = null;

        const existingUrls = new Set(
          this.plugin.settings.feeds.map((f) => f.url),
        );
        this.previewModel = new OpmlImportPreviewModel({
          feeds: this.parsedFeeds,
          folders: this.parsedFolders,
          importMode: this.importMode,
          existingUrls,
        });
      } catch (error) {
        console.error("[RSS Dashboard] Failed to parse OPML:", error);
        this.validationError = this.t("modal.opml.parseFailed");
        this.validationErrorKind = "parse_failed";
        return;
      }
    } catch (error) {
      console.error("[RSS Dashboard] Failed to read OPML file:", error);
      this.validationError = this.t("modal.opml.readFailed");
      this.validationErrorKind = "parse_failed";
    }
  }

  private updateUI() {
    // Update error container
    if (this.validationError) {
      this.errorContainer.removeClass("import-hidden");
      this.errorContainer.addClass("import-visible");
      this.errorContainer.empty();
      const errorDiv = this.errorContainer.createDiv({
        cls: "import-error-message",
      });
      errorDiv.textContent = this.validationError;

      if (
        this.validationErrorKind === "invalid_xml" ||
        this.validationErrorKind === "missing_opml" ||
        this.validationErrorKind === "missing_body" ||
        this.validationErrorKind === "parse_failed"
      ) {
        this.renderOpmlCleanerSuggestion(this.errorContainer);
      }

      // Hide preview and mode selector
      this.previewContainer.removeClass("import-visible");
      this.previewContainer.addClass("import-hidden");
      this.modeSelectorContainer.removeClass("import-visible");
      this.modeSelectorContainer.addClass("import-hidden");
      this.importButton.disabled = true;
    } else if (this.parsedFeeds.length > 0 && this.previewModel) {
      // Hide error
      this.errorContainer.removeClass("import-visible");
      this.errorContainer.addClass("import-hidden");

      // Show preview
      this.renderPreview();

      // Show mode selector
      this.modeSelectorContainer.removeClass("import-hidden");
      this.modeSelectorContainer.addClass("import-visible");

      this.updateImportButtonFromModel();
    } else {
      // No feeds found
      this.errorContainer.removeClass("import-hidden");
      this.errorContainer.addClass("import-visible");
      this.errorContainer.empty();
      const errorDiv = this.errorContainer.createDiv({
        cls: "import-error-message",
      });
      errorDiv.textContent = this.t("modal.opml.noFeeds");
      this.validationErrorKind = "no_feeds";
      this.previewContainer.removeClass("import-visible");
      this.previewContainer.addClass("import-hidden");
      this.modeSelectorContainer.removeClass("import-visible");
      this.modeSelectorContainer.addClass("import-hidden");
      this.importButton.disabled = true;
    }
  }

  private renderPreview() {
    const model = this.previewModel;
    if (!model) return;

    // Preserve scroll position across re-renders
    const existingList = this.previewContainer.querySelector<HTMLDivElement>(
      ".import-preview-list",
    );
    const previousScrollTop = existingList?.scrollTop ?? 0;

    this.previewContainer.removeClass("import-hidden");
    this.previewContainer.addClass("import-visible");
    this.previewContainer.empty();

    const stats = model.getStats();

    const header = this.previewContainer.createDiv({
      cls: "import-preview-header",
    });
    header.createEl("h4", { text: this.t("modal.opml.preview") });

    const badges = header.createDiv({ cls: "import-preview-badges" });
    badges.createDiv({
      cls: "import-preview-count",
      text: this.t("modal.opml.feedCount", { count: stats.totalFeeds }),
    });
    badges.createDiv({
      cls: "import-preview-count import-preview-count--primary",
      text: this.t("modal.opml.toImport", {
        count: stats.selectedImportableFeeds,
      }),
    });
    if (this.importMode === "update" && stats.duplicateFeeds > 0) {
      badges.createDiv({
        cls: "import-preview-count",
        text: this.t("modal.opml.alreadyExist", {
          count: stats.duplicateFeeds,
        }),
      });
    }

    const toolbar = this.previewContainer.createDiv({
      cls: "import-preview-toolbar",
    });

    const makeButton = (
      text: string,
      iconName: string,
      onClick: () => void,
    ) => {
      const btn = toolbar.createEl("button");
      setIcon(btn, iconName);
      btn.createSpan({ text });
      btn.onclick = onClick;
      return btn;
    };

    makeButton(this.t("modal.opml.selectAll"), "check-square", () => {
      const urls = this.collectAllFeedUrls(model.getFolderTree());
      urls.forEach((url) => model.toggleFeed(url, true));
      this.renderPreview();
      this.updateImportButtonFromModel();
    });

    makeButton(this.t("modal.opml.selectNone"), "square", () => {
      const urls = this.collectAllFeedUrls(model.getFolderTree());
      urls.forEach((url) => model.toggleFeed(url, false));
      this.renderPreview();
      this.updateImportButtonFromModel();
    });

    makeButton(this.t("modal.opml.expandAll"), "chevrons-down", () => {
      this.collapsedFolderPaths.clear();
      this.renderPreview();
    });

    makeButton(this.t("modal.opml.collapseAll"), "chevrons-up", () => {
      this.collapsedFolderPaths = new Set(
        this.collectAllFolderPaths(model.getFolderTree()),
      );
      this.renderPreview();
    });

    makeButton(this.t("modal.opml.autoFix"), "wand-2", () => {
      model.autoFixInvalidNames();
      this.renderPreview();
      this.updateImportButtonFromModel();
    });

    const list = this.previewContainer.createDiv({
      cls: "import-preview-list import-preview-tree",
    });
    list.scrollTop = previousScrollTop;

    const tree = model.getFolderTree();
    for (const node of tree) {
      this.renderFolderNode(list, node, 0);
    }
  }

  private updateImportButtonFromModel(): void {
    if (!this.previewModel) {
      this.importButton.disabled = true;
      this.importButton.textContent = this.t("modal.opml.importFeeds");
      return;
    }

    const stats = this.previewModel.getStats();
    const count = stats.selectedImportableFeeds;

    this.importButton.textContent =
      count === 1
        ? this.t("modal.opml.importOne")
        : this.t("modal.opml.importCount", { count });
    this.importButton.disabled = count === 0 || stats.hasBlockingErrors;
    this.importButton.classList.toggle(
      "is-disabled",
      this.importButton.disabled,
    );

    if (stats.hasBlockingErrors) {
      this.importButton.title = this.t("modal.opml.fixBefore");
    } else if (count === 0) {
      this.importButton.title = this.t("modal.opml.selectBefore");
    } else {
      this.importButton.title = "";
    }
  }

  private renderOpmlCleanerSuggestion(container: HTMLElement): void {
    const wrapper = container.createDiv({
      cls: "import-opml-cleaner-suggestion",
    });
    wrapper.createEl("div", {
      cls: "import-opml-cleaner-title",
      text: this.t("modal.opml.cleanTip"),
    });
    const row = wrapper.createDiv({ cls: "import-opml-cleaner-row" });
    const link = row.createEl("a", {
      cls: "import-opml-cleaner-link",
      text: ImportOpmlModal.OPML_CLEANER_URL,
      href: ImportOpmlModal.OPML_CLEANER_URL,
    });
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");

    const external = row.createDiv({
      cls: "clickable-icon import-opml-cleaner-external",
      attr: {
        role: "button",
        tabindex: "0",
        "aria-label": this.t("modal.opml.openCleaner"),
        title: this.t("modal.opml.openCleaner"),
      },
    });
    setIcon(external, "external-link");

    const open = () => {
      const opened = activeWindow.open(
        ImportOpmlModal.OPML_CLEANER_URL,
        "_blank",
        "noopener,noreferrer",
      );
      if (!opened) {
        new Notice(
          this.t("modal.opml.cleanerOpenFailed", {
            url: ImportOpmlModal.OPML_CLEANER_URL,
          }),
        );
      }
    };

    external.addEventListener("click", (e) => {
      e.preventDefault();
      open();
    });
    external.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  }

  private collectAllFeedUrls(
    tree: OpmlImportPreviewFolderSnapshot[],
  ): string[] {
    const urls: string[] = [];
    const stack = [...tree];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) break;
      urls.push(...node.feedUrls);
      stack.push(...(node.children ?? []));
    }
    return urls;
  }

  private collectAllFolderPaths(
    tree: OpmlImportPreviewFolderSnapshot[],
  ): string[] {
    const paths: string[] = [];
    const stack = [...tree];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) break;
      paths.push(node.path);
      stack.push(...(node.children ?? []));
    }
    return paths;
  }

  private renderFolderNode(
    listEl: HTMLElement,
    node: OpmlImportPreviewFolderSnapshot,
    depth: number,
  ): void {
    if (!this.previewModel) return;

    const model = this.previewModel;
    const folderRow = listEl.createDiv({
      cls: "import-preview-row import-preview-row--folder",
    });
    folderRow.style.setProperty("--import-indent", `${depth * 14}px`);

    const checkbox = folderRow.createEl("input", {
      cls: "import-preview-checkbox",
      attr: { type: "checkbox" },
    });

    const folderSelection = model.getFolderSelectionState(node.path);
    checkbox.checked = folderSelection.checked;
    checkbox.indeterminate = folderSelection.indeterminate;

    const descendantUrls = this.collectAllFeedUrls([node]);
    checkbox.disabled = descendantUrls.length === 0;

    checkbox.addEventListener("change", () => {
      model.toggleFolder(node.path, checkbox.checked);
      this.renderPreview();
      this.updateImportButtonFromModel();
    });

    const icon = folderRow.createDiv({ cls: "import-preview-icon" });
    setIcon(icon, "folder");

    const nameWrap = folderRow.createDiv({ cls: "import-preview-name" });
    const nameText = nameWrap.createSpan({
      cls: "import-preview-name-text",
      text: node.name,
    });

    const nameValidation = isValidFolderName(node.name);
    if (!nameValidation.valid) {
      folderRow.addClass("is-invalid");
      nameText.setAttr("title", this.t("modal.opml.invalidFolder"));
    }

    const edit = nameWrap.createDiv({
      cls: "clickable-icon import-preview-edit",
      attr: {
        role: "button",
        tabindex: "0",
        "aria-label": this.t("modal.opml.renameFolder"),
        title: this.t("modal.opml.renameFolder"),
      },
    });
    setIcon(edit, "pencil");

    const startEdit = () => {
      const input = activeDocument.createElement("input");
      input.className = "import-preview-edit-input";
      input.value = node.name;
      nameText.replaceWith(input);
      input.focus();
      input.select();

      const commit = () => {
        const next = input.value.trim();
        const validation = isValidFolderName(next);
        if (!validation.valid) {
          input.classList.add("is-invalid");
          input.setAttribute("title", this.t("modal.opml.invalidFolder"));
          input.focus();
          return;
        }
        model.renameFolderSegment(node.path, next);
        this.renderPreview();
        this.updateImportButtonFromModel();
      };

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.renderPreview();
        }
      });
      input.addEventListener("blur", () => commit());
    };

    edit.addEventListener("click", (e) => {
      e.preventDefault();
      startEdit();
    });
    edit.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        startEdit();
      }
    });

    const meta = folderRow.createDiv({ cls: "import-preview-meta" });
    const selectedCount = descendantUrls.filter(
      (url) => model.getFeedState(url).selected,
    ).length;
    meta.textContent = `${selectedCount}/${descendantUrls.length}`;

    const hasChildren =
      (node.children?.length ?? 0) > 0 || node.feedUrls.length > 0;
    const collapsed = this.collapsedFolderPaths.has(node.path);
    const toggle = folderRow.createDiv({
      cls: "clickable-icon import-preview-toggle",
      attr: {
        role: "button",
        tabindex: hasChildren ? "0" : "-1",
        "aria-label": collapsed
          ? this.t("modal.opml.expandFolder")
          : this.t("modal.opml.collapseFolder"),
        title: collapsed
          ? this.t("modal.opml.expand")
          : this.t("modal.opml.collapse"),
      },
    });
    setIcon(toggle, collapsed ? "chevron-right" : "chevron-down");
    if (!hasChildren) {
      toggle.addClass("is-disabled");
    }

    const toggleCollapse = () => {
      if (!hasChildren) return;
      if (this.collapsedFolderPaths.has(node.path)) {
        this.collapsedFolderPaths.delete(node.path);
      } else {
        this.collapsedFolderPaths.add(node.path);
      }
      this.renderPreview();
    };

    toggle.addEventListener("click", (e) => {
      e.preventDefault();
      toggleCollapse();
    });
    toggle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleCollapse();
      }
    });

    if (collapsed) return;

    // Render feeds directly under this folder
    for (const url of node.feedUrls) {
      this.renderFeedRow(listEl, url, depth + 1);
    }

    // Render children folders
    for (const child of node.children ?? []) {
      this.renderFolderNode(listEl, child, depth + 1);
    }
  }

  private renderFeedRow(listEl: HTMLElement, url: string, depth: number): void {
    if (!this.previewModel) return;
    const model = this.previewModel;

    const { feed, selected, duplicate } = model.getFeedState(url);

    const row = listEl.createDiv({
      cls: "import-preview-row import-preview-row--feed",
    });
    row.style.setProperty("--import-indent", `${depth * 14}px`);

    const checkbox = row.createEl("input", {
      cls: "import-preview-checkbox",
      attr: { type: "checkbox" },
    });
    checkbox.checked = selected;
    checkbox.disabled = duplicate;
    checkbox.addEventListener("change", () => {
      model.toggleFeed(url, checkbox.checked);
      this.renderPreview();
      this.updateImportButtonFromModel();
    });

    const icon = row.createDiv({ cls: "import-preview-icon" });
    setIcon(icon, "rss");

    const nameWrap = row.createDiv({ cls: "import-preview-name" });
    const titleText = nameWrap.createSpan({
      cls: "import-preview-name-text",
      text: feed.title,
    });

    const titleValidation = isValidFeedTitle(feed.title);
    if (!titleValidation.valid && selected && !duplicate) {
      row.addClass("is-invalid");
      titleText.setAttr("title", this.t("modal.opml.invalidFeed"));
    }

    const edit = nameWrap.createDiv({
      cls: "clickable-icon import-preview-edit",
      attr: {
        role: "button",
        tabindex: "0",
        "aria-label": this.t("modal.opml.renameFeed"),
        title: this.t("modal.opml.renameFeed"),
      },
    });
    setIcon(edit, "pencil");

    const startEdit = () => {
      const input = activeDocument.createElement("input");
      input.className = "import-preview-edit-input";
      input.value = feed.title;
      titleText.replaceWith(input);
      input.focus();
      input.select();

      const commit = () => {
        const next = input.value;
        const validation = isValidFeedTitle(next);
        if (!validation.valid) {
          input.classList.add("is-invalid");
          input.setAttribute("title", this.t("modal.opml.invalidFeed"));
          input.focus();
          return;
        }
        model.renameFeedTitle(url, next);
        this.renderPreview();
        this.updateImportButtonFromModel();
      };

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.renderPreview();
        }
      });
      input.addEventListener("blur", () => commit());
    };

    edit.addEventListener("click", (e) => {
      e.preventDefault();
      startEdit();
    });
    edit.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        startEdit();
      }
    });

    const meta = row.createDiv({ cls: "import-preview-meta" });
    if (this.importMode === "update" && duplicate) {
      meta.textContent = this.t("modal.opml.alreadyExists");
      row.addClass("is-duplicate");
    } else if (!titleValidation.valid && selected) {
      meta.textContent = this.t("modal.opml.needsFix");
    } else {
      meta.textContent = "";
    }

    // Keep grid alignment: empty toggle cell
    row.createDiv({ cls: "import-preview-toggle-spacer" });
  }

  private createModeSelector(container: HTMLElement) {
    container.empty();

    const label = container.createDiv({ cls: "import-mode-label" });
    label.textContent = this.t("modal.opml.mode");

    const optionsWrapper = container.createDiv({ cls: "import-mode-options" });

    // Update option - click to select
    const updateOption = optionsWrapper.createDiv({
      cls: "import-mode-option selected",
    });
    const updateContent = updateOption.createDiv({
      cls: "import-mode-option-content",
    });
    updateContent.createEl("div", {
      cls: "import-mode-option-title",
      text: this.t("modal.opml.update"),
    });
    updateContent.createEl("div", {
      cls: "import-mode-option-desc",
      text: this.t("modal.opml.updateDesc"),
    });

    // Overwrite option - click to select
    const overwriteOption = optionsWrapper.createDiv({
      cls: "import-mode-option",
    });
    const overwriteContent = overwriteOption.createDiv({
      cls: "import-mode-option-content",
    });
    overwriteContent.createEl("div", {
      cls: "import-mode-option-title",
      text: this.t("modal.opml.overwrite"),
    });
    overwriteContent.createEl("div", {
      cls: "import-mode-option-desc",
      text: this.t("modal.opml.overwriteDesc"),
    });

    // Add click handlers after elements are created
    updateOption.onclick = () => {
      this.importMode = "update";
      updateOption.addClass("selected");
      overwriteOption.removeClass("selected");

      if (this.previewModel) {
        const existingUrls = new Set(
          this.plugin.settings.feeds.map((f) => f.url),
        );
        this.previewModel.setImportMode("update", existingUrls);
        this.renderPreview();
        this.updateImportButtonFromModel();
      }
    };

    overwriteOption.onclick = () => {
      this.importMode = "overwrite";
      overwriteOption.addClass("selected");
      updateOption.removeClass("selected");

      if (this.previewModel) {
        this.previewModel.setImportMode("overwrite", new Set());
        this.renderPreview();
        this.updateImportButtonFromModel();
      }
    };
  }

  private showOverwriteWarning() {
    // Create overlay modal that appears ON TOP of the import modal
    const overlay = activeDocument.body.createDiv({
      cls: "rss-dashboard-modal-overlay",
    });

    const modal = overlay.createDiv({
      cls: "rss-dashboard-modal rss-dashboard-modal-container rss-dashboard-confirm-modal",
    });
    const modalContent = modal.createDiv({
      cls: "rss-dashboard-modal-content",
    });

    new Setting(modalContent)
      .setName(this.t("modal.opml.overwriteTitle"))
      .setHeading();

    // Warning message
    const warningDiv = modalContent.createDiv({
      cls: "delete-all-warning",
    });
    warningDiv.createEl("p", {
      text: this.t("modal.opml.overwriteWarning"),
    });

    // Backup recommendation
    const backupDiv = modalContent.createDiv({
      cls: "delete-all-backup-notice",
    });
    backupDiv.createEl("strong", {
      text: this.t("modal.opml.backupTitle"),
    });
    backupDiv.createEl("p", {
      text: this.t("modal.opml.backupDesc"),
    });

    // Button container
    const buttonContainer = modalContent.createDiv({
      cls: "rss-dashboard-modal-buttons",
    });

    // Export OPML button
    const exportBtn = buttonContainer.createEl("button", {
      text: this.t("modal.feedManager.export"),
      cls: "rss-dashboard-primary-button export-opml-btn",
    });
    exportBtn.onclick = () => {
      this.plugin.exportOpml();
    };

    const cancelButton = buttonContainer.createEl("button", {
      text: this.t("common.cancel"),
    });
    cancelButton.onclick = () => {
      activeDocument.body.removeChild(overlay);
    };

    const confirmButton = buttonContainer.createEl("button", {
      text: this.t("modal.opml.overwriteFeeds"),
      cls: "rss-dashboard-danger-button",
    });
    confirmButton.onclick = () => {
      activeDocument.body.removeChild(overlay);
      void this.executeImport();
    };
  }

  private async executeImport() {
    if (!this.previewModel) {
      return;
    }

    try {
      const selectedFeeds = this.previewModel.getSelectedImportableFeeds();
      if (selectedFeeds.length === 0) {
        return;
      }

      const derivedFolders =
        this.previewModel.getDerivedFoldersForSelectedFeeds();
      const result = await this.plugin.ingestFeedsForBackgroundImport(
        selectedFeeds,
        {
          mode: this.importMode,
          folders: derivedFolders,
        },
      );

      this.onImportStarted?.();

      if (this.importMode === "update" && result.addedCount === 0) {
        new Notice(this.t("modal.opml.noFeeds"));
        this.close();
        return;
      }

      new Notice(
        this.t(
          this.importMode === "overwrite"
            ? "modal.opml.overwriteSuccess"
            : "modal.opml.updateSuccess",
          {
            count: selectedFeeds.length,
          },
        ),
      );

      this.close();
    } catch (error) {
      console.error("[RSS Dashboard] OPML import failed:", error);
      new Notice(this.t("modal.opml.importFailed"));
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

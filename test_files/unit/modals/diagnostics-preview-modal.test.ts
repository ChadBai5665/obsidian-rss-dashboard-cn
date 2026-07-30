import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { DiagnosticsPreviewModal } from "../../../src/modals/diagnostics-preview-modal";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

function button(modal: DiagnosticsPreviewModal, label: string): HTMLButtonElement {
  const match = Array.from(modal.contentEl.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
});

describe("DiagnosticsPreviewModal", () => {
  it("shows the exact immutable preview before any copy action", () => {
    const preview = '{\n  "pluginVersion": "0.1.0"\n}';
    const copyPreview = vi.fn(async () => {});
    const modal = new DiagnosticsPreviewModal(new App(), {
      locale: "en",
      preview: { token: "one", text: preview },
      copyPreview,
      revokePreview: vi.fn(),
    });
    modal.open();

    expect(modal.contentEl.textContent).toContain("Review diagnostics before copying");
    expect(modal.contentEl.querySelector("pre")?.textContent).toBe(preview);
    expect(copyPreview).not.toHaveBeenCalled();
  });

  it("closing or cancelling performs zero clipboard writes", () => {
    const copyPreview = vi.fn(async () => {});
    const revokePreview = vi.fn();
    const modal = new DiagnosticsPreviewModal(new App(), {
      locale: "zh-CN",
      preview: { token: "one", text: "SAFE PREVIEW" },
      copyPreview,
      revokePreview,
    } as unknown as ConstructorParameters<typeof DiagnosticsPreviewModal>[1]);
    modal.open();
    button(modal, "取消").click();
    expect(copyPreview).not.toHaveBeenCalled();
    expect(revokePreview).toHaveBeenCalledWith("one");

    const second = new DiagnosticsPreviewModal(new App(), {
      locale: "zh-CN",
      preview: { token: "two", text: "SAFE PREVIEW" },
      copyPreview,
      revokePreview,
    } as unknown as ConstructorParameters<typeof DiagnosticsPreviewModal>[1]);
    second.open();
    second.close();
    expect(copyPreview).not.toHaveBeenCalled();
    expect(revokePreview).toHaveBeenCalledWith("two");
  });

  it("copies exactly once only after the separate explicit confirmation", async () => {
    const preview = "EXACT SAFE PREVIEW";
    const copyPreview = vi.fn(async () => {});
    const modal = new DiagnosticsPreviewModal(new App(), {
      locale: "en",
      preview: { token: "one", text: preview },
      copyPreview,
      revokePreview: vi.fn(),
    });
    modal.open();
    const copy = button(modal, "Copy diagnostics");
    copy.click();
    copy.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(copyPreview).toHaveBeenCalledTimes(1);
    expect(copyPreview).toHaveBeenCalledWith("one", preview);
  });

  it("reuses the immutable preview flow with operation-journal copy", async () => {
    const preview = "SAFE AGGREGATE JOURNAL";
    const copyPreview = vi.fn(async () => {});
    const modal = new DiagnosticsPreviewModal(new App(), {
      locale: "en",
      kind: "operation-journal",
      preview: Object.freeze({ token: "journal-one", text: preview }),
      copyPreview,
      revokePreview: vi.fn(),
    });
    modal.open();

    expect(modal.contentEl.textContent).toContain(
      "Review sanitized operation journal",
    );
    const rendered = modal.contentEl.querySelector("pre");
    expect(rendered?.textContent).toBe(preview);
    expect(rendered?.hasAttribute("contenteditable")).toBe(false);
    expect(copyPreview).not.toHaveBeenCalled();

    button(modal, "Copy sanitized journal").click();
    await Promise.resolve();
    await Promise.resolve();
    expect(copyPreview).toHaveBeenCalledWith("journal-one", preview);
  });

  it("contains a rejected copy dependency and still closes safely", async () => {
    const modal = new DiagnosticsPreviewModal(new App(), {
      locale: "en",
      preview: { token: "one", text: "SAFE" },
      copyPreview: vi.fn(async () => {
        throw new Error("clipboard dependency failed");
      }),
      revokePreview: vi.fn(),
    });
    const closeSpy = vi.spyOn(modal, "close");
    modal.open();

    button(modal, "Copy diagnostics").click();
    await flushPromises();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

import { App } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OperationJournalClearModal } from "../../../src/modals/operation-journal-clear-modal";
import { installObsidianDomPolyfills } from "../test-dom-polyfills";

function button(
  modal: OperationJournalClearModal,
  label: string,
): HTMLButtonElement {
  const match = Array.from(modal.contentEl.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  installObsidianDomPolyfills();
  document.body.empty();
  vi.restoreAllMocks();
});

describe("OperationJournalClearModal", () => {
  it("states the exact seven data groups that clearing will preserve", () => {
    const modal = new OperationJournalClearModal(new App(), {
      locale: "en",
      clear: vi.fn(async () => {}),
      onCleared: vi.fn(),
    });
    modal.open();

    const preserved = Array.from(modal.contentEl.querySelectorAll("li")).map(
      (item) => item.textContent,
    );
    expect(preserved).toEqual([
      "Configuration",
      "Keys",
      "Subscriptions",
      "Transcripts",
      "Collection and history",
      "AI analyses",
      "Markdown files",
    ]);
  });

  it("cancels without calling clear", () => {
    const clear = vi.fn(async () => {});
    const modal = new OperationJournalClearModal(new App(), {
      locale: "en",
      clear,
      onCleared: vi.fn(),
    });
    modal.open();

    button(modal, "Cancel").click();

    expect(clear).not.toHaveBeenCalled();
  });

  it("allows only one clear while confirmation is pending", async () => {
    const pending = deferred<void>();
    const clear = vi.fn(() => pending.promise);
    const onCleared = vi.fn();
    const modal = new OperationJournalClearModal(new App(), {
      locale: "en",
      clear,
      onCleared,
    });
    modal.open();
    const confirm = button(modal, "Clear operation journal");

    confirm.click();
    confirm.click();

    await Promise.resolve();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(confirm.disabled).toBe(true);
    pending.resolve();
    await pending.promise;
    await flushPromises();
    expect(onCleared).toHaveBeenCalledTimes(1);
  });

  it("stays open on failure and never claims records were deleted", async () => {
    const onCleared = vi.fn();
    const modal = new OperationJournalClearModal(new App(), {
      locale: "en",
      clear: vi.fn(async () => {
        throw new Error("PRIVATE_PATH_CANARY");
      }),
      onCleared,
    });
    const closeSpy = vi.spyOn(modal, "close");
    modal.open();

    button(modal, "Clear operation journal").click();
    await flushPromises();

    expect(closeSpy).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toContain(
      "Cleanup did not finish. Records may have partially changed. Check the operation journal and try again.",
    );
    expect(modal.contentEl.textContent).not.toContain("PRIVATE_PATH_CANARY");
    expect(modal.contentEl.textContent).not.toContain("Records cleared");
    expect(onCleared).not.toHaveBeenCalled();
    expect(button(modal, "Clear operation journal").disabled).toBe(false);
  });

  it("closes before requesting the post-clear refresh", async () => {
    const order: string[] = [];
    const modal = new OperationJournalClearModal(new App(), {
      locale: "en",
      clear: vi.fn(async () => {
        order.push("clear");
      }),
      onCleared: vi.fn(() => {
        order.push("refresh");
      }),
    });
    vi.spyOn(modal, "close").mockImplementation(() => {
      order.push("close");
      modal.onClose();
    });
    modal.open();

    button(modal, "Clear operation journal").click();
    await flushPromises();

    expect(order).toEqual(["clear", "close", "refresh"]);
  });

  it("refreshes business state after pending clear succeeds even if the modal closed", async () => {
    const pending = deferred<void>();
    const onCleared = vi.fn();
    const modal = new OperationJournalClearModal(new App(), {
      locale: "en",
      clear: vi.fn(() => pending.promise),
      onCleared,
    });
    modal.open();
    button(modal, "Clear operation journal").click();
    modal.close();

    pending.resolve();
    await pending.promise;
    await flushPromises();

    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(modal.contentEl.childElementCount).toBe(0);
  });
});

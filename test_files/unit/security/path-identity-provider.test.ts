import {
  mkdtemp,
  link,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, TFile } from "obsidian";
import {
  VaultPathIdentityProvider,
} from "../../../src/security/path-identity-provider";

const temporaryRoots: string[] = [];

function makeDesktopApp(root: string): App {
  return {
    vault: {
      adapter: {
        getBasePath: () => root,
        getFullPath: (controlledPath: string) =>
          path.join(root, controlledPath),
        exists: async () => false,
      },
      getAbstractFileByPath: () => null,
    },
  } as unknown as App;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rss-path-identity-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("VaultPathIdentityProvider", () => {
  it.each([
    "/RSS/data.json",
    "C:/RSS/data.json",
    "\\\\server\\share\\data.json",
    "RSS/../data.json",
    "RSS/data.json ",
    "RSS/data.json.",
    "RSS/con",
    "RSS/e\u0301.json",
  ])("rejects unsafe controlled path %s without normalizing it", async (candidate) => {
    const provider = new VaultPathIdentityProvider(makeDesktopApp(await makeRoot()));
    await expect(provider.inspect(candidate)).rejects.toThrow();
  });

  it("rejects case-fold aliases at every path prefix", async () => {
    const provider = new VaultPathIdentityProvider(makeDesktopApp(await makeRoot()));
    await expect(
      provider.assertSafePaths(["RSS/one.json", "rss/two.json"]),
    ).rejects.toThrow();
  });

  it("rejects a virtual target whose insensitive lookup succeeds but exact-case lookup fails", async () => {
    const app = {
      vault: {
        adapter: {
          exists: async (candidate: string, sensitive?: boolean) =>
            candidate === "rss" || candidate === "rss/data.json"
              ? sensitive !== true
              : false,
        },
        getAbstractFileByPath: () => null,
      },
    } as unknown as App;
    const provider = new VaultPathIdentityProvider(app);

    await expect(provider.inspect("rss/data.json")).rejects.toThrow();
  });

  it.each(["internal", "external"] as const)(
    "rejects an %s symlink below the trusted vault root",
    async (mode) => {
      const root = await makeRoot();
      const external = await makeRoot();
      await mkdir(path.join(root, "safe"));
      await symlink(
        mode === "internal" ? path.join(root, "safe") : external,
        path.join(root, "alias"),
      );
      const provider = new VaultPathIdentityProvider(makeDesktopApp(root));
      await expect(provider.inspect("alias/data.json")).rejects.toThrow();
    },
  );

  it("rejects two controlled paths that hardlink the same file", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "RSS"));
    const first = path.join(root, "RSS", "one.json");
    await writeFile(first, "same inode");
    await link(first, path.join(root, "RSS", "two.json"));
    const provider = new VaultPathIdentityProvider(makeDesktopApp(root));

    await expect(
      provider.assertSafePaths(["RSS/one.json", "RSS/two.json"]),
    ).rejects.toThrow();
  });

  it("rejects a controlled file with an unlisted hardlink alias", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "RSS"));
    const controlled = path.join(root, "RSS", "one.json");
    await writeFile(controlled, "same inode");
    await link(controlled, path.join(root, "outside-journal.json"));
    const provider = new VaultPathIdentityProvider(makeDesktopApp(root));

    await expect(provider.inspect("RSS/one.json")).rejects.toThrow();
  });

  it("creates a desktop rollback file exclusively and never replaces a winner", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "RSS"));
    const provider = new VaultPathIdentityProvider(makeDesktopApp(root));
    const identity = await provider.createExclusive(
      "RSS/restored.json",
      "RESTORED",
    );
    expect(identity).toMatchObject({
      kind: "file",
      destructiveSafe: true,
    });
    expect(
      await readFile(path.join(root, "RSS", "restored.json"), "utf8"),
    ).toBe("RESTORED");

    await expect(
      provider.createExclusive("RSS/restored.json", "OVERWRITE"),
    ).rejects.toThrow();
    expect(
      await readFile(path.join(root, "RSS", "restored.json"), "utf8"),
    ).toBe("RESTORED");
  });

  it("removes the exact directory when ownership marker creation fails", async () => {
    const app = App.createMock();
    const provider = new VaultPathIdentityProvider(app);
    vi.spyOn(app.vault, "create").mockRejectedValueOnce(
      new Error("marker-create-failure"),
    );

    await expect(
      provider.createOwnedDirectory(
        "Candidate",
        ".owner.json",
        "TOKEN",
      ),
    ).rejects.toThrow("marker-create-failure");

    expect(await app.vault.adapter.exists("Candidate")).toBe(false);
  });

  it("removes the exact marker and directory when ownership binding fails", async () => {
    const app = App.createMock();
    const provider = new VaultPathIdentityProvider(app);
    const inspect = provider.inspect.bind(provider);
    let markerObservations = 0;
    vi.spyOn(provider, "inspect").mockImplementation(async (candidate) => {
      if (candidate === "Candidate/.owner.json") {
        markerObservations += 1;
        if (markerObservations === 1) {
          return {
            path: candidate,
            namespaceKey: candidate.toLowerCase(),
            kind: "missing",
            destructiveSafe: false,
          };
        }
      }
      return inspect(candidate);
    });

    await expect(
      provider.createOwnedDirectory(
        "Candidate",
        ".owner.json",
        "TOKEN",
      ),
    ).rejects.toThrow("ownership could not be bound");

    expect(await app.vault.adapter.exists("Candidate/.owner.json")).toBe(false);
    expect(await app.vault.adapter.exists("Candidate")).toBe(false);
  });

  it("preserves a replacement marker and reports typed incomplete cleanup", async () => {
    const app = App.createMock();
    const provider = new VaultPathIdentityProvider(app);
    const originalCreate = app.vault.create.bind(app.vault);
    vi.spyOn(app.vault, "create").mockImplementation(
      async (candidate, contents) => {
        const created = await originalCreate(candidate, contents);
        if (candidate === "Candidate/.owner.json") {
          await app.vault.adapter.remove(candidate);
          await originalCreate(candidate, contents);
        }
        return created;
      },
    );

    await expect(
      provider.createOwnedDirectory(
        "Candidate",
        ".owner.json",
        "TOKEN",
      ),
    ).rejects.toMatchObject({
      name: "ControlledPathCleanupIncompleteError",
    });

    expect(
      app.vault.getAbstractFileByPath("Candidate/.owner.json"),
    ).toBeInstanceOf(TFile);
    expect(await app.vault.adapter.read("Candidate/.owner.json")).toBe("TOKEN");
    expect(await app.vault.adapter.exists("Candidate")).toBe(true);
  });
});

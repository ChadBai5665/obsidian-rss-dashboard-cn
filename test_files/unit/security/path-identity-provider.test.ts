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
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "obsidian";
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
});

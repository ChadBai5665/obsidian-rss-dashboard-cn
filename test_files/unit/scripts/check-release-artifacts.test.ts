import { Buffer } from "node:buffer";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RELEASE_BUNDLE_MAX_BYTES,
  checkReleaseArtifacts,
  stageReleaseArtifacts,
} from "../../../scripts/check-release-artifacts.mjs";
import {
  safeReleaseTextCases,
  unsafeReleaseTextCases,
} from "./release-safety-rule-fixtures";

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rss-release-artifacts-"));
  temporaryDirectories.push(root);
  await writeFile(root + "/main.js", "console.log('safe');\n");
  await writeFile(
    root + "/manifest.json",
    `${JSON.stringify({
      id: "rss-dashboard-cn",
      name: "RSS Dashboard CN",
      version: "0.1.0",
      minAppVersion: "1.1.0",
      isDesktopOnly: true,
    })}\n`,
  );
  await writeFile(root + "/styles.css", ".rss-dashboard { display: block; }\n");
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("release artifact validator", () => {
  it("stages exactly the standalone Obsidian files and validates byte identity", async () => {
    const root = await temporaryRoot();
    await stageReleaseArtifacts({ root });

    expect(await readdir(join(root, "release"))).toEqual([
      "main.js",
      "manifest.json",
      "styles.css",
    ]);
    expect(await readFile(join(root, "release/manifest.json"))).toEqual(
      await readFile(join(root, "manifest.json")),
    );
    expect(await readFile(join(root, "release/styles.css"))).toEqual(
      await readFile(join(root, "styles.css")),
    );
    await expect(checkReleaseArtifacts({ root })).resolves.toMatchObject({
      ok: true,
      errors: [],
    });
  });

  it("omits styles when the root has none and rejects stale or extra release files", async () => {
    const root = await temporaryRoot();
    await rm(join(root, "styles.css"));
    await mkdir(join(root, "release"));
    await writeFile(join(root, "release/stale.js"), "stale");

    await stageReleaseArtifacts({ root });
    expect(await readdir(join(root, "release"))).toEqual([
      "main.js",
      "manifest.json",
    ]);

    await writeFile(join(root, "release/extra.txt"), "extra");
    const result = await checkReleaseArtifacts({ root });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("release-extra-file:extra.txt");
  });

  it("check mode rejects missing, empty, mismatched, directory, and symlink artifacts", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "release"));
    await writeFile(join(root, "release/main.js"), "");
    await writeFile(join(root, "release/manifest.json"), "{}");
    await mkdir(join(root, "release/styles.css"));

    const invalid = await checkReleaseArtifacts({ root });
    expect(invalid.errors).toEqual(
      expect.arrayContaining([
        "release-empty-file:main.js",
        "release-manifest-mismatch:manifest.json",
        "release-not-file:styles.css",
      ]),
    );

    await rm(join(root, "release"), { recursive: true });
    await mkdir(join(root, "release"));
    await symlink(join(root, "main.js"), join(root, "release/main.js"));
    await writeFile(
      join(root, "release/manifest.json"),
      await readFile(join(root, "manifest.json")),
    );
    await writeFile(
      join(root, "release/styles.css"),
      await readFile(join(root, "styles.css")),
    );
    const symlinked = await checkReleaseArtifacts({ root });
    expect(symlinked.errors).toContain("release-symlink:main.js");
  });

  it("rejects private paths, credentials, source maps, and oversized bundles", async () => {
    for (const { rule, text: source } of unsafeReleaseTextCases) {
      const root = await temporaryRoot();
      await writeFile(join(root, "main.js"), source);
      await expect(stageReleaseArtifacts({ root })).rejects.toThrow(
        rule === "home-path" ? "bundle-private-path" : "bundle-credential",
      );
    }
    const safe = await temporaryRoot();
    await writeFile(join(safe, "main.js"), safeReleaseTextCases.join("\n"));
    await expect(stageReleaseArtifacts({ root: safe })).resolves.toMatchObject({
      ok: true,
    });

    const sourceMap = await temporaryRoot();
    await writeFile(join(sourceMap, "main.js"), "//# sourceMappingURL=main.js.map");
    await expect(stageReleaseArtifacts({ root: sourceMap })).rejects.toThrow(
      "bundle-source-map",
    );

    const oversized = await temporaryRoot();
    await writeFile(
      join(oversized, "main.js"),
      Buffer.alloc(RELEASE_BUNDLE_MAX_BYTES + 1, 0x61),
    );
    await expect(stageReleaseArtifacts({ root: oversized })).rejects.toThrow(
      "bundle-size-limit",
    );
  });

  it("preserves an existing valid release when staging validation or installation fails", async () => {
    const root = await temporaryRoot();
    await stageReleaseArtifacts({ root });
    const priorMain = await readFile(join(root, "release/main.js"));

    await writeFile(join(root, "main.js"), "Authorization: Bearer invalid-source");
    await expect(stageReleaseArtifacts({ root })).rejects.toThrow("bundle-credential");
    expect(await readFile(join(root, "release/main.js"))).toEqual(priorMain);

    await writeFile(join(root, "main.js"), "console.log('replacement');\n");
    await expect(
      stageReleaseArtifacts({
        root,
        hooks: {
          afterBackup() {
            throw new Error("simulated partial-stage failure");
          },
        },
      }),
    ).rejects.toThrow("simulated partial-stage failure");
    expect(await readFile(join(root, "release/main.js"))).toEqual(priorMain);
    expect(
      (await readdir(root)).filter((name) => name.startsWith(".release-stage-")),
    ).toEqual([]);
  });

  it("retains a named recovery copy when restoring the prior release fails", async () => {
    const root = await temporaryRoot();
    await stageReleaseArtifacts({ root });
    const priorMain = await readFile(join(root, "release/main.js"));
    await writeFile(join(root, "main.js"), "console.log('replacement');\n");
    let renameCalls = 0;

    await expect(
      stageReleaseArtifacts({
        root,
        hooks: {
          afterBackup() {
            throw new Error("simulated-install-failure");
          },
        },
        operations: {
          lstat,
          rename: async (source: string, destination: string) => {
            renameCalls += 1;
            if (
              renameCalls === 2 &&
              source.includes(".release-backup-") &&
              destination.endsWith("/release")
            ) {
              throw new Error("simulated-restore-failure");
            }
            await rename(source, destination);
          },
          rm,
        },
      }),
    ).rejects.toThrow(/release-recovery-required:.*\.release-backup-/);

    const recoveryName = (await readdir(root)).find((name) =>
      name.startsWith(".release-backup-"),
    );
    expect(recoveryName).toBeDefined();
    expect(await readFile(join(root, recoveryName!, "main.js"))).toEqual(
      priorMain,
    );
  });

  it("retains the prior release when backup cleanup fails", async () => {
    const root = await temporaryRoot();
    await stageReleaseArtifacts({ root });
    const priorMain = await readFile(join(root, "release/main.js"));
    await writeFile(join(root, "main.js"), "console.log('replacement');\n");

    await expect(
      stageReleaseArtifacts({
        root,
        operations: {
          rm: async (
            path: string,
            options?: Parameters<typeof rm>[1],
          ) => {
            if (path.includes(".release-backup-")) {
              throw new Error("simulated-backup-cleanup-failure");
            }
            await rm(path, options);
          },
        },
      }),
    ).rejects.toThrow(/release-recovery-required:.*\.release-backup-/);

    const recoveryName = (await readdir(root)).find((name) =>
      name.startsWith(".release-backup-"),
    );
    expect(recoveryName).toBeDefined();
    expect(await readFile(join(root, recoveryName!, "main.js"))).toEqual(
      priorMain,
    );
  });

  it("reports the primary failure and retained stage path when stage cleanup fails", async () => {
    const root = await temporaryRoot();
    await stageReleaseArtifacts({ root });
    await writeFile(join(root, "main.js"), "console.log('replacement');\n");

    await expect(
      stageReleaseArtifacts({
        root,
        hooks: {
          afterBackup() {
            throw new Error("simulated-primary-stage-failure");
          },
        },
        operations: {
          rm: async (
            path: string,
            options?: Parameters<typeof rm>[1],
          ) => {
            if (path.includes(".release-stage-")) {
              throw new Error("simulated-stage-cleanup-failure");
            }
            await rm(path, options);
          },
        },
      }),
    ).rejects.toThrow(
      /release-operation-failed:simulated-primary-stage-failure;release-recovery-required:.*\.release-stage-/,
    );

    expect(
      (await readdir(root)).some((name) => name.startsWith(".release-stage-")),
    ).toBe(true);
  });

  it("rejects root artifact symlinks without following them", async () => {
    const root = await temporaryRoot();
    const outside = join(root, "outside.js");
    await writeFile(outside, "console.log('outside');");
    await rm(join(root, "main.js"));
    await symlink(outside, join(root, "main.js"));

    await expect(stageReleaseArtifacts({ root })).rejects.toThrow(
      "source-symlink:main.js",
    );
  });

  it("check mode never mutates the release directory", async () => {
    const root = await temporaryRoot();
    await stageReleaseArtifacts({ root });
    const before = await Promise.all(
      (await readdir(join(root, "release"))).map(async (name) => [
        name,
        await readFile(join(root, "release", name)),
      ]),
    );

    await checkReleaseArtifacts({ root });

    const after = await Promise.all(
      (await readdir(join(root, "release"))).map(async (name) => [
        name,
        await readFile(join(root, "release", name)),
      ]),
    );
    expect(after).toEqual(before);
  });
});

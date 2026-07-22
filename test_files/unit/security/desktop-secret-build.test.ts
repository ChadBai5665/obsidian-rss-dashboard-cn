import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

describe("desktop secret build integration", () => {
  it("builds the secret-store entry with the production plugin config and retains Node builtins as externals", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "rss-secret-build-"));
    const outfile = join(outputDirectory, "secret-store.cjs");
    const script = [
      'import { build } from "esbuild";',
      'import { createPluginBuildOptions, nodeBuiltinExternals } from "./esbuild.config.mjs";',
      `await build(createPluginBuildOptions({ entryPoints: ["src/security/desktop-secret-store.ts"], outfile: ${JSON.stringify(outfile)}, production: true }));`,
      'process.stdout.write(JSON.stringify(nodeBuiltinExternals));',
    ].join(" ");

    try {
      const { stdout } = await promisify(execFileCallback)(process.execPath, ["--input-type=module", "-e", script], {
        cwd: process.cwd(),
      });
      const externals = JSON.parse(stdout) as string[];

      const bundle = await readFile(outfile, "utf8");
      expect(externals).toContain("node:fs/promises");
      expect(externals).toContain("node:path");
      expect(bundle).toContain('require("node:fs/promises")');
      expect(bundle).toContain('require("node:path")');
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});

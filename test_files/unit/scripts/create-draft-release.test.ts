import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

async function helper(): Promise<{
  buildReleaseArguments: (tag: string) => string[];
  runDraftRelease: (options: {
    tag?: string;
    execute: (command: string, arguments_: string[]) => void;
  }) => void;
}> {
  const url = pathToFileURL(
    join(process.cwd(), "scripts", "create-draft-release.mjs"),
  ).href;
  return import(/* @vite-ignore */ url);
}

describe("draft release helper", () => {
  it("builds fixed draft arguments for a stable tag", async () => {
    const { buildReleaseArguments } = await helper();
    const arguments_ = buildReleaseArguments("1.2.3");
    expect(arguments_).toEqual([
      "release",
      "create",
      "1.2.3",
      "--verify-tag",
      "--title",
      "1.2.3",
      "--notes",
      "Release 1.2.3",
      "--draft",
      "release/main.js",
      "release/manifest.json",
      "release/styles.css",
    ]);
  });

  it("marks a SemVer prerelease as prerelease", async () => {
    const { buildReleaseArguments } = await helper();
    expect(buildReleaseArguments("1.2.3-beta.1")).toContain("--prerelease");
  });

  it("does not treat hyphenated build metadata as prerelease", async () => {
    const { buildReleaseArguments } = await helper();
    expect(buildReleaseArguments("1.2.3+build-hyphen")).not.toContain(
      "--prerelease",
    );
  });

  it("keeps prerelease semantics when build metadata is present", async () => {
    const { buildReleaseArguments } = await helper();
    expect(buildReleaseArguments("1.2.3-rc.1+build-hyphen")).toContain(
      "--prerelease",
    );
  });

  it("rejects invalid or non-matching tag text", async () => {
    const { buildReleaseArguments } = await helper();
    for (const tag of ["0.1.0evil", "v1.2.3", "1.2.3\n"]) {
      expect(() => buildReleaseArguments(tag)).toThrow("release-tag-invalid");
    }
  });

  it("executes gh with fixed argv and propagates execution failure", async () => {
    const { runDraftRelease } = await helper();
    let captured: [string, string[]] | undefined;
    runDraftRelease({
      tag: "1.2.3",
      execute: (command, arguments_) => {
        captured = [command, arguments_];
      },
    });
    expect(captured?.[0]).toBe("gh");
    expect(captured?.[1].slice(0, 3)).toEqual(["release", "create", "1.2.3"]);
    expect(() =>
      runDraftRelease({
        tag: "1.2.3",
        execute: () => {
          throw new Error("synthetic execution failure");
        },
      }),
    ).toThrow("release-create-failed");
  });

  it("reads the release tag from GITHUB_REF_NAME by default", async () => {
    const { runDraftRelease } = await helper();
    const previous = process.env.GITHUB_REF_NAME;
    process.env.GITHUB_REF_NAME = "2.3.4";
    let tag: string | undefined;
    try {
      runDraftRelease({
        execute: (_command, arguments_) => {
          tag = arguments_[2];
        },
      });
    } finally {
      if (previous === undefined) delete process.env.GITHUB_REF_NAME;
      else process.env.GITHUB_REF_NAME = previous;
    }
    expect(tag).toBe("2.3.4");
  });
});

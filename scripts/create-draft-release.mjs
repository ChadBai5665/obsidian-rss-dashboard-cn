import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isStrictSemVer } from "./check-version-consistency.mjs";

export const RELEASE_ASSETS = Object.freeze([
  "release/main.js",
  "release/manifest.json",
  "release/styles.css",
]);

function hasPrerelease(tag) {
  return tag.split("+", 1)[0].includes("-");
}

export function buildReleaseArguments(tag) {
  if (!isStrictSemVer(tag)) throw new Error("release-tag-invalid");
  return [
    "release",
    "create",
    tag,
    "--verify-tag",
    "--title",
    tag,
    "--notes",
    `Release ${tag}`,
    "--draft",
    ...(hasPrerelease(tag) ? ["--prerelease"] : []),
    ...RELEASE_ASSETS,
  ];
}

export function runDraftRelease({
  tag = process.env.GITHUB_REF_NAME,
  execute = execFileSync,
} = {}) {
  const arguments_ = buildReleaseArguments(tag);
  try {
    execute("gh", arguments_, { stdio: "inherit" });
  } catch {
    throw new Error("release-create-failed");
  }
}

function main() {
  try {
    runDraftRelease();
  } catch (error) {
    const message =
      error instanceof Error &&
      ["release-tag-invalid", "release-create-failed"].includes(error.message)
        ? error.message
        : "release-create-operational-error";
    console.error(message);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

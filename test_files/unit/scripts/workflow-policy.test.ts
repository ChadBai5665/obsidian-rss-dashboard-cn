import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { beforeAll, describe, expect, it } from "vitest";
import { checkWorkflowPolicy } from "../../../scripts/check-workflow-policy.mjs";

interface WorkflowInputs {
  testWorkflow: string;
  releaseWorkflow: string;
  pullRequestTemplate: string;
  fundingPresent: boolean;
}

let inputs: WorkflowInputs;

beforeAll(async () => {
  const root = process.cwd();
  const github = join(root, ".github");
  inputs = {
    testWorkflow: await readFile(
      join(github, "workflows", "test.yml"),
      "utf8",
    ),
    releaseWorkflow: await readFile(
      join(github, "workflows", "release.yml"),
      "utf8",
    ),
    pullRequestTemplate: await readFile(
      join(github, "PULL_REQUEST_TEMPLATE.md"),
      "utf8",
    ),
    fundingPresent: await access(join(github, "funding.yml")).then(
      () => true,
      () => false,
    ),
  };
});

describe("public workflow policy", () => {
  it("accepts the repository CI, release workflow, and PR checklist", () => {
    expect(checkWorkflowPolicy(inputs)).toEqual([]);
  });

  it("rejects write permissions and pull-request-target execution in CI", () => {
    const unsafe = inputs.testWorkflow
      .replace("contents: read", "contents: write")
      .replace("pull_request:", "pull_request_target:");

    expect(
      checkWorkflowPolicy({ ...inputs, testWorkflow: unsafe }),
    ).toEqual(
      expect.arrayContaining([
        "test-permissions-not-read-only",
        "test-trigger-unsafe",
      ]),
    );
  });

  it("rejects broad release triggers and expression interpolation in shell", () => {
    const unsafe = inputs.releaseWorkflow
      .replace('"[0-9]+.[0-9]+.[0-9]+*"', '"*"')
      .replace(
        'node scripts/check-version-consistency.mjs --tag "$GITHUB_REF_NAME"',
        "node scripts/check-version-consistency.mjs --tag ${{ github.ref_name }}",
      );

    expect(
      checkWorkflowPolicy({ ...inputs, releaseWorkflow: unsafe }),
    ).toEqual(
      expect.arrayContaining([
        "release-trigger-not-numeric-semver",
        "release-shell-expression-interpolation",
      ]),
    );
  });

  it("rejects tag/version mismatch and a missing staged-artifact check", () => {
    const unsafe = inputs.releaseWorkflow
      .replace('"$GITHUB_REF_NAME"', '"0.1.0"')
      .replace("npm run release:check", "npm run build");

    expect(
      checkWorkflowPolicy({ ...inputs, releaseWorkflow: unsafe }),
    ).toEqual(
      expect.arrayContaining([
        "release-version-tag-not-validated",
        "release-artifacts-not-checked",
      ]),
    );
  });

  it("rejects publishing instead of drafting and directory uploads", () => {
    const unsafe = inputs.releaseWorkflow
      .replace("--draft", "--draft=false")
      .replaceAll("release/main.js", "release/")
      .replaceAll("release/manifest.json", "release/")
      .replaceAll("release/styles.css", "release/");

    expect(
      checkWorkflowPolicy({ ...inputs, releaseWorkflow: unsafe }),
    ).toEqual(
      expect.arrayContaining([
        "release-not-always-draft",
        "release-assets-not-individual-files",
      ]),
    );
  });

  it("rejects injected release jobs, commands, and alternate token sources", () => {
    const unsafe = inputs.releaseWorkflow
      .replace(
        "jobs:\n",
        [
          "jobs:",
          "  injected:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo untrusted",
          "",
        ].join("\n"),
      )
      .replace(
        "GH_TOKEN: ${{ github.token }}",
        "GH_TOKEN: ${{ secrets.RELEASE_TOKEN }}",
      );

    expect(
      checkWorkflowPolicy({ ...inputs, releaseWorkflow: unsafe }),
    ).toEqual(
      expect.arrayContaining([
        "release-job-not-single",
        "release-commands-not-minimal",
        "release-token-source-unsafe",
      ]),
    );
  });
});

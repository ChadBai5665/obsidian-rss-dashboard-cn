import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { beforeAll, describe, expect, it } from "vitest";
import { checkWorkflowPolicy } from "../../../scripts/check-workflow-policy.mjs";

interface Inputs {
  testWorkflow: string;
  releaseWorkflow: string;
  pullRequestTemplate: string;
  fundingPresent: boolean;
}

let inputs: Inputs;

beforeAll(async () => {
  const github = join(process.cwd(), ".github");
  inputs = {
    testWorkflow: await readFile(join(github, "workflows", "test.yml"), "utf8"),
    releaseWorkflow: await readFile(
      join(github, "workflows", "release.yml"),
      "utf8",
    ),
    pullRequestTemplate: await readFile(
      join(github, "PULL_REQUEST_TEMPLATE.md"),
      "utf8",
    ),
    fundingPresent: false,
  };
});

function releaseErrors(releaseWorkflow: string): string[] {
  return checkWorkflowPolicy({ ...inputs, releaseWorkflow });
}

describe("workflow policy adversarial mutations", () => {
  it.each([
    ["job", "    runs-on: ubuntu-latest\n    continue-on-error: true"],
    [
      "step",
      "      - name: Install dependencies\n        continue-on-error: true",
    ],
  ])("rejects continue-on-error on a %s", (_name, replacement) => {
    const marker =
      _name === "job"
        ? "    runs-on: ubuntu-latest"
        : "      - name: Install dependencies";
    expect(releaseErrors(inputs.releaseWorkflow.replace(marker, replacement))).toContain(
      "release-unsafe-control",
    );
  });

  it.each([
    ["write-all", "    permissions: write-all"],
    [
      "extra scope",
      [
        "    permissions:",
        "      contents: write",
        "      attestations: write",
        "      id-token: write",
        "      packages: write",
      ].join("\n"),
    ],
  ])("rejects %s permissions", (_name, replacement) => {
    const unsafe = inputs.releaseWorkflow.replace(
      / {4}permissions:\n {6}contents: write\n {6}attestations: write\n {6}id-token: write/,
      replacement,
    );
    expect(releaseErrors(unsafe)).toContain("release-schema-unsafe");
  });

  it.each([
    ["workflow", "jobs:", "env:\n  LEAK: ${{ secrets.RELEASE_TOKEN }}\n\njobs:"],
    [
      "job",
      "    runs-on: ubuntu-latest",
      "    runs-on: ubuntu-latest\n    env:\n      LEAK: ${{ secrets.RELEASE_TOKEN }}",
    ],
    [
      "step",
      "      - name: Install dependencies",
      "      - name: Install dependencies\n        env:\n          LEAK: ${{ secrets.RELEASE_TOKEN }}",
    ],
  ])("rejects secrets env at %s scope", (_name, marker, replacement) => {
    expect(
      releaseErrors(inputs.releaseWorkflow.replace(marker, replacement)),
    ).toContain("release-environment-unsafe");
  });

  it.each(["repository", "ref", "path", "submodules"])(
    "rejects checkout customization: %s",
    (field) => {
      const unsafe = inputs.releaseWorkflow.replace(
        / {8}uses: actions\/checkout@[^\n]+/,
        [
          "        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
          "        with:",
          `          ${field}: attacker/example`,
        ].join("\n"),
      );
      expect(releaseErrors(unsafe)).toContain("release-checkout-unsafe");
    },
  );

  it("rejects persist-credentials other than false", () => {
    const unsafe = inputs.releaseWorkflow.replace(
      / {8}uses: actions\/checkout@[^\n]+/,
      [
        "        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
        "        with:",
        "          persist-credentials: true",
      ].join("\n"),
    );
    expect(releaseErrors(unsafe)).toContain("release-checkout-unsafe");
  });

  it("rejects attestation before release:check", () => {
    const block = [
      "      - name: Attest build provenance for release assets",
      "        uses: actions/attest-build-provenance@96b4a1ef7235a096b17240c259729fdd70c83d45",
      "        with:",
      "          subject-path: |",
      "            release/main.js",
      "            release/manifest.json",
      "            release/styles.css",
      "",
    ].join("\n");
    const unsafe = inputs.releaseWorkflow
      .replace(block, "")
      .replace(
        "      - name: Validate staged release assets",
        `${block}      - name: Validate staged release assets`,
      );
    expect(releaseErrors(unsafe)).toContain("release-step-order-invalid");
  });

  it.each([
    ["if", "      if: always()"],
    ["working-directory", "      working-directory: /tmp"],
    ["shell", "      shell: python"],
    ["timeout", "    timeout-minutes: 999"],
    ["container", "    container: node:22"],
    ["services", "    services: {}"],
    ["strategy", "    strategy:\n      matrix:\n        node: [22]"],
    ["needs", "    needs: injected"],
    ["job uses", "    uses: attacker/workflow/.github/workflows/x.yml@main"],
  ])("rejects unsafe workflow control: %s", (_name, addition) => {
    const marker = addition.startsWith("      ")
      ? "      - name: Install dependencies"
      : "    runs-on: ubuntu-latest";
    const unsafe = inputs.releaseWorkflow.replace(marker, `${marker}\n${addition}`);
    expect(releaseErrors(unsafe)).toContain("release-schema-unsafe");
  });

  it.each([
    [
      "duplicate key",
      (text: string) => text.replace("name: Release Obsidian plugin", "name: One\nname: Two"),
    ],
    [
      "alias",
      (text: string) =>
        text.replace(
          "name: Release Obsidian plugin",
          "name: &release-name Release Obsidian plugin\nrun-name: *release-name",
        ),
    ],
    [
      "merge key",
      (text: string) =>
        text.replace(
          "jobs:",
          "defaults: &defaults\n  runs-on: ubuntu-latest\njobs:\n  merged:\n    <<: *defaults\n",
        ),
    ],
  ])("rejects YAML %s", (_name, mutate) => {
    expect(releaseErrors(mutate(inputs.releaseWorkflow))).toContain(
      "release-yaml-unsafe",
    );
  });

  it("accepts quoted on, multiline run, and reordered top-level fields", () => {
    const quoted = inputs.testWorkflow.replace("\non:\n", '\n"on":\n');
    const multiline = quoted.replace(
      "        run: npm ci",
      "        run: |\n          npm ci",
    );
    const [name, ...rest] = multiline.split("\n");
    const reordered = `${rest.join("\n")}\n${name}\n`;
    expect(
      checkWorkflowPolicy({ ...inputs, testWorkflow: reordered }),
    ).toEqual([]);
  });

  it("rejects a bypassed tag validator", () => {
    const unsafe = inputs.releaseWorkflow.replace(
      'node scripts/check-version-consistency.mjs --tag "$GITHUB_REF_NAME"',
      'true || node scripts/check-version-consistency.mjs --tag "$GITHUB_REF_NAME"',
    );
    expect(releaseErrors(unsafe)).toEqual(
      expect.arrayContaining([
        "release-version-tag-not-validated",
      ]),
    );
  });

  it("rejects a second checkout and unapproved package asset", () => {
    const unsafe = inputs.releaseWorkflow
      .replace(
        "      - name: Set up Node.js",
        [
          "      - name: Second checkout",
          "        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
          "        with:",
          "          persist-credentials: false",
          "",
          "      - name: Set up Node.js",
        ].join("\n"),
      )
      .replace(
        "            release/styles.css",
        "            release/styles.css\n            release/package.json",
      );
    expect(releaseErrors(unsafe)).toEqual(
      expect.arrayContaining([
        "release-actions-not-minimal",
        "release-assets-not-individual-files",
      ]),
    );
  });

  it("rejects movable action tags instead of full commit pins", () => {
    const unsafe = inputs.releaseWorkflow
      .replace(
        "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
        "actions/checkout@v4",
      )
      .replace(
        "actions/attest-build-provenance@96b4a1ef7235a096b17240c259729fdd70c83d45",
        "actions/attest-build-provenance@v2",
      );
    expect(releaseErrors(unsafe)).toEqual(
      expect.arrayContaining([
        "release-actions-not-minimal",
        "release-checkout-unsafe",
      ]),
    );
  });

  it("rejects an early non-draft release even if a later draft command exists", () => {
    const unsafe = inputs.releaseWorkflow.replace(
      "        run: node scripts/create-draft-release.mjs",
      [
        "        run: |",
        '          gh release create "$GITHUB_REF_NAME" release/main.js',
        "          node scripts/create-draft-release.mjs",
      ].join("\n"),
    );
    expect(releaseErrors(unsafe)).toContain("release-not-always-draft");
  });
});

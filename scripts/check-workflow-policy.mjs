import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const TEST_ACTIONS = new Set([
  "actions/checkout@v4",
  "actions/setup-node@v4",
]);
const RELEASE_ACTIONS = new Set([
  "actions/attest-build-provenance@v2",
  "actions/checkout@v4",
  "actions/setup-node@v4",
]);
const RELEASE_FILES = [
  "release/main.js",
  "release/manifest.json",
  "release/styles.css",
];

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function parseWorkflow(text, prefix, errors) {
  try {
    const value = parse(text, { maxAliasCount: 0 });
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      errors.push(`${prefix}-yaml-shape-invalid`);
      return {};
    }
    return value;
  } catch {
    errors.push(`${prefix}-yaml-invalid`);
    return {};
  }
}

function workflowSteps(workflow) {
  return Object.values(record(workflow.jobs)).flatMap((job) => {
    const steps = record(job).steps;
    return Array.isArray(steps) ? steps.map(record) : [];
  });
}

function allPermissions(workflow) {
  return [
    record(workflow.permissions),
    ...Object.values(record(workflow.jobs)).map((job) =>
      record(record(job).permissions),
    ),
  ].filter((permissions) => Object.keys(permissions).length > 0);
}

function checkTestWorkflow(text, errors) {
  const workflow = parseWorkflow(text, "test", errors);
  const jobs = Object.values(record(workflow.jobs)).map(record);
  if (
    jobs.length !== 1 ||
    jobs[0]["runs-on"] !== "ubuntu-latest"
  ) {
    errors.push("test-job-not-single");
  }
  const triggers = record(workflow.on);
  const triggerNames = Object.keys(triggers).sort();
  if (
    !triggerNames.includes("pull_request") ||
    !triggerNames.includes("push") ||
    triggerNames.some((name) => !["pull_request", "push"].includes(name))
  ) {
    errors.push("test-trigger-unsafe");
  }
  const pushBranches = record(triggers.push).branches;
  const pullRequestBranches = record(triggers.pull_request).branches;
  if (
    !Array.isArray(pushBranches) ||
    pushBranches.length !== 1 ||
    pushBranches[0] !== "master" ||
    !Array.isArray(pullRequestBranches) ||
    pullRequestBranches.length !== 1 ||
    pullRequestBranches[0] !== "master"
  ) {
    errors.push("test-base-branch-mismatch");
  }

  const permissions = allPermissions(workflow);
  if (
    permissions.length === 0 ||
    permissions.some(
      (entry) =>
        Object.keys(entry).length !== 1 || entry.contents !== "read",
    )
  ) {
    errors.push("test-permissions-not-read-only");
  }

  const steps = workflowSteps(workflow);
  const actions = steps
    .map((step) => step.uses)
    .filter((value) => typeof value === "string");
  if (
    actions.some((action) => !TEST_ACTIONS.has(action)) ||
    !actions.includes("actions/checkout@v4") ||
    !actions.includes("actions/setup-node@v4")
  ) {
    errors.push("test-actions-not-minimal");
  }
  const nodeStep = steps.find(
    (step) => step.uses === "actions/setup-node@v4",
  );
  if (String(record(nodeStep?.with)["node-version"]) !== "22") {
    errors.push("test-node-version-mismatch");
  }

  const commands = steps
    .map((step) => step.run)
    .filter((value) => typeof value === "string")
    .map((value) => value.trim());
  if (
    commands.length !== 2 ||
    commands[0] !== "npm ci" ||
    commands[1] !== "npm run check"
  ) {
    errors.push("test-not-canonical-check");
  }
}

function checkReleaseWorkflow(text, errors) {
  const workflow = parseWorkflow(text, "release", errors);
  const jobs = Object.values(record(workflow.jobs)).map(record);
  if (
    jobs.length !== 1 ||
    jobs[0]["runs-on"] !== "ubuntu-latest"
  ) {
    errors.push("release-job-not-single");
  }
  const triggers = record(workflow.on);
  const triggerNames = Object.keys(triggers);
  const tags = record(triggers.push).tags;
  if (
    triggerNames.length !== 1 ||
    triggerNames[0] !== "push" ||
    !Array.isArray(tags) ||
    tags.length !== 1 ||
    tags[0] !== "[0-9]+.[0-9]+.[0-9]+*"
  ) {
    errors.push("release-trigger-not-numeric-semver");
  }

  const permissions = allPermissions(workflow);
  const expectedPermissions = [
    "attestations:write",
    "contents:write",
    "id-token:write",
  ];
  if (
    permissions.length !== 1 ||
    Object.entries(permissions[0])
      .map(([name, value]) => `${name}:${value}`)
      .sort()
      .join(",") !== expectedPermissions.join(",")
  ) {
    errors.push("release-permissions-not-minimal");
  }

  const steps = workflowSteps(workflow);
  const actions = steps
    .map((step) => step.uses)
    .filter((value) => typeof value === "string");
  if (
    actions.some((action) => !RELEASE_ACTIONS.has(action)) ||
    !actions.includes("actions/checkout@v4") ||
    !actions.includes("actions/setup-node@v4") ||
    !actions.includes("actions/attest-build-provenance@v2")
  ) {
    errors.push("release-actions-not-minimal");
  }
  const nodeStep = steps.find(
    (step) => step.uses === "actions/setup-node@v4",
  );
  if (String(record(nodeStep?.with)["node-version"]) !== "22") {
    errors.push("release-node-version-mismatch");
  }

  const commands = steps
    .map((step) => step.run)
    .filter((value) => typeof value === "string");
  const commandText = commands.join("\n");
  if (commands.some((command) => command.includes("${{"))) {
    errors.push("release-shell-expression-interpolation");
  }
  const installIndex = commands.findIndex(
    (command) => command.trim() === "npm ci",
  );
  const versionIndex = commands.findIndex((command) =>
    command
      .trim()
      .includes(
        'node scripts/check-version-consistency.mjs --tag "$GITHUB_REF_NAME"',
      ),
  );
  const checkIndex = commands.findIndex(
    (command) => command.trim() === "npm run check",
  );
  const stageIndex = commands.findIndex(
    (command) => command.trim() === "npm run release:stage",
  );
  const artifactCheckIndex = commands.findIndex(
    (command) => command.trim() === "npm run release:check",
  );
  const createIndex = commands.findIndex((command) =>
    command.includes("gh release create"),
  );
  if (
    commands.length !== 6 ||
    installIndex !== 0 ||
    versionIndex !== 1 ||
    checkIndex !== 2 ||
    stageIndex !== 3 ||
    artifactCheckIndex !== 4 ||
    createIndex !== 5
  ) {
    errors.push("release-commands-not-minimal");
  }
  if (versionIndex < 0) {
    errors.push("release-version-tag-not-validated");
  }
  if (artifactCheckIndex < 0) {
    errors.push("release-artifacts-not-checked");
  }
  if (
    !(
      installIndex >= 0 &&
      installIndex < versionIndex &&
      versionIndex < checkIndex &&
      checkIndex < stageIndex &&
      stageIndex < artifactCheckIndex &&
      artifactCheckIndex < createIndex
    )
  ) {
    errors.push("release-validation-order-invalid");
  }

  const attestationStep = steps.find(
    (step) => step.uses === "actions/attest-build-provenance@v2",
  );
  const subjects = String(record(attestationStep?.with)["subject-path"] ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
  if (subjects.join(",") !== [...RELEASE_FILES].sort().join(",")) {
    errors.push("release-attestation-subjects-invalid");
  }

  const createCommand =
    commands.find((command) => command.includes("gh release create")) ?? "";
  const createStep = steps.find(
    (step) =>
      typeof step.run === "string" &&
      step.run.includes("gh release create"),
  );
  const createEnvironment = record(createStep?.env);
  if (
    Object.keys(createEnvironment).length !== 1 ||
    createEnvironment.GH_TOKEN !== "${{ github.token }}"
  ) {
    errors.push("release-token-source-unsafe");
  }
  if (
    !createCommand.includes('gh release create "$GITHUB_REF_NAME"') ||
    !createCommand.includes('--title "$GITHUB_REF_NAME"') ||
    !createCommand.includes("--verify-tag")
  ) {
    errors.push("release-name-or-tag-mismatch");
  }
  if (
    !createCommand.includes("--draft") ||
    createCommand.includes("--draft=false") ||
    createCommand.includes("gh release edit")
  ) {
    errors.push("release-not-always-draft");
  }
  if (
    !createCommand.includes('[[ "$GITHUB_REF_NAME" == *-* ]]') ||
    !createCommand.includes("--prerelease")
  ) {
    errors.push("release-prerelease-policy-missing");
  }
  if (
    RELEASE_FILES.some(
      (file) =>
        !new RegExp(
          `(?:^|\\s)${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`,
        ).test(createCommand),
    ) ||
    /(?:^|\s)release\/(?:\s|$)|release\/[*]|\.zip\b|\.tar(?:\.gz)?\b/.test(
      createCommand,
    )
  ) {
    errors.push("release-assets-not-individual-files");
  }

  if (
    !commandText.includes("npm run check") ||
    !commandText.includes("npm run release:stage")
  ) {
    errors.push("release-required-check-missing");
  }
}

function checkPullRequestTemplate(text, errors) {
  const requirements = [
    "Base branch is master",
    "npm run check:public",
    "npm run audit:i18n",
    "npm run test:unit",
    "npm run build",
    "Release Notes Candidate",
    "fixtures",
    "upstream attribution",
  ];
  if (requirements.some((requirement) => !text.includes(requirement))) {
    errors.push("pull-request-checklist-incomplete");
  }
}

export function checkWorkflowPolicy({
  testWorkflow,
  releaseWorkflow,
  pullRequestTemplate,
  fundingPresent,
}) {
  const errors = [];
  checkTestWorkflow(testWorkflow, errors);
  checkReleaseWorkflow(releaseWorkflow, errors);
  checkPullRequestTemplate(pullRequestTemplate, errors);
  if (fundingPresent) errors.push("upstream-funding-metadata-present");
  return [...new Set(errors)].sort();
}

async function main() {
  const root = resolve(process.cwd());
  const github = join(root, ".github");
  try {
    const inputs = {
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
    const errors = checkWorkflowPolicy(inputs);
    if (errors.length > 0) {
      console.log(errors.join("\n"));
      process.exitCode = 1;
      return;
    }
    console.log("workflow-policy-valid");
  } catch {
    console.error("workflow-policy-operational-error");
    process.exitCode = 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

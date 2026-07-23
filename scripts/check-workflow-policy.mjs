import { isDeepStrictEqual } from "node:util";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments, visit } from "yaml";

const CHECKOUT_ACTION =
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
const SETUP_NODE_ACTION =
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
const ATTEST_ACTION =
  "actions/attest-build-provenance@96b4a1ef7235a096b17240c259729fdd70c83d45";
const RELEASE_FILES = [
  "release/main.js",
  "release/manifest.json",
  "release/styles.css",
];
const RELEASE_TAG_PATTERNS = [
  "[0-9]+.[0-9]+.[0-9]+",
  "[0-9]+.[0-9]+.[0-9]+-*",
  String.raw`[0-9]+.[0-9]+.[0-9]+\+*`,
];

const EXPECTED_TEST_WORKFLOW = {
  name: "Test",
  permissions: { contents: "read" },
  on: {
    push: { branches: ["master"] },
    pull_request: { branches: ["master"] },
  },
  jobs: {
    check: {
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 30,
      steps: [
        {
          name: "Check out repository",
          uses: CHECKOUT_ACTION,
          with: { "persist-credentials": false },
        },
        {
          name: "Set up Node.js",
          uses: SETUP_NODE_ACTION,
          with: { "node-version": "22", cache: "npm" },
        },
        { name: "Install dependencies", run: "npm ci" },
        { name: "Run canonical checks", run: "npm run check" },
      ],
    },
  },
};

const EXPECTED_RELEASE_WORKFLOW = {
  name: "Release Obsidian plugin",
  on: { push: { tags: RELEASE_TAG_PATTERNS } },
  jobs: {
    "draft-release": {
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 30,
      permissions: {
        contents: "write",
        attestations: "write",
        "id-token": "write",
      },
      steps: [
        {
          name: "Check out repository",
          uses: CHECKOUT_ACTION,
          with: { "persist-credentials": false },
        },
        {
          name: "Set up Node.js",
          uses: SETUP_NODE_ACTION,
          with: { "node-version": "22", cache: "npm" },
        },
        { name: "Install dependencies", run: "npm ci" },
        {
          name: "Validate tag against package version",
          run: 'node scripts/check-version-consistency.mjs --tag "$GITHUB_REF_NAME"',
        },
        { name: "Run canonical checks", run: "npm run check" },
        { name: "Stage release assets", run: "npm run release:stage" },
        {
          name: "Validate staged release assets",
          run: "npm run release:check",
        },
        {
          name: "Attest build provenance for release assets",
          uses: ATTEST_ACTION,
          with: { "subject-path": RELEASE_FILES.join("\n") },
        },
        {
          name: "Create draft release",
          env: { GH_TOKEN: "${{ github.token }}" },
          run: "node scripts/create-draft-release.mjs",
        },
      ],
    },
  },
};

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function normalizeWorkflow(value) {
  const normalized = structuredClone(value);
  for (const job of Object.values(record(normalized.jobs))) {
    const steps = record(job).steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (typeof step?.run === "string") step.run = step.run.trim();
      if (typeof step?.with?.["subject-path"] === "string") {
        step.with["subject-path"] = step.with["subject-path"]
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .join("\n");
      }
    }
  }
  return normalized;
}

function parseWorkflow(text, prefix, errors) {
  try {
    const documents = parseAllDocuments(text, {
      maxAliasCount: 0,
      merge: false,
      uniqueKeys: true,
      version: "1.2",
    });
    let unsafe = documents.length !== 1;
    const document = documents[0];
    if (
      !document ||
      document.errors.length > 0 ||
      document.warnings.length > 0
    ) {
      unsafe = true;
    }
    if (document) {
      visit(document, {
        Alias() {
          unsafe = true;
        },
        Pair(_key, pair) {
          const key = pair.key;
          if (
            key &&
            typeof key === "object" &&
            "value" in key &&
            key.value === "<<"
          ) {
            unsafe = true;
          }
        },
      });
    }
    if (unsafe) {
      errors.push(`${prefix}-yaml-unsafe`);
      return {};
    }
    const value = document.toJS({ maxAliasCount: 0 });
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      errors.push(`${prefix}-yaml-unsafe`);
      return {};
    }
    return normalizeWorkflow(value);
  } catch {
    errors.push(`${prefix}-yaml-unsafe`);
    return {};
  }
}

function jobs(workflow) {
  return Object.values(record(workflow.jobs)).map(record);
}

function steps(workflow) {
  return jobs(workflow).flatMap((job) =>
    Array.isArray(job.steps) ? job.steps.map(record) : [],
  );
}

function containsKey(value, target) {
  if (!value || typeof value !== "object") return false;
  if (!Array.isArray(value) && Object.hasOwn(value, target)) return true;
  return Object.values(value).some((child) => containsKey(child, target));
}

function hasUnsafeEnvironment(workflow, expectedCreateEnvironment) {
  if (Object.hasOwn(workflow, "env")) return true;
  const workflowJobs = jobs(workflow);
  if (workflowJobs.some((job) => Object.hasOwn(job, "env"))) return true;
  const workflowSteps = steps(workflow);
  const envSteps = workflowSteps.filter((step) => Object.hasOwn(step, "env"));
  return (
    envSteps.length !== 1 ||
    !isDeepStrictEqual(envSteps[0].env, expectedCreateEnvironment)
  );
}

function checkTestWorkflow(text, errors) {
  const workflow = parseWorkflow(text, "test", errors);
  if (!isDeepStrictEqual(workflow, EXPECTED_TEST_WORKFLOW)) {
    errors.push("test-schema-unsafe");
  }
  if (
    !isDeepStrictEqual(workflow.permissions, { contents: "read" })
  ) {
    errors.push("test-permissions-not-read-only");
  }
  const trigger = record(workflow.on);
  if (
    !isDeepStrictEqual(Object.keys(trigger).sort(), [
      "pull_request",
      "push",
    ])
  ) {
    errors.push("test-trigger-unsafe");
  }
  if (
    !isDeepStrictEqual(record(trigger.push).branches, ["master"]) ||
    !isDeepStrictEqual(record(trigger.pull_request).branches, ["master"])
  ) {
    errors.push("test-base-branch-mismatch");
  }
  const workflowJobs = jobs(workflow);
  if (
    workflowJobs.length !== 1 ||
    workflowJobs[0]["runs-on"] !== "ubuntu-latest"
  ) {
    errors.push("test-job-not-single");
  }
  const workflowSteps = steps(workflow);
  const actionValues = workflowSteps
    .map((step) => step.uses)
    .filter((value) => typeof value === "string");
  if (
    !isDeepStrictEqual(actionValues, [CHECKOUT_ACTION, SETUP_NODE_ACTION])
  ) {
    errors.push("test-actions-not-minimal");
  }
  const checkout = workflowSteps.filter((step) =>
    String(step.uses ?? "").startsWith("actions/checkout@"),
  );
  if (
    checkout.length !== 1 ||
    !isDeepStrictEqual(checkout[0], EXPECTED_TEST_WORKFLOW.jobs.check.steps[0])
  ) {
    errors.push("test-checkout-unsafe");
  }
  if (
    record(
      workflowSteps.find((step) => step.uses === SETUP_NODE_ACTION)?.with,
    )["node-version"] !== "22"
  ) {
    errors.push("test-node-version-mismatch");
  }
  const commands = workflowSteps
    .map((step) => step.run)
    .filter((value) => typeof value === "string");
  if (!isDeepStrictEqual(commands, ["npm ci", "npm run check"])) {
    errors.push("test-not-canonical-check");
  }
  if (
    containsKey(workflow, "continue-on-error") ||
    containsKey(workflow, "if") ||
    containsKey(workflow, "working-directory") ||
    containsKey(workflow, "shell")
  ) {
    errors.push("test-unsafe-control");
  }
  if (
    Object.hasOwn(workflow, "env") ||
    workflowJobs.some((job) => Object.hasOwn(job, "env")) ||
    workflowSteps.some((step) => Object.hasOwn(step, "env"))
  ) {
    errors.push("test-environment-unsafe");
  }
}

function checkReleaseWorkflow(text, errors) {
  const workflow = parseWorkflow(text, "release", errors);
  if (!isDeepStrictEqual(workflow, EXPECTED_RELEASE_WORKFLOW)) {
    errors.push("release-schema-unsafe");
  }
  const trigger = record(workflow.on);
  if (
    !isDeepStrictEqual(Object.keys(trigger), ["push"]) ||
    !isDeepStrictEqual(record(trigger.push).tags, RELEASE_TAG_PATTERNS)
  ) {
    errors.push("release-trigger-not-numeric-semver");
  }

  const workflowJobs = jobs(workflow);
  if (
    workflowJobs.length !== 1 ||
    workflowJobs[0]["runs-on"] !== "ubuntu-latest"
  ) {
    errors.push("release-job-not-single");
  }
  if (
    workflowJobs.length !== 1 ||
    !isDeepStrictEqual(
      workflowJobs[0].permissions,
      EXPECTED_RELEASE_WORKFLOW.jobs["draft-release"].permissions,
    )
  ) {
    errors.push("release-permissions-not-minimal");
  }
  if (
    containsKey(workflow, "continue-on-error") ||
    containsKey(workflow, "if")
  ) {
    errors.push("release-unsafe-control");
  }
  if (
    hasUnsafeEnvironment(workflow, { GH_TOKEN: "${{ github.token }}" })
  ) {
    errors.push("release-environment-unsafe");
    errors.push("release-token-source-unsafe");
  }

  const workflowSteps = steps(workflow);
  const expectedSteps =
    EXPECTED_RELEASE_WORKFLOW.jobs["draft-release"].steps;
  if (
    !isDeepStrictEqual(
      workflowSteps.map((step) => step.name),
      expectedSteps.map((step) => step.name),
    )
  ) {
    errors.push("release-step-order-invalid");
  }
  const actionValues = workflowSteps
    .map((step) => step.uses)
    .filter((value) => typeof value === "string");
  if (
    !isDeepStrictEqual(actionValues, [
      CHECKOUT_ACTION,
      SETUP_NODE_ACTION,
      ATTEST_ACTION,
    ])
  ) {
    errors.push("release-actions-not-minimal");
  }
  const checkout = workflowSteps.filter((step) =>
    String(step.uses ?? "").startsWith("actions/checkout@"),
  );
  if (
    checkout.length !== 1 ||
    !isDeepStrictEqual(checkout[0], expectedSteps[0])
  ) {
    errors.push("release-checkout-unsafe");
  }

  const commands = workflowSteps
    .map((step) => step.run)
    .filter((value) => typeof value === "string");
  const expectedCommands = expectedSteps
    .map((step) => step.run)
    .filter((value) => typeof value === "string");
  if (!isDeepStrictEqual(commands, expectedCommands)) {
    errors.push("release-commands-not-minimal");
  }
  if (commands.some((command) => command.includes("${{"))) {
    errors.push("release-shell-expression-interpolation");
  }
  const versionStep = workflowSteps.find(
    (step) => step.name === "Validate tag against package version",
  );
  if (versionStep?.run !== expectedSteps[3].run) {
    errors.push("release-version-tag-not-validated");
  }
  const artifactCheckIndex = workflowSteps.findIndex(
    (step) => step.run === "npm run release:check",
  );
  if (artifactCheckIndex !== 6) {
    errors.push("release-artifacts-not-checked");
  }
  const attestationIndex = workflowSteps.findIndex(
    (step) => step.uses === ATTEST_ACTION,
  );
  const createIndex = workflowSteps.findIndex(
    (step) => step.run === "node scripts/create-draft-release.mjs",
  );
  if (
    artifactCheckIndex !== 6 ||
    attestationIndex !== 7 ||
    createIndex !== 8
  ) {
    errors.push("release-step-order-invalid");
    errors.push("release-validation-order-invalid");
  }
  const attestation = workflowSteps[attestationIndex] ?? {};
  if (
    !isDeepStrictEqual(
      record(attestation.with)["subject-path"],
      RELEASE_FILES.join("\n"),
    )
  ) {
    errors.push("release-attestation-subjects-invalid");
    errors.push("release-assets-not-individual-files");
  }
  const createStep = workflowSteps[createIndex] ?? {};
  if (createStep.run !== "node scripts/create-draft-release.mjs") {
    errors.push("release-not-always-draft");
    errors.push("release-name-or-tag-mismatch");
    errors.push("release-assets-not-individual-files");
  }
  if (
    workflowSteps.some(
      (step) =>
        typeof step.run === "string" &&
        step.run.includes("gh release create"),
    )
  ) {
    errors.push("release-not-always-draft");
  }
  if (
    containsKey(workflow, "working-directory") ||
    containsKey(workflow, "shell") ||
    containsKey(workflow, "container") ||
    containsKey(workflow, "services") ||
    containsKey(workflow, "strategy") ||
    containsKey(workflow, "needs")
  ) {
    errors.push("release-schema-unsafe");
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

async function fundingPresent(github) {
  for (const name of ["funding.yml", "FUNDING.yml"]) {
    try {
      await access(join(github, name));
      return true;
    } catch {
      // Continue checking the other supported filename.
    }
  }
  return false;
}

async function main() {
  const github = join(resolve(process.cwd()), ".github");
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
      fundingPresent: await fundingPresent(github),
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

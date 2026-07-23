import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  PUBLIC_SCAN_LIMITS,
  fingerprintFinding,
  parseNulPaths,
  scanPublicRepository,
} from "../../../scripts/check-public-repo.mjs";
import {
  safeReleaseTextCases,
  unsafeReleaseTextCases,
} from "./release-safety-rule-fixtures";

const temporaryDirectories: string[] = [];
const privateKeyMarker = ["-----BEGIN ", "OPENSSH PRIVATE KEY-----"].join("");

async function temporaryRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "rss-public-scan-"));
  temporaryDirectories.push(repository);
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], {
    cwd: repository,
  });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: repository });
  return repository;
}

async function track(
  repository: string,
  relativePath: string,
  contents: string | Uint8Array,
): Promise<void> {
  const absolutePath = join(repository, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
  execFileSync("git", ["add", "--", relativePath], { cwd: repository });
}

async function writeAllowlist(
  repository: string,
  entries: unknown[],
): Promise<string> {
  const path = join(repository, "allowlist.json");
  await writeFile(path, `${JSON.stringify(entries, null, 2)}\n`);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("public repository scanner", () => {
  it("scans only tracked files and reports redacted, deterministic findings", async () => {
    const repository = await temporaryRepository();
    await track(
      repository,
      "tracked.txt",
      [
        "local=/Users/private/Vault/note.md",
        "Authorization: Bearer live-secret-value",
        "url=https://person:password@example.invalid/feed",
        "encoded=https%3A%2F%2Fperson%3Apassword%40example.invalid",
        "double=https%253A%252F%252Fperson%253Apassword%2540example.invalid",
        privateKeyMarker,
      ].join("\r\n"),
    );
    await writeFile(
      join(repository, "untracked.txt"),
      "Authorization: Bearer must-not-be-scanned",
    );
    await track(repository, "safe.txt", "Authorization is a header name.\nBearer is a scheme.");

    const first = await scanPublicRepository({
      repository,
      allowlistPath: await writeAllowlist(repository, []),
    });
    const second = await scanPublicRepository({
      repository,
      allowlistPath: await writeAllowlist(repository, []),
    });

    expect(first.exitCode).toBe(1);
    expect(first.output).toEqual(second.output);
    expect(first.output).toContain("home-path tracked.txt:1 sha256:");
    expect(first.output).toContain("credential-value tracked.txt:2 sha256:");
    expect(first.output).toContain("credential-url tracked.txt:3 sha256:");
    expect(first.output).toContain("private-key-material tracked.txt:6 sha256:");
    expect(first.output).not.toMatch(
      /private\/Vault|live-secret|person:password|must-not-be-scanned/,
    );
    expect(first.output).not.toContain("safe.txt");
  });

  it("rejects forbidden tracked names, symlinks, traversal-like names, and private terms", async () => {
    const repository = await temporaryRepository();
    const outside = join(repository, "..", `outside-${Date.now()}.txt`);
    temporaryDirectories.push(outside);
    await writeFile(outside, "safe");
    await symlink(outside, join(repository, "linked.txt"));
    execFileSync("git", ["add", "--", "linked.txt"], { cwd: repository });
    await track(repository, ".env.production", "SAFE=true");
    await track(repository, ".envrc", "SAFE=true");
    await track(repository, "nested/secrets.json", "{}");
    await track(repository, ".rss-dashboard-data/items.jsonl", "{}");
    await track(repository, "信息收集/2026-01-01.md", "safe");
    await track(repository, "captures/raw/tikhub-response.json", "{}");
    await track(repository, "debug/session.diagnostics.json", "{}");
    await track(repository, "release-facing.md", "@private_handle private topic");
    const newlineName = "line\nbreak.txt";
    await track(repository, newlineName, "/home/private/vault");
    const privateTermsPath = join(repository, "private-terms.json");
    await writeFile(
      privateTermsPath,
      JSON.stringify({
        handles: ["private_handle"],
        keywords: ["private topic"],
      }),
    );

    const result = await scanPublicRepository({
      repository,
      allowlistPath: await writeAllowlist(repository, []),
      privateTermsPath,
    });

    expect(result.output).toMatch(/tracked-symlink linked\.txt:0/);
    expect(result.output).toMatch(/forbidden-env-file \.env\.production:0/);
    expect(result.output).toMatch(/forbidden-env-file \.envrc:0/);
    expect(result.output).toMatch(/forbidden-secret-file nested\/secrets\.json:0/);
    expect(result.output).toMatch(
      /forbidden-private-data \.rss-dashboard-data\/items\.jsonl:0/,
    );
    expect(result.output).toMatch(
      /forbidden-generated-collection 信息收集\/2026-01-01\.md:0/,
    );
    expect(result.output).toMatch(
      /forbidden-raw-provider-fixture captures\/raw\/tikhub-response\.json:0/,
    );
    expect(result.output).toMatch(
      /forbidden-diagnostics debug\/session\.diagnostics\.json:0/,
    );
    expect(result.output).toMatch(/private-x-handle release-facing\.md:1/);
    expect(result.output).toMatch(/private-topic-keyword release-facing\.md:1/);
    expect(result.output).toContain("line\\nbreak.txt:1");
    expect(result.output).not.toMatch(/private_handle|private topic/);
    await rm(outside, { force: true });
  });

  it("skips detected binary/non-UTF8 content but fails closed on size limits", async () => {
    const repository = await temporaryRepository();
    await track(
      repository,
      "nul.bin",
      new Uint8Array([0, 65, 117, 116, 104, 111, 114, 105, 122, 97, 116, 105, 111, 110]),
    );
    await track(repository, "non-utf8.bin", new Uint8Array([0xc3, 0x28]));
    await track(
      repository,
      "huge.txt",
      `prefix ${"x".repeat(PUBLIC_SCAN_LIMITS.maxLineBytes + 1)}`,
    );
    await track(
      repository,
      "too-large.bin",
      Buffer.alloc(PUBLIC_SCAN_LIMITS.maxFileBytes + 1, 0),
    );

    const result = await scanPublicRepository({
      repository,
      allowlistPath: await writeAllowlist(repository, []),
    });

    expect(result.output).not.toContain("nul.bin");
    expect(result.output).not.toContain("non-utf8.bin");
    expect(result.output).toContain("line-size-limit huge.txt:1");
    expect(result.output).toContain("file-size-limit too-large.bin:0");
  });

  it("uses exact immutable allowlist entries and rejects unsafe or stale entries", async () => {
    const repository = await temporaryRepository();
    const line = "Authorization: Bearer synthetic-test-credential";
    await track(repository, "test_files/unit/security/redaction.test.ts", line);
    const fingerprint = fingerprintFinding("credential-value", line);
    const valid = {
      path: "test_files/unit/security/redaction.test.ts",
      rule: "credential-value",
      line: 1,
      fingerprint,
      reason: "Synthetic literal verifies redaction behavior.",
    };

    const allowed = await scanPublicRepository({
      repository,
      allowlistPath: await writeAllowlist(repository, [valid]),
    });
    expect(allowed).toMatchObject({ exitCode: 0, findings: [] });

    for (const entry of [
      { ...valid, path: "test_files/**" },
      { ...valid, path: "../outside" },
      { ...valid, reason: "" },
      { ...valid, expires: "2000-01-01" },
      { ...valid, expires: "9999-99-99" },
      { ...valid, expires: "9999-02-29" },
      { ...valid, expires: "2025-02-29" },
      { ...valid, expires: "2025-02-28T00:00:00Z" },
      { ...valid, fingerprint: `sha256:${"0".repeat(64)}` },
    ]) {
      const rejected = await scanPublicRepository({
        repository,
        allowlistPath: await writeAllowlist(repository, [entry]),
      });
      expect(rejected.exitCode).toBe(2);
      expect(rejected.output).not.toContain("synthetic-test-credential");
    }

    const duplicate = await scanPublicRepository({
      repository,
      allowlistPath: await writeAllowlist(repository, [valid, valid]),
    });
    expect(duplicate.exitCode).toBe(2);

    const genericPrivateKeyMarker = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
    await track(repository, "private.pem", genericPrivateKeyMarker);
    const privateKeyAttempt = {
      path: "private.pem",
      rule: "private-key-material",
      line: 1,
      fingerprint: fingerprintFinding(
        "private-key-material",
        genericPrivateKeyMarker,
      ),
      reason: "Must never be permitted.",
    };
    const forbidden = await scanPublicRepository({
      repository,
      allowlistPath: await writeAllowlist(repository, [privateKeyAttempt]),
    });
    expect(forbidden.exitCode).toBe(2);
  });

  it("rejects content allowlists aimed at forbidden tracked filenames", async () => {
    const repository = await temporaryRepository();
    const line = 'api_key="synthetic-file-secret"';
    await track(repository, ".env", line);
    const entry = {
      path: ".env",
      rule: "credential-value",
      line: 1,
      fingerprint: fingerprintFinding("credential-value", line),
      reason: "A forbidden filename can never be allowlisted.",
    };

    const result = await scanPublicRepository({
      repository,
      allowlistPath: await writeAllowlist(repository, [entry]),
    });

    expect(result.exitCode).toBe(2);
  });

  it("rejects malicious allowlist shapes without evaluating repository content", async () => {
    const repository = await temporaryRepository();
    await track(repository, "safe.txt", "safe");
    const allowlistPath = join(repository, "allowlist.json");
    await writeFile(allowlistPath, '{"__proto__":{"polluted":true}}');
    const malformed = await scanPublicRepository({ repository, allowlistPath });
    expect(malformed).toMatchObject({ exitCode: 2 });

    await writeFile(allowlistPath, `[${"{}".repeat(PUBLIC_SCAN_LIMITS.maxAllowlistEntries + 1)}]`);
    const invalidJson = await scanPublicRepository({ repository, allowlistPath });
    expect(invalidJson.exitCode).toBe(2);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("parses NUL-delimited git output without trimming unusual filenames", () => {
    expect(parseNulPaths(Buffer.from("ordinary.txt\0space name.txt\0line\nname.txt\0"))).toEqual([
      "ordinary.txt",
      "space name.txt",
      "line\nname.txt",
    ]);
    expect(() => parseNulPaths(Buffer.from([0xc3, 0x28, 0]))).toThrow(
      "git-path-output-not-utf8",
    );
  });

  it("reads every regular file from the index blob, never the worktree", async () => {
    const repository = await temporaryRepository();
    await track(
      repository,
      "staged-secret.txt",
      "Authorization: Bearer staged-secret-value",
    );
    await writeFile(join(repository, "staged-secret.txt"), "safe worktree");
    await track(repository, "safe-index.txt", "safe index");
    await writeFile(
      join(repository, "safe-index.txt"),
      "Authorization: Bearer modified-worktree-secret",
    );
    await writeFile(
      join(repository, "untracked-secret.txt"),
      "Authorization: Bearer untracked-worktree-secret",
    );

    const result = await scanPublicRepository({
      repository,
      allowlistPath: await writeAllowlist(repository, []),
    });

    expect(result.output).toContain("credential-value staged-secret.txt:1");
    expect(result.output).not.toContain("safe-index.txt");
    expect(result.output).not.toContain("untracked-secret.txt");
    expect(result.output).not.toMatch(
      /staged-secret-value|modified-worktree-secret|untracked-worktree-secret/,
    );
  });

  it("fails closed when an indexed regular blob is unavailable", async () => {
    const repository = await temporaryRepository();
    const missingObject = "f".repeat(40);
    execFileSync(
      "git",
      [
        "update-index",
        "--add",
        "--info-only",
        "--cacheinfo",
        `100644,${missingObject},missing.txt`,
      ],
      { cwd: repository },
    );
    await writeFile(join(repository, "missing.txt"), "safe worktree fallback");

    const result = await scanPublicRepository({
      repository,
      allowlistPath: await writeAllowlist(repository, []),
    });

    expect(result).toMatchObject({
      exitCode: 2,
      findings: [],
      output: "index-blob-missing:missing.txt",
    });
  });

  it("rejects submodule index modes without reading the worktree", async () => {
    const repository = await temporaryRepository();
    await track(repository, "seed.txt", "seed");
    execFileSync("git", ["commit", "-qm", "seed"], { cwd: repository });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    execFileSync(
      "git",
      ["update-index", "--add", "--cacheinfo", `160000,${commit},vendor`],
      { cwd: repository },
    );

    const result = await scanPublicRepository({
      repository,
      allowlistPath: await writeAllowlist(repository, []),
    });

    expect(result.output).toContain("tracked-submodule vendor:0");
  });

  it("uses the shared adversarial sensitive-content rules without header false positives", async () => {
    const repository = await temporaryRepository();
    for (const [index, { text }] of unsafeReleaseTextCases.entries()) {
      await track(repository, `unsafe/${index}.txt`, text);
    }
    await track(repository, "safe.txt", safeReleaseTextCases.join("\n"));

    const result = await scanPublicRepository({
      repository,
      allowlistPath: await writeAllowlist(repository, []),
    });

    for (const [index, fixture] of unsafeReleaseTextCases.entries()) {
      expect(result.output).toContain(
        `${fixture.rule} unsafe/${index}.txt:${"line" in fixture ? fixture.line : 1}`,
      );
    }
    expect(result.output).not.toMatch(/(?:^|\s)safe\.txt:/);
  });

  it(
    "returns stable CLI exit codes and never echoes findings",
    async () => {
      const repository = await temporaryRepository();
      await track(repository, "leak.txt", "Authorization: Bearer cli-secret");
      const allowlistPath = await writeAllowlist(repository, []);
      const script = join(process.cwd(), "scripts/check-public-repo.mjs");
      const result = spawnSync(
        process.execPath,
        [script, "--repo", repository, "--allowlist", allowlistPath],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("credential-value leak.txt:1 sha256:");
      expect(`${result.stdout}${result.stderr}`).not.toContain("cli-secret");

      await chmod(allowlistPath, 0o000);
      const configError = spawnSync(
        process.execPath,
        [script, "--repo", repository, "--allowlist", allowlistPath],
        { encoding: "utf8" },
      );
      await chmod(allowlistPath, 0o600);
      if (process.getuid?.() !== 0) {
        expect(configError.status).toBe(2);
      }
    },
    30_000,
  );

  it("detects unfinished release metadata without treating upstream attribution as a secret", async () => {
    const repository = await temporaryRepository();
    await track(
      repository,
      "README.md",
      [
        "Author: YOUR_NAME",
        "Repository: https://github.com/your-name/your-repo",
        "TODO publish this release",
        "Upstream attribution: https://github.com/amatya-aditya/obsidian-rss-dashboard",
      ].join("\n"),
    );
    await track(
      repository,
      "package.json",
      '{"name":"obsidian-rss-dashboard-cn","author":""}\n',
    );

    const result = await scanPublicRepository({
      repository,
      allowlistPath: await writeAllowlist(repository, []),
    });

    expect(result.output).toMatch(/unfinished-release-placeholder README\.md:1/);
    expect(result.output).toMatch(/unfinished-release-placeholder README\.md:2/);
    expect(result.output).toMatch(/unfinished-release-placeholder README\.md:3/);
    expect(result.output).toMatch(/unfinished-author-metadata package\.json:1/);
    expect(result.output).not.toMatch(/amatya-aditya/);
  });

  it("checks placeholders across all release-facing documentation paths", async () => {
    const repository = await temporaryRepository();
    for (const path of [
      "SECURITY.md",
      "docs/INSTALL.md",
      "docs/PRIVACY.md",
      "docs/TROUBLESHOOTING.md",
      "docs/UPSTREAM.md",
      "docs/release/0.1.0.md",
    ]) {
      await track(repository, path, "Current release: not yet available");
    }

    const result = await scanPublicRepository({
      repository,
      allowlistPath: await writeAllowlist(repository, []),
    });

    for (const path of [
      "SECURITY.md",
      "docs/INSTALL.md",
      "docs/PRIVACY.md",
      "docs/TROUBLESHOOTING.md",
      "docs/UPSTREAM.md",
      "docs/release/0.1.0.md",
    ]) {
      expect(result.output).toContain(
        `unfinished-release-placeholder ${path}:1`,
      );
    }
  });

  it("keeps allowlist reasons contextual rather than one generic template", async () => {
    const entries = JSON.parse(
      await readFile(
        join(process.cwd(), "scripts/public-scan-allowlist.json"),
        "utf8",
      ),
    ) as Array<{ path: string; reason: string }>;
    const reasons = new Set(entries.map((entry) => entry.reason));

    expect(reasons.size).toBeGreaterThanOrEqual(4);
    expect(
      entries
        .filter((entry) => entry.path.startsWith("docs/"))
        .every((entry) => !/\btest fixture\b/i.test(entry.reason)),
    ).toBe(true);
    expect(
      entries.filter(
        (entry) =>
          /(?:^|\/)(?:src\/i18n\/|[^/]*(?:shortcut|tag-utils|filter-title)[^/]*)/i.test(
            entry.path,
          ) &&
          /\bcredential\b/i.test(entry.reason),
      ),
    ).toEqual([]);
  });
});

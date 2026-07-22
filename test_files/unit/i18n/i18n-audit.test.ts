import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";

const auditScript = join(process.cwd(), "scripts", "audit-i18n.mjs");
const temporaryRoots: string[] = [];

function createFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rss-i18n-audit-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    const file = join(root, relativePath);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content, "utf8");
  }

  return root;
}

function runAudit(root: string) {
  return spawnSync(process.execPath, [auditScript, "--root", root], {
    encoding: "utf8",
  });
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe("i18n literal audit", () => {
  it("reports direct user-facing literals for supported UI APIs with stable locations", () => {
    const root = createFixture({
      "main.ts": `plugin.addCommand({ id: "refresh", name: "Refresh now" });\nnew Notice("Updated");\nnew Notice(\`Saved \${filename}\`);\n`,
      "src/controls.ts": [
        'button.setText("Refresh");',
        'setting.setName("Subscription");',
        'setting.setDesc("Checks every day");',
        'input.setPlaceholder("Search");',
        'button.setButtonText("Save");',
      ].join("\n"),
    });

    const result = runAudit(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("main.ts:1 addCommand name \"Refresh now\"");
    expect(result.stdout).toContain("main.ts:2 Notice \"Updated\"");
    expect(result.stdout).toContain('main.ts:3 Notice "Saved ${filename}"');
    expect(result.stdout).toContain("src/controls.ts:1 setText \"Refresh\"");
    expect(result.stdout).toContain("src/controls.ts:2 setName \"Subscription\"");
    expect(result.stdout).toContain("src/controls.ts:3 setDesc \"Checks every day\"");
    expect(result.stdout).toContain("src/controls.ts:4 setPlaceholder \"Search\"");
    expect(result.stdout).toContain("src/controls.ts:5 setButtonText \"Save\"");
  });

  it("ignores catalogs, tests, source data, styling tokens, and non-literal UI values", () => {
    const root = createFixture({
      "src/i18n/en.ts": 'setting.setName("Catalog text");',
      "src/controls.test.ts": 'setting.setName("Test text");',
      "src/source-data.ts": 'const feed = { title: "McKinsey", url: "https://example.com" };',
      "src/controls.ts": [
        'button.setText(t("common.refresh"));',
        'button.setText("icon-refresh");',
        'element.createEl("button");',
        'const url = "https://example.com/feed.xml";',
        'const mime = "application/rss+xml";',
      ].join("\n"),
    });

    const result = runAudit(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("honors only exact reviewed allowlist entries and validates malformed, stale, and duplicate entries", () => {
    const root = createFixture({
      "main.ts": 'new Notice("Reviewed legacy notice");\n',
      "scripts/i18n-literal-allowlist.json": JSON.stringify([
        {
          pattern: "main.ts:1:Notice:Reviewed legacy notice",
          reason: "Compatibility message retained by the host application.",
        },
      ]),
    });

    const reviewed = runAudit(root);
    expect(reviewed.status).toBe(0);

    writeFileSync(
      join(root, "scripts", "i18n-literal-allowlist.json"),
      JSON.stringify([
        { pattern: "src/*.ts:*:*:*", reason: "too broad" },
        { pattern: "main.ts:9:Notice:stale", reason: "stale" },
        { pattern: "main.ts:9:Notice:stale", reason: "duplicate" },
      ]),
      "utf8",
    );

    const invalid = runAudit(root);
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain("invalid allowlist pattern");
    expect(invalid.stderr).toContain("duplicate allowlist pattern");
    expect(invalid.stderr).toContain("stale allowlist entry");
  });
});

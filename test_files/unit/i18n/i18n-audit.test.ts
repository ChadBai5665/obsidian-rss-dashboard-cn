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

  it("finds real calls through comments, optional chaining, grouping, multiline layout, and nested commands", () => {
    const root = createFixture({
      "main.ts": [
        "plugin.addCommand({",
        '  "name": "Top-level command",',
        "  callback: () => {",
        "    setup(() => { cleanup(); });",
        "  },",
        "});",
        "plugin.addCommand({ name });",
        "new /* constructor gap */ Notice((\"Parenthesized notice\"));",
      ].join("\n"),
      "src/controls.ts": [
        "button.setText /* gap */ (\"Comment gap\");",
        "button.setText?.((\"Optional grouped\"));",
        "setting",
        "  .setDesc(",
        "    `Multiline ${value}`",
        "  );",
        "Notice(\"Direct call\");",
        "new Notice(`Escaped \\` quote ${value}`);",
      ].join("\n"),
    });

    const result = runAudit(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('main.ts:2 addCommand name "Top-level command"');
    expect(result.stdout).toContain('main.ts:8 Notice "Parenthesized notice"');
    expect(result.stdout).toContain('src/controls.ts:1 setText "Comment gap"');
    expect(result.stdout).toContain('src/controls.ts:2 setText "Optional grouped"');
    expect(result.stdout).toContain('src/controls.ts:5 setDesc "Multiline ${value}"');
    expect(result.stdout).toContain('src/controls.ts:7 Notice "Direct call"');
    expect(result.stdout).toContain('src/controls.ts:8 Notice "Escaped \\\\` quote ${value}"');
    expect(result.stdout).not.toContain("main.ts:7 addCommand name");
  });

  it("does not execute audit patterns inside comments or ordinary string tokens and orders findings by code point", () => {
    const root = createFixture({
      "src/z.ts": [
        '// button.setText("Ignored comment");',
        'const source = "setting.setName(\\"Ignored string\\")";',
        '/* new Notice("Ignored block comment"); */',
        'button.setText("Zulu");',
      ].join("\n"),
      "src/a.ts": 'button.setText("Alpha");\n',
    });

    const result = runAudit(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe(
      'src/a.ts:1 setText "Alpha"\nsrc/z.ts:4 setText "Zulu"\n',
    );
    expect(result.stdout).not.toContain("Ignored");
  });

  it("consumes regular-expression literals without hiding the next real command name", () => {
    const root = createFixture({
      "main.ts": [
        "plugin.addCommand({",
        "  callback: () => {",
        '    const first = /button.setText("Ignored in regex")/;',
        "    const closing = /[}]/;",
        "    const symbols = /[/)]/;",
        "    const escaped = /button\\/setText\\(\\\"Ignored escaped\\\"\\)/;",
        "  },",
        '  "name": "Real command",',
        "});",
      ].join("\n"),
      "src/division.ts": [
        "const ratio = completed / total;",
        'const numericRatio = 10 / total; button.setText("Actual after division");',
      ].join("\n"),
    });

    const result = runAudit(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('main.ts:8 addCommand name "Real command"');
    expect(result.stdout).toContain('src/division.ts:2 setText "Actual after division"');
    expect(result.stdout).not.toContain("Ignored");
  });

  it("accepts only TypeScript assertion wrappers around direct literals", () => {
    const root = createFixture({
      "main.ts": [
        "plugin.addCommand({",
        '  "name": (("Asserted command" as const) satisfies Command<string>),',
        "  callback: () => undefined,",
        "});",
      ].join("\n"),
      "src/wrappers.ts": [
        'button.setText("Asserted text" as Namespace.Label<string>);',
        'button.setDesc((`Template ${value}`) satisfies string);',
        'button.setName("Not direct" + suffix);',
        "button.setPlaceholder(getPlaceholder());",
      ].join("\n"),
    });

    const result = runAudit(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('main.ts:2 addCommand name "Asserted command"');
    expect(result.stdout).toContain('src/wrappers.ts:1 setText "Asserted text"');
    expect(result.stdout).toContain('src/wrappers.ts:2 setDesc "Template ${value}"');
    expect(result.stdout).not.toContain("Not direct");
    expect(result.stdout).not.toContain("getPlaceholder");
  });

  it("keeps regex, control-close, and postfix boundaries in the expression stream", () => {
    const root = createFixture({
      "src/boundaries.ts": [
        "const expression = /a/ / 2; button.setText(\"After regex division\");",
        "if (enabled) /button.setText(\"Ignored control regex\")/.test(value); button.setText(\"After control regex\");",
        "counter++ / total; button.setDesc(\"After postfix division\");",
      ].join("\n"),
    });

    const result = runAudit(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('src/boundaries.ts:1 setText "After regex division"');
    expect(result.stdout).toContain('src/boundaries.ts:2 setText "After control regex"');
    expect(result.stdout).toContain('src/boundaries.ts:3 setDesc "After postfix division"');
    expect(result.stdout).not.toContain("Ignored control regex");
  });

  it("accepts parenthesized union and intersection assertions without accepting runtime method chains", () => {
    const root = createFixture({
      "main.ts": [
        "plugin.addCommand({",
        "  callback: () => { const ignored = /[}]/; },",
        '  "name": (("Typed command" as string | null) satisfies (Namespace.Command & Audited)[]),',
        "});",
      ].join("\n"),
      "src/types.ts": [
        'button.setText("Union" as string | null);',
        'button.setName(("Intersection" satisfies (Namespace.Label & Named)[]));',
        'button.setDesc(("Runtime chain" as string).toUpperCase());',
      ].join("\n"),
    });

    const result = runAudit(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('main.ts:3 addCommand name "Typed command"');
    expect(result.stdout).toContain('src/types.ts:1 setText "Union"');
    expect(result.stdout).toContain('src/types.ts:2 setName "Intersection"');
    expect(result.stdout).not.toContain("Runtime chain");
  });

  it("treats control words as keywords only when they are not property access and recognizes for await", () => {
    const root = createFixture({
      "src/control-context.ts": [
        'promise.catch(handler) / total; button.setText("After promise catch");',
        'source.if(enabled) / total; button.setName("After property if");',
        'source.while(enabled) / total; button.setDesc("After property while");',
        "for /* comment */ await",
        "  (const item of stream)",
        '  /button.setText("Ignored in for await regex")/.test(item); button.setText("After for await");',
      ].join("\n"),
    });

    const result = runAudit(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('src/control-context.ts:1 setText "After promise catch"');
    expect(result.stdout).toContain('src/control-context.ts:2 setName "After property if"');
    expect(result.stdout).toContain('src/control-context.ts:3 setDesc "After property while"');
    expect(result.stdout).toContain('src/control-context.ts:6 setText "After for await"');
    expect(result.stdout).not.toContain("Ignored in for await regex");
  });

  it("uses expression-aware scanning inside template interpolation without leaking nested code", () => {
    const root = createFixture({
      "src/templates.ts": [
        "button.setDesc(`Outer ${(() => {",
        '  const matcher = /}/; const fake = /button.setText("Ignored regex")/;',
        "  const nested = `Nested ${value / total}`;",
        '  return matcher.test("}") ? nested : "";',
        "})()}`);",
        'button.setText("After template interpolation");',
      ].join("\n"),
    });

    const result = runAudit(root);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("src/templates.ts:1 setDesc ");
    expect(result.stdout).toContain('src/templates.ts:6 setText "After template interpolation"');
    expect(result.stdout).not.toContain('setText "Ignored regex"');
  });
});

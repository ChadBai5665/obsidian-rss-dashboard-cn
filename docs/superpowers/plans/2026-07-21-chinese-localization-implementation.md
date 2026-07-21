# RSS Dashboard CN Chinese Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Simplified Chinese the complete default interface while preserving an English language option and preventing new user-facing strings from bypassing localization.

**Architecture:** Add a small typed dictionary layer with `zh-CN` and `en` catalogs. UI components receive or import a translator and render keys rather than literal labels. Locale is a normal plugin setting, can change without reinstalling, and falls back first to English and then to the key so a missing translation cannot crash the plugin.

**Tech Stack:** TypeScript, Obsidian DOM helpers, Vitest/jsdom, a Node audit script, existing settings and view components.

## Global Constraints

- Default locale is `zh-CN`; English remains selectable.
- Translate user-visible interface text, notices, validation errors, context menus, empty states, command names, and settings descriptions.
- Do not translate external feed content, website titles, URLs, provider/model names, file paths, or source-authored tags.
- Preserve all current behavior; localization is not permission to redesign unrelated interactions.
- Keep catalogs as TypeScript data, not a runtime network dependency.
- Every new key must exist in both catalogs; English is the semantic reference.
- Run focused tests before implementation and commit after each completed task.

---

## Task 1: Add the typed localization kernel and locale setting

**Files:**

- Create: `src/i18n/en.ts`
- Create: `src/i18n/zh-cn.ts`
- Create: `src/i18n/index.ts`
- Create: `src/i18n/types.ts`
- Create: `test_files/unit/i18n/i18n.test.ts`
- Modify: `src/types/types.ts`
- Modify: `src/utils/settings-loader.ts`
- Modify: `test_files/unit/utils/settings-loader.test.ts`

- [ ] **Step 1: Write failing localization kernel tests**

Test:

- `createTranslator("zh-CN")("common.refresh")` returns `刷新`.
- `createTranslator("en")("common.refresh")` returns `Refresh`.
- `{count}` parameters interpolate without executing HTML.
- A missing Chinese key falls back to English.
- A key missing from both catalogs returns the key and emits one development warning.
- Catalog key sets are identical.
- Settings without a locale migrate to `zh-CN`; a stored `en` value survives.

- [ ] **Step 2: Run the tests and confirm imports fail**

Run: `npm run test:unit -- test_files/unit/i18n/i18n.test.ts test_files/unit/utils/settings-loader.test.ts`

Expected: FAIL because `src/i18n` and the locale setting do not exist.

- [ ] **Step 3: Define the locale contracts**

Use:

```ts
export type Locale = "zh-CN" | "en";
export type TranslationParams = Record<string, string | number>;
export type Translator = (key: TranslationKey, params?: TranslationParams) => string;
```

Derive `TranslationKey` from the English catalog's nested dot paths or define a flat `as const` English object and use `keyof typeof en`. Prefer a flat object because it makes parity testing and search simple.

- [ ] **Step 4: Seed common, command, notice, and navigation keys**

The first catalogs must include keys for common actions, date/status words, main dashboard sections, manual refresh commands, generic errors, and language selection. Use natural Chinese such as `今日采集`, `我的订阅`, `主题发现`, `已加星标`, and `已保存`; do not mechanically translate brand names.

- [ ] **Step 5: Add `locale` to settings and loader migration**

Add `locale: Locale` to `RssDashboardSettings` with default `zh-CN`. Invalid stored values fall back to `zh-CN` rather than being cast.

- [ ] **Step 6: Re-run tests**

Run: `npm run test:unit -- test_files/unit/i18n/i18n.test.ts test_files/unit/utils/settings-loader.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/i18n src/types/types.ts src/utils/settings-loader.ts test_files/unit/i18n test_files/unit/utils/settings-loader.test.ts
git commit -m "feat: add Chinese-first localization kernel"
```

## Task 2: Localize settings navigation and general/storage controls

**Files:**

- Modify: `src/settings/tab-names.ts`
- Modify: `src/settings/settings-tab.ts`
- Modify: `src/settings/tabs/general-settings-tab.ts`
- Modify: `src/settings/tabs/storage-settings-tab.ts`
- Modify: `src/settings/tabs/display-settings-tab.ts`
- Modify: `src/settings/tabs/sidebar-settings-tab.ts`
- Modify: `src/settings/modals/settings-modals.ts`
- Modify: `src/settings/modals/storage-settings-modals.ts`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/zh-cn.ts`
- Modify: `test_files/unit/settings/settings-tab-orchestrator.test.ts`
- Modify: `test_files/unit/settings/settings-tab-general.test.ts`
- Modify: `test_files/unit/settings/storage-settings-general-tab.test.ts`

- [ ] **Step 1: Add failing Chinese and English rendering tests**

Assert that the same settings tab renders Chinese names/descriptions under `zh-CN` and existing English meaning under `en`. Include the language dropdown and the collection/refresh settings introduced by the foundation plan.

- [ ] **Step 2: Run the focused tests**

Run: `npm run test:unit -- test_files/unit/settings/settings-tab-orchestrator.test.ts test_files/unit/settings/settings-tab-general.test.ts test_files/unit/settings/storage-settings-general-tab.test.ts`

Expected: FAIL because labels are hard-coded English.

- [ ] **Step 3: Convert tab identity from display strings to stable IDs**

Replace English names as control-flow values with IDs:

```ts
export type SettingsTabId = "general" | "sources" | "topic-discovery" | "tikhub" | "ai" | "storage" | "display" | "sidebar" | "media" | "article-saving" | "rules" | "highlights" | "import-export" | "tags" | "about";
```

Map each ID to a translation key only at render time. A locale change must not invalidate the selected tab.

- [ ] **Step 4: Localize general, storage, display, and sidebar settings**

Pass the translator into tab constructors or create it from the current plugin settings at display time. Localize dropdown labels and descriptions, but keep stored option values stable English identifiers.

- [ ] **Step 5: Refresh the settings UI immediately after locale change**

Save the locale, clear and rebuild the settings container, and preserve the active stable tab ID. Do not require an Obsidian restart.

- [ ] **Step 6: Re-run tests**

Run: `npm run test:unit -- test_files/unit/settings/settings-tab-orchestrator.test.ts test_files/unit/settings/settings-tab-general.test.ts test_files/unit/settings/storage-settings-general-tab.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/settings src/i18n test_files/unit/settings
git commit -m "feat: localize core settings interface"
```

## Task 3: Localize dashboard, sidebar, article lists, and reader

**Files:**

- Modify: `src/views/dashboard-view.ts`
- Modify: `src/views/reader-view.ts`
- Modify: `src/components/sidebar.ts`
- Modify: `src/components/article-empty-state.ts`
- Modify: `src/components/article-filter-menu.ts`
- Modify: `src/components/article-header-menu.ts`
- Modify: `src/components/article-header.ts`
- Modify: `src/components/article-list.ts`
- Modify: `src/components/article-list/utils/article-actions.ts`
- Modify: `src/components/article-list/utils/article-context-menu.ts`
- Modify: `src/components/article-list/views/card-view.ts`
- Modify: `src/components/article-list/views/feed-view.ts`
- Modify: `src/components/article-list/views/list-view.ts`
- Modify: `src/components/article-renderer.ts`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/zh-cn.ts`
- Create: `test_files/unit/views/dashboard-localization.test.ts`
- Create: `test_files/unit/views/reader-view-localization.test.ts`
- Create: `test_files/unit/components/sidebar-localization.test.ts`
- Create: `test_files/unit/components/article-list-localization.test.ts`

- [ ] **Step 1: Add failing representative UI tests**

Test the Chinese defaults for dashboard sections, search placeholder, filters, unread/read status, refresh controls, save/star actions, reader navigation, error/empty states, and pagination. Add one English snapshot/semantic assertion for each major surface.

- [ ] **Step 2: Run representative tests**

Run: `npm run test:unit -- test_files/unit/views/dashboard-localization.test.ts test_files/unit/views/reader-view-localization.test.ts test_files/unit/components/sidebar-localization.test.ts test_files/unit/components/article-list-localization.test.ts`

Expected: FAIL on English literal assertions.

- [ ] **Step 3: Migrate dashboard and sidebar strings**

Use the exact Chinese information architecture:

```text
今日采集 / 我的订阅 / 主题发现 / 已加星标 / 已保存
```

Add localized accessible names (`aria-label`, button title, menu labels) at the same time as visible labels.

- [ ] **Step 4: Migrate article list and action strings**

Localize grouping, sort/filter names, pagination, context-menu actions, save/star/read state, and result counts. External article text remains untouched.

- [ ] **Step 5: Migrate reader strings**

Localize loading, full-text fallback, source link, save/highlight/menu actions, and error notices. Keep `contentBasis` stored values stable and translate only their display labels.

- [ ] **Step 6: Re-run tests**

Run: `npm run test:unit -- test_files/unit/views/dashboard-localization.test.ts test_files/unit/views/reader-view-localization.test.ts test_files/unit/components/sidebar-localization.test.ts test_files/unit/components/article-list-localization.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/views/dashboard-view.ts src/views/reader-view.ts src/components src/i18n test_files/unit/views test_files/unit/components
git commit -m "feat: localize dashboard and reader surfaces"
```

## Task 4: Localize subscription, import, and utility modals

**Files:**

- Modify: `src/modals/feed-manager-modal.ts`
- Modify: `src/modals/feed-manager/add-feed-modal.ts`
- Modify: `src/modals/feed-manager/edit-feed-modal.ts`
- Modify: `src/modals/feed-manager/feed-manager-modal.ts`
- Modify: `src/modals/feed-manager/feed-preview-loader.ts`
- Modify: `src/modals/feed-manager/folder-auto-tag-modal.ts`
- Modify: `src/modals/feed-manager/folder-selector-field.ts`
- Modify: `src/modals/feed-manager/supported-format-badges.ts`
- Modify: `src/modals/feed-manager/tag-application-confirm-modal.ts`
- Modify: `src/modals/feed-preview-modal.ts`
- Modify: `src/modals/import-opml-modal.ts`
- Modify: `src/modals/import-success-modal.ts`
- Modify: `src/modals/mobile-discover-filters-modal.ts`
- Modify: `src/modals/mobile-navigation-modal.ts`
- Modify: `src/modals/shortcut-help-modal.ts`
- Modify: `src/modals/storage-migration-modal.ts`
- Modify: `src/components/folder-selector-popup.ts`
- Modify: `src/components/folder-suggest.ts`
- Modify: `src/components/keyword-filter-editor.ts`
- Modify: `src/components/tag-multi-select-control.ts`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/zh-cn.ts`
- Modify: `test_files/unit/modals/add-feed-modal.test.ts`
- Modify: `test_files/unit/modals/import-opml-modal.test.ts`
- Modify: `test_files/unit/modals/storage-migration-modal.test.ts`

- [ ] **Step 1: Add failing modal tests**

Cover add/edit/delete confirmation, feed validation, preview loading/error, folder/tag selection, OPML import results, shortcuts, and storage migration warnings in both locales.

- [ ] **Step 2: Run modal tests**

Run: `npm run test:unit -- test_files/unit/modals/add-feed-modal.test.ts test_files/unit/modals/import-opml-modal.test.ts test_files/unit/modals/storage-migration-modal.test.ts`

Expected: FAIL because the modals use English literals.

- [ ] **Step 3: Migrate subscription and preview modals**

Keep protocol names (`RSS`, `Atom`, `JSON Feed`, `YouTube`) unchanged. Localize explanatory text and validation messages. Never translate or rewrite a user-entered URL.

- [ ] **Step 4: Migrate import, migration, and utility modals**

Use parameterized keys for counts and filenames. Never assemble Chinese grammar by concatenating fragments at call sites.

- [ ] **Step 5: Re-run tests**

Run: `npm run test:unit -- test_files/unit/modals/add-feed-modal.test.ts test_files/unit/modals/import-opml-modal.test.ts test_files/unit/modals/storage-migration-modal.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modals src/components/folder-selector-popup.ts src/components/folder-suggest.ts src/components/keyword-filter-editor.ts src/components/tag-multi-select-control.ts src/i18n test_files/unit/modals
git commit -m "feat: localize subscription and utility dialogs"
```

## Task 5: Localize discovery, media, remaining settings, commands, and notices

**Files:**

- Modify: `main.ts`
- Modify: `src/views/discover-view.ts`
- Modify: `src/views/kagi-smallweb-view.ts`
- Modify: `src/views/podcast-player.ts`
- Modify: `src/views/video-player.ts`
- Modify: `src/components/discover-sidebar.ts`
- Modify: `src/settings/tabs/media-settings-tab.ts`
- Modify: `src/settings/tabs/article-saving-settings-tab.ts`
- Modify: `src/settings/tabs/rules-settings-tab.ts`
- Modify: `src/settings/tabs/highlights-settings-tab.ts`
- Modify: `src/settings/tabs/import-export-settings-tab.ts`
- Modify: `src/settings/tabs/tags-settings-tab.ts`
- Modify: `src/settings/tabs/about-settings-tab.ts`
- Modify: `src/hotkeys/dashboard-hotkeys.ts`
- Modify: `src/hotkeys/reader-hotkeys.ts`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/zh-cn.ts`
- Modify: `test_files/unit/main/plugin-lifecycle.test.ts`
- Modify: `test_files/unit/views/discover-view.test.ts`
- Modify: `test_files/unit/settings/about-settings-tab.test.ts`

- [ ] **Step 1: Add failing tests for commands and remaining top-level surfaces**

Assert Chinese command names/notices and Chinese discovery/media/settings labels by default. Assert English remains available. Brand names, podcast episode titles, and embedded YouTube metadata remain source-authored.

- [ ] **Step 2: Run focused tests**

Run: `npm run test:unit -- test_files/unit/main/plugin-lifecycle.test.ts test_files/unit/views/discover-view.test.ts test_files/unit/settings/about-settings-tab.test.ts`

Expected: FAIL on remaining literal labels.

- [ ] **Step 3: Localize command registration and notices in `main.ts`**

Create the translator after settings load, and rebuild command-visible labels only on plugin load. If Obsidian cannot dynamically rename registered commands after a locale switch, show a localized notice that command names update after reload; the settings and views still update immediately.

- [ ] **Step 4: Migrate discovery/media views and remaining tabs**

Do not alter the contents of `src/discover/discover-feeds.json`; those are source data. Only localize UI chrome and descriptions owned by the plugin.

- [ ] **Step 5: Re-run tests**

Run: `npm run test:unit -- test_files/unit/main/plugin-lifecycle.test.ts test_files/unit/views/discover-view.test.ts test_files/unit/settings/about-settings-tab.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add main.ts src/views src/components/discover-sidebar.ts src/settings/tabs src/hotkeys src/i18n test_files/unit/main test_files/unit/views test_files/unit/settings
git commit -m "feat: complete Chinese interface localization"
```

## Task 6: Add a localization bypass audit

**Files:**

- Create: `scripts/audit-i18n.mjs`
- Create: `scripts/i18n-literal-allowlist.json`
- Modify: `package.json`
- Create: `test_files/unit/i18n/i18n-audit.test.ts`

- [ ] **Step 1: Write an audit test that invokes the script**

The test must fail when a temporary fixture contains direct user-facing literals passed to these common APIs:

```text
setText / setName / setDesc / setPlaceholder / setButtonText / Notice / addCommand name
```

It must ignore tests, catalogs, external source data, CSS, URLs, MIME types, icon IDs, DOM tag names, and explicitly reviewed allowlist entries.

- [ ] **Step 2: Run the test and confirm the script is absent**

Run: `npm run test:unit -- test_files/unit/i18n/i18n-audit.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement a deterministic static audit**

Use Node standard library only. Scan `.ts` files under `src` and root `main.ts`. Report file, line, API name, and literal. Exit non-zero when violations exist. The allowlist stores exact `path:line-pattern` entries with a human-readable reason; it must not contain a catch-all glob.

- [ ] **Step 4: Add scripts**

Add:

```json
{
  "scripts": {
    "audit:i18n": "node scripts/audit-i18n.mjs",
    "check": "npm run test:unit && npm run audit:i18n && npm run lint && npm run build"
  }
}
```

Merge with existing scripts rather than replacing them.

- [ ] **Step 5: Run the audit and remove or explicitly review every finding**

Run: `npm run audit:i18n`

Expected: exit code 0. Each allowlist entry must document why the literal is not user-facing or must remain unchanged.

- [ ] **Step 6: Re-run the audit test**

Run: `npm run test:unit -- test_files/unit/i18n/i18n-audit.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/audit-i18n.mjs scripts/i18n-literal-allowlist.json package.json test_files/unit/i18n/i18n-audit.test.ts
git commit -m "test: prevent untranslated interface strings"
```

## Task 7: Complete localization regression checks

**Files:**

- Modify only if verification exposes a localization defect.

- [ ] **Step 1: Verify catalog parity and bypass audit**

Run: `npm run audit:i18n`

Expected: PASS with no unreviewed user-facing literals.

- [ ] **Step 2: Run all unit tests**

Run: `npm run test:unit`

Expected: all tests PASS.

- [ ] **Step 3: Run lint and build**

Run: `npm run lint && npm run build`

Expected: both exit 0.

- [ ] **Step 4: Perform a two-locale smoke test in a disposable vault**

Install the built plugin into a disposable Obsidian vault, open settings and the dashboard in default Chinese, switch to English, then switch back to Chinese. Verify that source-authored feed titles never change and the selected settings tab remains active.

- [ ] **Step 5: Commit verification fixes if needed**

If no correction was needed, do not create an empty commit. Otherwise commit only verified fixes:

```bash
git add -u
git commit -m "fix: complete localization verification"
```

## Acceptance Checklist

- [ ] A fresh install opens in Simplified Chinese.
- [ ] English is selectable and semantically complete.
- [ ] Main views, settings, modals, commands, notices, errors, and accessibility labels are localized.
- [ ] External content, URLs, provider names, and stored enum values are not translated.
- [ ] Catalog parity and literal-audit checks pass.
- [ ] Unit tests, lint, and build pass.

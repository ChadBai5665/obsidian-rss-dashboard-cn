# 本地运行记录中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为字幕、AI、订阅刷新和订阅管理增加可持久化、可聚合、可脱敏导出的本地运行记录，让用户能从信息台直接知道一次操作何时开始、经过哪些阶段、停在哪里、是否可能计费、是否保存成功。

**Architecture:** 在 `.rss-dashboard-data/state/operation-journal/` 增加按自然日追加的严格 JSONL 事件仓库；由 `OperationJournalService` 统一生成 `operationId`、隔离写入失败、聚合操作时间线并提供安全导出。字幕、AI、刷新和订阅服务只依赖窄化的 journal port，不直接拼 JSON。信息台使用独立主区域面板读取最近 7/30 天事件并订阅增量，设置页复用同一服务提供统计、预览、导出和受控清空。

**Tech Stack:** TypeScript 5.9、Obsidian 1.8 Vault/DataAdapter API、Node `crypto`、Vitest 4、ESLint、esbuild。

## Global Constraints

- 只记录有后台副作用的字幕、AI、刷新和订阅管理操作；不记录滚动、展开、收起、筛选切换等普通界面行为。
- 日志只保存在当前 Vault 的配置数据根目录，不远程上传，不加入公共设置导出或备份包。
- 绝不记录 API Key、Token、Cookie、Authorization、完整 URL、凭证路径、字幕/文章正文、AI 输入、AI 输出、提示词、原始响应或原始错误对象。
- 本地展示可以使用最多 200 字符的 `subject.label`；脱敏导出必须移除名称、标题、路径、TikHub 任务 ID，并将本地关联 ID 变成不可逆短哈希。
- 每次实际操作只有一个稳定 `operationId`；同一字幕共享任务、TikHub 异步轮询与重开后续查必须继续使用同一个 ID。
- TikHub 费用字段只表示本地已确认请求数和“请求可能已发送”证据；不得把它描述为官方账单。
- 默认保留最近 30 个自然日，总容量最多 10MB；只删除严格匹配 `YYYY-MM-DD.jsonl` 的受控日志文件。
- JSONL 末尾半行和局部损坏不阻塞合法记录读取；UI 必须显示“不完整/损坏”健康提示。
- journal 的写入、读取、清理或实时通知失败不得改变字幕、AI、刷新、订阅操作的业务结果。
- 所有新事件数据先经过 own-data-property 严格投影；拒绝访问器、继承属性、未知字段、未知枚举、非有限整数和超长文本。
- 安装只替换 `main.js`、`manifest.json`、`styles.css`；保留 `data.json`、外部密钥、订阅、采集历史、字幕、AI 分析、用户 Markdown 和既有 `.rss-dashboard-data`。
- 每个任务遵循 RED → GREEN → REFACTOR，并在聚焦测试通过后独立提交。

## File Map

### New production files

- `src/operation-journal/operation-event.ts` — 严格事件联合类型、投影和字段上限。
- `src/operation-journal/operation-summary.ts` — 按 `operationId` 聚合、终态和“可能中断”判定。
- `src/operation-journal/operation-journal-repository.ts` — JSONL 追加、受限读取、统计、保留和清空。
- `src/operation-journal/operation-journal-service.ts` — 操作 scope、失败隔离、健康状态和实时订阅。
- `src/operation-journal/safe-operation-journal-export.ts` — 严格脱敏导出。
- `src/components/operation-journal-panel.ts` — 信息台运行记录主区域。
- `src/modals/operation-journal-clear-modal.ts` — 只清运行记录的明确确认。
- `src/styles/operation-journal.css` — 运行记录响应式布局。

### Existing production files to modify

- `src/youtube-transcript/transcript-types.ts`
- `src/youtube-transcript/youtube-transcript-service.ts`
- `src/youtube-transcript/tikhub-caption-job-repository.ts`
- `src/youtube-transcript/tikhub-transcript-provider.ts`
- `src/ai/ai-operation-task-coordinator.ts`
- `src/services/subscription-service.ts`
- `src/services/import-export-service.ts`
- `src/settings/tabs/import-export-settings-tab.ts`
- `src/modals/diagnostics-preview-modal.ts`
- `src/views/dashboard-view.ts`
- `src/i18n/zh-cn.ts`
- `src/i18n/en.ts`
- `src/styles/index.css`
- `main.ts`
- `README.md`
- `docs/PRIVACY.zh-CN.md`
- `docs/TROUBLESHOOTING.zh-CN.md`
- `scripts/public-scan-allowlist.json` — 仅在公共扫描因新增安全测试哨兵产生精确行号漂移时机械更新，不新增宽泛豁免。

---

### Task 1: Define a strict, immutable event contract and operation aggregation

**Files:**

- Create: `src/operation-journal/operation-event.ts`
- Create: `src/operation-journal/operation-summary.ts`
- Create: `test_files/unit/operation-journal/operation-event.test.ts`
- Create: `test_files/unit/operation-journal/operation-summary.test.ts`

**Interfaces:**

```ts
export type OperationCategory =
  | "transcript"
  | "ai"
  | "refresh"
  | "subscription";

export type OperationTrigger =
  | "manual"
  | "startup"
  | "schedule"
  | "system";

export type OperationStatus =
  | "started"
  | "progress"
  | "succeeded"
  | "failed"
  | "aborted"
  | "interrupted";

export interface OperationEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly operationId: string;
  readonly occurredAt: string;
  readonly category: OperationCategory;
  readonly action: OperationAction;
  readonly trigger: OperationTrigger;
  readonly stage: OperationStage;
  readonly status: OperationStatus;
  readonly subject: Readonly<OperationSubject>;
  readonly details: Readonly<OperationDetails>;
}

export function snapshotOperationEvent(value: unknown): OperationEvent;
export function aggregateOperationEvents(
  events: readonly OperationEvent[],
  now: Date,
): readonly OperationSummary[];
```

- `OperationAction` 使用封闭联合：字幕 `retrieve`；AI 使用现有 `AiOperation` 四值；刷新 `all | failed | source | folder`；订阅 `add | update | pause | resume | remove`。
- `OperationStage` 按类别定义封闭联合，不接受任意字符串。
- `OperationDetails` 是按 `category` 区分的联合，只允许设计稿列出的 provider、计费证据、轮询、模型、保存、批次计数和标准错误码。
- 中断展示阈值固定为：字幕 30 分钟、AI 30 分钟、刷新 2 小时、订阅 10 分钟。它只改变聚合摘要的派生状态，不回写历史。

- [ ] **Step 1: Write failing strict-projection tests**

覆盖：

```ts
expect(snapshotOperationEvent(validTranscriptEvent)).toEqual(
  Object.freeze({
    ...validTranscriptEvent,
    subject: Object.freeze({ ...validTranscriptEvent.subject }),
    details: Object.freeze({ ...validTranscriptEvent.details }),
  }),
);
```

并断言拒绝未知公共字段、未知详情字段、getter、继承属性、非普通对象、无效 UUID、无效 ISO 时间、超 200 字符标签、负数/小数/Infinity 计数、`confirmedPaidRequests > 2`、不匹配类别的 action/stage/details、含 URL/Authorization/API-key 形状的详情。

- [ ] **Step 2: Write failing aggregation tests**

覆盖同一 `operationId` 的排序、跨日事件、重复 `eventId` 去重、最终状态、耗时、计费证据合并、合法损坏日之外的正常摘要、四类不同中断阈值，以及终态后迟到 progress 不得把成功重新变成“进行中”。

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npm run test:unit -- \
  test_files/unit/operation-journal/operation-event.test.ts \
  test_files/unit/operation-journal/operation-summary.test.ts
```

Expected: FAIL because the event projector and aggregator do not exist.

- [ ] **Step 4: Implement strict projection and aggregation**

使用 `Object.getOwnPropertyDescriptors` 读取 own data properties；构造全新 plain object；递归 `Object.freeze` 到 `subject/details`。聚合前按 `occurredAt + eventId` 稳定排序，输出也冻结。任何未知 schema 直接抛受限解析错误，不做猜测性升级。

- [ ] **Step 5: Run focused tests and commit**

```bash
npm run test:unit -- \
  test_files/unit/operation-journal/operation-event.test.ts \
  test_files/unit/operation-journal/operation-summary.test.ts
git add src/operation-journal/operation-event.ts \
  src/operation-journal/operation-summary.ts \
  test_files/unit/operation-journal/operation-event.test.ts \
  test_files/unit/operation-journal/operation-summary.test.ts
git commit -m "feat: define operation journal events"
```

Expected: PASS.

### Task 2: Persist bounded daily JSONL and enforce retention safely

**Files:**

- Create: `src/operation-journal/operation-journal-repository.ts`
- Create: `test_files/unit/operation-journal/operation-journal-repository.test.ts`

**Interfaces:**

```ts
export interface OperationJournalReadResult {
  readonly events: readonly OperationEvent[];
  readonly incompleteDates: readonly string[];
  readonly corruptDates: readonly string[];
  readonly truncated: boolean;
}

export interface OperationJournalStats {
  readonly bytes: number;
  readonly days: number;
  readonly eventCount: number;
  readonly earliestDate?: string;
}

export interface OperationJournalAppendResult {
  readonly maintenanceIncomplete: boolean;
}

export class OperationJournalRepository {
  append(event: OperationEvent): Promise<OperationJournalAppendResult>;
  readRange(input: {
    days: 7 | 30;
    now: Date;
    maxEvents?: number;
  }): Promise<OperationJournalReadResult>;
  prune(now: Date): Promise<void>;
  stats(now: Date): Promise<OperationJournalStats>;
  clear(): Promise<void>;
}
```

Constants:

```ts
export const OPERATION_JOURNAL_RETENTION_DAYS = 30;
export const OPERATION_JOURNAL_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const OPERATION_JOURNAL_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const OPERATION_JOURNAL_MAX_READ_EVENTS = 20_000;
```

- [ ] **Step 1: Write failing append and recovery tests**

使用 fake Vault/DataAdapter 覆盖：

- 首次写入依次创建 data root、`state`、`operation-journal` 和当日文件。
- 文件日期使用现有 `toLocalCalendarDate()`，本地午夜后的事件进入新一天，不按 UTC 日期错分。
- 同一自然日第一次写入先执行一次保留检查；同日后续 append 不重复扫描目录。
- 同一 Vault/path 的两个 repository 实例并发追加仍保留完整行且顺序可解析。
- 跨日期写入进入不同文件。
- 最后一行无换行或非法时忽略末行并列入 `incompleteDates`。
- 中间非法行不隐藏其余合法行并列入 `corruptDates`。
- 未知 schema、超大单日文件、事件总数上限产生 `truncated`，不无限读取。

- [ ] **Step 2: Write failing retention, stats, and clear tests**

断言：

- 先删除超过 30 天的合法日志，再从最旧日期删除直到不超过 10MB。
- 当天文件不会被自动容量清理。
- `notes.txt`、`2026-07-30.json`、子目录和 `state` 下其他文件永不删除。
- `clear()` 只移除严格匹配日期的 JSONL 文件，保留目录和未知文件。
- 清理中途失败不会继续猜测性删除其他路径。
- 统计只计算受控合法日志。

- [ ] **Step 3: Run test and verify RED**

```bash
npm run test:unit -- \
  test_files/unit/operation-journal/operation-journal-repository.test.ts
```

Expected: FAIL because the repository does not exist.

- [ ] **Step 4: Implement queued append and bounded reads**

使用 `WeakMap<object, Map<string, Promise<void>>>` 为同一物理 Vault/path 串行化。不存在文件时在队列内调用 `vault.create(path, line)`；存在时调用 `DataAdapter.append(path, line)`。目录只逐级创建固定路径。文件清单只接受 `/^\d{4}-\d{2}-\d{2}\.jsonl$/u`，日期必须能严格往返解析。

文件分日复用 `src/refresh/local-calendar-day.ts` 的 `toLocalCalendarDate()`。仓库为同一 Vault/path 维护最近一次已尝试清理的本地日期；该日第一次 append 在相同 mutation queue 内先尝试 prune。清理失败时返回 `{ maintenanceIncomplete: true }`，仍继续追加当前事件；真正的 append 失败才 reject。两种失败都不得绕过路径限制。

读取每个文件前检查 `stat.size`，按日期从新到旧读取，在事件数和总字符上限处停止。解析错误只产生日期健康信息，不把原始行或错误正文带出仓库。

- [ ] **Step 5: Run focused test and commit**

```bash
npm run test:unit -- \
  test_files/unit/operation-journal/operation-journal-repository.test.ts
git add src/operation-journal/operation-journal-repository.ts \
  test_files/unit/operation-journal/operation-journal-repository.test.ts
git commit -m "feat: persist bounded operation journals"
```

Expected: PASS.

### Task 3: Add best-effort scopes, health state, live subscriptions, and safe export

**Files:**

- Create: `src/operation-journal/operation-journal-service.ts`
- Create: `src/operation-journal/safe-operation-journal-export.ts`
- Create: `test_files/unit/operation-journal/operation-journal-service.test.ts`
- Create: `test_files/unit/operation-journal/safe-operation-journal-export.test.ts`

**Interfaces:**

```ts
export interface OperationJournalScope {
  readonly operationId: string;
  progress(stage: OperationStage, details: OperationDetails): Promise<void>;
  succeed(stage: OperationStage, details: OperationDetails): Promise<void>;
  fail(
    stage: OperationStage,
    errorCode: OperationErrorCode,
    details?: OperationDetails,
  ): Promise<void>;
  abort(stage: OperationStage): Promise<void>;
}

export interface OperationJournalPort {
  begin(input: OperationBeginInput): OperationJournalScope;
  attach(operationId: string, input: OperationIdentityInput): OperationJournalScope;
}

export interface OperationJournalHealth {
  readonly writeIncomplete: boolean;
  readonly maintenanceIncomplete: boolean;
  readonly lastWriteFailureAt?: string;
  readonly lastMaintenanceFailureAt?: string;
}

export class OperationJournalService implements OperationJournalPort {
  list(input: { days: 7 | 30; now: Date }): Promise<OperationJournalListResult>;
  subscribe(listener: (event: OperationEvent) => void): () => void;
  getHealth(): OperationJournalHealth;
  stats(now: Date): Promise<OperationJournalStats>;
  prune(now: Date): Promise<void>;
  clear(): Promise<void>;
  createSafeExport(input: { days: 7 | 30; now: Date }): Promise<string>;
}
```

- [ ] **Step 1: Write failing scope and failure-isolation tests**

断言 `begin()` 立即返回 UUID，并排队写入 `started`；后续同 scope 共享 ID；终态后重复终态被忽略；repository append 失败时所有 journal 方法仍 resolve，`writeIncomplete` 切为 true，只通知一次，不递归记录“记录失败”；append 返回 `maintenanceIncomplete` 时事件仍广播且只更新维护健康；成功写入后才向订阅者广播；取消订阅后不再回调；监听器抛错不影响其他监听器或业务。

- [ ] **Step 2: Write failing safe-export tests**

本地事件中放入标题、source ID、item ID、分析文档路径、TikHub job ID 和安全错误码，断言导出：

```ts
expect(exported).not.toContain("The Writing System");
expect(exported).not.toContain("123e4567-e89b-12d3-a456-426614174000");
expect(exported).not.toContain(".rss-dashboard-data/content/");
expect(parsed.operations[0].subjectHash).toMatch(/^[a-f0-9]{16}$/u);
```

同时使用凭证、URL、字幕和 AI 输出哨兵做负向扫描；导出只含 schema、时间、类别、动作、触发、阶段、状态、标准码、计数、耗时、provider/model 的非秘密受限值和短哈希。

- [ ] **Step 3: Run tests and verify RED**

```bash
npm run test:unit -- \
  test_files/unit/operation-journal/operation-journal-service.test.ts \
  test_files/unit/operation-journal/safe-operation-journal-export.test.ts
```

Expected: FAIL because the service and exporter do not exist.

- [ ] **Step 4: Implement best-effort service and export**

`begin`/`attach` 先快照 identity，scope 每次调用再快照 details。内部 `safeAppend()` 捕获所有仓库错误并只更新冻结的 health snapshot。服务构造函数接受 `createId`、`clock` 和 `onHealthChange` 以便确定性测试。

每个 scope 维护自己的 promise tail，因此即使业务调用方没有 await，`started → progress → terminal` 仍按调用顺序进入 repository；一个 scope 的慢写不阻塞其他 operation，最终仍由 repository 的 Vault/path queue 保证文件行完整。

安全导出使用 `createHash("sha256").update(category + ":" + localId).digest("hex").slice(0, 16)`；不以名称、路径或 job ID 参与可见输出。导出根对象固定：

```ts
{
  schemaVersion: 1,
  generatedAt,
  rangeDays,
  health,
  operations,
}
```

- [ ] **Step 5: Run focused tests, public scan, and commit**

```bash
npm run test:unit -- \
  test_files/unit/operation-journal/operation-journal-service.test.ts \
  test_files/unit/operation-journal/safe-operation-journal-export.test.ts
npm run check:public
git add src/operation-journal/operation-journal-service.ts \
  src/operation-journal/safe-operation-journal-export.ts \
  test_files/unit/operation-journal/operation-journal-service.test.ts \
  test_files/unit/operation-journal/safe-operation-journal-export.test.ts \
  scripts/public-scan-allowlist.json
git commit -m "feat: add safe operation journal service"
```

Expected: PASS. Only stage `scripts/public-scan-allowlist.json` if its exact existing fingerprints/line references required a mechanical update.

### Task 4: Give each shared YouTube transcript request one operation timeline

**Files:**

- Modify: `src/youtube-transcript/transcript-types.ts`
- Modify: `src/youtube-transcript/youtube-transcript-service.ts`
- Modify: `test_files/unit/youtube-transcript/youtube-transcript-service.test.ts`

**Interfaces:**

```ts
export interface TranscriptProviderOperationContext {
  readonly itemId: string;
  readonly videoId: string;
  readonly operationId: string;
}

export interface YouTubeTranscriptServiceOptions {
  providers: readonly TranscriptProviderRegistration[];
  contentRepository: TranscriptCacheRepository;
  metadataRepository: TranscriptMetadataRepository;
  clock: () => Date;
  choiceTtlMs?: number;
  maxPendingChoiceSets?: number;
  operationJournal?: OperationJournalPort;
}

export interface YouTubeTranscriptRequest {
  itemId: string;
  videoId: string;
  sourceUrl?: string;
  preferredLanguage?: string;
  refresh?: boolean;
  trackId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: YouTubeTranscriptProgress) => void;
  subjectLabel?: string;
}
```

- [ ] **Step 1: Write failing transcript timeline tests**

覆盖：

- 缓存命中：`started → checking-cache → succeeded`，provider 为 `cache`。
- 缓存未命中后 InnerTube 成功：尝试 provider、保存、最终成功。
- InnerTube/TikHub/yt-dlp 依次失败：每个 provider 的标准错误码和最终失败。
- track selection 暂停后用户选择继续，保持同一 operation ID。
- 同一 `SharedWork` 的两个订阅者只产生一个 operation ID 和一套事件。
- UI subscriber abort 但仍有其他 subscriber 时不记录业务 abort；最后 subscriber abort 才进入 aborted。
- 日志 port 抛错不改变现有 transcript result/error。
- 任何事件 details 都不含字幕正文、caption URL 或 source URL。

- [ ] **Step 2: Run focused test and verify RED**

```bash
npm run test:unit -- \
  test_files/unit/youtube-transcript/youtube-transcript-service.test.ts
```

Expected: FAIL because provider context and service options have no operation journal.

- [ ] **Step 3: Instrument the shared-work boundary**

只在创建新 `SharedWork` 时调用：

```ts
const scope = journal?.begin({
  category: "transcript",
  action: "retrieve",
  trigger: "manual",
  subject: { itemId, label: subjectLabel },
  stage: "requested",
  details: { contentBasis: "youtube-transcript" },
});
```

将 `scope.operationId` 保存在 `SharedWork`，并传入所有 provider context。事件只在稳定业务边界发出，不在 UI 进度 callback 中重复记录。成功必须发生在 cache/metadata 持久化完成之后；保存失败是 `stage: saving` 的失败，不伪装成 provider 失败。

- [ ] **Step 4: Verify and commit**

```bash
npm run test:unit -- \
  test_files/unit/youtube-transcript/youtube-transcript-service.test.ts \
  test_files/unit/youtube-transcript/transcript-types.test.ts
git add src/youtube-transcript/transcript-types.ts \
  src/youtube-transcript/youtube-transcript-service.ts \
  test_files/unit/youtube-transcript/youtube-transcript-service.test.ts
git commit -m "feat: journal YouTube transcript requests"
```

Expected: PASS.

### Task 5: Persist TikHub operation identity and record paid-request/poll evidence

**Files:**

- Modify: `src/youtube-transcript/tikhub-caption-job-repository.ts`
- Modify: `src/youtube-transcript/tikhub-transcript-provider.ts`
- Modify: `test_files/unit/youtube-transcript/tikhub-caption-job-repository.test.ts`
- Modify: `test_files/unit/youtube-transcript/tikhub-transcript-provider.test.ts`

**Interfaces:**

```ts
export type TikHubCaptionJobRecord =
  | TikHubCaptionJobRecordV1
  | (Omit<TikHubCaptionJobRecordV1, "schemaVersion"> & {
      schemaVersion: 2;
      operationId: string;
    });

export interface TikHubTranscriptProviderOptions {
  getSettings: () => TikHubSettings;
  getApiKey: (connectionId: string) => Promise<string | undefined>;
  createClient: (settings: TikHubSettings) => TikHubCaptionClient;
  jobs: TikHubCaptionJobStore;
  clock: () => Date;
  delay: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
  operationJournal?: OperationJournalPort;
}
```

- [ ] **Step 1: Write failing v1/v2 compatibility tests**

断言旧 `schemaVersion: 1` 文件继续读取；新任务只写 v2 且含 UUID operation ID；`replaceIfCurrent`/`removeIfCurrent` 身份保护不因 schema 升级放松；未知 v3、无效 operation ID、getter 和额外字段仍拒绝；v1 任务第一次续查时升级为 v2，后续读取保持同一个 operation ID。

- [ ] **Step 2: Write failing paid-boundary and polling tests**

必须包含当前故障的回归：

```ts
await expect(provider.listTracks(videoId, signal, context))
  .rejects.toMatchObject({ code: "timeout" });

expect(journal.events).toContainEqual(expect.objectContaining({
  operationId: context.operationId,
  stage: "tikhub-request",
  status: "failed",
  details: expect.objectContaining({
    confirmedPaidRequests: 1,
    possiblySent: true,
  }),
}));
expect(journal.events.some((event) => event.details.jobId)).toBe(false);
```

另覆盖发送前失败 `possiblySent=false`、同步结果、收到并持久化 job ID、每次免费 poll 的序号/累计耗时、processing 超时、重开后续查、最终 content 保存后移除 job，以及字幕/响应内容不进入日志。

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npm run test:unit -- \
  test_files/unit/youtube-transcript/tikhub-caption-job-repository.test.ts \
  test_files/unit/youtube-transcript/tikhub-transcript-provider.test.ts
```

Expected: FAIL because job records and provider events do not carry operation identity.

- [ ] **Step 4: Implement v2 writes and detailed events**

- 新建 job 时使用 provider context 的 operation ID。
- v2 job 续查调用 `journal.attach(record.operationId, ...)`。
- v1 job 续查先新建一个“续查旧任务” operation scope，并在第一次安全写回时升级为 v2；不得重发付费请求。
- 付费 client 调用前记录预算确认；一旦 transport 跨过可能发送边界，失败事件必须保留 `possiblySent=true`。
- 只在明确响应后记录 job ID；job ID 只留本地，不进入安全导出。
- 每次 poll 记录 `pollNumber` 和从该 operation 开始的 `elapsedMs`，不记录响应体。

- [ ] **Step 5: Verify and commit**

```bash
npm run test:unit -- \
  test_files/unit/youtube-transcript/tikhub-caption-job-repository.test.ts \
  test_files/unit/youtube-transcript/tikhub-transcript-provider.test.ts \
  test_files/unit/sources/tikhub/tikhub-client.test.ts
git add src/youtube-transcript/tikhub-caption-job-repository.ts \
  src/youtube-transcript/tikhub-transcript-provider.ts \
  test_files/unit/youtube-transcript/tikhub-caption-job-repository.test.ts \
  test_files/unit/youtube-transcript/tikhub-transcript-provider.test.ts
git commit -m "feat: journal TikHub caption progress"
```

Expected: PASS.

### Task 6: Journal AI generation through verified Markdown persistence

**Files:**

- Modify: `src/ai/ai-operation-task-coordinator.ts`
- Modify: `test_files/unit/ai/ai-operation-task-coordinator.test.ts`

**Interfaces:**

```ts
export interface AiOperationTaskCoordinatorDependencies {
  service: Pick<AiOperationService, "run">;
  repository: Pick<AnalysisRepository, "latest" | "save">;
  createResultId?: () => string;
  now?: () => string;
  operationJournal?: OperationJournalPort;
}
```

- [ ] **Step 1: Write failing AI stage tests**

覆盖：

- `started/preparing` 含 operation、连接名、provider、模型和 content basis。
- 第一个非空 delta 只记录一次 `streaming`，不记录每个 token。
- provider 完成后进入 `saving`，repository 返回并验证路径后才 `succeeded`。
- 生成成功但保存失败明确停在 `saving`。
- provider 失败、API 失效、timeout、user abort、plugin shutdown 分别映射到受限码和正确终态。
- 同一 `itemId + operation` 的 dedupe 只产生一条 journal operation。
- “重新生成”产生新 operation ID。
- journal 失败不改变任务 snapshot、历史文件或 UI 错误。
- prompt、源正文、delta、最终输出、raw error sentinel 均不进入 journal。

- [ ] **Step 2: Run focused test and verify RED**

```bash
npm run test:unit -- \
  test_files/unit/ai/ai-operation-task-coordinator.test.ts
```

Expected: FAIL because the coordinator does not accept a journal dependency.

- [ ] **Step 3: Instrument TaskRecord, not UI**

在新 `TaskRecord` 创建时生成 scope；重连 UI 只订阅现有 task，不新建 scope。`TaskRecord` 保存 `journalScope` 和 `receivedFirstDelta`。保存成功事件只保留仓库返回的相对 artifact path；导出层会剥离该路径。错误处理复用现有稳定错误码，不序列化 `error.message` 或 `cause`。

- [ ] **Step 4: Verify and commit**

```bash
npm run test:unit -- \
  test_files/unit/ai/ai-operation-task-coordinator.test.ts \
  test_files/unit/ai/ai-operation-service.test.ts \
  test_files/unit/ai/analysis-repository.test.ts
git add src/ai/ai-operation-task-coordinator.ts \
  test_files/unit/ai/ai-operation-task-coordinator.test.ts
git commit -m "feat: journal AI generation lifecycle"
```

Expected: PASS.

### Task 7: Distinguish manual, startup, and scheduled refresh batches

**Files:**

- Modify: `main.ts`
- Modify: `test_files/unit/main/feed-refresh-pipeline.test.ts`
- Modify: `test_files/unit/main/plugin-lifecycle.test.ts`

**Interfaces:**

```ts
type RefreshTrigger = "manual" | "startup" | "schedule";

interface RefreshInvocation {
  trigger: RefreshTrigger;
  action: "all" | "failed" | "source" | "folder";
  feeds?: readonly Feed[];
  subject?: OperationSubject;
}
```

- [ ] **Step 1: Write failing trigger and batch-summary tests**

覆盖：

- “刷新全部”和“重试失败来源”按钮使用 `manual`。
- 每日打开刷新即使经过延时 timer 仍是 `startup`。
- interval timer 使用 `schedule`。
- 单来源按钮为 `manual + source`。
- 空候选、全部排除、刷新 session 已占用都有明确结束事件，而不是永久 started。
- 批次统计包含 total/succeeded/failed/newItems/duration。
- 单来源失败只写稳定 source ID/name 和标准错误码，不写 feed URL/raw error。
- settings 保存失败、collection 保存失败、source 被删除、中止均进入可区分终态。
- journal 失败不改变 Notice、刷新 ledger、设置发布和视图更新。

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm run test:unit -- \
  test_files/unit/main/feed-refresh-pipeline.test.ts \
  test_files/unit/main/plugin-lifecycle.test.ts
```

Expected: FAIL because refresh entry points do not carry trigger/action context.

- [ ] **Step 3: Thread one invocation through the orchestration**

将现有模糊 `refreshFeeds(selectedFeeds?)` 收敛为一个内部 `runRefresh(invocation)`：

```ts
private async runRefresh(invocation: RefreshInvocation): Promise<void>
```

所有 public/manual、startup 和 interval 入口显式构造 invocation。scope 在成功取得 refresh session 后开始；pipeline 返回受限的 `FeedRefreshOutcome`，由 batch 层合计，不从 Notice 文本或 raw errors 推断。`newItems` 使用每个 publication 的 `refreshedItems` 与 `previousItems` 的稳定 item identity 差集计算。

- [ ] **Step 4: Keep journal wiring optional until composition task**

为 `main.ts` 增加惰性 `getOperationJournalPort()` 调用，但测试 fixture 可以不提供；不存在 port 时业务行为保持完全兼容。自动刷新注册与注销不能因此新增 timer 或网络请求。

- [ ] **Step 5: Verify and commit**

```bash
npm run test:unit -- \
  test_files/unit/main/feed-refresh-pipeline.test.ts \
  test_files/unit/main/plugin-lifecycle.test.ts \
  test_files/unit/refresh/source-refresh-ledger.test.ts
git add main.ts \
  test_files/unit/main/feed-refresh-pipeline.test.ts \
  test_files/unit/main/plugin-lifecycle.test.ts
git commit -m "feat: journal subscription refresh batches"
```

Expected: PASS.

### Task 8: Journal subscription mutations without storing input URLs

**Files:**

- Modify: `src/services/subscription-service.ts`
- Modify: `test_files/unit/services/subscription-service.test.ts`
- Modify: `main.ts`
- Create: `test_files/unit/main/subscription-service-wiring.test.ts`

**Interfaces:**

Add `operationJournal?: OperationJournalPort` to the existing
`SubscriptionServiceDependencies` interface without changing its other ports.

- [ ] **Step 1: Write failing mutation tests**

对 `add`、`update`、`setPaused(false/true)` 和 `remove` 覆盖成功、验证失败、保存失败、集合清理失败和双击并发。断言：

- pause/resume 是两个 action。
- remove details 记录 `preserveHistory: true/false`。
- operation subject 只取验证后生成的 `feedId/sourceId` 和安全显示名称。
- add 验证前失败不写用户原始 URL，只写 `source-validation-failed`。
- X、YouTube、RSS、other TikHub source 都只记录 `sourceKind`。
- journal 写入失败不回滚或伪造订阅事务结果。

- [ ] **Step 2: Run focused test and verify RED**

```bash
npm run test:unit -- \
  test_files/unit/services/subscription-service.test.ts
```

Expected: FAIL because the dependency and events do not exist.

- [ ] **Step 3: Instrument transactional boundaries**

每个 public mutation 开始时创建 scope，但使用严格投影，不复制 request object。成功只在 `saveSettingsCandidate`/集合清理的现有事务边界完成后记录。失败 catch 只调用错误码映射器：

```ts
function subscriptionJournalErrorCode(
  error: unknown,
): SubscriptionJournalErrorCode
```

该函数不返回 `error.message`，未知值统一为 `subscription-operation-failed`。

- [ ] **Step 4: Wire the optional port and verify**

```bash
npm run test:unit -- \
  test_files/unit/services/subscription-service.test.ts \
  test_files/unit/main/subscription-service-wiring.test.ts
git add src/services/subscription-service.ts main.ts \
  test_files/unit/services/subscription-service.test.ts \
  test_files/unit/main/subscription-service-wiring.test.ts
git commit -m "feat: journal subscription changes"
```

Expected: PASS.

### Task 9: Add the information-dashboard operation journal view

**Files:**

- Create: `src/components/operation-journal-panel.ts`
- Create: `src/styles/operation-journal.css`
- Modify: `src/styles/index.css`
- Modify: `src/views/dashboard-view.ts`
- Modify: `src/i18n/zh-cn.ts`
- Modify: `src/i18n/en.ts`
- Create: `test_files/unit/components/operation-journal-panel.test.ts`
- Create: `test_files/unit/views/dashboard-operation-journal.test.ts`

**Interfaces:**

```ts
export interface OperationJournalPanelOptions {
  locale: Locale;
  load(days: 7 | 30): Promise<OperationJournalListResult>;
  subscribe(listener: () => void): () => void;
  exportSafe(days: 7 | 30): Promise<void>;
  requestClear(): void;
  onClose(): void;
}

type DashboardPrimaryMode =
  | { kind: "articles" }
  | { kind: "reader"; itemId: string }
  | { kind: "operation-journal" };
```

- [ ] **Step 1: Write failing panel rendering and filter tests**

使用 JSDOM 覆盖：

- 默认最近 7 天，按 operation start time 倒序。
- 同一 operation ID 只渲染一张卡，展开显示有序阶段时间线。
- 类别、状态、7/30 天筛选正确。
- 进行中、成功、失败、可能中断视觉与文本可区分。
- transcript 卡显示已确认请求数、possibly-sent 和 job-id-present，不显示 job ID 本身。
- AI 卡显示连接/模型/保存结果；refresh 卡显示触发与批次统计；subscription 卡显示动作与来源类型。
- incomplete/corrupt/write health 警告不会隐藏合法记录。
- 新事件到达时防抖重读，销毁后取消订阅和 timer。
- 加载失败显示可重试空态，不抛出到 Dashboard render。

- [ ] **Step 2: Write failing top-level dashboard entry tests**

断言“运行记录”与现有添加/管理订阅入口同级；点击后替换主区域而非打开嵌套 Modal；关闭后回到此前文章/列表模式；重复打开不重复订阅；信息台卸载时释放 panel；窄窗口下按钮与筛选器换行且不溢出。

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npm run test:unit -- \
  test_files/unit/components/operation-journal-panel.test.ts \
  test_files/unit/views/dashboard-operation-journal.test.ts
```

Expected: FAIL because the panel and dashboard mode do not exist.

- [ ] **Step 4: Implement a focused component and dashboard mode**

组件只接收经过聚合的 summary，不接触 repository、API key、正文或 provider response。时间线用原生 Obsidian DOM helpers 构建，不使用 `innerHTML`。所有动态字符串通过 `textContent/createEl({ text })` 输出。live callback 只触发重读，不直接相信推送 payload。

CSS 全部以 `.rss-operation-journal` 为根，使用 `minmax(0, 1fr)`、`overflow-wrap:anywhere` 和窄屏单列；不使用全局元素选择器或 `!important`。

- [ ] **Step 5: Verify UI, CSS scope, i18n, and commit**

```bash
npm run test:unit -- \
  test_files/unit/components/operation-journal-panel.test.ts \
  test_files/unit/views/dashboard-operation-journal.test.ts \
  test_files/unit/views/dashboard-localization.test.ts
npm run audit:i18n
npm run check:css-scope
git add src/components/operation-journal-panel.ts \
  src/styles/operation-journal.css src/styles/index.css \
  src/views/dashboard-view.ts src/i18n/zh-cn.ts src/i18n/en.ts \
  test_files/unit/components/operation-journal-panel.test.ts \
  test_files/unit/views/dashboard-operation-journal.test.ts
git commit -m "feat: add operation journal dashboard"
```

Expected: PASS.

### Task 10: Add settings statistics, safe preview/export, and controlled clear

**Files:**

- Create: `src/modals/operation-journal-clear-modal.ts`
- Modify: `src/modals/diagnostics-preview-modal.ts`
- Modify: `src/services/import-export-service.ts`
- Modify: `src/settings/tabs/import-export-settings-tab.ts`
- Modify: `src/i18n/zh-cn.ts`
- Modify: `src/i18n/en.ts`
- Create: `test_files/unit/modals/operation-journal-clear-modal.test.ts`
- Modify: `test_files/unit/modals/diagnostics-preview-modal.test.ts`
- Modify: `test_files/unit/services/import-export-service.test.ts`
- Modify: `test_files/unit/settings/import-export-settings-tab.test.ts`

**Interfaces:**

```ts
export interface OperationJournalSettingsPort {
  stats(): Promise<OperationJournalStats>;
  createPreview(days: 7 | 30): Promise<Readonly<{ token: string; text: string }>>;
  copyPreview(token: string, exactText: string): Promise<void>;
  revokePreview(token: string): void;
  clear(): Promise<void>;
  openDashboard(): Promise<void>;
}
```

- [ ] **Step 1: Write failing settings and confirmation tests**

覆盖：

- 设置 → 导入与导出 → 诊断信息显示占用字节、记录天数、最早日期。
- “查看运行记录”跳转信息台主区域。
- “导出脱敏记录”先生成只读预览，第二次明确点击才复制。
- 预览 token 5 分钟失效、一次性使用、关闭撤销，不能替换文本后复制。
- “清空记录”Modal 明确列出不会删除的配置、密钥、订阅、字幕、采集历史、AI 分析和 Markdown。
- 取消不清，确认双击只执行一次，失败提示不宣称已删除。
- 成功后刷新统计和已打开 journal panel。

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm run test:unit -- \
  test_files/unit/modals/operation-journal-clear-modal.test.ts \
  test_files/unit/modals/diagnostics-preview-modal.test.ts \
  test_files/unit/services/import-export-service.test.ts \
  test_files/unit/settings/import-export-settings-tab.test.ts
```

Expected: FAIL because settings has no operation journal port.

- [ ] **Step 3: Reuse the trusted-preview pattern**

将现有 diagnostics preview token store 抽成 ImportExportService 内部通用受信预览记录，token 同时绑定 `kind + exactText + expiresAt`，防止安全诊断 token 被用于运行记录或反之。保持现有安全诊断 API 兼容。

设置渲染异步统计时使用 generation/disposed guard，避免切换 tab 后把旧结果写入新 DOM。清空 Modal 只调用 service `clear()`；路径控制仍全部在 repository。

- [ ] **Step 4: Verify and commit**

```bash
npm run test:unit -- \
  test_files/unit/modals/operation-journal-clear-modal.test.ts \
  test_files/unit/modals/diagnostics-preview-modal.test.ts \
  test_files/unit/services/import-export-service.test.ts \
  test_files/unit/settings/import-export-settings-tab.test.ts
npm run audit:i18n
git add src/modals/operation-journal-clear-modal.ts \
  src/modals/diagnostics-preview-modal.ts \
  src/services/import-export-service.ts \
  src/settings/tabs/import-export-settings-tab.ts \
  src/i18n/zh-cn.ts src/i18n/en.ts \
  test_files/unit/modals/operation-journal-clear-modal.test.ts \
  test_files/unit/modals/diagnostics-preview-modal.test.ts \
  test_files/unit/services/import-export-service.test.ts \
  test_files/unit/settings/import-export-settings-tab.test.ts
git commit -m "feat: add operation journal controls"
```

Expected: PASS.

### Task 11: Compose one journal runtime and preserve lifecycle/data-root safety

**Files:**

- Modify: `main.ts`
- Create: `test_files/unit/main/operation-journal-wiring.test.ts`
- Modify: `test_files/unit/main/plugin-lifecycle.test.ts`
- Modify: `test_files/unit/main/ai-operation-wiring.test.ts`

**Interfaces:**

```ts
interface OperationJournalRuntime {
  readonly dataRoot: string;
  readonly service: OperationJournalService;
  readonly lifecycle: { revoked: boolean };
}
```

- [ ] **Step 1: Write failing composition and lifecycle tests**

断言：

- 同一 normalized data root 复用一个 service。
- data root 改变后旧 runtime 取消 listeners，不再向当前 UI 广播，新 runtime 写入新根。
- plugin load 构造 journal 但不创建目录；第一次实际 event 才创建。
- plugin load 安排一次 best-effort prune；prune 失败不阻止插件加载。
- transcript service、TikHub provider、AI coordinator、refresh 和 SubscriptionService 获得同一 port。
- settings safe diagnostics、运行记录导出和 Dashboard 只获得 UI facade，不获得 repository path mutation 能力。
- plugin unload 释放所有 live listeners；正在运行的业务任务仍按现有 shutdown 规则结束。
- 重新初始化设置服务不会重复 journal 监听或创建额外 timer。

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm run test:unit -- \
  test_files/unit/main/operation-journal-wiring.test.ts \
  test_files/unit/main/plugin-lifecycle.test.ts \
  test_files/unit/main/ai-operation-wiring.test.ts
```

Expected: FAIL because no shared runtime exists.

- [ ] **Step 3: Implement lazy runtime and public UI facade**

在 `RssDashboardPlugin` 中增加：

```ts
private operationJournalRuntime: OperationJournalRuntime | null = null;

private getOperationJournalRuntime(): OperationJournalRuntime;
public getOperationJournalUi(): OperationJournalUiPort;
public async openOperationJournal(): Promise<void>;
```

`getOperationJournalRuntime()` 只规范化和保存 data root，不触碰文件系统。首次 onload/layout ready 使用 `void service.prune(now)`，捕获后更新 health。data root 变化时只撤销旧 runtime 的内存订阅，不删除旧目录。

- [ ] **Step 4: Verify exact wiring and commit**

```bash
npm run test:unit -- \
  test_files/unit/main/operation-journal-wiring.test.ts \
  test_files/unit/main/plugin-lifecycle.test.ts \
  test_files/unit/main/ai-operation-wiring.test.ts \
  test_files/unit/main/subscription-service-wiring.test.ts \
  test_files/unit/youtube-transcript/youtube-transcript-service.test.ts
git add main.ts \
  test_files/unit/main/operation-journal-wiring.test.ts \
  test_files/unit/main/plugin-lifecycle.test.ts \
  test_files/unit/main/ai-operation-wiring.test.ts
git commit -m "feat: wire local operation journal"
```

Expected: PASS.

### Task 12: Document privacy boundaries and run release/install acceptance

**Files:**

- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `docs/PRIVACY.zh-CN.md`
- Modify: `docs/TROUBLESHOOTING.zh-CN.md`
- Modify: `scripts/public-scan-allowlist.json` only if an exact existing fingerprint/line moved.
- Generated/verify: `main.js`
- Generated/verify: `styles.css`
- Generated/verify: `release/main.js`
- Generated/verify: `release/manifest.json`
- Generated/verify: `release/styles.css`
- Test: existing full suite and release scripts.

- [ ] **Step 1: Add user-facing documentation**

Document:

- `CHANGELOG.md` 顶部增加 `Unreleased` 条目，不伪造新的版本号或发布日期。
- 信息台“运行记录”入口和最近 7/30 天筛选。
- 四类日志覆盖范围和不记录的内容。
- TikHub `confirmedPaidRequests`、`possiblySent`、`jobIdPresent` 的含义，以及官方账单仍为最终依据。
- 30 天/10MB 保留策略、损坏提示和“清空只清日志”。
- 安全导出会去掉标题、URL、路径、任务 ID、正文、AI 输出和凭证。
- 日志路径只用于高级排障，不要求普通用户手工编辑。

- [ ] **Step 2: Run all automated checks**

```bash
npm run check
npm run release:stage
npm run release:check
git status --short
```

Expected:

- unit tests, i18n, public scan, workflow/version/compliance, lint, typecheck and production build all pass;
- staged release contains only `main.js`, `manifest.json`, `styles.css`;
- tracked source tree contains no credential, home path, raw transcript/AI fixture, or generated journal JSONL;
- worktree only has intended documentation/allowlist changes before commit.

- [ ] **Step 3: Commit documentation and any exact allowlist maintenance**

```bash
git add CHANGELOG.md README.md docs/PRIVACY.zh-CN.md docs/TROUBLESHOOTING.zh-CN.md
git add scripts/public-scan-allowlist.json  # only when exact existing entries moved
git add main.js styles.css \
  release/main.js release/manifest.json release/styles.css
git commit -m "docs: explain local operation journals"
```

Do not bump `package.json`, `manifest.json`, `versions.json` or create a Git tag/Release in this task. If the generated `main.js/styles.css/release/*` files are unchanged, leave them unstaged.

- [ ] **Step 4: Snapshot the current installed plugin data before replacement**

Target Vault:

```text
$RSS_DASHBOARD_VAULT
```

At execution time, set `RSS_DASHBOARD_VAULT` to the already user-approved
current Vault path in the local shell. Do not write the personal absolute path
into tracked files, reports, fixtures, or Git history.

Before installation, record hashes/metadata for:

- `.obsidian/plugins/obsidian-rss-dashboard-cn/data.json`
- desktop external `secrets.json` used by the plugin
- `.rss-dashboard-data/state/`
- `.rss-dashboard-data/content/`
- `.rss-dashboard-data/analysis/`
- collected/history and saved Markdown counts

Do not print secret contents. Use file hashes, sizes, counts and modification times only.

- [ ] **Step 5: Install only executable artifacts**

```bash
npm run install:local
```

Verify the installer copies only `main.js`, `manifest.json`, `styles.css`. If the script targets a different Vault/plugin directory, stop before copying and resolve the exact target; do not hand-copy over `data.json`.

- [ ] **Step 6: Reopen/reload Obsidian and run user-visible acceptance**

1. Open “RSS 信息台 → 运行记录”; confirm an empty/healthy view or existing new records.
2. Run one harmless manual feed refresh; confirm `manual` timeline and batch counts.
3. Run one AI summary against an already collected item; confirm preparing/streaming/saving/succeeded and artifact path status, without output text in the log.
4. Use an already cached YouTube transcript first; confirm no TikHub fee and cache success.
5. Only with a fresh explicit authorization, run one named TikHub transcript request; confirm paid boundary, possibly-sent state, task presence, poll and terminal result.
6. Add/pause/resume/remove a disposable verified subscription while preserving history; confirm each mutation.
7. Export a 7-day safe preview and scan for titles, URLs, paths, task IDs, API keys, captions, prompts and AI output.
8. Cancel clear once, then confirm clear once; confirm subscriptions/content/analysis/config remain.

- [ ] **Step 7: Verify preservation and final Git state**

Compare post-install hashes/counts with Step 4:

- `data.json` and external secret file unchanged except changes made explicitly during acceptance.
- pre-existing subscriptions, history, subtitles, AI analysis and user Markdown still present.
- only the new `operation-journal/YYYY-MM-DD.jsonl` files were added/cleared by the new feature.

Then run:

```bash
git status --short --branch
git log -12 --oneline
```

Expected: clean worktree, ordered task commits, no generated journal or local secret artifacts tracked.

## Final Acceptance Matrix

| Scenario | Required evidence |
|---|---|
| TikHub request fails before send | `confirmedPaidRequests=0`, `possiblySent=false`, no job ID |
| TikHub request crosses send boundary then times out | confirmed local request count retained, `possiblySent=true`, no invented job ID, no automatic paid retry |
| TikHub returns async task | job ID stored locally, poll stages share one operation ID, safe export only says task present |
| AI provider succeeds but Markdown save fails | generation and saving are separate stages; operation ends failed at saving |
| Startup refresh | trigger is `startup`, even after configured delay |
| Interval refresh | trigger is `schedule`; manual button remains `manual` |
| Subscription mutation | validated source projection only; no original URL |
| Journal write fails | original operation keeps its real result; UI health says record may be incomplete |
| JSONL ends with partial line | earlier valid events display; date marked incomplete |
| Retention/clear | only controlled date JSONL files are removed |
| Safe export | no names, titles, URLs, paths, job IDs, credentials, content, prompts, model output or raw errors |
| Upgrade current Vault | executable files change; configuration, secrets, history, content, analysis and Markdown remain |

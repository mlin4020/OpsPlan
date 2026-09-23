# 需求台账页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有「归档」页（`arch` 视图）改造为「需求台账」页（`req` 视图）——全量需求的表格化清单（可排序筛选）+ 单需求档案展开，并新增 `desc` / `docUrl` 两个字段承载描述与需求文档。

**Architecture:** 沿用项目既有的三层分层：`core/` 放纯计算（新增 `mod-query.js` 承载筛选排序），`views/` 只拼 HTML 字符串不绑事件（新增 `req-view.js`），`components/` 做事件委托（新增 `req-page.js`）。增删改全部复用 `scheduler/mutations.js` 既有入口，数据层零新增。上线情况不新增字段，由 `core/versions.js` 的 `versionStatus` / `modLate` / `findGoMs` 合成。

**Tech Stack:** 原生 ES Module + Vite 5 + Vitest 2，无 UI 框架。样式为单一 `src/styles/gantt.css`。持久化为 Supabase `projects.plan`（jsonb）+ localStorage 兜底。

**设计依据：** `docs/superpowers/specs/2026-09-23-requirement-ledger-design.md`（下文简称"设计文档"）

## Global Constraints

- 所有代码注释、UI 文案、提交信息一律用中文（项目既有约定）。
- 视图 key 为 `req`；导航文案为「需求台账」，并带 `title="全部需求清单：可排序筛选，点行展开需求档案"`。
- 只读隐藏统一用 `body.readonly-mode` + class 前缀 `.req-act`（与 `version-view.js` 的 `.ver-act` 同构，见 `gantt.css:854`）。不要新造一套只读机制。
- 台账页容器用 `.req-wrap`（`max-width:1600px`），不要复用 `.report-wrap`（1300px）。
- `req-view.js` 必须是纯渲染：不 `addEventListener`、不读 `window`、不直接改 `planStore`。
- 所有新增/修改的纯函数必须能被 `vitest` 在 Node 环境直接 import 运行（不依赖 DOM）。
- 排序空值一律排最后（与升序降序无关）。
- 需求名可能含正则元字符，一律用字符串比较或 `esc()`，不要用 `RegExp` 拼接用户数据。
- 每个 Task 结束必须跑一次对应测试文件并提交。
- 测试命令统一为 `npx vitest run tests/<file>.test.js`。

---

## File Structure

**新增**

| 文件 | 职责 |
| --- | --- |
| `src/core/mod-stats.js` | 需求级人日/进度统计（`modStats`），从 `views/mod-card.js` 下沉。纯计算，供 core 层与 views 层共用 |
| `src/core/mod-query.js` | `filterMods()` / `sortMods()`：需求筛选与排序的纯函数，依赖通过参数注入 |
| `src/views/req-view.js` | 台账页渲染 + 展开态（`renderReqView` / `toggleReqExpanded` / `isReqExpanded`） |
| `src/components/req-page.js` | 台账页事件委托（`bindReqPage(deps)`） |
| `tests/mod-query.test.js` | 筛选与排序单测 |

**修改（按 Task 顺序）**

| 文件 | 改动 |
| --- | --- |
| `src/core/mod-tag.js` | 新增 `currentPhase(mo, today)` |
| `src/views/mod-card.js` | 改用 `currentPhase`；导出 `renderModDetailRows`；`modStats` 改从 core 转出 |
| `src/core/versions.js` | 新增 `isGoMs(b)` / `findGoMs(mo)` |
| `src/scheduler/mutations.js` | 改从 core 引入 `isGoMs` / `findGoMs`；`addModule`/`updateModule` 支持 `desc`/`docUrl` |
| `src/components/shell.js` | 需求抽屉加描述/文档控件；三处导航改名移位并删徽标 DOM |
| `src/components/modals.js` | 描述/文档回显、读取与链接校验 |
| `src/components/toolbar.js` | `arch-view` → `req-view`；缩放条隐藏条件加入 `req` |
| `src/views/index.js` | `arch` dispatch → `req`；导出同步 |
| `src/main-gantt.js` | 白名单、`?view=arch` 别名、viewState/ctx 加 `reqFilter`/`reqSort` |
| `src/main-standalone.js` | 白名单加 `req`、`?view=arch` 别名、viewState/ctx 加 `reqFilter`/`reqSort`、`req-view` class、绑 `bindReqPage` |
| `src/views/work-view.js` | 空态文案「归档」→「需求台账」 |
| `src/components/problem-drawer.js` | 删除 `updateArchiveBadge` |
| `src/components/gantt-interactions.js` | 删除徽标刷新调用 |
| `src/components/index.js` | 接线 `bindReqPage` |
| `src/styles/gantt.css` | `.arch-view` → `.req-view`；新增 `.req-*` |
| `tests/core.test.js` | 追加 `currentPhase` 用例 |
| `tests/version.test.js` | 追加 `isGoMs`/`findGoMs` 用例；更新 dispatch 契约断言 |
| `tests/views.test.js` | 删除 archive 用例，追加台账渲染契约 |
| `tests/mobile-layout.test.js` | 更新导航/badge/CSS 契约断言 |
| `tests/module-archive.test.js` | 删除仅针对 archive-view 的用例 |

**删除**

| 文件 | 原因 |
| --- | --- |
| `src/views/archive-view.js` | 归档页被台账页取代 |

---

## Task 1: 抽取 `currentPhase` 到 core

把 `mod-card.js` 里内联的「当前阶段」计算提到 `core/mod-tag.js`，让总览卡片与台账列共用同一份口径。

**Files:**
- Modify: `src/core/mod-tag.js`（追加在 `moduleTag` 之后）
- Modify: `src/views/mod-card.js:92-93` 与 `:124`
- Test: `tests/core.test.js`

**Interfaces:**
- Consumes: `core/dates.js` 的 `F`、`core/default-data.js` 的 `PNAME`（两者 `mod-tag.js` 已引入）
- Produces: `currentPhase(mo: {bars: Bar[]}, today: Date) => string`，返回中文阶段名，可能是 `'待启动'` / `'已全部完成'`

- [ ] **Step 1: 写失败测试**

在 `tests/core.test.js` 的 mod-tag import 行追加 `currentPhase`：

```js
import { computePlanPct, computeModuleTag, unscheduledModSet, moduleTag, currentPhase } from '../src/core/mod-tag.js';
```

在文件末尾追加：

```js
describe('core: currentPhase 需求当前阶段', () => {
  const today = F('2026-08-20');
  const bar = o => ({ id: 'x', p: 'dev', s: '2026-08-18', e: '2026-08-22', w: 5, ...o });

  it('取正在进行中最早的未完成任务所属阶段', () => {
    const mo = { name: 'A', bars: [
      bar({ id: 'a', p: 'req', s: '2026-08-10', e: '2026-08-14', done: 100 }),
      bar({ id: 'b', p: 'sit', s: '2026-08-19', e: '2026-08-25', done: 0 }),
      bar({ id: 'c', p: 'dev', s: '2026-08-18', e: '2026-08-21', done: 10 })
    ] };
    // dev 开始更早 → 排在前面
    expect(currentPhase(mo, today)).toBe('开发');
  });

  it('里程碑不参与阶段判定', () => {
    const mo = { name: 'A', bars: [
      { id: 'm', m: '2026-08-20', p: 'go', label: '上线' },
      bar({ id: 'b', p: 'dev', s: '2026-08-18', e: '2026-08-22', done: 0 })
    ] };
    expect(currentPhase(mo, today)).toBe('开发');
  });

  it('没有进行中的任务但有未完成任务 → 待启动', () => {
    const mo = { name: 'A', bars: [bar({ id: 'b', p: 'dev', s: '2026-09-01', e: '2026-09-05', done: 0 })] };
    expect(currentPhase(mo, today)).toBe('待启动');
  });

  it('全部任务完成 → 已全部完成', () => {
    const mo = { name: 'A', bars: [bar({ id: 'b', p: 'dev', done: 100 })] };
    expect(currentPhase(mo, today)).toBe('已全部完成');
  });

  it('没有任务 → 已全部完成（与卡片既有行为一致）', () => {
    expect(currentPhase({ name: 'A', bars: [] }, today)).toBe('已全部完成');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core.test.js`
Expected: FAIL — `currentPhase is not a function`（或 import 解析失败）

- [ ] **Step 3: 实现 `currentPhase`**

在 `src/core/mod-tag.js` 的 `moduleTag` 函数之后追加（逻辑一字不差地从 `mod-card.js:92-93` 搬运，不做行为改动）：

```js
/**
 * 需求当前所处阶段：进行中的最早未完成任务所属阶段；
 * 没有进行中的任务但有未完成任务 → 「待启动」；全部完成 → 「已全部完成」。
 *
 * 从 views/mod-card.js 抽出：总览卡片与需求台账都要显示"现在到哪一步"，
 * 两处各写一份必然给出两个答案。
 */
export function currentPhase(mo, today) {
  const bars = (mo && mo.bars) || [];
  const curTask = bars
    .filter(b => !b.m && (!b.done || b.done < 100) && F(b.s) <= today && F(b.e) >= today)
    .sort((a, b) => F(a.s) - F(b.s))[0];
  if (curTask) return PNAME[curTask.p] || curTask.p;
  return bars.some(b => !b.m && (!b.done || b.done < 100)) ? '待启动' : '已全部完成';
}
```

- [ ] **Step 4: 让 `mod-card.js` 用它**

`src/views/mod-card.js` 的 import 行加上 `currentPhase`：

```js
import { computeModulePer, computePlanPct, milestoneName, moduleTag, currentPhase } from '../core/mod-tag.js';
```

删除 `:92-93` 两行（`const curTask = ...` / `const curPhase = ...`），并把 `:124` 的 `${curPhase}` 改为：

```js
        <span class="rmod-phase">${currentPhase(mo, today)}</span>
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/core.test.js tests/views.test.js tests/report-layout.test.js`
Expected: PASS（全部）

- [ ] **Step 6: 提交**

```bash
git add src/core/mod-tag.js src/views/mod-card.js tests/core.test.js
git commit -m "refactor(mod-tag): 当前阶段计算下沉 core，总览卡片与台账共用口径"
```

---

## Task 2: 抽取 `isGoMs` / `findGoMs` 到 core/versions.js

「上线里程碑」的识别口径（`p === 'go'` 或 label 含「上线」）目前埋在 `mutations.js` 内部，台账读「计划上线日」必须用同一口径。

**Files:**
- Modify: `src/core/versions.js`（追加）
- Modify: `src/scheduler/mutations.js:463-473`
- Test: `tests/version.test.js`

**Interfaces:**
- Produces: `isGoMs(b: Bar) => boolean`、`findGoMs(mo) => Bar | null`（多个上线里程碑时取最后一个）
- Consumes: 无

- [ ] **Step 1: 写失败测试**

`tests/version.test.js` 的 versions import 行追加两个函数：

```js
import {
  versionOfMap, versionProgress, versionStatus, modLate, sortVersions, isGoMs, findGoMs
} from '../src/core/versions.js';
```

在文件末尾追加：

```js
describe('versions: 上线里程碑识别（isGoMs / findGoMs）', () => {
  it('p === go 的里程碑算上线', () => {
    expect(isGoMs({ m: '2026-09-09', p: 'go' })).toBe(true);
  });

  it('没有 p 字段但 label 含「上线」也算（默认/历史数据的形状）', () => {
    expect(isGoMs({ m: '2026-09-09', label: '9/9 上线' })).toBe(true);
    expect(isGoMs({ m: '2026-11-13', label: '整体上线' })).toBe(true);
  });

  it('非里程碑、或无上线语义的里程碑都不算', () => {
    expect(isGoMs({ s: '2026-09-01', e: '2026-09-05', p: 'go' })).toBe(false);  // 没有 m，不是里程碑
    expect(isGoMs({ m: '2026-09-09', p: 'sit', label: '提测' })).toBe(false);
    expect(isGoMs(null)).toBe(false);
  });

  it('findGoMs 取最后一个上线里程碑', () => {
    const mo = { name: 'A', bars: [
      { id: 'x', m: '2026-09-09', label: '9/9 上线' },
      { id: 'y', m: '2026-11-13', p: 'go', label: '上线' }
    ] };
    expect(findGoMs(mo).id).toBe('y');
  });

  it('找不到时返回 null', () => {
    expect(findGoMs({ name: 'A', bars: [{ id: 'x', m: '2026-09-09', p: 'sit', label: '提测' }] })).toBe(null);
    expect(findGoMs({ name: 'A' })).toBe(null);
    expect(findGoMs(null)).toBe(null);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/version.test.js`
Expected: FAIL — `isGoMs is not a function`

- [ ] **Step 3: 实现并导出**

在 `src/core/versions.js` 的 `modLate` 之前插入（连同原注释一起搬过来，注释是这条口径的说明书）：

```js
// 该需求的「上线」里程碑（多个取最后一个，与 addModule 的创建顺序一致）。
//
// ⚠️ 不能只认 p === 'go'：默认数据与历史数据里的上线里程碑是 `{ m:'2026-09-09', label:'9/9 上线' }`，
// **没有 p 字段**（阶段色靠 `PCOL[b.p] || PCOL.go` 兜底，一直没人注意）。
// 只按 p 找会"找不到 → 补建一个"，于是每加入一次版本就凭空多出一个「上线」菱形。
// 故按「p === 'go' 或 label 里含上线」识别：这条口径同时覆盖默认数据里的"11/13 整体上线"。
export function isGoMs(b) {
  if (!b || !b.m) return false;
  if (b.p === 'go') return true;
  return /上线/.test(String(b.label || ''));
}

export function findGoMs(mo) {
  let ms = null;
  ((mo && mo.bars) || []).forEach(b => { if (isGoMs(b)) ms = b; });
  return ms;
}
```

- [ ] **Step 4: `mutations.js` 改用 core 版本**

`src/scheduler/mutations.js` 的 versions import 行改为：

```js
import { newVersionId, versionOfMap, isGoMs, findGoMs } from '../core/versions.js';
```

删除文件内 `:463-473` 的 `isGoMs` / `findGoMs` 定义（含其上方的长注释，注释已随函数搬到 core）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/version.test.js tests/scheduler.test.js`
Expected: `scheduler.test.js` 全绿（它覆盖版本写入路径，用来确认搬运没改行为）；`version.test.js` 新增的 `isGoMs` / `findGoMs` 用例全绿，但该文件仍有 1 条历史失败（报告页「风险与关注点」含版本赶不上预警，见文末「已知不在范围内」），与本次搬运无关。

- [ ] **Step 6: 提交**

```bash
git add src/core/versions.js src/scheduler/mutations.js tests/version.test.js
git commit -m "refactor(versions): 上线里程碑识别抽到 core，供台账读取计划上线日"
```

---

## Task 3: `modStats` 下沉到 `core/mod-stats.js`

要让「按完成度排序」在 core 层实现，必须先把 `modStats` 从视图层下沉到 core —— `views → core` 是允许的依赖方向，反过来不行，否则 `core/mod-query.js` 就得把统计口径再实现一遍。

**Files:**
- Create: `src/core/mod-stats.js`
- Modify: `src/views/mod-card.js:24-34`（改为转出）
- Test: `tests/core.test.js`

**Interfaces:**
- Produces: `modStats(bars: Bar[], rng: {start:Date,end:Date}|null, ctx: {workday, today}) => { work: number, done: number, pct: number, planPct: number }`
- Consumes: `core/dates.js`、`core/mod-tag.js` 的 `computePlanPct`

- [ ] **Step 1: 写失败测试**

`tests/core.test.js` 追加 import 与用例：

```js
import { modStats } from '../src/core/mod-stats.js';
```

```js
describe('core: modStats 需求级进度（人日口径）', () => {
  const today = F('2026-08-20');
  const ctx = {
    today,
    workday: { workDays: (s, e) => Math.round((F(e) - F(s)) / 864e5) + 1 }   // 简算：含首尾的日历日
  };

  it('按人日加权：完成度 = 已完成人日 / 总人日', () => {
    const bars = [
      { id: 'a', p: 'dev', s: '2026-08-01', e: '2026-08-10', done: 100 },  // 10 人日，全完成
      { id: 'b', p: 'sit', s: '2026-08-11', e: '2026-08-20', done: 0 }     // 10 人日，未开始
    ];
    const r = modStats(bars, { start: F('2026-08-01'), end: F('2026-08-20') }, ctx);
    expect(r.work).toBe(20);
    expect(r.done).toBe(10);
    expect(r.pct).toBe(50);
  });

  it('里程碑不计入人日', () => {
    const bars = [
      { id: 'a', p: 'dev', s: '2026-08-01', e: '2026-08-10', done: 100 },
      { id: 'm', m: '2026-08-20', p: 'go', label: '上线' }
    ];
    expect(modStats(bars, { start: F('2026-08-01'), end: F('2026-08-20') }, ctx).work).toBe(10);
  });

  it('没有可算的任务时 pct 为 0（不出现 NaN）', () => {
    expect(modStats([], null, ctx).pct).toBe(0);
  });

  it('planPct 来自需求时间范围走过的比例', () => {
    // 8/1 ~ 8/21 共 20 天，今天 8/20 → 走过 19/20 = 95%
    const r = modStats([{ id: 'a', p: 'dev', s: '2026-08-01', e: '2026-08-21', done: 0 }],
      { start: F('2026-08-01'), end: F('2026-08-21') }, ctx);
    expect(r.planPct).toBe(95);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core.test.js`
Expected: FAIL — 找不到模块 `../src/core/mod-stats.js`

- [ ] **Step 3: 建文件（实现从 `mod-card.js:24-34` 原样搬）**

`src/core/mod-stats.js`：

```js
// ============================================================
// src/core/mod-stats.js — 需求级统计（人日口径完成度 + 时间口径应达基线）
//
// 从 views/mod-card.js 下沉：台账页的「按完成度排序」发生在 core 层（mod-query），
// core 不能反向 import views，故统计口径必须落在 core。
//
// 口径说明（与原实现逐字一致，勿在别处重算）：
//   work   = 需求内全部普通任务（非里程碑）的人日总和
//   done   = 按各任务完成度加权的人日
//   pct    = done / work × 100（无人日时为 0）
//   planPct= 需求时间范围到今天走过的比例（时间口径，与 pct 相减即"延后/超前"）
// ============================================================
import { computePlanPct } from './mod-tag.js';

export function modStats(bars, rng, ctx) {
  const { workday, today } = ctx;
  const tasks = (bars || []).filter(b => !b.m && b.s && b.e);
  const work = tasks.reduce((a, b) => a + workday.workDays(b.s, b.e), 0);
  const done = tasks.reduce((a, b) => a + workday.workDays(b.s, b.e) * ((b.done || 0) / 100), 0);
  return {
    work, done,
    pct: work ? Math.round((done / work * 100) * 100) / 100 : 0,
    planPct: computePlanPct(rng, today)
  };
}
```

- [ ] **Step 4: `mod-card.js` 改为转出**

删除 `src/views/mod-card.js:23-34` 的 `modStats` 定义与上方注释，改为（放在 import 区之后的文件顶部）：

```js
// 需求级统计已下沉 core（台账页需要在 core 层排序时用到），此处转出以保持既有调用方不变
export { modStats } from '../core/mod-stats.js';
```

同时删除该文件 import 中不再使用的 `computePlanPct`：

```js
import { computeModulePer, milestoneName, moduleTag, currentPhase } from '../core/mod-tag.js';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/core.test.js tests/views.test.js tests/version.test.js tests/report-layout.test.js`
Expected: 除 `version.test.js` 那 1 条历史失败外全绿（`version-view.js` / `report-view.js` 仍在从 `mod-card.js` 引 `modStats`，转成 re-export 后不受影响）。

- [ ] **Step 6: 提交**

```bash
git add src/core/mod-stats.js src/views/mod-card.js tests/core.test.js
git commit -m "refactor(mod-stats): 需求级统计下沉 core，供 core 层排序复用"
```

---

## Task 4: `mod-card.js` 抽出并导出 `renderModDetailRows`

台账展开区的「阶段明细」必须与总览卡片逐行一致，抽成具名导出。

**Files:**
- Modify: `src/views/mod-card.js:95-112`
- Test: `tests/views.test.js`

**Interfaces:**
- Produces: `renderModDetailRows(mo, ctx) => string`（HTML 片段，`.rmod-row` 序列）
- Consumes: `ctx.workday`、`core/dates.js` 的 `F`/`fmtD`、`PCOL`/`PNAME`

- [ ] **Step 1: 写失败测试**

`tests/views.test.js` 的 mod-card 相关 import 处追加：

```js
import { renderModDetailRows } from '../src/views/mod-card.js';
```

在文件末尾追加：

```js
describe('views: renderModDetailRows 需求阶段明细', () => {
  it('每个普通任务一行，含阶段色条、日期、人日、进度', () => {
    const ctx = makeCtx();
    const mo = ctx.state.modules[0];
    const html = renderModDetailRows(mo, ctx);
    expect(html).toContain('class="rmod-row"');
    expect(html).toContain('rmod-dates');
    expect(html).toContain('人日');
    expect(html).toContain('rmod-pct-bar');
  });

  it('里程碑不占明细行', () => {
    const ctx = makeCtx();
    const mo = { name: 'X', bars: [
      { id: 'a', p: 'dev', s: '2026-08-12', e: '2026-08-14', w: 3, done: 0, res: [] },
      { id: 'm', m: '2026-08-20', p: 'go', label: '上线' }
    ] };
    expect((renderModDetailRows(mo, ctx).match(/class="rmod-row"/g) || []).length).toBe(1);
  });

  it('空需求返回空串（台账展开区据此不渲染该段）', () => {
    expect(renderModDetailRows({ name: 'X', bars: [] }, makeCtx())).toBe('');
    expect(renderModDetailRows({ name: 'X' }, makeCtx())).toBe('');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/views.test.js`
Expected: FAIL — `renderModDetailRows is not a function`

- [ ] **Step 3: 抽成具名导出**

在 `src/views/mod-card.js` 中，把 `:95-112` 的 `const detailRows = open ? bars...map(...).join('') : '';` 整段改为函数，并把 `renderModCard` 内的引用改为调用它：

```js
// 需求阶段明细行（总览卡片展开区与需求台账展开档案共用同一份 DOM）
// 台账页直接调用本函数，不再复制列结构与口径 —— 两处各写一份必然漂移。
export function renderModDetailRows(mo, ctx) {
  const { workday } = ctx;
  return ((mo && mo.bars) || []).filter(b => !b.m).sort((a, b) => F(a.s) - F(b.s)).map(b => {
    const pc = PCOL[b.p] || '#94a3b8';
    const phaseName = PNAME[b.p] || '任务';
    const taskName = (b.name || '').trim() || phaseName;   // 未自定义名时回退阶段名
    // 自定义过任务名时补一个阶段小标签，便于区分同阶段下的多个任务（如多个 dev 任务）
    const phaseTag = taskName !== phaseName
      ? `<span class="rmod-row-phase" style="color:${pc};background:${pc}14;border-color:${pc}33">${phaseName}</span>`
      : '';
    return `<div class="rmod-row"><span class="steel" style="background:${pc}"></span>
      <b title="${phaseName} · ${taskName}">${taskName}</b>${phaseTag}<span class="rmod-dates">${fmtD(F(b.s))}~${fmtD(F(b.e))}</span>
      <span class="rmod-work">${workday.workDays(b.s, b.e)} 人日</span>
      ${b.res && b.res.length ? `<span class="rmod-res">${b.res.join('、')}</span>` : ''}
      <span class="rmod-pct-bar"><i style="width:${Math.min(100, b.done || 0)}%"></i></span>
      <span class="rmod-pct">${b.done || 0}%</span>
      ${(b.done || 0) >= 100 ? '<span class="rmod-st done">已完成</span>' : ''}
      <span class="rmod-st ${b.manual ? 'man' : 'auto'}">${b.manual ? '手动' : '自动'}</span>
    </div>`;
  }).join('');
}
```

`renderModCard` 内改为：

```js
  const detailRows = open ? renderModDetailRows(mo, ctx) : '';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/views.test.js tests/report-layout.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/views/mod-card.js tests/views.test.js
git commit -m "refactor(mod-card): 阶段明细抽为 renderModDetailRows，供台账展开区复用"
```

---

## Task 5: 实现 `core/mod-query.js` 筛选与排序

**Files:**
- Create: `src/core/mod-query.js`
- Test: `tests/mod-query.test.js`（新建）

**Interfaces:**
- Consumes: `core/mod-tag.js` 的 `moduleTag`、`core/versions.js` 的 `versionOfMap`、`core/mod-stats.js` 的 `modStats`、`core/default-data.js` 的 `PRIORITIES`
- Produces:
  - `filterMods(mods, filter, deps) => Mod[]`
  - `sortMods(mods, key, dir, deps) => Mod[]`（返回新数组，不改入参）
  - `filter: { kw, status, pri, ver, scope, unscheduled }`（全部为字符串，`'all'` 表示不限）
  - `deps: { today: Date, versions: Version[], modRange: (mo) => ({start,end}|null), ctx: {workday, today} }`（`ctx` 供 `modStats` 用于 `pct` 排序）

- [ ] **Step 1: 写失败测试**

`tests/mod-query.test.js`：

```js
// 需求台账的筛选与排序：纯函数，不依赖 DOM
import { describe, it, expect } from 'vitest';
import { F } from '../src/core/dates.js';
import { filterMods, sortMods } from '../src/core/mod-query.js';

const today = F('2026-08-20');

// 三个需求，覆盖：有版本 / 无版本、有描述 / 无描述、有优先级 / 无优先级、归档 / 待排期
function makeMods() {
  return [
    { name: '官网改版', pri: 'P0', tag: 'x', tagc: '#000', bars: [
      { id: 'a', p: 'dev', s: '2026-08-10', e: '2026-08-14', w: 5, done: 100, res: [] },
      { id: 'b', p: 'sit', s: '2026-08-18', e: '2026-08-22', w: 5, done: 50, res: [] }
    ], desc: '首页视觉升级与性能优化' },
    { name: '数据看板', pri: 'P1', bars: [
      { id: 'c', p: 'dev', s: '2026-09-01', e: '2026-09-05', w: 5, done: 0, res: [] }
    ] },
    { name: '移动端适配', bars: [], unscheduled: true, desc: 'H5 全量适配' }
  ];
}

const versions = [{ id: 'v1', name: 'V2.3', date: '2026-09-09', shipped: false, shippedAt: null, mods: ['官网改版'] }];

const ctx = {
  today,
  workday: { workDays: (s, e) => Math.round((F(e) - F(s)) / 864e5) + 1 }
};
const modRange = mo => {
  const bars = (mo.bars || []).filter(b => !b.m && b.s && b.e);
  if (!bars.length) return null;
  const ss = bars.map(b => F(b.s)), es = bars.map(b => F(b.e));
  return { start: new Date(Math.min(...ss)), end: new Date(Math.max(...es)) };
};
const deps = { today, versions, modRange, ctx };

describe('mod-query: filterMods 筛选', () => {
  it('默认（全 all）返回全部需求，含待排期', () => {
    expect(filterMods(makeMods(), {}, deps).map(m => m.name))
      .toEqual(['官网改版', '数据看板', '移动端适配']);
  });

  it('关键词命中需求名', () => {
    expect(filterMods(makeMods(), { kw: '看板' }, deps).map(m => m.name)).toEqual(['数据看板']);
  });

  it('关键词命中描述正文', () => {
    expect(filterMods(makeMods(), { kw: '性能优化' }, deps).map(m => m.name)).toEqual(['官网改版']);
  });

  it('关键词大小写不敏感', () => {
    const mods = [{ name: 'ABC', bars: [] }];
    expect(filterMods(mods, { kw: 'abc' }, deps).length).toBe(1);
  });

  it('按状态筛选（待排期是人工状态，优先级最高）', () => {
    expect(filterMods(makeMods(), { status: '待排期' }, deps).map(m => m.name)).toEqual(['移动端适配']);
    expect(filterMods(makeMods(), { status: '已完成' }, deps).length).toBe(0);
  });

  it('按优先级筛选，none 表示未设置', () => {
    expect(filterMods(makeMods(), { pri: 'P0' }, deps).map(m => m.name)).toEqual(['官网改版']);
    expect(filterMods(makeMods(), { pri: 'none' }, deps).map(m => m.name)).toEqual(['移动端适配']);
  });

  it('按版本筛选，none 表示未加入任何版本', () => {
    expect(filterMods(makeMods(), { ver: 'v1' }, deps).map(m => m.name)).toEqual(['官网改版']);
    expect(filterMods(makeMods(), { ver: 'none' }, deps).map(m => m.name))
      .toEqual(['数据看板', '移动端适配']);
  });

  it('scope=archived 只看归档，scope=active 排除归档', () => {
    const mods = makeMods();
    mods[1].archived = true;
    expect(filterMods(mods, { scope: 'archived' }, deps).map(m => m.name)).toEqual(['数据看板']);
    expect(filterMods(mods, { scope: 'active' }, deps).map(m => m.name))
      .toEqual(['官网改版', '移动端适配']);
  });

  it('unscheduled=only / exclude', () => {
    expect(filterMods(makeMods(), { unscheduled: 'only' }, deps).map(m => m.name)).toEqual(['移动端适配']);
    expect(filterMods(makeMods(), { unscheduled: 'exclude' }, deps).map(m => m.name))
      .toEqual(['官网改版', '数据看板']);
  });

  it('多个条件是与关系', () => {
    const mods = makeMods();
    mods[0].archived = true;
    expect(filterMods(mods, { scope: 'active', kw: '适配' }, deps).map(m => m.name))
      .toEqual(['移动端适配']);
  });

  it('入参为 null / undefined 时返回空数组，不抛错', () => {
    expect(filterMods(null, {}, deps)).toEqual([]);
    expect(filterMods(undefined, {}, deps)).toEqual([]);
  });
});

describe('mod-query: sortMods 排序', () => {
  const names = (arr) => arr.map(m => m.name);

  it('order 键保持原顺序（甘特图的需求顺序）', () => {
    expect(names(sortMods(makeMods(), 'order', 'asc', deps)))
      .toEqual(['官网改版', '数据看板', '移动端适配']);
  });

  it('按需求名排序，支持升降序', () => {
    // 中文名的 localeCompare 全序依赖运行环境的 ICU 排序规则，直接断言全序会在不同 Node 版本上飘：
    // 只断言"升降序是同一集合且互为镜像"，再把排序口径钉在实现里（localeCompare zh-Hans-CN）
    const asc = names(sortMods(makeMods(), 'name', 'asc', deps));
    const desc = names(sortMods(makeMods(), 'name', 'desc', deps));
    expect(asc.slice().sort()).toEqual(desc.slice().sort());
    expect(asc[0]).toBe(desc[desc.length - 1]);
  });

  it('按优先级排序，未设置一律排最后（升序降序都一样）', () => {
    expect(names(sortMods(makeMods(), 'pri', 'asc', deps)))
      .toEqual(['官网改版', '数据看板', '移动端适配']);
    expect(names(sortMods(makeMods(), 'pri', 'desc', deps)))
      .toEqual(['数据看板', '官网改版', '移动端适配']);
  });

  it('按排期开始日排序，无排期的排最后', () => {
    expect(names(sortMods(makeMods(), 'start', 'asc', deps)))
      .toEqual(['官网改版', '数据看板', '移动端适配']);
    expect(names(sortMods(makeMods(), 'start', 'desc', deps)))
      .toEqual(['数据看板', '官网改版', '移动端适配']);
  });

  it('按完成度排序', () => {
    // 官网改版 5*1 + 5*0.5 = 7.5/10 = 75%；数据看板 0%；移动端适配无任务 = 0%
    expect(names(sortMods(makeMods(), 'pct', 'desc', deps))[0]).toBe('官网改版');
  });

  it('不改动入参数组', () => {
    const mods = makeMods();
    const before = names(mods);
    sortMods(mods, 'start', 'desc', deps);
    expect(names(mods)).toEqual(before);
  });

  it('未知 key 视为 order', () => {
    expect(names(sortMods(makeMods(), 'nope', 'asc', deps)))
      .toEqual(['官网改版', '数据看板', '移动端适配']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/mod-query.test.js`
Expected: FAIL — 找不到模块 `../src/core/mod-query.js`

- [ ] **Step 3: 实现**

`src/core/mod-query.js`：

```js
// ============================================================
// src/core/mod-query.js — 需求台账的筛选与排序（纯函数）
//
// 为什么单独成模块：台账要把"筛什么、怎么排"与"怎么画"分开 ——
// 前者是本文件（无 DOM、可单测），后者是 views/req-view.js。
//
// 依赖全部通过参数注入（deps），因为状态、版本、时间范围都来自渲染 ctx：
//   deps.today    —— 状态判定基准（moduleTag）
//   deps.versions —— 所属版本筛选与排序
//   deps.modRange —— 排期起止（view/index.js 的 modRange）
//   deps.ctx      —— 传给 modStats 的渲染上下文（workday / today），仅 pct 排序需要
// ============================================================
import { moduleTag } from './mod-tag.js';
import { versionOfMap } from './versions.js';
import { modStats } from './mod-stats.js';
import { PRIORITIES } from './default-data.js';

const norm = s => String(s == null ? '' : s).toLowerCase();

export function filterMods(mods, filter, deps) {
  const f = filter || {};
  const { today } = deps || {};
  const kw = norm(f.kw).trim();
  const status = f.status || 'all';
  const pri = f.pri || 'all';
  const ver = f.ver || 'all';
  const scope = f.scope || 'all';
  const unsched = f.unscheduled || 'all';
  const owner = versionOfMap((deps && deps.versions) || []);

  return ((mods || [])).filter(mo => {
    if (!mo) return false;
    // 归档 / 待排期：两个正交维度，各自独立判定（设计文档 §4.3）
    if (scope === 'active' && mo.archived) return false;
    if (scope === 'archived' && !mo.archived) return false;
    if (unsched === 'only' && !mo.unscheduled) return false;
    if (unsched === 'exclude' && mo.unscheduled) return false;

    if (kw && !(norm(mo.name).includes(kw) || norm(mo.desc).includes(kw))) return false;
    if (status !== 'all' && moduleTag(mo, today).tag !== status) return false;

    if (pri !== 'all') {
      if (pri === 'none') { if (mo.pri) return false; }
      else if (mo.pri !== pri) return false;
    }

    if (ver !== 'all') {
      const v = owner[mo.name];
      if (ver === 'none') { if (v) return false; }
      else if (!v || v.id !== ver) return false;
    }
    return true;
  });
}

// 排序取值：{ v } 有值 / { miss: true } 无值
// 无值一律排最后（与升降序无关），避免缺失数据插队
function sortValue(mo, key, deps) {
  const { today, versions, modRange, ctx } = deps || {};
  switch (key) {
    case 'name':
      return { v: mo.name || '' };
    case 'status':
      return { v: moduleTag(mo, today).tag };
    case 'pri': {
      const i = PRIORITIES.indexOf(mo.pri);
      return i < 0 ? { miss: true } : { v: i };
    }
    case 'version': {
      const v = versionOfMap(versions || [])[mo.name];
      return v ? { v: v.date || '' } : { miss: true };
    }
    case 'start':
    case 'end': {
      const rng = modRange ? modRange(mo) : null;
      if (!rng) return { miss: true };
      return { v: key === 'start' ? rng.start.getTime() : rng.end.getTime() };
    }
    case 'pct': {
      const rng = modRange ? modRange(mo) : null;
      if (!rng || !ctx) return { miss: true };
      return { v: modStats(mo.bars, rng, ctx).pct };
    }
    case 'ship': {
      const v = versionOfMap(versions || [])[mo.name];
      // 计划上线日：版本日优先；无版本则回退该需求的上线里程碑
      if (!v || !v.date) return { miss: true };
      return { v: v.date };
    }
    default:
      return { v: 0 };
  }
}

export function sortMods(mods, key, dir, deps) {
  const list = [...((mods || []))];
  if (!key || key === 'order') {
    return dir === 'desc' ? list.reverse() : list;
  }
  const sign = dir === 'desc' ? -1 : 1;
  // 稳定排序：JS 的 Array#sort 自 ES2019 起稳定，装饰-排序-去装饰可保证同值保持原序
  return list
    .map((mo, i) => ({ mo, i, sv: sortValue(mo, key, deps) }))
    .sort((a, b) => {
      if (a.sv.miss && b.sv.miss) return a.i - b.i;
      if (a.sv.miss) return 1;      // 缺失永远在后
      if (b.sv.miss) return -1;
      const va = a.sv.v, vb = b.sv.v;
      let c = 0;
      if (typeof va === 'string' && typeof vb === 'string') c = va.localeCompare(vb, 'zh-Hans-CN');
      else c = va < vb ? -1 : (va > vb ? 1 : 0);
      return c !== 0 ? c * sign : a.i - b.i;
    })
    .map(x => x.mo);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/mod-query.test.js`
Expected: PASS（全部 15 条）

- [ ] **Step 5: 提交**

```bash
git add src/core/mod-query.js tests/mod-query.test.js
git commit -m "feat(mod-query): 需求台账的筛选与排序纯函数"
```

---

## Task 6: `desc` / `docUrl` 字段贯通（数据层 + 录入 UI）

**Files:**
- Modify: `src/scheduler/mutations.js`（`addModule`、`updateModule`）
- Modify: `src/components/shell.js:345` 之后（抽屉表单加两个控件）
- Modify: `src/components/modals.js`（`openNewModModal`、`openEditModModal`、`btnNewModSave`）
- Test: `tests/mobile-layout.test.js`

**Interfaces:**
- Produces: `addModule({ ..., desc, docUrl })`、`updateModule({ ..., desc, docUrl })`；需求对象上的 `mo.desc` / `mo.docUrl`
- 约定：空字符串归一为 `undefined`（清除字段），链接非法拒绝写入

- [ ] **Step 1: 写失败测试**

在 `tests/mobile-layout.test.js` 末尾追加（该文件已有 `readFileSync` 契约断言风格，沿用）：

```js
describe('需求台账：描述与需求文档字段贯通', () => {
  const modals = readFileSync(resolve(ROOT, 'src/components/modals.js'), 'utf8');
  const shell = readFileSync(resolve(ROOT, 'src/components/shell.js'), 'utf8');
  const muts = readFileSync(resolve(ROOT, 'src/scheduler/mutations.js'), 'utf8');

  it('抽屉里有描述与文档链接两个控件', () => {
    expect(shell).toContain('id="newModDesc"');
    expect(shell).toContain('id="newModDocUrl"');
  });

  it('打开时回显、保存时读取并校验', () => {
    expect(modals).toMatch(/g\('newModDesc'\)\.value = /);
    expect(modals).toMatch(/g\('newModDocUrl'\)\.value = /);
    // 新增与编辑两条路径都要带上两个新字段
    expect(modals).toMatch(/addModule\(\{[^}]*desc:[^}]*docUrl:/);
    expect(modals).toMatch(/updateModule\(\{[^}]*desc:[^}]*docUrl:/);
    // 只放行 http/https，挡掉伪协议（源码里是 /^https?:\/\//i 这个正则字面量）
    expect(modals).toContain('https?:\\/\\/');
    expect(modals).toContain('文档链接需以 http');
  });

  it('数据层接受两个字段，空串归一为 undefined', () => {
    expect(muts).toMatch(/if \('desc' in opts\)/);
    expect(muts).toMatch(/if \('docUrl' in opts\)/);
    expect(muts).toMatch(/delete mo\.desc/);
    expect(muts).toMatch(/delete mo\.docUrl/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/mobile-layout.test.js`
Expected: FAIL — 上面前三条断言均不通过

- [ ] **Step 3: 抽屉加控件**

`src/components/shell.js`，在 `newModPer` 那一行之后插入：

```html
    <div class="f-row"><label>描述<span class="phase-tip">给领导/业务看的一句话说明，会显示在需求台账页</span></label><textarea id="newModDesc" rows="3" placeholder="这个需求要解决什么问题、范围是什么"></textarea></div>
    <div class="f-row"><label>需求文档<span class="phase-tip">外部链接（语雀 / 飞书文档 / Confluence）</span></label><input type="text" id="newModDocUrl" placeholder="https://..."></div>
```

- [ ] **Step 4: `mutations.js` 支持两个字段**

`addModule` 内，在 `pri: normalizePriority(opts.pri) || PRIORITY_DEFAULT,` 之后（`bars: []` 之前）插入：

```js
      // 描述与需求文档：给领导/业务看的重内容，空串归一为 undefined（= 未填写）
      desc: (opts.desc || '').trim() || undefined,
      docUrl: (opts.docUrl || '').trim() || undefined,
```

`updateModule` 内，在 `if (opts.unscheduled != null) { ... }` 块之后、`ctx.collect()` 之前插入：

```js
    // 描述与需求文档：传空串 = 清除（回到"未填写"），与 tag/per 的归一化口径一致
    if ('desc' in opts) {
      const d = (opts.desc || '').trim();
      if (d) mo.desc = d; else delete mo.desc;
    }
    if ('docUrl' in opts) {
      const u = (opts.docUrl || '').trim();
      if (u) mo.docUrl = u; else delete mo.docUrl;
    }
```

- [ ] **Step 5: `modals.js` 回显与保存**

`openNewModModal` 内，`g('newModPer').value = '';` 之后加：

```js
  g('newModDesc').value = '';
  g('newModDocUrl').value = '';
```

`openEditModModal` 内，`g('newModPer').value = mo.per || autoPer;` 之后加：

```js
  g('newModDesc').value = mo.desc || '';
  g('newModDocUrl').value = mo.docUrl || '';
```

在 `bindModalControls` 内、`on('btnNewModSave', ...)` 之前加链接校验工具函数：

```js
  // 需求文档只放行 http/https：拦掉 javascript: 之类的伪协议（点开即执行）
  const readDocUrl = () => {
    const v = (g('newModDocUrl').value || '').trim();
    if (!v) return { ok: true, value: '' };
    return /^https?:\/\//i.test(v)
      ? { ok: true, value: v }
      : { ok: false, msg: '文档链接需以 http:// 或 https:// 开头' };
  };
```

`btnNewModSave` 回调开头，在取 `name` 之后加：

```js
    const doc = readDocUrl();
    if (!doc.ok) { deps.toast(doc.msg); return; }
```

编辑分支的 `updateModule({...})` 参数末尾补上：

```js
, desc: g('newModDesc').value, docUrl: doc.value
```

新增分支的 `addModule({...})` 参数末尾补上同样的两个字段。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/mobile-layout.test.js`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/scheduler/mutations.js src/components/shell.js src/components/modals.js tests/mobile-layout.test.js
git commit -m "feat(需求): 需求对象新增描述与需求文档链接，抽屉可录入并校验"
```

---

## Task 7: `req-view.js` — 页面骨架与主行表格

**Files:**
- Create: `src/views/req-view.js`
- Test: `tests/views.test.js`

**Interfaces:**
- Produces: `renderReqView(container, ctx) => string`
- Consumes: `ctx.state` / `ctx.today` / `ctx.modRange` / `ctx.workday` / `ctx.reqFilter` / `ctx.reqSort`
- DOM 契约（Task 9 的委托依赖这些属性名，务必一致）：
  - 行：`<tr class="req-row" data-req-row="需求名">`
  - 表头排序：`<th data-req-sort="key">`
  - 筛选：`<input data-req-q>`、`<select data-req-f="status|pri|ver|scope|unscheduled">`
  - 重置：`[data-req-reset]`；新建：`[data-req-new]`
  - 行内操作：`[data-req-edit]`、`[data-req-archive]`、`[data-req-del]`（后两者带 `data-name`）

- [ ] **Step 1: 写失败测试**

`tests/views.test.js` 追加 import 与用例：

```js
import { renderReqView } from '../src/views/req-view.js';
```

```js
// 台账渲染需要一个带 versions / reqFilter / reqSort 的 ctx
function makeReqCtx() {
  const ctx = makeCtx();
  ctx.state.versions = [{ id: 'v1', name: 'V2.3', date: '2026-09-09', shipped: false, shippedAt: null, mods: ['官网改版'] }];
  ctx.reqFilter = { kw: '', status: 'all', pri: 'all', ver: 'all', scope: 'all', unscheduled: 'all' };
  ctx.reqSort = { key: 'order', dir: 'asc' };
  return ctx;
}

describe('views: 需求台账主行表格', () => {
  it('渲染表头列与容器类', () => {
    const html = renderReqView(null, makeReqCtx());
    expect(html).toContain('req-wrap');
    expect(html).toContain('class="req-table"');
    ['需求', '状态', '描述', '文档', '所属版本', '排期', '进度', '上线情况', '操作']
      .forEach(h => expect(html).toContain(h));
  });

  it('标题区给出全量与筛选后计数', () => {
    const html = renderReqView(null, makeReqCtx());
    expect(html).toMatch(/共 \d+ 个需求/);
  });

  it('默认展示全部需求（含待排期与归档），归档行带标记', () => {
    const ctx = makeReqCtx();
    ctx.state.modules[1].archived = true;
    ctx.state.modules[2].unscheduled = true;
    const html = renderReqView(null, ctx);
    expect(html).toContain('data-req-row="官网改版"');
    expect(html).toContain('data-req-row="数据看板"');
    expect(html).toContain('data-req-row="移动端适配"');
    expect(html).toContain('req-badge-arch');
    expect(html).toContain('待排期');
  });

  it('未填写描述与文档时显示占位符，不留空白', () => {
    const html = renderReqView(null, makeReqCtx());
    expect(html).toContain('req-desc');
    expect(html).toContain('req-doc-empty');
  });

  it('筛选后计数反映筛选结果', () => {
    const ctx = makeReqCtx();
    ctx.reqFilter = { ...ctx.reqFilter, kw: '看板' };
    const html = renderReqView(null, ctx);
    expect(html).not.toContain('data-req-row="官网改版"');
    expect(html).toContain('data-req-row="数据看板"');
  });

  it('无命中时给空态与重置入口', () => {
    const ctx = makeReqCtx();
    ctx.reqFilter = { ...ctx.reqFilter, kw: '不存在的需求' };
    const html = renderReqView(null, ctx);
    expect(html).toContain('arch-empty');
    expect(html).toContain('data-req-reset');
  });

  it('操作列只读时整列隐藏（靠 req-act 类 + CSS）', () => {
    const html = renderReqView(null, makeReqCtx());
    expect(html).toMatch(/<th[^>]*class="[^"]*req-act/);
    expect(html).toContain('data-req-new');
    expect(html).toMatch(/class="btn primary req-act" data-req-new/);
  });

  it('上线情况列区分「未加入版本」与版本状态', () => {
    const html = renderReqView(null, makeReqCtx());
    expect(html).toContain('未加入版本');   // 数据看板 / 移动端适配均无版本
    expect(html).toContain('V2.3');        // 官网改版有版本
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/views.test.js`
Expected: FAIL — 找不到模块 `../src/views/req-view.js`

- [ ] **Step 3: 实现骨架与表格**

`src/views/req-view.js`：

```js
// ============================================================
// src/views/req-view.js — 需求台账页
//
// 定位（设计文档 §2）：与总览/版本同级的整页文档视图，给领导与业务人员看
// 「全量需求的字段对比 + 单个需求的完整档案」。归档不再是独立页面，
// 而是本页的一个筛选条件（scope）。
//
// 形态：语义化表格 + 行内展开档案。表格负责扫描对比（可排序筛选），
// 展开区负责细读（描述 / 文档 / 上线情况 / 阶段明细）。
//
// 纯渲染：不绑事件、不读 window。所有交互通过 data-req-* 交给
// components/req-page.js 委托。
// 展开态放模块级（跨重绘保持），与 report-view / version-view 同一思路 ——
// 它是界面临时状态，不该进 planStore（否则污染导出/同步/撤销）。
// ============================================================
import { F, fmtD } from '../core/dates.js';
import { moduleTag, currentPhase, computeModulePer } from '../core/mod-tag.js';
import { versionOfMod, versionStatus, modLate, findGoMs } from '../core/versions.js';
import { filterMods, sortMods } from '../core/mod-query.js';
import { modStats, renderModDetailRows } from './mod-card.js';
import { priorityBadge } from './badge.js';

const reqExpanded = new Set();

export function isReqExpanded(name) { return reqExpanded.has(name); }
export function toggleReqExpanded(name) {
  if (reqExpanded.has(name)) reqExpanded.delete(name);
  else reqExpanded.add(name);
  return reqExpanded.has(name);
}

const esc = s => String(s == null ? '' : s)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 上线情况：**不新增字段**，全部由版本数据合成（设计文档 §5）
// 口径边界：无版本的需求 versionStatus 会返回「未开始」，对读者是误导 ——
// 故这里先判版本存在性，无版本一律显示「未加入版本」。
export function shipInfo(mo, ctx) {
  const { state, today } = ctx;
  const v = versionOfMod(state, mo.name);
  const go = findGoMs(mo);
  const planFromMs = go && go.m ? go.m : null;

  if (mo.unscheduled) {
    return { text: '待排期', color: '#94a3b8', plan: null, actual: null, late: null };
  }
  if (!v) {
    return { text: '未加入版本', color: '#94a3b8', plan: planFromMs, actual: null, late: null };
  }
  const st = versionStatus(v, state, today);
  return {
    text: st.text, color: st.color,
    plan: v.date || planFromMs,
    actual: v.shipped ? v.shippedAt : null,
    late: modLate(v, mo)
  };
}

// 需求文档链接：只放行 http/https（渲染层再兜一道，双保险）
const safeDocUrl = u => (/^https?:\/\//i.test(String(u || '')) ? u : null);

function descCell(mo) {
  const d = (mo.desc || '').trim();
  if (!d) return '<span class="req-muted">—</span>';
  // 单行截断 + title 全文：让读者知道"点开有没有内容"
  return `<span class="req-desc" title="${esc(d)}">${esc(d)}</span>`;
}

function docCell(mo) {
  const u = safeDocUrl(mo.docUrl);
  if (!u) return '<span class="req-doc-empty req-muted">—</span>';
  return `<a class="req-doc" href="${esc(u)}" target="_blank" rel="noopener noreferrer"
    title="打开需求文档（新窗口）" aria-label="打开需求文档">📄</a>`;
}

function rowHtml(mo, ctx) {
  const { today, workday } = ctx;
  const { tag, tagc } = moduleTag(mo, today);
  const ship = shipInfo(mo, ctx);
  const ver = versionOfMod(ctx.state, mo.name);
  const rng = mo.unscheduled ? null : ctx.modRange(mo);
  const st = modStats(mo.bars, rng, ctx);
  const flags = `${mo.archived ? '<span class="req-badge-arch">已归档</span>' : ''}`;

  return `<tr class="req-row" data-req-row="${esc(mo.name)}">
    <td class="req-c-name">${priorityBadge(mo.pri)}<b>${esc(mo.name)}</b>${flags}</td>
    <td><span class="tag" style="background:${tagc}">${tag}</span></td>
    <td class="req-col-opt">${descCell(mo)}</td>
    <td class="req-col-opt">${docCell(mo)}</td>
    <td>${ver ? `${esc(ver.name)}<span class="req-sub">${ver.date ? fmtD(F(ver.date)) : ''}</span>` : '<span class="req-muted">未加入</span>'}</td>
    <td>${rng ? `<span class="req-sub">${fmtD(rng.start)}~${fmtD(rng.end)}</span>` : `<span class="req-muted">${mo.unscheduled ? '待排期' : '—'}</span>`}</td>
    <td class="req-c-pct">
      <span class="req-pbar"><i style="width:${Math.min(100, st.pct)}%"></i></span>
      <span class="req-sub">${st.pct.toFixed(0)}% · ${st.done.toFixed(1)}/${st.work} 人日</span>
    </td>
    <td>${shipCell(ship)}</td>
    <td class="req-ops req-act">
      <button type="button" class="btn sm" data-req-edit="${esc(mo.name)}">编辑</button>
      <button type="button" class="btn sm ghost" data-req-archive="${esc(mo.name)}" data-name="${esc(mo.name)}" data-archived="${mo.archived ? '1' : '0'}">${mo.archived ? '取消归档' : '归档'}</button>
      <button type="button" class="btn sm danger" data-req-del="${esc(mo.name)}" data-name="${esc(mo.name)}">删除</button>
    </td>
  </tr>`;
}

function shipCell(ship) {
  const parts = [`<span class="tag" style="background:${ship.color}">${ship.text}</span>`];
  if (ship.plan) parts.push(`<span class="req-sub">计划 ${fmtD(F(ship.plan))}</span>`);
  if (ship.actual) parts.push(`<span class="req-sub">实际 ${fmtD(F(ship.actual))}</span>`);
  if (ship.late) parts.push(`<span class="req-late" title="按当前排期算，最晚 ${fmtD(ship.late.end)} 才完成">赶不上 · 晚 ${ship.late.days} 天</span>`);
  return parts.join(' ');
}

function filterBar(ctx, filter, versions, total, shown) {
  const opt = (v, label, cur) => `<option value="${esc(v)}"${cur === v ? ' selected' : ''}>${label}</option>`;
  const verOpts = ['all', 'none', ...versions.map(v => v.id)]
    .map(v => {
      if (v === 'all') return opt('all', '全部版本', filter.ver);
      if (v === 'none') return opt('none', '未加入版本', filter.ver);
      const found = versions.find(x => x.id === v);
      return opt(v, found ? found.name : v, filter.ver);
    }).join('');
  return `<div class="req-bar">
    <button type="button" class="btn primary req-act" data-req-new>＋ 新建需求</button>
    <input type="search" class="req-q" data-req-q placeholder="搜索需求名或描述" value="${esc(filter.kw || '')}">
    <select class="req-f" data-req-f="status">
      ${['all', '待排期', '待启动', '进行中', '已逾期', '已完成'].map(v => opt(v, v === 'all' ? '全部状态' : v, filter.status)).join('')}
    </select>
    <select class="req-f" data-req-f="pri">
      ${['all', 'P0', 'P1', 'P2', 'P3', 'none'].map(v => opt(v, v === 'all' ? '全部优先级' : (v === 'none' ? '未设置' : v), filter.pri)).join('')}
    </select>
    <select class="req-f" data-req-f="ver">${verOpts}</select>
    <select class="req-f" data-req-f="scope">
      ${opt('all', '全部需求', filter.scope)}${opt('active', '排除已归档', filter.scope)}${opt('archived', '只看已归档', filter.scope)}
    </select>
    <select class="req-f" data-req-f="unscheduled">
      ${opt('all', '排期不限', filter.unscheduled)}${opt('only', '只看待排期', filter.unscheduled)}${opt('exclude', '排除待排期', filter.unscheduled)}
    </select>
    <button type="button" class="btn ghost" data-req-reset>重置</button>
    <span class="req-count">${shown === total ? `共 ${total} 个需求` : `筛选后 ${shown} 个 / 共 ${total} 个`}</span>
  </div>`;
}

export function renderReqView(container, ctx) {
  const { state, today } = ctx;
  const all = state.modules || [];
  const filter = ctx.reqFilter || {};
  const sort = ctx.reqSort || { key: 'order', dir: 'asc' };
  const deps = { today, versions: state.versions || [], modRange: ctx.modRange, ctx };
  const hit = sortMods(filterMods(all, filter, deps), sort.key, sort.dir, deps);
  const versions = state.versions || [];

  const head = `<div class="report-sec">
    <div class="report-head">需求台账<span>全部需求清单（含待排期与已归档）· 点任意一行展开需求档案</span></div>
    ${filterBar(ctx, filter, versions, all.length, hit.length)}`;

  if (!hit.length) {
    return `<div class="report-wrap req-wrap">${head}
      <div class="arch-empty">
        <b>没有符合条件的需求</b>
        <span>放宽筛选条件，或新建一个需求</span>
        <button type="button" class="btn ghost" data-req-reset>重置筛选</button>
      </div>
    </div></div>`;
  }

  const th = (key, label, cls = '') => {
    const on = sort.key === key ? ` class="on ${cls}"` : (cls ? ` class="${cls}"` : '');
    const arrow = sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th data-req-sort="${key}"${on}>${label}${arrow}</th>`;
  };

  const rows = hit.map(mo => rowHtml(mo, ctx)).join('');

  return `<div class="report-wrap req-wrap">
    ${head}
      <div class="req-scroll">
        <table class="req-table">
          <thead><tr>
            ${th('name', '需求')}
            ${th('status', '状态')}
            <th class="req-col-opt">描述</th>
            <th class="req-col-opt">文档</th>
            ${th('version', '所属版本')}
            ${th('start', '排期')}
            ${th('pct', '进度')}
            ${th('ship', '上线情况')}
            <th class="req-act">操作</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  </div>`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/views.test.js`
Expected: PASS（新增的 8 条）

- [ ] **Step 5: 提交**

```bash
git add src/views/req-view.js tests/views.test.js
git commit -m "feat(req-view): 需求台账主行表格渲染"
```

---

## Task 8: `req-view.js` — 行内展开档案

**Files:**
- Modify: `src/views/req-view.js`（`rowHtml` 之后接展开行）
- Test: `tests/views.test.js`

**Interfaces:**
- Consumes: Task 4 的 `renderModDetailRows`、Task 7 的 `shipInfo`
- Produces: `<tr class="req-detail-tr"><td colspan="9">…</td></tr>`，各信息段带 `data-req-sec="desc|doc|ship|progress|phases|ms"`

> 本任务会用到 `PCOL` / `PNAME`（里程碑圆点色与兜底名），请在 `views/req-view.js` 顶部补上：
> `import { PCOL, PNAME } from '../core/default-data.js';`
> （`computeModulePer` 在 Task 7 已随 import 引入，无需重复。）
> 测试文件 `tests/views.test.js` 需要额外引入展开态切换：`import { renderReqView, toggleReqExpanded } from '../src/views/req-view.js';`

- [ ] **Step 1: 写失败测试**

`tests/views.test.js` 追加：

```js
describe('views: 需求台账展开档案', () => {
  it('未展开时不渲染档案行', () => {
    const html = renderReqView(null, makeReqCtx());
    expect(html).not.toContain('req-detail-tr');
  });

  it('展开后依次包含描述、文档、上线情况、排期进度、阶段明细、里程碑六段', () => {
    const ctx = makeReqCtx();
    toggleReqExpanded('官网改版');
    const html = renderReqView(null, ctx);
    toggleReqExpanded('官网改版');   // 复位，避免污染其它用例
    expect(html).toContain('req-detail-tr');
    ['desc', 'doc', 'ship', 'progress', 'phases', 'ms']
      .forEach(s => expect(html).toContain(`data-req-sec="${s}"`));
  });

  it('描述以原文渲染并保留换行（用 pre-wrap 而非转义丢失）', () => {
    const ctx = makeReqCtx();
    ctx.state.modules[0].desc = '第一行\n第二行';
    toggleReqExpanded('官网改版');
    const html = renderReqView(null, ctx);
    toggleReqExpanded('官网改版');
    expect(html).toContain('req-desc-full');
    expect(html).toContain('第一行');
  });

  it('未填写描述时给出提示文案，不留空白', () => {
    const ctx = makeReqCtx();
    delete ctx.state.modules[0].desc;
    toggleReqExpanded('官网改版');
    const html = renderReqView(null, ctx);
    toggleReqExpanded('官网改版');
    expect(html).toContain('未填写描述');
  });

  it('文档链接带 target=_blank 与 rel=noopener', () => {
    const ctx = makeReqCtx();
    ctx.state.modules[0].docUrl = 'https://example.com/prd';
    toggleReqExpanded('官网改版');
    const html = renderReqView(null, ctx);
    toggleReqExpanded('官网改版');
    expect(html).toContain('href="https://example.com/prd"');
    expect(html).toMatch(/target="_blank"[^>]*rel="noopener noreferrer"/);
  });

  it('javascript: 伪协议链接一律不渲染为可点链接', () => {
    const ctx = makeReqCtx();
    ctx.state.modules[0].docUrl = 'javascript:alert(1)';
    toggleReqExpanded('官网改版');
    const html = renderReqView(null, ctx);
    toggleReqExpanded('官网改版');
    expect(html).not.toContain('javascript:');
  });

  it('阶段明细复用 renderModDetailRows 的 .rmod-row 结构', () => {
    const ctx = makeReqCtx();
    toggleReqExpanded('官网改版');
    const html = renderReqView(null, ctx);
    toggleReqExpanded('官网改版');
    expect(html).toContain('class="rmod-row"');
  });

  it('未展开的需求不输出档案行（只有被点开的那一条）', () => {
    const ctx = makeReqCtx();
    toggleReqExpanded('数据看板');
    const html = renderReqView(null, ctx);
    toggleReqExpanded('数据看板');
    expect((html.match(/class="req-detail-tr"/g) || []).length).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/views.test.js`
Expected: FAIL — `req-detail-tr` 不存在

- [ ] **Step 3: 实现档案行**

`src/views/req-view.js` 追加（`shipCell` 之后）：

```js
// 里程碑一览：需求内全部里程碑按日期升序（含需求确认 / 提测 / 上线）
function msList(mo) {
  const ms = ((mo.bars) || []).filter(b => b.m).sort((a, b) => F(a.m) - F(b.m));
  if (!ms.length) return '<span class="req-muted">该需求没有里程碑</span>';
  return ms.map(b => `<span class="req-ms"><i class="req-ms-dot" style="background:${PCOL[b.p] || '#94a3b8'}"></i>${esc(b.label || PNAME[b.p] || '里程碑')}<b>${fmtD(F(b.m))}</b></span>`).join('');
}

// 展开档案：把"一个需求的完整故事"摊开（设计文档 §4.2）
function detailHtml(mo, ctx) {
  const { today } = ctx;
  const ship = shipInfo(mo, ctx);
  const ver = versionOfMod(ctx.state, mo.name);
  const rng = mo.unscheduled ? null : ctx.modRange(mo);
  const st = modStats(mo.bars, rng, ctx);
  const desc = (mo.desc || '').trim();
  const docUrl = safeDocUrl(mo.docUrl);
  const per = computeModulePer(mo.bars || [], ctx.state.resources);
  const devi = st.work ? Math.round((st.pct - st.planPct) * 10) / 10 : 0;
  const deviTxt = !st.work ? '' : (devi < -0.5 ? `延后 ${Math.abs(devi).toFixed(0)}%` : (devi > 0.5 ? `超前 ${devi.toFixed(0)}%` : '按计划'));

  return `<tr class="req-detail-tr"><td colspan="9">
    <div class="req-detail">
      <div class="req-detail-sec" data-req-sec="desc">
        <h5>需求描述</h5>
        ${desc ? `<p class="req-desc-full">${esc(desc)}</p>` : '<p class="req-muted">未填写描述 —— 在「编辑」里补充，业务与领导都靠它理解需求</p>'}
      </div>
      <div class="req-detail-sec" data-req-sec="doc">
        <h5>需求文档</h5>
        ${docUrl ? `<a class="btn sm" href="${esc(docUrl)}" target="_blank" rel="noopener noreferrer">打开需求文档 ↗</a>` : '<p class="req-muted">未填写需求文档链接</p>'}
      </div>
      <div class="req-detail-sec" data-req-sec="ship">
        <h5>上线情况</h5>
        <div class="req-kv">
          <span><i>状态</i><b style="color:${ship.color}">${ship.text}</b></span>
          <span><i>所属版本</i><b>${ver ? esc(ver.name) : '未加入版本'}</b></span>
          <span><i>计划上线</i><b>${ship.plan ? fmtD(F(ship.plan)) : '—'}</b></span>
          <span><i>实际上线</i><b>${ship.actual ? fmtD(F(ship.actual)) : '—'}</b></span>
        </div>
        ${ship.late ? `<p class="req-late-note">按当前排期算，最晚 ${fmtD(ship.late.end)} 才能完成，比版本上线日晚 ${ship.late.days} 天。</p>` : ''}
      </div>
      <div class="req-detail-sec" data-req-sec="progress">
        <h5>排期与进度</h5>
        <div class="req-kv">
          <span><i>排期</i><b>${rng ? `${fmtD(rng.start)} ~ ${fmtD(rng.end)}` : (mo.unscheduled ? '待排期' : '—')}</b></span>
          <span><i>当前阶段</i><b>${currentPhase(mo, today)}</b></span>
          <span><i>完成度</i><b>${st.pct.toFixed(1)}%（${st.done.toFixed(1)} / ${st.work} 人日）</b></span>
          <span><i>对比计划</i><b>${deviTxt || '—'}</b></span>
          <span><i>人员</i><b>${per || '暂无人员'}</b></span>
        </div>
      </div>
      <div class="req-detail-sec" data-req-sec="phases">
        <h5>阶段明细</h5>
        ${renderModDetailRows(mo, ctx) || '<p class="req-muted">该需求还没有任务</p>'}
      </div>
      <div class="req-detail-sec" data-req-sec="ms">
        <h5>里程碑</h5>
        <div class="req-ms-list">${msList(mo)}</div>
      </div>
    </div>
  </td></tr>`;
}
```

在 `renderReqView` 里把行拼装改为带展开行：

```js
  const rows = hit.map(mo => rowHtml(mo, ctx) + (reqExpanded.has(mo.name) ? detailHtml(mo, ctx) : '')).join('');
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/views.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/views/req-view.js tests/views.test.js
git commit -m "feat(req-view): 行内展开需求档案（描述/文档/上线/进度/阶段/里程碑）"
```

---

## Task 9: `components/req-page.js` 事件委托

**Files:**
- Create: `src/components/req-page.js`
- Modify: `src/components/index.js`（接线）
- Test: `tests/components.test.js`

**Interfaces:**
- Produces: `bindReqPage(deps) => {}`（本页无对外 API，返回空对象）
- Consumes: `deps.gantt`（容器）、`deps.viewState`、`deps.render()`、`deps.planStore`、`deps.sched`（mutations）、`deps.toast`、`deps.modals`

- [ ] **Step 1: 写失败测试**

`tests/components.test.js` 追加（该文件用轻量 DOM 替身，沿用其既有 helper；若文件内没有可复用的替身，就用下面的最小实现）：

```js
import { bindReqPage } from '../src/components/req-page.js';

// 最小 DOM 替身：只在 #gantt 上记录监听器，供断言"委托绑在哪、绑了什么"
function fakeGantt() {
  const handlers = {};
  return {
    handlers,
    addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null
  };
}

describe('req-page: 台账事件委托', () => {
  const makeDeps = () => {
    const gantt = fakeGantt();
    const viewState = { reqFilter: { kw: '', status: 'all', pri: 'all', ver: 'all', scope: 'all', unscheduled: 'all' }, reqSort: { key: 'order', dir: 'asc' } };
    let rendered = 0;
    return {
      gantt, viewState,
      rendered: () => rendered,
      render: () => { rendered++; },
      toast: () => {},
      planStore: { state: { modules: [{ name: 'A', bars: [] }] } },
      sched: { updateModule: () => {}, archiveModule: () => {}, deleteModule: () => {} },
      getEl: () => null,
      doc: null
    };
  };

  it('把 click / input / change 委托绑在 #gantt 上，各只绑一次', () => {
    const deps = makeDeps();
    bindReqPage(deps);
    expect(deps.gantt.handlers.click.length).toBe(1);
    expect(deps.gantt.handlers.input.length).toBe(1);
    expect(deps.gantt.handlers.change.length).toBe(1);
  });

  it('容器或 viewState 缺失时安全返回 null，不抛错', () => {
    expect(bindReqPage({ viewState: {} })).toBe(null);
    expect(bindReqPage({ gantt: fakeGantt() })).toBe(null);
  });

  it('viewState 没带 reqFilter/reqSort 时自动补默认值（两个入口不必各自记得加）', () => {
    const deps = makeDeps();
    delete deps.viewState.reqFilter;
    delete deps.viewState.reqSort;
    bindReqPage(deps);
    expect(deps.viewState.reqFilter.scope).toBe('all');
    expect(deps.viewState.reqSort.key).toBe('order');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/components.test.js`
Expected: FAIL — 找不到模块 `../src/components/req-page.js`

- [ ] **Step 3: 实现**

`src/components/req-page.js`：

```js
// ============================================================
// src/components/req-page.js — 需求台账页的事件委托
//
// 为什么单独成模块（与 work-filter.js / version-page.js 同样的理由）：
// 筛选条与行操作要在两个入口都能用 ——
//   1) 排期页：components/index.js 的 bindAll 里调用；
//   2) 导出的单文件查看器：main-standalone.js 没有组件层，得自己调。
//
// 一切都委托在 #gantt 容器上：renderAll 只替换它的 innerHTML，元素本身不换，
// 所以只需绑一次。唯一的坑是搜索框 —— 重绘会连带把它换掉、焦点丢失，
// 故记住光标位置，重绘后还原（与 work-filter.js 同一套处理）。
// ============================================================
import { defaultReqFilter, defaultReqSort } from '../core/mod-query.js';

export function bindReqPage(deps) {
  const g = deps && deps.gantt;
  const vs = deps && deps.viewState;
  if (!g || !vs || typeof g.addEventListener !== 'function') return null;
  // viewState 由各入口各自构造，这里兜底默认值 —— 免得两个入口都要记得加这两个字段
  if (!vs.reqFilter) vs.reqFilter = defaultReqFilter();
  if (!vs.reqSort) vs.reqSort = defaultReqSort();
  const curF = () => vs.reqFilter;
  const curS = () => vs.reqSort;

  let caret = null;   // 搜索框重绘后要还原的光标位置（null = 本次不需要还原）

  const apply = (opts) => {
    if (typeof deps.render === 'function') deps.render();
    // 换筛选范围 = 列表整块重排，留在原滚动位置多半落进空白，故回到顶部；打字则保持原位
    if (opts && opts.top && deps.gsc) deps.gsc.scrollTop = 0;
    if (caret != null) {
      const el = g.querySelector && g.querySelector('[data-req-q]');
      if (el) {
        el.focus();
        if (el.setSelectionRange) { try { el.setSelectionRange(caret, caret); } catch (e) { /* 类型不支持时忽略 */ } }
      }
      caret = null;
    }
  };

  // 搜索框：输入即筛（实时），命中需求名与描述正文
  g.addEventListener('input', e => {
    const el = e.target && e.target.closest ? e.target.closest('[data-req-q]') : null;
    if (!el) return;
    caret = el.selectionStart == null ? 0 : el.selectionStart;
    curF().kw = el.value;
    apply();
  });

  // 下拉筛选：换范围 → 回到顶部
  g.addEventListener('change', e => {
    const el = e.target && e.target.closest ? e.target.closest('[data-req-f]') : null;
    if (!el) return;
    curF()[el.dataset.reqF] = el.value || 'all';
    apply({ top: true });
  });

  g.addEventListener('click', e => {
    const t = e.target;
    if (!t || !t.closest) return;

    // ---- 只读也要能用的：展开 / 收起、排序、重置 ----
    const row = t.closest('[data-req-row]');
    if (row) { toggleExpand(row.dataset.reqRow); return; }

    const sortTh = t.closest('[data-req-sort]');
    if (sortTh) {
      const key = sortTh.dataset.reqSort;
      const s = curS();
      // 同列再点一次 = 反向；换列 = 该列升序
      if (s.key === key) s.dir = s.dir === 'asc' ? 'desc' : 'asc';
      else { s.key = key; s.dir = 'asc'; }
      apply({ top: true });
      return;
    }

    if (t.closest('[data-req-reset]')) {
      Object.assign(vs.reqFilter, defaultReqFilter());
      Object.assign(vs.reqSort, defaultReqSort());
      apply({ top: true });
      return;
    }

    // ---- 以下都会改数据 ----
    if (deps.isReadonly && deps.isReadonly()) return;

    if (t.closest('[data-req-new]')) {
      if (deps.modals) deps.modals.openNewModModal();
      return;
    }
    const edit = t.closest('[data-req-edit]');
    if (edit) {
      if (deps.modals) deps.modals.openEditModModal(edit.dataset.reqEdit);
      return;
    }
    const arch = t.closest('[data-req-archive]');
    if (arch) {
      const name = arch.dataset.name;
      const to = arch.dataset.archived === '1';
      deps.sched.archiveModule(name, !to);
      deps.render();
      deps.toast(to ? '已取消归档' : '已归档');
      return;
    }
    const del = t.closest('[data-req-del]');
    if (del) {
      const name = del.dataset.name;
      if (!confirm(`确认删除需求「${name}」及其所有任务？此操作不可撤销。`)) return;
      deps.sched.deleteModule(name);
      deps.render();
      deps.toast('已删除需求');
      return;
    }
  });

  function toggleExpand(name) {
    // 展开态由视图模块持有（跨重绘保持），这里只负责切换后重绘
    if (deps.toggleReqExpanded) deps.toggleReqExpanded(name);
    deps.render();
  }

  return {};
}
```

同时给 `src/core/mod-query.js` 追加两个默认值工厂（`req-page.js` 与两个入口都要用）：

```js
// 默认筛选与排序：入口（排期页 / 导出查看器）与组件层兜底共用一份，避免三处各写一套默认值
export function defaultReqFilter() {
  return { kw: '', status: 'all', pri: 'all', ver: 'all', scope: 'all', unscheduled: 'all' };
}
export function defaultReqSort() {
  return { key: 'order', dir: 'asc' };
}
```

- [ ] **Step 4: 接线到 `components/index.js`**

顶部 import 区加：

```js
import { bindReqPage } from './req-page.js';
```

在 `const versionPage = bindVersionPage(deps);` 之后加：

```js
  // 需求台账页：把 [data-req-*] 委托在 #gantt 上，一次绑定
  const reqPage = bindReqPage(deps);
```

返回值对象里，在 `versionPage,` 之后加 `reqPage,`。

同时需要把展开态切换函数注入 deps —— `main-gantt.js` 已经在 `ctxInjection` 里传了 `toggleReportExpanded`，照同样方式加 `toggleReqExpanded`：

`src/components/index.js` 的 `ctxInjection` 里，`toggleReportExpanded: rawDeps.toggleReportExpanded` 之后加：

```js
    toggleReqExpanded: rawDeps.toggleReqExpanded
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/components.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/components/req-page.js src/components/index.js src/core/mod-query.js tests/components.test.js
git commit -m "feat(req-page): 需求台账的展开/排序/筛选/行操作委托"
```

---

## Task 10: 导航与视图接入

**Files:**
- Modify: `src/components/shell.js:46-51`、`:100-106`、`:148-155`（三处导航）
- Modify: `src/components/toolbar.js:35-52`
- Modify: `src/views/index.js:20`、`:172-174`、`:200`
- Modify: `src/main-gantt.js:33`、`:103-119`
- Modify: `src/main-standalone.js:54`、`:94-97`、`:108-119`、`:142-148`
- Modify: `src/styles/gantt.css:346-348`、`:668`（body class 改名 —— 必须与本任务同步，否则视图切换的收敛规则对不上）
- Test: `tests/mobile-layout.test.js`、`tests/version.test.js`

> **本任务必须一并处理两条既有断言**，否则它们会因为 `arch-view` 消失而失败：
> 1. `tests/mobile-layout.test.js:171-187` 的 `归档视图收敛工具栏` 用例 —— 用例名改为 `需求台账收敛工具栏`，其中三条断言里的 `arch-view` 全部换成 `req-view`（`toolbar` 的 `classList.toggle`、`css` 的 `[data-report-hide]` 与 `[data-zoom-only]`、以及 `return v !== ...` 那一行）。
> 2. `tests/mobile-layout.test.js:374-377` 的 badge 断言（`archNavCount` / `archNavCountM`）—— 改为断言这两个 id 在 `shell.js` 与查看器壳里都不存在。

**Interfaces:**
- Consumes: Task 7/8 的 `renderReqView`、`toggleReqExpanded`、`isReqExpanded`；Task 9 的 `bindReqPage`
- Produces: `?view=req` 可用，`?view=arch` 别名重定向到 `req`

- [ ] **Step 1: 写失败测试**

`tests/mobile-layout.test.js` 追加：

```js
describe('需求台账：导航与视图接入', () => {
  const shell = readFileSync(resolve(ROOT, 'src/components/shell.js'), 'utf8');
  const toolbar = readFileSync(resolve(ROOT, 'src/components/toolbar.js'), 'utf8');
  const viewsIndex = readFileSync(resolve(ROOT, 'src/views/index.js'), 'utf8');
  const mainGantt = readFileSync(resolve(ROOT, 'src/main-gantt.js'), 'utf8');

  it('三处导航都有需求台账，且紧跟总览之后', () => {
    expect((shell.match(/data-view="req"/g) || []).length).toBe(3);
    expect((shell.match(/需求台账/g) || []).length).toBeGreaterThanOrEqual(3);
    // 总览之后紧跟 req
    expect(shell).toMatch(/data-view="report"[\s\S]{0,200}data-view="req"/);
    // 归档入口已不存在
    expect(shell).not.toContain('data-view="arch"');
  });

  it('导航不再带徽标', () => {
    expect(shell).not.toContain('archNavCount');
    expect(shell).not.toContain('reqNavCount');
  });

  it('工具栏按 req-view 收敛并排除缩放', () => {
    expect(toolbar).toMatch(/classList\.toggle\('req-view', v === 'req'\)/);
    expect(toolbar).toMatch(/return v !== 'report' && v !== 'req' && v !== 'work' && v !== 'version';/);
    expect(toolbar).not.toContain('arch-view');
  });

  it('视图分发把 req 交给整页文档模式', () => {
    expect(viewsIndex).toMatch(/view === 'req' \|\| view === 'work' \|\| view === 'version'/);
    expect(viewsIndex).toContain('renderReqView');
  });

  it('?view=arch 旧链接映射到 req（书签不失效）', () => {
    expect(mainGantt).toContain('arch');
    expect(mainGantt).toMatch(/VIEW_ALIAS|alias/i);
    expect(mainGantt).toMatch(/'req'/);
  });
});
```

`tests/version.test.js` 的 dispatch 契约断言更新为：

```js
    expect(src).toMatch(/view === 'req' \|\| view === 'work' \|\| view === 'version'/);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/mobile-layout.test.js tests/version.test.js`
Expected: FAIL — 全部新断言不通过

- [ ] **Step 3: 三处导航改造**

`src/components/shell.js` 的 `MI` 里，把 `arch` 图标改名并换成表格语义的图标（台账是清单，不是箱子）：

```js
  // 需求台账：表格/清单图标
  req: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.2" width="18" height="15.6" rx="2.2"/><path d="M3 9.4h18"/><path d="M9.4 9.4v10.4"/></svg>',
```

移动端底栏（原 `:46-51`）改为：

```html
  <button class="mnav-item" data-view="report">${MI.report}<span>总览</span></button>
  <button class="mnav-item" data-view="req">${MI.req}<span>需求台账</span></button>
  <button class="mnav-item" data-view="mod">${MI.mod}<span>甘特图</span></button>
  <button class="mnav-item" data-view="res">${MI.res}<span>规划器</span></button>
  <button class="mnav-item" data-view="work">${MI.work}<span>工作视图</span></button>
  <button class="mnav-item" data-view="version">${MI.version}<span>版本</span></button>${more}
```

桌面工具栏两处（`:100-106` 与 `:148-155`）都改为：

```html
    <button class="btn" data-view="report">总览</button>
    <button class="btn" data-view="req" title="全部需求清单：可排序筛选，点行展开需求档案">需求台账</button>
    <button class="btn" data-view="mod">甘特图</button>
    <button class="btn" data-view="res">工作组规划器</button>
    <button class="btn" data-view="work" title="资源工作视图：按人查看每个人手里的任务、优先级与状态">资源工作视图</button>
    <button class="btn" data-view="version" title="版本（迭代）：给一组需求一个统一上线日，一起上线">版本</button>
```

- [ ] **Step 4: 工具栏与视图分发**

`src/components/toolbar.js`：

```js
  body.classList.toggle('report-view', v === 'report');
  body.classList.toggle('work-view', v === 'work');
  body.classList.toggle('req-view', v === 'req');
  body.classList.toggle('version-view', v === 'version');
```

```js
  return v !== 'report' && v !== 'req' && v !== 'work' && v !== 'version';
```

同时把 `:35` 注释里的 `arch-view` 改成 `req-view`。

`src/styles/gantt.css` 的两处 body class 必须在本任务一起改名 —— 工具栏 class 与 CSS 收敛规则是配套的，分开改会出现"切了视图但工具栏不收"的空窗：

```css
body.req-view [data-report-hide]:not(.stats){display:none}
```

```css
body.req-view .msheet-item[data-zoom-only]{display:none}
```

（`:346-347` 注释里的「归档页」一并改为「需求台账页」。）

`src/views/index.js`（三处都要**替换**掉 archive 的引用，不能只追加 —— Task 11 会删除 `archive-view.js`，留下残留引用会直接报"模块找不到"）：

1. `:20` 的 `import { renderArchiveView } from './archive-view.js';` → `import { renderReqView } from './req-view.js';`
2. `:172-174` 的整页文档分支：

```js
  if (view === 'req' || view === 'work' || view === 'version') {
    gantt.innerHTML = view === 'req' ? renderReqView(gantt, full)
      : (view === 'work' ? renderWorkView(gantt, full) : renderVersionView(gantt, full));
```

3. `:200` 的 `export { renderArchiveView } from './archive-view.js';` → `export { renderReqView, toggleReqExpanded, isReqExpanded } from './req-view.js';`

- [ ] **Step 5: 两个入口接线**

`src/main-gantt.js`：

```js
import { renderAll, buildViewCtx, toggleReportExpanded, toggleReqExpanded } from './views/index.js';
import { defaultReqFilter, defaultReqSort } from './core/mod-query.js';
```

```js
// 旧链接兼容：归档页已被需求台账取代，老书签 ?view=arch 重定向到 req
const VIEW_ALIAS = { arch: 'req' };
const rawView = params.get('view');
const viewFromQuery = ['res', 'report', 'mod', 'req', 'work', 'version'].includes(VIEW_ALIAS[rawView] || rawView)
  ? (VIEW_ALIAS[rawView] || rawView)
  : 'report';
```

`viewState` 里加：

```js
    reqFilter: defaultReqFilter(),
    reqSort: defaultReqSort(),
```

`buildCtx` 的返回对象里加：

```js
      reqFilter: viewState.reqFilter,
      reqSort: viewState.reqSort,
```

`bindAll({ ... })` 的调用参数里，在 `toggleReportExpanded` 旁边补上展开态切换（`components/index.js` 已在 Task 9 把它透传进 `ctxInjection`）：

```js
    toggleReportExpanded,
    toggleReqExpanded
```

`src/main-standalone.js`：同样加 import、`VIEW_ALIAS` 别名、`viewState.reqFilter/reqSort`、`buildCtx` 的两个字段；`syncToolbarForView` 里把 `arch-view` 换成：

```js
    document.body.classList.toggle('req-view', v === 'req');
```

并在 `bindVersionPage({...})` 之后加：

```js
  // 需求台账：查看器里同样要能展开档案 / 排序 / 筛选（领导看的就是这个）。
  // isReadonly 固定 true：查看器全只读，写操作拦在最前面（按钮另有 CSS 隐藏，这是第二道防线）
  bindReqPage({ gantt: baseCtx.gantt, gsc: baseCtx.gsc, viewState, render, toggleReqExpanded, isReadonly: () => true });
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/mobile-layout.test.js tests/version.test.js`
Expected: 新增断言全部通过；`version.test.js` 仍剩 1 条历史失败（报告页「风险与关注点」含版本赶不上预警，见文末「已知不在范围内」），非本任务引入。

- [ ] **Step 7: 提交**

```bash
git add src/components/shell.js src/components/toolbar.js src/views/index.js src/main-gantt.js src/main-standalone.js tests/mobile-layout.test.js tests/version.test.js
git commit -m "feat(需求台账): 接入视图分发与三处导航，归档页退出导航"
```

---

## Task 11: 删除归档页与徽标代码

**Files:**
- Delete: `src/views/archive-view.js`
- Modify: `src/components/problem-drawer.js:27-40`、`:105`
- Modify: `src/components/gantt-interactions.js:17`、`:28`、`:256`
- Modify: `src/views/work-view.js`（空态文案）
- Test: `tests/views.test.js`、`tests/module-archive.test.js`

- [ ] **Step 1: 改测试（先删契约）**

`tests/views.test.js`：删除 `import { renderArchiveView }` 一行，并整段删除 `describe('views: 归档需求页面（档案柜）', ...)` 这个 describe 块（原来的 6 条用例）。

`tests/module-archive.test.js`：删除文件顶部 `import { renderArchiveView } from '../src/views/archive-view.js';`，并删除使用它的那条用例（`已归档需求在归档页渲染…`，约 `:167`）。该文件其余用例（归档/取消归档的 mutation 行为）**保留**——归档能力仍然存在，只是入口变了。

- [ ] **Step 2: 跑测试确认仍然通过（建立删除前的基线）**

Run: `npx vitest run tests/views.test.js tests/module-archive.test.js`
Expected: PASS —— 本步只删了测试用例、还没动源码，所以必须全绿。若此时 FAIL，说明还有别的用例依赖 `archive-view.js`，先一并清理再继续。

- [ ] **Step 3: 删除文件与徽标代码**

```bash
git rm src/views/archive-view.js
```

`src/components/problem-drawer.js`：删除 `updateArchiveBadge` 函数（含其上方 `:27-28` 的注释）与返回值里的 `updateArchiveBadge: () => updateArchiveBadge(deps)` 一行。

`src/components/gantt-interactions.js`：import 行改为只引 `updateProblemBadge`，并删除 `:255-256` 两行（注释 + `updateArchiveBadge(deps);`）。

`src/views/work-view.js` 的空态文案改为：

```js
          <span>还有 ${archN} 项任务属于已归档需求，本页不再列出<br>要看它们去顶部的「需求台账」页并按「只看已归档」筛选；新建需求请去甘特图</span>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/views.test.js tests/module-archive.test.js tests/components.test.js`
Expected: PASS

- [ ] **Step 5: 全量测试确认没有遗漏引用**

Run: `npx vitest run`
Expected: PASS（既有 4 条失败用例除外——`auth.test.js` 的 `friendlyAuthError` 三条与 `version.test.js` 的报告页风险渲染一条，它们是本次改造之前就存在的历史失败，不在本计划范围内）

- [ ] **Step 6: 提交**

```bash
git add -A src/views/archive-view.js src/components/problem-drawer.js src/components/gantt-interactions.js src/views/work-view.js tests/views.test.js tests/module-archive.test.js
git commit -m "refactor(需求台账): 移除归档页与归档数徽标，归档改为台账筛选条件"
```

---

## Task 12: 台账页样式

**Files:**
- Modify: `src/styles/gantt.css`（`.arch-view` 两处改名 + 追加 `.req-*` 规则）
- Test: `tests/mobile-layout.test.js`

**Interfaces:**
- Consumes: Task 7/8 产出的 class 名（`.req-wrap` / `.req-table` / `.req-row` / `.req-detail` / `.req-col-opt` / `.req-act` / `.req-desc` / `.req-muted` / `.req-sub` / `.req-late` / `.req-badge-arch` / `.req-pbar` / `.req-kv` / `.req-ms` / `.req-desc-full` / `.req-late-note` / `.req-ms-list` / `.req-ms-dot` / `.req-bar` / `.req-count` / `.req-q` / `.req-f` / `.req-scroll` / `.req-c-name` / `.req-c-pct` / `.req-ops`）

- [ ] **Step 1: 写失败测试**

`tests/mobile-layout.test.js` 追加：

```js
describe('需求台账：样式契约', () => {
  it('归档页的 body class 规则已全部改名', () => {
    expect(css).not.toContain('body.arch-view');
    expect(css).toMatch(/body\.req-view \[data-report-hide\]:not\(\.stats\)\{display:none\}/);
    expect(css).toMatch(/body\.req-view \.msheet-item\[data-zoom-only\]\{display:none\}/);
  });

  it('台账容器比其它整页视图宽（1600px）', () => {
    expect(css).toMatch(/\.req-wrap\{[^}]*max-width:1600px/);
  });

  it('只读模式下写操作与操作列整列隐藏', () => {
    expect(css).toMatch(/body\.readonly-mode \.req-act\{display:none\}/);
  });

  it('窄屏隐藏描述与文档两个宽文本列', () => {
    expect(css).toMatch(/\.req-col-opt\{display:none\}/);
  });

  it('描述单行截断，避免把行高撑开', () => {
    expect(css).toMatch(/\.req-desc\{[^}]*text-overflow:ellipsis/);
    expect(css).toMatch(/\.req-desc\{[^}]*white-space:nowrap/);
  });

  it('展开区描述保留换行', () => {
    expect(css).toMatch(/\.req-desc-full\{[^}]*white-space:pre-wrap/);
  });

  it('容器可横向滚动（列多时不挤压内容）', () => {
    expect(css).toMatch(/\.req-scroll\{[^}]*overflow-x:auto/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/mobile-layout.test.js`
Expected: FAIL

- [ ] **Step 3: 确认 body class 改名已完成**

两处 `body.arch-view` → `body.req-view` 已在 Task 10 随工具栏一起改完（两者是配套规则，分两批改会开一个"切了视图但工具栏不收"的空窗）。本步只做确认：

Run: `git --no-pager grep -n "arch-view" -- src/styles/gantt.css`
Expected: 无输出

- [ ] **Step 4: 追加台账样式**

在 `gantt.css` 的 `.ver-*` 规则段之后追加：

```css
/* ============================================================
   需求台账页（.req-*）
   与其它整页视图共用 .report-mode / .report-sec / .report-head 骨架，
   这里只补表格自己的规则。容器比别的页宽：9 列在 1300px 下会过早出现横向滚动。
   ============================================================ */
.req-wrap{max-width:1600px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.req-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.req-q{width:220px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;font-size:12.5px;font-family:inherit}
.req-f{padding:7px 8px;border:1px solid var(--line);border-radius:8px;font-size:12.5px;font-family:inherit;background:#fff;color:#334155}
.req-count{margin-left:auto;font-size:11.5px;color:#64748b;font-variant-numeric:tabular-nums}
/* 列多时横向滚动，不挤压内容 */
.req-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.req-table{width:100%;border-collapse:collapse;font-size:12.5px}
.req-table th{position:sticky;top:0;z-index:1;background:#f8fafc;text-align:left;font-size:11.5px;font-weight:800;color:#475569;
  padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
.req-table th[data-req-sort]{cursor:pointer;user-select:none}
.req-table th[data-req-sort]:hover{color:var(--accent)}
.req-table th.on{color:var(--accent)}
.req-table td{padding:9px 10px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
.req-row{cursor:pointer;transition:background .12s}
.req-row:hover{background:var(--accent-soft)}
.req-c-name b{font-weight:800;color:#0f1729;margin-left:6px}
.req-c-name{min-width:180px}
.req-badge-arch{display:inline-block;margin-left:6px;font-size:10px;font-weight:800;color:#64748b;
  background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:1px 6px;white-space:nowrap}
.req-sub{margin-left:6px;font-size:10.5px;color:#64748b;font-variant-numeric:tabular-nums}
.req-muted{color:#94a3b8}
/* 描述列：单行截断 + title 放全文（让读者知道"点开有没有内容"） */
.req-desc{display:inline-block;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  vertical-align:bottom;color:#475569}
.req-doc{font-size:15px;text-decoration:none}
.req-doc-empty{font-size:12px}
.req-pbar{display:inline-block;width:70px;height:6px;border-radius:4px;background:#e2e8f0;overflow:hidden;vertical-align:middle}
.req-pbar i{display:block;height:100%;background:#16a34a}
.req-c-pct{white-space:nowrap}
.req-late{display:inline-block;margin-left:6px;font-size:10.5px;font-weight:800;color:#b91c1c;background:#fef2f2;
  border:1px solid #fecaca;border-radius:6px;padding:1px 6px;white-space:nowrap}
.req-ops{white-space:nowrap}
.req-ops .btn{margin-right:4px}
/* 只读：写操作与操作列整列隐藏（与 .ver-act 同一套机制） */
body.readonly-mode .req-act{display:none}
/* 展开档案 */
.req-detail-tr>td{padding:0;background:#fbfcfe}
.req-detail{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;padding:14px 16px;
  border-left:3px solid var(--accent)}
.req-detail-sec h5{margin:0 0 6px;font-size:11.5px;font-weight:800;color:#475569}
.req-desc-full{margin:0;font-size:12.5px;color:#334155;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.req-kv{display:flex;flex-direction:column;gap:4px}
.req-kv>span{display:flex;gap:8px;font-size:12px;color:#334155}
.req-kv i{flex:none;width:66px;font-style:normal;color:#94a3b8}
.req-kv b{font-weight:700}
.req-late-note{margin:6px 0 0;font-size:11.5px;color:#b91c1c;line-height:1.6}
.req-ms-list{display:flex;flex-wrap:wrap;gap:8px}
.req-ms{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:#334155;background:#fff;
  border:1px solid var(--line);border-radius:7px;padding:2px 8px}
.req-ms b{font-variant-numeric:tabular-nums;color:#0f1729}
.req-ms-dot{width:7px;height:7px;border-radius:50%;display:inline-block}
/* 窄屏：隐藏两个宽文本列，其余靠容器横向滚动兜底 */
@media(max-width:767px){
  .req-col-opt{display:none}
  .req-detail{grid-template-columns:1fr}
  .req-q{width:100%}
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/mobile-layout.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/styles/gantt.css tests/mobile-layout.test.js
git commit -m "style(需求台账): 表格与展开档案样式，归档页 body class 改名为 req-view"
```

---

## Task 13: 端到端验证

**Files:**
- 无代码改动；本任务是跑通并留证据

- [ ] **Step 1: 全量测试**

Run: `npx vitest run`
Expected: 只有 2 个文件失败、共 4 条用例：`tests/auth.test.js`（`friendlyAuthError` 三条）与 `tests/version.test.js`（报告页「风险与关注点」1 条）。这两处是本次改造**之前就存在**的历史失败（成因见下方"已知不在范围内"），其余全绿。

- [ ] **Step 2: 生产构建**

Run: `npm run build`
Expected: 构建成功，`dist/` 内 `index.html` / `gantt.html` 均引用到 `lib/supabase.js` 与 `supabase-config.js`（Task 10 没碰它们，此处是回归确认）

- [ ] **Step 3: 起开发服务器人工过一遍**

Run: `npm run dev`

逐项确认：

1. 顶部导航顺序为 总览 / 需求台账 / 甘特图 / 工作组规划器 / 资源工作视图 / 版本，且没有任何徽标
2. 点「需求台账」进入台账页：表格有 9 列，标题区显示「共 N 个需求」
3. 点表头「需求」「状态」「所属版本」「排期」「进度」「上线情况」都能排序，再点一次反向；空值始终在最后
4. 搜索框输入关键词能命中需求名与描述正文；换筛选下拉后列表回到顶部
5. 点任意一行展开档案：六段齐全（描述 / 文档 / 上线情况 / 排期与进度 / 阶段明细 / 里程碑）
6. 点「描述」与「文档」两列在窄窗口下随 `.req-col-opt` 隐藏（缩到 <767px）
7. 「+ 新建需求」能建；填一个非法文档链接（如 `abc`）会被拦下并提示
8. 行内「归档」→ 该行出现「已归档」标记；筛选切到「只看已归档」能看到它；「取消归档」能恢复
9. 行内「删除」→ 二次确认后需求消失
10. 访问 `gantt.html?project=<id>&view=arch` → 落到需求台账页（不是空白）
11. 打开一个**导出单文件**（`npm run build:export` 产物）：台账页只读，写操作与操作列不可见，但展开档案、排序、筛选都能用

- [ ] **Step 4: 确认无遗留引用**

Run: `git --no-pager grep -n "archive-view\|archNavCount\|updateArchiveBadge\|arch-view" -- src tests`
Expected: 无输出

- [ ] **Step 5: 提交收尾（若有手动修的问题）**

```bash
git add -A
git commit -m "fix(需求台账): 端到端验证中发现的问题"
```

若无改动则跳过本步。

---

## 已知不在范围内

以下 4 条测试失败在本次改造之前就存在，本计划不修（避免混入无关变更）：

- `tests/auth.test.js` 三条：`friendlyAuthError` 在飞书改造（`0163c6f`）中被简化成 3 条规则，邮件未确认 / 限流等错误不再映射中文。
- `tests/version.test.js` 一条：报告页「版本赶不上」预警已被 `4d65e8b` 移除，测试未同步。

如需一并修掉，应另开计划。

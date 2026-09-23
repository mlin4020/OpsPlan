# 需求生命周期与提出信息 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让需求台账能回答「谁提的 / 什么时候提的 / 走到生命周期哪道门」，并把排期里已有的「需求确认」「提测」两个里程碑提到台账主行。

**Architecture:** 需求对象新增 `proposedBy` / `proposedAt` / `lifecycle` 三个扁平字段（与现有 `desc` / `docUrl` / `pri` 同构，jsonb 无需 DDL）；台账新增三列并把展开档案加一小节；「需求确认时间 / 提测时间」**不新增字段**，一律从 `mo.bars` 的里程碑实时读取（单一事实来源）。字段读写分五层：`core/default-data.js`（常量）→ `core/mod-tag.js` / `core/mod-query.js`（纯函数）→ `scheduler/mutations.js`（写入）→ `views/`（渲染）→ `components/`（录入）。

**Tech Stack:** 原生 ES Module + Vite 5 + Vitest 2（node 环境，无 jsdom：DOM 契约以"源码文本 + 纯函数返回值"两路断言，仓库既有惯例见 `tests/mobile-layout.test.js` 的「字段贯通」describe）。

**设计依据:** `docs/superpowers/specs/2026-09-23-requirement-lifecycle-design.md`（已确认）

---

## 文件结构

| 文件 | 职责 | 本次动作 |
| --- | --- | --- |
| `src/core/default-data.js` | 枚举与归一化常量（与 `PRIORITIES` 并列） | 加 `MODULE_LIFECYCLE` / `LIFECYCLE_DEFAULT` / `LIFECYCLE_NONE` / `normalizeLifecycle` |
| `src/core/mod-tag.js` | 需求级纯函数 | 加 `findGateMs(mo, kind)` |
| `src/core/mod-query.js` | 台账筛选与排序纯函数 | 加 `collectProposers`；筛选加 `lifecycle`；排序加 3 个 key；关键词扩 `proposedBy` |
| `src/views/badge.js` | 渲染层徽标 HTML | 加 `lifecycleBadge` |
| `src/views/req-view.js` | 台账页纯渲染 | 三列 + 展开小节 + `colspan` 修正 |
| `src/scheduler/mutations.js` | 数据写入 | `addModule` / `updateModule` 支持三个字段 |
| `src/components/shell.js` | 静态外壳 DOM | 抽屉加提出人 / 提出时间 / 生命周期控件 |
| `src/components/modals.js` | 需求弹窗逻辑 | 回显、候选生成、读取并提交三个字段 |
| `src/styles/gantt.css` | 全站样式 | `.lc-*` 徽标配色 + 台账新列样式 |
| `tests/core.test.js` 等 5 个测试文件 | 回归保护 | 见各 Task |

**约定**：每个 Task 结束都跑一次 `npx vitest run` 并提交；不允许出现"测试留到最后一起跑"。

---

### Task 1: 生命周期常量与归一化

**Files:**
- Modify: `src/core/default-data.js`（在 `normalizePriority` 之后插入）
- Test: `tests/core.test.js`

- [ ] **Step 1: 更新测试文件的 import**

`tests/core.test.js` 第 5-8 行的 import 改为：

```js
import {
  PNAME, PCOL, PHASE_LIST,
  MODULE_LIFECYCLE, LIFECYCLE_DEFAULT, LIFECYCLE_NONE, normalizeLifecycle,
  defaultModules, defaultResources, defaultHolidays
} from '../src/core/default-data.js';
```

- [ ] **Step 2: 写失败测试（追加到 `tests/core.test.js` 末尾）**

```js
describe('core/default-data: 生命周期枚举与归一化', () => {
  it('MODULE_LIFECYCLE 是四档，数组顺序即流程顺序', () => {
    expect(MODULE_LIFECYCLE).toEqual(['待确认', '已确认', '已提测', '已上线']);
    expect(LIFECYCLE_DEFAULT).toBe('待确认');
    expect(LIFECYCLE_NONE).toBe('未设置');
  });

  it('normalizeLifecycle 只接受四档，其余一律 null', () => {
    MODULE_LIFECYCLE.forEach(v => expect(normalizeLifecycle(v)).toBe(v));
    // 带空格 / 大小写变体 / 不存在的档位 / 非字符串，一律视为未设置（不做 trim 兜底）
    [undefined, null, '', ' 已上线', '已上线 ', '上线', '待确认中', 0, {}].forEach(
      v => expect(normalizeLifecycle(v)).toBe(null)
    );
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/core.test.js`
Expected: FAIL —— `normalizeLifecycle is not a function`（或 import 报 "does not provide an export named"）

- [ ] **Step 4: 实现常量**

在 `src/core/default-data.js` 的 `normalizePriority` 那两行之后插入：

```js
// 需求生命周期状态（人工维护的「流程门」，与自动计算的 moduleTag 状态正交）：
//   台账的「状态」列由任务完成度自动推导（待启动/进行中/已逾期/已完成），
//   这一列是人在弹窗里选的流程进展，两列并存、语义不同（设计文档 §2）。
// 注意：数据层不补默认值 —— LIFECYCLE_DEFAULT 只被新建弹窗使用，
// 老数据缺失一律显示「未设置」，不替用户臆造「待确认」。
export const MODULE_LIFECYCLE = ['待确认', '已确认', '已提测', '已上线'];
export const LIFECYCLE_DEFAULT = '待确认';
export const LIFECYCLE_NONE = '未设置';   // 仅用于展示与筛选，不写入需求对象
export const normalizeLifecycle = v => (MODULE_LIFECYCLE.includes(v) ? v : null);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/core.test.js`
Expected: PASS（全部用例通过）

- [ ] **Step 6: 提交**

```bash
git add src/core/default-data.js tests/core.test.js
git commit -m "feat(core): 新增需求生命周期枚举与归一化"
```

---

### Task 2: `findGateMs` —— 关键时间点取值

**Files:**
- Modify: `src/core/mod-tag.js`（在 `milestoneName` 之后插入）
- Test: `tests/core.test.js`

- [ ] **Step 1: 更新测试文件的 import**

`tests/core.test.js` 第 10 行改为：

```js
import { computePlanPct, computeModuleTag, unscheduledModSet, moduleTag, currentPhase, findGateMs } from '../src/core/mod-tag.js';
```

- [ ] **Step 2: 写失败测试（追加到 `tests/core.test.js` 末尾）**

```js
describe('core/mod-tag: findGateMs 关键时间点（需求确认 / 提测）', () => {
  const mo = {
    name: 'X',
    bars: [
      { id: 'cfm', m: '2026-08-14', p: 'cfm', label: '需求确认' },
      { id: 'sit-task', s: '2026-08-17', e: '2026-08-21', p: 'sit', w: 5, res: [] },  // 测试任务，不是提测里程碑
      { id: 'tice', m: '2026-08-24', p: 'sit', label: '提测' },
      { id: 'go', m: '2026-09-09', p: 'go', label: '上线' }
    ]
  };

  it('确认：p=cfm 或 label 含「需求确认」都能认', () => {
    expect(findGateMs(mo, 'confirm').id).toBe('cfm');
    expect(findGateMs({ bars: [{ m: '2026-08-15', label: '需求确认' }] }, 'confirm').m).toBe('2026-08-15');
  });

  it('提测：按 label 认，不能把 p=sit 的测试任务当成提测里程碑', () => {
    expect(findGateMs(mo, 'submit').id).toBe('tice');
  });

  it('多个匹配取最后一个（与 findGoMs 同口径）', () => {
    const two = { bars: [
      { id: 'a', m: '2026-08-10', p: 'cfm', label: '需求确认' },
      { id: 'b', m: '2026-08-20', p: 'cfm', label: '需求确认（复议）' }
    ] };
    expect(findGateMs(two, 'confirm').id).toBe('b');
  });

  it('没有对应里程碑 / 未知 kind / 入参为 null 都返回 null', () => {
    expect(findGateMs({ bars: [] }, 'confirm')).toBe(null);
    expect(findGateMs(mo, 'nope')).toBe(null);
    expect(findGateMs(null, 'confirm')).toBe(null);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/core.test.js`
Expected: FAIL —— `findGateMs is not a function`

- [ ] **Step 4: 实现**

在 `src/core/mod-tag.js` 的 `milestoneName` 函数之后插入：

```js
/**
 * 关键时间点：从需求的任务条里取「需求确认」/「提测」里程碑（台账「关键时间」列用）
 *
 * kind: 'confirm' | 'submit'，返回里程碑 bar（含 m）或 null
 *
 * 为什么提测只能按 label 认：addModule 自动补建的提测里程碑是 { p:'sit', label:'提测' }，
 * 而 p:'sit' 同时也是「测试(SIT)」这个普通阶段 —— 只判 p 会把测试任务本身取出来，
 * 日期与语义都会错。
 *
 * 多个匹配取最后一个：与 core/versions.js 的 findGoMs 保持同一口径（重复里程碑以最新为准）。
 */
export function findGateMs(mo, kind) {
  const bars = (mo && mo.bars) || [];
  return bars.filter(b => {
    if (!b || !b.m) return false;
    const label = String(b.label || '');
    if (kind === 'confirm') return b.p === 'cfm' || label.includes('需求确认');
    if (kind === 'submit') return label.includes('提测');
    return false;
  }).pop() || null;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/core.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/core/mod-tag.js tests/core.test.js
git commit -m "feat(core): findGateMs 取需求确认 / 提测里程碑"
```

---

### Task 3: 提出人候选 + 生命周期筛选 + 三个排序键

**Files:**
- Modify: `src/core/mod-query.js`
- Test: `tests/mod-query.test.js`

- [ ] **Step 1: 更新测试文件的 import**

`tests/mod-query.test.js` 第 4 行改为：

```js
import { filterMods, sortMods, collectProposers, defaultReqFilter } from '../src/core/mod-query.js';
```

- [ ] **Step 2: 写失败测试（追加到 `tests/mod-query.test.js` 末尾）**

```js
describe('mod-query: collectProposers 提出人候选', () => {
  it('去重、忽略空值与首尾空格、保持首次出现顺序', () => {
    const mods = [
      { name: 'a', proposedBy: '张三' },
      { name: 'b', proposedBy: ' 李四 ' },
      { name: 'c' },
      { name: 'd', proposedBy: '   ' },
      { name: 'e', proposedBy: '张三' },
      { name: 'f', proposedBy: '王五' }
    ];
    expect(collectProposers(mods)).toEqual(['张三', '李四', '王五']);
  });

  it('空数组与非法入参返回空数组', () => {
    expect(collectProposers([])).toEqual([]);
    expect(collectProposers(null)).toEqual([]);
  });
});

describe('mod-query: 生命周期筛选与提出人关键词', () => {
  const mods = [
    { name: 'A', lifecycle: '已确认', proposedBy: '张三', bars: [] },
    { name: 'B', lifecycle: '待确认', proposedBy: '李四', bars: [] },
    { name: 'C', bars: [] }
  ];

  it('默认 filter 带 lifecycle:all（三处入口共用同一份默认值）', () => {
    expect(defaultReqFilter().lifecycle).toBe('all');
  });

  it('按生命周期筛选，none 表示未设置', () => {
    expect(names(filterMods(mods, { lifecycle: '已确认' }, deps))).toEqual(['A']);
    expect(names(filterMods(mods, { lifecycle: 'none' }, deps))).toEqual(['C']);
    expect(names(filterMods(mods, {}, deps))).toEqual(['A', 'B', 'C']);
  });

  it('关键词命中提出人（搜"某人提的需求"）', () => {
    expect(names(filterMods(mods, { kw: '李四' }, deps))).toEqual(['B']);
  });
});

describe('mod-query: 新增排序键（提出时间 / 生命周期 / 确认时间）', () => {
  it('按提出时间排序，未填写的排最后', () => {
    const mods = [
      { name: 'A', proposedAt: '2026-08-20', bars: [] },
      { name: 'B', bars: [] },
      { name: 'C', proposedAt: '2026-08-01', bars: [] }
    ];
    expect(names(sortMods(mods, 'proposed', 'asc', deps))).toEqual(['C', 'A', 'B']);
    expect(names(sortMods(mods, 'proposed', 'desc', deps))).toEqual(['A', 'C', 'B']);
  });

  it('按生命周期排序（枚举序），未设置排最后', () => {
    const mods = [
      { name: 'A', lifecycle: '已上线', bars: [] },
      { name: 'B', bars: [] },
      { name: 'C', lifecycle: '待确认', bars: [] }
    ];
    expect(names(sortMods(mods, 'lifecycle', 'asc', deps))).toEqual(['C', 'A', 'B']);
    expect(names(sortMods(mods, 'lifecycle', 'desc', deps))).toEqual(['A', 'C', 'B']);
  });

  it('按需求确认时间排序，没有确认里程碑的排最后', () => {
    const mods = [
      { name: 'A', bars: [{ id: 'x', m: '2026-08-05', p: 'cfm', label: '需求确认' }] },
      { name: 'B', bars: [] },
      { name: 'C', bars: [{ id: 'y', m: '2026-08-11', label: '需求确认' }] }
    ];
    expect(names(sortMods(mods, 'confirm', 'asc', deps))).toEqual(['A', 'C', 'B']);
    expect(names(sortMods(mods, 'confirm', 'desc', deps))).toEqual(['C', 'A', 'B']);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/mod-query.test.js`
Expected: FAIL —— `collectProposers is not a function` / `expect(undefined).toBe('all')`

- [ ] **Step 4: 实现**

`src/core/mod-query.js` 做 4 处改动。

(a) 顶部 import 改为：

```js
import { moduleTag, findGateMs } from './mod-tag.js';
import { versionOfMap, findGoMs } from './versions.js';
import { modStats } from './mod-stats.js';
import { PRIORITIES, MODULE_LIFECYCLE } from './default-data.js';
```

(b) `defaultReqFilter` 加一个键：

```js
export function defaultReqFilter() {
  return { kw: '', status: 'all', pri: 'all', ver: 'all', scope: 'all', unscheduled: 'all', lifecycle: 'all' };
}
```

(c) `filterMods` 内加常量与三处判定（`owner` 那行之后加 `lifecycle`，`kw` 那行扩 `proposedBy`，`pri` 判定之后加 `lifecycle` 判定）：

```js
  const scope = f.scope || 'all';
  const unsched = f.unscheduled || 'all';
  const lifecycle = f.lifecycle || 'all';
  const owner = versionOfMap((deps && deps.versions) || []);
```

```js
    // 关键词命中需求名 / 描述正文 / 提出人（"某人提的需求"要能搜到）
    if (kw && !(norm(mo.name).includes(kw) || norm(mo.desc).includes(kw) || norm(mo.proposedBy).includes(kw))) return false;
```

```js
    if (lifecycle !== 'all') {
      if (lifecycle === 'none') { if (mo.lifecycle) return false; }
      else if (mo.lifecycle !== lifecycle) return false;
    }
```

(d) `sortValue` 的 `switch` 里加三个 case（放在 `case 'ship'` 之前）：

```js
    case 'proposed':
      return mo.proposedAt ? { v: mo.proposedAt } : { miss: true };
    case 'lifecycle': {
      const i = MODULE_LIFECYCLE.indexOf(mo.lifecycle);
      return i < 0 ? { miss: true } : { v: i };
    }
    case 'confirm': {
      const cfm = findGateMs(mo, 'confirm');
      return cfm ? { v: cfm.m } : { miss: true };
    }
```

(e) 文件末尾（`sortMods` 之后）新增：

```js
// 提出人候选：从全量需求里收集已录入的提出人（去重、忽略空值、保持首次出现顺序）。
// 供需求弹窗的 <datalist> 用：既能选已有值，又能直接输新值（"允许新增选项"）。
// 不做人员字典表：提出人常是业务方，不一定在开发人员名单里（YAGNI）。
export function collectProposers(mods) {
  const out = [];
  const seen = new Set();
  (mods || []).forEach(mo => {
    const v = String((mo && mo.proposedBy) || '').trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  });
  return out;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/mod-query.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/core/mod-query.js tests/mod-query.test.js
git commit -m "feat(core): 台账生命周期筛选 / 提出人候选 / 三个新排序键"
```

---

### Task 4: 生命周期徽标与配色

**Files:**
- Modify: `src/views/badge.js`、`src/styles/gantt.css`
- Test: `tests/views.test.js`（徽标 HTML）、`tests/mobile-layout.test.js`（CSS 类名契约）

- [ ] **Step 1: 更新测试文件的 import**

`tests/views.test.js` 第 9 行改为：

```js
import { priorityBadge, lifecycleBadge } from '../src/views/badge.js';
```

`tests/mobile-layout.test.js` 顶部已有 `css`、`modals`、`shell`、`muts` 常量，无需改 import。

- [ ] **Step 2: 写失败测试**

追加到 `tests/views.test.js` 末尾：

```js
describe('views: 生命周期徽标', () => {
  it('四档各自映射到 lc-* 类名（结构固定，配色在 CSS）', () => {
    expect(lifecycleBadge('待确认')).toBe('<span class="lc lc-todo" title="生命周期（人工维护）：待确认">待确认</span>');
    expect(lifecycleBadge('已确认')).toContain('class="lc lc-ok"');
    expect(lifecycleBadge('已提测')).toContain('class="lc lc-sit"');
    expect(lifecycleBadge('已上线')).toContain('class="lc lc-live"');
  });

  it('未设置（缺字段 / 非法值）渲染 lc-none，不留空白', () => {
    [undefined, null, '', '已上线 '].forEach(v => {
      expect(lifecycleBadge(v)).toContain('class="lc lc-none"');
      expect(lifecycleBadge(v)).toContain('未设置');
    });
  });
});
```

追加到 `tests/mobile-layout.test.js` 末尾：

```js
describe('需求台账：生命周期徽标样式契约', () => {
  it('badge.js 产出的五个类名都能在 CSS 里找到，未设置用虚线', () => {
    ['lc-none', 'lc-todo', 'lc-ok', 'lc-sit', 'lc-live'].forEach(c => expect(css).toContain(`.${c}{`));
    expect(css).toMatch(/\.lc-none\{[^}]*border-style:dashed/);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/views.test.js tests/mobile-layout.test.js`
Expected: FAIL —— `lifecycleBadge is not a function`、`.lc-todo{` 找不到

- [ ] **Step 4: 实现徽标**

`src/views/badge.js`：import 行改为

```js
import { PRIORITIES, MODULE_LIFECYCLE, LIFECYCLE_NONE } from '../core/default-data.js';
```

并在文件末尾追加：

```js
// 生命周期徽标：与 priorityBadge 同一分工（只出结构，配色在 CSS 的 .lc-*）。
// 差别：未设置也渲染徽标 —— 台账该列不允许出现空白，
// 空白会让读者分不清"没填"和"渲染坏了"。
const LC_CLASS = { '待确认': 'lc-todo', '已确认': 'lc-ok', '已提测': 'lc-sit', '已上线': 'lc-live' };

export const lifecycleBadge = v => {
  const key = MODULE_LIFECYCLE.includes(v) ? v : null;
  const text = key || LIFECYCLE_NONE;
  return `<span class="lc ${LC_CLASS[key] || 'lc-none'}" title="生命周期（人工维护）：${text}">${text}</span>`;
};
```

同时把文件头注释最后一行（`// 只输出结构，配色全在 CSS（.pri-p0 ~ .pri-p3），` 那段）补一句生命周期同样只出结构：

```js
// 只输出结构，配色全在 CSS（.pri-p0 ~ .pri-p3 / .lc-*），
```

- [ ] **Step 5: 实现样式**

`src/styles/gantt.css`：在 `.pri-p3{...}` 那一行之后插入：

```css
/* 生命周期徽标（需求台账「生命周期」列）：与 .pri 同族的"浅底 + 描边"，
   与实心状态标签（.tag）区分开；未设置用虚线描边 —— 一眼能辨"没填"而不是渲染坏了。
   配色沿用项目数据语义色（灰=未开始 / 蓝=已定 / 琥珀=进行中 / 绿=完成），与主题品牌色无关。 */
.lc{display:inline-flex;align-items:center;flex:none;font-size:9px;font-weight:800;line-height:1;padding:2px 5px;border-radius:5px;border:1px solid;letter-spacing:.2px;white-space:nowrap}
.lc-none{color:#64748b;background:#f8fafc;border-color:#cbd5e1;border-style:dashed}
.lc-todo{color:#475569;background:#f1f5f9;border-color:#cbd5e1}
.lc-ok{color:#1d4ed8;background:#dbeafe;border-color:#93c5fd}
.lc-sit{color:#92400e;background:#fef3c7;border-color:#fcd34d}
.lc-live{color:#047857;background:#d1fae5;border-color:#6ee7b7}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/views.test.js tests/mobile-layout.test.js`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/views/badge.js src/styles/gantt.css tests/views.test.js tests/mobile-layout.test.js
git commit -m "feat(views): 生命周期徽标与配色"
```

---

### Task 5: 数据层写入三个新字段

**Files:**
- Modify: `src/scheduler/mutations.js`
- Test: `tests/scheduler.test.js`

- [ ] **Step 1: 写失败测试（追加到 `tests/scheduler.test.js` 末尾）**

```js
describe('scheduler: 需求提出信息与生命周期字段', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('addModule 落提出人与提出时间（提出人 trim）', () => {
    const sched = makeSched();
    const mo = sched.addModule({
      name: '字段样本', autoCreate: false,
      proposedBy: ' 张三 ', proposedAt: '2026-08-01', lifecycle: '已确认'
    });
    expect(mo.proposedBy).toBe('张三');
    expect(mo.proposedAt).toBe('2026-08-01');
    expect(mo.lifecycle).toBe('已确认');
  });

  it('addModule 不传 lifecycle 时不臆造默认值（默认「待确认」由新建弹窗给）', () => {
    const sched = makeSched();
    expect(sched.addModule({ name: '无生命周期', autoCreate: false }).lifecycle).toBe(undefined);
  });

  it('addModule 拒绝非法提出日期（手改 JSON / 外部导入的脏值）', () => {
    const sched = makeSched();
    const mo = sched.addModule({ name: '脏日期', autoCreate: false, proposedAt: '2026/08/01' });
    expect(mo.proposedAt).toBe(undefined);
  });

  it('updateModule 传空串 = 清除字段（回到未填写 / 未设置）', () => {
    const sched = makeSched();
    sched.addModule({
      name: '待清空', autoCreate: false,
      proposedBy: '李四', proposedAt: '2026-08-02', lifecycle: '已提测'
    });
    sched.updateModule({ oldName: '待清空', proposedBy: '', proposedAt: '', lifecycle: '' });
    const mo = mods().find(m => m.name === '待清空');
    expect('proposedBy' in mo).toBe(false);
    expect('proposedAt' in mo).toBe(false);
    expect('lifecycle' in mo).toBe(false);
  });

  it('updateModule 传非法 lifecycle 等同清除（回到未设置）', () => {
    const sched = makeSched();
    sched.addModule({ name: '非法状态', autoCreate: false, lifecycle: '已确认' });
    sched.updateModule({ oldName: '非法状态', lifecycle: '已验收' });
    expect('lifecycle' in mods().find(m => m.name === '非法状态')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scheduler.test.js`
Expected: FAIL —— `expected undefined to be '张三'`

- [ ] **Step 3: 实现**

(a) `src/scheduler/mutations.js` 第 12 行 import 改为：

```js
import { PNAME, MODULE_PHASES, MODULE_MILESTONE_PHASES, PRIORITY_DEFAULT, normalizePriority, normalizeLifecycle } from '../core/default-data.js';
```

(b) `addModule` 的 `tagc` 与 `pri` 之间插入（新建的需求对象）：

```js
      // 提出信息与生命周期（设计文档 §3）：
      //   · 提出人 trim 后空串归一为 undefined（与 desc / docUrl 同口径）
      //   · 提出时间只接受 YYYY-MM-DD，挡掉手改 JSON / 外部导入的脏值
      //   · lifecycle 不做默认值 —— 默认「待确认」由新建弹窗给。
      //     与 pri 的取舍不同：pri 有明确中位档（P2），生命周期没有；
      //     且老数据必须能原样保留「未设置」，数据层不能替用户臆造
      proposedBy: (opts.proposedBy || '').trim() || undefined,
      proposedAt: /^\d{4}-\d{2}-\d{2}$/.test(String(opts.proposedAt || '')) ? String(opts.proposedAt) : undefined,
      lifecycle: normalizeLifecycle(opts.lifecycle) || undefined,
```

(c) `updateModule` 的 `tagc` 那行之后、`pri` 注释之前插入：

```js
    // 提出信息与生命周期：传空串 / 非法值 = 清除（回到"未填写 / 未设置"），
    // 与 desc / docUrl 的归一化口径一致（字段直接 delete，不留空串）
    if (opts.proposedBy != null) {
      const by = (opts.proposedBy || '').trim();
      if (by) mo.proposedBy = by; else delete mo.proposedBy;
    }
    if (opts.proposedAt != null) {
      const at = String(opts.proposedAt || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(at)) mo.proposedAt = at; else delete mo.proposedAt;
    }
    if ('lifecycle' in opts) {
      const lc = normalizeLifecycle(opts.lifecycle);
      if (lc) mo.lifecycle = lc; else delete mo.lifecycle;
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/scheduler.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/scheduler/mutations.js tests/scheduler.test.js
git commit -m "feat(scheduler): addModule/updateModule 支持提出信息与生命周期"
```

---

### Task 6: 台账三列与展开档案小节

**Files:**
- Modify: `src/views/req-view.js`、`src/styles/gantt.css`
- Test: `tests/views.test.js`

- [ ] **Step 1: 写失败测试（追加到 `tests/views.test.js` 末尾）**

```js
describe('需求台账：提出 / 生命周期 / 关键时间三列', () => {
  it('三个列头齐全且可点排序', () => {
    const html = renderReqView(null, makeReqCtx());
    expect(html).toContain('data-req-sort="proposed"');
    expect(html).toContain('data-req-sort="lifecycle"');
    expect(html).toContain('data-req-sort="confirm"');
    expect(html).toMatch(/>提出/);
    expect(html).toMatch(/>生命周期/);
    expect(html).toMatch(/>关键时间/);
  });

  it('提出列显示提出人与日期，缺值时显示「—」', () => {
    const ctx = makeReqCtx();
    ctx.state.modules[0].proposedBy = '张三';
    ctx.state.modules[0].proposedAt = '2026-08-01';
    const withVal = renderReqView(null, ctx);
    expect(withVal).toContain('req-prop');
    expect(withVal).toContain('张三');
    expect(withVal).toContain('8/1');
    // 另两条需求都没有提出信息 → 渲染占位符而不是空白
    expect(withVal).toContain('req-muted">—');
  });

  it('生命周期列：有值出对应徽标，未设置出 lc-none', () => {
    const ctx = makeReqCtx();
    ctx.state.modules[0].lifecycle = '已提测';
    const html = renderReqView(null, ctx);
    expect(html).toContain('class="lc lc-sit"');
    expect(html).toContain('class="lc lc-none"');   // 其余两条需求未设置
  });

  it('关键时间列取确认与提测里程碑，测试任务不算提测', () => {
    const ctx = makeReqCtx();
    ctx.state.modules = [{
      name: '卡点样本',
      bars: [
        { id: 'cfm', m: '2026-08-14', p: 'cfm', label: '需求确认' },
        { id: 'sit-task', s: '2026-08-17', e: '2026-08-21', p: 'sit', w: 5, res: [] },
        { id: 'tice', m: '2026-08-24', p: 'sit', label: '提测' }
      ]
    }];
    const html = renderReqView(null, ctx);
    expect(html).toContain('req-gate');
    expect(html).toContain('8/14');                  // 确认
    expect(html).toContain('8/24');                  // 提测（不是 8/17 的测试任务）
  });

  it('没有任何里程碑的需求，关键时间显示「—」', () => {
    const ctx = makeReqCtx();
    ctx.state.modules = [{ name: '空需求', bars: [] }];
    const html = renderReqView(null, ctx);
    expect(html).not.toContain('req-gate');
    expect(html).toContain('req-muted">—');
  });
});
```

同时改动既有的两处：

1. `tests/views.test.js` 中「展开后依次包含描述、文档、上线情况、排期进度、阶段明细、里程碑六段」这个用例，把标题与断言列表改为七段，并把展开小节的新断言一起加上：

```js
  it('展开后依次包含提出与生命周期、描述、文档、上线情况、排期进度、阶段明细、里程碑七段', () => {
    const ctx = makeReqCtx();
    ctx.state.modules[0].lifecycle = '已确认';
    toggleReqExpanded('官网改版');
    const html = renderReqView(null, ctx);
    toggleReqExpanded('官网改版');   // 复位，避免污染其它用例
    expect(html).toContain('req-detail-tr');
    ['propose', 'desc', 'doc', 'ship', 'progress', 'phases', 'ms']
      .forEach(s => expect(html).toContain(`data-req-sec="${s}"`));
    // 档案行的 colspan 必须覆盖全部 12 列（少一列会让详情区错位）
    expect(html).toContain('colspan="12"');
  });
```

2. 在同文件中新增一条"提测里程碑不许被误认"的档案级用例（可选但建议）：

```js
  it('展开档案的「提出与生命周期」里，提测取里程碑而不是 SIT 任务', () => {
    const ctx = makeReqCtx();
    ctx.state.modules[0].bars = [
      { id: 'sit-task', s: '2026-08-17', e: '2026-08-21', p: 'sit', w: 5, res: [] },
      { id: 'tice', m: '2026-08-24', p: 'sit', label: '提测' }
    ];
    toggleReqExpanded('官网改版');
    const html = renderReqView(null, ctx);
    toggleReqExpanded('官网改版');
    // 只在「提出与生命周期」小节内断言：整页里 8/17 是 SIT 任务自己的日期（阶段明细 / 排期都会渲染），
    // 对整页断言 not.toContain('8/17') 会把正确实现判成失败（执行时已修正）
    const sec = html.slice(html.indexOf('data-req-sec="propose"'), html.indexOf('data-req-sec="desc"'));
    expect(sec).toContain('8/24');       // 提测 = 提测里程碑
    expect(sec).not.toContain('8/17');   // 而不是 SIT 任务的开始日
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/views.test.js`
Expected: FAIL —— `data-req-sort="proposed"` 找不到

- [ ] **Step 3: 实现单元格与列头**

(a) `src/views/req-view.js` 顶部 import 补两个函数：

```js
import { moduleTag, currentPhase, computeModulePer, progressDeviation, findGateMs } from '../core/mod-tag.js';
```

把 `priorityBadge` 那行改为：

```js
import { priorityBadge, lifecycleBadge } from './badge.js';
```

(b) 在 `docCell`（`req-view.js` 第 88-93 行）之后新增两个单元格渲染函数：

```js
// 提出信息：有哪项显示哪项，都没有显示「—」（与「未加入版本」同风格，不留空白）
function proposedCell(mo) {
  const by = (mo.proposedBy || '').trim();
  const at = (mo.proposedAt || '').trim();
  if (!by && !at) return '<span class="req-muted">—</span>';
  return [
    by ? `<b class="req-prop">${esc(by)}</b>` : '',
    at ? `<span class="req-sub">${fmtD(F(at))}</span>` : ''
  ].filter(Boolean).join(' ');
}

// 关键时间：需求确认 / 提测两个卡点的日期（不新增字段，实时读排期里程碑）
// 口径见 core/mod-tag.js 的 findGateMs：提测只能按 label 认，不能判 p='sit'
function gateCell(mo) {
  const cfm = findGateMs(mo, 'confirm');
  const tice = findGateMs(mo, 'submit');
  if (!cfm && !tice) return '<span class="req-muted">—</span>';
  const chip = (b, label) => `<span class="req-gate"><i style="background:${PCOL[b.p] || '#94a3b8'}"></i>${label}<b>${fmtD(F(b.m))}</b></span>`;
  return [cfm ? chip(cfm, '确认') : '', tice ? chip(tice, '提测') : ''].filter(Boolean).join('');
}
```

(c) `rowHtml` 的返回模板里，把三个 `<td>` 插到对应位置（顺序：需求 / **提出** / 状态 / **生命周期** / 描述 / 文档 / 所属版本 / 排期 / **关键时间** / 进度 / 上线情况 / 操作）：

```js
  return `<tr class="req-row" data-req-row="${esc(mo.name)}">
    <td class="req-c-name">${priorityBadge(mo.pri)}<b>${esc(mo.name)}</b>${archFlag}</td>
    <td class="req-col-opt">${proposedCell(mo)}</td>
    <td><span class="tag" style="background:${tagc}">${tag}</span></td>
    <td class="req-c-lc">${lifecycleBadge(mo.lifecycle)}</td>
    <td class="req-col-opt">${descCell(mo)}</td>
    <td class="req-col-opt">${docCell(mo)}</td>
    <td>${ver ? `${esc(ver.name)}<span class="req-sub">${ver.date ? fmtD(F(ver.date)) : ''}</span>` : '<span class="req-muted">未加入版本</span>'}</td>
    <td>${rng ? `<span class="req-sub">${fmtD(rng.start)}~${fmtD(rng.end)}</span>` : `<span class="req-muted">${mo.unscheduled ? '待排期' : '—'}</span>`}</td>
    <td class="req-c-gate">${gateCell(mo)}</td>
    <td class="req-c-pct">
```

（`<td class="req-c-pct">` 之后的内容保持原样，直到 `</tr>`）

(d) `th` 辅助函数支持列头 `title`（人工维护 / 排序口径都要说明），并把 3 个新列头插进 thead：

```js
  const th = (key, label, cls = '', title = '') => {
    const on = sort.key === key ? ' on' : '';
    const arrow = sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th data-req-sort="${key}" class="${(cls + on).trim()}"${title ? ` title="${esc(title)}"` : ''}>${label}${arrow}</th>`;
  };
```

```js
          <thead><tr>
            ${th('name', '需求')}
            ${th('proposed', '提出', 'req-col-opt', '提出人 / 提出时间；窄屏隐藏该列（背景信息，不是对比指标）')}
            ${th('status', '状态')}
            ${th('lifecycle', '生命周期', '', '人工维护的流程门，与左侧自动计算的「状态」不是同一件事')}
            <th class="req-col-opt">描述</th>
            <th class="req-col-opt">文档</th>
            ${th('version', '所属版本')}
            ${th('start', '排期')}
            ${th('confirm', '关键时间', '', '需求确认 / 提测两个卡点的排期日期；点击按需求确认时间排序，缺里程碑的排最后')}
            ${th('pct', '进度')}
            ${th('ship', '上线情况')}
            <th class="req-act">操作</th>
          </tr></thead>
```

- [ ] **Step 4: 实现展开档案小节与 colspan**

(a) `detailHtml` 顶部的取值区加 4 个变量：

```js
  const per = computeModulePer(mo.bars || [], ctx.state.resources);
  const propBy = (mo.proposedBy || '').trim();
  const propAt = (mo.proposedAt || '').trim();
  const cfmMs = findGateMs(mo, 'confirm');
  const ticeMs = findGateMs(mo, 'submit');
  const dev = progressDeviation(mo.bars, st);
```

(b) `colspan="9"` 改为 `colspan="12"`：

```js
  return `<tr class="req-detail-tr"><td colspan="12">
```

(c) 在 `<div class="req-detail">` 之后、`data-req-sec="desc"` 之前插入新小节：

```js
      <div class="req-detail-sec" data-req-sec="propose">
        <h5>提出与生命周期</h5>
        <div class="req-kv">
          <span><i>提出人</i><b>${propBy ? esc(propBy) : '—'}</b></span>
          <span><i>提出时间</i><b>${propAt ? fmtD(F(propAt)) : '—'}</b></span>
          <span><i>生命周期</i><b>${lifecycleBadge(mo.lifecycle)}</b></span>
          <span><i>需求确认</i><b>${cfmMs ? fmtD(F(cfmMs.m)) : '—'}</b></span>
          <span><i>提测</i><b>${ticeMs ? fmtD(F(ticeMs.m)) : '—'}</b></span>
        </div>
      </div>
```

(d) 把 `detailHtml` 上方的段序注释改为：

```js
// 展开档案：把「一个需求的完整故事」摊开（设计文档 §4.2）
// 七段固定顺序：提出与生命周期 → 描述 → 文档 → 上线情况 → 排期与进度 → 阶段明细 → 里程碑
```

- [ ] **Step 5: 实现新列样式**

`src/styles/gantt.css`：在 `.req-ms-dot{...}` 那一行之后插入：

```css
/* 需求台账新增三列（设计文档 §4.1）：都保持窄，避免 12 列过早横向滚动 */
.req-c-lc{white-space:nowrap}
.req-c-gate{white-space:nowrap}
.req-prop{font-weight:700;color:#334155}
/* 关键时间 chip：圆点取阶段色（与展开区「里程碑一览」同一套），日期加粗便于扫读 */
.req-gate{display:inline-flex;align-items:center;gap:4px;margin-right:8px;font-size:11px;color:#475569;white-space:nowrap}
.req-gate i{width:7px;height:7px;border-radius:50%;display:inline-block;flex:none}
.req-gate b{font-variant-numeric:tabular-nums;color:#0f1729}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/views.test.js`
Expected: PASS

Run: `npx vitest run`
Expected: PASS（全量；除仓库既有的 4 个失败用例——`tests/auth.test.js` 3 个错误文案映射 + `tests/version.test.js` 版本赶不上预警，这 4 个在本次改动前就是红的，不要顺手去修）

- [ ] **Step 7: 提交**

```bash
git add src/views/req-view.js src/styles/gantt.css tests/views.test.js
git commit -m "feat(views): 台账新增提出 / 生命周期 / 关键时间三列与展开小节"
```

---

### Task 7: 需求弹窗录入三项

**Files:**
- Modify: `src/components/shell.js`（抽屉 DOM）、`src/components/modals.js`（回显 / 候选 / 读取 / 提交）
- Test: `tests/mobile-layout.test.js`（仓库既有的「字段贯通」源码契约写法）

- [ ] **Step 1: 写失败测试（追加到 `tests/mobile-layout.test.js` 末尾）**

```js
describe('需求台账：提出信息与生命周期字段贯通', () => {
  const modals = readFileSync(resolve(ROOT, 'src/components/modals.js'), 'utf8');
  const shell = readFileSync(resolve(ROOT, 'src/components/shell.js'), 'utf8');
  const muts = readFileSync(resolve(ROOT, 'src/scheduler/mutations.js'), 'utf8');

  it('抽屉里有提出人 / 提出时间 / 生命周期三个控件与候选容器', () => {
    expect(shell).toContain('id="newModProposedBy"');
    expect(shell).toContain('id="newModProposedAt"');
    expect(shell).toContain('id="segModLc"');
    expect(shell).toContain('id="modProposerList"');
    expect(shell).toContain('data-lc=""');          // 「未设置」档必须在
  });

  it('打开时回显：新建默认「待确认」+ 当天，编辑回显原值', () => {
    expect(modals).toMatch(/renderModLcSeg\(LIFECYCLE_DEFAULT, deps\)/);
    expect(modals).toMatch(/renderModLcSeg\(mo\.lifecycle, deps\)/);
    expect(modals).toMatch(/g\('newModProposedAt'\)\.value = todayStr\(deps\)/);
    expect(modals).toMatch(/g\('newModProposedAt'\)\.value = mo\.proposedAt \|\| ''/);
    expect(modals).toMatch(/renderProposerOptions\(deps\)/);
  });

  it('保存时新增与编辑两条路径都提交三个字段', () => {
    expect(modals).toMatch(/addModule\(\{[\s\S]*?proposedBy:[\s\S]*?proposedAt:[\s\S]*?lifecycle:/);
    expect(modals).toMatch(/updateModule\(\{[\s\S]*?proposedBy:[\s\S]*?proposedAt:[\s\S]*?lifecycle:/);
  });

  it('数据层接受三个字段并支持清空', () => {
    expect(muts).toMatch(/if \(opts\.proposedBy != null\)/);
    expect(muts).toMatch(/delete mo\.proposedBy/);
    expect(muts).toMatch(/if \(opts\.proposedAt != null\)/);
    expect(muts).toMatch(/delete mo\.proposedAt/);
    expect(muts).toMatch(/if \('lifecycle' in opts\)/);
    expect(muts).toMatch(/delete mo\.lifecycle/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/mobile-layout.test.js`
Expected: FAIL —— `id="newModProposedBy"` 找不到

- [ ] **Step 3: 加抽屉 DOM**

`src/components/shell.js`：在「需求颜色」那一行之后插入两行，在「优先级」那个 `</div></div>` 之后插入生命周期行。

```html
    <div class="f-row">
      <label>提出人<span class="phase-tip">可选已有提出人，也可直接输入新的</span></label>
      <input type="text" id="newModProposedBy" list="modProposerList" placeholder="如：业务方张三">
      <datalist id="modProposerList"></datalist>
    </div>
    <div class="f-row">
      <label>提出时间<span class="phase-tip">新建默认今天，可改可清空</span></label>
      <input type="date" id="newModProposedAt">
    </div>
```

优先级那一整块之后（`<div class="f-row">…优先级…</div>` 结束处）插入：

```html
    <div class="f-row">
      <label>生命周期<span class="phase-tip" id="modLcTip">人工维护的流程门；与台账「状态」列（自动计算）不是一回事</span></label>
      <div class="seg" id="segModLc">
        <button type="button" class="btn" data-lc="">未设置</button>
        <button type="button" class="btn" data-lc="待确认">待确认</button>
        <button type="button" class="btn" data-lc="已确认">已确认</button>
        <button type="button" class="btn" data-lc="已提测">已提测</button>
        <button type="button" class="btn" data-lc="已上线">已上线</button>
      </div>
    </div>
```

- [ ] **Step 4: 加弹窗逻辑**

`src/components/modals.js`：

(a) import 改为：

```js
import { moduleTag } from '../core/mod-tag.js';
import { collectProposers } from '../core/mod-query.js';
import { fmt } from '../core/dates.js';
import { MODULE_PHASES, MODULE_MILESTONE_PHASES, PRIORITY_DEFAULT, normalizePriority, LIFECYCLE_DEFAULT, normalizeLifecycle } from '../core/default-data.js';
```

(b) 文件顶部（`let modEditName = null;` 附近）加两个小工具：

```js
// 属性值转义：datalist 的候选来自用户输入（提出人），必须转义后再拼 HTML
const escAttr = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 今天的 YYYY-MM-DD：优先用 deps.today（渲染 ctx 的基准日），便于测试固定日期
function todayStr(deps) {
  const t = typeof deps.today === 'function' ? deps.today() : (deps.today || new Date());
  return fmt(t);
}
```

(c) 在 `renderModPriSeg` 之后加三个函数（与 `readModPri` 同构）：

```js
// 生命周期分段控件：未设置 / 待确认 / 已确认 / 已提测 / 已上线。
// 「未设置」是合法档 —— 老数据没有 lifecycle 字段，编辑时必须能原样保留，
// 否则一打开编辑再保存就替用户臆造了一个「待确认」。
function renderModLcSeg(lc, deps) {
  const box = deps.getEl('segModLc');
  if (!box) return;
  const cur = normalizeLifecycle(lc) || '';
  box.querySelectorAll('.btn').forEach(b => b.classList.toggle('on', (b.dataset.lc || '') === cur));
}

// 读取当前选中的生命周期（'' = 未设置）
function readModLc(deps) {
  const box = deps.getEl('segModLc');
  const on = box ? box.querySelector('.btn.on') : null;
  return (on && on.dataset.lc) || '';
}

// 提出人候选：容器写在抽屉的静态 DOM 里，但候选随数据变化，
// 故每次打开弹窗按当前需求集合重写（不能写死在 DOM 里）
function renderProposerOptions(deps) {
  const list = deps.getEl('modProposerList');
  if (!list) return;
  list.innerHTML = collectProposers(deps.planStore.state.modules)
    .map(n => `<option value="${escAttr(n)}"></option>`).join('');
}
```

(d) `openNewModModal` 里，`refreshModColorTip(deps);` 之后加：

```js
  g('newModProposedBy').value = '';
  g('newModProposedAt').value = todayStr(deps);
```

并在 `renderModPriSeg(PRIORITY_DEFAULT, deps);` 之后加：

```js
  renderProposerOptions(deps);                       // 新建也要能选已有提出人
  renderModLcSeg(LIFECYCLE_DEFAULT, deps);           // 新建默认「待确认」
```

(e) `openEditModModal` 里，`refreshModColorTip(deps);` 之后加：

```js
  g('newModProposedBy').value = mo.proposedBy || '';
  g('newModProposedAt').value = mo.proposedAt || '';
```

并在 `renderModPriSeg(mo.pri, deps);` 之后加：

```js
  renderProposerOptions(deps);
  // 回显实际值：老数据没有 lifecycle 时选中「未设置」，保存后仍是未设置
  renderModLcSeg(mo.lifecycle, deps);
```

(f) `bindModalControls` 里，优先级分段控件绑定之后加：

```js
  // 生命周期：多选一分段控件（含「未设置」）
  const segLc = g('segModLc');
  if (segLc) segLc.querySelectorAll('.btn').forEach(b => b.addEventListener('click', () => {
    segLc.querySelectorAll('.btn').forEach(x => x.classList.toggle('on', x === b));
  }));
```

(g) `btnNewModSave` 的两条提交路径都带上三个字段：

```js
        deps.sched.updateModule({ oldName: modEditName, name, tag: g('newModTag').value.trim(), tagc: resolveChosenColor(g('newModTagc').value, deps.planStore.state.modules, modEditName), unscheduled: readModSched(deps), pri: readModPri(deps), proposedBy: g('newModProposedBy').value, proposedAt: g('newModProposedAt').value, lifecycle: readModLc(deps), desc: g('newModDesc').value, docUrl: doc.value });
```

```js
      deps.sched.addModule({ name, tag: g('newModTag').value.trim(), tagc: resolveChosenColor(g('newModTagc').value, deps.planStore.state.modules, null), phases, unscheduled: readModSched(deps), pri: readModPri(deps), proposedBy: g('newModProposedBy').value, proposedAt: g('newModProposedAt').value, lifecycle: readModLc(deps), desc: g('newModDesc').value, docUrl: doc.value });
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/mobile-layout.test.js`
Expected: PASS

- [ ] **Step 6: 手动验收（DOM 契约测不出交互）**

Run: `npm run dev`，浏览器打开 `http://localhost:8000/gantt.html`，逐条确认：

1. 点「＋ 新建需求」：提出时间已填今天；生命周期停在「待确认」
2. 提出人输入框能下拉出已录入过的提出人；输入一个新名字可正常保存
3. 保存后打开需求台账：新需求的三列都有值，未填的显示「—」/「未设置」徽标
4. 再点「编辑」：三个控件正确回显；把生命周期改回「未设置」保存 → 台账显示虚线「未设置」
5. 手机上（窄屏）「提出」列隐藏，生命周期与关键时间仍在

- [ ] **Step 7: 提交**

```bash
git add src/components/shell.js src/components/modals.js tests/mobile-layout.test.js
git commit -m "feat(ui): 需求弹窗新增提出人 / 提出时间 / 生命周期录入"
```

---

### Task 8: 文档同步与全量回归

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新 README 的「需求管理」能力描述**

把 README 能力表里这一行：

```markdown
| **需求管理** | 状态标签、标识色、优先级 P0–P3、描述、需求文档、待排期；归档是**软状态**——归档后的需求仍参与依赖与资源计算，不会静默改变下游排期 |
```

改为：

```markdown
| **需求管理** | 状态标签、标识色、优先级 P0–P3、描述、需求文档、提出人与提出时间、生命周期（待确认/已确认/已提测/已上线，人工维护）、待排期；归档是**软状态**——归档后的需求仍参与依赖与资源计算，不会静默改变下游排期 |
```

- [ ] **Step 2: 全量回归**

Run: `npx vitest run`
Expected: 421 + 新增用例全部 PASS；仅剩仓库既有的 4 个失败（`tests/auth.test.js` 3 个 + `tests/version.test.js` 1 个）——用改动前的基线对比确认数量没变

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs: README 补充需求提出信息与生命周期能力"
```

- [ ] **Step 4: 处理导出模板（构建产物，按用户决定）**

`public/export-template.html` 是 `npm run build:export` 生成的单文件导出模板（仓库里跟踪了它）。本次改动后它已落后于源码（缺三列与生命周期样式）。两种处理，取其一：

- 让导出件同步：`npm run build:export`（会把该文件整体重建，包含此前积压的其它源码改动，diff 较大）
- 或按用户此前的意向把该产物从仓库移除并加入 `.gitignore`

**在用户明确选择之前不要动这个文件。**

---

## 自检记录

**Spec 覆盖**：§3 数据模型 → Task 1 / Task 5；§4.1 三列 → Task 6；§4.2 徽标配色 → Task 4；§4.3 展开小节 → Task 6；§5 关键时间口径 → Task 2 + Task 6；§6 录入交互 → Task 7；§7 筛选与排序 → Task 3；§8 文件清单 → 全部 Task 覆盖；§9 测试策略 → 各 Task 的测试步骤；§10 非目标（不改甘特图、不做人工时间字段、不做自动推导）→ 无相关 Task，符合预期；§11 风险（飞书未映射、12 列宽度）→ 宽度在 Task 6 样式里处理，飞书映射刻意不做。

**类型/命名一致性**：`findGateMs(mo, 'confirm' | 'submit')` 在 Task 2 定义，Task 3（`confirm` 排序）与 Task 6（两列取值）消费，签名一致；`lifecycleBadge` 在 Task 4 定义、Task 6 使用；`collectProposers` 在 Task 3 定义、Task 7 使用；`renderModLcSeg` / `readModLc` / `renderProposerOptions` / `todayStr` 在 Task 7 内部自洽；CSS 类名 `lc-*` 在 Task 4 定义、Task 6 复用、Task 4 的契约测试守着漂移。

**已知口径提醒**：`addModule` 不传 `lifecycle` 时对象上会存在 `lifecycle: undefined` 这个键（与既有 `desc` / `docUrl` 的写法一致），故测试用 `toBe(undefined)` 而不是 `'lifecycle' in mo` 来断言"未设置"；`updateModule` 清空后是**真的 delete**，两种断言各自对应各自的入口。

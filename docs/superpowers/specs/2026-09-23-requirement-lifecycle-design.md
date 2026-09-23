# 需求生命周期与提出信息设计

- 日期：2026-09-23
- 状态：设计已确认，待实施
- 载体：需求台账页（`req` 视图）新增三列 + 需求弹窗新增三项录入；**甘特图（排期视图）不做任何改动**
- 关联：`docs/superpowers/specs/2026-09-23-requirement-ledger-design.md`（台账页本体）
- 分支：按用户要求，本次改动在当前分支完成，不额外拉分支

---

## 1. 背景与目标

台账页现在能回答「这个需求是什么、什么时候上、做到哪一步、有没有风险」，但回答不了项目管理里最常被问的两件事：

1. **谁提的、什么时候提的** —— 需求的来源与时效（躺了多久才被排上）。
2. **走到了生命周期的哪一道门** —— 待确认 / 已确认 / 已提测 / 已上线，是业务方与领导真正在跟的四个状态。

同时，排期数据里**已经存在**「需求确认」与「提测」两个里程碑，但它们在台账主行完全看不见（只藏在展开档案的「里程碑一览」里），需要提到主行重点体现。

本设计交付三件事：

- 需求级新增 `proposedBy` / `proposedAt` / `lifecycle` 三个字段
- 台账新增「提出」「生命周期」「关键时间」三列（9 列 → 12 列）
- 需求弹窗新增三项录入；「需求确认时间 / 提测时间」从排期里程碑读取，**不新增字段**

## 2. 与既有「状态」列的关系

台账已有「状态」列，由 `moduleTag(mo, today)` 从任务完成度与日期**自动推导**。新增的「生命周期」是**人工维护**的流程门。两者并存、语义正交：

| | 状态（既有） | 生命周期（新增） |
| --- | --- | --- |
| 来源 | 自动推导（任务完成度 + 日期） | 人工在需求弹窗里选择 |
| 回答的问题 | 现在干得怎么样、有没有逾期 | 流程走到哪道门了 |
| 取值 | 待排期 / 待启动 / 进行中 / 已逾期 / 已完成 | 未设置 / 待确认 / 已确认 / 已提测 / 已上线 |

两列的视觉必须能分开：状态列是**实心**色块（`.tag`，白字），生命周期是**浅底 + 描边**徽标（与 `.pri` 同族，彩色字）。

### 2.1 已否决的替代方案（记录理由，避免重复讨论）

| 方案 | 否决理由 |
| --- | --- |
| **自动推导生命周期**（里程碑日期 + 完成度推导，可人工覆盖） | 用户明确改为纯人工维护。自动推导在三种常见情况下会给出误导性的"已到达"：需求尚未排期（没有里程碑）、里程碑未初始化、已延期但计划日期已过。且"推导 + 人工覆盖"必然引入两套来源的优先权语义 |
| **结构化 `gates: [{key, at, by}]` 或 `lifecycle: {status, at, by}`** | 本设计不需要节点级的时间与操作人；扁平三字段与现有 `desc` / `docUrl` / `pri` 完全同构，YAGNI |
| **用既有「状态标签」`mo.tag` 承担生命周期** | 自由文本，无法筛选/排序/统一配色；且 `mo.tag` 在甘特图里是"冲刺中 / 顺延"这类展示标签，语义与生命周期不同 |

## 3. 数据模型变更

需求对象新增三个字段（`projects.plan` 是 jsonb，**无需任何 DDL**）：

| 字段 | 类型 | 语义 | 缺省 |
| --- | --- | --- | --- |
| `proposedBy` | string | 提出人（自由文本，录入时来自下拉候选） | `undefined` = 未填写 |
| `proposedAt` | string `YYYY-MM-DD` | 提出时间 | `undefined` = 未填写 |
| `lifecycle` | 枚举 | 人工维护的生命周期状态 | `undefined` = 未设置（老数据不补；新建时由弹窗预选「待确认」，见 §6） |

**常量与归一化**放在 `core/default-data.js`，与现有的 `PRIORITIES` / `PRIORITY_DEFAULT` / `normalizePriority` 并列：

```js
export const MODULE_LIFECYCLE = ['待确认', '已确认', '已提测', '已上线'];
export const LIFECYCLE_DEFAULT = '待确认';
export const LIFECYCLE_NONE = '未设置';        // 仅用于展示与筛选，不写入需求对象
export const normalizeLifecycle = v => (MODULE_LIFECYCLE.includes(v) ? v : null);
```

**写入**集中在 `scheduler/mutations.js`：

- `addModule()`：`proposedBy` 照 `opts.desc` 的写法取 `trim()`，空串归一为 `undefined`；`proposedAt` 仅在匹配 `^\d{4}-\d{2}-\d{2}$` 时写入（挡掉手改 JSON / 导入带来的脏值），否则 `undefined`；`lifecycle` 取 `normalizeLifecycle(opts.lifecycle) || undefined`
- `updateModule()`：`opts.proposedBy != null` / `opts.proposedAt != null` 时写入，空串 **`delete` 字段**（与 `desc` / `docUrl` 的"传空串 = 清除"口径一致）；`'lifecycle' in opts` 时用 `normalizeLifecycle`，空值 → `delete`

**默认值由弹窗层提供，数据层不补**：`LIFECYCLE_DEFAULT` 只被 `components/modals.js` 的新建弹窗使用（预选「待确认」）；`addModule()` 拿到什么写什么，不传就是未设置。这样 `addModule` 的语义干净（不产生隐藏默认值），用户在新弹窗里主动改成「未设置」也能被如实保存。

**缺省语义**：`undefined` 一律显示「未设置」，**不替老数据补「待确认」**。这与既有「`pri` 未设置不补假值」是同一条原则——默认演示数据里那 6 个需求不会被静默标成待确认。

**无需改动**：`scheduler/persistence.js`、`services/plan-sync.js`、`utils/export.js` 全是展开写法（`modules: state.modules`），新字段自动随载荷同步到 Supabase / localStorage / 导出件 / 撤销快照。

## 4. 页面结构

### 4.1 台账主行三列

列顺序（9 → 12），插入位置按语义归组：

| # | 列 | 数据来源 | 可排序 |
| --- | --- | --- | --- |
| 1 | 需求 | 既有 | — |
| 2 | **提出** | `mo.proposedBy` + `mo.proposedAt` | 是（按提出时间） |
| 3 | 状态 | 既有（`moduleTag` 自动） | — |
| 4 | **生命周期** | `lifecycleBadge(mo.lifecycle)` | 是（枚举序） |
| 5 | 描述 | 既有（`.req-col-opt`） | — |
| 6 | 文档 | 既有（`.req-col-opt`） | — |
| 7 | 所属版本 | 既有 | — |
| 8 | 排期 | 既有 | — |
| 9 | **关键时间** | 确认 / 提测里程碑（§5） | 是（按确认时间） |
| 10 | 进度 | 既有 | — |
| 11 | 上线情况 | 既有 | — |
| 12 | 操作 | 既有 | — |

- **提出**：提出人（正文）+ 提出日期（`.req-sub` 小字）。只有提出人没有日期、或只有日期没有提出人时，有哪项显示哪项；两者都缺显示「—」（与「未加入版本」「未填写描述」的显式空值风格一致）。该列归入窄屏隐藏列 `.req-col-opt`：它属于背景信息，不是对比指标
- **生命周期**：徽标，取值「未设置」时也渲染徽标（虚线灰），不渲染空白。列头带 `title`：「人工维护，与左侧自动计算的『状态』不是同一件事」
- **关键时间**：`确认 9/1 · 提测 9/20` 两个小标记，圆点色取 `PCOL`（与展开区「里程碑一览」同一套点色）；任一缺失显示「—」。列头 `title` 写明排序口径：「点击按需求确认时间排序（缺里程碑的排在最后）」

### 4.2 生命周期徽标配色

新增 `views/badge.js` 的 `lifecycleBadge(v)`，只产出 HTML 结构，配色全在 CSS（与 `priorityBadge` 同一分工）。与 `priorityBadge` 唯一的差别：**未设置也渲染徽标**（台账该列不允许出现空白，空白读者无法区分"没填"和"渲染坏了"）：

```js
const LC_CLASS = { '待确认': 'lc-todo', '已确认': 'lc-ok', '已提测': 'lc-sit', '已上线': 'lc-live' };

export const lifecycleBadge = v => {
  const key = MODULE_LIFECYCLE.includes(v) ? v : null;   // 缺失 / 非法值 → 未设置
  const text = key || LIFECYCLE_NONE;
  return `<span class="lc ${LC_CLASS[key] || 'lc-none'}" title="生命周期（人工维护）：${text}">${text}</span>`;
};
```

CSS 类名 `.lc` + `.lc-none` / `.lc-todo` / `.lc-ok` / `.lc-sit` / `.lc-live`，写法照 `.pri` 族（`display:inline-flex` + `9px/800` + `border:1px solid`），沿用项目既有语义色：

| 状态 | 类名 | 文字 / 底 / 描边 | 语义 |
| --- | --- | --- | --- |
| 未设置 | `.lc-none` | `#64748b` / `#f8fafc` / `#cbd5e1` **虚线** | 没填（虚线一眼可辨） |
| 待确认 | `.lc-todo` | `#475569` / `#f1f5f9` / `#cbd5e1` | 未开始 |
| 已确认 | `.lc-ok` | `#1d4ed8` / `#dbeafe` / `#93c5fd` | 已定 |
| 已提测 | `.lc-sit` | `#92400e` / `#fef3c7` / `#fcd34d` | 进行中 |
| 已上线 | `.lc-live` | `#047857` / `#d1fae5` / `#6ee7b7` | 完成 |

文字对比度均 ≥ 4.5:1；这五个色与任务状态的语义色（完成绿 / 逾期红 / 进行中琥珀 / 待启动灰）同源，不随主题品牌色变化。

### 4.3 展开档案新增一小节

展开档案（`detailHtml`）新增「提出与生命周期」小节，一行 key-value：提出人 / 提出时间 / 生命周期 / 确认时间 / 提测时间。放在档案顶部（描述之前）。

理由：主行 12 列已经很挤，「提出」与「关键时间」都做了截断；展开是细读场景，把 5 项一次看全，也顺手补上主行放不下的完整信息。这一节是纯展示、不引入新数据，删掉它不影响任何主行功能。

## 5. 关键时间口径

**不新增字段**：确认时间与提测时间都从排期里程碑读取，排期一改台账跟着变，只有一个事实来源。

新增 `findGateMs(mo, kind)` 放 `core/mod-tag.js`（与 `milestoneName` 并列）：

```js
// kind: 'confirm' | 'submit'；返回里程碑 bar（含 m）或 null，多个匹配时取最后一个
findGateMs(mo, 'confirm')   // p === 'cfm' 或 label 含「需求确认」
findGateMs(mo, 'submit')    // label 含「提测」
```

必须写进注释的口径边界：

- **「提测」里程碑只能按 label 认**。现有数据里它是 `{ p:'sit', label:'提测' }`（`scheduler/mutations.js` 的 `addModule` 自动补建），而 `p:'sit'` 同时也是「测试(SIT)」这个普通阶段。只判 `p` 会取到测试任务本身，日期与语义都会错
- 「需求确认」是唯一被 `MODULE_MILESTONE_PHASES` 声明的里程碑阶段（`p:'cfm'`），但历史数据里也可能只有 label，故两个条件取"或"
- 多个匹配取**最后一个**，与既有 `findGoMs(mo)` 的口径一致（上线里程碑也是取最后一个）
- 待排期、或没初始化该阶段的需求 → 显示「—」，不留空白
- 归档需求照常显示（台账默认含归档需求）

## 6. 录入与交互

三个控件都在现有需求弹窗（`components/modals.js` + 抽屉 DOM 在 `components/shell.js`），读取函数照 `readModPri()` 的模式各写一个（`readModProposedBy` / `readModProposedAt`）：

1. **提出人**：`<input list="modProposerList">` + `<datalist id="modProposerList">`。浏览器原生支持"既能选已有值、又能输新值"，对应"下拉选择 + 允许新增选项"。
   - `<datalist>` 容器写在抽屉的静态 DOM 里（`components/shell.js`），`option` 内容在**每次打开弹窗时**由 `components/modals.js` 按 `collectProposers(deps.planStore.state.modules)` 重写——候选来自当前数据，不能写死在 DOM 里
   - `collectProposers(mods)`（纯函数，放 `core/mod-query.js`）：全量需求里已录入的 `proposedBy` 去重、忽略空值与首尾空格、保持首次出现顺序；**并入当前编辑对象的旧值**（否则改一次名就会让候选消失）
   - 新建时不预填：提出人多为业务方，不替用户臆造（与 `pri` 不做默认值的取舍不同——`pri` 有明确的中位档「P2」，提出人没有）
2. **提出时间**：`<input type="date">`。新建时预填当天（`F(new Date())` 的 `YYYY-MM-DD`），可改、可清空；编辑时回显原值，不覆盖
3. **生命周期**：分段控件（复用 `.seg`，与「排期状态」「优先级」同一形态），5 档：`未设置 / 待确认 / 已确认 / 已提测 / 已上线`，按钮 `data-lc` 取值与枚举同名（未设置档为 `data-lc=""`），读取函数照 `readModPri()` 的 `.btn.on` 取 `dataset`。
   - **新建时默认选中「待确认」**（`LIFECYCLE_DEFAULT`，由弹窗层给）
   - **「未设置」这一档是刻意留的**：没有它，编辑一次老数据就会把「未设置」悄悄变成「待确认」，等同于替用户改数据。编辑老数据时选中「未设置」，用户不动它、保存后仍是未设置
   - 5 个按钮的宽度与现有 5 档优先级分段控件同量级，抽屉内允许折行

**校验与归一化**：提出人 `trim()`，空 → 不写入；提出时间由原生 date 控件保证格式，写入前仍按 `^\d{4}-\d{2}-\d{2}$` 兜一道（手改 JSON / 外部导入的脏值一律归一为未填写）。

**只读模式**：`userStore.state.readonly` 为真时（含导出单文件查看器），台账不渲染操作列、弹窗入口不可达，数据层由 `assertEditable()` 兜底——与既有口径一致。

## 7. 筛选与排序

**筛选**：`filterBar` 新增一个 `<select data-req-f="lifecycle">`（全部生命周期 / 待确认 / 已确认 / 已提测 / 已上线 / 未设置）。

- `components/req-page.js` 的 change 委托是通用的（`curF()[el.dataset.reqF] = el.value || 'all'`），**新增下拉不需要改事件代码**
- `defaultReqFilter()` 增加 `lifecycle: 'all'`；`filterMods()` 增加判定：`none` → 未设置（`!mo.lifecycle`），其余精确匹配
- 关键词搜索 `kw` 扩展匹配 `proposedBy`（现在只匹配 `name` + `desc`），于是「搜某人提的需求」直接可用

**排序**：新增三个 key，实现于 `mod-query.js` 的 `sortValue()`，沿用现有 `{ v } / { miss: true }` 约定（**空值一律排最后**，与升降序无关）：

| key | 取值 |
| --- | --- |
| `proposed` | `mo.proposedAt`（字符串比较），缺失 → miss |
| `lifecycle` | `MODULE_LIFECYCLE.indexOf(mo.lifecycle)`，未设置 → miss（排在四档之后） |
| `confirm` | `findGateMs(mo, 'confirm')?.m`，缺失 → miss |

排序 `deps` 不需要新增依赖；`confirm` 直接从 `core/mod-tag.js` 引入 `findGateMs`（`mod-query.js` 已经依赖 `mod-tag.js`）。

## 8. 涉及文件清单

**修改**：

| 文件 | 改动 |
| --- | --- |
| `src/core/default-data.js` | `MODULE_LIFECYCLE` / `LIFECYCLE_DEFAULT` / `LIFECYCLE_NONE` / `normalizeLifecycle` |
| `src/core/mod-tag.js` | `findGateMs(mo, kind)`（`confirm` / `submit`） |
| `src/core/mod-query.js` | `collectProposers()`；`defaultReqFilter` 加 `lifecycle`；`filterMods` 加生命周期判定；`sortValue` 加 `proposed` / `lifecycle` / `confirm`；`kw` 扩到 `proposedBy` |
| `src/views/badge.js` | `lifecycleBadge(v)` |
| `src/views/req-view.js` | 三列表头与单元格、「关键时间」格、展开档案「提出与生命周期」小节 |
| `src/scheduler/mutations.js` | `addModule` / `updateModule` 支持三个新字段 |
| `src/components/shell.js` | 抽屉 DOM：提出人（含 `datalist`）、提出时间、生命周期分段控件 |
| `src/components/modals.js` | 新建 / 编辑回显与读取函数，保存时提交三个新字段 |
| `src/styles/gantt.css` | `.lc-*` 配色（照 `.pri` 族）；台账新列样式；「提出」列入窄屏隐藏组 |
| `tests/core.test.js` · `tests/scheduler.test.js` · `tests/mod-query.test.js` · `tests/views.test.js` | 见 §9 |

**无需改动**（新字段随展开写法自动携带）：`src/scheduler/persistence.js`、`src/services/plan-sync.js`、`src/utils/export.js`、`src/main-standalone.js`、`deploy/supabase/migration.sql`（`projects.plan` 为 jsonb）。

**本次不扩展**：`src/services/feishu-sync.js`（唯一的显式字段映射，见 §11 风险）。

## 9. 测试策略

| 文件 | 用例 |
| --- | --- |
| `tests/core.test.js` | `normalizeLifecycle` 只接受四值（`undefined` / `''` / `'已上线 '` / 任意串 → `null`）；`findGateMs` 认 `p:'cfm'` 与 label「需求确认」、按 label 认「提测」而不是 `p:'sit'`（用 `{ p:'sit', label:'提测' }` 与 `{ p:'sit', label:'测试(SIT)' }` 两条数据对比）、取最后一个、无匹配返回 null |
| `tests/scheduler.test.js` | `addModule` 不传 `lifecycle` → 未设置（数据层不补默认值）；传 `proposedBy` / `proposedAt` 落值；`proposedAt` 传非 `YYYY-MM-DD` → 不落值；`updateModule` 传空串 → 字段被 `delete`（而非留空串） |
| `tests/mod-query.test.js` | `collectProposers` 去重、忽略空值与首尾空格、保持顺序；生命周期筛选 6 种取值（含"未设置"）；`kw` 命中 `proposedBy`；三个新排序 key 的升降序与「空值排最后」 |
| `tests/views.test.js` | 台账三列列头齐全；有值时渲染提出人与日期、缺值时「—」；生命周期徽标 class 正确（含 `lc-none`）；「关键时间」取到确认与提测里程碑（`p:'sit' + label:'提测'` 的数据不能取错）；展开档案含「提出与生命周期」小节 |

## 10. 非目标

- **不改甘特图**（排期视图）：不在需求行、不在里程碑标签上做任何突出显示（用户明确要求）
- 不做「确认时间 / 提测时间」的人工录入字段：一律取排期里程碑
- 不做生命周期状态的自动推导、不做状态与里程碑的联动校验（人工填什么就是什么）
- 不做行内快捷改状态：与既有「改名、优先级、人员都走弹窗」的约定保持一致
- 不出提出人字典表（人员管理）：`datalist` 候选收敛即可
- 不扩展飞书同步字段映射（见 §11）
- 不做「需求流转历史 / 状态变更记录」：只保留当前状态

## 11. 风险与取舍

| 风险 | 处理 |
| --- | --- |
| 「生命周期」与自动计算的「状态」被读成同一件事 | 列头 `title` 写明人工维护；徽标形态（浅底描边 + 未设置虚线）与实心状态标签明确区分；两列相邻摆放正是为了让差异可见 |
| 12 列在 1600px 容器下更容易横向滚动 | 三个新列都窄（提出 ~120px / 生命周期 ~90px / 关键时间 ~140px）；「提出」列入窄屏隐藏组；窗口不足时仍由容器横向滚动兜底 |
| 老数据生命周期全部显示「未设置」，首屏显得"没填" | 这是刻意的（不臆造数据）；配合筛选器「未设置」项，可以一次捞出全部待补录的需求 |
| 提出人是自由文本，会出现「张三」「张三（业务）」并存 | `datalist` 候选收敛（含当前编辑对象的旧值）；不做字典表（YAGNI）；不校验提出人是否存在于人员名单 |
| 关键时间依赖排期维护质量 | 口径已写死为"读里程碑"；没排期就显示「—」，如实反映"排期里没有这道门"，不猜 |
| 切回飞书后端后三个新字段不落库 | 与 `desc` / `docUrl` 同一条风险：需先在多维表格「需求」表加「提出人」「提出时间」「生命周期」三列，再补 `services/feishu-sync.js` 的 `modToReqFields()` 与拉取侧的字段映射。当前后端为 Supabase，此行不阻塞本次实施 |

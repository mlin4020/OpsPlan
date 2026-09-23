# 需求台账页（Requirement Ledger）设计

- 日期：2026-09-23
- 状态：设计已确认，待实施
- 载体：把现有「归档」页（`arch` 视图）改造为「需求台账」页（`req` 视图）
- 分支：按用户要求，本次改动在当前分支完成，不额外拉分支

---

## 1. 背景与目标

现状存在三个问题：

1. **「归档」页覆盖面太窄**。它只服务"已归档需求留档"这一件事，而这类需求在数量上永远是少数。
2. **需求全貌散落在三处**。总览页是卡片流（不适合横向对比字段），甘特图是排期编辑视角，版本页是迭代收口视角；没有任何一个地方能"按字段看全局"。
3. **领导和业务人员没有可读入口**。他们关心的是"这个需求是什么、什么时候上、现在到哪一步、有没有风险"，而现有视图要么是给排期负责人用的编辑界面，要么是汇报用的图表，都不适合读单个需求的完整信息。

本设计把「归档」页升级为「需求台账」：**全量需求的表格化视图 + 单需求档案展开**。归档不再是独立页面，而是台账里的一个筛选条件。

## 2. 定位与受众

| 页面 | 视角 | 主受众 |
| --- | --- | --- |
| 总览 `report` | 汇报卡片流（指标 / 需求进度 / 里程碑 / 风险 / 资源负载） | 领导（上图看趋势） |
| **需求台账 `req`** | **全量清单 + 字段对比 + 单需求档案** | **领导、业务（读单个需求）** |
| 甘特图 `mod` / 工作组规划器 `res` | 时间轴排期编辑 | 排期负责人、开发 |
| 资源工作视图 `work` | 按人看任务清单 | 执行人员 |
| 版本 `version` | 迭代收口 | 项目管理 |

台账的读写分工：**领导/业务以只读浏览为主**（默认进入即可看全量），**项目管理用筛选器定位需求并维护描述与文档**。

## 3. 数据模型变更

需求对象新增两个字段（`projects.plan` 是 jsonb，**无需任何 DDL**）：

| 字段 | 类型 | 语义 | 缺省 |
| --- | --- | --- | --- |
| `desc` | string | 需求描述，纯文本，保留换行 | `undefined` = 未填写 |
| `docUrl` | string | 需求文档链接，仅接受 http/https | `undefined` = 未填写 |

持久化**无需改动**：`scheduler/persistence.js` 的 `buildPayload()` / `exportJSON()` 都是展开写法（`modules: getState().modules`），新字段自动随载荷同步到 Supabase 与 localStorage。

飞书同步本次**不扩展**：`services/feishu-sync.js` 的 `modToReqFields()` 是显式字段映射（现有 7 个字段：需求名称 / 状态标签 / 标签颜色 / 人员配置 / 优先级 / 排序号 / 待排期），要在飞书侧承载描述与文档，需先在多维表格「需求」表加「描述」「需求文档」两列再补映射。当前后端为 Supabase，此事项记在 §13 风险中。

## 4. 页面结构

### 4.1 主行列表

表格形态：语义化 `<table>` + 外层横向滚动容器，列头可点击排序。

容器宽度：台账页容器比其它整页视图宽 —— `.req-wrap` 用 `max-width: 1600px`（其余整页视图复用 `.report-wrap` 的 1300px）。9 列在 1300px 下会过早触发横向滚动，白白牺牲对比能力；窗口不足时仍由容器横向滚动兜底。

| # | 列 | 数据来源 | 可排序 |
| --- | --- | --- | --- |
| 1 | 需求 | `mo.name` + `priorityBadge(mo.pri)` + 归档 / 待排期标记 | 是 |
| 2 | 状态 | `moduleTag(mo, today)` → 待排期 / 已逾期 / 已完成 / 进行中 / 待启动（含色值） | 是 |
| 3 | 描述 | `mo.desc` 单行截断，`title` 属性放全文；未填写显示「—」 | 否 |
| 4 | 文档 | `mo.docUrl` 有值则渲染可点图标，无则「—」 | 否 |
| 5 | 所属版本 | `versionOfMod(state, mo.name)` → 版本名 + 计划上线日；无则「未加入」 | 是 |
| 6 | 排期 | `ctx.modRange(mo)` → 起 ~ 止；待排期或无任务显示「待排期」/「—」 | 是 |
| 7 | 进度 | `modStats(bars, rng, ctx)` → 进度条 + `pct`% + `done/work` 人日 | 是 |
| 8 | 上线情况 | 见 §5 | 是 |
| 9 | 操作 | 编辑 / 归档·取消归档 / 删除（只读模式整列隐藏） | 否 |

默认排序 `order`：沿用 `state.modules` 的数组顺序，与甘特图左侧需求行的顺序一致。

页面标题区展示统计：「共 N 个需求 · 筛选后 M 个」。N 为全量需求数、M 为当前筛选结果数，随筛选条件实时更新；两者相等时只显示「共 N 个需求」。这是原本想用导航徽标承担的信息，放在页面内更直观（见 §7）。

### 4.2 展开档案

点击主行切换展开，展开内容（自上而下）：

1. **描述全文** — `white-space: pre-wrap` 保留换行；未填写时显示「未填写描述」提示
2. **需求文档** — 按钮形式，新窗口打开；未填写时不渲染该行
3. **上线情况块** — 所属版本 / 计划上线日 / 实际上线日 / 上线状态 / 赶不上预警（口径见 §5）
4. **排期与进度块** — 起止日期、总人日、完成度、应达基线偏差（`pct - planPct`，沿用卡片"延后 N% / 超前 N%"的既有口径）
5. **阶段明细** — 与总览卡片展开区共用同一份实现（`renderModDetailRows`，见 §8）：阶段色条 / 任务名 / 日期 / 人日 / 负责人 / 进度条 / 手动·自动标记
6. **里程碑一览** — 需求内全部里程碑（需求确认、提测、上线等）及日期

展开态由 `req-view.js` 内的模块级 `Set` 持有，导出 `toggleReqExpanded(name)` / `isReqExpanded(name)`，与 `report-view.js` 的 `reportExpanded`、`version-view.js` 的 `verExpanded` 并列且互不干扰（两个页面的需求集合本就不同，共用会互相串状态）。

展开与收起是纯查看行为，**只读模式下同样可用**（只读限制的是写操作，不是阅读）。

### 4.3 筛选与排序

状态存 `viewState`（与现有 `viewState.workFilter` 同构，不进 URL）：

```js
viewState.reqFilter = {
  kw: '',            // 关键词，匹配 name 与 desc 正文，不区分大小写
  status: 'all',     // all | 待排期 | 待启动 | 进行中 | 已逾期 | 已完成
  pri: 'all',        // all | P0 | P1 | P2 | P3 | none（未设置）
  ver: 'all',        // all | <版本 id> | none（未加入版本）
  scope: 'all',      // all | active（排除归档） | archived（只看归档）
  unscheduled: 'all' // all | only（只看待排期） | exclude
};
viewState.reqSort = { key: 'order', dir: 'asc' };
```

默认 `scope: 'all'`：台账默认展示**全部需求**（含待排期与归档），由用户用筛选器收窄。

可排序 key：`order` / `name` / `status` / `pri` / `version` / `start` / `end` / `pct` / `ship`。**空值一律排在最后**（无论升序降序），避免缺失数据插队。

`core/mod-query.js` 的两个纯函数签名与依赖：

```js
filterMods(mods, filter, deps)      // filter 即上面的 reqFilter
sortMods(mods, key, dir, deps)
// deps = { today, versions, modRange }
```

- `today`：状态筛选与状态排序都要用它（`moduleTag` 的判定基准）
- `versions`：所属版本筛选、版本排序，以及"上线情况"排序
- `modRange`：`start` / `end` 排序；无排期需求取不到范围，排最后
- 两个函数不读 window 全局、不碰 DOM，因此可以脱离浏览器环境单测

> 为什么用 `scope` + `unscheduled` 两个维度而不是一个"显示范围"单选：归档与待排期是两个正交属性（一个需求可以既是归档又是待排期），合成一个枚举会产生"归档+待排期"这种难以穷举的组合。

## 5. 上线情况合成口径

**不新增字段**，全部由现有数据合成：

| 展示项 | 口径 | 依赖函数 |
| --- | --- | --- |
| 上线状态 | 已上线 / 待上线 / 已逾期 / 进行中 / 未开始 | `versionStatus(v, state, today)` |
| 计划上线日 | 版本日 `v.date`；无版本时回退该需求的「上线」里程碑 `findGoMs(mo).m`；都没有则「—」 | `findGoMs`（§8 新增） |
| 实际上线日 | 版本 `v.shippedAt`；未标记上线则为空 | — |
| 赶不上预警 | `modLate(v, mo)` → 「赶不上 N 天」红色文字 | `core/versions.js` |

必须在代码注释中写明的口径边界（否则易被误读）：

- `modLate()` 只在需求**属于某个版本**时有效（无版本直接返回 `null`），所以未加入版本的需求不会有"赶不上"预警，台账对这类需求显示「未加入版本」。
- `modLate()` 与 `versionStatus()` 都会跳过 `unscheduled` 需求 —— 待排期需求的日期本身不可信，不该拿来报警。
- 上线状态的「已逾期」含义是"版本上线日已过且成员未全部完成"，**不等于**"延期交付"。列头 `title` 与展开区都要带上这句说明。

## 6. 录入与交互

**录入入口**复用现有需求弹窗（`components/modals.js` 的新建/编辑需求弹窗），新增两个控件：

- 「描述」`<textarea>`
- 「文档链接」`<input type="url">`

校验规则：链接仅在匹配 `/^https?:\/\//i` 时写入；不匹配则提示并拒绝提交（挡掉 `javascript:` 之类伪协议）。渲染时经 `esc()` 转义，并带 `target="_blank" rel="noopener noreferrer"`。

**行操作**：

| 操作 | 走法 |
| --- | --- |
| 编辑 | 打开现有需求弹窗（回显 `desc` / `docUrl`） |
| 归档 / 取消归档 | `mutations.archiveModule(name, bool)` |
| 删除 | `mutations.deleteModule(name)` + `confirm()` 二次确认 |
| 新建需求 | 顶部「+ 新建需求」→ 现有新建需求弹窗 |

`mutations.addModule()` / `updateModule()` 各增加 `desc` / `docUrl` 参数，写法照现有 `opts.tag` / `opts.per` 的模式（`!= null` 判定 + `''` 归一为 `undefined`）。

**只读模式**：`userStore.state.readonly` 为真时（含导出单文件查看器），隐藏「+ 新建需求」按钮与操作列；数据层由 `assertEditable()` 兜底。

**同步链路**：所有变更走 `planStore → ctx.save() → pushToServer`，台账页不直接接触后端 —— 与现有各视图一致。

## 7. 导航改造与兼容

- **视图 key**：`arch` → `req`
- **导航顺序**：总览 / **需求台账** / 甘特图 / 工作组规划器 / 资源工作视图 / 版本（共 6 项，与原「归档」项数量相同，净增 0）
- **旧链接兼容**：`?view=arch` 别名映射到 `req`，`main-gantt.js` 与 `main-standalone.js` 各一处
- **徽标**：**取消**。连带删除 `shell.js` 三处的徽标 DOM（`archNavCount` / `archNavCountM`）、`problem-drawer.js` 的 `updateArchiveBadge()`，以及 `gantt-interactions.js` 里的刷新调用点。需求总数改为在页面标题区展示（见 §4.1），不再占用导航
- **DOM class**：`body.arch-view` → `body.req-view`

> 为什么不是"逾期数"或"需求总数"：导航徽标在本项目里的语义是"有 N 个容易被遗忘的东西"（现有 6 个导航项中只有「归档」带徽标，正因它原先埋在页面底部无人问津）。台账已是主视图，不存在被遗忘的问题；逾期数在 hero 统计与台账自己的筛选器里都能直接看到；需求总数放在页面标题区，比挂在导航上更直观。三者都不需要徽标。

## 8. 需要抽取的公共函数

下列四处逻辑目前被内联在消费方（或落在了错误的层），台账页要用同一份口径，必须先抽出来，否则必然出现两套数字或两套列：

| 函数 | 从 | 到 | 抽取理由 |
| --- | --- | --- | --- |
| `currentPhase(mo, today)` | `views/mod-card.js` L92-93 内联（`curTask` / `curPhase` 计算） | `core/mod-tag.js` | "当前阶段"要同时用于总览卡片与台账列，两处内联必然漂移 |
| `isGoMs(b)` / `findGoMs(mo)` | `scheduler/mutations.js` L463-473（内部函数） | `core/versions.js` | "上线里程碑"的识别口径（`p === 'go'` **或** label 含「上线」）是版本逻辑的核心约定，台账读计划上线日必须用同一口径 |
| `renderModDetailRows(mo, ctx)` | `views/mod-card.js` 的 `detailRows` 内联生成（L95-112，闭包内） | 同文件内提升为具名导出 | 台账展开区的阶段明细必须与总览卡片逐行一致（列顺、口径、`.rmod-row` 结构），各写一份必然漂移 |
| `modStats(bars, rng, ctx)` | `views/mod-card.js`（视图层） | `core/mod-stats.js`（`mod-card.js` 转出以保持既有调用方不变） | 台账的「按完成度排序」发生在 core 层的 `mod-query.js`，而 core 不能反向 import views；不下沉就只能把排序再实现一遍 |

`isGoMs` 的口径不能简化成只判 `p === 'go'`：默认数据与历史数据里的上线里程碑形如 `{ m:'2026-09-09', label:'9/9 上线' }`，**没有 `p` 字段**（阶段色靠 `PCOL[b.p] || PCOL.go` 兜底）。只按 `p` 找会漏掉它们。

## 9. 移动端与只读

- 移动端底部导航：「归档」→「需求台账」，位置第 2（紧随总览）
- 窄屏表格：容器横向滚动；用 CSS 隐藏两个宽文本列（描述 / 文档，类名 `.req-col-opt`），保留需求 / 状态 / 所属版本 / 排期 / 进度 / 上线情况 / 操作，仍放不下则由容器横向滚动兜底
- 展开档案在窄屏纵向堆叠（与桌面同构，仅去掉多列横排）
- 导出单文件（`main-standalone.js` 的只读查看器）：白名单加 `req`、class toggle 同步为 `req-view`；台账在其中纯只读

## 10. 涉及文件清单

**新增**

| 文件 | 职责 |
| --- | --- |
| `src/views/req-view.js` | 台账页纯渲染：返回 HTML 字符串，持有展开态，导出 `renderReqView` / `toggleReqExpanded` / `isReqExpanded` |
| `src/core/mod-query.js` | `filterMods(mods, filter, deps)` / `sortMods(mods, key, dir, deps)` 纯函数，不碰 DOM，可单测；另提供 `defaultReqFilter()` / `defaultReqSort()` 供两个入口与组件层共用默认值 |
| `src/core/mod-stats.js` | 需求级统计 `modStats`，从 `views/mod-card.js` 下沉（见 §8） |
| `src/components/req-page.js` | 事件委托：`[data-req-row]`（展开）、`[data-req-edit]`、`[data-req-archive]`、`[data-req-del]`、`[data-req-new]`、表头排序、筛选器输入；参照 `version-page.js` 的 `bindVersionPage(deps)` 形态，委托绑在 `#gantt` 容器上一次完成，返回空对象（本页没有需要外部调用的 API） |
| `tests/mod-query.test.js` | 筛选与排序的单元测试 |

**修改**

| 文件 | 改动 |
| --- | --- |
| `src/views/index.js` | import / dispatch / export：`arch` 分支改为 `req` |
| `src/main-gantt.js` | 视图白名单加 `req`、`?view=arch` 别名映射 |
| `src/main-standalone.js` | 同上 + `req-view` class toggle |
| `src/components/shell.js` | 三处导航（移动端底栏 / 桌面工具栏 / 只读查看器）改名与移位；删除三处徽标 DOM（`archNavCount` / `archNavCountM`） |
| `src/components/index.js` | 接线 `bindReqPage(deps)` |
| `src/components/toolbar.js` | `arch-view` → `req-view`；缩放条显示条件（`data-report-hide` 那处判断）加入 `req` |
| `src/components/problem-drawer.js` | 删除 `updateArchiveBadge()` 及其导出（徽标取消，见 §7） |
| `src/components/gantt-interactions.js` | 删除徽标刷新调用点（`updateArchiveBadge(deps)`） |
| `src/components/modals.js` | 需求弹窗加描述 / 文档链接控件与校验 |
| `src/scheduler/mutations.js` | `addModule` / `updateModule` 支持 `desc` / `docUrl`；`isGoMs` / `findGoMs` 改为从 `core/versions.js` 引入 |
| `src/views/mod-card.js` | 改用 `core/mod-tag.js` 的 `currentPhase`；阶段明细抽为具名导出的 `renderModDetailRows`（§8）；`modStats` 改为从 `core/mod-stats.js` 转出 |
| `src/views/work-view.js` | 空态文案「要看它们去顶部的『归档』页」改为「需求台账」 |
| `src/styles/gantt.css` | `.arch-view` → `.req-view`（2 处）；新增 `.req-wrap`（1600px 容器）与 `.req-*` 表格样式 |

**删除**

| 文件 | 原因 |
| --- | --- |
| `src/views/archive-view.js` | 归档页不再存在，保留即为死代码 |

## 11. 测试策略

**新增**

- `tests/mod-query.test.js`
  - 筛选：关键词命中 `name`、关键词命中 `desc` 正文、状态各枚举、优先级含"未设置"、版本含"未加入"、归档/待排期 6 种组合
  - 排序：9 个 key × 升降序、空值排最后、同值稳定排序
- 台账渲染契约（并入 `tests/views.test.js`）：列头齐全、空态文案、标题区统计文案、待排期行与归档行的标记、展开区含描述与文档链接、只读模式不渲染操作列

**修改**

- `tests/views.test.js` / `tests/module-archive.test.js`：删除只针对 `archive-view` 的用例；归档能力改由台账覆盖（归档行标记 + 取消归档操作）
- `tests/mobile-layout.test.js`：导航项文案断言更新为「需求台账」；`archNavCount` / `archNavCountM` 的 badge 断言改为断言徽标已移除
- `tests/version.test.js`：`view === 'arch' || ...` 的 dispatch 契约正则更新为含 `req`

## 12. 非目标

- 不做附件上传（文档用外链）
- 不做行内编辑（改名、优先级、人员等仍走弹窗）
- 不做分页与虚拟滚动（需求量为数十级，全量渲染足够；现有归档页也是全量渲染）
- 不扩展飞书同步的字段映射（见 §3）
- 不引入常驻详情面板（曾评估的"左列表 + 右详情"方案），如需可在后续直接复用展开档案的渲染函数
- 不改动总览 / 甘特图 / 规划器 / 工作视图 / 版本页的既有布局

## 13. 风险与取舍

| 风险 | 处理 |
| --- | --- |
| 描述与文档大面积为空，页面对领导"看起来没内容" | 描述列与文档列显式渲染「—」而非空白；展开区对空描述给「未填写描述」提示；上线后再推动补录 |
| 领导把「已逾期」误读为交付延期 | 列头 `title` 与展开区都写明口径：指"版本上线日已过且成员未全部完成" |
| 未加入版本的需求没有"赶不上"预警 | 该列显示「未加入版本」而非空白，读者知道是"没有版本"而不是"没问题" |
| 切回飞书后端后描述/文档不落库 | §3 已记录：需先在多维表格「需求」表加两列并补 `modToReqFields` 映射；切换后端前需完成 |
| 台账成为"第二个总览"、与总览职责重叠 | 两者形态与用途已明确切分（§2）：总览是汇报图表，台账是可排序清单与单需求档案 |

// ============================================================
// src/views/req-view.js — 需求台账页
//
// 定位（设计文档 §2）：与总览 / 版本同级的整页文档视图，给领导与业务人员看
// 「全量需求的字段对比 + 单个需求的完整档案」。归档不再是独立页面，
// 而是本页的一个筛选条件（scope）。
//
// 形态：语义化表格 + 行内展开档案。表格负责扫描对比（可排序筛选），
// 展开区负责细读（描述 / 文档 / 上线情况 / 阶段明细）。
//
// 纯渲染：不绑事件、不读 window。所有交互通过 data-req-* 交给
// components/req-page.js 委托。
// 展开态放模块级（跨重绘保持），与 report-view / version-view 同一思路 ——
// 它是界面临时状态，不该进 planStore（否则污染导出 / 同步 / 撤销）。
// ============================================================
import { F, fmtD } from '../core/dates.js';
import { PCOL, PNAME, MODULE_LIFECYCLE, LIFECYCLE_NONE } from '../core/default-data.js';
import { moduleTag, currentPhase, computeModulePer, progressDeviation, findGateMs } from '../core/mod-tag.js';
import { versionOfMod, versionStatus, findGoMs, sortVersions, versionOptionLabel } from '../core/versions.js';
import { filterMods, sortMods, collectProposers, modGroupTier } from '../core/mod-query.js';
import { modStats, renderModDetailRows } from './mod-card.js';
import { priorityBadge, lifecycleBadge, LC_CLASS } from './badge.js';

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
//
// 呈现位置：只在展开档案的「上线情况」段。主行曾单列一列，已去掉 ——
// 它读的是版本口径（不是需求自身的进度），与「状态」列同屏时反而互相干扰（见下），
// 而它属于"细读才用得上"的信息：点开档案看更清楚，也省下一列宽度。
//
// 口径边界：无版本的需求 versionStatus 会返回「未开始」，对读者是误导 ——
// 故这里先判版本存在性，无版本一律显示「未加入版本」。
// 措辞只讲上线维度，不复述需求状态。
// 原因：versionStatus 用的是版本口径，其中「进行中」（版本有成员已开工）和
// 「已逾期」（版本过了上线日没发）会与「状态」列的 moduleTag 撞词 ——
// 同一行出现两个「进行中」、两个「已逾期」，且含义并不相同，读者要费劲分辨。
// 版本页保留 versionStatus 原文案：那里讲的就是版本本身，语境自洽。
const SHIP_TEXT = {
  shipped: '已上线',
  ready: '待上线',      // 成员全部完成、只等发版 —— 有行动含义，必须保留
  overdue: '上线逾期',
  doing: '未上线',      // 版本做没开工不属于「上线情况」这列的信息，合并为「未上线」
  todo: '未上线'
};

export function shipInfo(mo, ctx) {
  const { state, today } = ctx;
  const v = versionOfMod(state, mo.name);
  const go = findGoMs(mo);
  const planFromMs = go && go.m ? go.m : null;

  if (mo.unscheduled) {
    return { text: '待排期', color: '#94a3b8', plan: null, actual: null };
  }
  if (!v) {
    return { text: '未加入版本', color: '#94a3b8', plan: planFromMs, actual: null };
  }
  const st = versionStatus(v, state, today);
  return {
    text: SHIP_TEXT[st.key] || st.text, color: st.color,
    plan: v.date || planFromMs,
    actual: v.shipped ? v.shippedAt : null
  };
}

// 需求文档链接：只放行 http/https（渲染层再兜一道，与录入时的校验形成双保险）
const safeDocUrl = u => (/^https?:\/\//i.test(String(u || '')) ? u : null);

function docCell(mo) {
  const u = safeDocUrl(mo.docUrl);
  if (!u) return '<span class="req-doc-empty req-muted">—</span>';
  // 主行只给「有没有文档、能不能点开」；描述与文档全文都在展开档案里细读。
  // 原先这里是一枚 📄 图标 + 单独一列「描述」，两列各占一份宽度却常常全空
  // （描述多为空、文档多为「—」），故收成一列文字链接。
  return `<a class="req-doc" href="${esc(u)}" target="_blank" rel="noopener noreferrer"
    title="打开需求文档（新窗口）">需求文档</a>`;
}

// 提出信息：有哪项显示哪项，都没有显示「—」（与「未加入版本」同风格，不留空白）
function proposedCell(mo) {
  const by = (mo.proposedBy || '').trim();
  const at = (mo.proposedAt || '').trim();
  const timeTxt = at ? `<span class="req-sub">${fmtD(F(at))}</span>` : '';
  // 提出人支持行内直接改：展示版与编辑版同时渲染，由 CSS 按只读状态二选一
  // （body.readonly-mode 下只露展示版，与操作列 `.req-act` 同一套机制，渲染层不必知道只读）
  return `<span class="req-inline-view">${by ? `<b class="req-prop">${esc(by)}</b>` : '<span class="req-muted">—</span>'}</span>` +
    `<span class="req-inline-edit"><input class="req-inline req-inline-by" type="text" list="reqProposerList"`
    + ` data-req-inline="proposedBy" data-name="${esc(mo.name)}" data-prev="${esc(by)}" value="${esc(by)}"`
    + ` placeholder="未填写" title="直接修改提出人（回车或点别处生效）"></span>` + timeTxt;
}

// 生命周期行内编辑：用原生 <select> 定制成徽标外观（配色复用 .lc-* 族，去掉系统箭头）。
// 为什么不用自绘下拉：原生控件键盘可达、移动端是熟悉的滚轮，且不需要额外的开合状态。
function lifecycleSelect(name, cur) {
  const v = MODULE_LIFECYCLE.includes(cur) ? cur : '';
  const opts = ['', ...MODULE_LIFECYCLE]
    .map(o => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${o || LIFECYCLE_NONE}</option>`)
    .join('');
  return `<select class="req-inline req-inline-lc lc ${LC_CLASS[v] || 'lc-none'}"`
    + ` data-req-inline="lifecycle" data-name="${esc(name)}" data-prev="${esc(v)}"`
    + ` title="直接改生命周期（人工维护，与左侧自动计算的「状态」不是一回事）">${opts}</select>`;
}

// 所属版本行内编辑：把「编辑版本 → 取消勾选 → 再去另一个版本勾选」压成一次选择。
//
// 选项 = 「未加入版本」+ 全部版本（按上线日升序，与版本页顺序一致，
// 文案由 core/versions.js 的 versionOptionLabel 统一给出）。
// 提交不走 updateModule：需求侧不存版本字段，改归属动的是版本侧的成员名单，
// 由 components/req-page.js 转发给 sched.setModuleVersion（见 core/versions.js 的口径说明）。
//
// 一个版本都没有时不给下拉：选项只有「未加入版本」，摆在那里只会让人以为能选。
function versionCell(state, name, ver) {
  const view = `<span class="req-inline-view">${ver
    ? `${esc(ver.name)}<span class="req-sub">${ver.date ? fmtD(F(ver.date)) : ''}</span>`
    : '<span class="req-muted">未加入版本</span>'}</span>`;
  const versions = (state && state.versions) || [];
  if (!versions.length) return view;
  const cur = ver ? ver.id : '';
  const opts = `<option value=""${cur === '' ? ' selected' : ''}>未加入版本</option>`
    + sortVersions(versions).map(v => `<option value="${esc(v.id)}"${v.id === cur ? ' selected' : ''}`
      + `>${esc(versionOptionLabel(v))}</option>`).join('');
  return view
    + `<span class="req-inline-edit"><select class="req-inline req-inline-ver"`
    + ` data-req-inline="version" data-name="${esc(name)}" data-prev="${esc(cur)}"`
    + ` title="直接调整所属版本（切到别的版本会自动从原版本移出，并跟随新版本的上线日）">${opts}</select></span>`;
}

// 操作列图标：内联 SVG 而不是 emoji / Unicode 符号。
// emoji（如 🗄）在不同系统会渲成彩色字形且大小不一；✎ ✕ 这类符号在不同字体下
// 粗细也对不齐。SVG 用 stroke=currentColor 跟随文字色，hover 与 danger 变色时自动同步。
const ICON = {
  edit: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>',
  archive: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 001 1h12a1 1 0 001-1V8M10 12h4"/></svg>',
  restore: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8"/><path d="M3 3v5h5"/></svg>',
  del: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>'
};

// 关键时间：需求确认 / 提测两个卡点的日期（不新增字段，实时读排期里程碑）
// 口径见 core/mod-tag.js 的 findGateMs：提测只能按 label 认，不能判 p='sit'
//
// 待排期需求一律留空：它的排期还没定下来，这两个卡点（若存在）是自动阶段占位算出来的，
// 摆在表里会被当成"已确定的时间"读——那是误导，宁可空着。
function gateCell(mo) {
  if (mo.unscheduled) return '<span class="req-muted">—</span>';
  const cfm = findGateMs(mo, 'confirm');
  const tice = findGateMs(mo, 'submit');
  if (!cfm && !tice) return '<span class="req-muted">—</span>';
  const chip = (b, label) => `<span class="req-gate"><i style="background:${PCOL[b.p] || '#94a3b8'}"></i>${label}<b>${fmtD(F(b.m))}</b></span>`;
  return [cfm ? chip(cfm, '确认') : '', tice ? chip(tice, '提测') : ''].filter(Boolean).join('');
}

// 排期与进度列。
//
// 待排期需求只留「待排期」三个字，不显示排期区间、进度条与偏差：
//   · 排期区间为空本来就没得显示；
//   · 进度（EV / PV）是**建在排期之上**的派生量 —— 日期都还没定，算出来的 0% 与「延后 30%」
//     只会被读成"没开工 / 落后了"，而事实是"还没排期，现在不该看进度"。
// 顺带省掉这类行的 modStats 计算（台账一次要渲染全部需求）。
//
// 其余需求的偏差口径：与总览卡片 / 排期总览同口径（EV − PV），判定集中在
// core/mod-tag.js 的 progressDeviation（含"已完成不报偏差"这条，三处必须一致）。
// 两类需求不参与健康度评判：
//   · 待排期：没有排期区间，日期本身不可信，无从判偏差（见上，直接不渲染）
//   · 已归档：留档查阅用，「延后 40%」这种行动导向的提醒对它已无意义。
//     但进度条不能留着红——红了却不写原因只会更困惑，故转中性色。
//     已完成的需求例外，仍走绿：100% 是既成事实，与是否归档无关。
function planCell(mo, ctx) {
  if (mo.unscheduled) return '<span class="req-muted">待排期</span>';
  const rng = ctx.modRange(mo);
  const st = modStats(mo.bars, ctx);
  const dev = progressDeviation(mo.bars, st);
  const archQuiet = !!mo.archived && !dev.finished;
  const stCls = !rng ? '' : (archQuiet ? 'archived' : dev.key);
  const deviTxt = (rng && !mo.archived) ? dev.label : '';
  return `<span class="req-sub">${rng ? `${fmtD(rng.start)}~${fmtD(rng.end)}` : '—'}</span>
      <span class="req-c-pct">
        <span class="req-pbar"><i class="${stCls}" style="width:${Math.min(100, st.pct)}%"></i></span>
        <span class="req-sub">${st.pct.toFixed(0)}% · ${st.done.toFixed(1)}/${st.work} 人日</span>
        ${deviTxt ? `<span class="req-devi ${stCls}" title="实际完成度 ${st.pct.toFixed(1)}% − 计划应达 ${st.planPct.toFixed(1)}%（PV 按各任务的计划窗口算）">${deviTxt}</span>` : ''}
      </span>`;
}

function rowHtml(mo, ctx, deps, dragOn) {
  const { today } = ctx;
  const { tag, tagc } = moduleTag(mo, today);
  const ver = versionOfMod(ctx.state, mo.name);
  const archFlag = mo.archived ? '<span class="req-badge-arch">已归档</span>' : '';
  // 拖拽手柄与分组档位只在「进行中优先」排序下输出（dragOn）：
  // 其余排序的档内先后由排序键决定（优先级 / 日期…），拖完会被重排回去，
  // 与其让用户白拖一次，不如干脆不给手柄（判定见 components/req-page.js 的拖拽委托）。
  const dragAttr = dragOn ? ` draggable="true" data-req-drag="${esc(mo.name)}"` : '';
  // ⚠️ 档位必须用排序同源的 modGroupTier：逾期与"进行中"在视觉上同组，
  //    若这里写细分档，两者档位不同 → 明明同组却拖不动
  const tierAttr = dragOn ? ` data-req-tier="${modGroupTier(mo, deps)}"` : '';

  return `<tr class="req-row" data-req-row="${esc(mo.name)}"${tierAttr}>
    <td class="req-c-name"${dragAttr}>${priorityBadge(mo.pri)}<b>${esc(mo.name)}</b>${archFlag}</td>
    <td class="req-col-opt">${proposedCell(mo)}</td>
    <td><span class="tag" style="background:${tagc}">${tag}</span></td>
    <td class="req-c-lc">
      <span class="req-inline-view">${lifecycleBadge(mo.lifecycle)}</span>
      <span class="req-inline-edit">${lifecycleSelect(mo.name, mo.lifecycle)}</span>
    </td>
    <td class="req-col-opt">${docCell(mo)}</td>
    <td class="req-c-ver">${versionCell(ctx.state, mo.name, ver)}</td>
    <td class="req-c-plan">${planCell(mo, ctx)}</td>
    <td class="req-c-gate">${gateCell(mo)}</td>
    <td class="req-ops req-act">
      <button type="button" class="ico-btn" data-req-edit="${esc(mo.name)}" title="编辑需求" aria-label="编辑需求">${ICON.edit}</button>
      <button type="button" class="ico-btn" data-req-archive="${esc(mo.name)}" data-name="${esc(mo.name)}" data-archived="${mo.archived ? '1' : '0'}" title="${mo.archived ? '取消归档' : '归档需求'}" aria-label="${mo.archived ? '取消归档' : '归档需求'}">${mo.archived ? ICON.restore : ICON.archive}</button>
      <button type="button" class="ico-btn danger" data-req-del="${esc(mo.name)}" data-name="${esc(mo.name)}" title="删除需求" aria-label="删除需求">${ICON.del}</button>
    </td>
  </tr>`;
}

// 排序方式下拉的选项：值编码成 "key:dir"，与 viewState.reqSort 一一对应。
// 为什么要这个下拉：排序原先只能点表头，而表头没有任何"可点"的暗示，
// 用户基本发现不了；再加上首列现在默认按「进行中优先」排（不对应任何单一列），
// 光靠表头点击也无法表达这个状态。
const SORT_OPTIONS = [
  // group 内部叫「进行中优先」（分档 + 档内甘特图顺序），下拉里只写「默认排序」：
  // 看台账的人不需要知道排序算法，只需要认出"这就是打开时那档"
  ['group:asc', '默认排序'],
  ['focus:asc', '关注度排序'],
  ['pri:asc', '优先级（高在前）'],
  ['end:asc', '计划结束日（近在前）'],
  ['end:desc', '计划结束日（远在前）'],
  ['start:asc', '排期开始日（早在前）'],
  ['pct:asc', '完成度（低在前）'],
  ['pct:desc', '完成度（高在前）'],
  ['lifecycle:asc', '生命周期（流程先后）'],
  // 计划上线日：主行已不单列这一项（收进展开档案），但排序照旧有意义 ——
  // "哪条最先上线"是排期会上的常用问法，展开档案里能看到具体日期
  ['ship:asc', '计划上线日（近在前）'],
  ['proposed:desc', '提出时间（近在前）'],
  ['name:asc', '需求名'],
  ['order:asc', '甘特图顺序']
];

// 筛选条：所有控件都带 data-req-* 属性，交给 components/req-page.js 委托
function filterBar(filter, sort, versions, total, shown) {
  const opt = (v, label, cur) => `<option value="${esc(v)}"${cur === v ? ' selected' : ''}>${label}</option>`;
  const verOpts = ['all', 'none', ...versions.map(v => v.id)].map(v => {
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
    <select class="req-f" data-req-f="lifecycle">
      ${['all', ...MODULE_LIFECYCLE, 'none'].map(v => opt(v, v === 'all' ? '全部生命周期' : (v === 'none' ? '未设置' : v), filter.lifecycle)).join('')}
    </select>
    <select class="req-f" data-req-f="ver">${verOpts}</select>
    <select class="req-f" data-req-f="scope">
      ${opt('all', '全部需求', filter.scope)}${opt('active', '排除已归档', filter.scope)}${opt('archived', '只看已归档', filter.scope)}
    </select>
    <select class="req-f" data-req-f="unscheduled">
      ${opt('all', '排期不限', filter.unscheduled)}${opt('only', '只看待排期', filter.unscheduled)}${opt('exclude', '排除待排期', filter.unscheduled)}
    </select>
    <select class="req-f req-sortsel" data-req-sortsel title="排序方式（点击表头也可切换）">
      ${SORT_OPTIONS.map(([val, label]) =>
        `<option value="${esc(val)}"${(sort.key + ':' + sort.dir) === val ? ' selected' : ''}>${label}</option>`).join('')}
    </select>
    <button type="button" class="btn ghost" data-req-reset>重置</button>
    <span class="req-count">${shown === total ? `共 ${total} 个需求` : `筛选后 ${shown} 个 / 共 ${total} 个`}</span>
  </div>`;
}

// 里程碑一览：需求内全部里程碑按日期升序（需求确认 / 提测 / 上线…）
function msList(mo) {
  const ms = ((mo.bars) || []).filter(b => b.m).sort((a, b) => F(a.m) - F(b.m));
  if (!ms.length) return '<span class="req-muted">该需求没有里程碑</span>';
  return ms.map(b => `<span class="req-ms"><i class="req-ms-dot" style="background:${PCOL[b.p] || '#94a3b8'}"></i>${esc(b.label || PNAME[b.p] || '里程碑')}<b>${fmtD(F(b.m))}</b></span>`).join('');
}

// 展开档案：把「一个需求的完整故事」摊开（设计文档 §4.2）
// 七段固定顺序：提出与生命周期 → 描述 → 文档 → 上线情况 → 排期与进度 → 阶段明细 → 里程碑
function detailHtml(mo, ctx) {
  const { today } = ctx;
  const ship = shipInfo(mo, ctx);
  const ver = versionOfMod(ctx.state, mo.name);
  const rng = mo.unscheduled ? null : ctx.modRange(mo);
  const st = modStats(mo.bars, ctx);
  const desc = (mo.desc || '').trim();
  const docUrl = safeDocUrl(mo.docUrl);
  const per = computeModulePer(mo.bars || [], ctx.state.resources);
  const propBy = (mo.proposedBy || '').trim();
  const propAt = (mo.proposedAt || '').trim();
  const cfmMs = findGateMs(mo, 'confirm');
  const ticeMs = findGateMs(mo, 'submit');
  const dev = progressDeviation(mo.bars, st);
  // 展开区是"细读"场景，措辞要给全：已完成的需求不报偏差，直接说「已完成」
  const deviTxt = !st.work ? '' : (dev.finished ? '已完成' : (dev.label || '按计划'));

  // colspan 给一个明显大于当前列数（10）的值：浏览器会自动收敛到实际列数，
  // 以后增删列就不必回来同步这个数字（它已经从 9 漂到 12 过一次）
  return `<tr class="req-detail-tr"><td colspan="20">
    <div class="req-detail">
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
          <span><i>所属版本</i><b>${versionCell(ctx.state, mo.name, ver)}</b></span>
          <span><i>计划上线</i><b>${ship.plan ? fmtD(F(ship.plan)) : '—'}</b></span>
          <span><i>实际上线</i><b>${ship.actual ? fmtD(F(ship.actual)) : '—'}</b></span>
        </div>
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

export function renderReqView(container, ctx) {
  const { state, today } = ctx;
  const all = state.modules || [];
  const filter = ctx.reqFilter || {};
  const sort = ctx.reqSort || { key: 'order', dir: 'asc' };
  const deps = { today, versions: state.versions || [], modRange: ctx.modRange, ctx };
  const hit = sortMods(filterMods(all, filter, deps), sort.key, sort.dir, deps);
  const versions = state.versions || [];
  // 拖拽排序只在默认的「进行中优先」下渲染手柄：那个排序的档内就是甘特图顺序，拖动才改得动
  const dragOn = sort.key === 'group' && sort.dir === 'asc';

  const head = `<div class="report-sec">
    <div class="report-head">需求台账<span>全部需求清单（含待排期与已归档）· 点任意一行展开需求档案</span></div>
    ${filterBar(filter, sort, versions, all.length, hit.length)}`;

  if (!hit.length) {
    return `<div class="report-wrap req-wrap">${head}
      <div class="arch-empty">
        <b>没有符合条件的需求</b>
        <span>放宽筛选条件，或新建一个需求</span>
        <button type="button" class="btn ghost" data-req-reset>重置筛选</button>
      </div>
    </div></div>`;
  }

  const th = (key, label, cls = '', title = '') => {
    const on = sort.key === key ? ' on' : '';
    const arrow = sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th data-req-sort="${key}" class="${(cls + on).trim()}"${title ? ` title="${esc(title)}"` : ''}>${label}${arrow}</th>`;
  };

  // 展开档案紧跟在被点开的那一行之后（同一 tbody 内的 detail 行）
  const rows = hit.map(mo => rowHtml(mo, ctx, deps, dragOn) + (reqExpanded.has(mo.name) ? detailHtml(mo, ctx) : '')).join('');

  return `<div class="report-wrap req-wrap">
    ${head}
    <datalist id="reqProposerList">${collectProposers(all).map(n => `<option value="${esc(n)}"></option>`).join('')}</datalist>
      <div class="req-scroll">
        <table class="req-table">
          <thead><tr>
            ${th('name', '需求')}
            ${th('proposed', '提出人', 'req-col-opt', '提出人 / 提出时间；窄屏隐藏该列（背景信息，不是对比指标）')}
            ${th('status', '状态')}
            ${th('lifecycle', '生命周期', '', '人工维护的流程门，与左侧自动计算的「状态」不是同一件事')}
            <th class="req-col-opt" title="有需求文档链接时显示可点入口；无则「—」">文档</th>
            ${th('version', '所属版本')}
            ${th('start', '排期与进度', '', '排期区间 + 完成度（含与计划的偏差）；待排期需求为空；点击按排期起点排序')}
            ${th('confirm', '关键时间', '', '需求确认 / 提测两个卡点的排期日期；待排期需求为空；点击按需求确认时间排序，缺里程碑的排最后')}
            <th class="req-act">操作</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  </div>`;
}

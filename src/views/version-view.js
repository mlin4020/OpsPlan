// ============================================================
// src/views/version-view.js — 版本（迭代）页面
//
// 定位：给"要一起上线的几个需求"一个统一上线日，并一屏看清「这版能不能按时上」。
// 形态：整页文档（与总览 / 归档 / 资源工作视图同一套 report-mode 版式），
//       版本卡纵向排列，卡内是该版本的成员需求清单。
//
// 数据：state.versions（版本是主，成员按需求名引用）+ state.modules（反查成员对象）。
//       "状态 / 完成度 / 排期区间"的口径全部来自 core/versions.js 与 mod-card.js 的 modStats，
//       **不在本文件重算**——否则版本页与需求卡片会给出两个数。
//
// 交互：纯渲染，不绑定事件；所有按钮通过 [data-ver-*] 属性交给 components/version-page.js 委托。
// 只读：所有会改数据的按钮统一带 .ver-act，由 CSS（body.readonly-mode .ver-act）隐藏。
//
// 展开态放在模块级（跨重绘保持），与 report-view 的 reportExpanded 同一思路：
// 它属于"界面临时状态"，不该进 planStore（否则会污染导出/同步/撤销）。
// ============================================================
import { F, fmtD, diff } from '../core/dates.js';
import { moduleTag } from '../core/mod-tag.js';
import { versionMembers, versionStatus, versionProgress, versionRange, sortVersions, versionOptionLabel } from '../core/versions.js';
import { modStats } from './mod-card.js';
import { priorityBadge } from './badge.js';
import { userStore } from '../store/user-store.js';
import { ctxOf, canDeleteVersion, canArchiveVersionMods } from '../utils/permission.js';

const verExpanded = new Set();

// 每页版本数：一屏能同时看到"几个版本 + 各自的成员"，再多就要滚很远才有下一页；
// 与展开态一样属于界面临时状态，故也留在本模块（不进 planStore / viewState）
const VER_PAGE_SIZE = 6;
let verPage = 1;

export function isVersionExpanded(id) { return verExpanded.has(id); }
export function toggleVersionExpanded(id) {
  if (verExpanded.has(id)) verExpanded.delete(id);
  else verExpanded.add(id);
  return verExpanded.has(id);
}

// 当前页码（1 起。渲染时按实际页数钳制，见 renderVersionView）
export function getVersionPage() { return verPage; }
export function setVersionPage(n) {
  const p = Math.floor(Number(n));
  verPage = p >= 1 ? p : 1;
  return verPage;
}

// 某个版本落在第几页。排序与分页口径都在本文件，外面（组件层）不必再算一遍 ——
// 新建版本 / 改版本归属之后要靠它把那一页翻出来，否则用户"操作完看不见结果"。
export function versionPageOf(state, id) {
  const list = sortVersions((state && state.versions) || []);
  const i = list.findIndex(v => v && v.id === id);
  return i < 0 ? 1 : Math.floor(i / VER_PAGE_SIZE) + 1;
}

// 计划 vs 实际的差异文案："延后 2 天 / 提前 1 天 / 准点"。
// 实际发版是版本管理里最有用的一个数（排期准不准），故单独给一条：
const actualDiffText = (v) => {
  if (!v.shippedAt || !v.date) return '';
  const d = diff(F(v.date), F(v.shippedAt));
  if (d > 0) return `延后 ${d} 天`;
  if (d < 0) return `提前 ${-d} 天`;
  return '准点';
};

// 成员行：需求名 / 状态标签 / 排期区间 / 完成度 / 换版本 / 移出
//
// 换版本下拉：改归属原先只能进版本弹窗"先取消勾选、再去另一个版本勾选"，
// 而在这一页上你看到的正是"这版有哪几个需求" —— 发现放错了就地改才顺手。
// 下拉里**不放**「未加入版本」：本行末尾的 × 就是移出，两个入口做同一件事只会让人犹豫。
function memberRow(v, mo, ctx) {
  const { state, today } = ctx;
  const { tag, tagc } = moduleTag(mo, today);
  const rng = versionRange({ mods: [mo.name], date: v.date }, state);
  const pct = modStats(mo.bars, ctx).pct;
  // 只有一个版本时不给下拉：唯一选项就是它自己
  const all = state.versions || [];
  const move = all.length > 1
    ? `<select class="ver-mod-move ver-act" data-ver-move="${v.id}" data-mod="${mo.name}"
        title="把「${mo.name}」调整到别的版本（会自动从本版本移出，上线日跟随新版本）">${
        sortVersions(all).map(x => `<option value="${x.id}"${x.id === v.id ? ' selected' : ''}>${versionOptionLabel(x)}</option>`).join('')
      }</select>`
    : '';
  return `<div class="ver-mod">
      <span class="ver-mod-name" title="${mo.name}">${priorityBadge(mo.pri)}${mo.name}</span>
      <span class="tag" style="background:${tagc}">${tag}</span>
      <span class="ver-mod-range">${rng ? `${fmtD(rng.start)}~${fmtD(rng.end)}` : '—'}</span>
      <span class="ver-mod-pct">${pct.toFixed(0)}%</span>
      ${move}
      <button type="button" class="ver-mod-x ver-act" data-ver-remove="${v.id}" data-mod="${mo.name}"
        title="把「${mo.name}」从本版本移出（其上线日恢复为跟随任务自动计算）">×</button>
    </div>`;
}

// 单个版本卡
function versionCard(v, ctx) {
  const { state, workday, today } = ctx;
  const st = versionStatus(v, state, today);
  const mods = versionMembers(v, state);
  const pr = versionProgress(v, state, workday);
  const rng = versionRange(v, state);
  const open = verExpanded.has(v.id);
  const actual = actualDiffText(v);
  // 两个"全权动作"按钮：删版本会一次性解绑里面所有需求（影响面比删单个需求大）；
  // 一键归档会批量改成员需求的 archived（归属级字段）。其余版本操作对协作者保持放开。
  const c = ctxOf(userStore.state);
  const showDanger = canDeleteVersion(c) && canArchiveVersionMods(c);

  // 头行：不展开也能一眼看到"这个版本什么时候上、做完没有"。
  //
  // data-ver-toggle 挂在**整行**上（不只是右下角那个三角）：卡片收起来的时候，
  // 头行就是整张卡片，点哪儿都该展开 —— 只让三角可点是"看不出来能点"的老问题。
  // 行内的「编辑 / 标记上线」按钮自带 data-ver-* ，closest 会先命中它们，
  // 不会顺手把卡片折叠掉（见 components/version-page.js 的 onClick）。
  const hd = `<div class="ver-hd" data-ver-toggle="${v.id}">
      <span class="ver-name" title="${v.name}">${v.name}</span>
      <span class="tag" style="background:${st.color}">${st.text}</span>
      <span class="ver-date" title="计划上线日（成员需求的「上线」日期自动跟随它）">计划 ${fmtD(F(v.date))} 上线</span>
      ${v.shipped && v.shippedAt ? `<span class="ver-actual">实际 ${fmtD(F(v.shippedAt))}${actual ? ` · ${actual}` : ''}</span>` : ''}
      <span class="ver-count">${mods.length} 个需求</span>
      ${mods.length ? `<span class="ver-pct">完成 ${pr.pct.toFixed(1)}%</span>` : ''}
      ${rng ? `<span class="ver-range">${fmtD(rng.start)}~${fmtD(rng.end)}</span>` : ''}
      <span class="ver-spacer"></span>
      <button type="button" class="btn ghost ver-act" data-ver-edit="${v.id}">编辑</button>
      ${v.shipped
        ? `<button type="button" class="btn ghost ver-act" data-ver-unship="${v.id}" title="取消「已上线」标记（版本恢复可编辑）">取消上线</button>`
        : `<button type="button" class="btn primary ver-act" data-ver-ship="${v.id}" title="标记为已上线并记录实际上线日">标记上线</button>`}
      <button type="button" class="ver-arr" data-ver-toggle="${v.id}" aria-expanded="${open ? 'true' : 'false'}"
        aria-label="${open ? '收起成员' : '展开成员'}">${open ? '▲' : '▼'}</button>
    </div>`;

  if (!open) return `<div class="ver-card" data-ver-id="${v.id}">${hd}</div>`;

  // 刻意不做表头行：成员行是可折行的 flex，表头列宽与内容列宽无法保证对齐，
  // 一行"对不齐的表头"比没有表头更让人怀疑数据。每行自带单位（%、天数），语义自明。
  const body = `<div class="ver-body">
      ${mods.length ? mods.map(mo => memberRow(v, mo, ctx)).join('')
        : '<div class="ver-mod-empty">还没有需求 · 点右下角「＋ 加需求」把要一起上线的需求放进来</div>'}
      <div class="ver-foot">
        <button type="button" class="btn primary ver-act" data-ver-add="${v.id}">＋ 加需求</button>
        ${v.shipped && showDanger ? `<button type="button" class="btn ghost ver-act" data-ver-archive="${v.id}" title="把本版本的全部需求标记为已归档（不自动执行，避免误收口）">归档本版本全部需求</button>` : ''}
        <span class="ver-spacer"></span>
        ${showDanger ? `<button type="button" class="btn danger ver-act" data-ver-del="${v.id}" title="删除版本（成员的上线日恢复为跟随任务自动计算）">删除版本</button>` : ''}
      </div>
    </div>`;

  return `<div class="ver-card open" data-ver-id="${v.id}">${hd}${body}</div>`;
}

// 分页条：一页装得下就不渲染（多一条没有信息量的工具条只会占地方）。
// 按钮的 data-ver-page 直接给**目标页码**，组件层拿到就设，不必在那儿再判 prev/next。
function pager(total, page) {
  const totalPages = Math.max(1, Math.ceil(total / VER_PAGE_SIZE));
  if (totalPages <= 1) return '';
  const btn = (target, label, disabled) =>
    `<button type="button" class="btn ghost ver-page-btn" data-ver-page="${target}"${disabled ? ' disabled' : ''}>${label}</button>`;
  return `<div class="ver-pager">
      ${btn(page - 1, '← 上一页', page <= 1)}
      <span class="ver-page-txt">第 ${page} / ${totalPages} 页 · 每页 ${VER_PAGE_SIZE} 个版本</span>
      ${btn(page + 1, '下一页 →', page >= totalPages)}
    </div>`;
}

export function renderVersionView(container, ctx) {
  const { state, today } = ctx;
  // 上线日倒序：最新的版本排最前（口径见 core/versions.js 的 sortVersions）
  const versions = sortVersions(state.versions);
  const sts = versions.map(v => versionStatus(v, state, today));
  const nOverdue = sts.filter(x => x.key === 'overdue').length;
  const nReady = sts.filter(x => x.key === 'ready').length;

  // 页码在这里钳制：删掉最后一页的版本、或数据变少之后，停在一个空页上是最糟的结果。
  // 钳制是幂等的（页码已合法时不动），所以放在渲染里安全。
  const totalPages = Math.max(1, Math.ceil(versions.length / VER_PAGE_SIZE));
  if (verPage > totalPages) verPage = totalPages;
  if (verPage < 1) verPage = 1;
  const pageList = versions.slice((verPage - 1) * VER_PAGE_SIZE, verPage * VER_PAGE_SIZE);

  const head = `<div class="report-sec">
    <div class="report-head">版本（迭代）<span>共 ${versions.length} 个版本${nOverdue ? ` · ${nOverdue} 个已逾期` : ''}${nReady ? ` · ${nReady} 个待上线` : ''}${totalPages > 1 ? ` · 第 ${verPage}/${totalPages} 页` : ''}</span></div>
    <div class="ver-bar">
      <button type="button" class="btn primary ver-act" data-ver-new>＋ 新建版本</button>
      <span class="ver-hint">版本 = 迭代：给一组需求一个统一上线日。需求加入后，甘特图上该需求的「上线」日期自动改为版本上线日（改版本日也会跟着改）。</span>
    </div>
    ${versions.length
      ? `<div class="ver-list">${pageList.map(v => versionCard(v, ctx)).join('')}</div>${pager(versions.length, verPage)}`
      : `<div class="ver-empty">
          <b>还没有版本</b>
          <span>点「＋ 新建版本」给一组需求一个统一上线日，例如「V2.3 · 10/29 上线」</span>
        </div>`}
  </div>`;

  return `<div class="report-wrap">${head}</div>`;
}

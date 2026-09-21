// ============================================================
// src/views/version-view.js — 版本（迭代）页面
//
// 定位：给"要一起上线的几个需求"一个统一上线日，并一屏看清「这版能不能按时上」。
// 形态：整页文档（与总览 / 归档 / 资源工作视图同一套 report-mode 版式），
//       版本卡纵向排列，卡内是该版本的成员需求清单。
//
// 数据：state.versions（版本是主，成员按需求名引用）+ state.modules（反查成员对象）。
//       "赶不上 / 状态 / 完成度"的口径全部来自 core/versions.js 与 mod-card.js 的 modStats，
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
import { versionMembers, versionStatus, versionProgress, versionRange, modLate, sortVersions } from '../core/versions.js';
import { modStats } from './mod-card.js';
import { priorityBadge } from './badge.js';

const verExpanded = new Set();

export function isVersionExpanded(id) { return verExpanded.has(id); }
export function toggleVersionExpanded(id) {
  if (verExpanded.has(id)) verExpanded.delete(id);
  else verExpanded.add(id);
  return verExpanded.has(id);
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

// 成员行：需求名 / 状态标签 / 排期区间 / 完成度 / 赶不上提示
function memberRow(v, mo, ctx) {
  const { state, today, workday } = ctx;
  const { tag, tagc } = moduleTag(mo, today);
  const rng = versionRange({ mods: [mo.name], date: v.date }, state);
  const pct = modStats(mo.bars, rng, ctx).pct;
  const late = modLate(v, mo);
  // 状态说明：待排期需求的日期不可信（不参与赶不上判定），单独标灰，别让它显示成"可按时"
  const flag = mo.unscheduled
    ? '<span class="ver-mod-flag muted">待排期</span>'
    : (late
      ? `<span class="ver-mod-flag late" title="按当前排期算，最晚 ${fmtD(late.end)} 才完成">赶不上 · 晚 ${late.days} 天</span>`
      : '<span class="ver-mod-flag ok">可按时</span>');
  return `<div class="ver-mod">
      <span class="ver-mod-name" title="${mo.name}">${priorityBadge(mo.pri)}${mo.name}</span>
      <span class="tag" style="background:${tagc}">${tag}</span>
      <span class="ver-mod-range">${rng ? `${fmtD(rng.start)}~${fmtD(rng.end)}` : '—'}</span>
      <span class="ver-mod-pct">${pct.toFixed(0)}%</span>
      ${flag}
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
  const lateN = mods.filter(mo => modLate(v, mo)).length;
  const open = verExpanded.has(v.id);
  const actual = actualDiffText(v);

  // 头行：不展开也能一眼看到"这个版本什么时候上、做完没有、有没有人赶不上"
  const hd = `<div class="ver-hd">
      <span class="ver-name" title="${v.name}">${v.name}</span>
      <span class="tag" style="background:${st.color}">${st.text}</span>
      <span class="ver-date" title="计划上线日（成员需求的「上线」日期自动跟随它）">计划 ${fmtD(F(v.date))} 上线</span>
      ${v.shipped && v.shippedAt ? `<span class="ver-actual">实际 ${fmtD(F(v.shippedAt))}${actual ? ` · ${actual}` : ''}</span>` : ''}
      <span class="ver-count">${mods.length} 个需求</span>
      ${mods.length ? `<span class="ver-pct">完成 ${pr.pct.toFixed(1)}%</span>` : ''}
      ${rng ? `<span class="ver-range">${fmtD(rng.start)}~${fmtD(rng.end)}</span>` : ''}
      ${lateN ? `<span class="ver-late">${lateN} 个赶不上</span>` : ''}
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
        ${v.shipped ? `<button type="button" class="btn ghost ver-act" data-ver-archive="${v.id}" title="把本版本的全部需求标记为已归档（不自动执行，避免误收口）">归档本版本全部需求</button>` : ''}
        <span class="ver-spacer"></span>
        <button type="button" class="btn danger ver-act" data-ver-del="${v.id}" title="删除版本（成员的上线日恢复为跟随任务自动计算）">删除版本</button>
      </div>
    </div>`;

  return `<div class="ver-card open" data-ver-id="${v.id}">${hd}${body}</div>`;
}

export function renderVersionView(container, ctx) {
  const { state, today } = ctx;
  const versions = sortVersions(state.versions);
  const sts = versions.map(v => versionStatus(v, state, today));
  const nOverdue = sts.filter(x => x.key === 'overdue').length;
  const nReady = sts.filter(x => x.key === 'ready').length;

  const head = `<div class="report-sec">
    <div class="report-head">版本（迭代）<span>共 ${versions.length} 个版本${nOverdue ? ` · ${nOverdue} 个已逾期` : ''}${nReady ? ` · ${nReady} 个待上线` : ''}</span></div>
    <div class="ver-bar">
      <button type="button" class="btn primary ver-act" data-ver-new>＋ 新建版本</button>
      <span class="ver-hint">版本 = 迭代：给一组需求一个统一上线日。需求加入后，甘特图上该需求的「上线」日期自动改为版本上线日（改版本日也会跟着改）；排到上线日之后的需求会标红「赶不上」。</span>
    </div>
    ${versions.length
      ? `<div class="ver-list">${versions.map(v => versionCard(v, ctx)).join('')}</div>`
      : `<div class="ver-empty">
          <b>还没有版本</b>
          <span>点「＋ 新建版本」给一组需求一个统一上线日，例如「V2.3 · 10/29 上线」</span>
        </div>`}
  </div>`;

  return `<div class="report-wrap">${head}</div>`;
}

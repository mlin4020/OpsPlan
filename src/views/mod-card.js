// ============================================================
// src/views/mod-card.js — 需求进度卡片（总览「需求进度」与「归档需求」页共用）
//
// 为什么单独成模块：这张卡片原本是 renderReportView 里的闭包，归档页也要用它。
// 抽出来之后，两处页面共用同一份 DOM 结构与样式，不会各自漂移。
//
// 纯渲染：接收 ctx（state/today/workday/modRange/fmtD）与 opts，返回 HTML 字符串。
// opts:
//   isExpanded(name) → 是否展开明细（展开态由调用方持有，故用谓词传入而不是引用状态）
//   archivedAt       → 有值时在标题行补一个「M/D 归档」标记（归档页专用字段）
//   actions          → 追加到卡片右上角（展开箭头之前）的 HTML，如「取消归档」按钮
// ============================================================
import { F, fmtD } from '../core/dates.js';
import { PCOL, PNAME } from '../core/default-data.js';
import { computeModulePer, milestoneName, moduleTag, currentPhase } from '../core/mod-tag.js';
import { versionOfMod } from '../core/versions.js';
import { modStats } from '../core/mod-stats.js';
import { priorityBadge, versionBadge } from './badge.js';

// 里程碑名里若自带前导日期（默认数据形如 "9/9 上线"），剥掉它，
// 避免与外部已单独显示的日期拼成 "9/9 9/9 上线"
export const msName = (b, modName) => milestoneName(b, modName).replace(/^\d{1,2}\/\d{1,2}\s*/, '');

// 需求级统计已下沉 core（台账页要在 core 层按完成度排序时用到），此处转出以保持既有调用方不变。
// 注意：必须是先 import 再 export —— `export { x } from '...'` 只是转发，不会在本模块建立绑定，
// 而 renderModCard 内部要调用 modStats，用转发式写法会直接 ReferenceError。
export { modStats };

// 归档时间（ISO 字符串）→ 「M/D 归档」；解析失败或缺失返回空串
export function archivedAtText(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()} 归档`;
}

// 需求阶段明细行（总览卡片展开区与需求台账的展开档案共用同一份 DOM）
// 台账页直接调用本函数，不复制列结构与口径 —— 两处各写一份必然漂移。
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

// 单个需求的进度卡片（普通需求与归档需求共用同一渲染逻辑）
export function renderModCard(mo, ctx, opts = {}) {
  const { state, today, modRange } = ctx;
  const isExpanded = opts.isExpanded || (() => false);
  const archivedAt = opts.archivedAt || '';
  const actions = opts.actions || '';
  // 所属版本（迭代）：反查自 state.versions，需求侧不存字段（见 core/versions.js 注释）
  const ver = versionOfMod(state, mo.name);

  // 待排期需求：卡片只保留需求名与状态，不给进度条 / 里程碑 / 人员 / 应达基线
  if (mo.unscheduled) {
    return `<div class="rmod-card rmod-unsched">
      <div class="rmod-top">
        <div class="rmod-idx" style="background:#94a3b8">待排期</div>
        <div class="rmod-head">
          <span class="rmod-title"><b class="rmod-name">${mo.name}</b>${priorityBadge(mo.pri)}${versionBadge(ver)}<span class="rmod-range">未排期</span></span>
        </div>
      </div>
      <div class="rmod-bar"><span class="rtl2-unsched">待排期</span></div>
    </div>`;
  }

  const bars = mo.bars || [];
  const rng = modRange(mo);
  const { tag: autoTag, tagc: autoTagc } = moduleTag(mo, today);
  const autoPer = computeModulePer(bars, state.resources);
  const { work: mWork, done: mDone, pct: mp, planPct } = modStats(bars, rng, ctx);
  const devi = Math.round((mp - planPct) * 10) / 10;
  const st = (!rng || !mWork) ? '' : (devi < -0.5 ? 'late' : (devi > 0.5 ? 'ahead' : 'on'));
  const stTxt = st === 'late' ? `延后${Math.abs(devi).toFixed(0)}%` : (st === 'ahead' ? `超前${devi.toFixed(0)}%` : '');
  // 今日在需求时间范围内的位置（用于今日线 / 应达基线）
  const modStart = rng ? rng.start.getTime() : 0;
  const modSpan = rng ? (rng.end.getTime() - modStart || 864e5) : 1;
  const modPct = d => Math.max(0, Math.min(100, ((d.getTime() - modStart) / modSpan) * 100));
  const todayPos = rng ? modPct(today) : 0;
  // 里程碑标注：参考排期总览的样式（菱形 + 虚线下延 + 文字标签）
  const moMss = bars.filter(b => b.m).sort((a, b) => F(a.m) - F(b.m));
  const msMarkers = moMss.length && rng ? moMss.map(b => {
    const p = modPct(F(b.m));
    const tice = /提测/.test(b.label || '');
    const on = F(b.m) <= today;
    const cls = tice ? 'tice' : (on ? 'on' : 'go');
    // 条内文字保留日期（卡片里没有独立日期列，带上更好读）；
    // title 已单独给出日期，改用剥掉日期前缀的名字，避免再次拼成 "9/9 9/9 上线"
    const lbl = milestoneName(b, mo.name);
    return `<div class="rmod-m ${cls}" style="left:${p.toFixed(1)}%" title="📌 ${fmtD(F(b.m))} ${msName(b, mo.name)}">
      <i></i><b></b><em>${lbl}</em></div>`;
  }).join('') : '';
  const open = isExpanded(mo.name);
  const detailRows = open ? renderModDetailRows(mo, ctx) : '';

  const barTodayHtml = rng ? `<i class="rmod-bar-today" style="left:${todayPos.toFixed(1)}%"></i>` : '';
  // 进度填充色：与排期总览一致 —— 正常/超前=标准绿(green-600)，延期=标准红(red-600)
  const fillColor = st === 'late' ? '#dc2626' : '#16a34a';
  return `
  <div class="rmod-card" data-report-mod="${mo.name}">
    <div class="rmod-top">
      <div class="rmod-idx" style="background:${autoTagc}">${autoTag}</div>
      <div class="rmod-head">
        <span class="rmod-title"><b class="rmod-name">${mo.name}</b>${priorityBadge(mo.pri)}${versionBadge(ver)}<span class="rmod-range">${rng ? `${fmtD(rng.start)}~${fmtD(rng.end)}` : '暂无'}</span>${archivedAt ? `<span class="rmod-at" title="归档时间">${archivedAt}</span>` : ''}</span>
        <span class="rmod-meta" title="完成 ${mp.toFixed(1)}% · ${mDone.toFixed(1)}/${mWork} 人日${stTxt ? ' · ' + stTxt : ''}"><b>${mp.toFixed(1)}%</b><i>${mDone.toFixed(1)}/${mWork} 人日</i>${stTxt ? `<span class="rmod-devi ${st}">${stTxt}</span>` : ''}</span>
        <span class="rmod-phase">${currentPhase(mo, today)}</span>
      </div>
      ${actions}<span class="rmod-arr">${open ? '▲' : '▼'}</span>
    </div>
    <div class="rmod-bar ${st}">
      <div class="rmod-bar-fill" style="width:${mp.toFixed(1)}%;background:${fillColor}"></div>
      ${barTodayHtml}
      ${msMarkers}
    </div>
    <div class="rmod-t3"><span class="rmod-per">${autoPer || '暂无人员'}</span></div>
    ${open ? `<div class="rmod-detail">${detailRows}</div>` : ''}
  </div>`;
}

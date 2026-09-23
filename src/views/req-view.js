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
import { moduleTag } from '../core/mod-tag.js';
import { versionOfMod, versionStatus, modLate, findGoMs } from '../core/versions.js';
import { filterMods, sortMods } from '../core/mod-query.js';
import { modStats } from './mod-card.js';
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
//
// 口径边界：无版本的需求 versionStatus 会返回「未开始」，对读者是误导 ——
// 故这里先判版本存在性，无版本一律显示「未加入版本」，且不给「赶不上」预警
// （modLate 本身也只在有版本时才有效）。
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

// 需求文档链接：只放行 http/https（渲染层再兜一道，与录入时的校验形成双保险）
const safeDocUrl = u => (/^https?:\/\//i.test(String(u || '')) ? u : null);

function descCell(mo) {
  const d = (mo.desc || '').trim();
  // 空值也带 .req-desc：列宽与截断规则保持一致，不会因为有没有描述而抖动
  if (!d) return '<span class="req-desc req-muted">—</span>';
  // 单行截断 + title 全文：让读者知道"点开有没有内容"
  return `<span class="req-desc" title="${esc(d)}">${esc(d)}</span>`;
}

function docCell(mo) {
  const u = safeDocUrl(mo.docUrl);
  if (!u) return '<span class="req-doc-empty req-muted">—</span>';
  return `<a class="req-doc" href="${esc(u)}" target="_blank" rel="noopener noreferrer"
    title="打开需求文档（新窗口）" aria-label="打开需求文档">📄</a>`;
}

function shipCell(ship) {
  const parts = [`<span class="tag" style="background:${ship.color}">${ship.text}</span>`];
  if (ship.plan) parts.push(`<span class="req-sub">计划 ${fmtD(F(ship.plan))}</span>`);
  if (ship.actual) parts.push(`<span class="req-sub">实际 ${fmtD(F(ship.actual))}</span>`);
  if (ship.late) parts.push(`<span class="req-late" title="按当前排期算，最晚 ${fmtD(ship.late.end)} 才完成">赶不上 · 晚 ${ship.late.days} 天</span>`);
  return parts.join(' ');
}

function rowHtml(mo, ctx) {
  const { today } = ctx;
  const { tag, tagc } = moduleTag(mo, today);
  const ship = shipInfo(mo, ctx);
  const ver = versionOfMod(ctx.state, mo.name);
  const rng = mo.unscheduled ? null : ctx.modRange(mo);
  const st = modStats(mo.bars, rng, ctx);
  const archFlag = mo.archived ? '<span class="req-badge-arch">已归档</span>' : '';

  return `<tr class="req-row" data-req-row="${esc(mo.name)}">
    <td class="req-c-name">${priorityBadge(mo.pri)}<b>${esc(mo.name)}</b>${archFlag}</td>
    <td><span class="tag" style="background:${tagc}">${tag}</span></td>
    <td class="req-col-opt">${descCell(mo)}</td>
    <td class="req-col-opt">${docCell(mo)}</td>
    <td>${ver ? `${esc(ver.name)}<span class="req-sub">${ver.date ? fmtD(F(ver.date)) : ''}</span>` : '<span class="req-muted">未加入版本</span>'}</td>
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

// 筛选条：所有控件都带 data-req-* 属性，交给 components/req-page.js 委托
function filterBar(filter, versions, total, shown) {
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
    ${filterBar(filter, versions, all.length, hit.length)}`;

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
    const on = sort.key === key ? ' on' : '';
    const arrow = sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th data-req-sort="${key}" class="${(cls + on).trim()}">${label}${arrow}</th>`;
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

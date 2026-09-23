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
import { PCOL, PNAME } from '../core/default-data.js';
import { moduleTag, currentPhase, computeModulePer, progressDeviation, findGateMs } from '../core/mod-tag.js';
import { versionOfMod, versionStatus, modLate, findGoMs } from '../core/versions.js';
import { filterMods, sortMods } from '../core/mod-query.js';
import { modStats, renderModDetailRows } from './mod-card.js';
import { priorityBadge, lifecycleBadge } from './badge.js';

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
// 台账「上线情况」列的措辞只讲上线维度，不复述需求状态。
// 原因：versionStatus 用的是版本口径，其中「进行中」（版本有成员已开工）和
// 「已逾期」（版本过了上线日没发）会与左边「状态」列的 moduleTag 撞词 ——
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
    return { text: '待排期', color: '#94a3b8', plan: null, actual: null, late: null };
  }
  if (!v) {
    return { text: '未加入版本', color: '#94a3b8', plan: planFromMs, actual: null, late: null };
  }
  const st = versionStatus(v, state, today);
  return {
    text: SHIP_TEXT[st.key] || st.text, color: st.color,
    plan: v.date || planFromMs,
    actual: v.shipped ? v.shippedAt : null,
    // 已上线的版本不再有"赶不上"风险 —— 都已经发布完了，再报风险只会误导读者
    // （modLate 只看"最晚完成日是否晚于版本日"，不看版本是否已发货）
    late: v.shipped ? null : modLate(v, mo)
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

function shipCell(ship) {
  const parts = [`<span class="tag" style="background:${ship.color}">${ship.text}</span>`];
  // plan / actual 是 "YYYY-MM-DD" 字符串 → 需要 F() 转 Date
  if (ship.plan) parts.push(`<span class="req-sub">计划 ${fmtD(F(ship.plan))}</span>`);
  if (ship.actual) parts.push(`<span class="req-sub">实际 ${fmtD(F(ship.actual))}</span>`);
  // ⚠️ ship.late.end 则**已经是 Date**（core/versions.js 的 modLatestEnd 返回 Date），
  // 不能再包 F()：F 按 "YYYY-MM-DD" 切字符串，传 Date 会得到 Invalid Date → 渲染成 "NaN/NaN"
  if (ship.late) parts.push(`<span class="req-late" title="按当前排期算，最晚 ${fmtD(ship.late.end)} 才完成">赶不上 · 晚 ${ship.late.days} 天</span>`);
  return parts.join(' ');
}

function rowHtml(mo, ctx) {
  const { today } = ctx;
  const { tag, tagc } = moduleTag(mo, today);
  const ship = shipInfo(mo, ctx);
  const ver = versionOfMod(ctx.state, mo.name);
  const rng = mo.unscheduled ? null : ctx.modRange(mo);
  const st = modStats(mo.bars, ctx);
  // 偏差与总览卡片 / 排期总览同口径（EV − PV），判定集中在 core/mod-tag.js 的 progressDeviation
  // （含"已完成不报偏差"这条，三处必须一致）。
  // 两类需求不参与健康度评判：
  //   · 待排期：没有排期区间（rng 为空），日期本身不可信，无从判偏差
  //   · 已归档：留档查阅用，「延后 40%」这种行动导向的提醒对它已无意义。
  //     但进度条不能留着红——红了却不写原因只会更困惑，故转中性色。
  //     已完成的需求例外，仍走绿：100% 是既成事实，与是否归档无关。
  const dev = progressDeviation(mo.bars, st);
  const archQuiet = !!mo.archived && !dev.finished;
  const stCls = !rng ? '' : (archQuiet ? 'archived' : dev.key);
  const deviTxt = (rng && !mo.archived) ? dev.label : '';
  const archFlag = mo.archived ? '<span class="req-badge-arch">已归档</span>' : '';

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
      <span class="req-pbar"><i class="${stCls}" style="width:${Math.min(100, st.pct)}%"></i></span>
      <span class="req-sub">${st.pct.toFixed(0)}% · ${st.done.toFixed(1)}/${st.work} 人日</span>
      ${deviTxt ? `<span class="req-devi ${stCls}" title="实际完成度 ${st.pct.toFixed(1)}% − 计划应达 ${st.planPct.toFixed(1)}%（PV 按各任务的计划窗口算）">${deviTxt}</span>` : ''}
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

  return `<tr class="req-detail-tr"><td colspan="12">
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

  const th = (key, label, cls = '', title = '') => {
    const on = sort.key === key ? ' on' : '';
    const arrow = sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th data-req-sort="${key}" class="${(cls + on).trim()}"${title ? ` title="${esc(title)}"` : ''}>${label}${arrow}</th>`;
  };

  // 展开档案紧跟在被点开的那一行之后（同一 tbody 内的 detail 行）
  const rows = hit.map(mo => rowHtml(mo, ctx) + (reqExpanded.has(mo.name) ? detailHtml(mo, ctx) : '')).join('');

  return `<div class="report-wrap req-wrap">
    ${head}
      <div class="req-scroll">
        <table class="req-table">
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
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  </div>`;
}

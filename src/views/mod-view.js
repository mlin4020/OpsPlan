// ============================================================
// src/views/mod-view.js — 需求视图渲染（需求折叠 + 阶段任务条 + 里程碑）
// 由 gantt-app.js 迁移：
//   renderModView + barHtml + bands + msLabel + MODE_ICO
// 纯渲染：返回 HTML 字符串，不绑定事件；conflictSet 用于冲突条高亮
// 依赖注入：全部经 ctx 读取（state/sched/workday/holidays/X/dayW 等），不读 window 全局
// bands/barHtml 导出供 res-view 复用（资源泳道）
// ============================================================
import { F, fmtD } from '../core/dates.js';
import { PCOL, PNAME } from '../core/default-data.js';
import { moduleTag, computeModulePer, milestoneName } from '../core/mod-tag.js';
import { isOverdueTask } from '../core/task-status.js';
import { versionOfMod } from '../core/versions.js';
import { priorityBadge, versionBadge } from './badge.js';

// 计划模式图标：手动=锁定，自动=循环重算
const MODE_ICO = {
  manual: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>',
  auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.6 6.3"></path><path d="M20 4v6h-6"></path></svg>'
};

// 里程碑图上标签：显示「名字 + 日期」；名字已含日期（如 "9/9 上线"）则不重复追加
// name 由调用方经 milestoneName() 解析后传入（已去掉需求名前缀/无意义通用词）
export const msLabel = (b, name) => {
  const label = name || b.label || '里程碑';
  return /\d{1,2}\/\d{1,2}/.test(label) ? label : `${label} ${fmtD(F(b.m))}`;
};

// 假期带 & 今天线（ctx.holidays 替代 window.HOLIDAYS，ctx.today 替代 window.TODAY）
export function bands(ctx) {
  const { X, holidays, dayW, today } = ctx;
  let h = '<div class="bands">';
  (holidays || []).forEach(hol => {
    const x = X(hol.s), w = X(hol.e) - x + dayW;
    h += `<div class="hol-band" style="left:${x}px;width:${w}px"></div>`;
    if (dayW > 20) h += `<div class="hol-tag" style="left:${x + w / 2}px">${hol.n}</div>`;
  });
  const tx = X(today);
  h += `<div class="today-line" style="left:${tx}px"></div></div>`;
  return h;
}

// 资源姓名 → 标识色（与工作组规划器里头像的底色同源）。
// 按 resources 数组本身缓存 Map，避免一百多条任务各自重建一遍。
let _resColorSrc = null, _resColorMap = null;
function resColorOf(state, name) {
  const list = (state && state.resources) || [];
  if (_resColorSrc !== list || !_resColorMap) {
    const m = new Map();
    list.forEach(r => { if (r && r.name) m.set(r.name, r.color); });
    _resColorSrc = list; _resColorMap = m;
  }
  return _resColorMap.get(name) || '#94a3b8';
}

// 任务条 HTML（含手动/自动图标、资源标签、冲突高亮）
// compact=true（资源泳道视图）：条内始终小字显示「需求 · 阶段」，不再显示资源小标签
// laneTop（可选，百分比）：资源泳道内多任务重叠时按泳道上下错开显示
export function barHtml(ctx, b, mo, conflictSet, compact, laneTop, dim) {
  const { X, workday, today, dayW } = ctx;
  const x = X(F(b.s)), w = X(F(b.e)) - x + dayW;
  // 需求识别色：任务条主色直接用所属需求色 —— 同一需求的任务不分阶段、不论落在谁的泳道里都同色，
  // 这才是「一眼归组」最直接的做法。取不到需求色时兜底回阶段色，避免条变透明（需求名异常等边界）。
  const modColor = (ctx.modColors && ctx.modColors[mo.name]) || '';
  const c = modColor || PCOL[b.p];
  const topStyle = (typeof laneTop === 'number') ? `top:${laneTop}%` : '';
  const span = (b.s && b.e) ? workday.spanDays(b.s, b.e) : 0;
  const work = (b.s && b.e) ? workday.workDays(b.s, b.e) : 0;
  const dur = span ? span + 'd' : '';
  const workTag = (work && work !== span) ? ' 工' + work : '';
  const shownName = b.name || PNAME[b.p] || '任务';
  let shown = '';
  const pctDone = b.done || 0;
  const isFull = pctDone >= 100;
  if (compact) {
    shown = `${mo.name} · ${shownName}${dur ? ' ' + dur : ''}${workTag}`;
  } else if (w >= 110) shown = (isFull ? '✓ ' : (pctDone > 0 ? pctDone + '% ' : '')) + shownName + (dur ? ' ' + dur : '') + workTag;
  else if (w >= 26 && dur) shown = dur + workTag + (pctDone > 0 && !isFull ? ' ' + pctDone + '%' : '');
  else if (isFull) shown = '✓';
  else if (pctDone > 0) shown = pctDone + '%';
  const tags = [];
  const mode = b.manual ? 'manual' : 'auto';
  tags.push(`<span class="mode-ico ${mode}" title="${mode === 'manual' ? '手动计划（日期锁定）' : '自动计划（依赖+资源自动计算）'}">${MODE_ICO[mode]}</span>`);
  // 负责人标签：每人前面配一个与其头像同色的圆点 —— 颜色是在规划器里认人的依据，
  // 带回甘特图后，"这条任务是谁的"就能跨视图对上号，而不必逐字读姓名。
  // 悬停再给出完整名单（title），应付姓名被截断或人多的情形。
  if (!compact && b.res && b.res.length && w >= 40) {
    const names = b.res.join('、');
    const dots = b.res.map(n => `<i style="background:${resColorOf(ctx.state, n)}"></i>`).join('');
    tags.push(`<span class="res-chip" title="负责人：${names}">${dots}<span class="res-chip-txt">${names}</span></span>`);
  }
  const isOverdue = isOverdueTask(b, today);
  const cls = ['bar', isFull ? 'done' : '', conflictSet.has(b.id) ? 'conflict' : '', isOverdue ? 'overdue' : '', dim ? 'archived' : ''].filter(Boolean).join(' ');
  const tName = `${mo.name} · ${shownName}`;
  const tDesc = `${b.s} ~ ${b.e}` +
    ` · 进度 ${pctDone}%` +
    ` · 时间周期 ${span}天` +
    ` · 工作量 ${work}个工作日` +
    (b.res && b.res.length ? ` · 资源 ${b.res.join('、')}` : ' · 未分配资源') +
    (b.manual ? ' · 手动计划(锁定)' : ' · 自动计划') +
    (b.dep && b.dep.length ? ` · 前置 ${b.dep.length} 项` : '') +
    (isOverdue ? ' · ⚠ 已逾期！' : '') +
    (dim ? ' · 已归档需求' : '');
  const compactCls = compact ? ' compact' : '';
  const progressFill = isFull ? '' : `<span class="bar-progress" style="width:${pctDone}%"></span>`;
  // --mod-c 仍要挂：主色已等于需求色，该变量留给悬浮联动描边（.bar.mod-mate）用；
  // data-mod 供悬浮联动按需求跨泳道高亮（工作组规划器同需求任务分散在不同人的泳道里）
  const modVar = modColor ? `;--mod-c:${modColor}` : '';
  return `<div class="${cls}${compactCls}" data-task-id="${b.id}" data-mod="${mo.name}" style="left:${x}px;width:${w}px;background:${c};${topStyle}${modVar}"
    data-t="${tName}" data-d="${tDesc}">${progressFill}<span class="btxt">${shown}</span>${tags.join('')}
    <span class="bar-resize l" title="拖拽调整工作量（持续天数）"></span>
    <span class="bar-resize r" title="拖拽调整工作量（持续天数）"></span></div>`;
}

// 归档区（只读）：标题行 + 展开后的归档需求行
// 归档需求不参与上方排期展示，此处仅汇总展示名称/周期/完成情况，并提供「取消归档」入口。
//
// 为什么甘特图这一份要保留（而总览的那份已移除）：
//   这套行把归档需求画在**时间轴**上 —— .fold-bar 占位 + 里程碑菱形，
//   能直接看出它当时排在哪一段；这是独立归档页的卡片给不了的信息。
//   总览底部那份只是把同一批卡片再列一遍，与归档页完全重复，故删掉。
function renderArchiveSection(archived, ctx) {
  if (!archived.length) return '';
  const { state, today, dayW, X, fmtD, modRange, archOpen } = ctx;
  const open = !!archOpen;
  let html = `<div class="row mod-arch-head" data-arch-head="1">
      <div class="mname"><span class="tag" style="background:#94a3b8">归档</span>已归档需求
        <span class="range">${archived.length} 个 · 只读</span>
        <span class="arr" style="transform:${open ? 'rotate(0)' : 'rotate(-90deg)'}">▼</span>
      </div>
      <div class="track"><span class="arch-hint">已归档需求不再参与排期展示，可取消归档恢复</span></div>
    </div>`;
  if (!open) return html;
  archived.forEach(mo => {
    const rng = modRange(mo);
    const rngTxt = rng ? `${fmtD(rng.start)} - ${fmtD(rng.end)}` : '暂无任务';
    const { tag: autoTag, tagc: autoTagc } = moduleTag(mo, today);
    const autoPer = computeModulePer(mo.bars || [], state.resources);
    const tasks = (mo.bars || []).filter(b => !b.m);
    const doneN = tasks.filter(b => (b.done || 0) >= 100).length;
    const statTxt = tasks.length ? `${doneN}/${tasks.length} 项完成` : '无任务';
    const mc = (ctx.modColors && ctx.modColors[mo.name]) || mo.tagc || '';
    html += `<div class="row mod-arch-row" data-arch-mod="${mo.name}">
      <div class="mname">${mc ? `<span class="mod-dot" style="background:${mc}" title="需求标识色"></span>` : ''}<span class="mname-main"><span class="mname-txt" title="${mo.name}">${mo.name}</span><span class="mname-sub">${priorityBadge(mo.pri)}<span class="tag" style="background:${autoTagc}">${autoTag}</span><span class="range">${rngTxt}</span><span class="per">${autoPer || statTxt}</span></span></span>
      </div>
      <span class="arch-unbtn" data-unarchive="${mo.name}" title="取消归档（恢复到排期视图）">↩</span>
      <div class="track">${bands(ctx)}`;
    if (rng) {
      const x = X(rng.start), w = X(rng.end) - x + dayW;
      html += `<div class="fold-bar" title="${mo.name} ${rngTxt}" style="left:${x}px;width:${w}px">
          <div class="fold-done" style="background:${mc || mo.tagc};width:${w}px"></div></div>`;
    }
    (mo.bars || []).forEach(b => {
      if (!b.m) return;
      const mx = X(F(b.m));
      const mn = msLabel(b, milestoneName(b, mo.name));
      html += `<div class="mile mini" style="left:${mx}px;background:${mc || PCOL[b.p] || PCOL.go}"
        title="${mo.name} · ${mn}" data-t="${mo.name} · ${mn}" data-d="${b.m}"></div>`;
    });
    html += '</div></div>';
  });
  return html;
}

// 需求视图（现有结构 + 增强）
export function renderModView(container, ctx, conflictSet) {
  const { state, collapsed, today, dayW, X, fmtD, modRange } = ctx;
  const all = state.modules || [];
  // 归档需求在此过滤掉，不让它们作为可编辑行出现在主视图；
  // 数据仍保留在 state.modules（导出/同步/撤销不丢数据），
  // 呈现有两条路径：本页底部的归档区（画在时间轴上）+ 独立「归档」页（卡片版）
  const modules = all.filter(m => !m.archived);
  const archived = all.filter(m => !!m.archived);
  let html = '';
  if (!modules.length) {
    html += `<div class="mod-empty" style="padding:40px;text-align:center;color:var(--muted);font-size:13px">
      暂无任务 · 点击工具栏「新增需求」开始规划
    </div>`;
  }
  modules.forEach(mo => {
    const isCol = collapsed[mo.name];
    const rng = modRange(mo);
    const rngTxt = rng ? `${fmtD(rng.start)} - ${fmtD(rng.end)}` : '暂无任务';
    const { tag: autoTag, tagc: autoTagc } = moduleTag(mo, today);
    const autoPer = computeModulePer(mo.bars || [], state.resources);
    const mc = (ctx.modColors && ctx.modColors[mo.name]) || mo.tagc || '';
    // 名称主体与次要信息（状态标签 / 周期 / 人员）分层包一层：
    // 桌面端两者同一行（与原版式一致），手机端名称独占一行完整显示，次要信息降到第二行，
    // 避免左列只有 108px 时需求名被截成「标保督导 ·」这样看不出所以然来。
    html += `<div class="row mod-row" data-mod="${mo.name}">
      <div class="mname">${mc ? `<span class="mod-dot" style="background:${mc}" title="需求标识色（与任务条左侧色条一致）"></span>` : ''}<span class="mname-main"><span class="mname-txt" title="${mo.name}">${mo.name}</span><span class="mname-sub">${priorityBadge(mo.pri)}${versionBadge(versionOfMod(state, mo.name))}<span class="tag" style="background:${autoTagc}">${autoTag}</span><span class="range">${rngTxt}</span><span class="per">${autoPer}</span></span></span><span class="arr" style="transform:${isCol ? 'rotate(-90deg)' : 'rotate(0)'}">▼</span>
      </div>
      <span class="mod-edit-btn" title="编辑需求">⚙</span>
      <div class="track">${bands(ctx)}`;
    if (rng) {
      const x = X(rng.start), w = X(rng.end) - x + dayW;
      const tx = X(today);
      const done = Math.max(0, Math.min(w, tx - x));
      html += `<div class="fold-bar" title="${mo.name} ${rngTxt}" style="left:${x}px;width:${w}px">
          <div class="fold-done" style="background:${mc || mo.tagc};width:${done}px"></div></div>`;
    }
    mo.bars.forEach(b => {
      if (!b.m) return;
      const mx = X(F(b.m));
      html += `<div class="mile mini" style="left:${mx}px;background:${mc || PCOL[b.p] || PCOL.go}"
        data-t="${mo.name} · ${msLabel(b, milestoneName(b, mo.name))}" data-d="${b.m}" data-task-id="${b.id}"></div>`;
    });
    if (isCol) {
      html += '</div></div>';
      return;
    }
    if (!mo.bars.length) html += '<div class="mod-empty">暂无任务 · 点击右上角「＋任务」添加</div>';
    html += '</div></div>';
    mo.bars.forEach(b => {
      if (b.m) {
        const mn = milestoneName(b, mo.name);
        const lbl = msLabel(b, mn);
        // 菱形标记随任务条改用需求色；左列 steel 仍保留阶段色，阶段维度不至于完全丢失
        const mcol = mc || PCOL[b.p] || PCOL.go;
        html += `<div class="row bar-row" data-mod="${mo.name}" data-task-id="${b.id}"><div class="mname">
          <span class="steel" style="background:${PCOL[b.p] || PCOL.go}"></span>
          <span class="mname-txt" title="${mo.name} · ${mn}">${mo.name} · ${mn}</span>${(b.dep && b.dep.length) ? `<span class="dep-hint" title="有 ${b.dep.length} 项前置依赖">前置${b.dep.length}</span>` : ''}
        </div><div class="track">${bands(ctx)}`;
        const x = X(F(b.m));
        html += `<div class="mile-label" style="left:${x}px">${lbl}</div>
          <div class="mile" style="left:${x}px;background:${mcol}"
            data-t="${mo.name} · ${lbl}" data-d="${b.m}" data-task-id="${b.id}"></div>`;
      } else {
        const tName = b.name || PNAME[b.p] || '任务';
        html += `<div class="row bar-row" data-mod="${mo.name}" data-task-id="${b.id}"><div class="mname">
          <span class="steel" style="background:${PCOL[b.p]}"></span>
          <span class="mname-txt" title="${tName}">${tName}</span>${b.done >= 100 ? ' <span style="color:#10b981;font-weight:800">✓</span>' : (b.done ? ` <span style="color:#10b981;font-weight:600">${b.done}%</span>` : '')}
        </div><div class="track">${bands(ctx)}`;
        html += barHtml(ctx, b, mo, conflictSet);
      }
      html += '</div></div>';
    });
  });
  // 归档区挂在最底部：不干扰正在排期的内容，同时保留"在时间轴上回看归档"的能力
  html += renderArchiveSection(archived, ctx);
  return html;
}

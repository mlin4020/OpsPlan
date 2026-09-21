// ============================================================
// src/views/index.js — 渲染视图层聚合
// 由 gantt-app.js render() 迁移其"渲染分发"部分（不含事件绑定，事件委托留给组件层 Task 4b）
// 职责：
//   1) 组装完整 ctx（X/width/fmtD/modRange/dayW/today/holidays/workday 等渲染辅助）
//   2) 计算冲突集合（依赖/重叠任务的 conflictSet，供 mod/res 视图高亮）
//   3) 顶部统计（动态人日/并行/逾期）写入
//   4) 视图分发：report/arch/work -> 整页文档类视图；mod/res -> renderHeader + renderModView/renderResView
//   5) 设置甘特容器宽度与 report-mode class
// 纯渲染：不绑定永久事件（tip/折叠/拖拽/详情等由组件层在 innerHTML 写入后委托处理）
// ============================================================
import { F, fmtD } from '../core/dates.js';
import { defaultHolidays } from '../core/default-data.js';
import { archivedModSet } from '../core/mod-tag.js';
import { isOverdueTask } from '../core/task-status.js';
import { resolveModuleColors } from '../core/mod-color.js';
import { renderHeader } from './header.js';
import { renderModView } from './mod-view.js';
import { renderReportView } from './report-view.js';
import { renderArchiveView } from './archive-view.js';
import { renderResView } from './res-view.js';
import { renderWorkView } from './work-view.js';

// 缩放倍率 -> 日宽像素（源 ZOOM_DAYW）
const ZOOM_DAYW = { day: 13, week: 15, month: 32 };
const PAD = 200;

// 需求时间范围（源 modRange）
// 注意：右边界取「最大结束日期」（含普通任务 e 与里程碑 m），而非最大开始日期——
// 否则需求泳道（fold-bar）会短于其下的阶段泳道，导致横轴错位。
const modRange = mo => {
  if (!mo.bars.length) return null;
  const starts = mo.bars.map(b => F(b.m || b.s));
  const ends = mo.bars.map(b => (b.e ? F(b.e) : F(b.m || b.s)));
  let start = starts[0], end = ends[0];
  for (const d of starts) if (d < start) start = d;
  for (const d of ends) if (d > end) end = d;
  return { start, end };
};

// 非工作日列底色：口径完全交给 workday（法定节假日 + 调休补班），不再按"周六周日"硬算。
//
// 为什么不能再用「7 天周期的 repeating-linear-gradient」：
//   调休补班的周六其实要上班（不该涂灰），法定假日可能落在周三（必须涂灰），
//   固定周期画不出这种日历，必然一边多涂一边漏涂。
//
// 做法：逐日问 isWorkday → 把连续的非工作日并成区间 → 每段生成一条 linear-gradient
// 叠进同一张 background-image。一年约 60 段，浏览器毫无压力，而且仍是**零额外 DOM**
// （几十行 × 十几周不会产生上千个格子）。
// 轨道坐标 0 = 项目开始日 start（与 X() 同口径），故区间像素 = 起止日序号 × 日宽。
const NW_FILL = 'rgba(100,116,139,.06)';
const NW_CLEAR = 'rgba(100,116,139,0)';
export function nonWorkdayBg(start, end, dayW, isWorkday) {
  if (!start || !end || !dayW || typeof isWorkday !== 'function') return 'none';
  const D = t => new Date(t.getFullYear(), t.getMonth(), t.getDate());
  const a0 = D(start), b0 = D(end);
  if (b0 < a0) return 'none';
  const segs = [];
  let cur = null;
  for (let d = a0; d <= b0; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    if (!isWorkday(d)) {
      if (cur) cur.e = d; else cur = { s: d, e: d };
    } else if (cur) { segs.push(cur); cur = null; }
  }
  if (cur) segs.push(cur);
  if (!segs.length) return 'none';
  const idx = d => Math.round((d - a0) / 864e5);
  return segs.map(s => {
    const l = idx(s.s) * dayW, r = (idx(s.e) + 1) * dayW;
    return `linear-gradient(90deg,${NW_CLEAR} ${l}px,${NW_FILL} ${l}px,${NW_FILL} ${r}px,${NW_CLEAR} ${r}px)`;
  }).join(',');
}

// 无 workday 可注入时的兜底口径（导出单文件等场景）：仅按周六周日
export const weekendOnly = d => d.getDay() !== 0 && d.getDay() !== 6;

// 组装完整渲染 ctx：各视图只读该 ctx，不接触 window 全局
// 导出供 main-gantt/diag 的 getCtx 复用，确保拖拽等交互拿到的 ctx 始终含 X/totalW
export function buildViewCtx(ctx) {
  const dayW = ctx.dayW || ZOOM_DAYW[ctx.zoom] || 13;
  // today 归一化到当天 00:00:00（午夜）：X() 按“整天数”计算像素偏移，
  // 若带时分秒（new Date() 默认含当前时刻），(today-start)/864e5 会得到 24.6 这样
  // 的小数，Math.round 后多进 1 天 → 今日红线落到明天左边界、fold-done 进度多算一天。
  // 归一化后与任务条 X(F(b.s)) 的口径一致，红线精确对齐今日左边界。
  const todayRaw = ctx.today || new Date();
  const today = new Date(todayRaw.getFullYear(), todayRaw.getMonth(), todayRaw.getDate());
  // 假期带：优先以节假日接口结果拼接（workday.dayInfo 同步读缓存），无接口数据时回退本地兜底带
  const start = ctx.state.start, end = ctx.state.end;
  let holidays = ctx.holidays || defaultHolidays();
  if (ctx.workday && ctx.workday.dayInfo && start && end) {
    const segs = [];
    let cur = null;
    const D = t => new Date(t.getFullYear(), t.getMonth(), t.getDate());
    for (let d = D(start); d <= D(end); d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      const info = ctx.workday.dayInfo(d);
      if (info && info.holiday) {
        if (!cur || cur.e.getTime() === d.getTime() - 864e5) cur = cur || {};
        if (!cur.s) cur = { s: d, e: d, n: info.name || '放假' };
        else { cur.e = d; if (info.name) cur.n = info.name; }
      } else if (cur) { segs.push(cur); cur = null; }
    }
    if (cur) segs.push(cur);
    // 接口缓存已就绪（能识别出假日）才用合成结果；否则保留兜底带
    if (segs.length) holidays = segs;
  }
  const X = d => Math.round((d - start) / 864e5) * dayW;
  const totalW = () => X(end) + dayW;
  return {
    ...ctx,
    dayW, today, holidays, PAD,
    // 非工作日列底色的渐变串（见 gantt.css 里 .gbody .track 的 background-image）：
    // 按 workday 口径逐日算，补班周末不涂、工作日放假照涂
    nonWorkdayBg: nonWorkdayBg(
      start, end, dayW,
      (ctx.workday && ctx.workday.isWorkday) || weekendOnly
    ),
    // 需求识别色（需求名 → 色值）：任务条左侧色条与同需求悬浮联动共用，
    // 在此统一解析，保证甘特图 / 工作组规划器 / 总览三处口径一致
    modColors: resolveModuleColors(ctx.state && ctx.state.modules),
    X, totalW, fmtD, modRange
  };
}

// 主渲染函数
export function renderAll(ctx) {
  const { state, sched, view, gantt, workday } = ctx;
  const full = buildViewCtx(ctx);

  // 滚动位置保持：重建 innerHTML 会把两个方向都重置，故在任何 DOM 变更前先快照。
  // 横向：调用方显式传入数字（缩放定位、切换视图等）时以其为准；否则沿用当前滚动位置，
  //       避免「删除任务 / 撤销 / 折叠」等无参重绘把视图拉回时间轴最左端。
  // 纵向：总览视图（卡片下钻展开）与甘特视图都需要保持，否则每次点击卡片都会被弹回顶部。
  const keepScroll = typeof ctx.scrollLeft === 'number'
    ? ctx.scrollLeft
    : (ctx.gsc ? ctx.gsc.scrollLeft : 0);
  const keepTop = ctx.gsc ? ctx.gsc.scrollTop : 0;

  const problems = sched.detectProblems();
  const conflictSet = new Set(
    problems.filter(p => p.type === 'overlap' || p.type === 'depend').map(p => p.taskId)
  );

  // 顶部统计（动态）：并行推进 / 总人日 / 逾期
  // 已归档需求的任务不计入统计（归档即视为已收口，不再占用「并行/逾期」口径）
  const arch = archivedModSet(state.modules);
  const all = (sched.tasks() || []).filter(t => !arch.has(t.mod));
  const totalWork = all.reduce((a, t) => a + (t.s && t.e ? workday.workDays(t.s, t.e) : 0), 0);
  const activeN = all.filter(t => !t.isMs && (!t.done || t.done < 100) && F(t.s) <= full.today && F(t.e) >= full.today).length;
  // 逾期：统一口径（排除里程碑/已完成/未到期/未分配资源；all 已排除归档需求）
  const overdueN = all.filter(t => isOverdueTask(t, full.today)).length;
  const setN = (id, n) => { const el = id ? (ctx.getEl ? ctx.getEl(id) : ctx[id]) : null; if (el) el.textContent = n; };
  setN('totalWork', totalWork);
  setN('statActive', activeN);
  setN('statOverdue', overdueN);
  const overdueWrap = ctx.getEl ? ctx.getEl('statOverdueWrap') : ctx.statOverdueWrap;
  if (overdueWrap) overdueWrap.style.display = overdueN > 0 ? '' : 'none';

  let html = '';
  if (view === 'report') {
    html += renderReportView(gantt, full);
    gantt.innerHTML = html;
    gantt.style.width = '100%';
    gantt.classList.add('report-mode');
    // 总览是纵向滚动的卡片流：下钻展开后必须回到原位置，否则每次都弹回顶部
    if (ctx.gsc) { ctx.gsc.scrollLeft = keepScroll; ctx.gsc.scrollTop = keepTop; }
    return;
  }
  // 归档需求 / 资源工作视图：独立页面，与总览同为"整页纵向文档"形态，
  // 故共用 report-mode（宽度 100% + 页面留白）与纵向滚动位置保持。
  // 归档页的重绘同样要保持纵向位置（展开卡片后不能弹回顶部），与总览一致。
  if (view === 'arch' || view === 'work') {
    gantt.innerHTML = view === 'arch' ? renderArchiveView(gantt, full) : renderWorkView(gantt, full);
    gantt.style.width = '100%';
    gantt.classList.add('report-mode');
    if (ctx.gsc) { ctx.gsc.scrollLeft = keepScroll; ctx.gsc.scrollTop = keepTop; }
    return;
  }
  gantt.classList.remove('report-mode');
  html = renderHeader(gantt, full) + '<div class="gbody">';
  html += (view === 'mod') ? renderModView(gantt, full, conflictSet) : renderResView(gantt, full, conflictSet);
  html += '</div>';
  gantt.innerHTML = html;
  gantt.style.width = (PAD + full.totalW()) + 'px';
  // 非工作日列底色：渐变串挂在甘特容器上，所有轨道的 background-image 共享同一份（缩放变化时重算）。
  // 判空：轻量 DOM 替身（测试）没有 CSSOM，不应因此中断渲染
  if (gantt.style && gantt.style.setProperty) {
    gantt.style.setProperty('--nowork-bg', full.nonWorkdayBg);
  }

  // 滚动位置保持（回填 DOM 变更前的快照）；gsc 由 ctx 注入，缺省不滚动
  if (ctx.gsc) { ctx.gsc.scrollLeft = keepScroll; ctx.gsc.scrollTop = keepTop; }
}

// 聚合导出：供组件层（Task 4b）与其他模块按需引用
export { renderHeader } from './header.js';
export { renderModView, barHtml, bands, msLabel } from './mod-view.js';
export { renderReportView, toggleReportExpanded, isReportExpanded } from './report-view.js';
export { renderArchiveView } from './archive-view.js';
export { renderResView } from './res-view.js';
export { renderWorkView } from './work-view.js';
export { PAD };

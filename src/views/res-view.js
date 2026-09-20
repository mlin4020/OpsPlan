// ============================================================
// src/views/res-view.js — 资源泳道视图渲染
// 由 gantt-app.js renderResView 迁移，改为读 ctx（不读 window 全局）
// 重叠任务自动分泳道上下错开显示（贪心按开始时间分配不冲突的泳道）
// 纯渲染：返回 HTML 字符串，不绑定事件；conflictSet 用于冲突条高亮
// ============================================================
import { F } from '../core/dates.js';
import { bands, barHtml } from './mod-view.js';
import { archivedModSet } from '../core/mod-auto.js';

export function renderResView(container, ctx, conflictSet) {
  const { state, sched } = ctx;
  let html = '';
  // 已归档需求：仍展示其任务（工作组规划器要能看到全量资源占用），但条置灰，
  // 避免把已收口的需求误当成仍在执行的工作。数据分支本身不参与排期编辑。
  const arch = archivedModSet(state.modules);
  const tasks = sched.tasks().filter(t => !t.isMs && t.res && t.res.length);
  state.resources.forEach(r => {
    const rTasks = tasks
      .filter(t => t.res.includes(r.name))
      .sort((a, b) => F(a.s) - F(b.s));
    const load = rTasks.length;
    // 泳道分配：每个泳道内任务互不重叠（后置开始 >= 泳道最后任务结束次日）
    const lanes = [];
    rTasks.forEach(t => {
      const s = F(t.s);
      let li = lanes.findIndex(g => F(g[g.length - 1].e) < s);
      if (li < 0) { lanes.push([]); li = lanes.length - 1; }
      lanes[li].push(t);
    });
    const laneN = Math.max(1, lanes.length);
    // 行高决定「人与人之间的上下距离」：单泳道也给足 52px（原来 38px），
    // 否则上下两个人的任务条只隔一条细线，一眼看不出哪条属于谁。
    // 多泳道按 28px/条递推，保证同一人内部相邻泳道也不贴在一起。
    const rowH = Math.max(52, laneN * 28);
    html += `<div class="row res-row" style="height:${rowH}px">
      <div class="mname"><span class="avatar" style="background:${r.color}">${r.name[0]}</span>
        <span class="mname-main"><span class="mname-txt res-name" title="${r.name}">${r.name}</span><span class="mname-sub"><span class="res-role">${r.role}</span><span class="res-load">${load} 项任务${laneN > 1 ? ' · ' + laneN + ' 泳道' : ''}</span></span></span></div>
      <div class="track">${bands(ctx)}`;
    lanes.forEach((group, li) => {
      const topPct = ((li + 0.5) / laneN) * 100;
      group.forEach(t => {
        const t2 = { ...t };
        html += barHtml(ctx, t2, { name: t.mod }, conflictSet, true, topPct, arch.has(t.mod));
      });
    });
    html += '</div></div>';
  });

  // 未分配任务泳道：无资源或资源为空的任务
  const unassigned = sched.tasks().filter(t => !t.isMs && (!t.res || !t.res.length))
    .sort((a, b) => F(a.s) - F(b.s));
  if (unassigned.length) {
    const laneN = 1;
    html += `<div class="row res-row unassigned" style="height:52px">
      <div class="mname" style="color:#94a3b8"><span class="avatar" style="background:#cbd5e1">?</span>
        <span class="mname-main"><span class="mname-txt res-name" style="color:#94a3b8;font-style:italic">未分配</span><span class="mname-sub"><span class="res-load">${unassigned.length} 项任务</span></span></span></div>
      <div class="track">${bands(ctx)}`;
    unassigned.forEach(t => {
      const t2 = { ...t };
      html += barHtml(ctx, t2, { name: t.mod }, conflictSet, true, 50, arch.has(t.mod));
    });
    html += '</div></div>';
  }

  return html;
}

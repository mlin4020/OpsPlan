// ============================================================
// src/scheduler/cycle.js — 项目周期自动推导
// 由手动周期（周期弹窗手动设置 start/end）改造为"根据任务日期动态变化"：
//   start = 所有任务最早开始日（含里程碑 m）
//   end   = 所有任务最晚结束日（含里程碑 m）
// 每当任一任务日期变更（save）或从服务器加载后自动重算，
// 表头 / X 坐标 / 总览随之动态收展到实际任务范围。
// 状态经 ctx 注入（getState/setState/tasks），无 DOM/window 依赖。
// ============================================================
import { F } from '../core/dates.js';
import { DEFAULT_START, DEFAULT_END } from '../core/constants.js';

export function createCycle(ctx) {
  const { getState, setState } = ctx;

  // 由当前全部任务推算项目周期；无可任务时回退默认窗口
  // 返回 { start: Date, end: Date }
  function compute() {
    const tasks = ctx.tasks || [];
    let min = null, max = null;
    tasks.forEach(t => {
      if (t.isMs) {
        if (!t.m) return;
        const m = F(t.m);
        if (!min || m < min) min = m;
        if (!max || m > max) max = m;
        return;
      }
      if (t.s) { const s = F(t.s); if (!min || s < min) min = s; }
      if (t.e) { const e = F(t.e); if (!max || e > max) max = e; }
    });
    if (!min || !max) return { start: DEFAULT_START, end: DEFAULT_END };
    return { start: min, end: max };
  }

  // 把推算结果写回 planStore（仅在与当前值不同时 set，避免无谓的重绘）
  function apply() {
    const { start, end } = compute();
    const st = getState();
    const same = st.start && st.end &&
      st.start.getTime() === start.getTime() &&
      st.end.getTime() === end.getTime();
    if (!same) setState({ start, end });
  }

  return { compute, apply };
}
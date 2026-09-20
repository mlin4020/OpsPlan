// ============================================================
// src/scheduler/problems.js — 排期问题扫描（纯计算，状态经 ctx 注入）
// 由 gantt-scheduler.js 602-659 行迁移
// 检测：依赖环(cycle) / 资源过载(overlap) / 依赖违反(depend) / 超期(overdue)
// ctx 提供 tasks/tasksById/nameOf/nextWorkday/getState 等共享依赖
// ============================================================
import { topoSort } from './topo.js';
import { F } from './planning.js';
import { fmt, addDays } from '../core/dates.js';

// 已完成（进度 100%）的任务视为已收口，不再参与排期问题检测与提示
// 里程碑无 done 字段（转里程碑时会清除），不会被误判
function isDone(t) {
  return !!t && (t.done || 0) >= 100;
}

export function detectProblems(ctx) {
  const probs = [];
  // 依赖环
  const dagIds = ctx.tasks.filter(t => (t.dep || []).length).map(t => t.id);
  if (dagIds.length) {
    const depFn = id => (ctx.tasksById[id].dep || []).map(d => d.id).filter(p => ctx.tasksById[p]);
    const { cycle } = topoSort(dagIds, depFn);
    cycle.forEach(id => {
      const t = ctx.tasksById[id];
      if (t) probs.push({ type: 'cycle', taskId: id, desc: `任务「${ctx.nameOf(t)}」处于依赖环中，无法自动计算排期` });
    });
  }
  // 资源过载（里程碑无资源、无周期，跳过）
  for (let i = 0; i < ctx.tasks.length; i++) {
    for (let j = i + 1; j < ctx.tasks.length; j++) {
      const a = ctx.tasks[i], b = ctx.tasks[j];
      // 里程碑无资源、无周期；已完成任务已释放资源占用，均跳过
      if (a.isMs || b.isMs || isDone(a) || isDone(b)) continue;
      const shared = (a.res || []).filter(r => (b.res || []).includes(r));
      if (!shared.length) continue;
      if (F(a.s) <= F(b.e) && F(a.e) >= F(b.s)) {
        probs.push({
          type: 'overlap', taskId: b.id, ref: a.id,
          desc: `「${ctx.nameOf(a)}」与「${ctx.nameOf(b)}」在 ${fmt(F(a.s)).slice(5)} ~ ${fmt(F(b.e)).slice(5)} 同时占用资源 ${shared.join('、')}`
        });
      }
    }
  }
  // 依赖违反（多为手动锁定 / 拖拽后导致的排期早于前置）
  ctx.tasks.forEach(t => (t.dep || []).forEach(d => {
    const p = ctx.tasksById[d.id];
    if (!p) return;
    const pEnd = p.isMs ? F(p.m) : F(p.e);
    // 依赖违反判定与 earliestDepStart 一致：普通任务前置=结束次日+lag；里程碑前置=同日+lag（0 天单点无 +1）
    const shift = (d.lag || 0) + (p.isMs ? 0 : 1);
    const earliest = ctx.nextWorkday(addDays(pEnd, shift));
    const tStart = t.isMs ? F(t.m) : F(t.s);
    if (tStart < earliest) {
      probs.push({
        type: 'depend', taskId: t.id, ref: d.id,
        desc: `「${ctx.nameOf(t)}」开始于 ${fmt(tStart).slice(5)}，早于前置「${ctx.nameOf(p)}」允许的最早开始（${fmt(earliest).slice(5)}）`
      });
    }
  }));
  // 超期（里程碑看 m，普通任务看 e）
  ctx.tasks.forEach(t => {
    const end = t.isMs ? F(t.m) : F(t.e);
    if (end > ctx.getState().end) {
      probs.push({ type: 'overdue', taskId: t.id, desc: `「${ctx.nameOf(t)}」结束日期 ${fmt(end).slice(5)} 超出项目周期` });
    }
  });
  // 过滤不需要提示的问题（依赖环 / 资源过载 / 依赖违反 / 超期 一律适用）：
  //   - 已忽略：用户手动标记过不再提示
  //   - 已完成：视为已收口
  //   - 未分配资源：还没排人负责的活儿不构成排期问题
  //     （里程碑没有"分配资源"这个概念，豁免）
  ctx.problems = probs.filter(p => {
    const t = ctx.tasksById[p.taskId];
    if (!t) return true;
    if (t.ignore) return false;
    if (isDone(t)) return false;
    if (!t.isMs && !(t.res && t.res.length)) return false;
    return true;
  });
  return ctx.problems;
}

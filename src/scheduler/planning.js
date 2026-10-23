// ============================================================
// src/scheduler/planning.js — 排期计算（纯计算，状态经 ctx 注入）
// 由 gantt-scheduler.js 迁移：
//   工作日历：isWorkday/nextWorkday
//   资源占用：addOcc/earliestFree/busyOnWorkdays/earliestDepStart
//   级联重算：recomputeAffected/collectAffected
//   对外操作：computeSchedule/cascade/resolveAuto/resolveIgnore/unignore
//   实时预览：previewCascade/previewResize
// 依赖：topo.js、core/dates.js；ctx 提供 getState/setState/W 与共享索引 tasks/tasksById
// ============================================================
import { topoSort } from './topo.js';
import { F as baseF, fmt, addDays } from '../core/dates.js';
import { userStore } from '../store/user-store.js';
import { ctxOf, canTouchTask } from '../utils/permission.js';

// 兼容 Date 输入的日期解析（与源 gantt-scheduler.js 的 F 一致：Date 直接克隆，字符串按 YYYY-MM-DD 解析）
// 源 F 支持 Date，而 core/dates.js 的 F 仅支持字符串，故在此薄封装补齐 Date 分支
export function F(s) {
  if (s instanceof Date) return new Date(s.getFullYear(), s.getMonth(), s.getDate());
  return baseF(s);
}

export function createPlanning(ctx) {
  const { getState, W } = ctx;

  // ---------- 工作日历 ----------
  // 排期仅在"工作日"（周一~周五 且 非假期）上安排；具体口径由注入的 W 决定（等价 window.WORKDAY）
  function isWorkday(d) { return W.isWorkday(d); }

  // 返回 >= d 的最近工作日
  function nextWorkday(d) {
    let day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    while (!isWorkday(day)) day = addDays(day, 1);
    return day;
  }

  // ---------- 资源占用 ----------
  function addOcc(occ, res, s, e) {
    if (!res) return;
    if (!occ[res]) occ[res] = [];
    occ[res].push({ s, e });
  }

  // 区间 [s,e] 内任一工作日，只要有一个资源被占用即视为忙（周末/节假日不计资源占用）
  function busyOnWorkdays(occ, resNames, s, e) {
    let d = F(s);
    const end = F(e);
    while (d <= end) {
      if (isWorkday(d)) {
        const t = d.getTime();
        const busy = resNames.some(r =>
          (occ[r] || []).some(iv => iv.s.getTime() <= t && iv.e.getTime() >= t)
        );
        if (busy) return true;
      }
      d = addDays(d, 1);
    }
    return false;
  }

  // 从 from 起找 resNames 全部空闲的 workDays 个工作日起点（起点与顺延均只落在工作日）。
  // 时间周期 = 起点起第 workDays 个工作日对应的日历结束日（周末/节假日自动顺延）
  function earliestFree(occ, resNames, from, workDays) {
    let day = nextWorkday(new Date(Math.max(from, getState().start)));
    for (let g = 0; g < 1000; g++) {
      const end = W.spanEndByWorkdays(day, workDays);
      if (!busyOnWorkdays(occ, resNames, day, end)) return day;
      day = nextWorkday(addDays(day, 1));
    }
    return day;
  }

  // 任务最早可开始：max(各前置可开始时间 + lag)，并落到工作日
  // FS 语义：普通任务前置在 end 日全天工作，后置最早从 end+1 日才可开始（避免与前置重合一天）；
  //          里程碑前置是 0 天单点（无"全天工作"概念），后置可与里程碑同一天开始（不加 +1）
  function earliestDepStart(t) {
    let from = getState().start;
    (t.dep || []).forEach(d => {
      const p = ctx.tasksById[d.id];
      if (!p) return;
      const end = p.isMs ? F(p.m) : F(p.e);
      const shift = (d.lag || 0) + (p.isMs ? 0 : 1);
      const v = nextWorkday(addDays(end, shift));
      if (v > from) from = v;
    });
    return nextWorkday(from);
  }

  // ---------- 级联重算 ----------
  // 对 affected 集合内的任务按依赖+资源重排（"尽量靠前"语义）：
  //   手动任务 / 无依赖自动任务 / 依赖环上任务 → 保持当前日期(锚点)并占用资源
  //   有依赖自动任务 → 重新放置到「依赖允许最早开始 ∩ 资源可用」的最早工作日，
  //                    既能因依赖/资源变化向后顺延，也能在前置提前、资源空出时自动前移
  function recomputeAffected(affected) {
    const occ = {};
    // 1. affected 之外的任务按当前日期占用（不受影响）；里程碑无资源占用
    ctx.tasks.forEach(t => {
      if (!affected.has(t.id) && !t.isMs) (t.res || []).forEach(r => addOcc(occ, r, F(t.s), F(t.e)));
    });
    // 2. affected 内拓扑序处理
    const sub = [...affected];
    const depFn = id => (ctx.tasksById[id].dep || []).map(d => d.id).filter(p => affected.has(p));
    const { order, cycle } = topoSort(sub, depFn);
    ctx.cycleTasks = cycle.map(id => ctx.tasksById[id]).filter(Boolean);
    for (const id of order) {
      const t = ctx.tasksById[id];
      if (!t) continue;
      if (t.isMs) {
        // 里程碑：手动 / 无依赖 / 环上 → 保持现状；自动且有依赖 → 上线日 = 依赖允许的最早工作日
        if (cycle.includes(id) || t.manual || !(t.dep || []).length) continue;
        t.m = fmt(earliestDepStart(t));
        continue;
      }
      if (cycle.includes(id) || t.manual || (t.dep || []).length === 0) {
        // 环上/手动/无依赖：保持现状
        (t.res || []).forEach(r => addOcc(occ, r, F(t.s), F(t.e)));
        continue;
      }
      const work = W.workDays(t.s, t.e);   // 工作量（工作日）为任务固有属性，排期不改变
      const from = earliestDepStart(t);
      // 自动任务：统一重排到依赖允许且资源空闲的最早工作日（可前移也可后移）；
      // 时间周期 = 覆盖同等工作量的日历跨度（周末/节假日自动顺延）
      const start = earliestFree(occ, t.res || [], from, work);
      t.e = fmt(W.spanEndByWorkdays(start, work));
      t.s = fmt(start);
      if (typeof t.w === 'number') t.w = work;   // 工作量（人天）
      (t.res || []).forEach(r => addOcc(occ, r, F(t.s), F(t.e)));
    }
  }

  // 需求名 → 需求对象（里程碑判定需要知道它属于哪个需求）
  function modByName(name) {
    return (getState().modules || []).find(m => m.name === name) || null;
  }

  // pred→succ 映射（多级递归用）。所有任务的依赖都登记，两者共用同一份构建口径
  function buildSuccIndex() {
    const succ = {};
    ctx.tasks.forEach(t => (t.dep || []).forEach(d => {
      if (!ctx.tasksById[d.id]) return;
      (succ[d.id] = succ[d.id] || []).push(t.id);
    }));
    return succ;
  }

  // 只有"协作者"才断链：
  //   全权用户 → 完整级联（行为与改造前逐字节相同）
  //   只读用户 → 操作在第一道守卫就被拦下，到不了这里
  //   access 未显式给出时 ctxOf 返回 full → Task 9 之前本函数恒为 false，零行为变化
  function isCollabMode() { return ctxOf(userStore.state).access === 'collab'; }

  // 唯一入口：从 anchorId 出发沿"后置边"(pred→succ) 可达的受影响集合（含自身）。
  // 安全判定放在这里而不是散在各调用点 —— 调用方无从绕过（与 Task 7 的 default→最严 同一思路）：
  //   全权 → 全量 BFS，pinned 恒为 []
  //   协作者 → 断链 BFS：遇到"我无权编辑"的任务就钉成手动并停止该分支，不重排它也不继续下探。
  //            为什么断链就够：被钉住的节点日期没变 → 它下游的依赖输入也没变 → 下游没有变动的理由。
  //            钉住是唯一被特许的跨人写入（设计文档 §6.4 特许①），服务端会校验它确实被级联影响到。
  //   dryRun：预览用，只收集 pinned 不写 manual（预览绝不能有副作用）
  function collectAffected(anchorId, opts) {
    const dry = !!(opts && opts.dryRun);
    if (!isCollabMode()) {
      // 全权：原全量 BFS。多算了 opts 也不管，行为与改造前逐字节相同
      const succ = buildSuccIndex();
      const affected = new Set([anchorId]);
      const stack = [anchorId];
      while (stack.length) {
        const id = stack.pop();
        (succ[id] || []).forEach(n => {
          if (!affected.has(n)) { affected.add(n); stack.push(n); }
        });
      }
      return { affected, pinned: [] };
    }
    const succ = buildSuccIndex();
    const c = ctxOf(userStore.state);
    const affected = new Set([anchorId]);
    const pinned = [];
    const stack = [anchorId];
    while (stack.length) {
      const id = stack.pop();
      (succ[id] || []).forEach(n => {
        if (affected.has(n)) return;
        const t = ctx.tasksById[n];
        if (!t) return;
        if (!canTouchTask(t, modByName(t.mod), c)) {
          // 只统计"真的从自动被改成手动"的节点：本来就是 manual 的没有"被钉住"这回事，
          // 计入会让界面提示成"已钉住 N 条"里掺虚数（它一直都锁着，本次没有新增跨人写入）。
          // 预览（dry）照记，但不写 manual —— 预览绝不能有副作用。
          if (!t.manual) {
            if (!dry) t.manual = true;
            if (!pinned.includes(n)) pinned.push(n);
          }
          return;                                   // 断链：不加入 affected、不继续下探
        }
        affected.add(n);
        stack.push(n);
      });
    }
    return { affected, pinned };
  }

  // ---------- 对外操作 ----------
  // 一键自动计划：全量重排所有自动任务
  function computeSchedule() {
    if (!ctx.assertEditable(false, { kind: 'plan' })) return;
    const affected = new Set(ctx.tasks.filter(t => !t.manual).map(t => t.id));
    recomputeAffected(affected);
    ctx.save();
  }

  // 拖拽落位：锁定手动日期并级联重算后置子图。
  // 关键语义：工作量（工作日数）恒定，时间周期（日历天数）随新位置含有的周末/节假日自动伸缩。
  function cascade(anchorId, newStart) {
    const t = ctx.getTask(anchorId);
    if (!t || t.isMs) return { pinned: [] };
    if (!ctx.assertEditable(false, { kind: 'task', task: t })) return { pinned: [] };
    t.manual = true;
    const work = W.workDays(t.s, t.e);                       // 拖动前的工作量
    const startD = F(newStart);                              // 兼容 Date 与 'YYYY-MM-DD'
    t.s = fmt(startD);
    t.e = fmt(W.spanEndByWorkdays(startD, work));            // 结束 = 起点起第 work 个工作日
    if (typeof t.w === 'number') t.w = work;                 // 工作量（人天）同步持久化
    const { affected, pinned } = collectAffected(anchorId);
    recomputeAffected(affected);
    ctx.save();
    return { pinned };
  }

  // 自动调整至资源可用的时间：解除锁定并重排该任务及其后置子图
  function resolveAuto(taskId) {
    const t = ctx.getTask(taskId);
    if (!t) return { pinned: [] };
    if (!ctx.assertEditable(false, { kind: 'task', task: t })) return { pinned: [] };
    t.manual = false;
    t.ignore = false;
    const { affected, pinned } = collectAffected(taskId);
    recomputeAffected(affected);
    ctx.save();
    return { pinned };
  }

  // 忽略：保留现状并淡化标记
  function resolveIgnore(taskId) {
    if (!ctx.assertEditable(false, { kind: 'task', task: ctx.getTask(taskId) })) return;
    const t = ctx.getTask(taskId);
    if (!t) return;
    t.ignore = true;
    ctx.save();
  }

  // 撤销忽略
  function unignore(taskId) {
    if (!ctx.assertEditable(false, { kind: 'task', task: ctx.getTask(taskId) })) return;
    const t = ctx.getTask(taskId);
    if (t) { t.ignore = false; ctx.save(); }
  }

  // 拖拽实时预览：模拟把 anchor 移到 newStart，返回受影响(日期变化)的任务 id 集合，不改动真实数据
  // 与 cascade 同语义：工作量（工作日）恒定，时间周期随周末/节假日自动伸缩
  function previewCascade(anchorId, newStart) {
    const t = ctx.getTask(anchorId);
    if (!t || t.isMs) return new Set();
    // 预览必须与落位用同一条影响集合，否则会出现"预览在这、松手跑到那"；
    // dryRun：只收集 pinned，绝不写 manual（预览不能有副作用）
    const { affected } = collectAffected(anchorId, { dryRun: true });
    const backup = {};
    affected.forEach(id => {
      const tt = ctx.tasksById[id];
      backup[id] = tt ? { s: tt.s, e: tt.e, m: tt.m, manual: tt.manual, w: tt.w } : null;
    });
    const work = W.workDays(t.s, t.e);
    const wasManual = t.manual;
    t.manual = true;
    const startD = F(newStart);   // 兼容 Date 与 'YYYY-MM-DD'
    t.s = fmt(startD);
    t.e = fmt(W.spanEndByWorkdays(startD, work));
    recomputeAffected(affected);
    const shifted = new Set();
    affected.forEach(id => {
      const tt = ctx.tasksById[id];
      if (tt && backup[id] && (tt.s !== backup[id].s || tt.e !== backup[id].e || tt.m !== backup[id].m)) shifted.add(id);
    });
    // 恢复现场（里程碑含 m，一并回滚；w 同步回滚避免预览泄漏）
    affected.forEach(id => {
      const b = backup[id];
      if (b && ctx.tasksById[id]) {
        ctx.tasksById[id].s = b.s;
        ctx.tasksById[id].e = b.e;
        ctx.tasksById[id].m = b.m;
        ctx.tasksById[id].manual = b.manual;
        ctx.tasksById[id].w = b.w;
      }
    });
    return shifted;
  }

  // 拖拽调整工作量实时预览：模拟调整边缘，返回受影响(日期变化)的任务 id 集合，不改动真实数据
  function previewResize(taskId, edge, date) {
    const t = ctx.getTask(taskId);
    if (!t || t.isMs) return new Set();
    const nd = F(date);
    if ((edge === 'l' && nd > F(t.e)) || (edge === 'r' && nd < F(t.s))) return new Set();
    // 同 previewCascade：与落位共用影响集合，且不得写 manual
    const { affected } = collectAffected(taskId, { dryRun: true });
    const backup = {};
    affected.forEach(id => {
      const tt = ctx.tasksById[id];
      backup[id] = tt ? { s: tt.s, e: tt.e, m: tt.m, manual: tt.manual, w: tt.w } : null;
    });
    if (edge === 'l') t.s = fmt(nd); else t.e = fmt(nd);
    t.manual = true;
    recomputeAffected(affected);
    const shifted = new Set();
    affected.forEach(id => {
      const tt = ctx.tasksById[id];
      if (tt && backup[id] && (tt.s !== backup[id].s || tt.e !== backup[id].e || tt.m !== backup[id].m)) shifted.add(id);
    });
    affected.forEach(id => {
      const b = backup[id];
      if (b && ctx.tasksById[id]) {
        ctx.tasksById[id].s = b.s;
        ctx.tasksById[id].e = b.e;
        ctx.tasksById[id].m = b.m;
        ctx.tasksById[id].manual = b.manual;
        ctx.tasksById[id].w = b.w;
      }
    });
    return shifted;
  }

  // 回填 ctx，供其他模块（mutations/problems/index）复用
  ctx.isWorkday = isWorkday;
  ctx.nextWorkday = nextWorkday;
  ctx.recomputeAffected = recomputeAffected;
  ctx.collectAffected = collectAffected;

  return {
    isWorkday, nextWorkday,
    recomputeAffected, collectAffected,
    computeSchedule, cascade,
    resolveAuto, resolveIgnore, unignore,
    previewCascade, previewResize
  };
}

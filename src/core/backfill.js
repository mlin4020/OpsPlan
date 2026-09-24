// ============================================================
// src/core/backfill.js — 历史需求元信息的一次性回填
//
// 背景：`proposedBy` / `proposedAt` / `lifecycle` 三个字段是后加的，
// 历史数据里全为空。三个字段在台账主行各占一席，空着会让整列没信息量。
//
// ⚠️ 与设计文档 §2.1 的关系：
//   那里否决的是「**长期自动推导**生命周期」（每次渲染都推，会和人工维护的
//   值抢语义）。本文件是**一次性回填**：算出来的值直接写成人工可编辑的静态
//   字段，之后与手工填的完全等价，不存在两套来源。
//   三个字段一律**只补缺失、不覆盖已有值**，因此重复执行是幂等的。
//
// 只做纯计算（给定 modules 返回要写的 patch），应用与落盘交给调用方，
// 这样可以脱离浏览器单测。
// ============================================================
import { F } from './dates.js';
import { findGateMs } from './mod-tag.js';
import { versionOfMod } from './versions.js';

/**
 * 最早任务开始日 —— 数据里没有「需求创建时间」，这是最接近的可用近似。
 *
 * 只取普通任务（排除里程碑）：里程碑的 `m` 是卡点日，不代表需求何时被登记，
 * 用它会把提出时间推到需求确认那天，反而比任务开始日更晚。
 * 待排期 / 没有任务的需求取不到 → 返回 null，调用方留空，不臆造。
 */
export function earliestTaskStart(mo) {
  let min = null;
  ((mo && mo.bars) || []).forEach(b => {
    if (!b || b.m || !b.s) return;
    if (!min || b.s < min) min = b.s;
  });
  return min;
}

/**
 * 生命周期四档推导（优先级从高到低，一旦命中即返回）：
 *
 *   已上线 —— 所属版本已被人工标记上线（版本页的「已上线」口径一致）
 *   已提测 —— 提测里程碑已过。只能按 label 认（口径见 core/mod-tag.js 的 findGateMs）
 *   已确认 —— 有任务已开工（有完成度，或开始日不晚于今天）
 *   待确认 —— 其余（含什么都没排的）
 *
 * 已知局限（刻意接受）：里程碑未初始化、或延期后计划日期已过，都会提前落到
 * 较高的一档。回填值只是人工维护的起点，逐条订正即可。
 */
export function inferLifecycle(mo, ctx) {
  const today = ctx.today instanceof Date ? ctx.today : F(ctx.today);
  const v = versionOfMod(ctx.state, mo.name);
  if (v && v.shipped) return '已上线';
  const submit = findGateMs(mo, 'submit');
  if (submit && submit.m && F(submit.m) <= today) return '已提测';
  const tasks = ((mo && mo.bars) || []).filter(b => b && !b.m);
  const started = tasks.some(b => (b.done || 0) > 0 || (b.s && F(b.s) <= today));
  if (started) return '已确认';
  return '待确认';
}

/**
 * 算出需要回填的 patch 列表。
 *
 * @param {Array} mods 全量需求
 * @param {{proposedBy:string, today:Date, state:object}} ctx
 * @returns {Array<{name:string, patch:object}>} 只含确实要改的需求（已填好的不出现）
 */
export function planRequirementBackfill(mods, ctx) {
  const proposedBy = String((ctx && ctx.proposedBy) || '').trim();
  const out = [];
  (mods || []).forEach(mo => {
    if (!mo || !mo.name) return;
    const patch = {};
    // 提出人：只在为空且调用方给了值时才补（"郑致远"这类具体值属于业务决定，不进 core 常量）
    if (proposedBy && !String(mo.proposedBy || '').trim()) patch.proposedBy = proposedBy;
    // 提出时间：取不到最早任务开始日就留空（待排期需求属于这种情况）
    if (!String(mo.proposedAt || '').trim()) {
      const at = earliestTaskStart(mo);
      if (at) patch.proposedAt = at;
    }
    if (!mo.lifecycle) patch.lifecycle = inferLifecycle(mo, ctx);
    if (Object.keys(patch).length) out.push({ name: mo.name, patch });
  });
  return out;
}

// ============================================================
// src/core/mod-stats.js — 需求级统计（人日口径完成度 + 时间口径应达基线）
//
// 从 views/mod-card.js 下沉：需求台账的「按完成度排序」发生在 core 层（mod-query），
// 而 core 不能反向 import views，故统计口径必须落在 core。
//
// 口径说明（与原实现逐字一致，勿在别处重算）：
//   work    = 需求内全部普通任务（非里程碑）的人日总和
//   done    = 按各任务完成度加权的人日
//   pct     = done / work × 100（无人日时为 0，绝不出现 NaN）
//   planPct = 需求时间范围到今天走过的比例（时间口径，与 pct 相减即"延后 / 超前"）
// ============================================================
import { computePlanPct } from './mod-tag.js';

export function modStats(bars, rng, ctx) {
  const { workday, today } = ctx;
  const tasks = (bars || []).filter(b => !b.m && b.s && b.e);
  const work = tasks.reduce((a, b) => a + workday.workDays(b.s, b.e), 0);
  const done = tasks.reduce((a, b) => a + workday.workDays(b.s, b.e) * ((b.done || 0) / 100), 0);
  return {
    work, done,
    pct: work ? Math.round((done / work * 100) * 100) / 100 : 0,
    planPct: computePlanPct(rng, today)
  };
}

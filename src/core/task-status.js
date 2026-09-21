// ============================================================
// src/core/task-status.js — 任务级状态与逾期判定
//
// 从 core/mod-auto.js 拆出（那个文件曾同时装着状态判定、标签计算、颜色解析与徽标 HTML，
// 于是"只想拿一个颜色"的渲染层也要连带依赖整套状态逻辑）。
// 本模块只回答一个问题：**这条任务现在处于什么状态**，并且是整个 app 的唯一口径。
//
// 谁在用：顶部统计 / 需求标签 / 资源工作视图 / 筛选器 —— 任一处口径漂移，
// 同一件事就会在两个界面显示成两种状态，故所有判定只在这里实现一次。
// ============================================================
import { F } from './dates.js';

/**
 * 逾期任务判定（统一口径：顶部统计 / 汇报卡片 / 需求标签 / 甘特条 / 抽屉提示共用）
 *
 * 排除以下几类，避免逾期数字虚高：
 *   1) 里程碑：0 天单点，没有"完成度"概念
 *   2) 已完成（done >= 100）
 *   3) 结束日未过（含当天：今天到期不算逾期）
 *   4) 未分配资源的任务：还没排人负责的活儿不构成"逾期"
 *
 * 归档需求的任务由调用方在传入前过滤（归档状态挂在需求上，本函数拿不到）。
 * 注意 today 会先归一化到当天零点：调用方可能传 new Date()（带时分秒），
 * 否则「今天到期」会被误判成逾期。
 */
export function isOverdueTask(t, today) {
  if (!t || t.isMs || t.m) return false;
  if ((t.done || 0) >= 100) return false;
  if (!t.e) return false;
  const day = today instanceof Date
    ? new Date(today.getFullYear(), today.getMonth(), today.getDate())
    : F(today);
  if (F(t.e) >= day) return false;
  return !!(t.res && t.res.length);
}

/**
 * 单条任务的执行状态（资源工作视图按人列任务时用）
 *
 * 与需求级 moduleTag 的区别：那个回答"这个需求整体走到哪一步"，这个只回答"这一条任务现在什么状态"。
 * 两者口径刻意保持一致（已完成优先判定 → 逾期 → 进行中 → 未开始），
 * 否则同一件事在需求卡片和人员清单里会显示成两个状态。
 *
 * 判定顺序与理由：
 *   1) 已完成（done >= 100）先判：isOverdueTask 本身也排除已完成，把完成项单独拎出来更直观
 *   2) 逾期直接复用 isOverdueTask（排除里程碑 / 未分配资源的任务），与顶部统计同源
 *   3) 进行中 = 今日落在 [s, e] 区间内 —— 与需求级 computeModuleTag 的 started 窗口**同一口径**，
 *      同一件事在需求卡片和人员清单里不能一个"进行中"一个"未开始"
 *   4) 其余为未开始。包括两种"看着怪但故意的"情形：
 *      · 尚未开工（s 在未来）→ 未开始；
 *      · 结束日已过但没人负责（isOverdueTask 明确不判逾期的那类）→ 也归未开始，
 *        因为"逾期"在这个 app 里的定义是"有人负责且没做完"，无人认领的活儿不该算在某个人头上
 *        （它们在工作视图里单独归入「未分配」组，见 views/work-view.js）
 *
 * 注意 taskStatus 只描述"现在"，不判"是否延期"：延期与否看的是完成度 vs 应达基线，
 * 那是需求级 computePlanPct 的活儿，别混进来。
 *
 * 返回 {key, text, color}：color 与需求状态标签 computeModuleTag 的 tagc 取同一套色
 * （完成绿 / 逾期红 / 进行中琥珀 / 待启动灰）—— 同一件事在两处不能是两个颜色。
 * 渲染层直接用 class="tag" + 内联 background，不再重定义一套状态徽标样式。
 */
export function taskStatus(t, today) {
  if (!t) return { key: 'todo', text: '未开始', color: '#94a3b8' };
  if ((t.done || 0) >= 100) return { key: 'done', text: '已完成', color: '#10b981' };
  if (isOverdueTask(t, today)) return { key: 'overdue', text: '已逾期', color: '#ef4444' };
  const day = today instanceof Date
    ? new Date(today.getFullYear(), today.getMonth(), today.getDate())
    : F(today);
  if (t.s && t.e && F(t.s) <= day && F(t.e) >= day) return { key: 'doing', text: '进行中', color: '#f59e0b' };
  return { key: 'todo', text: '未开始', color: '#94a3b8' };
}

/**
 * 任务状态排序权重（资源工作视图用）：逾期的排最前（要处理），已完成沉到最后（只需知晓）。
 * 与 taskStatus 的 key 一一对应，键名漂移会静默退化成"全部同级"，故两边放一起。
 */
export const TASK_STATUS_RANK = { overdue: 0, doing: 1, todo: 2, done: 3 };

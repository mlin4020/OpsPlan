// ============================================================
// src/core/mod-color.js — 需求识别色解析
//
// 从 core/mod-auto.js 拆出。原先渲染层为了拿一个 resolveModuleColors，
// 必须连带依赖整套状态判定与标签计算；颜色解析与那些逻辑毫无关系，故独立成模块。
// 纯函数、无依赖：输出只由入参 modules 决定（同一份输入永远同一套色，渲染不会闪色）。
// ============================================================

/**
 * 需求识别色板：任务条左侧色条 / 需求行色点用。
 * 工作组规划器按人分行，同一需求的任务天然散落在不同泳道里，
 * 靠这套颜色才能一眼对上「这几个条是同一个需求的」。
 */
export const MODULE_PALETTE = [
  '#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#ec4899',
  '#06b6d4', '#ef4444', '#6366f1', '#14b8a6', '#f97316'
];

/**
 * 解析「需求名 → 识别色」映射。
 *
 * 取色优先级：
 *   1) 需求自带 tagc —— 即需求弹窗里的「需求颜色」，随 state.modules 一起落库/导出/同步，
 *      人工指定优先，保证用户改过的颜色不被覆盖；
 *   2) tagc 缺失或与前面需求撞色时（历史数据里默认值全是 #3b82f6），按色板补一个未占用的色。
 *      这一层兜底是必须的：否则老数据整张图一个颜色，色条等于白加。
 *
 * 同一份 modules 顺序下结果稳定，渲染层（甘特图 / 工作组规划器 / 总览）不会闪色。
 * 需求数超过色板长度时允许循环复用（此时区分度已无法保证，只能接受撞色）。
 */
export function resolveModuleColors(modules) {
  const used = new Set();
  const out = {};
  const n = MODULE_PALETTE.length;
  let ci = 0;
  (modules || []).forEach(mo => {
    if (!mo || !mo.name) return;
    // 统一小写：数据库/色板来源的十六进制大小写不一，否则「同色」判定会漏（CSS 本身不区分大小写）
    const manual = String(mo.tagc || '').trim().toLowerCase();
    if (manual && !used.has(manual)) {
      out[mo.name] = manual;
      used.add(manual);
      return;
    }
    // 从游标处向后找第一个未被占用的色板色；游标前移保证后续需求继续往后取，避免总撞同一个
    let pick = '';
    for (let k = 0; k < n; k++) {
      const cand = MODULE_PALETTE[(ci + k) % n];
      if (!used.has(cand)) { pick = cand; ci += k + 1; break; }
    }
    if (!pick) { pick = MODULE_PALETTE[ci % n]; ci++; }
    out[mo.name] = pick;
    used.add(pick);
  });
  return out;
}

/**
 * 新建需求时的推荐颜色：色板里第一个尚未被占用的颜色。
 * 若沿用固定默认值（#3b82f6），所有新需求都会同色，任务条色条也就失去区分作用。
 */
export function nextModuleColor(modules) {
  const used = new Set(Object.values(resolveModuleColors(modules)));
  return MODULE_PALETTE.find(c => !used.has(c))
    || MODULE_PALETTE[(modules || []).length % MODULE_PALETTE.length];
}

// 待新建需求在解析时的占位名（真实需求名尚未确定，内部一次性使用，不会落到数据里）
export const PENDING_MOD_KEY = '\u0000pending-mod';

/**
 * 需求弹窗里「选定的颜色」最终会渲染成什么色。
 *
 * resolveModuleColors 会给撞色的需求补一个色板色，所以用户选的色未必是最终生效的色。
 * 编辑器必须按「实际生效色」回显与落库 —— 否则弹窗显示一个色、图上条色/色点又是另一个色。
 * modName 传空表示「待新建需求」（临时追加到末尾参与解析）。
 */
export function resolveChosenColor(hex, modules, modName) {
  const chosen = String(hex || '').trim().toLowerCase();
  const key = modName || PENDING_MOD_KEY;
  const list = (modules || []).map(m => (m && m.name === key) ? { ...m, tagc: chosen } : m);
  if (!modName) list.push({ name: PENDING_MOD_KEY, tagc: chosen });
  return resolveModuleColors(list)[key] || chosen;
}

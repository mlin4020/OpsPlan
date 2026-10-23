// ============================================================
// src/utils/pinned.js — "钉住了他人任务"的统一提示
//
// 为什么必须说出来：协作者改自己的任务时，级联遇到"不归我管"的下游节点会把它钉成手动
// 并断链（scheduler/planning.js 的 collectAffected）。这是唯一被特许的跨人写入
// （设计文档 §6.4 特许①），但界面上除了被钉任务自己的「手动」锁图标之外没有别的线索 ——
// 出争议时查不出是谁、哪一步引起的。
// 原先只有拖拽（components/drag.js 的私有函数）会提示，导致"抽屉保存 / 自动调整 /
// 需求补钉上线日"这些同样会钉人的路径完全静默（其中问题面板还会反着说"已自动调整排期"，
// 实际是把别人的任务锁成了手动）。所以抽到这里，三条路径共用一份文案与判定。
//
// 通道用 toast：同步状态区只渲染"已同步 + 时间 + 保存人"，塞进去的文案根本不会显示。
// ============================================================

// 兼容三种入参：{ pinned:[...] } / [...] / null-undefined
export function pinnedItems(r) {
  if (!r) return [];
  if (Array.isArray(r)) return r;
  return Array.isArray(r.pinned) ? r.pinned : [];
}

export function pinnedCount(r) {
  return pinnedItems(r).length;
}

// 合并多次操作的结果（如"一键自动调整"对 N 条问题循环调 resolveAuto），按 id 去重
export function mergePinned(results) {
  const out = [];
  (results || []).forEach(r => pinnedItems(r).forEach(id => {
    if (!out.includes(id)) out.push(id);
  }));
  return out;
}

export function pinnedMessage(n) {
  return n ? `已钉住 ${n} 条他人任务为手动，风险面板会报出依赖冲突` : '';
}

// 统一提示：有钉住 → 说清钉了几条（这比"已自动调整"重要，不能被它盖掉）；
// 没有钉住 → 说 fallback（可选，通常是原操作原本要说的那句话）。
// 返回是否说了"钉住"提示，便于调用方决定后续文案。
export function notifyPinned(deps, r, fallback) {
  const n = pinnedCount(r);
  const toast = deps && deps.toast;
  if (typeof toast !== 'function') return n > 0;
  if (n) toast(pinnedMessage(n));
  else if (fallback) toast(fallback);
  return n > 0;
}

// ============================================================
// src/components/gantt-scroll.js — 时间轴的横向定位（把某个日期滚到眼前）
//
// 为什么单独成模块：调用方在 components/gantt-interactions.js（点需求行展开）与
// components/menu-actions.js（右键菜单「展开需求」）两边，而前者 import 后者 ——
// 放在任何一边都会绕成循环依赖，故抽成中立的一小块。
//
// 坐标口径（与 toolbar.js 的「定位今天」同一套，改动请一起改）：
//   X(date) 量的是 .track 左边缘到该日期的像素；而 .track 的左边缘在滚动内容里
//   正好落在**粘性名称列**的右边界（.mname 是 position:sticky;left:0，覆盖在轨道上）。
//   所以 scrollLeft = X(date) - 偏移，就能把该日期摆到可见轨道区里想要的位置：
//     · 偏移 = 可见轨道宽 / 2  → 居中（定位今天用这个）
//     · 偏移 = 一小段留白      → 贴左（展开需求看任务起点用这个）
//   名称列宽从 CSS 变量 --mname-w 读，不写死数字。
// ============================================================

// 展开需求后，任务开始日距可见轨道区左端的留白：
// 不留白的话首日会紧贴名称列边线，任务条的圆角与左侧拖拽手柄都被压住
const LEAD_PAD = 24;

// 粘性名称列宽度（读不到时按 0：宁可不偏移，也不要瞎猜一个宽度把日期推歪）
function mnameWidth(deps) {
  try {
    const style = deps.doc.defaultView.getComputedStyle(deps.doc.documentElement);
    return parseInt(style.getPropertyValue('--mname-w'), 10) || 0;
  } catch (e) {
    return 0;   // 轻量 DOM 替身（测试）没有 CSSOM
  }
}

function layout(deps) {
  const gsc = deps && deps.gsc;
  const ctx = deps && deps.getCtx ? deps.getCtx() : null;
  if (!gsc || !ctx || typeof ctx.X !== 'function') return null;
  // 可见轨道宽 = 滚动容器宽 − 被名称列盖住的那一段
  const visible = Math.max(80, (gsc.clientWidth || 0) - mnameWidth(deps));
  return { gsc, ctx, X: ctx.X, visible };
}

// 把 date 滚到可见轨道区的正中（工具栏「定位今天」用）
export function scrollDateToCenter(deps, date) {
  const L = layout(deps);
  if (!L || !date) return false;
  L.gsc.scrollLeft = Math.max(0, Math.round(L.X(date) - L.visible / 2));
  return true;
}

// 展开某条需求后把它的**任务开始日**带到可见轨道区左端。
//
// 为什么需要：这页默认全部折叠，横向滚动条多半停在项目开头；需求的任务可能排在
// 两三个月之后，展开完依旧一片空白 —— 用户得自己拖滚动条去找"刚展开的东西在哪"。
//
// 没有可信开始日的需求（无任务 / 待排期）不动滚动条：
// 那种情况下滚到哪儿都是错的，保持原样比乱跳好。
export function scrollToModStart(deps, modName) {
  const L = layout(deps);
  if (!L || !modName) return false;
  const modules = (deps.planStore && deps.planStore.state && deps.planStore.state.modules) || [];
  const mo = modules.find(m => m && m.name === modName);
  if (!mo || !mo.bars || !mo.bars.length) return false;
  if (typeof L.ctx.modRange !== 'function') return false;
  const rng = L.ctx.modRange(mo);
  if (!rng || !rng.start) return false;
  L.gsc.scrollLeft = Math.max(0, Math.round(L.X(rng.start) - LEAD_PAD));
  return true;
}

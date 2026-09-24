// ============================================================
// src/core/mod-fold.js — 需求泳道的折叠状态（纯函数，无 DOM）
//
// 语义：**折叠是默认，展开是显式选择**。
// 用户口径：甘特图打开时全部折叠 —— 先一眼看清"这版有哪几条需求"，
// 再按需展开某条去看它的任务条。
//
// 因此折叠表里只有 `false` 是有含义的（"这条我展开了"）：
//   · 键不存在      → 折叠
//   · 值为 false    → 显式展开
//   · 值为 true     → 折叠（历史数据 / 显式折叠都归到这里）
//
// 为什么不做"初始化时把所有需求名塞进表里"：需求还会从导入 JSON、服务端同步、
// 其他协作者那里进来，这些来源都不经过初始化 —— 逐个补写必然漏一处，
// 表现就是"新同步来的需求自己展开了"，与"默认折叠"的承诺对不上。
// 让"缺省值"本身承担默认语义，任何数据来源都自动一致。
//
// 折叠表挂在 viewState 上（可变对象），不进 planStore：
// 它是界面临时状态，不该污染导出 / 同步 / 撤销。
// ============================================================

// 是否折叠（键缺失即折叠）
export function isModCollapsed(collapsed, name) {
  return !collapsed || collapsed[name] !== false;
}

// 展开 / 折叠互转，返回转换后的状态（true = 现在处于折叠态）
export function toggleModCollapsed(collapsed, name) {
  const next = !isModCollapsed(collapsed, name);
  collapsed[name] = next;
  return next;
}

// 全部展开：逐条写显式 false（不能靠清空表——清空在现在的语义下是"全折叠"）
export function expandAllMods(collapsed, modules) {
  (modules || []).forEach(m => { if (m && m.name) collapsed[m.name] = false; });
  return collapsed;
}

// 全部折叠：清空即全折叠。顺带丢掉已删除需求留下的死键，表不会越用越大
export function collapseAllMods(collapsed) {
  Object.keys(collapsed).forEach(k => { delete collapsed[k]; });
  return collapsed;
}

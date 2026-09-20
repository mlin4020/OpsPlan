// ============================================================
// src/components/loading.js — 全屏 loading（加载中遮罩）
// 由 gantt-app.js 1548-1564 行迁移：进页面显示全屏 loading，数据加载完成后隐藏。
// 依赖注入：doc（Document 或带 createElement/body 的对象）；不读 window 全局。
// showLoading 幂等：重复调用不重复创建；hideLoading 幂等：不存在则忽略。
// ============================================================

let loadingEl = null;

// 显示全屏 loading；缺省 doc = document
export function showLoading(doc) {
  const root = doc || (typeof document !== 'undefined' ? document : null);
  if (!root || loadingEl) return loadingEl;
  const el = root.createElement('div');
  el.id = 'fullLoading';
  el.style.cssText = 'position:fixed;inset:0;z-index:999;background:#eef1f7;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;font-family:sans-serif';
  el.innerHTML = '<div style="width:30px;height:30px;border:3px solid #dbe4f0;border-top-color:#3b82f6;border-radius:50%;animation:spin .8s linear infinite"></div><div style="color:#64748b;font-size:13px">加载中…</div>';
  root.body.appendChild(el);
  loadingEl = el;
  return el;
}

// 隐藏并移除全屏 loading；缺省 doc = document
export function hideLoading(doc) {
  if (!loadingEl) return;
  if (loadingEl.parentNode) loadingEl.parentNode.removeChild(loadingEl);
  loadingEl = null;
}

// 聚合暴露（供 bindAll 与入口调用）
export const loading = { showLoading, hideLoading };

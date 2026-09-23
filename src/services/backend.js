// ============================================================
// backend.js — 后端工厂
// 后端选择（显式开关，避免"配了飞书配置就再也回不到 Supabase"）：
//   window.FEISHU_CONFIG.enabled === true 且 bridgeUrl 非空 → 飞书 backend
//   其余情况 → Supabase backend
// 切换方式：只改 feishu-config.js 里的 enabled 字段，无需改代码或 HTML。
// 业务代码只调这里，不感知具体实现。
// ============================================================

// 是否启用飞书后端：必须显式 enabled===true，默认回退 Supabase。
// 这样 feishu-config.js 里只有 bridgeUrl 时不会抢占后端，
// 也不会因为飞书 bridge 没启动而导致整站不可用。
export function isFeishuEnabled() {
  if (typeof window === 'undefined') return false;
  const cfg = window.FEISHU_CONFIG;
  return !!(cfg && cfg.enabled === true && cfg.bridgeUrl);
}

let _backendPromise = null;

export function getBackend() {
  if (_backendPromise) return _backendPromise;

  _backendPromise = isFeishuEnabled()
    ? import('./backends/feishu.js').then(m => m.feishuBackend)
    : import('./backends/supabase.js').then(m => m.supabaseBackend);

  return _backendPromise;
}

export default { getBackend, isFeishuEnabled };

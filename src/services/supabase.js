// ============================================================
// src/services/supabase.js — Supabase 客户端单例
// 由 gantt-api.js client() 迁移，改为 ES Module 形态。
// 依赖：lib/supabase.js（UMD 暴露 window.supabase）→ supabase-config.js（window.SUPABASE_CONFIG）
// 职责：
//   1) 从 window.SUPABASE_CONFIG 读取 url / anonKey
//   2) 惰性创建 client 单例（首次调用 initSupabase/getClient 时创建）
//   3) 兼容历史：创建后把 window.supabase 覆盖为 client，供旧代码 window.supabase.from 复用
// ============================================================

// 配置来源（与 supabase-config.js 约定一致）；未配置时返回空对象
function config() {
  return (typeof window !== 'undefined' && window.SUPABASE_CONFIG) || {};
}

// 读取配置并创建 client（不缓存，供外部读取原始配置/校验用）
export function resolveConfig() {
  return config();
}

// 判断 supabase UMD 是否已加载且可创建 client
export function isSupabaseLoaded() {
  return typeof window !== 'undefined'
    && !!window.supabase
    && typeof window.supabase.createClient === 'function';
}

let sb = null;   // client 单例

// 显式初始化：传入 cfg 覆盖（缺省从 window.SUPABASE_CONFIG 读取）；返回创建的 client 或 null
export function initSupabase(cfg) {
  if (sb) return sb;   // 已初始化则复用（此时 window.supabase 已被覆盖为 client，不能再校验 UMD）
  const CFG = cfg || config();
  if (!CFG.url || !CFG.anonKey || !isSupabaseLoaded()) {
    return null;
  }
  sb = window.supabase.createClient(CFG.url, CFG.anonKey);
  // 兼容历史代码：window.supabase / window.supabaseClient 覆盖为 client
  window.supabase = sb;
  window.supabaseClient = sb;
  return sb;
}

// 获取 client（惰性初始化）；未配置/未加载返回 null
export function getClient() {
  return initSupabase();
}

// 是否已配置且可访问
export function isReady() {
  return !!getClient();
}

// 默认导出聚合（便于 `import supabaseService from ...`）
export default {
  resolveConfig,
  isSupabaseLoaded,
  initSupabase,
  getClient,
  isReady
};

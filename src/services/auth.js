// ============================================================
// auth.js — 认证薄层
// 所有操作转发给 backend（飞书或 Supabase），业务代码不感知
// ============================================================
import { getBackend, isFeishuEnabled } from './backend.js';

// 把 backend 方法包成兼容旧调用方的签名
async function call(method, ...args) {
  const backend = await getBackend();
  return backend[method](...args);
}

export function login(email, password) { return call('login', email, password); }
export function logout() { return call('logout'); }
export function getSession() { return call('getSession'); }
export function getUser() { return call('getUser'); }
export function getProfile(userId) { return call('getProfile', userId); }
export function signUp(name, email, password) { return call('register', name, email, password); }

export function currentUser() {
  // 同步读取当前用户（从 localStorage / 内存）
  // 飞书模式直接读 LS；Supabase 模式同步读
  // 注意：必须与 backend.js 的后端判定保持一致（同样依赖 enabled 开关），
  // 否则「存在 FEISHU_CONFIG 就当成飞书」会读出一个并不存在的飞书用户。
  try {
    if (isFeishuEnabled()) {
      return JSON.parse(localStorage.getItem('opsplan.feishu.user') || 'null');
    }
  } catch { /* ignore */ }
  return null;
}

// 飞书模式不需要 session 快照/恢复
export async function snapshotSession() { return { data: null }; }
export async function restoreSession() { return { data: null }; }

// 错误提示本地化（简化版，保留接口）
export function friendlyAuthError(error) {
  if (!error) return '';
  const raw = (error && error.message) ? error.message : String(error);
  if (/invalid login|incorrect|密码不正确/i.test(raw)) return '邮箱或密码不正确。';
  if (/网络|fetch|Failed/i.test(raw)) return '网络异常，请检查网络后重试。';
  return raw;
}

export default {
  login, signUp, logout, getSession, getUser, currentUser, getProfile,
  friendlyAuthError, snapshotSession, restoreSession
};

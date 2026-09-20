// ============================================================
// src/services/auth.js — 认证与用户档案
// 由 gantt-api.js 认证部分迁移，改为 ES Module 形态（复用 supabase 单例）。
// 提供：login / signUp / logout / getSession / getUser / getProfile / currentUser
// 所有函数均经 getClient() 取 client；client 未就绪时抛出/返回空结果由调用方处理。
// ============================================================
import { getClient } from './supabase.js';

// client 未就绪时返回带 error 的结果（替代 null.auth 抛 TypeError）
function needClient() {
  const c = getClient();
  if (!c) return { error: { message: '未配置 Supabase 或客户端未就绪' } };
  return null;
}

// 登录：邮箱 + 密码
export function login(email, password) {
  const miss = needClient();
  if (miss) return Promise.resolve(miss);
  return getClient().auth.signInWithPassword({ email, password });
}

// 注册：姓名 + 邮箱 + 密码（displayName 写入 user_metadata，供档案回退显示）
export function signUp(name, email, password) {
  const miss = needClient();
  if (miss) return Promise.resolve(miss);
  return getClient().auth.signUp({
    email,
    password,
    options: { data: { displayName: name || (email ? email.split('@')[0] : '') } }
  });
}

// 退出登录
export function logout() {
  const miss = needClient();
  if (miss) return Promise.resolve(miss);
  return getClient().auth.signOut();
}

// 当前会话（Promise<{ data: { session } }>）
export function getSession() {
  const miss = needClient();
  if (miss) return Promise.resolve(miss);
  return getClient().auth.getSession();
}

// 当前用户（Promise<{ data: { user } }>）
export function getUser() {
  const miss = needClient();
  if (miss) return Promise.resolve(miss);
  return getClient().auth.getUser();
}

// 同步读取当前登录用户（内存态；未登录返回 null）
export function currentUser() {
  const c = getClient();
  if (!c) return null;
  const u = c.auth.getUser();
  return u && u.data && u.data.user ? u.data.user : null;
}

// ---------- 错误提示本地化 ----------
// Supabase 返回的是英文原始错误，直接展示不可读；这里映射为可执行的中文提示。
// 命中规则时返回中文说明，未命中则原样透出（便于排查新错误）。
const AUTH_ERROR_RULES = [
  [/email rate limit exceeded|over_email_send_rate_limit/i,
    '验证邮件已达 Supabase 发送限流（免费项目每小时仅数封）。请到 Supabase 控制台关闭「Confirm email」后重试，或配置自定义 SMTP。'],
  [/over_request_rate_limit/i, '操作过于频繁，请稍后再试。'],
  [/Invalid login credentials/i, '邮箱或密码不正确。'],
  [/Email not confirmed/i, '邮箱尚未验证，请先到邮箱点击确认链接后再登录。'],
  [/User already registered/i, '该邮箱已注册，请直接登录。'],
  [/Password should be at least/i, '密码长度不足（至少 6 位）。'],
  [/unable to validate email address|invalid email/i, '邮箱格式不正确。'],
  [/weak password/i, '密码强度不足，请包含大小写字母与数字。'],
  [/network|fetch failed|Failed to fetch/i, '网络异常，请检查网络后重试。']
];

// 把 Supabase auth 错误转成中文提示；非 Error 或空值返回空串
export function friendlyAuthError(error) {
  if (!error) return '';
  const raw = (error && error.message) ? error.message : String(error);
  for (const [re, msg] of AUTH_ERROR_RULES) {
    if (re.test(raw)) return msg;
  }
  return raw;
}

// ---------- 会话快照 / 恢复 ----------
// Supabase signUp 成功后会把当前会话切换为新注册用户。
// 管理员在后台创建账号时会导致自己被"踢下线"，因此建号前后需要快照并恢复会话。
export function snapshotSession() {
  return getSession();
}

// 用快照恢复会话（snapshot 为 getSession() 返回的 data.session）
export function restoreSession(session) {
  const miss = needClient();
  if (miss) return Promise.resolve(miss);
  if (!session || !session.access_token || !session.refresh_token) {
    return Promise.resolve({ data: null, error: null });
  }
  return getClient().auth.setSession(session);
}

// 用户档案：按 userId 查 profiles（display_name / role）
export function getProfile(userId) {
  const miss = needClient();
  if (miss) return Promise.resolve(miss);
  return getClient()
    .from('profiles')
    .select('id,display_name,role')
    .eq('id', userId)
    .maybeSingle();
}

// 聚合导出
export default {
  login, signUp, logout, getSession, getUser, currentUser, getProfile,
  friendlyAuthError, snapshotSession, restoreSession
};

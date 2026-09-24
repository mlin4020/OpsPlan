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

// ---------- 游客（只读）身份 ----------
// 「游客」不是后端账号，只是本机的一个标记：允许免登录进入项目列表只读浏览。
// 权限边界全在服务端（Supabase RLS 对 anon 只放行 select），前端这里不做任何伪造身份的动作，
// 只记「这个人选了以游客身份进来」这一件事，从而让项目列表页知道"不必再弹登录页"。
//
// 存 localStorage（而不是 sessionStorage）：这是"我要怎么用这个工具"的偏好，
// 和主题配色、台账筛选同性质 —— 每次新开标签页都要求重选一次没有意义。
// 真实登录成功时会清掉（见 main-login.js），避免退出后又被当成游客自动放行。
const GUEST_KEY = 'opsplan.guest';

export function isGuest() {
  try { return localStorage.getItem(GUEST_KEY) === '1'; } catch { return false; }
}

export function enterGuest() {
  try { localStorage.setItem(GUEST_KEY, '1'); } catch { /* 隐私模式等写入失败，忽略 */ }
  return true;
}

export function leaveGuest() {
  try { localStorage.removeItem(GUEST_KEY); } catch { /* 同上 */ }
  return false;
}

// 错误提示本地化
// 后端（Supabase / 飞书）返回的是英文原始错误，直接展示不可读；这里映射为可执行的中文提示。
// 命中规则时返回中文说明，未命中则原样透出（便于排查新错误）。
// 注意：飞书 bridge 返回的 msg 多为中文，未命中规则时会原样带出，同样可读。
const AUTH_ERROR_RULES = [
  [/email rate limit exceeded|over_email_send_rate_limit/i,
    '验证邮件已达发送限流（免费项目每小时仅数封）。请到 Supabase 控制台关闭「Confirm email」后重试，或配置自定义 SMTP。'],
  [/over_request_rate_limit/i, '操作过于频繁，请稍后再试。'],
  [/Invalid login credentials/i, '邮箱或密码不正确。'],
  [/Email not confirmed/i, '邮箱尚未验证，请先到邮箱点击确认链接后再登录。'],
  [/User already registered/i, '该邮箱已注册，请直接登录。'],
  [/Password should be at least/i, '密码长度不足（至少 6 位）。'],
  [/unable to validate email address|invalid email/i, '邮箱格式不正确。'],
  [/weak password/i, '密码强度不足，请包含大小写字母与数字。'],
  [/invalid login|incorrect|密码不正确/i, '邮箱或密码不正确。'],
  [/network|fetch failed|Failed to fetch|网络|Failed/i, '网络异常，请检查网络后重试。']
];

// 把后端 auth 错误转成中文提示；非 Error 或空值返回空串
export function friendlyAuthError(error) {
  if (!error) return '';
  const raw = (error && error.message) ? error.message : String(error);
  for (const [re, msg] of AUTH_ERROR_RULES) {
    if (re.test(raw)) return msg;
  }
  return raw;
}

export default {
  login, signUp, logout, getSession, getUser, currentUser, getProfile,
  friendlyAuthError, snapshotSession, restoreSession,
  isGuest, enterGuest, leaveGuest
};

// ============================================================
// backends/feishu.js — 飞书多维表格后端实现
// 所有操作走 bridge（http://127.0.0.1:8787），不直连飞书
// auth session 存 localStorage（无状态，bridge 不存 session）
// ============================================================
import { listAllRecords, batchCreateRecords, batchDeleteRecords, createRecord, updateRecord } from '../feishu-client.js';
import { TABLES, loadPlanFromFeishu, savePlanToFeishu } from '../feishu-sync.js';

const LS_KEY = 'opsplan.feishu.user';
const base = () => window.FEISHU_CONFIG.bridgeUrl;

// ---- 内部工具 ----
function getUserFromLS() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); }
  catch { return null; }
}
function setUserToLS(u) {
  if (u) localStorage.setItem(LS_KEY, JSON.stringify(u));
  else localStorage.removeItem(LS_KEY);
}

// ---- auth ----
async function api(path, opts = {}) {
  const r = await fetch(base() + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || data.msg || `HTTP ${r.status}`;
    return { data: null, error: { message: msg } };
  }
  return { data, error: null };
}

export const feishuBackend = {
  type: 'feishu',

  // ---- auth ----
  async login(email, password) {
    const { data, error } = await api('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    });
    if (error) return { data: null, error };
    setUserToLS(data.user);
    return { data: { user: data.user, session: { access_token: 'feishu' } }, error: null };
  },

  async logout() {
    setUserToLS(null);
    return { error: null };
  },

  async getSession() {
    const u = getUserFromLS();
    return { data: { session: u ? { access_token: 'feishu' } : null }, error: null };
  },

  async getUser() {
    const u = getUserFromLS();
    return { data: { user: u }, error: null };
  },

  async getProfile(userId) {
    // 飞书模式下 user 本身就是完整 profile
    const u = getUserFromLS();
    if (u && u.id === userId) return { data: { role: u.role, display_name: u.display_name }, error: null };
    return { data: null, error: null };
  },

  async register(name, email, password) {
    const { data, error } = await api('/api/auth/register', {
      method: 'POST', body: JSON.stringify({ name, email, password, role: 'user' }),
    });
    if (error) return { data: null, error };
    return { data: { user: data.user, session: null }, error: null };
  },

  currentUser() { return getUserFromLS(); },

  async listUsers() {
    const { data, error } = await api('/api/auth/users');
    if (error) return { data: null, error };
    return { data: data.users || [], error: null };
  },

  async listUserOptions() {
    const { data, error } = await api('/api/auth/users');
    if (error) return { data: null, error };
    return { data: (data.users || []).map(u => ({ id: u.id, display_name: u.display_name })), error: null };
  },

  async setAdmin(userId, isAdmin) {
    // 飞书模式：直接更新人员表的"账号类型"字段
    // 注意：bridge 没有专门端点，走通用 record update
    const r = await fetch(base() + `/bitable/v1/apps/${window.FEISHU_CONFIG.appToken}/tables/${TABLES.resources}/records/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { '账号类型': isAdmin ? 'admin' : 'user' } }),
    });
    if (!r.ok) return { error: { message: '设管理员失败' } };
    return { error: null };
  },

  // ---- projects ----
  async listProjects() {
    try {
      const items = await listAllRecords(TABLES.projects);
      const projects = items.map(r => ({
        id: r.record_id,
        name: (r.fields['项目名称'] || '').toString(),
        owner_id: null,
        updated_at: r.fields['更新时间'] || null,
      }));
      return { data: projects, error: null };
    } catch (e) { return { data: null, error: { message: e.message } }; }
  },

  async getProject(projectId) {
    try {
      const items = await listAllRecords(TABLES.projects);
      const proj = items.find(r => r.record_id === projectId);
      if (!proj) return { data: null, error: { message: '项目不存在' } };
      return {
        data: {
          id: projectId,
          name: (proj.fields['项目名称'] || '未命名').toString(),
          owner_id: null,
          plan: null,
          updated_at: proj.fields['更新时间'] || null,
        },
        error: null,
      };
    } catch (e) { return { data: null, error: { message: e.message } }; }
  },

  async createProject({ name }) {
    try {
      const rec = await createRecord(TABLES.projects, { '项目名称': name, '负责人': '' });
      return { data: { id: rec.record_id, name }, error: null };
    } catch (e) { return { data: null, error: { message: e.message } }; }
  },

  async updateProject(projectId, patch) {
    try {
      const fields = {};
      if (patch.name) fields['项目名称'] = patch.name;
      await updateRecord(TABLES.projects, projectId, fields);
      return { error: null };
    } catch (e) { return { error: { message: e.message } }; }
  },

  async deleteProject(projectId) {
    try {
      const reqs = await listAllRecords(TABLES.requirements);
      const tasks = await listAllRecords(TABLES.tasks);
      const vers = await listAllRecords(TABLES.versions);
      await batchDeleteRecords(TABLES.tasks, tasks.map(r => r.record_id));
      await batchDeleteRecords(TABLES.requirements, reqs.map(r => r.record_id));
      await batchDeleteRecords(TABLES.versions, vers.map(r => r.record_id));
      await batchDeleteRecords(TABLES.projects, [projectId]);
      return { error: null };
    } catch (e) { return { error: { message: e.message } }; }
  },

  // ---- plan ----
  async loadPlan(projectId) {
    try {
      const { plan } = await loadPlanFromFeishu(projectId);
      // 补 calcVer 让 plan-sync 兼容
      return { data: { ...plan, calcVer: 5, savedAt: Date.now(), savedBy: '' }, error: null };
    } catch (e) { return { data: null, error: { message: e.message } }; }
  },

  async savePlan(projectId, plan) {
    try {
      await savePlanToFeishu(projectId, plan);
      return { error: null };
    } catch (e) { return { error: { message: e.message } }; }
  },
};

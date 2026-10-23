// ============================================================
// backends/supabase.js — Supabase 后端实现
// 原有 Supabase 逻辑，完整保留
// ============================================================
import { getClient } from '../supabase.js';

function needClient() {
  const c = getClient();
  if (!c) return { error: { message: '未配置 Supabase 或客户端未就绪' } };
  return null;
}

export const supabaseBackend = {
  type: 'supabase',

  // ---- auth ----
  async login(email, password) {
    const miss = needClient();
    if (miss) return miss;
    return getClient().auth.signInWithPassword({ email, password });
  },

  async logout() {
    const miss = needClient();
    if (miss) return miss;
    return getClient().auth.signOut();
  },

  async getSession() {
    const miss = needClient();
    if (miss) return miss;
    return getClient().auth.getSession();
  },

  async getUser() {
    const miss = needClient();
    if (miss) return miss;
    return getClient().auth.getUser();
  },

  async getProfile(userId) {
    const miss = needClient();
    if (miss) return miss;
    return getClient()
      .from('profiles')
      .select('id,display_name,role,resource_name')
      .eq('id', userId)
      .maybeSingle();
  },

  async register(name, email, password) {
    const miss = needClient();
    if (miss) return miss;
    return getClient().auth.signUp({
      email, password,
      options: { data: { displayName: name || (email ? email.split('@')[0] : '') } }
    });
  },

  currentUser() {
    const c = getClient();
    if (!c) return null;
    const u = c.auth.getUser();
    return u && u.data && u.data.user ? u.data.user : null;
  },

  async listUsers() {
    const miss = needClient();
    if (miss) return miss;
    // resource_name 必须 select：用户管理页靠它渲染「未指定」徽标 ——
    // 漏了它，每个人看起来都没配人名，而"为什么我什么都不能改"在界面上就没有线索了。
    return getClient()
      .from('profiles')
      .select('id,display_name,role,resource_name,created_at')
      .order('created_at');
  },

  async listUserOptions() {
    const miss = needClient();
    if (miss) return miss;
    return getClient()
      .from('profiles')
      .select('id,display_name')
      .order('display_name');
  },

  // 编辑用户：只允许改这三个字段 —— role 与 resource_name 由服务端的
  // profiles_guard_sensitive 触发器兜底，非管理员改会被拒（42501）。
  // 因此这个页面天然只能由管理员使用（非管理员调用会拿到服务端的中文拒绝原因）。
  async updateProfile(userId, patch = {}) {
    const miss = needClient();
    if (miss) return miss;
    const body = {};
    if (patch.display_name != null) body.display_name = String(patch.display_name).trim();
    if (patch.role != null) body.role = patch.role === 'admin' ? 'admin' : 'user';
    if (patch.resource_name != null) {
      const rn = String(patch.resource_name).trim();
      body.resource_name = rn || null;      // 空串 → NULL = 未指定（只读）
    }
    return getClient().from('profiles').update(body).eq('id', userId);
  },

  // 「对应人员」候选。服务端已 btrim + distinct（见 migration.sql 5.6），这里只解包。
  async listResourceNames() {
    const miss = needClient();
    if (miss) return miss;
    const { data, error } = await getClient().rpc('list_resource_names');
    if (error) return { data: null, error };
    return { data: (data || []).map(r => r.name), error: null };
  },

  // ---- projects ----
  async listProjects() {
    const miss = needClient();
    if (miss) return miss;
    return getClient()
      .from('projects')
      .select('id,name,owner_id,created_at,updated_at')
      .order('updated_at', { ascending: false });
  },

  async getProject(id) {
    const miss = needClient();
    if (miss) return miss;
    return getClient()
      .from('projects')
      .select('name,owner_id,plan')
      .eq('id', id)
      .maybeSingle();
  },

  async createProject({ name, ownerId, createdBy, plan }) {
    const miss = needClient();
    if (miss) return miss;
    return getClient()
      .from('projects')
      .insert({ name, owner_id: ownerId, created_by: createdBy, plan })
      .select('id')
      .single();
  },

  async updateProject(id, patch) {
    const miss = needClient();
    if (miss) return miss;
    return getClient().from('projects').update(patch).eq('id', id);
  },

  async deleteProject(id) {
    const miss = needClient();
    if (miss) return miss;
    return getClient().from('projects').delete().eq('id', id);
  },

  // ---- plan ----
  async loadPlan(projectId) {
    const miss = needClient();
    if (miss) return miss;
    return getClient()
      .from('projects')
      .select('plan')
      .eq('id', projectId)
      .maybeSingle();
  },

  async savePlan(projectId, plan) {
    const miss = needClient();
    if (miss) return miss;
    // 唯一写入口：走 RPC，由服务端做身份判定与细粒度校验（migration.sql 的 save_plan）。
    // 不再直接 PATCH projects —— RLS 的 projects_update 只放行 owner/admin，
    // 协作者直接 PATCH 会被拒；RPC 是 SECURITY DEFINER，把规则判定收回服务端。
    return getClient().rpc('save_plan', { p_project_id: projectId, p_plan: plan });
  },
};

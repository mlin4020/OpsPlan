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
      .select('id,display_name,role')
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
    return getClient()
      .from('profiles')
      .select('id,display_name,role,created_at')
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

  async setAdmin(userId) {
    const miss = needClient();
    if (miss) return miss;
    return getClient().from('profiles').update({ role: 'admin' }).eq('id', userId);
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
    return getClient()
      .from('projects')
      .update({ plan, updated_at: new Date().toISOString() })
      .eq('id', projectId);
  },
};

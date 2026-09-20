// ============================================================
// src/services/projects.js — 用户管理 + 项目 CRUD + 排期读写
// 由 gantt-api.js 用户档案/项目 CRUD/排期读写部分迁移，改为 ES Module 形态。
// 依赖 supabase 单例（getClient）。
// 全部返回 supabase 查询结果对象 { data, error }，由调用方决定错误展示。
// ============================================================
import { getClient } from './supabase.js';

// client 未就绪时返回带 error 的结果（替代 null.from 抛 TypeError）
function needClient() {
  const c = getClient();
  if (!c) return { error: { message: '未配置 Supabase 或客户端未就绪' } };
  return null;
}

// ---------- 用户管理（管理员） ----------
// 全量用户（含角色与创建时间，按创建时间升序）
export function listUsers() {
  const miss = needClient();
  if (miss) return Promise.resolve(miss);
  return getClient()
    .from('profiles')
    .select('id,display_name,role,created_at')
    .order('created_at');
}

// 用户选项（id/display_name，按姓名排序，用于负责人下拉）
export function listUserOptions() {
  const miss = needClient();
  if (miss) return Promise.resolve(miss);
  return getClient()
    .from('profiles')
    .select('id,display_name')
    .order('display_name');
}

// 设置某用户为管理员
export function setAdmin(userId) {
  const miss = needClient();
  if (miss) return Promise.resolve(miss);
  return getClient()
    .from('profiles')
    .update({ role: 'admin' })
    .eq('id', userId);
}

// ---------- 项目 CRUD ----------
// 项目列表（按更新时间倒序）
export function listProjects() {
  const miss = needClient();
  if (miss) return Promise.resolve(miss);
  return getClient()
    .from('projects')
    .select('id,name,owner_id,created_at,updated_at')
    .order('updated_at', { ascending: false });
}

// 单个项目元数据 + plan
export function getProject(id) {
  const miss = needClient();
  if (miss) return Promise.resolve(miss);
  return getClient()
    .from('projects')
    .select('name,owner_id,plan')
    .eq('id', id)
    .maybeSingle();
}

// 新建项目：owner_id / created_by / plan（空排期）
export function createProject({ name, ownerId, createdBy, plan }) {
  const miss = needClient();
  if (miss) return Promise.resolve(miss);
  return getClient()
    .from('projects')
    .insert({ name, owner_id: ownerId, created_by: createdBy, plan })
    .select('id')
    .single();
}

// 更新项目字段
export function updateProject(id, patch) {
  const miss = needClient();
  if (miss) return Promise.resolve(miss);
  return getClient()
    .from('projects')
    .update(patch)
    .eq('id', id);
}

// 删除项目
export function deleteProject(id) {
  const miss = needClient();
  if (miss) return Promise.resolve(miss);
  return getClient()
    .from('projects')
    .delete()
    .eq('id', id);
}

// ---------- 排期读写（projects.plan jsonb） ----------
// 读取排期（plan jsonb）
export function loadPlan(projectId) {
  const miss = needClient();
  if (miss) return Promise.resolve(miss);
  return getClient()
    .from('projects')
    .select('plan')
    .eq('id', projectId)
    .maybeSingle();
}

// 保存排期（写 plan 并刷新 updated_at）
export function savePlan(projectId, plan) {
  const miss = needClient();
  if (miss) return Promise.resolve(miss);
  return getClient()
    .from('projects')
    .update({ plan, updated_at: new Date().toISOString() })
    .eq('id', projectId);
}

// ---------- 错误处理 ----------
// 将 supabase 错误转换为用户可读信息
export function errMsg(error) {
  if (!error) return '';
  if (error.code === '42501') return '无权限修改该项目';
  return error.message || '操作失败';
}

// 聚合导出
export default {
  listUsers, listUserOptions, setAdmin,
  listProjects, getProject, createProject, updateProject, deleteProject,
  loadPlan, savePlan, errMsg
};

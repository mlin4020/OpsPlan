// ============================================================
// projects.js — 项目/排期/用户 薄层
// 所有操作转发给 backend，业务代码不感知具体实现
// ============================================================
import { getBackend } from './backend.js';

async function call(method, ...args) {
  const backend = await getBackend();
  return backend[method](...args);
}

// 用户管理
export function listUsers() { return call('listUsers'); }
export function listUserOptions() { return call('listUserOptions'); }
export function setAdmin(userId) { return call('setAdmin', userId); }

// 项目 CRUD
export function listProjects() { return call('listProjects'); }
export function getProject(id) { return call('getProject', id); }
export function createProject(opts) { return call('createProject', opts); }
export function updateProject(id, patch) { return call('updateProject', id, patch); }
export function deleteProject(id) { return call('deleteProject', id); }

// 排期读写
export function loadPlan(projectId) { return call('loadPlan', projectId); }
export function savePlan(projectId, plan) { return call('savePlan', projectId, plan); }

// 错误处理
export function errMsg(error) {
  if (!error) return '';
  if (error.code === '42501') return '无权限修改该项目';
  return error.message || '操作失败';
}

export default {
  listUsers, listUserOptions, setAdmin,
  listProjects, getProject, createProject, updateProject, deleteProject,
  loadPlan, savePlan, errMsg
};

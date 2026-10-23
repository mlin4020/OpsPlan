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

// 服务端校验拒绝的判定（设计文档 §6.2）：
//   PostgREST 把 plpgsql 的 raise ... using errcode 原样带出（code = '42501'）
export function isDenied(error) {
  if (!error) return false;
  if (error.code === '42501') return true;
  return /无权|未指定对应人员|仅管理员/.test(String(error.message || ''));
}

// 错误文案：权限拒绝必须原样透出服务端的中文原因。
// 改造前这里把 42501 统一压成「无权限修改该项目」—— 那是行级策略时代的文案，
// 现在服务端会告诉我们"到底哪一条规则被触发"，笼统化会让用户不知道该怎么办。
export function errMsg(error) {
  if (!error) return '';
  if (error.code === '42501') return error.message || '无权限执行该操作';
  return error.message || '操作失败';
}

export default {
  listUsers, listUserOptions, setAdmin,
  listProjects, getProject, createProject, updateProject, deleteProject,
  loadPlan, savePlan, errMsg, isDenied
};

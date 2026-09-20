// ============================================================
// src/main-index.js — 登录 / 项目列表 / 管理面板页入口
// 迁移 index.html 内联脚本（168-398 行）全部逻辑，改为 ES Module 形态。
// 复用 services/auth + services/projects（替代 window.API），DOM 结构复用 index.html。
// ============================================================
import { getSession, getUser, getProfile, login, signUp, logout, friendlyAuthError, snapshotSession, restoreSession } from './services/auth.js';
import {
  listProjects, getProject, createProject, updateProject, deleteProject,
  listUsers, listUserOptions, setAdmin
} from './services/projects.js';
import { restoreTheme } from './utils/theme.js';

// 主题配色：与排期页共用同一份 localStorage，保证「项目列表 → 排期页」品牌色一致。
// 放在模块顶层（早于任何渲染）执行，避免首屏先闪默认色。
restoreTheme(document);

// 元素选择（id）
function $(id) { return document.getElementById(id); }

let me = null;        // 当前登录用户 { id, email, role, display_name }
let projects = [];    // 项目列表
let editingProj = null;

// ---------- 工具 ----------
const fmtTime = ts => {
  if (!ts) return '--';
  const d = new Date(ts);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
};
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isAdmin = () => me && me.role === 'admin';

// ---------- 视图切换 ----------
function showLogin() { $('viewLogin').style.display = 'flex'; $('viewMain').style.display = 'none'; }
function showMain() { $('viewLogin').style.display = 'none'; $('viewMain').style.display = 'block'; }

// ---------- 数据加载 ----------
async function fetchMyProfile() {
  const { data: { user } } = await getUser();
  if (!user) return null;
  const { data, error } = await getProfile(user.id);
  if (error) return null;
  me = { id: user.id, email: user.email || '', role: data ? data.role : 'user', display_name: (data && data.display_name) || user.email || '--' };
  return me;
}

async function loadProjects() {
  const { data, error } = await listProjects();
  if (error) { $('projGrid').innerHTML = '<div class="empty">加载失败：' + esc(error.message) + '</div>'; return; }
  projects = data || [];
  renderProjects();
}

function renderProjects() {
  const grid = $('projGrid');
  if (!projects.length) { grid.innerHTML = '<div class="empty">还没有项目，点击右上角「新建项目」创建</div>'; return; }
  grid.innerHTML = projects.map(p => {
    const canEdit = !!me && (p.owner_id === me.id || isAdmin());   // 未登录(me=null)一律只读
    return '<div class="proj-card">' +
      '<div class="proj-name">' + esc(p.name || '未命名') +
        '<span class="owner-tag">' + (canEdit ? '我的' : '只读') + '</span>' +
      '</div>' +
      '<div class="time">更新时间：' + fmtTime(p.updated_at) + '</div>' +
      '<div class="proj-actions">' +
        '<button class="btn sm primary" onclick="location.href=\'gantt.html?project=' + p.id + '\'">' + (canEdit ? '进入编辑' : '只读查看') + '</button>' +
        (isAdmin() ? '<button class="btn sm ghost" data-edit="' + p.id + '">管理</button>' : '') +
      '</div>' +
    '</div>';
  }).join('');
  grid.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openEditProj(b.dataset.edit)));
}

async function loadUsers() {
  if (!isAdmin()) return;
  const { data, error } = await listUsers();
  if (error) return;
  const ul = $('userList');
  ul.innerHTML = (data || []).map(u => {
    const isMe = u.id === me.id;
    return '<div class="user-row">' +
      '<span class="avatar" style="background:' + (u.role === 'admin' ? '#f59e0b' : '#3b82f6') + '">' + esc((u.display_name || '?').slice(0, 1)) + '</span>' +
      '<span style="font-weight:600">' + esc(u.display_name || '--') + '</span>' +
      (u.role === 'admin' ? '<span class="badge admin">管理员</span>' : '') +
      (isMe ? '<span class="badge">我</span>' : '') +
      '<span class="spacer"></span>' +
      '<span class="time">' + fmtTime(u.created_at) + '</span>' +
      (isAdmin() && !isMe ? '<button class="btn sm ghost" data-setadmin="' + u.id + '">设为管理员</button>' : '') +
    '</div>';
  }).join('');
  ul.querySelectorAll('[data-setadmin]').forEach(b => b.addEventListener('click', async () => {
    if (confirm('确认将该用户设为管理员？')) {
      const { error } = await setAdmin(b.dataset.setadmin);
      if (error) alert('操作失败：' + error.message); else loadUsers();
    }
  }));
}

// ---------- 认证操作 ----------
async function doLogin(email, pwd) {
  $('loginErr').textContent = '';
  const { error } = await login(email, pwd);
  if (error) { $('loginErr').textContent = friendlyAuthError(error); return; }
  const p = await fetchMyProfile();
  if (!p) { $('loginErr').textContent = '账号资料加载失败，请重试'; return; }
  enterApp();
}

async function doReg(name, email, pwd) {
  $('regErr').textContent = '';
  const { data, error } = await signUp(name, email, pwd);
  if (error) { $('regErr').textContent = friendlyAuthError(error); return; }
  if (data.session) {
    await fetchMyProfile();
    enterApp();
  } else {
    $('regErr').textContent = '注册成功，请前往邮箱点击确认链接后登录';
  }
}

function enterApp() {
  showMain();
  if (me) {
    $('lblUser').textContent = me.display_name + '（' + me.email + '）';
    $('lblAvatar').textContent = (me.display_name || '?').slice(0, 1).toUpperCase();
    $('lblRole').style.display = isAdmin() ? '' : 'none';
    $('adminSection').style.display = isAdmin() ? '' : 'none';
    $('rowNewProjOwner').style.display = isAdmin() ? '' : 'none';
    $('btnNewProj').style.display = '';
    showGuestLoginBtn(false);
  } else {
    enterGuestMode();
  }
  loadProjects();
  if (me && isAdmin()) { loadUsers(); fillOwnerSelects(); }
}

// ---------- 游客模式（未登录，只读浏览） ----------
// 项目数据本身由 RLS 的 projects_select_anon 策略对 anon 放开只读，
// 因此这里只需收敛 UI：隐藏一切写入口，并提供登录入口。
function enterGuestMode() {
  $('lblUser').textContent = '游客（只读）';
  $('lblAvatar').textContent = '游';
  $('lblRole').style.display = 'none';
  $('adminSection').style.display = 'none';
  $('btnNewProj').style.display = 'none';   // 游客不可新建项目
  showGuestLoginBtn(true);
}

// hero 区的「登录」按钮：游客模式下动态插入，点击回到登录卡片
function showGuestLoginBtn(on) {
  let btn = $('btnGuestLogin');
  if (!on) { if (btn) btn.remove(); return; }
  if (btn) return;
  btn = document.createElement('button');
  btn.id = 'btnGuestLogin';
  btn.className = 'btn ghost';
  btn.style.cssText = 'color:#9db4d6;border-color:#33455e';
  btn.textContent = '登录';
  btn.addEventListener('click', () => showLogin());
  $('btnLogout').before(btn);
  $('btnLogout').style.display = 'none';   // 游客无登录态，隐藏退出
}

// ---------- 项目编辑 ----------
async function fillOwnerSelects() {
  const { data, error } = await listUserOptions();
  if (error || !data) return;
  const opts = data.map(u => '<option value="' + u.id + '">' + esc(u.display_name || u.id.slice(0, 8)) + '</option>').join('');
  $('selNewProjOwner').innerHTML = opts;
  $('selEditProjOwner').innerHTML = opts;
}

function openNewProj() {
  $('inpNewProjName').value = '';
  const sel = $('selNewProjOwner');
  const opt = Array.from(sel.options).find(o => o.value === me.id);
  if (opt) sel.value = me.id;
  $('maskNewProj').classList.add('show');
}

async function saveNewProj() {
  const name = $('inpNewProjName').value.trim();
  if (!name) { alert('请输入项目名称'); return; }
  const ownerId = isAdmin() ? ($('selNewProjOwner').value || me.id) : me.id;
  // 新项目初始化为空排期：modules/resources 为空，带入默认时间窗口
  const emptyPlan = {
    v: 1, calcVer: 5, savedAt: Date.now(), savedBy: me.email || '',
    start: '2026-08-12', end: '2026-10-31',
    modules: [], resources: []
  };
  const { data, error } = await createProject({ name, ownerId, createdBy: me.id, plan: emptyPlan });
  if (error) { alert('创建失败：' + error.message); return; }
  closeModal('maskNewProj');
  location.href = 'gantt.html?project=' + data.id;
}

function openEditProj(id) {
  const p = projects.find(x => x.id === id);
  if (!p) return;
  editingProj = p;
  $('inpEditProjName').value = p.name || '';
  const sel = $('selEditProjOwner');
  const opt = Array.from(sel.options).find(o => o.value === p.owner_id);
  if (opt) sel.value = p.owner_id;
  $('maskEditProj').classList.add('show');
}

async function saveEditProj() {
  if (!editingProj) return;
  const name = $('inpEditProjName').value.trim();
  const ownerId = $('selEditProjOwner').value;
  const { error } = await updateProject(editingProj.id, { name: name || editingProj.name, owner_id: ownerId });
  if (error) { $('editProjErr').textContent = error.message; return; }
  closeModal('maskEditProj');
  loadProjects();
}

async function delProj() {
  if (!editingProj) return;
  if (!confirm('确认删除项目「' + editingProj.name + '」？删除后不可恢复！')) return;
  const { error } = await deleteProject(editingProj.id);
  if (error) { $('editProjErr').textContent = error.message; return; }
  closeModal('maskEditProj');
  loadProjects();
}

// ---------- 用户管理 ----------
async function saveNewUser() {
  const name = $('inpNuName').value.trim();
  const email = $('inpNuEmail').value.trim();
  const pwd = $('inpNuPwd').value;
  $('nuErr').textContent = '';
  if (!email || !pwd) { $('nuErr').textContent = '邮箱与密码必填'; return; }
  // 先快照管理员会话：signUp 成功后会话会切到新用户，需在建号后恢复
  const before = await snapshotSession();
  const { data, error } = await signUp(name, email, pwd);
  if (error) { $('nuErr').textContent = friendlyAuthError(error); return; }
  const prevSession = before && before.data ? before.data.session : null;
  if (prevSession) await restoreSession(prevSession);
  if (!data.session) { $('nuErr').textContent = '账号已创建，需邮箱确认后生效'; }
  else {
    closeModal('maskNewUser');
    loadUsers();
    fillOwnerSelects();
  }
}

function closeModal(id) { $(id).classList.remove('show'); }

// ---------- 事件绑定 ----------
function bindEvents() {
  $('loginForm').addEventListener('submit', e => { e.preventDefault(); doLogin($('inpLoginEmail').value.trim(), $('inpLoginPwd').value); });
  $('regForm').addEventListener('submit', e => { e.preventDefault(); doReg($('inpRegName').value.trim(), $('inpRegEmail').value.trim(), $('inpRegPwd').value); });
  $('linkToReg').addEventListener('click', () => { $('loginForm').style.display = 'none'; $('regForm').style.display = 'block'; $('loginSub').textContent = '创建你的账号'; });
  $('linkToLogin').addEventListener('click', () => { $('regForm').style.display = 'none'; $('loginForm').style.display = 'block'; $('loginSub').textContent = '登录后进入项目列表'; });
  $('btnLogout').addEventListener('click', async () => { await logout(); me = null; showLogin(); });
  $('btnNewProj').addEventListener('click', openNewProj);
  $('btnNewProjSave').addEventListener('click', saveNewProj);
  $('btnNewProjCancel').addEventListener('click', () => closeModal('maskNewProj'));
  $('btnNewUser').addEventListener('click', () => { $('inpNuName').value = ''; $('inpNuEmail').value = ''; $('inpNuPwd').value = ''; $('nuErr').textContent = ''; $('maskNewUser').classList.add('show'); });
  $('btnNuSave').addEventListener('click', saveNewUser);
  $('btnNuCancel').addEventListener('click', () => closeModal('maskNewUser'));
  $('btnEditProjSave').addEventListener('click', saveEditProj);
  $('btnDelProj').addEventListener('click', delProj);
  $('btnEditProjCancel').addEventListener('click', () => closeModal('maskEditProj'));
  $('btnReload').addEventListener('click', () => { loadProjects(); if (isAdmin()) loadUsers(); });

  document.querySelectorAll('.modal-mask').forEach(m => m.addEventListener('click', e => {
    if (e.target === m) m.classList.remove('show');
  }));
}

// ---------- 初始化（会话恢复） ----------
function init() {
  bindEvents();
  getSession().then(({ data }) => {
    if (data.session) {
      fetchMyProfile().then(p => { if (p) enterApp(); else showLogin(); });
    } else {
      // 未登录：不再强制停在登录页，直接进入游客模式（只读浏览项目与排期）
      me = null;
      enterApp();
    }
  });
}

init();

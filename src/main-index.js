// ============================================================
// src/main-index.js — 项目列表 / 管理面板页入口（index.html）
//
// 登录已拆到独立路由 login.html（见 src/main-login.js），本页只做两件事：
//   1) 进门先把关：没有登录态、也不是游客 → 直接跳登录页（用 replace，别让返回键来回弹）；
//   2) 进来之后列项目：管理员还有用户管理面板。
//
// 游客（isGuest）是"免登录只读浏览"本机标记，写操作照样被服务端 RLS 拒掉，
// 这里只收敛 UI（隐藏一切写入口 + 提供回登录页的入口）。
// ============================================================
// signUp / friendlyAuthError 仍由本页用：管理员在「用户管理」里直接建号（见 saveNewUser）
import { getSession, getUser, getProfile, logout, signUp, friendlyAuthError, snapshotSession, restoreSession, isGuest, leaveGuest } from './services/auth.js';
import {
  listProjects, getProject, createProject, updateProject, deleteProject,
  listUsers, listUserOptions, updateProfile, listResourceNames, errMsg
} from './services/projects.js';
import { restoreTheme } from './utils/theme.js';
import { roleChangeGuard } from './utils/permission.js';

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

// ---------- 视图切换 / 登录守卫 ----------
function showMain() { $('viewMain').style.display = 'block'; }

// 去登录页。用 replace 而不是 href：未登录被拦下时不该在历史里留下一条列表页记录，
// 否则返回键会退回来又被拦一次（来回弹两下，看着像坏了）
function goLogin() { location.replace('login.html'); }

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
    const isOwner = !!me && p.owner_id === me.id;
    const canEdit = !!me && (isOwner || isAdmin());            // 未登录(me=null)一律只读
    // 「管理」入口：所属人也要有 —— 原来只对 admin 显示，导致普通用户
    // 建了项目却改不了自己的项目名/负责人（这是"普通用户可建项目"的实际缺口）
    const canManage = isOwner || isAdmin();
    return '<div class="proj-card">' +
      '<div class="proj-name">' + esc(p.name || '未命名') +
        '<span class="owner-tag">' + (canEdit ? (isOwner ? '我的' : '管理员') : '只读') + '</span>' +
      '</div>' +
      '<div class="time">更新时间：' + fmtTime(p.updated_at) + '</div>' +
      '<div class="proj-actions">' +
        '<button class="btn sm primary" onclick="location.href=\'gantt.html?project=' + p.id + '\'">' + (canEdit ? '进入编辑' : '只读查看') + '</button>' +
        (canManage ? '<button class="btn sm ghost" data-edit="' + p.id + '">管理</button>' : '') +
      '</div>' +
    '</div>';
  }).join('');
  grid.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openEditProj(b.dataset.edit)));
}

let usersCache = [];

async function loadUsers() {
  // 用户管理只能用管理员身份：updateProfile 写 role / resource_name 会被服务端
  // profiles_guard_sensitive 触发器拒（42501），非管理员进来必然处处失败。
  // 面板本身也是 isAdmin() 才显示（enterApp），这里再收一道，避免以后有别的入口。
  if (!isAdmin()) return;
  const { data, error } = await listUsers();
  if (error) return;
  usersCache = data || [];
  const ul = $('userList');
  ul.innerHTML = usersCache.map(u => {
    const isMe = u.id === me.id;
    // 「未指定」是本次的漏配发现机制：没配 resource_name 的人登录后是纯只读，
    // 而"为什么我什么都不能改"在界面上完全没有别的线索 —— 必须在这里显式标出来
    const rn = String(u.resource_name == null ? '' : u.resource_name).trim();
    const rnCell = rn
      ? '<span class="time">' + esc(rn) + '</span>'
      : '<span class="badge warn" title="未指定对应人员：该账号登录后只能查看，不能编辑">未指定</span>';
    return '<div class="user-row">' +
      '<span class="avatar" style="background:' + (u.role === 'admin' ? '#f59e0b' : '#3b82f6') + '">' + esc((u.display_name || '?').slice(0, 1)) + '</span>' +
      '<span style="font-weight:600">' + esc(u.display_name || '--') + '</span>' +
      (u.role === 'admin' ? '<span class="badge admin">管理员</span>' : '') +
      (isMe ? '<span class="badge">我</span>' : '') +
      rnCell +
      '<span class="spacer"></span>' +
      '<span class="time">' + fmtTime(u.created_at) + '</span>' +
      '<button class="btn sm ghost" data-edituser="' + u.id + '">编辑</button>' +
    '</div>';
  }).join('');
  ul.querySelectorAll('[data-edituser]').forEach(b => b.addEventListener('click', () => openEditUser(b.dataset.edituser)));
}

// ---------- 编辑用户 ----------
let editingUser = null;

// 候选人名：拼错的 resource_name 会让那人"什么都改不了"且极难排查，所以必须给候选
async function fillResNameOptions() {
  const { data } = await listResourceNames();
  const dl = $('resNameList');
  if (dl && data) dl.innerHTML = data.map(n => '<option value="' + esc(n) + '"></option>').join('');
}

function openEditUser(id) {
  const u = usersCache.find(x => x.id === id);
  if (!u) return;
  editingUser = u;
  $('inpEuName').value = u.display_name || '';
  $('selEuRole').value = u.role === 'admin' ? 'admin' : 'user';
  $('inpEuResName').value = u.resource_name || '';
  $('euErr').textContent = '';

  // 两条保护统一由 permission.roleChangeGuard 判定（别在 UI 里散落 if/else，
  // 否则以后加第三条保护时必然漏掉某条路径）
  const guard = roleChangeGuard(u, usersCache, me);
  const sel = $('selEuRole');
  sel.disabled = !guard.ok;
  sel.title = guard.reason || '';

  $('maskEditUser').classList.add('show');
}

async function saveEditUser() {
  if (!editingUser) return;
  const name = $('inpEuName').value.trim();
  if (!name) { $('euErr').textContent = '姓名不能为空'; return; }
  const patch = {
    display_name: name,
    // 空串 → 后端转 null（未指定）。空字符串会让"没配"和"配了个空名字"混在一起。
    resource_name: $('inpEuResName').value.trim()
  };
  // 角色下拉被 disable 时（自己 / 最后一个管理员）不提交 role，避免撞服务端触发器
  if (!$('selEuRole').disabled) patch.role = $('selEuRole').value;

  const { error } = await updateProfile(editingUser.id, patch);
  // 服务端原因原样透出：42501 时用户需要知道"哪条规则被触发"，笼统文案无从下手
  if (error) { $('euErr').textContent = errMsg(error); return; }
  closeModal('maskEditUser');
  loadUsers();
  fillOwnerSelects();
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
  // 负责人候选对「所属人」也要拉：他点「管理」时要能改项目名与负责人。
  // 只给管理员拉的话，普通用户打开编辑弹窗会看到空下拉 → 保存即静默转交/报错。
  if (me) fillOwnerSelects();
  if (me && isAdmin()) { loadUsers(); fillResNameOptions(); }
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

// hero 区的「登录」按钮：游客模式下动态插入，点击前往登录页（换账号 / 结束只读浏览）
function showGuestLoginBtn(on) {
  let btn = $('btnGuestLogin');
  if (!on) { if (btn) btn.remove(); return; }
  if (btn) return;
  btn = document.createElement('button');
  btn.id = 'btnGuestLogin';
  btn.className = 'btn ghost';
  btn.style.cssText = 'color:#9db4d6;border-color:#33455e';
  btn.textContent = '登录';
  btn.addEventListener('click', () => { location.href = 'login.html'; });
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
  let opt = Array.from(sel.options).find(o => o.value === p.owner_id);
  // 所属人不在候选里（账号被删 / 资料读不到）时补一个占位项并选中：
  // 否则下拉会停在第一个人身上，一点保存就把项目**静默转交**给陌生人。
  if (!opt && p.owner_id) {
    opt = document.createElement('option');
    opt.value = p.owner_id;
    opt.textContent = '未知账号（' + String(p.owner_id).slice(0, 8) + '）';
    sel.appendChild(opt);
  }
  if (opt) sel.value = p.owner_id;
  // 删除项目仅管理员：RLS 的 projects_delete 策略就是 is_admin()，前端不放开
  $('btnDelProj').style.display = isAdmin() ? '' : 'none';
  $('editProjErr').textContent = '';
  $('maskEditProj').classList.add('show');
}

async function saveEditProj() {
  if (!editingProj) return;
  const name = $('inpEditProjName').value.trim();
  const ownerId = $('selEditProjOwner').value;
  const changingOwner = !!ownerId && ownerId !== editingProj.owner_id;

  if (changingOwner) {
    // 转交会让原所属人当场失去管理权（RLS 的 projects_update 只认 owner_id），
    // 且不可自恢复 —— 必须说清楚再让他点
    const target = Array.from($('selEditProjOwner').options).find(o => o.value === ownerId);
    const who = target ? target.textContent : ownerId;
    if (!confirm('确认把项目「' + (editingProj.name || '未命名') + '」转交给「' + who + '」？\n\n' +
                 '转交后你将失去对该项目的管理权（连项目名都改不了），需要管理员才能改回。')) return;
  }

  const { error } = await updateProject(editingProj.id, { name: name || editingProj.name, owner_id: ownerId });
  if (error) { $('editProjErr').textContent = errMsg(error); return; }
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
  // 退出登录：清掉游客标记后再去登录页 —— 否则「退出」之后会被游客标记自动放行回来，
  // 看起来像退出失败
  $('btnLogout').addEventListener('click', async () => {
    await logout();
    me = null;
    leaveGuest();
    goLogin();
  });
  $('btnNewProj').addEventListener('click', openNewProj);
  $('btnNewProjSave').addEventListener('click', saveNewProj);
  $('btnNewProjCancel').addEventListener('click', () => closeModal('maskNewProj'));
  $('btnNewUser').addEventListener('click', () => { $('inpNuName').value = ''; $('inpNuEmail').value = ''; $('inpNuPwd').value = ''; $('nuErr').textContent = ''; $('maskNewUser').classList.add('show'); });
  $('btnNuSave').addEventListener('click', saveNewUser);
  $('btnNuCancel').addEventListener('click', () => closeModal('maskNewUser'));
  $('btnEuSave').addEventListener('click', saveEditUser);
  $('btnEuCancel').addEventListener('click', () => closeModal('maskEditUser'));
  $('btnEditProjSave').addEventListener('click', saveEditProj);
  $('btnDelProj').addEventListener('click', delProj);
  $('btnEditProjCancel').addEventListener('click', () => closeModal('maskEditProj'));
  $('btnReload').addEventListener('click', () => { loadProjects(); if (isAdmin()) loadUsers(); });

  document.querySelectorAll('.modal-mask').forEach(m => m.addEventListener('click', e => {
    if (e.target === m) m.classList.remove('show');
  }));
}

// ---------- 初始化（登录守卫 + 会话恢复） ----------
// 三条出路，按优先级：
//   1) 有会话且资料读得到 → 正常进入（管理员还会拉用户列表）
//   2) 没有会话但是游客（登录页点过「游客进入」）→ 只读进入
//   3) 其余 → 去登录页。原先这里是"未登录也直接游客进入"，于是登录页形同虚设：
//      任何人打开 index.html 就已经在系统里了。改成独立路由后必须显式选一次。
function init() {
  bindEvents();
  getSession()
    .then(({ data }) => enterWith(!!(data && data.session)))
    // 会话读取异常（配置缺失 / 存储不可用）：按"未登录"处理 —— 游客标记仍然生效，
    // 否则一个网络抖动就会把正在只读浏览的人踢出去
    .catch(() => enterWith(false));
}

function enterWith(hasSession) {
  if (hasSession) {
    fetchMyProfile().then(p => { if (p) enterApp(); else goLogin(); });
    return;
  }
  if (isGuest()) { me = null; enterApp(); return; }
  goLogin();
}

init();

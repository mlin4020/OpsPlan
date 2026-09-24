// ============================================================
// src/main-login.js — 登录页入口（login.html）
// 从 main-index.js 里拆出来：那一页原先同时管"登录 / 注册"和"项目列表"两件事，
// 拆开之后本文件只管登录这一件事，进系统的三条路都收在这里：
//   1) 邮箱 + 密码登录
//   2) 注册（注册成功即尝试直接进入；需要邮箱确认时留在本页提示）
//   3) 游客进入（只读，不做任何后端调用）
// 依赖：services/auth（认证薄层，飞书 / Supabase 由它转发）、utils/theme（配色与主站保持一致）
// ============================================================
import './styles/login.css';
import { getSession, getUser, getProfile, login, signUp, friendlyAuthError, enterGuest, leaveGuest } from './services/auth.js';
import { restoreTheme } from './utils/theme.js';

// 恢复上次选定的配色：登录页与项目列表、排期页共用同一份主题，避免进门换一次肤色。
// 放在模块顶层（早于任何渲染）执行。
restoreTheme(document);

const $ = id => document.getElementById(id);
const HOME = 'index.html';

// 用 replace 而不是 href：登录成功后按返回键不该回到登录表单
// （那条路径只能再被"已登录校验"弹回来，来回弹两下很像是卡住了）
function goHome() { location.replace(HOME); }

// ---------- 三条进系统的路 ----------
async function doLogin(email, pwd) {
  $('loginErr').textContent = '';
  const { error } = await login(email, pwd);
  if (error) { $('loginErr').textContent = friendlyAuthError(error); return; }
  // 后端异常时可能连 data 都没有（如未配置 Supabase）—— 别直接解构，那会抛异常且页面毫无反应
  const { data: gu } = await getUser();
  const user = gu && gu.user;
  if (!user) { $('loginErr').textContent = '登录状态异常，请重试'; return; }
  const { error: perr } = await getProfile(user.id);
  if (perr) { $('loginErr').textContent = '账号资料加载失败，请重试'; return; }
  leaveGuest();   // 真登录了就不再是游客，否则退出后会被游客标记自动放行
  goHome();
}

async function doReg(name, email, pwd) {
  $('regErr').textContent = '';
  const { data, error } = await signUp(name, email, pwd);
  if (error) { $('regErr').textContent = friendlyAuthError(error); return; }
  if (data && data.session) {   // 项目未开启邮箱确认时会直接给会话
    leaveGuest();
    goHome();
    return;
  }
  $('regErr').textContent = '注册成功，请前往邮箱点击确认链接后登录';
}

// 游客：只在本机留一个标记，不碰后端（权限边界在服务端 RLS，见 services/auth.js 的说明）
function doGuest() {
  enterGuest();
  goHome();
}

// ---------- 视图切换（登录 ↔ 注册） ----------
function showReg(on) {
  $('loginForm').style.display = on ? 'none' : 'block';
  $('regForm').style.display = on ? 'block' : 'none';
  $('loginSub').textContent = on ? '创建你的账号' : '登录后进入项目列表';
  if (on) $('regErr').textContent = ''; else $('loginErr').textContent = '';
}

function bindEvents() {
  $('loginForm').addEventListener('submit', e => {
    e.preventDefault();
    doLogin($('inpLoginEmail').value.trim(), $('inpLoginPwd').value);
  });
  $('regForm').addEventListener('submit', e => {
    e.preventDefault();
    doReg($('inpRegName').value.trim(), $('inpRegEmail').value.trim(), $('inpRegPwd').value);
  });
  $('linkToReg').addEventListener('click', () => showReg(true));
  $('linkToLogin').addEventListener('click', () => showReg(false));
  $('btnGuest').addEventListener('click', doGuest);
}

// ---------- 初始化 ----------
// 已经是有效登录态就直接进列表页 —— 登录表单对这种人只是干扰。
//
// 但"有 session"不等于"能用"：token 可能已失效、账号资料可能读不到。
// 所以这里连资料一起校验，**任一步不成立就老老实实停在登录页**。
// 只判 session 就跳转的话，会和项目列表页的"资料读不到 → 回登录页"形成来回弹跳（死循环）。
function skipIfSignedIn() {
  getSession()
    .then(async ({ data }) => {
      if (!(data && data.session)) return;
      const { data: gu } = await getUser();
      const user = gu && gu.user;
      if (!user) return;
      const { error } = await getProfile(user.id);
      if (error) return;
      goHome();
    })
    .catch(() => { /* 会话读取异常：停在登录页，由用户重新登录 */ });
}

bindEvents();
skipIfSignedIn();

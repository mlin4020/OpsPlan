// ============================================================
// src/main-gantt.js — 排期页入口（真实实现）
// 组装排期平台（Supabase 多项目模式）：
//   1) 注入排期页样式与静态 DOM 壳（hero / toolbar / 甘特容器 / 抽屉 / 弹窗）
//   2) 解析 ?project=，无参数则提示"请从项目列表进入"
//   3) 初始化 supabase client → 登录检查 → 项目元数据 → editable 判定 → 只读状态
//   4) 组装 createScheduler + createPlanSync + bindAll + renderAll
//   5) hero 动态化（标题=项目名、副标题=时间窗口）+ 全屏 loading + 同步状态
// 依赖：services/* + core/* + store/* + scheduler + views + components
// ============================================================
import './styles/gantt.css';
import { planStore } from './store/plan-store.js';
import { userStore } from './store/user-store.js';
import { createWorkday } from './core/workday.js';
import { defaultHolidays, PNAME } from './core/default-data.js';
import { defaultWorkFilter } from './core/work-filter.js';
import { createScheduler } from './scheduler/index.js';
import { bindAll } from './components/index.js';
import { buildShellHTML, showFullLoading } from './components/shell.js';
import { renderAll, buildViewCtx, toggleReportExpanded } from './views/index.js';
import { restoreTheme } from './utils/theme.js';
import { initSupabase } from './services/supabase.js';
import { getSession, getUser, getProfile } from './services/auth.js';
import { getProject } from './services/projects.js';
import { createPlanSync } from './services/plan-sync.js';

// 解析项目参数
const params = new URLSearchParams(location.search);
const projectId = params.get('project');
// 白名单里的键必须与 shell.js 的 data-view 一致（含 work / arch / version）；
// 不在白名单里的值静默回退默认视图 —— 拼错的 ?view=xxx 会表现为"链接打不开"
const viewFromQuery = ['res', 'report', 'mod', 'arch', 'work', 'version'].includes(params.get('view')) ? params.get('view') : 'report';
// ?me=某人：资源工作视图的"看自己"深链（如 ?view=work&me=张三）。
// 没有账号与资源人名的映射关系（Supabase 用户 ≠ 资源库人名），故用 URL 参数代替"我是谁"，
// 员工把自己的链接存成书签即可一步到位，无需在系统里维护身份映射。
const meFromQuery = (params.get('me') || '').trim();

// 必须从项目列表带 project 参数进入
if (!projectId) {
  document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#eef1f7;color:#64748b;font-family:sans-serif;font-size:14px">请从<a href="index.html" style="color:#3b82f6;margin:0 4px">项目列表</a>进入排期页</div>';
} else {
  ensureSupabaseScripts().then(boot);
}

function boot() {
  // 恢复上次选定的顶栏配色（换肤）。必须在注入 DOM 壳之前，
  // 否则会先渲染默认色再跳成用户选的色，首屏闪一下。
  restoreTheme(document);

  // 注入排期页静态 DOM 壳（样式由 gantt.css 提供）
  document.body.innerHTML = buildShellHTML();

  // 全屏 loading（进页面立即显示，覆盖登录/项目/排期接口加载链）
  let loadingApi = null;
  function showLoading() {
    if (!loadingApi) loadingApi = showFullLoading();
  }
  function hideLoading() {
    if (loadingApi) { loadingApi.remove(); loadingApi = null; }
  }
  showLoading();

  // 数据访问：初始化 supabase client（未配置则提示并终止）
  const client = initSupabase();
  if (!client) {
    hideLoading();
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#eef1f7;color:#64748b;font-family:sans-serif;flex-direction:column;gap:8px"><div style="font-size:15px;font-weight:600;color:#334155">未配置 Supabase</div><div style="font-size:12px">请在 supabase-config.js 中填写 Project URL 与 anon key</div></div>';
    return;
  }

  // 视图状态（toolbar 读写；renderAll 读取）
  const viewState = {
    view: viewFromQuery, zoom: 'day', collapsed: {}, dayW: 13, archOpen: false,
    // 资源工作视图的筛选条件（人员 / 状态 / 优先级 / 关键词）。放 viewState 而不是写进 URL：
    // 切换视图来回时不丢，且不污染地址栏；只有 ?me= 这一项刻意走 URL（便于分享"我的任务"链接）
    workFilter: { ...defaultWorkFilter(), person: meFromQuery }
  };
  // 工作日计算（注入本地兜底假期）
  const workday = createWorkday({ holidays: defaultHolidays() });

  // 项目上下文注入 userStore（projectId 先写入，供 scheduler KEY 与 plan-sync 使用）
  userStore.set({ projectId });

  // 同步状态回调（先占位，bindAll 后经 setSyncStatus 接线）
  const planSync = createPlanSync({ planStore, userStore, sched: null });
  // 调度引擎（sync 注入 planSync 的 load/push）
  const sched = createScheduler({ planStore, userStore, W: workday, sync: planSync });
  planSync.setSched(sched);   // 回填 sched 供 collect 重建索引

  // ---- 渲染 ctx 基础（每次 render 与 viewState/ctxInjection 合并）----
  const baseCtx = {
    state: planStore.state,
    sched,
    gantt: document.getElementById('gantt'),
    gsc: document.querySelector('.gscroll'),
    getEl: id => document.getElementById(id),
    workday,
    today: new Date(),
    holidays: defaultHolidays(),
    toggleReportExpanded
  };
  let lastCtx = null;
  function buildCtx(sc) {
    const raw = {
      ...baseCtx,
      view: viewState.view,
      zoom: viewState.zoom,
      dayW: viewState.dayW,
      collapsed: viewState.collapsed,
      archOpen: viewState.archOpen,
      workFilter: viewState.workFilter,
      // 未显式指定时保持 undefined：renderAll 会沿用当前滚动位置（传 0 会被当作"滚到最左"）
      scrollLeft: typeof sc === 'number' ? sc : undefined,
      ...(ui ? ui.ctxInjection : {})
    };
    // 关键：经 buildViewCtx 补全 X/totalW/fmtD/modRange，确保拖拽(getCtx)拿到的 ctx 可算坐标
    lastCtx = buildViewCtx(raw);
    return lastCtx;
  }
  function render(sc) {
    renderAll(buildCtx(sc));
    if (ui) ui.afterRender();
  }

  // 只读状态（进入项目后由 editable 判定写入）
  let ui = null;
  function wireUI() {
    // 完整依赖注入组件层
    ui = bindAll({
      doc: document,
      getEl: id => document.getElementById(id),
      gantt: document.getElementById('gantt'),
      gsc: document.querySelector('.gscroll'),
      planStore, userStore, sched,
      workday,
      PNAME,
      today: () => new Date(),
      viewState,
      setDayW: dw => { viewState.dayW = dw; },
      toggleReportExpanded,
      getCtx: () => lastCtx || buildCtx(),
      render: sc => render(sc),
      readonlyOnInit: !!userStore.state.readonly,
      onBackList: () => { location.href = 'index.html'; }
    });
    // 同步状态钩子：planSync → ui.onSyncStatus
    planSync.setSyncStatus(ui.onSyncStatus);
  }

  // ---- 项目初始化：hero 动态化 + editable 判定 + 服务端加载 ----
  function initProject(p) {
    // 项目上下文注入 userStore（供导出 HTML 取项目名）
    userStore.set({ project: p || null });
    // hero 动态化：标题=项目名，副标题=项目时间窗口
    const projName = (p && p.name) || '未命名项目';
    const hTitle = document.getElementById('heroTitle');
    const hSub = document.getElementById('heroSub');
    if (hTitle) hTitle.textContent = projName;
    if (hSub) {
      const start = (p && p.plan && p.plan.start) || '2026-08-12';
      const endRaw = (p && p.plan && p.plan.end) || '2026-10-31';
      // end 可能为 'YYYY-MM-DD' 或 'MM/DD' 短格式
      const end = endRaw.length <= 5 ? endRaw : endRaw.slice(5).replace('-', '/');
      hSub.textContent = start + ' → ' + end + ' 整体上线 · 工作组规划器（依赖 / 自动排期 / 资源）';
    }

    // editable 判定：登录用户中 owner 为空 / 本人 / 管理员 可编辑
    // 游客（未登录，me 为空）一律只读 —— 与 RLS 的 anon 只读策略一致，避免前端可改但服务端拒绝
    const me = userStore.state.user;
    const editable = !!me && (!p || p.owner_id == null || p.owner_id === me.id || me.role === 'admin');
    if (!editable) userStore.set({ readonly: true });

    // 显示服务器工具栏（返回列表 / 从服务器刷新）
    const serverGroup = document.getElementById('serverGroup');
    if (serverGroup) serverGroup.style.display = '';
    // body 标记：移动端「更多」弹层据此放出服务器相关操作（本地导出模式无此项）
    document.body.classList.add('with-server');

    // 组装组件层（此时 userStore.readonly 已确定）
    wireUI();
    hideLoading();

    // 初始渲染（空数据壳），随后从服务器加载
    render(0);
    // 预取工作日假期缓存，成功后重渲染以反映调休补班
    workday.prefetch([2026, 2027]).then(() => { try { render(document.querySelector('.gscroll').scrollLeft); } catch (e) {} });

    // 从服务器加载排期（成功渲染最新；失败回退本地空排期渲染）
    sched.loadFromServer().then(ok => {
      if (ok) {
        try { render(document.querySelector('.gscroll').scrollLeft); } catch (e) {}
      } else {
        ui.onSyncStatus('fail', { msg: '服务器暂无排期数据' });
        try { render(document.querySelector('.gscroll').scrollLeft); } catch (e) {}
      }
      hideLoading();
    });
  }

  // ---- 登录检查 → 用户档案 → 项目元数据 → 初始化 ----
  // 游客（未登录）也可进入：不跳转登录页，保持 user=null，
  // 后续 initProject 的 editable 判定会因 me 为空而置为只读，只能查看不能编辑。
  (async () => {
    const { data: sess } = await getSession();
    const hasSession = !!(sess && sess.session);
    if (hasSession) {
      const { data: ud } = await getUser();
      const user = ud && ud.user;
      if (user) {
        userStore.set({ user: { id: user.id, email: user.email || '' } });
        const { data: prof } = await getProfile(user.id);
        if (prof && prof.role === 'admin') {
          const u = userStore.state.user;
          userStore.set({ user: { ...u, role: 'admin' } });
        }
      }
    }
    const { data: proj, error } = await getProject(projectId);
    if (error || !proj) {
      wireUI();
      ui.onSyncStatus('fail', { msg: '项目不存在或无权限' });
      initProject(null);
      return;
    }
    initProject(proj);
  })();
}

// 动态加载 Supabase UMD 与配置脚本（gantt.html 未显式引入，需在此确保就绪）。
// 幂等：已在 head 注入则跳过；返回 Promise，脚本全部加载完成后 resolve（失败也 resolve，由 boot 内处理未配置提示）。
function ensureSupabaseScripts() {
  const needed = [
    { id: 'supabase-umd', src: 'lib/supabase.js' },
    { id: 'supabase-config', src: 'supabase-config.js' }
  ];
  const existing = () => !!(window.supabase && window.SUPABASE_CONFIG);
  if (existing()) return Promise.resolve();
  const load = src => new Promise(resolve => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => resolve();
    document.head.appendChild(s);
  });
  // 顺序加载：先 supabase.js（定义 window.supabase），再 config.js
  return load('lib/supabase.js')
    .then(() => load('supabase-config.js'))
    .catch(() => {});
}

// showFullLoading / buildShellHTML 已提取至 components/shell.js，此处不再重复定义

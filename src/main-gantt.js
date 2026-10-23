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
import { loadWorkFilter, saveWorkFilter } from './core/work-filter.js';
import { defaultReqFilter, defaultReqSort, loadReqView, saveReqView } from './core/mod-query.js';
import { planRequirementBackfill } from './core/backfill.js';

// 历史数据回填时统一写入的提出人。这是具体的业务值（不是技术默认值），
// 所以放在入口层而不是 core 常量里 —— core/backfill.js 只认调用方传什么。
const BACKFILL_PROPOSED_BY = '郑致远';
import { createScheduler } from './scheduler/index.js';
import { bindAll } from './components/index.js';
import { buildShellHTML, showFullLoading } from './components/shell.js';
import { renderAll, buildViewCtx, toggleReportExpanded, toggleReqExpanded } from './views/index.js';
import { restoreTheme } from './utils/theme.js';
import { initSupabase } from './services/supabase.js';
import { isFeishuEnabled } from './services/backend.js';
import { getSession, getUser, getProfile } from './services/auth.js';
import { getProject } from './services/projects.js';
import { createPlanSync } from './services/plan-sync.js';
import { resolveAccess, ACCESS, ctxOf } from './utils/permission.js';
import { refreshUI as refreshReadonlyUI } from './utils/readonly.js';

// 解析项目参数
const params = new URLSearchParams(location.search);
const projectId = params.get('project');
// 白名单里的键必须与 shell.js 的 data-view 一致（含 req / work / version）；
// 不在白名单里的值静默回退默认视图 —— 拼错的 ?view=xxx 会表现为"链接打不开"
// 旧链接兼容：归档页已被需求台账取代，老书签 ?view=arch 重定向到 req
const VIEW_ALIAS = { arch: 'req' };
const rawView = params.get('view') || '';
const viewFromQuery = ['res', 'report', 'mod', 'req', 'work', 'version'].includes(VIEW_ALIAS[rawView] || rawView)
  ? (VIEW_ALIAS[rawView] || rawView)
  : 'report';
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

  // 数据访问：Supabase 模式下初始化 client（未配置则提示并终止）；
  // 飞书模式由 bridge 提供数据，不依赖 Supabase client，不能在这里卡住。
  if (!isFeishuEnabled() && !initSupabase()) {
    hideLoading();
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#eef1f7;color:#64748b;font-family:sans-serif;flex-direction:column;gap:8px"><div style="font-size:15px;font-weight:600;color:#334155">未配置 Supabase</div><div style="font-size:12px">请在 supabase-config.js 中填写 Project URL 与 anon key，或在 feishu-config.js 中开启 enabled 使用飞书后端</div></div>';
    return;
  }

  // 恢复上次的台账查询条件（本机、本项目维度；读不到就是默认值）
  const savedReqView = loadReqView(projectId);
  // 资源工作视图的筛选条件同样记忆（本机、本项目维度），否则每次进页面都要把
  // 人员 / 状态 / 优先级重设一遍（与台账那次的诉求同源）
  const savedWorkFilter = loadWorkFilter(projectId);

  // 视图状态（toolbar 读写；renderAll 读取）
  const viewState = {
    view: viewFromQuery, zoom: 'day', collapsed: {}, dayW: 13, archOpen: false,
    // 资源工作视图的筛选条件（人员 / 状态 / 优先级 / 关键词）。放 viewState 而不是写进 URL：
    // 切换视图来回时不丢，且不污染地址栏；只有 ?me= 这一项刻意走 URL（便于分享"我的任务"链接）。
    // 初值来自上次的记忆（本机本项目），但 ?me= 是**本次明确的意图**，优先级高于记忆 ——
    // 打开"我的任务"链接却看到上次筛的别人，比丢记忆更难解释。
    workFilter: { ...savedWorkFilter, ...(meFromQuery ? { person: meFromQuery } : {}) },
    // 需求台账的筛选与排序（同样不进 URL：属临时观察状态，切换视图来回不丢）。
    // 但从 localStorage 恢复上次的选择 —— 否则每次打开都要把筛选条件重设一遍
    // （用户反馈的痛点）。按 projectId 隔离：不同项目关注的范围本来就不一样。
    reqFilter: savedReqView.filter,
    reqSort: savedReqView.sort
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
    toggleReportExpanded,
    // 资源工作视图的进度编辑口径（spec §9.1）：
    //   full  → 所有行（含未分配）
    //   collab → 只有 res 含我名字的行
    //   readonly → 无
    // 刻意比全局口径更窄：未分配任务在本页只读（认领请去甘特图）。
    // 注意这是"前端比服务端更严"：服务端 bar_owned 对 res:[] 是放行的，别误判成服务端漏判。
    canEditProgress: t => {
      const c = ctxOf(userStore.state);
      if (c.access === 'full') return true;
      if (c.access !== 'collab') return false;
      return !!t.res && t.res.includes(c.rname);
    }
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
      reqFilter: viewState.reqFilter,
      reqSort: viewState.reqSort,
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

  // ---- 历史需求元信息回填（自动、幂等）----
  // 打开页面就执行，不需要任何操作，也不弹提示。
  //
  // 安全边界全部在 core/backfill.js 的 isLegacyMeta 里：只处理「提出人 / 提出时间 /
  // 生命周期」三项目全空的需求 —— 这三项都是后加的，全空即说明该需求建于它们上线之前；
  // 而新建需求时弹窗会给默认提出时间（今天）与默认生命周期（待分析），因此不会被误补，
  // 用户以后新建需求时忘了填提出人也不会被静默盖上同一个名字。
  //
  // 也正因为判据落在数据本身，不需要任何"已回填"标记：补完后三项目都有值，
  // 下次启动自然是 0 条变更，天然幂等。
  function backfillRequirementMeta() {
    if (userStore.state.readonly) return;
    const plan = planRequirementBackfill(planStore.state.modules, {
      proposedBy: BACKFILL_PROPOSED_BY,
      today: new Date(),
      state: planStore.state
    });
    if (!plan.length) return;
    // updateModule 是 patch 语义（只传 oldName + 要改的字段），内部会走 assertEditable
    // 与归一化；save() 有 300ms 防抖，N 条只落盘一次
    plan.forEach(({ name, patch }) => sched.updateModule({ oldName: name, ...patch }));
    ui.onSyncStatus('ok', { msg: `已补全 ${plan.length} 个历史需求的提出信息与生命周期` });
  }

  // ---- 账号档案（role / resource_name）的本地兜底 ----
  // 为什么要缓存：access 完全由 role 与 resource_name 决定（resolveAccess）。
  // 档案接口一次瞬时失败就会让 prof 为 null → role 落到 'user'、resourceName 落到 '' →
  // 降级为只读，管理员/协作者被**静默**变成"什么都点不动"。
  // 旧逻辑里档案只影响"管理员徽标"，失败模式很轻；现在它决定写权限，必须兜住：
  // 失败时沿用**上一次成功**的身份（缓存在本机，按用户 id 隔离）；
  // 连缓存都没有才降为只读 —— 但那时必须明确告知，不能装作没发生。
  const PROFILE_CACHE_PREFIX = 'sched-profile-';
  function readCachedProfile(uid) {
    try {
      const raw = localStorage.getItem(PROFILE_CACHE_PREFIX + uid);
      const p = raw ? JSON.parse(raw) : null;
      return p && typeof p === 'object' ? p : null;
    } catch (e) { return null; }
  }
  function cacheProfile(uid, prof) {
    try {
      localStorage.setItem(PROFILE_CACHE_PREFIX + uid, JSON.stringify({
        role: prof.role || 'user',
        resource_name: prof.resource_name || ''
      }));
    } catch (e) { /* 隐私模式 / 配额满：缓存只是兜底，写不进去不影响主流程 */ }
  }

  // 档案加载失败的一句话说明（null = 没失败）。在 wireUI 之后由 initProject 提示一次。
  let profileNotice = null;

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
      // 台账 / 资源工作视图查询条件的持久化（页面在筛选/排序变化时调用）
      projectId,
      saveReqView,
      saveWorkFilter,
      setDayW: dw => { viewState.dayW = dw; },
      toggleReportExpanded,
      toggleReqExpanded,
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

    // 访问级别判定（设计文档 §5.1 / §8.2）：
    //   全权 = 管理员 或 本项目所属人
    //   协作 = 已登录 且 配了"对应人员"（profile.resource_name）
    //   只读 = 其余：游客、没配人名的登录用户
    // 没配人名降级为只读是刻意的：login.html 有公开自助注册入口，
    // 若"没配人名也能改需求/版本"，任何人注册一个账号就能动别人的需求。
    // owner_id 为空的历史项目不再一律放行，按上面的身份规则算（否则任何登录用户都能全权改）。
    const me = userStore.state.user;
    const isOwner = !!me && !!p && p.owner_id === me.id;
    const access = resolveAccess({
      role: me ? me.role : 'user',
      isOwner,
      resourceName: userStore.state.resourceName
    });
    userStore.set({ isOwner, access, readonly: access === ACCESS.READONLY });
    // access 就绪后立刻刷新两组按钮的灰化状态。
    // refreshUI 原本只在 enterReadonly / leaveReadonly 里被调，而协作者的 readonly === false
    // → 两个入口都不会走 → FULL_ONLY 那组（自动计划/撤销/导入/资源库）永远不会灰掉。
    // 必须在 wireUI 之前：wireUI 可能按只读状态装配组件，按钮状态要先生效。
    refreshReadonlyUI(document);

    // 显示服务器工具栏（返回列表 / 从服务器刷新）
    const serverGroup = document.getElementById('serverGroup');
    if (serverGroup) serverGroup.style.display = '';
    // body 标记：移动端「更多」弹层据此放出服务器相关操作（本地导出模式无此项）
    document.body.classList.add('with-server');

    // 组装组件层（此时 userStore.readonly 已确定）
    wireUI();
    // 档案加载失败必须说出来：access 全靠 role / resourceName，静默失败表现为
    // "我明明能用却什么都点不动"，排查成本极高。只提示一次（项目不存在时 initProject 会被调两次）。
    if (profileNotice) {
      const notice = profileNotice;
      profileNotice = null;
      if (ui && typeof ui.toast === 'function') ui.toast(notice);
      else if (ui) ui.onSyncStatus('fail', { msg: notice });
    }
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
      // 数据就位后再回填，避免在空数据上算出一堆空值
      backfillRequirementMeta();
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
        // 档案里的 role 与"对应人员"必须一起注入：任务级权限全靠 resource_name，
        // 少了它协作者会被降级成只读（表现为"我明明配了人名却什么都不能改"）。
        // role 同时写进 user.role（既有代码从这里读）和顶层 role（ctxOf 从这里读），别只写一处。
        // ⚠️ 必须看 error：以前只解构 data，接口一次瞬时失败就把 prof 当空 → 静默全局只读。
        const { data: prof, error: profErr } = await getProfile(user.id);
        let role = 'user';
        let rname = '';
        if (profErr || !prof) {
          const cached = readCachedProfile(user.id);
          role = (cached && cached.role) || 'user';
          rname = (cached && cached.resource_name) || '';
          profileNotice = cached
            ? '账号资料加载失败，已沿用上次的身份继续（权限不对请刷新页面）'
            : '账号资料加载失败，已暂时降为只读（请刷新重试）';
        } else {
          role = prof.role || 'user';
          rname = prof.resource_name || '';
          cacheProfile(user.id, prof);
        }
        userStore.set({
          user: { id: user.id, email: user.email || '', role },
          role,
          resourceName: rname
        });
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
  // 飞书模式不需要 Supabase 客户端：直接跳过，避免多打两个无效请求
  if (isFeishuEnabled()) return Promise.resolve();
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

// ============================================================
// src/views/work-view.js — 资源工作视图（按人汇总的任务清单）
//
// 与「工作组规划器」(res-view.js) 的分工 —— 两者都按人分块，但回答的问题不同：
//   规划器 = 时间轴视角：一个人一行，任务画在日历上 →「这段时间忙不忙、有没有撞车」
//   本页   = 清单视角：一个人一块，任务逐条列出（优先级 / 状态 / 日期 / 进度）
//            →「他手上到底有哪几件事、哪件该先干、哪件已经逾期」，且窄屏无需横向平移
//
// 形态：与总览 / 归档页同属"整页纵向文档"，共用 report-mode + report-wrap / report-sec /
// report-metrics（工具栏收敛靠 toolbar.js 的 body.work-view）。
//
// 口径（与顶部统计保持一致，不另算一套）：
//   · 只列阶段任务：里程碑是时间点不是"手里的活儿"，不占人日
//   · 状态用 core/mod-auto.js 的 taskStatus，逾期判定复用同一处的 isOverdueTask
//   · **归档需求的任务整条不列**：归档即视为已收口，不该再挂在某个人的待办里；
//     要看历史去「归档」页。指标与清单因此天然同口径（不需要再各过滤一次）
//   · 待排期需求的任务照常列出（日期还没排，但活已经登记了），不额外特殊处理
//   · 未分配任务单独一组：没人认领的活儿最容易漏，必须看得见
//
// 筛选（2026-09-21 增补）：本页最常见的用法是"员工查自己手里的活"，
// 所以筛选必须能一步定位到人 —— 人员下拉（含"未分配"）+ 状态/优先级多选 + 关键词。
// 判定逻辑在 core/work-filter.js（排期页与导出单文件共用同一套），本文件只负责画和分组。
// 筛选生效时**指标条跟随筛选**：否则顶部"12 项逾期"和下面只列 3 条对不上，用户会先怀疑数字。
//
// 纯渲染：返回 HTML 字符串，不绑定事件（事件委托见 components/work-filter.js）。
// ============================================================
import { F, fmtD } from '../core/dates.js';
import { PCOL, PNAME } from '../core/default-data.js';
import { archivedModSet } from '../core/mod-tag.js';
import { taskStatus, TASK_STATUS_RANK } from '../core/task-status.js';
import { priorityBadge } from './badge.js';
import {
  UNASSIGNED, WORK_PRI_OPTIONS, WORK_PRI_TEXT, WORK_STATE_OPTIONS,
  describeWorkFilter, filterWorkTasks, isWorkFilterActive, normalizeWorkFilter, personScope
} from '../core/work-filter.js';

// 单人之内的任务排序：先按状态（逾期 → 进行中 → 未开始 → 已完成），同状态按开始日先后。
// 逾期排最前是刻意的：这一页最常被用来回答"他现在该先处理哪一件"；
// 已完成沉到最后，它只需要"知晓"，不需要"处理"。
const byStatusThenDate = today => (a, b) => {
  const ra = TASK_STATUS_RANK[taskStatus(a, today).key] ?? 9;
  const rb = TASK_STATUS_RANK[taskStatus(b, today).key] ?? 9;
  if (ra !== rb) return ra - rb;
  return F(a.s) - F(b.s);
};

// 属性值 / 文本转义：关键词与人员名都来自用户输入，直接拼进 HTML 会破坏结构（甚至注入）
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// 单人统计：项数 / 人日 / 进行中 / 逾期
// 人日口径：把他参与的每个任务的人日各算一份（app 里人日是任务级的，没有按人分摊的模型）。
// 因此多人共同参与的任务，每人都会各记一份 —— 卡片上有 title 说明，别当"团队总人日"用。
function statOf(list, ctx) {
  const st = { n: list.length, work: 0, doing: 0, overdue: 0 };
  list.forEach(t => {
    if (t.s && t.e) st.work += ctx.workday.workDays(t.s, t.e);
    const k = taskStatus(t, ctx.today).key;
    if (k === 'doing') st.doing++;
    else if (k === 'overdue') st.overdue++;
  });
  return st;
}

// 筛选条：搜索框 + 人员下拉 + 状态/优先级多选 + 重置
// 全部用原生控件（input / select / button）—— 导出单文件里没有组件层，原生控件配事件委托最省事，
// 而且手机端自带原生选择器，比自绘下拉可靠。
function filterBar(filter, options, active) {
  const opts = options.map(o => {
    const sel = o.value === filter.person ? ' selected' : '';
    return `<option value="${esc(o.value)}"${sel}>${esc(o.text)}</option>`;
  }).join('');
  const chips = (dataAttr, val, list, label, dot) =>
    `<button type="button" class="rwk-f-chip${list.includes(val) ? ' on' : ''}" ${dataAttr}="${esc(val)}" title="只显示「${esc(label)}」的任务">${dot}${esc(label)}</button>`;
  const stateChips = WORK_STATE_OPTIONS.map(o =>
    chips('data-wk-state', o.key, filter.states, o.text, `<i style="background:${o.color}"></i>`)
  ).join('');
  const priChips = WORK_PRI_OPTIONS.map(p =>
    chips('data-wk-pri', p, filter.pris, WORK_PRI_TEXT[p] || p, '')
  ).join('');
  return `<div class="rwk-tools">
    <input class="rwk-f-q" type="search" data-wk-q value="${esc(filter.q)}" placeholder="搜索任务 / 需求 / 人" title="按任务名、阶段、需求名或人名过滤" aria-label="搜索任务">
    <select class="rwk-f-person" data-wk-person title="只看某个人手里的任务" aria-label="按人员筛选">${opts}</select>
    <span class="rwk-f-chips" role="group" aria-label="按状态筛选">${stateChips}</span>
    <span class="rwk-f-chips" role="group" aria-label="按优先级筛选">${priChips}</span>
    <button type="button" class="rwk-f-reset" data-wk-reset${active ? '' : ' disabled'} title="清除全部筛选条件">重置</button>
  </div>`;
}

// 单条任务：色条(阶段) + 任务名/所属需求 + 优先级 + 状态 + 日期人日 + 进度
// 名字一律允许换行（不省略号）：这一页就是用来核对"谁在做什么"的，截成「李…」等于没写
// 注意这里不判归档：归档需求的任务在进本页之前就已经被剔除了（见 renderWorkView 的口径过滤）
function taskRow(t, ctx, deps) {
  const pc = PCOL[t.p] || '#94a3b8';
  const phase = PNAME[t.p] || '任务';
  const name = (t.name || '').trim() || phase;      // 未自定义名时回退阶段名（与需求卡片一致）
  const st = taskStatus(t, ctx.today);
  const pct = Math.min(100, t.done || 0);
  const mc = (deps.modColors || {})[t.mod] || '#94a3b8';
  const work = (t.s && t.e) ? ctx.workday.workDays(t.s, t.e) : 0;
  const dates = (t.s && t.e) ? `${fmtD(F(t.s))}~${fmtD(F(t.e))}` : '未排期';
  // 进度填充色沿用全局口径：逾期=红(red-600)，其余=绿(green-600)（与排期总览/需求卡片同源）
  const fill = st.key === 'overdue' ? '#dc2626' : '#16a34a';
  return `<div class="rwk-row">
    <span class="steel" style="background:${pc}" title="阶段：${phase}"></span>
    <span class="rwk-main">
      <b class="rwk-name" title="${esc(phase)} · ${esc(name)}">${esc(name)}</b>
      ${name !== phase ? `<span class="rwk-phase" style="color:${pc};background:${pc}14;border-color:${pc}33">${esc(phase)}</span>` : ''}
      <span class="rwk-mod" title="所属需求：${esc(t.mod)}"><i class="mod-dot" style="background:${mc}"></i><span class="rwk-mod-t">${esc(t.mod)}</span></span>
      ${t.manual ? '<span class="rwk-chip" title="手工锁定日期，重排时不会自动调整">手动</span>' : ''}
    </span>
    <span class="rwk-pri">${priorityBadge(deps.modPri[t.mod])}</span>
    <span class="tag rwk-state" style="background:${st.color}" title="${esc(t.mod)} · ${esc(name)}：${st.text}">${st.text}</span>
    <span class="rwk-dates" title="${dates} · ${work} 人日">${dates}<i>${work} 人日</i></span>
    <span class="rwk-prog" title="完成度 ${pct}%"><span class="rwk-bar"><i style="width:${pct}%;background:${fill}"></i></span><b class="rwk-pct">${pct}%</b></span>
  </div>`;
}

// 人名的点击筛选入口：点一下只看这个人，再点一下回到全部 ——
// 手机端下拉不好用，这是"看自己"最快的路子（桌面同样好使）。
function nameButton(r, list, deps) {
  if (!list.length) return `<span class="rwk-pname">${esc(r.name)}</span>`;
  const on = deps.filter.person === r.name;
  return `<button type="button" class="rwk-pname${on ? ' on' : ''}" data-wk-pick="${esc(r.name)}" title="${on ? '取消筛选，回到全部人员' : `只看 ${esc(r.name)} 的任务`}">${esc(r.name)}</button>`;
}

// 一个人一块：头部（头像/姓名/角色/统计）+ 任务行
// workloadTip 说明人日口径，避免被误读成"团队总人日"
function personBlock(r, list, ctx, deps) {
  const av = `<span class="avatar" style="background:${r.color}">${esc(String(r.name || '?').slice(0, 1))}</span>`;
  const role = r.role ? `<span class="res-role">${esc(r.role)}</span>` : '';
  const nameHtml = nameButton(r, list, deps);
  if (!list.length) {
    return `<div class="rwk-person is-idle">
      <div class="rwk-ph">${av}${nameHtml}${role}<span class="rwk-pstat">暂无任务</span></div>
    </div>`;
  }
  const st = statOf(list, ctx);
  const rows = list.map(t => taskRow(t, ctx, deps)).join('');
  return `<div class="rwk-person">
    <div class="rwk-ph">${av}${nameHtml}${role}
      <span class="rwk-pstat" title="人日为参与任务的人日合计（同一任务多人参与时每人各计一份）"><b>${st.n}</b> 项任务<i>·</i><b>${st.work}</b> 人日${st.doing ? `<em class="is-doing">${st.doing} 项进行中</em>` : ''}${st.overdue ? `<em class="is-overdue">${st.overdue} 项逾期</em>` : ''}</span>
    </div>
    <div class="rwk-list">${rows}</div>
  </div>`;
}

// 未分配块：「没人认领」本身就是一个筛选维度，标题同样可点（点一下只看未分配）
function unassignedBlock(list, ctx, deps) {
  const on = deps.filter.person === UNASSIGNED;
  return `<div class="rwk-person is-unassigned">
    <div class="rwk-ph"><span class="avatar" style="background:#cbd5e1">?</span>
      <button type="button" class="rwk-pname${on ? ' on' : ''}" data-wk-pick="${UNASSIGNED}" title="${on ? '取消筛选，回到全部人员' : '只看还没有排人负责的任务'}">未分配</button>
      <span class="rwk-pstat" title="还没有排人负责的任务（不计入逾期口径）"><b>${list.length}</b> 项任务待认领</span></div>
    <div class="rwk-list">${list.map(t => taskRow(t, ctx, deps)).join('')}</div>
  </div>`;
}

export function renderWorkView(container, ctx) {
  const { state, sched, workday, today } = ctx;
  const resources = state.resources || [];
  const arch = archivedModSet(state.modules);
  const unsched = new Set((state.modules || []).filter(m => m.unscheduled).map(m => m.name));

  // 需求名 → 优先级：优先级挂在需求上（任务本身没有 pri），所以任务行显示的是"所属需求的优先级"
  const modPri = {};
  (state.modules || []).forEach(m => { if (m && m.name) modPri[m.name] = m.pri; });

  const filter = normalizeWorkFilter(ctx.workFilter);
  const filtering = isWorkFilterActive(filter);
  const scope = personScope(filter);
  const fDeps = { today, modPri };
  const deps = { modPri, modColors: ctx.modColors, filter };

  // 口径第一刀：归档需求的任务整条剔除（人只列"还要干的活"，指标与清单一次性同口径）。
  // 归档是软状态，数据仍留在 state.modules 里 —— 想看历史去「归档」页，本页不重复呈现。
  const archAll = sched.tasks() || [];
  const all = archAll.filter(t => !arch.has(t.mod));
  const archN = archAll.filter(t => !t.isMs && arch.has(t.mod)).length;
  // 里程碑（isMs）不是"手里的活儿"：0 天单点、没有人日，不进本页任何统计与清单
  const tasks = all.filter(t => !t.isMs);
  const assignedAll = tasks.filter(t => t.res && t.res.length);
  const unassignedAll = tasks.filter(t => !t.res || !t.res.length);

  // 筛选：先筛后分组 —— 指标、分组、排序全部基于同一份结果，避免"数字和列表对不上"
  const assigned = filterWorkTasks(assignedAll, filter, fDeps);
  const unassigned = filterWorkTasks(unassignedAll, filter, fDeps);

  // 归属：资源库顺序为准（与规划器一致，人员顺序用户自己排过，不要按任务数重排）
  const known = new Set(resources.map(r => r.name));
  // 兜底：任务上留着的人名已不在资源库里（删人/改名后残留），否则这些任务会在这页凭空消失。
  // 单独成块并标注，便于发现"人没了活还在"的脏数据。
  const orphanNames = [];
  assignedAll.forEach(t => t.res.forEach(n => { if (n && !known.has(n) && !orphanNames.includes(n)) orphanNames.push(n); }));
  const countOf = n => assignedAll.filter(t => t.res.includes(n)).length;

  // 人员下拉选项：资源库顺序 + 资源库外的残留人名（下拉里必须出现，否则筛到这个人时选不回来）
  const personOptions = [
    { value: '', text: '全部人员' },
    { value: UNASSIGNED, text: `未分配（${unassignedAll.length}）` },
    ...resources.map(r => ({ value: r.name, text: `${r.name}（${countOf(r.name)}）` })),
    ...orphanNames.map(n => ({ value: n, text: `${n}（资源库外 ${countOf(n)}）` }))
  ];
  // ?me=某人 深链指向的名字可能不在库里（人已删/改名）：补一个选项，否则下拉会显示空白，
  // 用户看到的是"筛选中但选不回来"，比筛不出结果更难解释
  if (filter.person && filter.person !== UNASSIGNED && !personOptions.some(o => o.value === filter.person)) {
    personOptions.push({ value: filter.person, text: `${filter.person}（不在资源库）` });
  }

  // ---- 分组渲染 ----
  // scope=person 时只渲染被选中的人；筛选生效时"一条都没命中"的人整块不渲染
  // （否则筛选"已逾期"会得到一屏「暂无任务」，把有效信息淹没）
  const wants = name => scope !== 'person' || filter.person === name;
  const blocks = [];
  if (scope !== 'unassigned') {
    resources.forEach(r => {
      if (!wants(r.name)) return;
      const list = assigned.filter(t => t.res.includes(r.name)).sort(byStatusThenDate(today));
      if (!list.length && filtering) return;
      blocks.push(personBlock(r, list, ctx, deps));
    });
    orphanNames.forEach(n => {
      if (!wants(n)) return;
      const list = assigned.filter(t => t.res.includes(n)).sort(byStatusThenDate(today));
      if (!list.length && filtering) return;
      blocks.push(personBlock({ name: n, role: '资源库外', color: '#cbd5e1' }, list, ctx, deps));
    });
  }
  if (scope !== 'person' && unassigned.length) {
    blocks.push(unassignedBlock(unassigned.sort(byStatusThenDate(today)), ctx, deps));
  }

  // 指标条：口径与渲染层一致（归档已在入口剔除），且**筛选生效时跟随筛选**（先筛后算）——
  // "看自己"时这排数字就是他本人的数字，而列表里正好是他那几条，两边不会打架
  const statTasks = assigned;
  const totalWork = statTasks.reduce((a, t) => a + ((t.s && t.e) ? workday.workDays(t.s, t.e) : 0), 0);
  const doingN = statTasks.filter(t => taskStatus(t, today).key === 'doing').length;
  const overdueN = statTasks.filter(t => taskStatus(t, today).key === 'overdue').length;
  // 「有任务人员」按"结果集里出现过的执行人"统计。
  // 例外：筛选到具体某人时这个口径会失真 —— 共享任务（如全员参与的回归验证）让每个人都"有任务"，
  // 于是"只看张三"却显示 8/8，看着像筛选没生效。此时问题的答案只有一个，直接给 1/0。
  const busy = scope === 'person'
    ? (assigned.length ? 1 : 0)
    : resources.filter(r => assigned.some(t => t.res.includes(r.name))).length;
  const desc = esc(describeWorkFilter(filter, fDeps));
  const hitN = assigned.length + unassigned.length;

  const head = `<div class="report-sec">
    <div class="report-head">资源工作视图<span>${filtering
      ? `已筛选：${desc} —— 指标与下方清单口径一致`
      : '按人汇总：每个人手里的任务、优先级、状态与进度（人员在资源库中维护）'}</span></div>
    <div class="report-metrics">
      <div class="rms-item" title="资源库共 ${resources.length} 人，其中 ${busy} 人手上有任务">
        <b>${busy}<i>/${resources.length}</i></b><span>有任务人员</span>
      </div>
      <div class="rms-item" title="已分配到人的阶段任务（不含里程碑、未分配任务与已归档需求）">
        <b>${statTasks.length}</b><span>人员任务</span>
      </div>
      <div class="rms-item" title="已分配任务的人日合计（不含已归档需求）">
        <b>${totalWork}</b><span>总人日</span>
      </div>
      <div class="rms-item" title="已开工未完成的任务">
        <b class="amber">${doingN}</b><span>进行中</span>
      </div>
      <div class="rms-item${overdueN ? ' is-alert' : ''}" title="已排人且结束日已过未完成（不含已归档需求）">
        <b class="red">${overdueN}</b><span>已逾期</span>
      </div>
      <div class="rms-item${unassigned.length ? ' is-alert' : ''}" title="还没有排人负责的任务">
        <b class="${unassigned.length ? 'red' : ''}">${unassigned.length}</b><span>未分配</span>
      </div>
    </div>
    <div class="rwk-legend">
      <span><i style="background:#ef4444"></i>已逾期</span>
      <span><i style="background:#f59e0b"></i>进行中</span>
      <span><i style="background:#94a3b8"></i>未开始</span>
      <span><i style="background:#10b981"></i>已完成</span>
      <span class="rwk-legend-hint">同一人内按「逾期 → 进行中 → 未开始 → 已完成」排序</span>
    </div>
  </div>`;

  // 全空：既没人手上活、也没有未分配任务 —— 给一句"下一步做什么"，别只留一张白卡片。
  // 但要区分"从来没排过任务"和"任务都已归档"：后者是正常收口，指引他去「归档」页而不是去建需求
  if (!assignedAll.length && !unassignedAll.length) {
    return `<div class="report-wrap">${head}
      <div class="report-sec">
        <div class="arch-empty">
          ${archN
            ? `<b>只剩归档需求了</b>
          <span>还有 ${archN} 项任务属于已归档需求，本页不再列出<br>要看它们去顶部的「归档」页；新建需求请去甘特图</span>`
            : `<b>还没有任何任务</b>
          <span>在甘特图里新建需求并添加任务，任务排上人之后就会出现在这里</span>`}
        </div>
      </div>
    </div>`;
  }

  const pendingN = unsched.size;
  const tools = filterBar(filter, personOptions, filtering);
  const listSub = filtering
    ? `已筛选出 ${hitN} 项 / 共 ${assignedAll.length + unassignedAll.length} 项任务 · ${desc}`
    : `共 ${resources.length + orphanNames.length} 人 · ${assignedAll.length} 项已分配任务${pendingN ? ` · 含 ${pendingN} 个待排期需求的任务（日期未排，仅供参考）` : ''}${archN ? ` · 已隐藏 ${archN} 项归档需求的任务` : ''}`;
  const listHead = `<div class="report-head">按人清单<span>${listSub}</span></div>`;

  // 筛选后一条都不剩：不是"没有任务"，而是"条件太紧" —— 两者要给出完全不同的下一步
  if (filtering && !blocks.length) {
    return `<div class="report-wrap">
      ${head}
      <div class="report-sec">
        ${listHead}
        ${tools}
        <div class="arch-empty">
          <b>没有符合筛选条件的任务</b>
          <span>当前条件：${desc}<br>放宽条件，或点「重置」看全部任务</span>
          <button type="button" class="rwk-f-reset-lg" data-wk-reset>重置筛选</button>
        </div>
      </div>
    </div>`;
  }

  return `<div class="report-wrap">
    ${head}
    <div class="report-sec">
      ${listHead}
      ${tools}
      <div class="rwk-people">${blocks.join('')}</div>
    </div>
  </div>`;
}

// ============================================================
// src/components/problem-drawer.js — 排期问题抽屉 + 顶部徽标
//
// 从 1112 行的 components/drawers.js 拆出。本模块负责三块互相关联的"提示类"UI：
//   1) 排期问题抽屉：列表渲染、悬停定位高亮、单条/一键自动处理
//   2) 问题数量徽标（桌面工具栏 + 移动端操作条两个位置同步）
//   3) 归档数量徽标（让"归档里有没有东西"不点进去也能看见）
//
// 徽标放在这里而不是各自的页面模块里：它们都是"按渲染刷新一次的数字提示"，
// 逻辑一模一样（取数 → 写两处 badge），放一起才不会一个改了另一个忘改。
// ============================================================
import { setPanel } from './drawer-shell.js';

const PROB_ICO = { overlap: '!', depend: '↗', overdue: '⌛', cycle: '∞' };

export function updateProblemBadge(deps) {
  const n = deps.sched.problems().length;
  // 桌面工具栏与移动端操作条各有一个徽标，保持同步
  ['probCount', 'probCountM'].forEach(id => {
    const badge = deps.getEl(id);
    if (!badge) return;
    badge.hidden = n === 0;
    badge.textContent = n;
  });
}

// 归档入口的数量徽标：让"归档里有没有东西"不点进去也能看见。
// 归档是个独立页面，没有徽标的话入口很容易被忽略（这正是它原先埋在页底无人问津的原因）。
export function updateArchiveBadge(deps) {
  const modules = (deps.planStore && deps.planStore.state && deps.planStore.state.modules) || [];
  const n = modules.filter(m => !!m.archived).length;
  ['archNavCount', 'archNavCountM'].forEach(id => {
    const badge = deps.getEl(id);
    if (!badge) return;
    badge.hidden = n === 0;
    badge.textContent = n;
  });
}

function locateTask(taskId, on, deps) {
  const el = deps.gantt ? deps.gantt.querySelector(`.bar[data-task-id="${taskId}"]`) : null;
  if (!el) return;
  if (on) {
    el.classList.add('locate');
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  } else {
    setTimeout(() => el.classList.remove('locate'), 120);
  }
}

export function renderProbList(deps) {
  const list = deps.getEl('probList');
  const countEl = deps.getEl('probDrawerCount');
  if (!list) return;
  const problems = deps.sched.problems();
  if (countEl) countEl.textContent = problems.length;
  if (!problems.length) {
    list.innerHTML = '<div class="empty-tip">当前没有排期问题<br>拖拽任务条 / 修改依赖 / 切换手动计划后会自动检测</div>';
    return;
  }
  list.innerHTML = problems.map(p => {
    const t = deps.sched.getTask(p.taskId);
    return `<div class="prob" data-task="${p.taskId}">
      <div class="prob-top"><span class="ico ${p.type}">${PROB_ICO[p.type] || '!'}</span>
        <span class="prob-name">${t ? deps.sched.nameOf(t) : '未知任务'}</span></div>
      <div class="prob-desc">${p.desc}</div>
      <div class="prob-actions">
        <button class="btn primary" data-act="auto" title="自动调整至依赖与资源可用时间">自动调整</button>
        <button class="btn ghost" data-act="ignore" title="保留现状并忽略此问题">忽略</button>
      </div></div>`;
  }).join('');
  list.querySelectorAll('.prob').forEach(item => {
    const taskId = item.dataset.task;
    item.addEventListener('mouseenter', () => locateTask(taskId, true, deps));
    item.addEventListener('mouseleave', () => locateTask(taskId, false, deps));
    item.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'auto') { deps.sched.resolveAuto(taskId); deps.toast('已自动调整排期'); }
        else { deps.sched.resolveIgnore(taskId); deps.toast('已忽略该问题'); }
        renderProbList(deps);
        updateProblemBadge(deps);
        deps.render();
      });
    });
    item.addEventListener('click', () => locateTask(taskId, true, deps));
  });
}

export function openProblemDrawer(deps) {
  setPanel('prob');
  const d = deps.getEl('probDrawer'), m = deps.getEl('drawerMask');
  if (d) d.classList.add('open');
  if (m) m.classList.add('show');
  renderProbList(deps);
}

// 装配入口：返回问题抽屉对外能力
export function bindProblemDrawer(deps) {
  return {
    openProblemDrawer: () => openProblemDrawer(deps),
    renderProbList: () => renderProbList(deps),
    updateProblemBadge: () => updateProblemBadge(deps),
    updateArchiveBadge: () => updateArchiveBadge(deps)
  };
}

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
import { notifyPinned } from '../utils/pinned.js';
import { userStore } from '../store/user-store.js';
import { ctxOf, canTouchTask } from '../utils/permission.js';

const PROB_ICO = { overlap: '!', depend: '↗', overdue: '⌛', cycle: '∞' };

// 需求名 → 需求对象（里程碑的编辑权按需求归属判）
function modOf(name, deps) {
  const mods = (deps.planStore && deps.planStore.state && deps.planStore.state.modules) || [];
  return mods.find(m => m.name === name) || null;
}

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

// 这条问题归不归我处理。与列表里是否渲染「自动调整 / 忽略」**同一个判据**：
// 两处各写一套的话，会出现"列表没有按钮、一键修复却改了它"的静默越权。
export function canFixProblem(taskId, deps) {
  const t = deps.sched.getTask(taskId);
  return t ? canTouchTask(t, modOf(t.mod, deps), ctxOf(userStore.state)) : false;
}

// 去重后的「我有权处理」任务 id（同一任务可能挂着多条问题）。
// 批量修复的范围就用它 —— Task 11 只收敛了单条，批量那一颗原本是"改全项目"。
export function fixableTaskIds(deps) {
  const seen = new Set();
  const out = [];
  deps.sched.problems().forEach(p => {
    if (seen.has(p.taskId)) return;
    seen.add(p.taskId);
    if (canFixProblem(p.taskId, deps)) out.push(p.taskId);
  });
  return out;
}

// 「全部自动调整」按钮的可操作状态：一条都改不了就置灰 + 说明原因。
// 置灰原因必须写出来 —— 「为什么这个按钮点不动」在界面上没有别的线索，
// 而这恰恰是协作者最常见的困惑（他看到问题列表里有内容，却以为是功能坏了）。
// 刻意**不用** .disabled class：那条规则带 pointer-events:none，鼠标扫不到元素，
// 浏览器就不会弹 title —— 置灰的同时把"为什么"藏起来，等于没解释。
// 因此改用 .unavailable（只降透明度、不禁指针），点击由守卫拦住并 toast 说明原因。
export function syncAutoFixAllBtn(deps) {
  const btn = deps.getEl('btnAutoFixAll');
  if (!btn) return;
  const total = deps.sched.problems().length;
  const mine = fixableTaskIds(deps).length;
  const off = mine === 0;
  btn.classList.toggle('unavailable', off);
  if (btn.setAttribute) btn.setAttribute('aria-disabled', off ? 'true' : 'false');
  btn.title = off
    ? (total === 0
        ? '当前没有排期问题'
        : '这些问题都不归你负责，无法一键调整；请联系任务负责人或项目所属人处理')
    : ('只处理归你负责的问题' + (mine < total ? `（当前 ${total} 条问题，其中 ${mine} 条的所属任务归你）` : ''));
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
  // 批量按钮的状态每次重绘都重算（问题列表变了，可处理范围随之变化）
  syncAutoFixAllBtn(deps);
  if (!problems.length) {
    list.innerHTML = '<div class="empty-tip">当前没有排期问题<br>拖拽任务条 / 修改依赖 / 切换手动计划后会自动检测</div>';
    return;
  }
  list.innerHTML = problems.map(p => {
    const t = deps.sched.getTask(p.taskId);
    // 处理动作会改这条任务本身 → 按归属判。别人的任务只显示问题描述，
    // 不渲染「自动调整 / 忽略」——渲染了再在事件里 return 会留下一个假的可点区域。
    const canFix = canFixProblem(p.taskId, deps);
    return `<div class="prob" data-task="${p.taskId}">
      <div class="prob-top"><span class="ico ${p.type}">${PROB_ICO[p.type] || '!'}</span>
        <span class="prob-name">${t ? deps.sched.nameOf(t) : '未知任务'}</span></div>
      <div class="prob-desc">${p.desc}</div>
      ${canFix ? `<div class="prob-actions">
        <button class="btn primary" data-act="auto" title="自动调整至依赖与资源可用时间">自动调整</button>
        <button class="btn ghost" data-act="ignore" title="保留现状并忽略此问题">忽略</button>
      </div>` : ''}</div>`;
  }).join('');
  list.querySelectorAll('.prob').forEach(item => {
    const taskId = item.dataset.task;
    item.addEventListener('mouseenter', () => locateTask(taskId, true, deps));
    item.addEventListener('mouseleave', () => locateTask(taskId, false, deps));
    item.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        const act = btn.dataset.act;
        // 「自动调整」会解锁本任务并重排其后置子图：协作者模式下遇到他人任务会把它钉成手动。
        // 以前这里无条件说"已自动调整排期"，实际上很可能是"别人的任务被我锁成了手动"——
        // 两种结果必须分开说，钉住时以钉住提示为准。
        if (act === 'auto') notifyPinned(deps, deps.sched.resolveAuto(taskId), '已自动调整排期');
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
    updateProblemBadge: () => updateProblemBadge(deps)
  };
}

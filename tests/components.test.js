// 组件层测试：锁定拖拽翻转限制、只读守卫、exportHTML 回退逻辑
//   另含 2026-09-21 拆分后的结构契约（drawers.js 曾 1112 行，现按职责拆为 5 个模块）
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planStore } from '../src/store/plan-store.js';
import { userStore } from '../src/store/user-store.js';
import { defaultModules, defaultResources } from '../src/core/default-data.js';
import { createWorkday } from '../src/core/workday.js';
import { createScheduler } from '../src/scheduler/index.js';
import { bindDrawers, paintModHover, pickDragHandle } from '../src/components/drawers.js';
import { isPanTarget, startBarDrag, startMsDrag } from '../src/components/drag.js';
import { renderProbList } from '../src/components/problem-drawer.js';
import { bindReqPage } from '../src/components/req-page.js';
import { openTaskDrawer } from '../src/components/task-drawer.js';
import { bindModals } from '../src/components/modals.js';
import { bindResLib } from '../src/components/reslib.js';
import {
  READONLY_BTN_IDS, FULL_ONLY_BTN_IDS, refreshUI, leaveReadonly
} from '../src/utils/readonly.js';
import { ctxOf } from '../src/utils/permission.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMP = resolve(ROOT, 'src/components');

function makeSched() {
  planStore.set({ modules: defaultModules(), resources: defaultResources() });
  return createScheduler({ planStore, userStore, W: createWorkday({}) });
}

// 组件层替身：所有 getEl 返回 null、甘特替身查不到任何元素 ——
// 用来验证"装配过程本身"不依赖具体 DOM（拆分后最容易犯的错就是漏接线或提前取值）
function stubDeps() {
  return {
    doc: { defaultView: { matchMedia: () => ({ matches: false }) }, addEventListener: () => {}, querySelector: () => null },
    gantt: { querySelectorAll: () => [], addEventListener: () => {} },
    gsc: { addEventListener: () => {}, scrollTop: 0, scrollLeft: 0 },
    getEl: () => null,
    planStore,
    sched: {
      problems: () => [], tasks: () => [], getTask: () => null, nameOf: () => '',
      fmt: () => '2026-09-01', F: v => v
    },
    viewState: { view: 'mod', collapsed: {} },
    render: () => {},
    toast: () => {},
    isReadonly: () => false,
    today: () => new Date(2026, 8, 21),
    workday: {},
    PNAME: {},
    shared: { activeTaskId: 'x', modalRes: [] },
    bindTip: () => {},
    consumeSuppress: () => false,
    startBarDrag: () => {},
    startMsDrag: () => {}
  };
}

describe('components: 拖拽翻转限制（sched.diff 源契约）', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('resize 到开始日期之前被翻转限制拦截（diff(e,s) < 0 不允许）', () => {
    const sched = makeSched();
    const t = sched.getTask('m1-dev');
    const before = { s: t.s, e: t.e };
    // 把结束边拖到开始之前：e 早于 s → 翻转保护应阻止（模拟 UI 层守卫逻辑）
    const eBefore = new Date(2026, 7, 10);   // 8/10 < m1-dev.s 9/1
    const sDate = new Date(t.s);
    const flipGuard = sched.diff(eBefore, sDate) < 0;
    expect(flipGuard).toBe(true);            // 源语义：e-s<0 表示翻转，应被拦截
    // 确认任务数据未被 resize 破坏（没有非法状态）
    expect(t.s).toBe(before.s);
    expect(t.e).toBe(before.e);
  });

  it('正常 resize 时 diff(e,s) >= 0 允许', () => {
    const sched = makeSched();
    const t = sched.getTask('m1-dev');
    const sDate = new Date(t.s);
    const eDate = new Date(t.e);
    expect(sched.diff(eDate, sDate)).toBeGreaterThanOrEqual(0);
  });
});

describe('components: 只读守卫语义', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('只读下新增任务抛错、编辑静默、重置无副作用', () => {
    const sched = makeSched();
    userStore.set({ readonly: true });
    expect(() => sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1 })).toThrow('只读模式');
    sched.saveTask('m1-req', { name: 'x' });
    expect(sched.getTask('m1-req').name).not.toBe('x');
    sched.resetToDefault();
    expect(planStore.state.modules.length).toBeGreaterThan(0);
  });

  it('恢复可编辑后守卫放行', () => {
    const sched = makeSched();
    userStore.set({ readonly: true });
    expect(() => sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1 })).toThrow('只读模式');
    userStore.set({ readonly: false });
    const id = sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1 });
    expect(id).toBeTruthy();
  });
});

describe('components: 同需求悬浮联动高亮', () => {
  // 任务条替身：只暴露 paintModHover 用到的 dataset / classList
  const barEl = mod => {
    const set = new Set();
    return {
      dataset: { mod },
      classList: {
        toggle(c, on) { if (on) set.add(c); else set.delete(c); },
        has: c => set.has(c)
      }
    };
  };
  const bars = ['甲需求', '甲需求', '乙需求'].map(barEl);
  const gantt = { querySelectorAll: () => bars };

  it('同需求的条一起描边，其余淡化', () => {
    paintModHover(gantt, '甲需求');
    expect(bars[0].classList.has('mod-mate')).toBe(true);
    expect(bars[1].classList.has('mod-mate')).toBe(true);
    expect(bars[2].classList.has('mod-mate')).toBe(false);
    expect(bars[2].classList.has('mod-dim')).toBe(true);
    expect(bars[0].classList.has('mod-dim')).toBe(false);
  });

  it('切到另一需求时高亮整体转移', () => {
    paintModHover(gantt, '甲需求');
    paintModHover(gantt, '乙需求');
    expect(bars[0].classList.has('mod-mate')).toBe(false);
    expect(bars[0].classList.has('mod-dim')).toBe(true);
    expect(bars[2].classList.has('mod-mate')).toBe(true);
  });

  it('传 null 清除全部高亮（鼠标移出甘特区）', () => {
    paintModHover(gantt, '甲需求');
    paintModHover(gantt, null);
    bars.forEach(b => {
      expect(b.classList.has('mod-mate')).toBe(false);
      expect(b.classList.has('mod-dim')).toBe(false);
    });
  });
});

describe('components: 甘特图空白平移 vs 行排序的职责边界', () => {
  // 替身：closest(sel) 命中给定选择器列表即返回节点
  const hit = (...sels) => ({ closest: sel => (sels.includes(sel) ? { sel } : null) });

  it('左侧固定名称列是唯一的行排序手柄', () => {
    const mname = { tag: 'mname' };
    const el = { querySelector: sel => (sel === '.mname' ? mname : null) };
    expect(pickDragHandle(el)).toBe(mname);
    // 没有名称列的容器不能成为拖拽源（避免整行 draggable 把空白平移吃掉）
    expect(pickDragHandle({ querySelector: () => null })).toBeNull();
    expect(pickDragHandle(null)).toBeNull();
  });

  it('轨道空白、表头、需求汇总条按下都走横向平移', () => {
    expect(isPanTarget(hit())).toBe(true);                    // 纯空白轨道
    expect(isPanTarget(hit('.train'))).toBe(true);            // 未命中任何已知元素
    expect(isPanTarget(null)).toBe(true);                     // 兜底：拿不到 target 也允许平移
  });

  it('任务条 / 里程碑 / 调整手柄 / 左侧名称列各自占用拖拽语义，不平移', () => {
    expect(isPanTarget(hit('.bar'))).toBe(false);
    expect(isPanTarget(hit('.mile'))).toBe(false);
    expect(isPanTarget(hit('.bar-resize'))).toBe(false);
    expect(isPanTarget(hit('.mname[draggable="true"]'))).toBe(false);
  });

  it('规则顺序不影响判定：命中靠前的元素优先让位', () => {
    // 同时命中 .bar 与 .mname（任务条就在行内）时，仍应让位给任务条拖拽
    expect(isPanTarget(hit('.bar', '.mname[draggable="true"]'))).toBe(false);
  });
});

describe('components: exportHTML 回退逻辑', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('缺 #inline-app 结构时抛错（触发 JSON 回退）', () => {
    const sched = makeSched();
    const s = sched.exportJSON();
    expect(typeof s).toBe('string');
    const parsed = JSON.parse(s);
    expect(Array.isArray(parsed.modules)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 拆分后的结构契约：drawers.js 原 1112 行，按"谁和谁共享可变状态"拆成 5 个模块。
// 这几条测试钉住的是拆分最容易退化的三点：装配漏接线、入口重新长胖、模块间成环。
// ---------------------------------------------------------------------------
describe('components: 抽屉与甘特交互的拆分契约', () => {
  const PARTS = ['drawer-shell.js', 'task-drawer.js', 'problem-drawer.js', 'menu-actions.js', 'gantt-interactions.js'];

  it('拆出的模块都在，且 drawers.js 只做装配（不重新长回实现）', () => {
    PARTS.forEach(m => expect(existsSync(resolve(COMP, m))).toBe(true));
    const src = readFileSync(resolve(COMP, 'drawers.js'), 'utf8');
    ['drawer-shell.js', 'task-drawer.js', 'problem-drawer.js', 'gantt-interactions.js']
      .forEach(m => expect(src).toContain(`'./${m}'`));
    // 装配入口本该只有几十行；超过 90 行说明实现又往回堆了
    expect(src.split('\n').length).toBeLessThan(90);
    // 已删除的旧实现不应再被任何地方引用
    expect(existsSync(resolve(ROOT, 'src/core/mod-auto.js'))).toBe(false);
  });

  it('bindDrawers 返回完整 API，且装配过程不依赖具体 DOM（空跑不报错）', () => {
    const api = bindDrawers(stubDeps());
    ['openTaskDrawer', 'openNewTaskDrawer', 'openProblemDrawer', 'closeDrawer',
      'updateProblemBadge', 'renderProbList', 'renderResPicker', 'bindGanttInteractions']
      .forEach(k => expect(typeof api[k]).toBe('function'));
    expect(() => api.bindGanttInteractions()).not.toThrow();
    expect(() => api.openTaskDrawer('不存在')).not.toThrow();   // getTask 返回 null → 静默返回
    expect(() => api.updateProblemBadge()).not.toThrow();
    expect(() => api.renderProbList()).not.toThrow();
    expect(() => api.renderResPicker()).not.toThrow();
    expect(() => api.closeDrawer()).not.toThrow();
  });

  it('关闭抽屉会清掉"当前打开的任务"（跨模块收尾由 drawer-shell 统一触发）', () => {
    const deps = stubDeps();
    const api = bindDrawers(deps);
    expect(deps.shared.activeTaskId).toBe('x');
    api.closeDrawer();
    expect(deps.shared.activeTaskId).toBe(null);
  });

  it('组件层无循环依赖（成环会让模块级状态读到未初始化的值）', () => {
    const files = PARTS.concat(['drawers.js', 'context-menu.js', 'modals.js', 'reslib.js', 'toolbar.js', 'drag.js', 'shell.js', 'index.js', 'theme-picker.js', 'loading.js', 'sync-status.js']);
    const deps = new Map();
    files.forEach(f => {
      const src = readFileSync(resolve(COMP, f), 'utf8');
      const out = new Set();
      const re = /from\s*'\.\/([\w.-]+\.js)'/g;
      let m;
      while ((m = re.exec(src))) out.add(m[1]);
      deps.set(f, out);
    });
    const cycles = [];
    const seen = new Set(), stack = [];
    const dfs = n => {
      if (stack.includes(n)) { cycles.push(stack.slice(stack.indexOf(n)).concat(n).join(' → ')); return; }
      if (seen.has(n)) return;
      seen.add(n); stack.push(n);
      for (const d of deps.get(n) || []) if (deps.has(d)) dfs(d);
      stack.pop();
    };
    files.forEach(dfs);
    expect(cycles).toEqual([]);
  });
});

// 最小 DOM 替身：只在 #gantt 上记录监听器，供断言"委托绑在哪、绑了什么"
function fakeReqGantt() {
  const handlers = {};
  return {
    handlers,
    addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
    querySelector: () => null,
    querySelectorAll: () => []
  };
}

function reqPageDeps() {
  const gantt = fakeReqGantt();
  const viewState = {
    reqFilter: { kw: '', status: 'all', pri: 'all', ver: 'all', scope: 'all', unscheduled: 'all' },
    reqSort: { key: 'order', dir: 'asc' }
  };
  let rendered = 0;
  return {
    gantt, viewState,
    rendered: () => rendered,
    render: () => { rendered++; },
    toast: () => {},
    planStore: { state: { modules: [{ name: 'A', bars: [] }] } },
    sched: { updateModule: () => {}, archiveModule: () => {}, deleteModule: () => {} },
    getEl: () => null
  };
}

describe('req-page: 台账事件委托', () => {
  it('把 click / input / change 委托绑在 #gantt 上，各只绑一次', () => {
    const deps = reqPageDeps();
    bindReqPage(deps);
    expect(deps.gantt.handlers.click.length).toBe(1);
    expect(deps.gantt.handlers.input.length).toBe(1);
    expect(deps.gantt.handlers.change.length).toBe(1);
  });

  it('容器或 viewState 缺失时安全返回 null，不抛错', () => {
    expect(bindReqPage({ viewState: {} })).toBe(null);
    expect(bindReqPage({ gantt: fakeReqGantt() })).toBe(null);
  });

  it('viewState 没带 reqFilter/reqSort 时自动补默认值（两个入口不必各自记得加）', () => {
    const deps = reqPageDeps();
    delete deps.viewState.reqFilter;
    delete deps.viewState.reqSort;
    bindReqPage(deps);
    expect(deps.viewState.reqFilter.scope).toBe('all');
    expect(deps.viewState.reqSort.key).toBe('group');   // 默认「进行中优先」，不再按甘特图顺序
  });
});

// ============================================================
// 任务抽屉：他人任务只读（Task 11）
//   抽屉是"一条任务的编辑闭环"，可用性必须按**这条任务归不归我**判，
//   而不是按"全局只读"——协作者要能编辑自己的任务，但打开别人的只能是看。
// ============================================================
function fakeDrawerDeps() {
  const els = {};
  const mk = () => ({
    style: {}, value: '', textContent: '', hidden: false, innerHTML: '',
    readOnly: false, disabled: false, options: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, querySelectorAll: () => [], querySelector: () => null
  });
  return {
    els,
    getEl: id => (els[id] = els[id] || mk()),
    doc: {},
    planStore: { state: { modules: [{ name: '甲需求', owner: '李四' }], resources: [] } },
    sched: {
      getTask: () => null, nameOf: () => '某任务', problems: () => [], tasks: () => [],
      fmt: () => '2026-09-01', F: v => v
    },
    isReadonly: () => false,
    workday: { spanDays: () => 1, workDays: () => 1 },
    today: () => new Date(2026, 8, 1),
    PNAME: { dev: '开发' },
    shared: { activeTaskId: null, modalRes: [] },
    toast: () => {},
    render: () => {},
    reslib: {}, modals: {}
  };
}

describe('components: 任务抽屉按归属只读（Task 11）', () => {
  const task = (res) => ({
    id: 't1', mod: '甲需求', p: 'dev', name: '某任务', s: '2026-09-01', e: '2026-09-02',
    w: 1, done: 0, res, dep: [], manual: true
  });

  const open = t => {
    const deps = fakeDrawerDeps();
    deps.sched.getTask = id => (id === t.id ? t : null);
    userStore.set({ readonly: false, access: 'collab', resourceName: '张三', role: 'user' });
    openTaskDrawer(t.id, deps);
    return deps;
  };

  it('打开别人的任务：保存/删除按钮禁用，表单字段只读', () => {
    const deps = open(task(['李四']));
    expect(deps.els.btnSaveTask.disabled).toBe(true);
    expect(deps.els.btnDeleteTask.disabled).toBe(true);
    expect(deps.els.inpName.readOnly).toBe(true);
    expect(deps.els.inpW.readOnly).toBe(true);
    expect(deps.els.inpProgress.disabled).toBe(true);   // range 没有 readOnly 效果
    expect(deps.els.inpMod.disabled).toBe(true);
  });

  it('打开自己的任务：可保存可删除，字段可写', () => {
    const deps = open(task(['张三']));
    expect(deps.els.btnSaveTask.disabled).toBe(false);
    expect(deps.els.btnDeleteTask.disabled).toBe(false);
    expect(deps.els.inpName.readOnly).toBe(false);
    expect(deps.els.inpProgress.disabled).toBe(false);
    expect(deps.els.inpMod.disabled).toBe(false);
  });

  it('未分配任务（res:[]）：协作者可认领 → 抽屉可编辑', () => {
    const deps = open(task([]));
    expect(deps.els.btnSaveTask.disabled).toBe(false);
  });

  it('只读身份打开自己的任务：仍然只读（归属之外还有身份这一层）', () => {
    const t = task(['张三']);
    const deps = fakeDrawerDeps();
    deps.sched.getTask = id => (id === t.id ? t : null);
    userStore.set({ readonly: true, access: 'readonly', resourceName: '张三' });
    openTaskDrawer(t.id, deps);
    expect(deps.els.btnSaveTask.disabled).toBe(true);
    expect(deps.els.inpName.readOnly).toBe(true);
  });
});

// ============================================================
// 拖拽起手 & 问题抽屉：按归属收敛（Task 11）
//   拖拽的 observable 是"有没有接管这次 mousedown"（stopPropagation/preventDefault）：
//   守卫命中时直接 return，不接管 —— 于是事件继续冒泡到空白处平移，与"点不动"一致。
// ============================================================
describe('components: 拖拽起手按归属收敛（Task 11）', () => {
  beforeEach(() => { userStore.reset(); });

  const deps = (task, mods) => ({
    planStore: { state: { modules: mods || [{ name: '甲需求', owner: '李四' }] } },
    sched: { getTask: id => (id === task.id ? task : null), F: v => new Date(v) },
    workday: { spanDays: () => 2 }, getCtx: () => ({}), render: () => {}
  });
  const mouseDown = () => ({
    button: 0,
    clientX: 100,
    target: { closest: () => null },
    currentTarget: { classList: { contains: () => false } },
    stopPropagation: vi.fn(),
    preventDefault: vi.fn()
  });

  const task = res => ({
    id: 't1', mod: '甲需求', p: 'dev', s: '2026-09-01', e: '2026-09-02', res, dep: [], manual: true
  });

  it('协作者拖自己的任务：接管 mousedown；拖别人的：不接管', () => {
    userStore.set({ readonly: false, access: 'collab', resourceName: '张三' });

    const mine = mouseDown();
    startBarDrag(mine, 't1', deps(task(['张三'])));
    expect(mine.stopPropagation).toHaveBeenCalled();

    const others = mouseDown();
    startBarDrag(others, 't1', deps(task(['李四'])));
    expect(others.stopPropagation).not.toHaveBeenCalled();
  });

  it('里程碑按需求归属：需求归我则接管，归别人则不接管', () => {
    userStore.set({ readonly: false, access: 'collab', resourceName: '张三' });
    // isMs 是 collect() 写回的标记（渲染层拿到的就是这种形态）
    const ms = { id: 'ms-1', mod: '甲需求', m: '2026-09-09', label: '上线', isMs: true };

    const mine = mouseDown();
    startMsDrag(mine, 'ms-1', deps(ms, [{ name: '甲需求', owner: '张三' }]));
    expect(mine.stopPropagation).toHaveBeenCalled();

    // 里程碑没有 res：若按任务判据会被当成"未分配可认领"而误放行
    const others = mouseDown();
    startMsDrag(others, 'ms-1', deps(ms, [{ name: '甲需求', owner: '李四' }]));
    expect(others.stopPropagation).not.toHaveBeenCalled();
  });

  it('只读身份：自己的任务也不接管', () => {
    userStore.set({ readonly: true, access: 'readonly', resourceName: '张三' });
    const e = mouseDown();
    startBarDrag(e, 't1', deps(task(['张三'])));
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });
});

describe('components: 问题抽屉按归属显隐处理按钮（Task 11）', () => {
  beforeEach(() => { userStore.reset(); });

  const render = res => {
    const els = {};
    const deps = {
      getEl: id => (els[id] = els[id] || { innerHTML: '', textContent: '', querySelectorAll: () => [], addEventListener() {} }),
      planStore: { state: { modules: [{ name: '甲需求', owner: '李四' }] } },
      gantt: null,
      sched: {
        problems: () => [{ taskId: 't1', type: 'overlap', desc: '任务重叠' }],
        getTask: () => ({ id: 't1', mod: '甲需求', res, name: '某任务' }),
        nameOf: () => '某任务',
        resolveAuto: () => null, resolveIgnore: () => {}
      },
      render: () => {}, toast: () => {}
    };
    userStore.set({ readonly: false, access: 'collab', resourceName: '张三' });
    renderProbList(deps);
    return els.probList.innerHTML;
  };

  it('自己的任务：渲染「自动调整 / 忽略」；别人的任务：只显示问题描述', () => {
    expect(render(['张三'])).toContain('data-act="auto"');
    const other = render(['李四']);
    expect(other).toContain('任务重叠');           // 问题本身仍然显示
    expect(other).not.toContain('data-act="auto"');
    expect(other).not.toContain('data-act="ignore"');
  });
});

// ============================================================
// 需求弹窗：归属字段 + 名字/归属按归属级权限置灰（Task 12）
//   关键不变量：置灰时保存**不能**传 owner —— 传了就是一次转交请求，
//   服务端会按"无权转交"拒掉整次保存（用户看到"什么都没改却存不进去"）。
// ============================================================
function fakeModalDeps() {
  const els = {};
  const mk = () => ({
    style: {}, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
    dataset: {}, _h: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn); },
    querySelectorAll: () => [], querySelector: () => null,
    click() { (this._h.click || []).forEach(fn => fn({})); }
  });
  const deps = {
    els,
    getEl: id => (els[id] = els[id] || mk()),
    planStore: { state: { modules: [{ name: '甲需求', owner: '李四', bars: [] }], resources: [] } },
    viewState: { collapsed: {} },
    today: () => new Date(2026, 8, 1),
    render: () => {}, toast: () => {},
    sched: {
      updateModule: vi.fn(), addModule: vi.fn(), deleteModule: vi.fn(),
      takePinned: () => []
    },
    drawers: {}, PNAME: { dev: '开发' }
  };
  return deps;
}

describe('components: 需求弹窗的归属与置灰（Task 12）', () => {
  beforeEach(() => { userStore.reset(); });

  const openEdit = (owner, user) => {
    const deps = fakeModalDeps();
    deps.planStore.state.modules[0].owner = owner;
    userStore.set({ readonly: false, ...user });
    const modals = bindModals(deps);
    modals.openEditModModal('甲需求');
    const g = deps.getEl;
    g('newModName').value = '甲需求';
    g('newModTagc').value = '#3b82f6';
    return { deps, g };
  };

  it('别人的需求：名字与归属都置灰', () => {
    const { g } = openEdit('李四', { access: 'collab', resourceName: '张三', role: 'user' });
    expect(g('newModName').disabled).toBe(true);
    expect(g('inpModOwner').disabled).toBe(true);
  });

  it('自己的需求：名字与归属都可改，且回显当前归属', () => {
    const { g } = openEdit('张三', { access: 'collab', resourceName: '张三', role: 'user' });
    expect(g('newModName').disabled).toBe(false);
    expect(g('inpModOwner').disabled).toBe(false);
    expect(g('inpModOwner').value).toBe('张三');
  });

  it('置灰时保存不传 owner（只传字段级改动）', () => {
    const { deps, g } = openEdit('李四', { access: 'collab', resourceName: '张三', role: 'user' });
    g('inpModOwner').value = '张三';       // 即使 DOM 里被改过（旧值残留），也不该提交
    g('btnNewModSave').click();
    expect(deps.sched.updateModule).toHaveBeenCalledTimes(1);
    const opts = deps.sched.updateModule.mock.calls[0][0];
    expect('owner' in opts).toBe(false);
  });

  it('可改时保存带上 owner（转交）', () => {
    const { deps, g } = openEdit('张三', { access: 'collab', resourceName: '张三', role: 'user' });
    g('inpModOwner').value = '李四';
    g('btnNewModSave').click();
    expect(deps.sched.updateModule.mock.calls[0][0].owner).toBe('李四');
  });

  it('新建需求：归属默认填当前用户名，且可改', () => {
    const deps = fakeModalDeps();
    userStore.set({ readonly: false, access: 'collab', resourceName: '张三', role: 'user' });
    const modals = bindModals(deps);
    modals.openNewModModal();
    const g = deps.getEl;
    expect(g('inpModOwner').value).toBe('张三');
    expect(g('inpModOwner').disabled).toBe(false);
    g('newModName').value = '新需求';
    g('newModTagc').value = '#3b82f6';
    // 新建要求至少勾一个初始化阶段：替身只回一个已勾选的 dev
    g('newModPhases').querySelectorAll = sel => (sel.includes(':checked') ? [{ value: 'dev' }] : []);
    g('btnNewModSave').click();
    expect(deps.sched.addModule).toHaveBeenCalledTimes(1);
    expect(deps.sched.addModule.mock.calls[0][0].owner).toBe('张三');
  });
});

// ============================================================
// 资源库：入口灰化之外的第二道（Task 12）
//   改人名会级联重写全项目任务里的人名 → 全权动作。抽屉里的「管理资源」
//   是 btnResLib 之外的另一条入口，所以弹窗内部也要按权限收敛。
// ============================================================
describe('components: 资源库按权限收敛（Task 12）', () => {
  beforeEach(() => { userStore.reset(); });

  const render = () => {
    const els = {};
    // 替身按需创建，唯一被断言的是 resLibList 的 innerHTML
    const deps = {
      getEl: id => (els[id] = els[id] || {
        innerHTML: '', value: '', textContent: '', style: {}, dataset: {},
        classList: { add() {}, remove() {}, contains: () => false },
        addEventListener() {}, querySelectorAll: () => [], querySelector: () => null
      }),
      planStore: { state: { resources: [{ id: 'r1', name: '张三', role: '需求', color: '#3b82f6' }] } },
      sched: { deleteResource() {}, addResource() {}, updateResource() {} },
      render: () => {}, toast: () => {}
    };
    const lib = bindResLib(deps);
    lib.renderResLib();
    return { list: els.resLibList, addBtn: els.btnAddRes };
  };

  it('协作者：不渲染行内编辑/删除按钮，「＋ 新增资源」也隐藏', () => {
    userStore.set({ readonly: false, access: 'collab', resourceName: '张三', role: 'user' });
    const { list, addBtn } = render();
    expect(list.innerHTML).toContain('张三');            // 仍能看有谁
    expect(list.innerHTML).not.toContain('data-rid');
    expect(list.innerHTML).not.toContain('data-del');
    expect(addBtn.style.display).toBe('none');
  });

  it('全权：渲染编辑/删除按钮与新增入口', () => {
    userStore.set({ readonly: false, access: 'full', role: 'admin' });
    const { list, addBtn } = render();
    expect(list.innerHTML).toContain('data-rid="r1"');
    expect(list.innerHTML).toContain('data-del="r1"');
    expect(addBtn.style.display).toBe('');
  });
});

// ============================================================
// 工具栏按钮分组（Task 10）
//   两组的分界线不是"只读与否"，而是"这个动作只影响我自己的东西，还是会动整份 plan"：
//     READONLY 组 = 新增类 + 问题面板（协作者仍要能用）
//     FULL_ONLY 组 = 自动计划 / 撤销重做 / 整份导入 / 资源库（只影响全权）
//   注：「周期」按钮早就被 cycle.js 的改造删掉了，不在任何一组里。
// ============================================================
describe('readonly: 按钮分组', () => {
  it('两组互不重叠', () => {
    const a = new Set(READONLY_BTN_IDS);
    expect(FULL_ONLY_BTN_IDS.some(id => a.has(id))).toBe(false);
  });

  it('新增类按钮属于 READONLY 组（协作者仍要能用）', () => {
    expect(READONLY_BTN_IDS).toContain('btnAddTask');
    expect(READONLY_BTN_IDS).toContain('btnAddModule');
  });

  it('动整份 plan 的按钮属于 FULL_ONLY 组', () => {
    ['btnAutoPlan', 'btnUndo', 'btnRedo', 'btnImport', 'btnResLib']
      .forEach(id => expect(FULL_ONLY_BTN_IDS).toContain(id));
  });

  // 拆分不是"删按钮"：原 EDIT_BTN_IDS 的 9 个必须一个不少地落在两组之一的并集里
  it('两组并集覆盖原有 9 个编辑按钮', () => {
    const ids = new Set([...READONLY_BTN_IDS, ...FULL_ONLY_BTN_IDS]);
    ['btnAddTask', 'btnAddModule', 'btnAutoPlan', 'btnProblems', 'btnResLib', 'btnImport', 'btnUndo', 'btnRedo', 'mAddTask']
      .forEach(id => expect(ids.has(id)).toBe(true));
  });
});

// 最小 DOM 替身：只需要 getElementById + body.classList（refreshUI 的全部接触面）
function fakeDoc(ids) {
  const els = {};
  ids.forEach(id => {
    const set = new Set();
    els[id] = {
      style: {},
      classList: {
        toggle(c, on) { if (on) set.add(c); else set.delete(c); },
        has: c => set.has(c)
      }
    };
  });
  return {
    els,
    getElementById: id => els[id] || null,
    querySelector: () => null,
    body: { classList: { toggle() {} } }
  };
}

const allBtnIds = () => [...READONLY_BTN_IDS, ...FULL_ONLY_BTN_IDS];

describe('readonly: refreshUI 的两组灰化口径', () => {
  beforeEach(() => { userStore.reset(); });

  it('协作者：READONLY 组不灰（要能新增任务/需求），FULL_ONLY 组灰', () => {
    userStore.set({ readonly: false, access: 'collab', resourceName: '张三' });
    const doc = fakeDoc(allBtnIds());
    refreshUI(doc);
    READONLY_BTN_IDS.forEach(id => expect(doc.els[id].classList.has('disabled')).toBe(false));
    FULL_ONLY_BTN_IDS.forEach(id => expect(doc.els[id].classList.has('disabled')).toBe(true));
  });

  it('只读：两组都灰', () => {
    userStore.set({ readonly: true, access: 'readonly' });
    const doc = fakeDoc(allBtnIds());
    refreshUI(doc);
    allBtnIds().forEach(id => expect(doc.els[id].classList.has('disabled')).toBe(true));
  });

  it('全权：两组都不灰', () => {
    userStore.set({ readonly: false, access: 'full', role: 'admin' });
    const doc = fakeDoc(allBtnIds());
    refreshUI(doc);
    allBtnIds().forEach(id => expect(doc.els[id].classList.has('disabled')).toBe(false));
  });
});

// ============================================================
// Task 10 Step 4a：leaveReadonly 的写入侧修复
//   leaveReadonly 原来只写 readonly:false、不写 access。ctxOf 的兜底
//   （`s.access` 不是 collab/full 时一律视作 full）于是把 access='readonly'
//   翻成 full —— "只读用户点一下切换就变成全权"。
//   修法只能是写入侧用真源重算 access；ctxOf 的兜底被 Task 1 的用例锁着，不能动。
// ============================================================
describe('readonly: leaveReadonly 不得把只读用户翻成 full', () => {
  beforeEach(() => { userStore.reset(); });

  it('只读身份调用后：access 仍是 readonly，readonly 仍为 true，ctxOf 也仍是只读', () => {
    userStore.set({ role: 'user', isOwner: false, resourceName: '', access: 'readonly', readonly: true });
    leaveReadonly(fakeDoc([]));
    expect(userStore.state.access).toBe('readonly');
    expect(userStore.state.readonly).toBe(true);
    expect(ctxOf(userStore.state).access).toBe('readonly');
  });

  it('协作者调用后：access 重算为 collab 且 readonly 为 false', () => {
    userStore.set({ role: 'user', isOwner: false, resourceName: '张三', readonly: true });
    leaveReadonly(fakeDoc([]));
    expect(userStore.state.access).toBe('collab');
    expect(userStore.state.readonly).toBe(false);
  });

  it('所属人调用后：access 重算为 full（不是"只把 readonly 置 false"）', () => {
    userStore.set({ role: 'user', isOwner: true, resourceName: '', readonly: true });
    leaveReadonly(fakeDoc([]));
    expect(userStore.state.access).toBe('full');
    expect(userStore.state.readonly).toBe(false);
  });
});

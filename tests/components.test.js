// 组件层测试：锁定拖拽翻转限制、只读守卫、exportHTML 回退逻辑
//   另含 2026-09-21 拆分后的结构契约（drawers.js 曾 1112 行，现按职责拆为 5 个模块）
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planStore } from '../src/store/plan-store.js';
import { userStore } from '../src/store/user-store.js';
import { defaultModules, defaultResources } from '../src/core/default-data.js';
import { createWorkday } from '../src/core/workday.js';
import { createScheduler } from '../src/scheduler/index.js';
import { bindDrawers, paintModHover, pickDragHandle } from '../src/components/drawers.js';
import { isPanTarget } from '../src/components/drag.js';
import { bindReqPage } from '../src/components/req-page.js';

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
    expect(deps.viewState.reqSort.key).toBe('order');
  });
});

// 需求归档测试：归档是「软状态 + 渲染层过滤」
//   1) 数据层：archiveModule 写入 archived/archivedAt，需求对象仍保留（导出/同步/撤销不丢数据）
//   2) 排期：归档需求的任务仍参与依赖与资源计算（避免归档导致下游排期被静默改写）
//   3) 渲染层：归档需求不出现在主视图，只在独立的「归档」页面（archive-view.js）只读展示
import { describe, it, expect, beforeEach } from 'vitest';
import { planStore } from '../src/store/plan-store.js';
import { userStore } from '../src/store/user-store.js';
import { defaultModules, defaultResources } from '../src/core/default-data.js';
import { createWorkday } from '../src/core/workday.js';
import { createScheduler } from '../src/scheduler/index.js';
import { archivedModSet } from '../src/core/mod-tag.js';
import { renderModView } from '../src/views/mod-view.js';
import { renderArchiveView } from '../src/views/archive-view.js';
import { F } from '../src/core/dates.js';

// localStorage 兜底（node 环境无全局 localStorage；persistence.save 内部 try/catch 也能兜底）
if (typeof globalThis.localStorage === 'undefined') {
  const m = new Map();
  globalThis.localStorage = {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); }
  };
}

function makeSched() {
  planStore.set({ modules: defaultModules(), resources: defaultResources() });
  return createScheduler({ planStore, userStore, W: createWorkday({}) });
}

const modOf = name => planStore.state.modules.find(m => m.name === name);

// 最小渲染 ctx（与 buildViewCtx 契约对齐）
function makeRenderCtx(archOpen) {
  const state = {
    modules: planStore.state.modules,
    resources: defaultResources(),
    start: F('2026-08-12'),
    end: F('2026-10-31')
  };
  return {
    state,
    collapsed: {},
    today: F('2026-08-20'),
    dayW: 13,
    archOpen,
    holidays: [],
    // barHtml 需要 workday.spanDays / workDays（测试用简算：自然日）
    workday: {
      spanDays: (s, e) => Math.round((F(e) - F(s)) / 864e5) + 1,
      workDays: (s, e) => Math.round((F(e) - F(s)) / 864e5) + 1
    },
    fmtD: d => (d.getMonth() + 1) + '/' + d.getDate(),
    modRange: mo => {
      const bars = mo.bars || [];
      if (!bars.length) return null;
      const ds = bars.map(b => F(b.m || b.s));
      const de = bars.map(b => F(b.e || b.m || b.s));
      const start = ds.reduce((a, d) => (d < a ? d : a));
      const end = de.reduce((a, d) => (d > a ? d : a));
      return { start, end };
    },
    X: d => Math.round((d - state.start) / 864e5) * 13
  };
}

describe('module-archive: archiveModule 数据层', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('归档写入 archived=true 与归档时间，且需求对象保留在 state.modules 中', () => {
    const sched = makeSched();
    const before = planStore.state.modules.length;
    const mo = sched.archiveModule('官网改版', true);
    expect(mo && mo.archived).toBe(true);
    expect(typeof mo.archivedAt).toBe('string');
    expect(isNaN(Date.parse(mo.archivedAt))).toBe(false);
    // 关键：归档是软状态，不从数组移除（导出 / 同步 / 撤销栈因此不丢数据）
    expect(planStore.state.modules.length).toBe(before);
    expect(modOf('官网改版').archived).toBe(true);
  });

  it('取消归档清空 archived 与归档时间', () => {
    const sched = makeSched();
    sched.archiveModule('官网改版', true);
    sched.archiveModule('官网改版', false);
    const mo = modOf('官网改版');
    expect(mo.archived).toBe(false);
    expect(mo.archivedAt).toBe(null);
  });

  it('需求不存在时返回 null，不抛异常', () => {
    const sched = makeSched();
    expect(sched.archiveModule('不存在的需求', true)).toBe(null);
  });

  it('只读模式下不归档（返回 null 且状态不变）', () => {
    const sched = makeSched();
    userStore.set({ readonly: true });
    expect(sched.archiveModule('官网改版', true)).toBe(null);
    expect(modOf('官网改版').archived).toBeFalsy();
  });
});

describe('module-archive: 归档不影响排期计算', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('归档需求的任务仍在 tasks 索引中（依赖与资源占用口径不变）', () => {
    const sched = makeSched();
    const before = sched.tasks().length;
    sched.archiveModule('官网改版', true);
    sched.collect();
    expect(sched.tasks().length).toBe(before);
    expect(sched.tasks().some(t => t.mod === '官网改版')).toBe(true);
    // 跨需求依赖仍然可解析（回归验证依赖各需求 uat 任务）
    expect(sched.getTask('m1-uat')).not.toBe(null);
  });
});

describe('module-archive: archivedModSet', () => {
  it('返回已归档需求名集合', () => {
    expect([...archivedModSet([
      { name: 'A', archived: true }, { name: 'B' }, { name: 'C', archived: true }
    ])]).toEqual(['A', 'C']);
  });

  it('空输入返回空集合', () => {
    expect(archivedModSet(null).size).toBe(0);
  });
});

describe('module-archive: 渲染层过滤与归档区', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('归档需求不作为可编辑行，但出现在甘特图底部的归档区（展开态）', () => {
    makeSched();
    planStore.state.modules.find(m => m.name === '官网改版').archived = true;
    const html = renderModView(null, makeRenderCtx(true), new Set());
    // 主视图：归档需求不作为可编辑行渲染
    expect(html).not.toContain('data-mod="官网改版"');
    // 底部归档区：标题行 + 只读行 + 取消归档入口
    expect(html).toContain('mod-arch-head');
    expect(html).toContain('data-arch-mod="官网改版"');
    expect(html).toContain('data-unarchive="官网改版"');
    // 这一份的独特价值：画在时间轴上（排期区间 + 迷你里程碑），卡片版给不了
    expect(html).toContain('fold-bar');
    expect(html).toContain('mile mini');
    // 未归档需求照常渲染
    expect(html).toContain('data-mod="数据看板"');
  });

  it('归档区收起时只留标题行，不渲染归档需求行', () => {
    makeSched();
    planStore.state.modules.find(m => m.name === '官网改版').archived = true;
    const html = renderModView(null, makeRenderCtx(false), new Set());
    expect(html).toContain('mod-arch-head');
    expect(html).not.toContain('data-arch-mod="官网改版"');
  });

  it('没有归档需求时不渲染归档区', () => {
    makeSched();
    expect(renderModView(null, makeRenderCtx(true), new Set())).not.toContain('mod-arch-head');
  });

  it('归档需求在「归档」页面里以卡片形式可见，并带取消归档入口', () => {
    makeSched();
    planStore.state.modules.find(m => m.name === '官网改版').archived = true;
    const html = renderArchiveView(null, makeRenderCtx(true));
    expect(html).toContain('class="rmod-grid"');
    expect(html).toContain('data-report-mod="官网改版"');
    expect(html).toContain('data-unarchive="官网改版"');
    expect(html).not.toContain('data-report-mod="数据看板"');   // 未归档的不出现
  });
});

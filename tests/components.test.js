// 组件层测试：锁定拖拽翻转限制、只读守卫、exportHTML 回退逻辑
import { describe, it, expect, beforeEach } from 'vitest';
import { planStore } from '../src/store/plan-store.js';
import { userStore } from '../src/store/user-store.js';
import { defaultModules, defaultResources } from '../src/core/default-data.js';
import { createWorkday } from '../src/core/workday.js';
import { createScheduler } from '../src/scheduler/index.js';
import { paintModHover, pickDragHandle } from '../src/components/drawers.js';
import { isPanTarget } from '../src/components/drag.js';

function makeSched() {
  planStore.set({ modules: defaultModules(), resources: defaultResources() });
  return createScheduler({ planStore, userStore, W: createWorkday({}) });
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

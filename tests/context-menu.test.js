// 右击快捷选项卡：菜单项构建纯函数测试（node 环境，无 DOM）
import { describe, it, expect } from 'vitest';
import {
  buildTaskMenuItems, buildModuleMenuItems, buildResMenuItems, dateAtClientX
} from '../src/components/context-menu.js';
import { F, fmt } from '../src/core/dates.js';

const keysOf = items => items.filter(i => !i.divider).map(i => i.key);
const find = (items, key) => items.find(i => i.key === key);

describe('context-menu: 任务（阶段）泳道菜单项', () => {
  const task = { id: 't1', done: 0, manual: true };

  it('可编辑时包含 新增任务/新建需求/编辑/完成/切换计划/删除，变更类均可用', () => {
    const items = buildTaskMenuItems(task, { editable: true });
    expect(keysOf(items)).toEqual(['addTask', 'addModule', 'edit', 'complete', 'toggleManual', 'delete']);
    expect(find(items, 'addTask').disabled).toBe(false);
    expect(find(items, 'addModule').disabled).toBe(false);
    expect(find(items, 'complete').disabled).toBe(false);
    expect(find(items, 'toggleManual').disabled).toBe(false);
    expect(find(items, 'delete').disabled).toBe(false);
    expect(find(items, 'delete').danger).toBe(true);
  });

  it('只读时新增/变更类项禁用，编辑仍可用', () => {
    const items = buildTaskMenuItems(task, { editable: false });
    expect(find(items, 'addTask').disabled).toBe(true);
    expect(find(items, 'addModule').disabled).toBe(true);
    expect(find(items, 'edit').disabled).toBeFalsy();
    expect(find(items, 'complete').disabled).toBe(true);
    expect(find(items, 'toggleManual').disabled).toBe(true);
    expect(find(items, 'delete').disabled).toBe(true);
  });

  it('未完成显示「标记完成」，已完成显示「重置进度」', () => {
    expect(find(buildTaskMenuItems({ done: 0 }, {}), 'complete').label).toContain('标记完成');
    expect(find(buildTaskMenuItems({ done: 100 }, {}), 'complete').label).toContain('重置进度');
  });

  it('手动任务显示「切换为自动」，自动任务显示「切换为手动」', () => {
    expect(find(buildTaskMenuItems({ manual: true }, {}), 'toggleManual').label).toContain('自动计划');
    expect(find(buildTaskMenuItems({ manual: false }, {}), 'toggleManual').label).toContain('手动计划');
  });
});

describe('context-menu: 里程碑=任务（菜单一致）', () => {
  it('里程碑(isMs) 与任务共用同一菜单构建，含完成/切换计划/删除', () => {
    const ms = { id: 'm1', isMs: true, m: '2026-08-21', manual: true };
    const items = buildTaskMenuItems(ms, { editable: true });
    expect(keysOf(items)).toEqual(['addTask', 'addModule', 'edit', 'complete', 'toggleManual', 'delete']);
    // 只读时删除禁用
    expect(find(buildTaskMenuItems(ms, { editable: false }), 'delete').disabled).toBe(true);
  });
});

describe('context-menu: 资源泳道（工作组规划器）菜单项', () => {
  it('包含 新增任务/新建需求/管理资源库，只读时新增类禁用', () => {
    const rw = buildResMenuItems({ editable: true });
    expect(keysOf(rw)).toEqual(['addTask', 'addModule', 'reslib']);
    expect(find(rw, 'addTask').disabled).toBe(false);
    expect(find(rw, 'addModule').disabled).toBe(false);
    const ro = buildResMenuItems({ editable: false });
    expect(find(ro, 'addTask').disabled).toBe(true);
    expect(find(ro, 'addModule').disabled).toBe(true);
    expect(find(ro, 'reslib').disabled).toBeFalsy();  // 资源库查看不受只读限制
  });
});

describe('context-menu: 需求泳道菜单项', () => {
  const mo = { name: '需求A' };

  it('包含 新增任务/新建需求/编辑/折叠/归档/删除', () => {
    expect(keysOf(buildModuleMenuItems(mo, {}))).toEqual(['addTask', 'addModule', 'editMod', 'toggleCollapse', 'archiveMod', 'deleteMod']);
    expect(find(buildModuleMenuItems(mo, { editable: true }), 'addTask').disabled).toBe(false);
    expect(find(buildModuleMenuItems(mo, { editable: true }), 'addModule').disabled).toBe(false);
  });

  it('折叠态文案随 collapsed 切换', () => {
    expect(find(buildModuleMenuItems(mo, { collapsed: false }), 'toggleCollapse').label).toBe('折叠需求');
    expect(find(buildModuleMenuItems(mo, { collapsed: true }), 'toggleCollapse').label).toBe('展开需求');
  });

  it('只读时新增/删除类项禁用', () => {
    expect(find(buildModuleMenuItems(mo, { editable: false }), 'addTask').disabled).toBe(true);
    expect(find(buildModuleMenuItems(mo, { editable: false }), 'addModule').disabled).toBe(true);
    expect(find(buildModuleMenuItems(mo, { editable: false }), 'deleteMod').disabled).toBe(true);
    expect(find(buildModuleMenuItems(mo, { editable: true }), 'deleteMod').disabled).toBe(false);
  });
});

describe('context-menu: 右击位置 → 日期（新建任务开始日）', () => {
  const ctx = { dayW: 13, state: { start: F('2026-08-12'), end: F('2026-10-31') } };
  const at = x => dateAtClientX({ clientX: x, trackLeft: 300, ctx });

  it('track 左边界=项目起始日，按 dayW 逐日递增', () => {
    expect(fmt(at(300))).toBe('2026-08-12');
    expect(fmt(at(300 + 13))).toBe('2026-08-13');
    expect(fmt(at(300 + 13 * 5))).toBe('2026-08-17');
  });

  it('同一天格内任意位置都归属该天（向下取整）', () => {
    expect(fmt(at(300 + 13 * 5 + 12))).toBe('2026-08-17');
    expect(fmt(at(300 + 12))).toBe('2026-08-12');
  });

  it('落在时间轴左侧（如左侧固定列）返回 null，由调用方回退为今天', () => {
    expect(at(299)).toBe(null);
    expect(at(0)).toBe(null);
  });

  it('超出项目结束日的部分钳制到结束日', () => {
    expect(fmt(at(300 + 13 * 1000))).toBe('2026-10-31');
  });

  it('start/end 为 Date 对象时同样可用（planStore 存 Date）', () => {
    const ctxD = { dayW: 13, state: { start: new Date(2026, 7, 12), end: new Date(2026, 9, 31) } };
    expect(fmt(dateAtClientX({ clientX: 300 + 26, trackLeft: 300, ctx: ctxD }))).toBe('2026-08-14');
  });

  it('ctx 缺失 dayW/state 或坐标为非数字时返回 null', () => {
    expect(dateAtClientX({ clientX: 400, trackLeft: 300, ctx: null })).toBe(null);
    expect(dateAtClientX({ clientX: 400, trackLeft: 300, ctx: { state: ctx.state } })).toBe(null);
    expect(dateAtClientX({ clientX: 400, trackLeft: 300, ctx: { dayW: 13 } })).toBe(null);
    expect(dateAtClientX({ clientX: 'x', trackLeft: 300, ctx })).toBe(null);
  });
});

describe('context-menu: 菜单项「新增任务」带右击位置日期', () => {
  const task = { id: 't1', done: 0 };

  it('未传 atDate 时保持原文案（工具栏新增任务不受影响）', () => {
    expect(find(buildTaskMenuItems(task, {}), 'addTask').label).toBe('新增任务');
    expect(find(buildResMenuItems({}), 'addTask').label).toBe('新增任务');
    expect(find(buildModuleMenuItems({ name: 'A' }, {}), 'addTask').label).toBe('新增任务');
  });

  it('传入 atDate 时三类菜单均显示「新增任务（M/D 起）」', () => {
    const d = F('2026-03-16');
    expect(find(buildTaskMenuItems(task, { atDate: d }), 'addTask').label).toBe('新增任务（3/16 起）');
    expect(find(buildResMenuItems({ atDate: d }), 'addTask').label).toBe('新增任务（3/16 起）');
    expect(find(buildModuleMenuItems({ name: 'A' }, { atDate: d }), 'addTask').label).toBe('新增任务（3/16 起）');
  });

  it('atDate 不影响只读禁用与其余菜单项', () => {
    const d = '2026-03-16';
    expect(find(buildTaskMenuItems(task, { atDate: d, editable: false }), 'addTask').disabled).toBe(true);
    expect(keysOf(buildTaskMenuItems(task, { atDate: d })))
      .toEqual(['addTask', 'addModule', 'edit', 'complete', 'toggleManual', 'delete']);
  });
});

describe('context-menu: modRange 泳道对齐（需求右边界=最大结束日期）', () => {
  it('buildViewCtx 的 modRange 用最大结束日期而非最大开始日期', async () => {
    const { buildViewCtx } = await import('../src/views/index.js');
    const { F } = await import('../src/core/dates.js');
    const state = { modules: [
      { name: 'A', bars: [
        { id: 't1', s: '2026-08-18', e: '2026-08-22' },       // 8/18 ~ 8/22
        { id: 't2', s: '2026-08-24', e: '2026-08-28' }        // 8/24 ~ 8/28
      ] }
    ], resources: [], start: F('2026-08-12'), end: F('2026-10-31') };
    const ctx = buildViewCtx({ state, dayW: 13 });
    const rng = ctx.modRange(state.modules[0]);
    const starts = state.modules[0].bars.map(b => F(b.s));
    const maxStart = new Date(Math.max(...starts));
    const maxEnd = F('2026-08-28');
    // 右边界=最大结束日期（8/28），且应大于最大开始日期（8/24）——回归保护旧实现在此错位
    expect(rng.end).toEqual(maxEnd);
    expect(rng.end > maxStart).toBe(true);
  });
});

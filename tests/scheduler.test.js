// scheduler 测试：从 _test-scheduler-features.js 迁移，改为基于 createScheduler({planStore,userStore,W}) 的形态
// 原测试用全局 window.MODULES 操作，改为 planStore.state.modules；window.WORKDAY 改为注入的 W
import { describe, it, expect, beforeEach } from 'vitest';
import { planStore } from '../src/store/plan-store.js';
import { userStore } from '../src/store/user-store.js';
import { defaultModules, defaultResources, PNAME, MODULE_PHASES, MODULE_MILESTONE_PHASES } from '../src/core/default-data.js';
import { createWorkday } from '../src/core/workday.js';
import { createScheduler } from '../src/scheduler/index.js';

// localStorage 兜底（node 环境无全局 localStorage；save 的 try/catch 也能兜底，这里显式提供）
if (typeof globalThis.localStorage === 'undefined') {
  const m = new Map();
  globalThis.localStorage = {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); }
  };
}

// 与 _test-scheduler-features.js 的 window.WORKDAY 等价：createWorkday({}) 即周末口径（无假期带）
function makeSched() {
  planStore.set({ modules: defaultModules(), resources: defaultResources() });
  return createScheduler({ planStore, userStore, W: createWorkday({}) });
}

const mods = () => planStore.state.modules;

describe('scheduler: 需求与任务编辑', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('updateModule 支持「待排期」状态开关', () => {
    const sched = makeSched();
    sched.addModule({ name: '待排期需求', autoCreate: false });
    const find = () => planStore.state.modules.find(m => m.name === '待排期需求');
    expect(!!find().unscheduled).toBe(false);

    sched.updateModule({ name: '待排期需求', unscheduled: true });
    expect(find().unscheduled).toBe(true);

    sched.updateModule({ name: '待排期需求', unscheduled: false });
    expect(find().unscheduled).toBe(false);
  });

  it('addModule：优先级默认 P2，可显式指定，非法值回落到默认', () => {
    const sched = makeSched();
    const pri = n => planStore.state.modules.find(m => m.name === n).pri;
    sched.addModule({ name: '默认优先级', autoCreate: false });
    expect(pri('默认优先级')).toBe('P2');
    sched.addModule({ name: '最高优先级', autoCreate: false, pri: 'P0' });
    expect(pri('最高优先级')).toBe('P0');
    // 非法值不落库（回落到默认），避免脏数据进 state 被导出
    sched.addModule({ name: '非法优先级', autoCreate: false, pri: 'P9' });
    expect(pri('非法优先级')).toBe('P2');
  });

  it('updateModule：可改优先级，可清空回「未设置」，不传则保持原值', () => {
    const sched = makeSched();
    sched.addModule({ name: '改优先级', autoCreate: false, pri: 'P3' });
    const pri = () => planStore.state.modules.find(m => m.name === '改优先级').pri;
    expect(pri()).toBe('P3');

    sched.updateModule({ name: '改优先级', pri: 'P0' });
    expect(pri()).toBe('P0');

    // 清空（'' 或非法值都归到 null=未设置）—— 与「打开编辑再保存不该臆造档位」同源
    sched.updateModule({ name: '改优先级', pri: '' });
    expect(pri()).toBe(null);
    sched.updateModule({ name: '改优先级', pri: 'P9' });
    expect(pri()).toBe(null);

    // 其它字段的编辑不能顺手把优先级冲掉
    sched.updateModule({ name: '改优先级', pri: 'P1' });
    sched.updateModule({ name: '改优先级', tag: '冲刺中' });
    expect(pri()).toBe('P1');
  });

  it('优先级不参与排期：改优先级不移动任何任务日期', () => {
    const sched = makeSched();
    const snap = () => JSON.stringify(sched.tasks().map(t => [t.id, t.s, t.e]));
    const before = snap();
    sched.updateModule({ name: '官网改版', pri: 'P3' });
    expect(snap()).toBe(before);
  });

  it('addModule 可直接创建为「待排期」', () => {
    const sched = makeSched();
    sched.addModule({ name: '新建待排期', autoCreate: false, unscheduled: true });
    expect(planStore.state.modules.find(m => m.name === '新建待排期').unscheduled).toBe(true);
  });

  it('addModule 新增需求 / 重复与空名拒绝 / 空需求不破坏 collect', () => {
    const sched = makeSched();
    const mo = sched.addModule({ name: '测试需求', tag: '新建', tagc: '#8b5cf6', autoCreate: false });
    expect(!!mo && mo.name === '测试需求' && Array.isArray(mo.bars) && mo.bars.length === 0).toBe(true);
    expect(mods().some(m => m.name === '测试需求')).toBe(true);
    expect(() => sched.addModule({ name: '测试需求' })).toThrow();
    expect(() => sched.addModule({ name: '   ' })).toThrow();
    sched.collect();  // 空需求不破坏 collect
    expect(sched.tasks().length).toBeGreaterThan(0);
  });

  it('addModule 自定义阶段：仅初始化所选阶段 + 里程碑，顺序跟随传入', () => {
    const sched = makeSched();
    const mo = sched.addModule({ name: '阶段筛选', phases: ['dev', 'sit'] });
    const bars = mo.bars;
    const phases = bars.filter(b => !b.m).map(b => b.p);
    expect(phases).toEqual(['dev', 'sit']);
    // 提测里程碑始终追加在 SIT 之后，上线里程碑追加在最后一个阶段之后
    const tice = bars.find(b => b.m && b.label === '提测');
    const go = bars.find(b => b.m && b.label === '上线');
    expect(!!tice && tice.dep[0].id === bars.find(b => b.p === 'sit').id).toBe(true);
    expect(!!go).toBe(true);
    // 阶段间依赖链正确（sit 依赖 dev）
    const dev = bars.find(b => b.p === 'dev');
    const sit = bars.find(b => b.p === 'sit');
    expect(dev.dep.length).toBe(0);
    expect(sit.dep[0].id).toBe(dev.id);
  });

  it('addModule 里程碑：提测前置=SIT、上线前置=最后一个阶段（未选 SIT 时不建提测）', () => {
    const sched = makeSched();
    const mo = sched.addModule({ name: '里程碑链', phases: ['dev', 'sit', 'uat'] });
    const bars = mo.bars;
    const sit = bars.find(b => b.p === 'sit' && !b.m);
    const uat = bars.find(b => b.p === 'uat');
    const tice = bars.find(b => /提测$/.test(b.label || ''));
    const go = bars.find(b => /上线$/.test(b.label || ''));
    expect(tice.dep).toEqual([{ id: sit.id, lag: 0 }]);
    expect(go.dep).toEqual([{ id: uat.id, lag: 0 }]);
    // 无 SIT 阶段 → 不创建提测里程碑
    const mo2 = sched.addModule({ name: '无SIT需求', phases: ['dev', 'uat'] });
    expect(mo2.bars.some(b => /提测$/.test(b.label || ''))).toBe(false);
    expect(mo2.bars.some(b => /上线$/.test(b.label || ''))).toBe(true);
  });

  it('addModule 自定义阶段：无效/重复阶段被过滤，空数组回退默认模板阶段（不含回归测试）', () => {
    const sched = makeSched();
    // 无效 key 与重复被过滤
    const mo1 = sched.addModule({ name: '过滤阶段', phases: ['dev', 'notExist', 'dev', 'ui'] });
    expect(mo1.bars.filter(b => !b.m).map(b => b.p)).toEqual(['dev', 'ui']);
    // 空数组/缺省 → 默认模板阶段（里程碑阶段不出现在任务列表里）
    const mo2 = sched.addModule({ name: '全部阶段', phases: [] });
    const taskPhases = MODULE_PHASES.filter(p => !MODULE_MILESTONE_PHASES.includes(p));
    expect(mo2.bars.filter(b => !b.m).map(b => b.p)).toEqual(taskPhases);
    expect(MODULE_PHASES).not.toContain('reg');
    expect(MODULE_PHASES).toEqual(Object.keys(PNAME).filter(k => k !== 'reg'));
  });

  it('addModule 默认模板：需求确认以里程碑（0 天卡点）创建，后续阶段依赖它', () => {
    const sched = makeSched();
    // 2026-09-07 周一：req 手动手动锚定，其余自动顺延
    const mo = sched.addModule({ name: '默认模板', start: '2026-09-07' });
    const bars = mo.bars;
    const ui = bars.find(b => b.p === 'ui');
    const cfm = bars.find(b => b.p === 'cfm');
    const dev = bars.find(b => b.p === 'dev');
    // 里程碑形态：只有卡点日 m，没有周期/工作量/资源
    expect(cfm.label).toBe('需求确认');
    expect(cfm.m).toBe('2026-09-09');
    expect(cfm.s).toBeUndefined();
    expect(cfm.e).toBeUndefined();
    expect(cfm.w).toBeUndefined();
    expect(cfm.res).toBeUndefined();
    // 前置=UI设计；里程碑单点前置不加 1 天 → 开发与需求确认同日开始
    expect(cfm.manual).toBe(false);
    expect(cfm.dep).toEqual([{ id: ui.id, lag: 0 }]);
    expect(dev.dep).toEqual([{ id: cfm.id, lag: 0 }]);
    expect(dev.s).toBe('2026-09-09');
    // 里程碑不参与资源冲突检测 / 工作量统计
    expect(sched.detectProblems().some(p => p.taskId === cfm.id)).toBe(false);
  });

  it('addModule：首个任务手动锁定，其余阶段与里程碑为自动，并从今天开始', () => {
  const sched = makeSched();
  // 固定起始日以便断言（不传 start 时默认取"今天"）
  const mo = sched.addModule({ name: '新建需求', phases: ['dev', 'sit'], start: '2026-09-07' });
  const bars = mo.bars;
  const dev = bars.find(b => b.p === 'dev');
  const sit = bars.find(b => b.p === 'sit');
  const ms = bars.find(b => b.m);
  // 首个任务：手动 + 落在开始日
  expect(dev.manual).toBe(true);
  expect(dev.s).toBe('2026-09-07');
  // 其余阶段：自动，且被重排到依赖允许的最早工作日（dev 结束 9/7 → sit 9/8）
  expect(sit.manual).toBe(false);
  expect(sit.s).toBe('2026-09-08');
  // 里程碑：自动，跟随最后阶段（sit 结束 9/8 → 上线 9/9）
  expect(ms.manual).toBe(false);
  expect(ms.m).toBe('2026-09-09');
  // 依赖链仍然建立
  expect(sit.dep[0].id).toBe(dev.id);
  expect(ms.dep[0].id).toBe(sit.id);
});

it('addModule 不传 start 时默认从今天开始', () => {
  const sched = makeSched();
  const todayStr = new Date().toISOString().slice(0, 10);
  const mo = sched.addModule({ name: '今日起始', phases: ['req'] });
  const first = mo.bars.find(b => !b.m);
  expect(first.s).toBe(todayStr);
  expect(first.manual).toBe(true);
});

it('addTask 新增普通任务 + nameOf 默认回退', () => {
    const sched = makeSched();
    sched.addModule({ name: '测试需求' });
    const id = sched.addTask({ mod: '测试需求', p: 'dev', name: '开发-联调', start: '2026-09-20', dur: 3, res: ['张三'], manual: false });
    const t = sched.getTask(id);
    expect(!!id && !!t && t.id === id).toBe(true);
    // dur 语义=工作量（人天）：09-20 是周日，跳过周末，第3个工作日停在 09-23 周三
    expect(t.s === '2026-09-20' && t.e === '2026-09-23').toBe(true);
    expect(t.w).toBe(3);
    expect(t.name).toBe('开发-联调');
    expect(sched.nameOf(t)).toBe('开发-联调');
    expect(sched.nameOf(sched.getTask('m1-dev'))).toBe('官网改版 · 开发');
    const id2 = sched.addTask({ mod: '测试需求', p: 'dev', start: '2026-09-24', dur: 1 });
    expect(id2).not.toBe(id);
    expect(() => sched.addTask({ mod: '不存在的需求', p: 'dev', start: '2026-09-20', dur: 1 })).toThrow();
  });

  it('renameTask 重命名 / 清空名称回退默认', () => {
    const sched = makeSched();
    sched.addModule({ name: '测试需求' });
    const id = sched.addTask({ mod: '测试需求', p: 'dev', name: '开发-联调', start: '2026-09-20', dur: 3 });
    sched.renameTask(id, '联调-改名');
    expect(sched.getTask(id).name).toBe('联调-改名');
    expect(sched.nameOf(sched.getTask(id))).toBe('联调-改名');
    sched.renameTask(id, '   ');
    expect(!('name' in sched.getTask(id)) && sched.nameOf(sched.getTask(id)) === '测试需求 · 开发').toBe(true);
  });

  it('addTask 里程碑 / 改名 label / 默认 label', () => {
    const sched = makeSched();
    sched.addModule({ name: '测试需求' });
    const mid = sched.addTask({ mod: '测试需求', p: 'go', name: '10/1 上线', type: 'ms', start: '2026-10-01', manual: true });
    const ms = sched.getTask(mid);
    expect(!!ms && ms.isMs && ms.m === '2026-10-01' && ms.label === '10/1 上线').toBe(true);
    sched.renameTask(mid, '10/2 上线');
    expect(sched.getTask(mid).label).toBe('10/2 上线');
    expect(sched.nameOf(sched.getTask(mid))).toBe('10/2 上线');
    const mid2 = sched.addTask({ mod: '测试需求', p: 'go', type: 'ms', start: '2026-10-03', manual: false });
    // 未填名字时回退阶段名（"上线"），而不是「需求名 里程碑」——后者在图上只剩「里程碑」，看不出是什么卡点
    expect(sched.getTask(mid2).label).toBe('上线');
  });

  it('computeSchedule 不报错，无依赖自动任务保持日期，参与问题检测', () => {
    const sched = makeSched();
    sched.addModule({ name: '测试需求' });
    const id = sched.addTask({ mod: '测试需求', p: 'dev', name: '开发-联调', start: '2026-09-20', dur: 3, res: ['张三'], manual: false });
    sched.computeSchedule();
    const auto = sched.getTask(id);
    expect(auto.s).toBe('2026-09-20');
    expect(Array.isArray(sched.detectProblems())).toBe(true);
  });

  it('资源管理：增改删 + 删除资源清空任务引用', () => {
    const sched = makeSched();
    sched.addModule({ name: '测试需求' });
    sched.addResource({ name: '测试员', role: '测试', color: '#123456' });
    const tr = planStore.state.resources.find(r => r.name === '测试员');
    expect(!!tr && tr.role === '测试').toBe(true);
    sched.updateResource(tr.id, { name: '测试员2' });
    expect(planStore.state.resources.some(r => r.name === '测试员2')).toBe(true);
    const tid = sched.addTask({ mod: '测试需求', p: 'dev', name: '资源引用', start: '2026-09-25', dur: 1, res: ['张三'], manual: true });
    sched.deleteResource(planStore.state.resources.find(r => r.name === '张三').id);
    expect(sched.getTask(tid).res.length).toBe(0);
  });

  it('exportJSON/importJSON 往返：自定义名保留、运行时字段剥离', () => {
    const sched = makeSched();
    sched.addModule({ name: '测试需求' });
    const id = sched.addTask({ mod: '测试需求', p: 'dev', name: '开发-再改名', start: '2026-09-20', dur: 3 });
    const json = sched.exportJSON();
    const parsed = JSON.parse(json);
    expect(parsed.modules.some(m => m.name === '测试需求')).toBe(true);
    expect(parsed.modules.some(m => m.bars.some(b => b.name === '开发-再改名'))).toBe(true);
    expect(parsed.modules.every(m => m.bars.every(b => !('mod' in b) && !('isMs' in b)))).toBe(true);
    sched.importJSON(json);
    expect(!!sched.getTask(id) && sched.getTask(id).name === '开发-再改名').toBe(true);
    expect(mods().some(m => m.name === '测试需求')).toBe(true);
  });
});

describe('scheduler: 依赖与排期语义', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('里程碑前置：自动任务与里程碑同日开始（不加 +1）；lag=1 顺延至次日工作日', () => {
    const sched = makeSched();
    sched.addModule({ name: '依赖测试' });
    const msId = sched.addTask({ mod: '依赖测试', p: 'go', name: '依赖里程碑', type: 'ms', start: '2026-09-18', manual: true });
    const tkId = sched.addTask({ mod: '依赖测试', p: 'dev', name: '依赖任务', start: '2026-09-01', dur: 2, manual: false, res: [] });
    sched.getTask(tkId).dep = [{ id: msId, lag: 0 }];
    sched.collect();
    sched.computeSchedule();
    const tk = sched.getTask(tkId);
    expect(tk.s).toBe('2026-09-18');
    expect(!sched.detectProblems().some(p => p.type === 'depend' && p.taskId === tkId)).toBe(true);
    // lag=1：里程碑日 +1，9/19 周六顺延到 9/21 周一
    sched.getTask(tkId).dep = [{ id: msId, lag: 1 }];
    sched.collect();
    sched.computeSchedule();
    expect(sched.getTask(tkId).s).toBe('2026-09-21');
  });

  it('普通任务前置仍 +1（结束次日开始，FS 语义回归）', () => {
    const sched = makeSched();
    sched.addModule({ name: '依赖测试' });
    const preId = sched.addTask({ mod: '依赖测试', p: 'req', name: '普通前置', start: '2026-09-16', dur: 1, manual: true, res: [] });
    const postId = sched.addTask({ mod: '依赖测试', p: 'ui', name: '普通后置', start: '2026-09-01', dur: 1, manual: false, res: [] });
    sched.getTask(postId).dep = [{ id: preId, lag: 0 }];
    sched.collect();
    sched.computeSchedule();
    expect(sched.getTask(postId).s).toBe('2026-09-17');
  });

  it('拓扑排序：环检测返回环上节点', () => {
    const sched = makeSched();
    const nodeIds = ['a', 'b', 'c'];
    const depFn = id => ({ a: ['c'], b: ['a'], c: ['b'] }[id] || []);
    const { cycle } = sched.topoSort(nodeIds, depFn);
    expect(cycle.sort().join(',')).toBe('a,b,c');
  });
});

describe('scheduler: 需求/任务阶段排序', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('moveModule / moveBar 排序语义', () => {
    const sched = makeSched();
    const modNames = () => mods().map(m => m.name);
    sched.addModule({ name: '排序A', autoCreate: false });
    sched.addModule({ name: '排序B', autoCreate: false });
    sched.addModule({ name: '排序C', autoCreate: false });
    const aIdx = () => modNames().indexOf('排序A');
    const cIdx = () => modNames().indexOf('排序C');
    expect(aIdx()).toBeLessThan(cIdx());
    sched.moveModule('排序C', '排序A', true);     // C 移到 A 之前
    expect(modNames().indexOf('排序C')).toBe(modNames().indexOf('排序A') - 1);
    sched.moveModule('排序A', '排序C', false);    // A 移到 C 之后
    expect(modNames().indexOf('排序A')).toBe(modNames().indexOf('排序C') + 1);
    sched.moveModule('排序B', '排序B', true);     // 同目标无操作
    expect(modNames().length).toBe(mods().length);
    sched.moveModule('不存在的', '排序A', true);  // 非法源无操作
    expect(modNames().length).toBe(mods().length);
    // 需求移动后任务跟随
    const A = mods().find(m => m.name === '排序A');
    A.bars.push({ id: 'sort-a1', p: 'req', s: '2026-09-01', e: '2026-09-01', w: 1, res: [], dep: [], manual: true, ignore: false });
    A.bars.push({ id: 'sort-a2', p: 'dev', s: '2026-09-02', e: '2026-09-02', w: 1, res: [], dep: [], manual: true, ignore: false });
    sched.collect();
    sched.moveModule('排序A', '排序B', false);    // A 移到 B 后（整个需求连带任务）
    expect(sched.getTask('sort-a1').mod).toBe('排序A');
    expect(sched.getTask('sort-a2').mod).toBe('排序A');
    // 任务阶段排序（仅同需求内）
    const barsOf = () => mods().find(m => m.name === '排序A').bars.map(b => b.id);
    sched.moveBar('sort-a2', 'sort-a1', true);    // a2 移到 a1 前
    expect(barsOf().join(',')).toBe('sort-a2,sort-a1');
    sched.moveBar('sort-a1', 'sort-a2', true);    // a1 移到 a2 前（移回）
    expect(barsOf().join(',')).toBe('sort-a1,sort-a2');
    sched.moveBar('sort-a1', 'sort-a1', true);    // 同目标无操作
    expect(barsOf().length).toBe(2);
    // 跨需求任务排序应无效果
    const B = mods().find(m => m.name === '排序B');
    B.bars.push({ id: 'sort-b1', p: 'ui', s: '2026-09-03', e: '2026-09-03', w: 1, res: [], dep: [], manual: true, ignore: false });
    sched.collect();
    sched.moveBar('sort-a1', 'sort-b1', true);
    expect(barsOf().includes('sort-a1') && !barsOf().includes('sort-b1')).toBe(true);
  });
});

describe('scheduler: 工作量恒定（拖动/自动排期）', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('拖到周五：工作量不变，时间周期随周末自动伸缩', () => {
    const sched = makeSched();
    const W = createWorkday({});
    sched.addModule({ name: '工作量测试' });
    const wa = sched.addTask({ mod: '工作量测试', p: 'dev', start: '2026-09-01', dur: 3, manual: true, res: [] });  // 9/1(二)~9/3(四)，work=3
    const workOf = id => W.workDays(sched.getTask(id).s, sched.getTask(id).e);
    const spanOf = id => W.spanDays(sched.getTask(id).s, sched.getTask(id).e);
    expect(workOf(wa)).toBe(3);
    expect(spanOf(wa)).toBe(3);
    sched.cascade(wa, new Date(2026, 7, 21));   // 拖到 8/21 周五，跨 8/22-23 周末
    expect(workOf(wa)).toBe(3);
    expect(sched.getTask(wa).s).toBe('2026-08-21');
    expect(sched.getTask(wa).e).toBe('2026-08-25');
    expect(spanOf(wa)).toBe(5);
    expect(workOf(wa)).toBe(3);
    expect(sched.getTask(wa).w).toBe(workOf(wa));   // w 同步为工作量（人天），非时间周期
  });

  it('跨周末拖拽 / 自动计划跨周末：工作量恒定', () => {
    const sched = makeSched();
    const W = createWorkday({});
    sched.addModule({ name: '工作量测试' });
    const workOf = id => W.workDays(sched.getTask(id).s, sched.getTask(id).e);
    const spanOf = id => W.spanDays(sched.getTask(id).s, sched.getTask(id).e);
    const wb = sched.addTask({ mod: '工作量测试', p: 'sit', start: '2026-09-14', dur: 2, manual: true, res: [] });  // 9/14~9/15 work=2
    sched.cascade(wb, new Date(2026, 9, 9));    // 拖到 10/9 周五，跨 10/10-11 周末
    expect(workOf(wb)).toBe(2);
    expect(sched.getTask(wb).s).toBe('2026-10-09');
    expect(sched.getTask(wb).e).toBe('2026-10-12');
    expect(spanOf(wb)).toBe(4);
    // 自动计划跨周末：前置 9/3 结束，自动任务重排到 9/4 起（跨 9/5-6 周末）
    const wPre = sched.addTask({ mod: '工作量测试', p: 'req', start: '2026-09-03', dur: 1, manual: true, res: [] });
    const wc = sched.addTask({ mod: '工作量测试', p: 'ui', start: '2026-09-01', dur: 3, manual: false, res: [] });
    sched.getTask(wc).dep = [{ id: wPre, lag: 0 }];
    sched.collect();
    sched.computeSchedule();
    expect(workOf(wc)).toBe(3);
    expect(sched.getTask(wc).s).toBe('2026-09-04');
    expect(sched.getTask(wc).e).toBe('2026-09-08');
    expect(spanOf(wc)).toBe(5);
  });

  it('拖拽落位后转为手动：依赖关系保留，后置自动任务跟随，后置手动任务保持不动', () => {
  const sched = makeSched();
  sched.addModule({ name: '依赖联动' });
  const A = sched.addTask({ mod: '依赖联动', p: 'req', start: '2026-09-01', dur: 1, manual: true, res: [] });
  const B = sched.addTask({ mod: '依赖联动', p: 'dev', start: '2026-09-05', dur: 1, manual: false, res: [] });
  // C 分配资源：未分配资源的任务不提示排期问题（见后续 depend 断言）
  const C = sched.addTask({ mod: '依赖联动', p: 'sit', start: '2026-09-08', dur: 1, manual: true, res: ['李四'] });
  sched.getTask(B).dep = [{ id: A, lag: 0 }];
  sched.getTask(C).dep = [{ id: A, lag: 0 }];
  sched.collect();
  sched.computeSchedule();
  expect(sched.getTask(B).s).toBe('2026-09-02');    // A 9/1 结束 → B 自动排到 9/2

  // 拖动 A 到 9/10：A 本身被锁定为手动，dep 不被清除
  sched.cascade(A, new Date(2026, 8, 10));
  expect(sched.getTask(A).s).toBe('2026-09-10');
  expect(sched.getTask(A).manual).toBe(true);
  expect(sched.getTask(A).dep).toBeDefined();
  expect(sched.getTask(B).dep.length).toBe(1);      // 依赖关系保留
  expect(sched.getTask(B).s).toBe('2026-09-11');    // 后置自动任务跟随联动
  expect(sched.getTask(C).s).toBe('2026-09-08');    // 后置手动任务保持不动
  // 后置手动任务早于前置结束 → 应被检测为依赖违反
  const probs = sched.detectProblems();
  expect(probs.some(p => p.type === 'depend' && p.taskId === C)).toBe(true);
});

it('已完成任务（进度 100%）不再提示任何排期问题', () => {
  const sched = makeSched();
  sched.addModule({ name: '完成态' });

  // ① 依赖违反：后置手动任务与前置同日开始 → 早于允许的最早开始
  // 两者都需分配资源：未分配资源的任务不提示排期问题
  // 资源名刻意与默认演示数据不重名：避免演示数据的占用意外制造资源冲突，干扰本用例的判定
  const A = sched.addTask({ mod: '完成态', p: 'req', start: '2026-09-07', dur: 1, manual: true, res: ['甲'] });
  const C = sched.addTask({ mod: '完成态', p: 'sit', start: '2026-09-07', dur: 1, manual: true, res: ['乙'] });
  sched.getTask(C).dep = [{ id: A, lag: 0 }];
  sched.collect();
  sched.computeSchedule();
  expect(sched.detectProblems().some(p => p.type === 'depend' && p.taskId === C)).toBe(true);
  sched.getTask(C).done = 100;
  sched.collect();
  expect(sched.detectProblems().some(p => p.taskId === C)).toBe(false);

  // ② 资源过载：两个共享资源的任务时间区间重叠
  const R1 = sched.addTask({ mod: '完成态', p: 'dev', start: '2026-09-14', dur: 2, manual: true, res: [] });
  const R2 = sched.addTask({ mod: '完成态', p: 'ui', start: '2026-09-15', dur: 2, manual: true, res: [] });
  sched.getTask(R1).res = ['前端A'];
  sched.getTask(R2).res = ['前端A'];
  sched.collect();
  expect(sched.detectProblems().some(p => p.type === 'overlap' && p.taskId === R2)).toBe(true);
  // R1 已完成：既不提示 R1，也不再因 R1 产生资源过载提示
  sched.getTask(R1).done = 100;
  sched.collect();
  expect(sched.detectProblems().some(p => p.type === 'overlap')).toBe(false);

  // ③ 超期：结束日超出项目周期（默认 2026-08-12 ~ 2026-10-31）
  const O = sched.addTask({ mod: '完成态', p: 'uat', start: '2027-01-11', dur: 3, manual: true, res: ['张三'] });
  sched.collect();
  planStore.set({ end: new Date(2026, 9, 31) });   // 收敛项目周期，构造超期场景
  expect(sched.detectProblems().some(p => p.type === 'overdue' && p.taskId === O)).toBe(true);
  sched.getTask(O).done = 100;
  sched.collect();
  expect(sched.detectProblems().some(p => p.taskId === O)).toBe(false);
});

it('未分配资源的任务不提示排期问题（分配资源后才提示）', () => {
  const sched = makeSched();
  sched.addModule({ name: '未分配' });
  const pre = sched.addTask({ mod: '未分配', p: 'req', start: '2026-09-07', dur: 1, manual: true, res: ['张三'] });
  const t = sched.addTask({ mod: '未分配', p: 'sit', start: '2026-09-07', dur: 1, manual: true, res: [] });
  sched.getTask(t).dep = [{ id: pre, lag: 0 }];
  sched.collect();
  // 还没排人 → 即便开始日早于前置允许的最早开始，也不提示
  expect(sched.detectProblems().some(p => p.taskId === t)).toBe(false);

  // 分配资源后，同样的依赖违反会被正常提示
  sched.getTask(t).res = ['李四'];
  sched.collect();
  expect(sched.detectProblems().some(p => p.type === 'depend' && p.taskId === t)).toBe(true);
});

it('工作量要跨法定节假日时：结束日自动顺延（不问周几，以节假日接口/兜底带为准）', () => {
    // 注入国庆兜底假期带（与 createWorkday 回退逻辑一致）
    const HOL = { holidays: [{ s: new Date(2026, 9, 1), e: new Date(2026, 9, 7), n: '国庆' }] };
    planStore.set({ modules: defaultModules(), resources: defaultResources() });
    const sched = createScheduler({ planStore, userStore, W: createWorkday(HOL) });
    const W = createWorkday(HOL);
    sched.addModule({ name: '节假日测试' });
    // 9/28(一) 起 3 人天：9/28、9/29、9/30 → 结束 9/30（未触国庆）
    const t1 = sched.addTask({ mod: '节假日测试', p: 'dev', start: '2026-09-28', dur: 3, manual: true, res: [] });
    expect(createWorkday(HOL).spanDays(sched.getTask(t1).s, sched.getTask(t1).e)).toBe(3);
    expect(sched.getTask(t1).e).toBe('2026-09-30');
    // 9/28(一) 起 5 人天：9/28,9/29,9/30,10/8,10/9 → 结束 10/9（跳过 10/1~10/7 国庆）
    const t2 = sched.addTask({ mod: '节假日测试', p: 'sit', start: '2026-09-28', dur: 5, manual: true, res: [] });
    expect(W.workDays(sched.getTask(t2).s, sched.getTask(t2).e)).toBe(5);   // 工作量恒为 5 人天
    expect(sched.getTask(t2).s).toBe('2026-09-28');
    expect(sched.getTask(t2).e).toBe('2026-10-09');                        // 自动跳过国庆 7 天假期
    expect(sched.getTask(t2).w).toBe(5);                                    // w=人天
  });

  it('createWorkday 注入兼容 Date 输入', () => {
    makeSched();
    const W = createWorkday({});
    const endD = W.spanEndByWorkdays(new Date(2026, 7, 17), 1);
    expect(endD instanceof Date && !isNaN(endD.getTime()) && endD.getFullYear() === 2026 && endD.getMonth() === 7 && endD.getDate() === 17).toBe(true);
    expect(W.workDays(new Date(2026, 7, 17), new Date(2026, 7, 18))).toBe(2);
  });
});

describe('scheduler: 只读守卫 + sync 降级', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('READONLY 守卫：addTask 抛错', () => {
    const sched = makeSched();
    userStore.set({ readonly: true });
    expect(() => sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1 })).toThrow('只读模式');
  });

  it('READONLY 守卫：saveTask 静默不生效', () => {
    const sched = makeSched();
    userStore.set({ readonly: true });
    sched.saveTask('m1-req', { name: '改不了', dur: 5 });
    const t = sched.getTask('m1-req');
    expect(t.name).not.toBe('改不了');
    expect(t.w).toBe(3);
  });

  it('READONLY 守卫：addModule 抛错', () => {
    const sched = makeSched();
    userStore.set({ readonly: true });
    expect(() => sched.addModule({ name: '新需求' })).toThrow('只读模式');
  });

  it('loadFromServer 无 sync 时 resolve false（本地兜底）', async () => {
    const sched = makeSched();
    await expect(sched.loadFromServer()).resolves.toBe(false);
  });

  it('pushToServer 无 sync 时 resolve false', async () => {
    const sched = makeSched();
    await expect(sched.pushToServer()).resolves.toBe(false);
  });

  it('sched.diff 保持源契约（a-b）：翻转保护依赖 sched.diff(e,s) < 0', () => {
    const sched = makeSched();
    // e(结束) 早于 s(开始) → 差值应为负（源契约 a-b）
    const s = new Date(2026, 7, 14);
    const e = new Date(2026, 7, 12);
    expect(sched.diff(e, s)).toBe(-2);   // e - s = -2（源语义）
    expect(sched.diff(s, e)).toBe(2);
  });
});

describe('scheduler: 撤销/重做（history）', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('初始时无历史可撤销/重做', () => {
    const sched = makeSched();
    expect(sched.canUndo()).toBe(false);
    expect(sched.canRedo()).toBe(false);
  });

  it('addTask 后可撤销，撤销后任务消失，重做恢复', () => {
    const sched = makeSched();
    // 初始无历史（刚创建时仅含初始快照）
    expect(sched.canUndo()).toBe(false);
    sched.addModule({ name: '撤销测试' });
    const beforeCount = sched.tasks().length;
    sched.addTask({ mod: '撤销测试', p: 'dev', name: '待撤销', start: '2026-09-20', dur: 2 });
    expect(sched.canUndo()).toBe(true);
    // 撤销：任务数量回到之前
    const ok = sched.undo();
    expect(ok).toBe(true);
    expect(sched.tasks().length).toBe(beforeCount);
    // 重做：任务恢复
    expect(sched.canRedo()).toBe(true);
    const ok2 = sched.redo();
    expect(ok2).toBe(true);
    const t = sched.tasks().find(x => x.name === '待撤销');
    expect(!!t).toBe(true);
  });

  it('saveTask 修改后可撤销并恢复原值', () => {
    const sched = makeSched();
    const id = 'm1-req';
    const orig = { ...sched.getTask(id) };
    sched.saveTask(id, { name: '改后的名字', dur: 9 });
    expect(sched.getTask(id).name).toBe('改后的名字');
    sched.undo();
    const restored = sched.getTask(id);
    expect(restored.name).toBe(orig.name);
    expect(restored.w).toBe(orig.w);
  });

  it('撤销后新修改会清空重做分支', () => {
    const sched = makeSched();
    sched.addTask({ mod: '官网改版', p: 'dev', name: '操作A', start: '2026-09-20', dur: 1 });
    sched.addTask({ mod: '官网改版', p: 'dev', name: '操作B', start: '2026-09-22', dur: 1 });
    sched.undo();          // 撤销 B，此时有重做
    expect(sched.canRedo()).toBe(true);
    const got = sched.tasks().find(x => x.name === '操作B');
    expect(!got).toBe(true);
    sched.addTask({ mod: '官网改版', p: 'dev', name: '操作C', start: '2026-09-24', dur: 1 });
    expect(sched.canRedo()).toBe(false);   // 新修改清空重做
  });

  it('deleteTask 后可撤销恢复任务', () => {
    const sched = makeSched();
    sched.addModule({ name: '删除撤销' });
    const id = sched.addTask({ mod: '删除撤销', p: 'dev', name: '准备删除', start: '2026-09-20', dur: 1 });
    sched.deleteTask(id);
    expect(!sched.getTask(id)).toBe(true);
    sched.undo();
    expect(!!sched.getTask(id)).toBe(true);
    expect(sched.getTask(id).name).toBe('准备删除');
  });

  it('deleteModule 后可撤销恢复整个需求', () => {
    const sched = makeSched();
    sched.addModule({ name: '需求撤销' });
    sched.addTask({ mod: '需求撤销', p: 'dev', name: '需求内任务', start: '2026-09-20', dur: 1 });
    sched.deleteModule('需求撤销');
    expect(!mods().some(m => m.name === '需求撤销')).toBe(true);
    sched.undo();
    const mo = mods().find(m => m.name === '需求撤销');
    expect(!!mo).toBe(true);
    const t = sched.tasks().find(x => x.name === '需求内任务');
    expect(!!t).toBe(true);
  });

  it('moveModule 排序后可撤销恢复位置', () => {
    const sched = makeSched();
    sched.addModule({ name: '移动A' });
    sched.addModule({ name: '移动B' });
    // 记录顺序：B 在 A 之后
    const idxOf = n => mods().findIndex(m => m.name === n);
    expect(idxOf('移动B')).toBeGreaterThan(idxOf('移动A'));
    // 把 A 移到 B 之前
    sched.moveModule('移动A', '移动B', true);
    expect(idxOf('移动A')).toBeLessThan(idxOf('移动B'));
    // 撤销后恢复原顺序（B 在 A 之后）
    sched.undo();
    expect(idxOf('移动B')).toBeGreaterThan(idxOf('移动A'));
  });

  it('多次撤销到达初始态后不可再撤销，重做可逐步前进', () => {
    const sched = makeSched();
    sched.addModule({ name: '步进1' });
    sched.addModule({ name: '步进2' });
    sched.addModule({ name: '步进3' });
    sched.undo();  // 撤销 步进3
    sched.undo();  // 撤销 步进2
    sched.undo();  // 撤销 步进1
    expect(sched.canUndo()).toBe(false);   // 到底了
    sched.redo();
    expect(mods().some(m => m.name === '步进1')).toBe(true);
    sched.redo();
    expect(mods().some(m => m.name === '步进2')).toBe(true);
    sched.redo();
    expect(mods().some(m => m.name === '步进3')).toBe(true);
    expect(sched.canRedo()).toBe(false);
  });
});

describe('scheduler: saveTask 归属变更（编辑任务改需求/阶段）', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  // 两个空需求 + A 内一个普通任务
  function twoMods(sched) {
    sched.addModule({ name: '需求A', autoCreate: false });
    sched.addModule({ name: '需求B', autoCreate: false });
    return sched.addTask({ mod: '需求A', p: 'dev', name: '待迁移', start: '2026-09-01', dur: 2 });
  }
  const modOf = name => mods().find(m => m.name === name);

  it('改需求：从原需求摘除并追加到目标需求末尾，id 与字段保持不变', () => {
    const sched = makeSched();
    const id = twoMods(sched);
    sched.addTask({ mod: '需求B', p: 'dev', name: 'B已有', start: '2026-09-01', dur: 1 });

    sched.saveTask(id, { mod: '需求B' });

    expect(modOf('需求A').bars.some(b => b.id === id)).toBe(false);
    expect(modOf('需求B').bars[modOf('需求B').bars.length - 1].id).toBe(id);
    const t = sched.getTask(id);
    expect(t.id).toBe(id);          // id 不变 → 其他任务对它的依赖引用不受影响
    expect(t.mod).toBe('需求B');     // collect 写回归属
    expect(t.s).toBe('2026-09-01');
    expect(t.e).toBe('2026-09-02');
  });

  it('改阶段：p 更新，日期与 id 不受影响', () => {
    const sched = makeSched();
    const id = twoMods(sched);
    sched.saveTask(id, { p: 'sit' });
    const t = sched.getTask(id);
    expect(t.p).toBe('sit');
    expect(t.id).toBe(id);
    expect(t.s).toBe('2026-09-01');
  });

  it('传相同的 mod/p 时不产生任何移动（幂等）', () => {
    const sched = makeSched();
    const id = twoMods(sched);
    const before = modOf('需求A').bars.map(b => b.id);
    sched.saveTask(id, { mod: '需求A', p: 'dev' });
    expect(modOf('需求A').bars.map(b => b.id)).toEqual(before);
    expect(modOf('需求B').bars.length).toBe(0);
  });

  it('目标需求不存在时保持原样，不丢任务', () => {
    const sched = makeSched();
    const id = twoMods(sched);
    sched.saveTask(id, { mod: '不存在的需求' });
    expect(sched.getTask(id).mod).toBe('需求A');
    expect(modOf('需求A').bars.some(b => b.id === id)).toBe(true);
  });

  it('里程碑默认名取阶段名，自定义 label 跨需求保持不动', () => {
    const sched = makeSched();
    const id = twoMods(sched);
    const msDefault = sched.addTask({ mod: '需求A', p: 'go', type: 'ms', start: '2026-09-10' });
    const msCustom = sched.addTask({ mod: '需求A', p: 'go', type: 'ms', name: '自定义上线', start: '2026-09-10' });
    expect(sched.getTask(msDefault).label).toBe('上线');   // 阶段名兜底，不含需求名

    sched.saveTask(msDefault, { type: 'ms', mod: '需求B' });
    sched.saveTask(msCustom, { type: 'ms', mod: '需求B' });

    expect(sched.getTask(msDefault).label).toBe('上线');   // 不含需求名 → 跨需求移动无需同步前缀
    expect(sched.getTask(msCustom).label).toBe('自定义上线');
    expect(sched.getTask(msDefault).mod).toBe('需求B');
    expect(sched.getTask(id).mod).toBe('需求A');   // 未指定 mod 的任务不受影响
  });

  it('历史数据的「需求名 里程碑」默认名：改归属时同步前缀', () => {
    const sched = makeSched();
    const other = twoMods(sched);
    expect(sched.getTask(other).mod).toBe('需求A');

    const legacy = sched.addTask({ mod: '需求A', p: 'go', type: 'ms', start: '2026-09-10' });
    // 模拟历史数据：label 是「需求名 里程碑」（迁移前 addTask 的默认值）
    planStore.state.modules.find(m => m.name === '需求A').bars.find(b => b.id === legacy).label = '需求A 里程碑';
    sched.collect();

    sched.saveTask(legacy, { type: 'ms', mod: '需求B' });
    expect(sched.getTask(legacy).label).toBe('需求B 里程碑');
  });

  it('归属变更可撤销：撤销后回到原需求', () => {
    const sched = makeSched();
    const id = twoMods(sched);
    sched.saveTask(id, { mod: '需求B' });
    expect(sched.getTask(id).mod).toBe('需求B');
    sched.undo();
    expect(sched.getTask(id).mod).toBe('需求A');
    expect(modOf('需求B').bars.length).toBe(0);
  });

  it('READONLY 守卫：归属变更静默不生效', () => {
    const sched = makeSched();
    const id = twoMods(sched);
    userStore.set({ readonly: true });
    sched.saveTask(id, { mod: '需求B', p: 'sit' });
    expect(sched.getTask(id).mod).toBe('需求A');
    expect(sched.getTask(id).p).toBe('dev');
  });
});

// ---------------------------------------------------------------------------
// 回归：新建里程碑后补写依赖导致"里程碑被降级成任务 + res 未初始化崩溃"
// 现象：Uncaught TypeError: Cannot read properties of undefined (reading 'forEach')
//       at recomputeAffected → ctx.tasks.forEach(t => ... t.res.forEach(...))
// 根因：drawers.js 新建后补写 dep 时 saveTask 未带 type，saveTask 走"转成普通任务"分支
//       → delete raw.m（里程碑降级为任务）且未初始化 res → 级联重算读 t.res 崩溃
// ---------------------------------------------------------------------------
describe('scheduler: 里程碑局部更新不被降级（回归）', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('新建里程碑后补写依赖：仍为里程碑，不被降级成普通任务', () => {
    const sched = makeSched();
    const mod = mods()[0].name;
    const anchor = mods()[0].bars.find(b => !b.m);
    const msId = sched.addTask({ mod, p: 'go', name: '上线里程碑', type: 'ms', start: '2026-09-01', manual: true });
    // 模拟 drawers.js：仅补写 dep，未显式带 type
    sched.saveTask(msId, { dep: [{ id: anchor.id, lag: 0 }] });

    const ms = sched.getTask(msId);
    expect(!!ms).toBe(true);
    expect(ms.isMs).toBe(true);          // 仍是里程碑
    expect(!!ms.m).toBe(true);           // 上线日字段未被删除
    expect(ms.dep.length).toBe(1);       // 依赖已写入
    expect(ms.dep[0].id).toBe(anchor.id);
  });

  it('里程碑局部更新不带 type 不会抛出 res 未定义的 TypeError', () => {
    const sched = makeSched();
    const mod = mods()[0].name;
    const msId = sched.addTask({ mod, p: 'go', type: 'ms', start: '2026-09-01', manual: true });
    expect(() => sched.saveTask(msId, { dep: [] })).not.toThrow();
    expect(() => sched.collect()).not.toThrow();
  });

  it('collect 自愈：普通任务缺 res 时补空数组，computeSchedule 不崩', () => {
    const sched = makeSched();
    const mod = mods()[0].name;
    const id = sched.addTask({ mod, p: 'dev', type: 'task', start: '2026-09-01', dur: 2, res: [], manual: false });
    const raw = sched.getTask(id);
    delete raw.res;                      // 模拟脏数据（历史被降级流程改写过的任务）
    expect(() => sched.collect()).not.toThrow();
    expect(Array.isArray(sched.getTask(id).res)).toBe(true);
    expect(() => sched.computeSchedule()).not.toThrow();
  });

  it('普通任务显式转里程碑 / 里程碑显式转任务仍然生效', () => {
    const sched = makeSched();
    const mod = mods()[0].name;
    const id = sched.addTask({ mod, p: 'dev', type: 'task', start: '2026-09-01', dur: 3, res: [], manual: true });
    sched.saveTask(id, { type: 'ms', start: '2026-09-10', manual: true });
    expect(sched.getTask(id).isMs).toBe(true);

    sched.saveTask(id, { type: 'task', start: '2026-09-15', dur: 2, manual: true });
    const back = sched.getTask(id);
    expect(back.isMs).toBe(false);
    expect(Array.isArray(back.res)).toBe(true);   // 转回任务时 res 必须可用
  });
});

describe('scheduler: 需求提出信息与生命周期字段', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('addModule 落提出人与提出时间（提出人 trim）', () => {
    const sched = makeSched();
    const mo = sched.addModule({
      name: '字段样本', autoCreate: false,
      proposedBy: ' 张三 ', proposedAt: '2026-08-01', lifecycle: '已确认'
    });
    expect(mo.proposedBy).toBe('张三');
    expect(mo.proposedAt).toBe('2026-08-01');
    expect(mo.lifecycle).toBe('已确认');
  });

  it('addModule 不传 lifecycle 时不臆造默认值（默认「待分析」由新建弹窗给）', () => {
    const sched = makeSched();
    const mo = sched.addModule({ name: '无生命周期', autoCreate: false });
    // 键存在但值为 undefined —— 与 desc / docUrl 的写法一致（数据层不替用户补值）
    expect('lifecycle' in mo).toBe(true);
    expect(mo.lifecycle).toBe(undefined);
  });

  it('addModule 拒绝非法提出日期（手改 JSON / 外部导入的脏值）', () => {
    const sched = makeSched();
    const mo = sched.addModule({ name: '脏日期', autoCreate: false, proposedAt: '2026/08/01' });
    expect('proposedAt' in mo).toBe(true);
    expect(mo.proposedAt).toBe(undefined);
  });

  it('updateModule 传空串 = 清除字段（回到未填写 / 未设置）', () => {
    const sched = makeSched();
    sched.addModule({
      name: '待清空', autoCreate: false,
      proposedBy: '李四', proposedAt: '2026-08-02', lifecycle: '已提测'
    });
    sched.updateModule({ oldName: '待清空', proposedBy: '', proposedAt: '', lifecycle: '' });
    const mo = mods().find(m => m.name === '待清空');
    expect('proposedBy' in mo).toBe(false);
    expect('proposedAt' in mo).toBe(false);
    expect('lifecycle' in mo).toBe(false);
  });

  it('updateModule 传非法 lifecycle 等同清除（回到未设置）', () => {
    const sched = makeSched();
    sched.addModule({ name: '非法状态', autoCreate: false, lifecycle: '已确认' });
    sched.updateModule({ oldName: '非法状态', lifecycle: '已验收' });
    expect('lifecycle' in mods().find(m => m.name === '非法状态')).toBe(false);
  });
});

describe('scheduler: 需求归属 owner', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('addModule 默认把归属写成当前用户的人名', () => {
    const sched = makeSched();
    userStore.set({ resourceName: '张三' });
    sched.addModule({ name: '归属需求', autoCreate: false });
    expect(planStore.state.modules.find(m => m.name === '归属需求').owner).toBe('张三');
  });

  it('addModule 没配人名时不写归属（不臆造）', () => {
    const sched = makeSched();
    userStore.set({ resourceName: '' });
    sched.addModule({ name: '无主需求', autoCreate: false });
    const mo = planStore.state.modules.find(m => m.name === '无主需求');
    expect('owner' in mo).toBe(false);
  });

  it('opts.owner 可显式指定（供转交/导入用）', () => {
    const sched = makeSched();
    userStore.set({ resourceName: '张三' });
    sched.addModule({ name: '指定归属', autoCreate: false, owner: '李四' });
    expect(planStore.state.modules.find(m => m.name === '指定归属').owner).toBe('李四');
  });

  it('addModule 归属人名带空格会被 trim', () => {
    const sched = makeSched();
    userStore.set({ resourceName: '  张三  ' });
    sched.addModule({ name: '去空格', autoCreate: false });
    expect(planStore.state.modules.find(m => m.name === '去空格').owner).toBe('张三');
  });

  it('updateModule 支持转交归属', () => {
    const sched = makeSched();
    userStore.set({ resourceName: '张三' });
    sched.addModule({ name: '待转交', autoCreate: false });
    sched.updateModule({ name: '待转交', owner: '李四' });
    expect(planStore.state.modules.find(m => m.name === '待转交').owner).toBe('李四');
  });

  it('updateModule 传空串 = 清除归属（回到无主），与 desc/docUrl 同口径', () => {
    const sched = makeSched();
    const mo = planStore.state.modules.find(m => m.name === '官网改版');
    mo.owner = '张三';
    sched.updateModule({ name: '官网改版', owner: '' });
    expect('owner' in planStore.state.modules.find(m => m.name === '官网改版')).toBe(false);
  });

  it('不传 owner 时 updateModule 不动归属（patch 语义）', () => {
    const sched = makeSched();
    const mo = planStore.state.modules.find(m => m.name === '官网改版');
    mo.owner = '张三';
    sched.updateModule({ name: '官网改版', pri: 'P0' });
    expect(planStore.state.modules.find(m => m.name === '官网改版').owner).toBe('张三');
  });
});

describe('scheduler: 按目标粒度的守卫', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  // 造一个"协作者"上下文：access 显式设成 collab，人名张三
  const asCollab = () => userStore.set({ readonly: false, access: 'collab', resourceName: '张三' });
  const asFull = () => userStore.set({ readonly: false, access: 'full', resourceName: '张三' });

  it('协作者不能改别人负责的任务（静默不生效 + 可 throw 语义）', () => {
    const sched = makeSched();
    asCollab();
    // m1-sit 的 res 是 ["吴十"]，不归张三
    sched.saveTask('m1-sit', { name: '偷改' });
    expect(sched.getTask('m1-sit').name).not.toBe('偷改');
  });

  it('协作者能改自己负责的任务', () => {
    const sched = makeSched();
    asCollab();
    // m1-req 的 res 是 ["张三"]
    sched.saveTask('m1-req', { name: '我的任务' });
    expect(sched.getTask('m1-req').name).toBe('我的任务');
  });

  it('协作者能改未分配的任务（res 为空数组）', () => {
    const sched = makeSched();
    asCollab();
    sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1, res: [] });
    const t = sched.tasks().filter(x => !x.isMs && (x.res || []).length === 0).pop();
    sched.saveTask(t.id, { name: '待认领的活' });
    expect(sched.getTask(t.id).name).toBe('待认领的活');
  });

  it('协作者不能动资源库', () => {
    const sched = makeSched();
    asCollab();
    const before = planStore.state.resources.length;
    sched.addResource({ name: '新人' });
    expect(planStore.state.resources.length).toBe(before);
  });

  // ⚠️ 里程碑用例必须用**真正的里程碑**（有 m 键、无 res 键）。
  //   初版误用了 'm1-cfm' —— 它是普通任务（p:'cfm'、res:['钱七']、无 m），
  //   moveMilestone 会在"找不到 target"处提前 return，msGuard 的 milestone 分支一次都没执行，
  //   用例在"无守卫 / 守卫退回 task 分支"时也全绿（空转）。
  //   真正的里程碑是 default-data.js:62 的 { m:"2026-09-09", label:"9/9 上线" }（无 id，由 collect() 惰性生成）。
  const findMs = sched => sched.tasks().find(t => t.isMs && t.mod === '官网改版');

  it('协作者不能动无主需求里的里程碑', () => {
    const sched = makeSched();
    asCollab();
    // default-data.js:62 的 { m:"2026-09-09", label:"9/9 上线" } 才是真里程碑（无 res 键）
    const ms = findMs(sched);
    expect(ms).toBeTruthy();
    expect(ms.m).toBe('2026-09-09');
    sched.moveMilestone(ms.id, '2026-10-01');
    expect(sched.getTask(ms.id).m).toBe('2026-09-09');    // 没被改动
  });

  it('协作者能改**自己需求**里的里程碑（需求创建人全权）', () => {
    const sched = makeSched();
    asCollab();
    const mo = planStore.state.modules.find(m => m.name === '官网改版');
    mo.owner = '张三';                                     // 让它成为张三的需求
    const ms = findMs(sched);
    expect(ms).toBeTruthy();
    sched.moveMilestone(ms.id, '2026-10-01');
    expect(sched.getTask(ms.id).m).toBe('2026-10-01');    // 允许改
  });

  // Important-1 的入口直证：编辑分支对里程碑必须走 {kind:'milestone'}，
  // 否则 taskMine 对"无 res 的里程碑"返回 false → 协作者在**自己的需求**里点这两条也没反应。
  it('协作者能在自己需求里编辑里程碑（抽屉保存 / 右键标记完成 / 切手动）', () => {
    const sched = makeSched();
    asCollab();
    planStore.state.modules.find(m => m.name === '官网改版').owner = '张三';
    const ms = findMs(sched);

    // 抽屉保存：改 label + 上线日（saveTask 编辑分支）
    sched.saveTask(ms.id, { type: 'ms', name: '张三的上线', start: '2026-10-05' });
    expect(sched.getTask(ms.id).label).toBe('张三的上线');
    expect(sched.getTask(ms.id).m).toBe('2026-10-05');

    // 右键「切换手动/自动」
    sched.saveTask(ms.id, { type: 'ms', manual: false });
    expect(sched.getTask(ms.id).manual).toBe(false);

    // 右键「标记完成」：里程碑无完成度概念，done 被清掉，但不该被守卫拦掉（manual 要能写进去）
    sched.saveTask(ms.id, { type: 'ms', manual: true, done: 100 });
    expect(sched.getTask(ms.id).manual).toBe(true);
    expect(sched.getTask(ms.id).done).toBeUndefined();
  });

  it('协作者不能在无主需求里编辑里程碑（抽屉保存同样被拦）', () => {
    const sched = makeSched();
    asCollab();
    const ms = findMs(sched);
    sched.saveTask(ms.id, { type: 'ms', name: '偷改', start: '2026-10-05' });
    expect(sched.getTask(ms.id).label).toBe('9/9 上线');
    expect(sched.getTask(ms.id).m).toBe('2026-09-09');
  });

  // ⚠️ 这里刻意分成"无主"与"自己的"两条，因为它们的**权限结论相反**。
  //   决策 §1.1-13 是「需求创建人有该需求所有权限（改名/删除/归档/转交）」，
  //   所以归属人可以给自己需求改名/归档；无主需求才轮不到协作者。
  //   （初版这里写成"协作者不能给自己需求改名/归档"，与设计直接冲突，属计划缺陷，2026-10-23 修正。）
  it('协作者对**无主需求**不能改名（归档已由下一条覆盖）', () => {
    const sched = makeSched();
    asCollab();
    // 默认数据的「官网改版」没有 owner 字段 = 无主 → 协作者对它没有归属权
    expect(() => sched.updateModule({ name: '改名', oldName: '官网改版' })).toThrow();
    expect(planStore.state.modules.some(m => m.name === '官网改版')).toBe(true);   // 没被改掉
  });

  it('协作者能改**自己的需求**的字段，也能改名 / 归档（需求创建人全权）', () => {
    const sched = makeSched();
    asCollab();
    sched.addModule({ name: '我的需求', autoCreate: false });   // owner = 张三
    // 字段级
    sched.updateModule({ name: '我的需求', pri: 'P0' });
    expect(planStore.state.modules.find(m => m.name === '我的需求').pri).toBe('P0');
    // 归属级：改名（需求创建人有权）
    sched.updateModule({ oldName: '我的需求', name: '我的需求V2' });
    expect(planStore.state.modules.some(m => m.name === '我的需求V2')).toBe(true);
    // 归属级：归档（同上）
    sched.archiveModule('我的需求V2', true);
    expect(!!planStore.state.modules.find(m => m.name === '我的需求V2').archived).toBe(true);
  });

  it('协作者能改无主需求的字段，但不能归档它', () => {
    const sched = makeSched();
    asCollab();
    sched.updateModule({ name: '官网改版', pri: 'P0' });
    expect(planStore.state.modules.find(m => m.name === '官网改版').pri).toBe('P0');
    sched.archiveModule('官网改版', true);
    expect(!!planStore.state.modules.find(m => m.name === '官网改版').archived).toBe(false);
  });

  it('协作者不能动版本删除与一键归档，但能改版本', () => {
    const sched = makeSched();
    asCollab();
    const v = sched.createVersion({ name: '9月版', date: '2026-09-30' });
    const vid = v.version.id;
    sched.shipVersion(vid, true, '2026-09-30');
    expect(planStore.state.versions.find(x => x.id === vid).shipped).toBe(true);
    sched.deleteVersion(vid);
    expect(planStore.state.versions.some(x => x.id === vid)).toBe(true);   // 没被删掉
  });

  // 标题只写它**真正覆盖**的范围（初版标题写了"撤销 / 导入"却只断言 computeSchedule）。
  // 撤销 / 导入各自拆了专条（见下两条），因为它们的语义不同：undo 返回 false，importJSON 是 throw。
  it('协作者不能一键自动计划（computeSchedule 静默不生效）', () => {
    const sched = makeSched();
    asCollab();
    const before = JSON.stringify(planStore.state.modules);
    sched.computeSchedule();
    expect(JSON.stringify(planStore.state.modules)).toBe(before);
  });

  it('协作者不能撤销（数据层拦截，不止按钮 disabled）', () => {
    const sched = makeSched();
    asFull();
    sched.saveTask('m1-req', { name: '全权改的' });   // 制造一个可撤销的历史快照
    expect(sched.canUndo()).toBe(true);
    asCollab();
    expect(sched.undo()).toBe(false);                 // 被守卫拦下
    expect(sched.getTask('m1-req').name).toBe('全权改的');   // 没被回滚
  });

  it('协作者不能导入（importJSON 抛错，数据不变）', () => {
    const sched = makeSched();
    asCollab();
    const before = JSON.stringify(planStore.state.modules);
    const payload = JSON.stringify({ modules: [{ name: '被导入', tag: '冲刺中', tagc: '#000', bars: [] }] });
    expect(() => sched.importJSON(payload)).toThrow('只读模式');
    expect(JSON.stringify(planStore.state.modules)).toBe(before);
  });

  it('全权用户不受影响（回归）', () => {
    const sched = makeSched();
    asFull();
    sched.saveTask('m1-sit', { name: '我能改' });
    expect(sched.getTask('m1-sit').name).toBe('我能改');
    sched.addResource({ name: '新人' });
    expect(planStore.state.resources.some(r => r.name === '新人')).toBe(true);
  });

  it('只读模式仍然全拦（回归）', () => {
    const sched = makeSched();
    userStore.set({ readonly: true });
    expect(() => sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1 })).toThrow('只读模式');
  });
});

describe('scheduler: setProgress', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  const asCollab = () => userStore.set({ readonly: false, access: 'collab', resourceName: '张三' });

  it('写入归一化后的整数百分比', () => {
    const sched = makeSched();
    expect(sched.setProgress('m1-req', 40)).toBe(40);
    expect(sched.getTask('m1-req').done).toBe(40);
  });

  it('越界与小数被钳制/取整，非法值不动数据', () => {
    const sched = makeSched();
    expect(sched.setProgress('m1-req', 140)).toBe(100);
    expect(sched.getTask('m1-req').done).toBe(100);
    expect(sched.setProgress('m1-req', -20)).toBe(0);
    expect(sched.getTask('m1-req').done).toBe(0);
    expect(sched.setProgress('m1-req', 33.7)).toBe(34);
    // 非数值（含空串）→ 直接返回 null，不把 done 写成 NaN
    expect(sched.setProgress('m1-req', '')).toBe(null);
    expect(sched.setProgress('m1-req', 'abc')).toBe(null);
    expect(sched.getTask('m1-req').done).toBe(34);
  });

  it('空值与纯空白 → null 且不把 done 写成 0（Number("")===0 陷阱）', () => {
    const sched = makeSched();
    // 先落一个非 0 的基线，若归一化链条漏了前置判据，'' / '   ' / null / undefined 都会被写成 0
    expect(sched.setProgress('m1-req', 55)).toBe(55);
    for (const bad of ['', '   ', null, undefined, 'abc']) {
      expect(sched.setProgress('m1-req', bad)).toBe(null);
      expect(sched.getTask('m1-req').done).toBe(55);
    }
  });

  it('不存在的任务 / 里程碑 → null 且不报错', () => {
    const sched = makeSched();
    expect(sched.setProgress('no-such-id', 50)).toBe(null);
    // ⚠️ 真里程碑是 default-data.js:62 的 { m:"2026-09-09", label:"9/9 上线" }（原始数据无 id，
    //   由 collect() 惰性补上）。**m1-cfm 是普通任务**（p:"cfm"、res:["钱七"]、无 m 键），
    //   拿它当里程碑会让这条断言空转——Task 7 已经踩过同一个坑。
    const ms = sched.tasks().find(t => t.isMs && t.mod === '官网改版');
    expect(ms).toBeTruthy();
    expect(ms.m).toBe('2026-09-09');
    expect(sched.setProgress(ms.id, 50)).toBe(null);
    expect(sched.getTask(ms.id).done).toBeUndefined();
  });

  it('协作者能改自己负责的任务', () => {
    const sched = makeSched();
    asCollab();
    expect(sched.setProgress('m1-req', 60)).toBe(60);      // res = ["张三"]
  });

  it('协作者改不了别人负责的任务（静默不生效）', () => {
    const sched = makeSched();
    asCollab();
    const before = sched.getTask('m1-sit').done;           // res = ["吴十"]
    expect(sched.setProgress('m1-sit', 60)).toBe(null);
    expect(sched.getTask('m1-sit').done).toBe(before);
  });

  it('数据层对未分配任务仍然放行（本页的"未分配只读"是界面口径，不是数据层口径）', () => {
    const sched = makeSched();
    asCollab();
    // 显式造一条未分配任务
    sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1, res: [], id: 'U' });
    expect(sched.setProgress('U', 30)).toBe(30);
  });

  it('只读模式拦下', () => {
    const sched = makeSched();
    userStore.set({ readonly: true });
    expect(sched.setProgress('m1-req', 50)).toBe(null);
  });

  it('改进度不改变任何日期（不触发重排）', () => {
    const sched = makeSched();
    const before = JSON.stringify(planStore.state.modules.map(m => m.bars.map(b => [b.s, b.e, b.m])));
    sched.setProgress('m1-req', 80);
    const after = JSON.stringify(planStore.state.modules.map(m => m.bars.map(b => [b.s, b.e, b.m])));
    expect(after).toBe(before);
  });
});

describe('scheduler: 级联断链', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  const asCollab = () => userStore.set({ readonly: false, access: 'collab', resourceName: '张三' });
  const asFull = () => userStore.set({ readonly: false, access: 'full', resourceName: '张三' });

  // ⚠️ 凡是要造"别人的任务"（res:['李四']）的用例，必须**先建链、再 asCollab()**：
  //   addTask 的守卫按"打算派给谁"判（决策 B：新增任务负责人默认自己），协作者张三
  //   新建一条 res:['李四'] 的任务会被**正确地**拒绝。若在 asCollab() 之后才建那条
  //   "别人的任务"，用例测的就变成 addTask 的守卫，而不是级联断链。
  //   userStore.reset() 默认 access:'full'，所以 asCollab() 之前建链天然是全权身份。
  //   例外：全部 res 都是张三的用例（如「下游是自己人时不断链」）可在 asCollab() 之后建。
  //
  // 🧨 另一处坑（2026-10-23 实测）：`addTask` 默认 `manual: true`（避免被一键自动计划冲掉），
  //   而 `recomputeAffected` 对手动任务的行为是"保持现状、不重排"。于是"下游是自己人"时
  //   B 虽然进了 affected 却原地不动 —— 于是"断链"与"不断链"在日期上无法区分，用例测不出东西。
  //   凡是要看 B 被真正重排的用例，建 B 时必须显式 `manual: false`（自动任务才会被重算）。
  //
  // 另注意：`cascade` 只把**锚点**挪到新日期，锚点本身不会被 recompute 二次落位，
  //   所以日期取工作日时不要用周一（非工作日起点不会被吸附），用 2026-09-21（周一）这类**工作日**。

  it('全权用户：级联照旧，没有任何钉住（回归）', () => {
    const sched = makeSched();
    asFull();
    // m1-dev(钱七) → m1-sit(吴十)：都是别人的任务，全权用户照常全部重排
    const before = sched.getTask('m1-sit').s;
    const r = sched.cascade('m1-dev', '2026-09-20');
    expect(r.pinned).toEqual([]);
    expect(sched.getTask('m1-sit').s).not.toBe(before);
  });

  it('协作者拖自己的任务：下游他人任务被钉住且不再下探', () => {
    const sched = makeSched();
    // 造一条链：我的任务 A(张三) → 别人的 B(李四) → 我的 C(张三)
    // 建链必须在 asCollab() 之前（协作者不能新建派给别人的任务）
    sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1, res: ['张三'], id: 'A' });
    // B、C 必须是自动任务，否则 recompute 会因 manual 而保持现状，"断链"无从观测
    sched.addTask({ mod: '官网改版', p: 'sit', start: '2026-09-02', dur: 1, res: ['李四'], id: 'B', manual: false });
    sched.addTask({ mod: '官网改版', p: 'uat', start: '2026-09-03', dur: 1, res: ['张三'], id: 'C', manual: false });
    sched.saveTask('B', { dep: [{ id: 'A', lag: 0 }] });
    sched.saveTask('C', { dep: [{ id: 'B', lag: 0 }] });
    asCollab();   // ← 之后只做"拖动"

    const bBefore = sched.getTask('B').s;
    const cBefore = sched.getTask('C').s;
    const r = sched.cascade('A', '2026-09-21');            // 工作日（周一），锚点原样落位

    expect(r.pinned).toEqual(['B']);                       // B 被钉住
    expect(sched.getTask('B').manual).toBe(true);
    expect(sched.getTask('B').s).toBe(bBefore);            // B 的日期没动
    expect(sched.getTask('C').s).toBe(cBefore);            // 断链 → C 也没动
    expect(sched.getTask('A').s).toBe('2026-09-21');       // 我的 A 正常落位
  });

  it('断链后会产生「依赖违反」问题（进风险面板）', () => {
    const sched = makeSched();
    sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1, res: ['张三'], id: 'A' });
    sched.addTask({ mod: '官网改版', p: 'sit', start: '2026-09-02', dur: 1, res: ['李四'], id: 'B', manual: false });
    sched.saveTask('B', { dep: [{ id: 'A', lag: 0 }] });
    asCollab();   // ← 建链后才切身份
    const r = sched.cascade('A', '2026-09-21');
    expect(r.pinned).toEqual(['B']);                       // 前提：确实断链了
    const probs = sched.detectProblems();                  // API 名为 detectProblems（无 detect 别名）
    expect(probs.some(p => p.type === 'depend' && p.taskId === 'B')).toBe(true);
  });

  it('下游是自己人时不断链', () => {
    const sched = makeSched();
    asCollab();
    sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1, res: ['张三'], id: 'A' });
    // B 必须自动，否则 recompute 因 manual 保持现状 → 与"断链"结果完全相同，用例测不出东西
    sched.addTask({ mod: '官网改版', p: 'sit', start: '2026-09-02', dur: 1, res: ['张三'], id: 'B', manual: false });
    sched.saveTask('B', { dep: [{ id: 'A', lag: 0 }] });
    const r = sched.cascade('A', '2026-09-21');
    expect(r.pinned).toEqual([]);
    expect(sched.getTask('B').s).toBe('2026-09-22');       // 被级联推到前置结束的次日
  });

  it('previewCascade 与 cascade 用同一条影响集合（预览必须等于落位）', () => {
    const sched = makeSched();
    sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1, res: ['张三'], id: 'A' });
    sched.addTask({ mod: '官网改版', p: 'sit', start: '2026-09-02', dur: 1, res: ['李四'], id: 'B' });
    sched.saveTask('B', { dep: [{ id: 'A', lag: 0 }] });
    asCollab();   // ← 建链后才切身份
    const preview = [...sched.previewCascade('A', '2026-09-21')].sort();
    sched.cascade('A', '2026-09-21');
    // 预览里不应出现 B（它不会被重排）
    expect(preview).not.toContain('B');
    expect(preview).toContain('A');
  });

  it('previewCascade 不产生副作用（预览不写 manual）', () => {
    const sched = makeSched();
    sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1, res: ['张三'], id: 'A' });
    // B 必须自动：若 B 本来就是 manual，这条用例同样恒真（测不出 dryRun 有没有生效）
    sched.addTask({ mod: '官网改版', p: 'sit', start: '2026-09-02', dur: 1, res: ['李四'], id: 'B', manual: false });
    sched.saveTask('B', { dep: [{ id: 'A', lag: 0 }] });
    asCollab();   // ← 建链后才切身份
    const preview = sched.previewCascade('A', '2026-09-21');
    expect(preview.has('A')).toBe(true);                   // 前提：预览真的跑起来了
    expect(sched.getTask('B').manual).toBe(false);         // 但没写 manual
    // 对照：落位时同样断链，B 会被钉住 → 证明上面的 false 不是"断链压根没触发"
    const r = sched.cascade('A', '2026-09-21');
    expect(r.pinned).toEqual(['B']);
    expect(sched.getTask('B').manual).toBe(true);
  });
});

// ============================================================
// 修复轮（Task 9）：saveTask 只在"日期真的变了"时才级联
//
// 为什么必须这样（线上故障级）：collectAffectedCapped/collectAffected 的断链判定在
// **BFS 遍历时**就把"不可编辑的下游节点"钉成 manual —— 不管它会不会动。而抽屉保存会把
// 整份 draft 原样回传（start/dur/manual/dep 全带上）。于是协作者"打开抽屉、什么都不改、
// 点保存"也会把下游他人任务钉成手动；服务端 assert_plan_editable 的 v_moved 只认
// s/e/m 有变化 → 本次提交"动了别人的任务"却没有任何日期变化 → 钉住被 42501 拒 →
// save_plan 整体失败 + 回滚。结论：只要下游有别人的任务，协作者连保存都做不了。
//
// 判据因此落在"锚点自己的 s/e/m 变没变"上：
//   没变 → 不跑级联 → 不钉人 → 保存必然通过
//   变了 → 跑级联 → 钉住有依据 → 服务端 v_moved 非空 → 特许①成立
// 两条用例必须能**区分**：下面第一条在"无条件级联"的实现下会红（pinned=['B']、
// B.manual 被改成 true），第二条在"改了日期也不级联"的实现下会红。
// ============================================================
describe('scheduler: saveTask 只在日期变化时级联（修复轮）', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  const asCollab = () => userStore.set({ readonly: false, access: 'collab', resourceName: '张三' });

  // 建链必须在切身份之前：addTask 的守卫按"打算派给谁"判，协作者建不了 res:['李四'] 的任务
  function chain() {
    const sched = makeSched();
    sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1, res: ['张三'], id: 'A' });
    // B 必须自动（manual:false）：若 B 本来就是 manual，"有没有被误钉"在数据上无法区分
    sched.addTask({ mod: '官网改版', p: 'sit', start: '2026-09-02', dur: 1, res: ['李四'], id: 'B', manual: false });
    sched.saveTask('B', { dep: [{ id: 'A', lag: 0 }] });
    return sched;
  }

  it('协作者只保存、日期一个没改：不跑级联，下游他人任务仍是自动，pinned 为空', () => {
    const sched = chain();
    asCollab();

    const a = sched.getTask('A');
    // 与抽屉"原样回传"等价：日期/工作量/负责人/依赖全部照抄当前值
    const r = sched.saveTask('A', {
      type: 'task', res: [...a.res], dep: a.dep.map(d => ({ ...d })),
      start: a.s, dur: a.w, manual: a.manual
    });

    expect(r && r.pinned).toEqual([]);              // ← 一个人都没钉
    expect(sched.getTask('B').manual).toBe(false);  // ← 关键：下游他人任务没被误钉成手动
    expect(sched.getTask('A').s).toBe('2026-09-01');
    expect(sched.getTask('A').e).toBe('2026-09-01');
  });

  it('协作者改了日期：下游他人任务被钉住，pinned 含它（服务端 v_moved 非空，可过校验）', () => {
    const sched = chain();
    asCollab();

    const r = sched.saveTask('A', {
      type: 'task', res: ['张三'], dep: [], start: '2026-09-21', dur: 1, manual: true
    });

    expect(r.pinned).toEqual(['B']);                // ← 钉住有依据（A 的 s 变了）
    expect(sched.getTask('B').manual).toBe(true);
    expect(sched.getTask('A').s).toBe('2026-09-21');
  });

  it('pinned 只计"真的从自动改成手动"的节点：本来就 manual 的下游不算虚数', () => {
    const sched = makeSched();
    sched.addTask({ mod: '官网改版', p: 'dev', start: '2026-09-01', dur: 1, res: ['张三'], id: 'A' });
    // B 用 addTask 默认的 manual:true —— 它本来就是手动，"被钉住"这件事无从谈起
    sched.addTask({ mod: '官网改版', p: 'sit', start: '2026-09-02', dur: 1, res: ['李四'], id: 'B' });
    sched.saveTask('B', { dep: [{ id: 'A', lag: 0 }] });
    asCollab();

    const r = sched.saveTask('A', {
      type: 'task', res: ['张三'], dep: [], start: '2026-09-21', dur: 1, manual: true
    });

    expect(r.pinned).toEqual([]);                   // 提示里的"N 条"不该含虚数
    expect(sched.getTask('B').manual).toBe(true);   // 断链依旧成立（B 没被重排）
  });

  // 第三条会钉人的路径：需求从「待排期」改成「已排期」时补钉上线日（updateModule）。
  // updateModule 的返回值是需求对象（不能塞 pinned），所以钉住结果经 sched.takePinned() 交回界面。
  // 没有这条用例，pushPinned 是否真的接上、takePinned 是否真能取到，全靠读代码猜。
  it('需求补钉上线日（待排期→已排期）：钉住的他人任务经 takePinned 交回界面', () => {
    const sched = makeSched();
    sched.addModule({ name: '我的需求', autoCreate: false });
    sched.addTask({ mod: '我的需求', p: 'dev', start: '2026-09-01', dur: 1, res: ['张三'], id: 'A' });
    sched.addTask({ mod: '我的需求', p: 'go', type: 'ms', start: '2026-09-10', id: 'MS' });
    // 上线里程碑的下游是别人的自动任务：钉上线日 → 级联一碰它就断链
    sched.addTask({ mod: '我的需求', p: 'sit', start: '2026-09-11', dur: 1, res: ['李四'], id: 'B', manual: false });
    sched.saveTask('B', { dep: [{ id: 'MS', lag: 0 }] });
    sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['我的需求'] });
    sched.updateModule({ name: '我的需求', unscheduled: true });

    asCollab();
    sched.updateModule({ name: '我的需求', unscheduled: false });   // ← 补钉上线日 + 级联

    expect(sched.takePinned()).toEqual(['B']);      // 钉住结果没被丢掉
    expect(sched.getTask('B').manual).toBe(true);
    expect(sched.takePinned()).toEqual([]);         // 取走即清空（不会污染之后的操作）
  });
});

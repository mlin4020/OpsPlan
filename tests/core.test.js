// core 模块测试：dates / default-data / workday / plan-store / user-store
import { describe, it, expect, beforeEach } from 'vitest';

import { F, pad, fmt, addDays, diff, fmtD } from '../src/core/dates.js';
import {
  PNAME, PCOL, PHASE_LIST,
  MODULE_LIFECYCLE, LIFECYCLE_DEFAULT, LIFECYCLE_NONE, normalizeLifecycle,
  defaultModules, defaultResources, defaultHolidays
} from '../src/core/default-data.js';
import { createWorkday } from '../src/core/workday.js';
import { computePlanPct, computeModuleTag, unscheduledModSet, moduleTag, currentPhase, findGateMs } from '../src/core/mod-tag.js';
import { modStats } from '../src/core/mod-stats.js';
import { isOverdueTask } from '../src/core/task-status.js';
import { planStore } from '../src/store/plan-store.js';
import { userStore } from '../src/store/user-store.js';

// 与源 gantt-data.js 一致的本地兜底假期（中秋/国庆）
const FALLBACK_HOLIDAYS = [
  { s: new Date(2026, 8, 25), e: new Date(2026, 8, 27), n: '中秋' },
  { s: new Date(2026, 9, 1), e: new Date(2026, 9, 7), n: '国庆' }
];

// 内存版 storage，模拟 localStorage
function memStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); }
  };
}

// 模拟公开接口返回：code:0 + holiday 映射（含调休补班）
const API_DATA = {
  code: 0,
  holiday: {
    '09-20': { holiday: false, name: '中秋节前补班' },
    '09-25': { holiday: true, name: '中秋节' },
    '09-26': { holiday: true, name: '中秋节' },
    '09-27': { holiday: true, name: '中秋节' },
    '10-01': { holiday: true, name: '国庆节' },
    '10-02': { holiday: true, name: '国庆节' },
    '10-03': { holiday: true, name: '国庆节' },
    '10-04': { holiday: true, name: '国庆节' },
    '10-05': { holiday: true, name: '国庆节' },
    '10-06': { holiday: true, name: '国庆节' },
    '10-07': { holiday: true, name: '国庆节' },
    '10-10': { holiday: false, name: '国庆节后补班' }
  }
};
const apiFetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(API_DATA) });

const toStr = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

describe('core/dates', () => {
  it('F 解析 YYYY-MM-DD 为本地零点 Date', () => {
    const d = F('2026-08-14');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(14);
  });
  it('pad 补零', () => {
    expect(pad(9)).toBe('09');
    expect(pad(12)).toBe('12');
  });
  it('fmt 格式化为 YYYY-MM-DD', () => {
    expect(fmt(F('2026-08-14'))).toBe('2026-08-14');
  });
  it('addDays 增加天数', () => {
    expect(toStr(addDays(F('2026-08-14'), 3))).toBe('2026-08-17');
    expect(toStr(addDays(F('2026-08-14'), -1))).toBe('2026-08-13');
  });
  it('diff 返回天数差', () => {
    expect(diff(F('2026-08-14'), F('2026-08-17'))).toBe(3);
  });
  it('fmtD 格式化为 M/D', () => {
    expect(fmtD(F('2026-08-14'))).toBe('8/14');
  });
});

describe('core/default-data', () => {
  it('导出 PNAME / PCOL / PHASE_LIST', () => {
    expect(PNAME.req).toBe('需求分析');
    expect(PCOL.dev).toBe('#10b981');
    expect(Array.isArray(PHASE_LIST)).toBe(true);
    expect(PHASE_LIST).toContain('req');
  });
  it('defaultModules 深拷贝隔离：修改返回不影响再次调用', () => {
    const a = defaultModules();
    const b = defaultModules();
    a[0].bars[0].w = 999;
    expect(b[0].bars[0].w).not.toBe(999);
  });
  it('defaultResources 深拷贝隔离', () => {
    const a = defaultResources();
    const b = defaultResources();
    a[0].name = 'changed';
    expect(b[0].name).not.toBe('changed');
  });
  it('defaultHolidays 深拷贝且 Date 被重建', () => {
    const a = defaultHolidays();
    const b = defaultHolidays();
    expect(a.length).toBeGreaterThan(0);
    expect(a[0].s).toBeInstanceOf(Date);
    a[0].n = 'changed';
    expect(b[0].n).not.toBe('changed');
  });
});

describe('core/workday (createWorkday 依赖注入)', () => {
  let W;
  beforeEach(() => {
    W = createWorkday({
      storage: memStorage(),
      fetchImpl: apiFetch,
      holidays: FALLBACK_HOLIDAYS
    });
  });

  it('isWorkday: 2026-08-14 周五是工作日', () => {
    expect(W.isWorkday('2026-08-14')).toBe(true);
  });
  it('isWorkday: 2026-08-15 周六非工作日', () => {
    expect(W.isWorkday('2026-08-15')).toBe(false);
  });
  it('isWorkday: 本地兜底假期 2026-10-01 国庆非工作日', () => {
    expect(W.isWorkday('2026-10-01')).toBe(false);
  });
  it('spanDays: 含首尾日历跨度', () => {
    expect(W.spanDays('2026-08-14', '2026-08-17')).toBe(4);
  });
  it('workDays: 去除周末/假日', () => {
    // 8/14 周五 8/17 周一 8/18 周二 => 3 个工作日
    expect(W.workDays('2026-08-14', '2026-08-18')).toBe(3);
  });
  it('addWorkdays: 从周五起第 2 个工作日跳到周一（跳过周末）', () => {
    // addWorkdays(start, n) = 从 start 起的第 n 个工作日（含 start 本身）
    // 8/14(周五) 第1个, 8/17(周一) 第2个 => 2026-08-17
    expect(toStr(W.addWorkdays('2026-08-14', 2))).toBe('2026-08-17');
  });
  it('spanEndByWorkdays: 2026-08-14 起第 2 个工作日结束日', () => {
    // 8/14(周五) 第1个, 8/17(周一) 第2个 => 2026-08-17
    expect(toStr(W.spanEndByWorkdays('2026-08-14', 2))).toBe('2026-08-17');
  });
  it('接口缓存生效后 isWorkday 结合调休补班', async () => {
    await W.fetchYear(2026);
    // 09-20 是补班日(调休补班)，周六也上班
    expect(W.isWorkday('2026-09-20')).toBe(true);
    expect(W.isWorkday('2026-10-01')).toBe(false);
  });
  it('dayInfo：区分 法定假 / 补班 / 普通周末 / 工作日（表头着色依据）', async () => {
    await W.fetchYear(2026);
    // 10-01 国庆：holiday=true，非法定周末休假
    let di = W.dayInfo('2026-10-01');
    expect(di.holiday).toBe(true);
    expect(di.isWeekend).toBe(false);
    expect(di.isWorkday).toBe(false);
    // 09-20 周六补班：非 holiday，是周末，但按工作日对待（补班上班）
    di = W.dayInfo('2026-09-20');
    expect(di.holiday).toBe(false);
    expect(di.isMakeup).toBe(true);
    expect(di.isWeekend).toBe(true);
    expect(di.isWorkday).toBe(true);
    // 普通周末：10-11（周日）
    di = W.dayInfo('2026-10-11');
    expect(di.holiday).toBe(false);
    expect(di.isMakeup).toBe(false);
    expect(di.isWeekend).toBe(true);
    expect(di.isWorkday).toBe(false);
    // 普通工作日：10-12（周一）
    di = W.dayInfo('2026-10-12');
    expect(di.isWeekend).toBe(false);
    expect(di.isWorkday).toBe(true);
  });
});

describe('core/mod-tag: computePlanPct 计划应达基线（工作量口径 = EVM 的 PV）', () => {
  // 工作日简算：周一~周五（不引入假期，隔离掉 workday 的复杂度）
  const wd = {
    workDays: (s, e) => {
      let n = 0; const d = F(s); const end = F(e);
      while (d <= end) { const w = d.getDay(); if (w !== 0 && w !== 6) n++; d.setDate(d.getDate() + 1); }
      return n;
    }
  };
  const bar = o => ({ id: 'x', p: 'dev', ...o });

  it('计划结束日已过的任务全额计入 PV（做没做是 EV 的事）', () => {
    // 8/17(一)~8/21(五) = 5 人日，今天 8/24（下周一）→ 已过
    const bars = [bar({ s: '2026-08-17', e: '2026-08-21', w: 5, done: 40 })];
    expect(computePlanPct(bars, F('2026-08-24'), wd)).toBe(100);
  });

  it('计划未开始的任务不计入 PV', () => {
    const bars = [bar({ s: '2026-08-24', e: '2026-08-28', w: 5, done: 0 })];
    expect(computePlanPct(bars, F('2026-08-20'), wd)).toBe(0);
  });

  it('跨今天的任务按已过的计划工作日比例计入', () => {
    // 8/17(一)~8/21(五) 共 5 人日，今天 8/19(三) → 已过 8/17、8/18、8/19 → 3/5
    const bars = [bar({ s: '2026-08-17', e: '2026-08-21', w: 5 })];
    expect(computePlanPct(bars, F('2026-08-19'), wd)).toBe(60);
  });

  it('里程碑不参与 PV（0 天单点没有工作量）', () => {
    const bars = [
      bar({ id: 'a', s: '2026-08-17', e: '2026-08-21', w: 5, done: 0 }),
      { id: 'm', m: '2026-08-18', p: 'go', label: '上线' }
    ];
    expect(computePlanPct(bars, F('2026-08-17'), wd)).toBe(20);   // 只算 a：1/5
  });

  it('前重后轻的计划：末尾空档不得把「逾期未完成」算成「超前」（回归）', () => {
    // 复现「县域-得分排名」的形状：19 人日里 18 人日的任务计划在 9/23 前完成，
    // 末尾一个 1 人日的上线排到 10/15。旧口径（时间流逝比例 16/38 = 42.11%）
    // 会把这条需求判成"超前"，而它其实有一条任务已逾期未完成。
    const bars = [
      bar({ id: 'a', s: '2026-09-07', e: '2026-09-11', w: 5, done: 100 }),
      bar({ id: 'b', s: '2026-09-07', e: '2026-09-11', w: 5, done: 100 }),
      bar({ id: 'c', s: '2026-09-14', e: '2026-09-18', w: 5, done: 100 }),
      bar({ id: 'd', p: 'sit', s: '2026-09-14', e: '2026-09-16', w: 3, done: 0 }),   // 计划已到期、未完成
      bar({ id: 'e', p: 'go', s: '2026-10-15', e: '2026-10-15', w: 1, done: 0 })
    ];
    // 总 19 人日；到 9/23 计划应完成 18（只有 go 还没到）→ PV = 18/19 = 94.74%
    expect(computePlanPct(bars, F('2026-09-23'), wd)).toBeCloseTo(94.74, 1);
  });

  it('无任务 / 缺 workday → 0（不抛错）', () => {
    expect(computePlanPct([], F('2026-08-20'), wd)).toBe(0);
    expect(computePlanPct(null, F('2026-08-20'), wd)).toBe(0);
    expect(computePlanPct([bar({ s: '2026-08-17', e: '2026-08-21' })], F('2026-08-20'), {})).toBe(0);
  });

  it('computeModuleTag 排除里程碑：任务全完成即「已完成」', () => {
    const bars2 = [
      { id: 'A', s: '2026-08-17', e: '2026-08-18', w: 2, done: 100 },
      { m: '2026-08-17', s: '2026-08-17', e: '2026-08-17', w: 1, isMs: true, label: '需求确认', done: 1 }
    ];
    expect(computeModuleTag(bars2, F('2026-08-20')).tag).toBe('已完成');
  });
});

describe('core/task-status: isOverdueTask 逾期判定（统一口径）', () => {
  const today = F('2026-09-14');

  it('结束日已过、未完成、已分配资源 → 逾期', () => {
    expect(isOverdueTask({ e: '2026-09-10', done: 50, res: ['张三'] }, today)).toBe(true);
    expect(isOverdueTask({ e: '2026-09-10', res: ['张三'] }, today)).toBe(true);
  });

  it('未分配资源 → 不算逾期（还没排人的活儿）', () => {
    expect(isOverdueTask({ e: '2026-09-10', done: 50, res: [] }, today)).toBe(false);
    expect(isOverdueTask({ e: '2026-09-10', done: 50 }, today)).toBe(false);
  });

  it('已完成 / 里程碑 / 未到期（含今天到期）→ 不算逾期', () => {
    expect(isOverdueTask({ e: '2026-09-10', done: 100, res: ['张三'] }, today)).toBe(false);
    expect(isOverdueTask({ m: '2026-09-10', res: ['张三'] }, today)).toBe(false);
    expect(isOverdueTask({ isMs: true, e: '2026-09-10', res: ['张三'] }, today)).toBe(false);
    expect(isOverdueTask({ e: '2026-09-14', done: 0, res: ['张三'] }, today)).toBe(false);
    expect(isOverdueTask({ e: '2026-09-20', done: 0, res: ['张三'] }, today)).toBe(false);
  });

  it('today 带时分秒时，「今天到期」也不会被误判为逾期', () => {
    expect(isOverdueTask({ e: '2026-09-14', done: 0, res: ['张三'] }, new Date(2026, 8, 14, 23, 30))).toBe(false);
  });

  it('空值安全', () => {
    expect(isOverdueTask(null, today)).toBe(false);
    expect(isOverdueTask({ res: ['张三'] }, today)).toBe(false);   // 无结束日
  });
});

describe('core/mod-tag: 待排期需求（unscheduled）', () => {
  it('unscheduledModSet 只收 unscheduled=true 的需求', () => {
    const set = unscheduledModSet([
      { name: 'A', unscheduled: true }, { name: 'B' }, { name: 'C', unscheduled: false }
    ]);
    expect([...set]).toEqual(['A']);
    expect(unscheduledModSet(null).size).toBe(0);
  });

  it('moduleTag：待排期优先于自动推算的标签（不会被判成已逾期）', () => {
    const bars = [{ s: '2026-08-01', e: '2026-08-05', done: 0, res: ['张三'] }];
    expect(moduleTag({ unscheduled: true, bars }, F('2026-09-02')).tag).toBe('待排期');
    // 去掉待排期标记后，同样的数据按自动标签判为已逾期
    expect(moduleTag({ unscheduled: false, bars }, F('2026-09-02')).tag).toBe('已逾期');
  });

  it('moduleTag：非待排期时等价于 computeModuleTag', () => {
    const bars = [{ s: '2026-08-31', e: '2026-09-04', done: 40, res: ['张三'] }];
    expect(moduleTag({ bars }, F('2026-09-02')).tag).toBe('进行中');
    expect(moduleTag(null, F('2026-09-02')).tag).toBe('待启动');
  });
});

describe('core/mod-tag: computeModuleTag 需求状态标签', () => {
  const T = F('2026-09-02');   // 周三

  it('全部任务完成 → 已完成', () => {
    expect(computeModuleTag([
      { s: '2026-08-27', e: '2026-08-28', done: 100 },
      { s: '2026-09-01', e: '2026-09-01', done: 100 }
    ], T).tag).toBe('已完成');
  });

  it('有未完成任务且结束日已过（已分配资源）→ 已逾期', () => {
    expect(computeModuleTag([
      { s: '2026-08-27', e: '2026-08-28', done: 50, res: ['张三'] },
      { s: '2026-09-04', e: '2026-09-07', done: 0, res: ['张三'] }
    ], T).tag).toBe('已逾期');
  });

  it('逾期但未分配资源 → 不计入已逾期', () => {
    expect(computeModuleTag([
      { s: '2026-08-27', e: '2026-08-28', done: 50 },   // 逾期但没排人
      { s: '2026-08-31', e: '2026-09-04', done: 40 }    // 今日在跑
    ], T).tag).toBe('进行中');
  });

  it('今日有任务在跑 → 进行中', () => {
    expect(computeModuleTag([{ s: '2026-08-28', e: '2026-09-04', done: 40 }], T).tag).toBe('进行中');
  });

  it('今日落在任务间隙（前置已完、后置未开始）→ 进行中，而非待启动', () => {
    // 县域-季均优化实况：dev 8/27~8/28 已完成、UAT 9/1 已完成、上线 9/3 未开始
    expect(computeModuleTag([
      { s: '2026-08-27', e: '2026-08-28', done: 100 },
      { s: '2026-09-01', e: '2026-09-01', done: 100 },
      { s: '2026-09-03', e: '2026-09-03', done: 0 }
    ], T).tag).toBe('进行中');
  });

  it('已开工任务全部完成、后续任务未开始 → 进行中，而非待启动', () => {
    // 县域银保实况：需求 8/28~9/2 已完成、开发 9/4 才启动
    expect(computeModuleTag([
      { s: '2026-08-28', e: '2026-09-02', done: 100 },
      { s: '2026-09-04', e: '2026-09-07', done: 0 }
    ], T).tag).toBe('进行中');
  });

  it('所有任务都在未来（首个任务未到开始日）→ 待启动', () => {
    expect(computeModuleTag([
      { s: '2026-09-04', e: '2026-09-07', done: 0 },
      { s: '2026-09-09', e: '2026-09-14', done: 0 }
    ], T).tag).toBe('待启动');
  });

  it('里程碑不计入：仅有里程碑视为无任务 → 待启动', () => {
    expect(computeModuleTag([{ m: '2026-09-10' }], T).tag).toBe('待启动');
  });
});

describe('store/plan-store', () => {
  beforeEach(() => planStore.reset());

  it('初始 state 默认值', () => {
    expect(planStore.state.modules).toEqual([]);
    expect(planStore.state.calcVer).toBe(5);
    expect(planStore.state.start.getFullYear()).toBe(2026);
  });
  it('set 更新并通知订阅者', () => {
    let received = null;
    const unsub = planStore.subscribe(s => { received = s; });
    planStore.set({ modules: [{ id: 'x' }], calcVer: 6 });
    expect(received.modules).toEqual([{ id: 'x' }]);
    expect(planStore.state.calcVer).toBe(6);
    unsub();
  });
  it('reset 恢复默认并通知', () => {
    let count = 0;
    planStore.subscribe(() => count++);
    planStore.set({ modules: [{ id: 'x' }], calcVer: 6 });
    planStore.reset();
    expect(planStore.state.modules).toEqual([]);
    expect(planStore.state.calcVer).toBe(5);
    expect(count).toBe(2);
  });
  it('unsubscribe 后不再通知', () => {
    let count = 0;
    const unsub = planStore.subscribe(() => count++);
    unsub();
    planStore.set({ calcVer: 9 });
    expect(count).toBe(0);
  });
});

describe('store/user-store', () => {
  beforeEach(() => userStore.reset());

  it('初始 state 默认值', () => {
    expect(userStore.state.user).toBe(null);
    expect(userStore.state.role).toBe('user');
    expect(userStore.state.readonly).toBe(false);
  });
  it('readonly 切换', () => {
    userStore.set({ readonly: true, role: 'admin', user: { name: '张三' } });
    expect(userStore.state.readonly).toBe(true);
    expect(userStore.state.role).toBe('admin');
  });
  it('reset 恢复默认', () => {
    userStore.set({ readonly: true, user: { name: '张三' }, projectId: 7 });
    userStore.reset();
    expect(userStore.state.readonly).toBe(false);
    expect(userStore.state.user).toBe(null);
    expect(userStore.state.projectId).toBe(null);
  });
  it('subscribe/set 通知', () => {
    let received = null;
    const unsub = userStore.subscribe(s => { received = s; });
    userStore.set({ readonly: true });
    expect(received.readonly).toBe(true);
    unsub();
  });
});

describe('core: currentPhase 需求当前阶段', () => {
  const today = F('2026-08-20');
  const bar = o => ({ id: 'x', p: 'dev', s: '2026-08-18', e: '2026-08-22', w: 5, ...o });

  it('取正在进行中最早的未完成任务所属阶段', () => {
    const mo = { name: 'A', bars: [
      bar({ id: 'a', p: 'req', s: '2026-08-10', e: '2026-08-14', done: 100 }),
      bar({ id: 'b', p: 'sit', s: '2026-08-19', e: '2026-08-25', done: 0 }),
      bar({ id: 'c', p: 'dev', s: '2026-08-18', e: '2026-08-21', done: 10 })
    ] };
    // dev 开始更早 → 排在前面
    expect(currentPhase(mo, today)).toBe('开发');
  });

  it('里程碑不参与阶段判定', () => {
    const mo = { name: 'A', bars: [
      { id: 'm', m: '2026-08-20', p: 'go', label: '上线' },
      bar({ id: 'b', p: 'dev', s: '2026-08-18', e: '2026-08-22', done: 0 })
    ] };
    expect(currentPhase(mo, today)).toBe('开发');
  });

  it('没有进行中的任务但有未完成任务 → 待启动', () => {
    const mo = { name: 'A', bars: [bar({ id: 'b', p: 'dev', s: '2026-09-01', e: '2026-09-05', done: 0 })] };
    expect(currentPhase(mo, today)).toBe('待启动');
  });

  it('全部任务完成 → 已全部完成', () => {
    const mo = { name: 'A', bars: [bar({ id: 'b', p: 'dev', done: 100 })] };
    expect(currentPhase(mo, today)).toBe('已全部完成');
  });

  it('没有任务 → 已全部完成（与卡片既有行为一致）', () => {
    expect(currentPhase({ name: 'A', bars: [] }, today)).toBe('已全部完成');
  });
});

describe('core: modStats 需求级进度（人日口径）', () => {
  const today = F('2026-08-20');
  const ctx = {
    today,
    // 简算人日：含首尾的日历日（真实实现会跳过节假日，这里只验证加权口径）
    workday: { workDays: (s, e) => Math.round((F(e) - F(s)) / 864e5) + 1 }
  };

  it('按人日加权：完成度 = 已完成人日 / 总人日', () => {
    const bars = [
      { id: 'a', p: 'dev', s: '2026-08-01', e: '2026-08-10', done: 100 },   // 10 人日全完成
      { id: 'b', p: 'sit', s: '2026-08-11', e: '2026-08-20', done: 0 }      // 10 人日未开始
    ];
    const r = modStats(bars, ctx);
    expect(r.work).toBe(20);
    expect(r.done).toBe(10);
    expect(r.pct).toBe(50);
  });

  it('里程碑不计入人日', () => {
    const bars = [
      { id: 'a', p: 'dev', s: '2026-08-01', e: '2026-08-10', done: 100 },
      { id: 'm', m: '2026-08-20', p: 'go', label: '上线' }
    ];
    expect(modStats(bars, ctx).work).toBe(10);
  });

  it('没有可算的任务时 pct 为 0（不出现 NaN）', () => {
    expect(modStats([], ctx).pct).toBe(0);
  });

  it('planPct 按任务的计划窗口算（PV），不再看需求时间跨度', () => {
    // ctx.workday 是"含首尾日历日"简算：8/1~8/21 = 21 天，今天 8/20 → 已过 20 天
    // 该任务跨今天 → planned = 21 × 20/21 = 20 → PV = 20/21 = 95.24%
    const r = modStats([{ id: 'a', p: 'dev', s: '2026-08-01', e: '2026-08-21', done: 0 }], ctx);
    expect(r.planPct).toBe(95.24);
  });

  it('前重后轻：末尾长空档不抬高 PV，有任务到期未完成就该判延后', () => {
    const bars = [
      { id: 'a', p: 'dev', s: '2026-08-01', e: '2026-08-05', done: 100 },   // 5 人日，计划已完成
      { id: 'b', p: 'sit', s: '2026-08-06', e: '2026-08-10', done: 0 },     // 5 人日，计划已到期未完成
      { id: 'c', p: 'go',  s: '2026-09-30', e: '2026-09-30', done: 0 }      // 1 人日，还很远
    ];
    const r = modStats(bars, ctx);
    // EV = 5/11 = 45.45%；PV = 10/11 = 90.91% → 偏差为负（延后）
    expect(r.pct).toBeCloseTo(45.45, 1);
    expect(r.planPct).toBeCloseTo(90.91, 1);
    expect(r.pct - r.planPct).toBeLessThan(0);
  });
});

describe('core/default-data: 生命周期枚举与归一化', () => {
  it('MODULE_LIFECYCLE 是四档，数组顺序即流程顺序', () => {
    expect(MODULE_LIFECYCLE).toEqual(['待确认', '已确认', '已提测', '已上线']);
    expect(LIFECYCLE_DEFAULT).toBe('待确认');
    expect(LIFECYCLE_NONE).toBe('未设置');
  });

  it('normalizeLifecycle 只接受四档，其余一律 null', () => {
    MODULE_LIFECYCLE.forEach(v => expect(normalizeLifecycle(v)).toBe(v));
    // 带空格 / 大小写变体 / 不存在的档位 / 非字符串，一律视为未设置（不做 trim 兜底）
    [undefined, null, '', ' 已上线', '已上线 ', '上线', '待确认中', 0, {}].forEach(
      v => expect(normalizeLifecycle(v)).toBe(null)
    );
  });
});

describe('core/mod-tag: findGateMs 关键时间点（需求确认 / 提测）', () => {
  const mo = {
    name: 'X',
    bars: [
      { id: 'cfm', m: '2026-08-14', p: 'cfm', label: '需求确认' },
      { id: 'sit-task', s: '2026-08-17', e: '2026-08-21', p: 'sit', w: 5, res: [] },  // 测试任务，不是提测里程碑
      { id: 'tice', m: '2026-08-24', p: 'sit', label: '提测' },
      { id: 'go', m: '2026-09-09', p: 'go', label: '上线' }
    ]
  };

  it('确认：p=cfm 或 label 含「需求确认」都能认', () => {
    expect(findGateMs(mo, 'confirm').id).toBe('cfm');
    expect(findGateMs({ bars: [{ m: '2026-08-15', label: '需求确认' }] }, 'confirm').m).toBe('2026-08-15');
  });

  it('提测：按 label 认，不能把 p=sit 的测试任务当成提测里程碑', () => {
    expect(findGateMs(mo, 'submit').id).toBe('tice');
  });

  it('多个匹配取最后一个（与 findGoMs 同口径）', () => {
    const two = { bars: [
      { id: 'a', m: '2026-08-10', p: 'cfm', label: '需求确认' },
      { id: 'b', m: '2026-08-20', p: 'cfm', label: '需求确认（复议）' }
    ] };
    expect(findGateMs(two, 'confirm').id).toBe('b');
  });

  it('没有对应里程碑 / 未知 kind / 入参为 null 都返回 null', () => {
    expect(findGateMs({ bars: [] }, 'confirm')).toBe(null);
    expect(findGateMs(mo, 'nope')).toBe(null);
    expect(findGateMs(null, 'confirm')).toBe(null);
  });
});

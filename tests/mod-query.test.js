// 需求台账的筛选与排序：纯函数，不依赖 DOM
import { describe, it, expect, beforeEach } from 'vitest';
import { F } from '../src/core/dates.js';
import { filterMods, sortMods, collectProposers, defaultReqFilter, loadReqView, saveReqView } from '../src/core/mod-query.js';

const today = F('2026-08-20');

// 三个需求，覆盖：有版本 / 无版本、有描述 / 无描述、有优先级 / 无优先级、待排期
function makeMods() {
  return [
    { name: '官网改版', pri: 'P0', tag: 'x', tagc: '#000', bars: [
      { id: 'a', p: 'dev', s: '2026-08-10', e: '2026-08-14', w: 5, done: 100, res: [] },
      { id: 'b', p: 'sit', s: '2026-08-18', e: '2026-08-22', w: 5, done: 50, res: [] }
    ], desc: '首页视觉升级与性能优化' },
    { name: '数据看板', pri: 'P1', bars: [
      { id: 'c', p: 'dev', s: '2026-09-01', e: '2026-09-05', w: 5, done: 0, res: [] }
    ] },
    { name: '移动端适配', bars: [], unscheduled: true, desc: 'H5 全量适配' }
  ];
}

const versions = [{ id: 'v1', name: 'V2.3', date: '2026-09-09', shipped: false, shippedAt: null, mods: ['官网改版'] }];

const ctx = {
  today,
  workday: { workDays: (s, e) => Math.round((F(e) - F(s)) / 864e5) + 1 }
};

const modRange = mo => {
  const bars = (mo.bars || []).filter(b => !b.m && b.s && b.e);
  if (!bars.length) return null;
  const ss = bars.map(b => F(b.s)), es = bars.map(b => F(b.e));
  return { start: new Date(Math.min(...ss)), end: new Date(Math.max(...es)) };
};

const deps = { today, versions, modRange, ctx };
const names = arr => arr.map(m => m.name);

describe('mod-query: filterMods 筛选', () => {
  it('默认（全 all）返回全部需求，含待排期', () => {
    expect(names(filterMods(makeMods(), {}, deps)))
      .toEqual(['官网改版', '数据看板', '移动端适配']);
  });

  it('关键词命中需求名', () => {
    expect(names(filterMods(makeMods(), { kw: '看板' }, deps))).toEqual(['数据看板']);
  });

  it('关键词命中描述正文', () => {
    expect(names(filterMods(makeMods(), { kw: '性能优化' }, deps))).toEqual(['官网改版']);
  });

  it('关键词大小写不敏感', () => {
    const mods = [{ name: 'ABC', bars: [] }];
    expect(filterMods(mods, { kw: 'abc' }, deps).length).toBe(1);
  });

  it('按状态筛选（待排期是人工状态，优先级最高）', () => {
    expect(names(filterMods(makeMods(), { status: '待排期' }, deps))).toEqual(['移动端适配']);
    expect(filterMods(makeMods(), { status: '已完成' }, deps).length).toBe(0);
  });

  it('按优先级筛选，none 表示未设置', () => {
    expect(names(filterMods(makeMods(), { pri: 'P0' }, deps))).toEqual(['官网改版']);
    expect(names(filterMods(makeMods(), { pri: 'none' }, deps))).toEqual(['移动端适配']);
  });

  it('按版本筛选，none 表示未加入任何版本', () => {
    expect(names(filterMods(makeMods(), { ver: 'v1' }, deps))).toEqual(['官网改版']);
    expect(names(filterMods(makeMods(), { ver: 'none' }, deps)))
      .toEqual(['数据看板', '移动端适配']);
  });

  it('scope=archived 只看归档，scope=active 排除归档', () => {
    const mods = makeMods();
    mods[1].archived = true;
    expect(names(filterMods(mods, { scope: 'archived' }, deps))).toEqual(['数据看板']);
    expect(names(filterMods(mods, { scope: 'active' }, deps)))
      .toEqual(['官网改版', '移动端适配']);
  });

  it('unscheduled=only / exclude', () => {
    expect(names(filterMods(makeMods(), { unscheduled: 'only' }, deps))).toEqual(['移动端适配']);
    expect(names(filterMods(makeMods(), { unscheduled: 'exclude' }, deps)))
      .toEqual(['官网改版', '数据看板']);
  });

  it('多个条件是与关系', () => {
    const mods = makeMods();
    mods[0].archived = true;
    expect(names(filterMods(mods, { scope: 'active', kw: '适配' }, deps)))
      .toEqual(['移动端适配']);
  });

  it('入参为 null / undefined 时返回空数组，不抛错', () => {
    expect(filterMods(null, {}, deps)).toEqual([]);
    expect(filterMods(undefined, {}, deps)).toEqual([]);
  });
});

describe('mod-query: sortMods 排序', () => {
  it('order 键保持原顺序（甘特图的需求顺序）', () => {
    expect(names(sortMods(makeMods(), 'order', 'asc', deps)))
      .toEqual(['官网改版', '数据看板', '移动端适配']);
  });

  it('按需求名排序，支持升降序', () => {
    // 中文名的 localeCompare 全序依赖运行环境的 ICU 排序规则，直接断言全序会在不同 Node 版本上飘：
    // 只断言"升降序是同一集合且互为镜像"，排序口径钉在实现里（localeCompare zh-Hans-CN）
    const asc = names(sortMods(makeMods(), 'name', 'asc', deps));
    const desc = names(sortMods(makeMods(), 'name', 'desc', deps));
    expect(asc.slice().sort()).toEqual(desc.slice().sort());
    expect(asc[0]).toBe(desc[desc.length - 1]);
  });

  it('按优先级排序，未设置一律排最后（升序降序都一样）', () => {
    expect(names(sortMods(makeMods(), 'pri', 'asc', deps)))
      .toEqual(['官网改版', '数据看板', '移动端适配']);
    expect(names(sortMods(makeMods(), 'pri', 'desc', deps)))
      .toEqual(['数据看板', '官网改版', '移动端适配']);
  });

  it('按排期开始日排序，无排期的排最后', () => {
    expect(names(sortMods(makeMods(), 'start', 'asc', deps)))
      .toEqual(['官网改版', '数据看板', '移动端适配']);
    expect(names(sortMods(makeMods(), 'start', 'desc', deps)))
      .toEqual(['数据看板', '官网改版', '移动端适配']);
  });

  it('按完成度排序', () => {
    // 官网改版：5×1 + 5×0.5 = 7.5/10 = 75%；数据看板 0%；移动端适配无任务 = 0%
    expect(names(sortMods(makeMods(), 'pct', 'desc', deps))[0]).toBe('官网改版');
  });

  it('不改动入参数组', () => {
    const mods = makeMods();
    const before = names(mods);
    sortMods(mods, 'start', 'desc', deps);
    expect(names(mods)).toEqual(before);
  });

  it('按上线日排序：版本日优先，无版本回退上线里程碑，都没有的排最后', () => {
    const mods = makeMods();
    mods[1].bars.push({ id: 'ms', m: '2026-10-01', p: 'go', label: '上线' });
    const asc = names(sortMods(mods, 'ship', 'asc', deps));
    expect(asc[0]).toBe('官网改版');      // 版本日 9/9 最早
    expect(asc[1]).toBe('数据看板');      // 无版本，回退里程碑 10/1
    expect(asc[2]).toBe('移动端适配');    // 两者都没有 → 排最后
  });

  it('未知 key 视为 order', () => {
    expect(names(sortMods(makeMods(), 'nope', 'asc', deps)))
      .toEqual(['官网改版', '数据看板', '移动端适配']);
  });
});

describe('mod-query: collectProposers 提出人候选', () => {
  it('去重、忽略空值与首尾空格、保持首次出现顺序', () => {
    const mods = [
      { name: 'a', proposedBy: '张三' },
      { name: 'b', proposedBy: ' 李四 ' },
      { name: 'c' },
      { name: 'd', proposedBy: '   ' },
      { name: 'e', proposedBy: '张三' },
      { name: 'f', proposedBy: '王五' }
    ];
    expect(collectProposers(mods)).toEqual(['张三', '李四', '王五']);
  });

  it('空数组与非法入参返回空数组', () => {
    expect(collectProposers([])).toEqual([]);
    expect(collectProposers(null)).toEqual([]);
  });
});

describe('mod-query: 生命周期筛选与提出人关键词', () => {
  const mods = [
    { name: 'A', lifecycle: '已确认', proposedBy: '张三', bars: [] },
    { name: 'B', lifecycle: '待确认', proposedBy: '李四', bars: [] },
    { name: 'C', bars: [] }
  ];

  it('默认 filter 带 lifecycle:all（三处入口共用同一份默认值）', () => {
    expect(defaultReqFilter().lifecycle).toBe('all');
  });

  it('按生命周期筛选，none 表示未设置', () => {
    expect(names(filterMods(mods, { lifecycle: '已确认' }, deps))).toEqual(['A']);
    expect(names(filterMods(mods, { lifecycle: 'none' }, deps))).toEqual(['C']);
    expect(names(filterMods(mods, {}, deps))).toEqual(['A', 'B', 'C']);
  });

  it('关键词命中提出人（搜"某人提的需求"）', () => {
    expect(names(filterMods(mods, { kw: '李四' }, deps))).toEqual(['B']);
  });
});

describe('mod-query: 新增排序键（提出时间 / 生命周期 / 确认时间）', () => {
  it('按提出时间排序，未填写的排最后', () => {
    const mods = [
      { name: 'A', proposedAt: '2026-08-20', bars: [] },
      { name: 'B', bars: [] },
      { name: 'C', proposedAt: '2026-08-01', bars: [] }
    ];
    expect(names(sortMods(mods, 'proposed', 'asc', deps))).toEqual(['C', 'A', 'B']);
    expect(names(sortMods(mods, 'proposed', 'desc', deps))).toEqual(['A', 'C', 'B']);
  });

  it('按生命周期排序（枚举序），未设置排最后', () => {
    const mods = [
      { name: 'A', lifecycle: '已上线', bars: [] },
      { name: 'B', bars: [] },
      { name: 'C', lifecycle: '待确认', bars: [] }
    ];
    expect(names(sortMods(mods, 'lifecycle', 'asc', deps))).toEqual(['C', 'A', 'B']);
    expect(names(sortMods(mods, 'lifecycle', 'desc', deps))).toEqual(['A', 'C', 'B']);
  });

  it('按需求确认时间排序，没有确认里程碑的排最后', () => {
    const mods = [
      { name: 'A', bars: [{ id: 'x', m: '2026-08-05', p: 'cfm', label: '需求确认' }] },
      { name: 'B', bars: [] },
      { name: 'C', bars: [{ id: 'y', m: '2026-08-11', label: '需求确认' }] }
    ];
    expect(names(sortMods(mods, 'confirm', 'asc', deps))).toEqual(['A', 'C', 'B']);
    expect(names(sortMods(mods, 'confirm', 'desc', deps))).toEqual(['C', 'A', 'B']);
  });
});

describe('mod-query: 关注度排序（focus）', () => {
  // 逾期判定要求「有资源」——没人负责的活儿不算逾期（见 core/task-status.js），
  // 所以下面所有造数据都带上 res，否则逾期这一档永远命中不了。
  const bar = o => ({ id: o.id || 'b', p: o.p || 'dev', res: ['张三'], done: 0, ...o });
  const focusOrder = mods => names(sortMods(mods, 'focus', 'asc', deps));

  it('分层顺序：已逾期 → 待排期 → 待启动 → 已完成 → 已归档', () => {
    const mods = [
      { name: '已完成', pri: 'P0', bars: [bar({ s: '2026-08-01', e: '2026-08-05', done: 100 })] },
      // 已归档即使逾期也要沉到最底：它已退出活跃跟踪
      { name: '已归档', pri: 'P0', archived: true, bars: [bar({ s: '2026-07-01', e: '2026-07-05' })] },
      { name: '已逾期', pri: 'P3', bars: [bar({ s: '2026-08-01', e: '2026-08-10' })] },
      { name: '待启动', pri: 'P0', bars: [bar({ s: '2026-10-01', e: '2026-10-05' })] },
      { name: '待排期', pri: 'P0', unscheduled: true, bars: [bar({ s: '2026-10-01', e: '2026-10-05' })] }
    ];
    expect(focusOrder(mods)).toEqual(['已逾期', '待排期', '待启动', '已完成', '已归档']);
  });

  it('分层永远压过优先级（P3 已逾期 仍在 P0 已归档 之前）', () => {
    const mods = [
      { name: 'P0已归档', pri: 'P0', archived: true, bars: [bar({ s: '2026-07-01', e: '2026-07-05' })] },
      { name: 'P3已逾期', pri: 'P3', bars: [bar({ s: '2026-08-01', e: '2026-08-10' })] }
    ];
    expect(focusOrder(mods)).toEqual(['P3已逾期', 'P0已归档']);
  });

  it('同层内按优先级：P0 在 P3 前，未设优先级排在同层最后', () => {
    const late = () => [bar({ s: '2026-08-01', e: '2026-08-10' })];
    const mods = [
      { name: 'P3', pri: 'P3', bars: late() },
      { name: '无优先级', bars: late() },
      { name: 'P0', pri: 'P0', bars: late() }
    ];
    expect(focusOrder(mods)).toEqual(['P0', 'P3', '无优先级']);
  });

  it('同层同优先级时，计划结束日近的在前', () => {
    const mods = [
      { name: '晚', pri: 'P1', bars: [bar({ s: '2026-08-01', e: '2026-08-19' })] },
      { name: '早', pri: 'P1', bars: [bar({ s: '2026-07-01', e: '2026-08-05' })] }
    ];
    expect(focusOrder(mods)).toEqual(['早', '晚']);
  });
});

describe('mod-query: 查询条件持久化', () => {
  // node 环境没有 localStorage，用内存版打桩（与 scheduler.test.js 同一套做法）
  const store = new Map();
  beforeEach(() => {
    store.clear();
    globalThis.localStorage = {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    };
  });

  it('没存过时返回默认值（默认按关注度排）', () => {
    const v = loadReqView('p1');
    expect(v.filter.scope).toBe('all');
    expect(v.sort.key).toBe('focus');
  });

  it('存了能还原，且不同项目互不干扰', () => {
    saveReqView('p1', { ...defaultReqFilter(), scope: 'active', kw: '看板' }, { key: 'pri', dir: 'desc' });
    const v1 = loadReqView('p1');
    expect(v1.filter.scope).toBe('active');
    expect(v1.filter.kw).toBe('看板');
    expect(v1.sort).toEqual({ key: 'pri', dir: 'desc' });
    expect(loadReqView('p2').filter.scope).toBe('all');
  });

  it('老快照缺字段时逐字段回退默认值（以后加筛选维度不会让整份配置失效）', () => {
    store.set('opsplan.reqView.v1:p1', JSON.stringify({ filter: { scope: 'archived' }, sort: { key: 'pri' } }));
    const v = loadReqView('p1');
    expect(v.filter.scope).toBe('archived');   // 存了的照用
    expect(v.filter.lifecycle).toBe('all');    // 没存的回退默认
    expect(v.sort.key).toBe('pri');
    expect(v.sort.dir).toBe('asc');            // dir 缺失时回退 asc
  });

  it('快照损坏时回退默认值，不抛错', () => {
    store.set('opsplan.reqView.v1:p1', '{ 这不是 json');
    expect(loadReqView('p1').sort.key).toBe('focus');
  });
});

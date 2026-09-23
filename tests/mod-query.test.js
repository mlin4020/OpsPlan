// 需求台账的筛选与排序：纯函数，不依赖 DOM
import { describe, it, expect } from 'vitest';
import { F } from '../src/core/dates.js';
import { filterMods, sortMods } from '../src/core/mod-query.js';

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

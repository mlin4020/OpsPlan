// 需求折叠：甘特图默认全部折叠（core/mod-fold.js）
//          + 展开某条需求时把横向滚动条带到它的任务开始日（components/gantt-scroll.js）
//
// 这两件事各有一个容易反复踩的坑，所以单独盯住：
//   1) 折叠默认值靠"键缺失 = 折叠"承担 —— 谁再把判定写回 `!!collapsed[name]`，
//      或把「全部展开」实现成 `collapsed = {}`，就会静默反过来（全折叠变全展开）；
//   2) 展开后的定位必须发生在 render 之后（render 会回填旧滚动位置），
//      且偏移量要扣掉粘性名称列宽，否则日期会被左边那一列盖住。
import { describe, it, expect } from 'vitest';
import { isModCollapsed, toggleModCollapsed, expandAllMods, collapseAllMods } from '../src/core/mod-fold.js';
import { scrollToModStart, scrollDateToCenter } from '../src/components/gantt-scroll.js';
import { renderModView } from '../src/views/mod-view.js';
import { F } from '../src/core/dates.js';

describe('core/mod-fold: 折叠语义（缺省 = 折叠）', () => {
  it('键不存在即折叠；只有显式 false 才是展开', () => {
    const c = {};
    expect(isModCollapsed(c, '甲')).toBe(true);
    c['甲'] = false;
    expect(isModCollapsed(c, '甲')).toBe(false);
    c['乙'] = true;                       // 历史数据里写 true 的也按折叠处理
    expect(isModCollapsed(c, '乙')).toBe(true);
  });

  it('折叠表整个缺失时按折叠处理，不抛错', () => {
    expect(isModCollapsed(undefined, '甲')).toBe(true);
    expect(isModCollapsed(null, '甲')).toBe(true);
  });

  it('toggle 互转：折叠 → 展开 → 折叠', () => {
    const c = {};
    expect(toggleModCollapsed(c, '甲')).toBe(false);   // 返回值是"转换后是否折叠"
    expect(isModCollapsed(c, '甲')).toBe(false);
    expect(toggleModCollapsed(c, '甲')).toBe(true);
    expect(isModCollapsed(c, '甲')).toBe(true);
  });

  it('全部展开要逐条写显式 false（清空表在现在的语义下等于全折叠）', () => {
    const c = {};
    expandAllMods(c, [{ name: '甲' }, { name: '乙' }, null, { name: '' }]);
    expect(c).toEqual({ 甲: false, 乙: false });
    expect(isModCollapsed(c, '甲')).toBe(false);
  });

  it('全部折叠 = 清空表，顺带丢掉已删需求的死键', () => {
    const c = { 甲: false, 乙: false, 已删需求: false };
    collapseAllMods(c);
    expect(c).toEqual({});
    expect(isModCollapsed(c, '甲')).toBe(true);
  });
});

// ---- 横向定位 ----
const X = d => Math.round((d - F('2026-08-12')) / 864e5) * 13;

function scrollDeps(mods) {
  const gsc = { scrollLeft: 999, clientWidth: 1000 };
  return {
    gsc,
    planStore: { state: { modules: mods } },
    // 名称列宽 200px：可见轨道宽 = 1000 − 200 = 800
    doc: { documentElement: {}, defaultView: { getComputedStyle: () => ({ getPropertyValue: () => '200px' }) } },
    getCtx: () => ({
      X,
      today: F('2026-09-01'),
      modRange: mo => {
        const ss = mo.bars.map(b => F(b.m || b.s));
        const ee = mo.bars.map(b => F(b.e || b.m || b.s));
        return { start: new Date(Math.min(...ss)), end: new Date(Math.max(...ee)) };
      }
    })
  };
}

const MOD = {
  name: '甲',
  bars: [
    { id: 'a', p: 'dev', s: '2026-09-01', e: '2026-09-10' },
    { id: 'b', p: 'go', m: '2026-09-20', label: '上线' }
  ]
};

describe('components/gantt-scroll: 展开需求后把任务开始日带到眼前', () => {
  it('scrollLeft = X(任务开始日) − 留白（日期落在可见轨道左端）', () => {
    const deps = scrollDeps([MOD]);
    expect(scrollToModStart(deps, '甲')).toBe(true);
    expect(deps.gsc.scrollLeft).toBe(X(F('2026-09-01')) - 24);
  });

  it('任务开始日在项目开头附近时不会把滚动条拉到负数', () => {
    const early = { name: '早', bars: [{ id: 'x', p: 'dev', s: '2026-08-12', e: '2026-08-14' }] };
    const deps = scrollDeps([early]);
    expect(scrollToModStart(deps, '早')).toBe(true);
    expect(deps.gsc.scrollLeft).toBe(0);
  });

  it('没有可信开始日的需求（无任务）不动滚动条', () => {
    const deps = scrollDeps([{ name: '空', bars: [] }]);
    expect(scrollToModStart(deps, '空')).toBe(false);
    expect(deps.gsc.scrollLeft).toBe(999);   // 保持原样：无处可滚时乱跳比不动更费解
  });

  it('需求不存在 / 名字为空 / 缺渲染 ctx 时都不动', () => {
    const deps = scrollDeps([MOD]);
    expect(scrollToModStart(deps, '不存在')).toBe(false);
    expect(scrollToModStart(deps, '')).toBe(false);
    expect(scrollToModStart({ ...deps, getCtx: () => null }, '甲')).toBe(false);
    expect(deps.gsc.scrollLeft).toBe(999);
  });

  it('「定位今天」居中：偏移取可见轨道宽的一半', () => {
    const deps = scrollDeps([MOD]);
    expect(scrollDateToCenter(deps, F('2026-10-01'))).toBe(true);
    expect(deps.gsc.scrollLeft).toBe(X(F('2026-10-01')) - 400);   // 可见轨道宽 800 的一半
  });

  it('取不到名称列宽时按 0 处理（宁可不偏移，也不要拿猜的宽度把日期推歪）', () => {
    const deps = scrollDeps([MOD]);
    deps.doc.defaultView.getComputedStyle = () => ({ getPropertyValue: () => '' });
    scrollDateToCenter(deps, F('2026-10-01'));
    expect(deps.gsc.scrollLeft).toBe(X(F('2026-10-01')) - 500);   // 可见宽退化为整个容器
  });
});

// ---- 渲染：默认折叠 ----
function viewCtx(collapsed) {
  const modules = [{
    name: '官网改版',
    tagc: '#3b82f6',
    bars: [
      { id: 't1', p: 'dev', s: '2026-09-01', e: '2026-09-10', done: 50 },
      { id: 'g1', p: 'go', m: '2026-09-20', label: '上线' }
    ]
  }];
  return {
    state: { modules, resources: [], start: F('2026-08-12'), end: F('2026-10-31') },
    collapsed,
    today: F('2026-09-01'),
    dayW: 13,
    holidays: [],
    archOpen: false,
    X,
    fmtD: d => (d.getMonth() + 1) + '/' + d.getDate(),
    modRange: () => ({ start: F('2026-09-01'), end: F('2026-09-20') }),
    modColors: {},
    workday: { spanDays: () => 1, workDays: () => 1, isWorkday: () => true }
  };
}

describe('views/mod-view: 默认全折叠', () => {
  it('折叠表为空 → 只有需求概要行与迷你里程碑，没有任务条', () => {
    const html = renderModView(null, viewCtx({}), new Set());
    expect(html).toContain('data-mod="官网改版"');
    expect(html).toContain('mile mini');        // 折叠态仍给里程碑小菱形（不展开也知道啥时候上线）
    expect(html).not.toContain('bar-row');      // 任务行不该出现
    expect(html).not.toContain('data-task-id="t1"');
  });

  it('显式 false（展开）→ 铺开阶段泳道与里程碑标签', () => {
    const html = renderModView(null, viewCtx({ 官网改版: false }), new Set());
    expect(html).toContain('bar-row');
    expect(html).toContain('data-task-id="t1"');
    expect(html).toContain('mile-label');
  });
});

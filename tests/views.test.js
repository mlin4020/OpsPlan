// 渲染视图层测试：锁定 barHtml/bands/msLabel/renderHeader 模板输出，防止渲染回归
import { describe, it, expect } from 'vitest';
import { F } from '../src/core/dates.js';
import { defaultModules, defaultResources, defaultHolidays } from '../src/core/default-data.js';
import { PCOL } from '../src/core/default-data.js';
import { barHtml, bands, msLabel, renderModView } from '../src/views/mod-view.js';
import { milestoneName } from '../src/core/mod-tag.js';
import { resolveModuleColors, nextModuleColor, resolveChosenColor, MODULE_PALETTE } from '../src/core/mod-color.js';
import { priorityBadge } from '../src/views/badge.js';
import { renderAll, nonWorkdayBg, weekendOnly } from '../src/views/index.js';
import { renderReportView } from '../src/views/report-view.js';
import { renderModDetailRows } from '../src/views/mod-card.js';
import { renderReqView, toggleReqExpanded } from '../src/views/req-view.js';

// 构造最小渲染 ctx（与 renderAll 的 buildViewCtx 契约对齐）
function makeCtx() {
  const state = {
    modules: defaultModules(),
    resources: defaultResources(),
    start: F('2026-08-12'),
    end: F('2026-10-31')
  };
  // 工作日简算：周一~周五，忽略假期（测试用）
  const isWd = d => { const w = d.getDay(); return w !== 0 && w !== 6; };
  return {
    state,
    sched: {
      tasks: () => [], problems: () => [], cycleTasks: () => [],
      tasksById: () => ({}),
      diff: (a, b) => Math.round((a - b) / 864e5),
      addDays: (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
    },
    holidays: defaultHolidays(),
    today: F('2026-08-20'),
    dayW: 34,
    zoom: 0,
    collapsed: {},
    fmtD: d => (d.getMonth() + 1) + '/' + d.getDate(),
    modRange: mo => {
      let s = null, e = null;
      mo.bars.forEach(b => {
        if (b.m) return;
        const d = F(b.s);
        if (!s || d < s) s = d;
        const de = F(b.e);
        if (!e || de > e) e = de;
      });
      return s && e ? { start: s, end: e } : null;
    },
    workday: {
      spanDays: (s, e) => Math.round((F(e) - F(s)) / 864e5) + 1,
      workDays: (s, e) => {
        let n = 0; const d = F(s); const end = F(e);
        while (d <= end) { if (isWd(d)) n++; d.setDate(d.getDate() + 1); }
        return n;
      }
    },
    X: d => Math.round((d - state.start) / 864e5) * 34
  };
}

describe('views: 需求优先级徽标（P0~P3）', () => {
  it('priorityBadge 只接受 P0~P3，未设置不渲染', () => {
    expect(priorityBadge('P0')).toBe('<span class="pri pri-p0" title="优先级 P0">P0</span>');
    expect(priorityBadge('P3')).toContain('class="pri pri-p3"');
    // 老数据没有 pri，或传了非法值 —— 一律不输出，绝不替用户臆造档位
    [undefined, null, '', 'P9', 'p0', 'P0 '].forEach(v => expect(priorityBadge(v)).toBe(''));
  });

  it('甘特图需求行输出徽标（默认演示数据带 P0~P3）', () => {
    const ctx = makeCtx();
    const html = renderModView(null, ctx, new Set());
    expect(html).toContain('class="pri pri-p0"');
    expect(html).toContain('class="pri pri-p1"');
    expect(html).toContain('class="pri pri-p2"');
    expect(html).toContain('class="pri pri-p3"');
    // 徽标必须落在名称列的次要信息行内（与状态标签同层），不能顶掉需求名
    expect(html).toMatch(/<span class="mname-sub"><span class="pri pri-p\d"/);
  });

  it('无 pri 的需求不输出徽标', () => {
    const ctx = makeCtx();
    ctx.state.modules.forEach(m => { delete m.pri; });
    expect(renderModView(null, ctx, new Set())).not.toContain('class="pri pri-');
  });

  it('总览（report）需求卡片与排期总览卡片也带徽标', () => {
    const ctx = makeCtx();
    const html = renderReportView(null, ctx);
    expect(html).toContain('class="pri pri-p0"');
    expect(html).toMatch(/class="mtl-name">[^<]*<\/span>\s*<span class="pri pri-p\d"/);
    expect(html).toMatch(/class="rmod-name">[^<]*<\/b><span class="pri pri-p\d"/);
  });
});

describe('views: barHtml 任务条模板', () => {
  const ctx = makeCtx();
  const mod = ctx.state.modules[0];          // 官网改版
  const normalBar = mod.bars.find(b => b.id === 'm1-dev');  // 普通任务
  const ms = mod.bars.find(b => b.m);        // 里程碑

  it('普通任务条包含背景色（无需求色时兜底阶段色）/data-task-id/模式图标', () => {
    const html = barHtml(ctx, normalBar, mod, new Set(), false);
    expect(html).toContain(`background:${PCOL[normalBar.p]}`);
    expect(html).toContain(`data-task-id="${normalBar.id}"`);
    expect(html).toContain('mode-ico');
  });

  it('renderModView 渲染里程碑 mile 标记与需求行', () => {
    const html = renderModView(null, ctx, new Set());
    expect(html).toContain('mile mini');
    expect(html).toContain(msLabel(ms, milestoneName(ms, mod.name)));
    expect(html).toContain(`data-mod="${mod.name}"`);
  });

  it('barHtml 的 dim 参数：归档需求任务条置灰并标注', () => {
    const html = barHtml(ctx, normalBar, mod, new Set(), false, undefined, true);
    expect(html).toContain('bar archived');
    expect(html).toContain('已归档需求');
  });

  it('冲突任务条高亮', () => {
    const conflict = new Set(['m1-dev']);
    const html = barHtml(ctx, normalBar, mod, conflict, false);
    expect(html).toContain('conflict');
  });
});

describe('views: 任务条需求识别色', () => {
  it('任务条主色取所属需求色：同需求内不同阶段的任务同色', () => {
    const ctx = makeCtx();
    const mod = ctx.state.modules[0];                       // 官网改版
    ctx.modColors = { [mod.name]: '#123456' };
    // 同一需求下阶段不同的两个任务，主色必须完全一致才是「一眼归组」
    const dev = mod.bars.find(b => b.id === 'm1-dev');
    const ui = mod.bars.find(b => b.id === 'm1-ui');
    expect(dev.p).not.toBe(ui.p);                            // 前提：两者阶段确实不同
    const hDev = barHtml(ctx, dev, mod, new Set(), true);
    const hUi = barHtml(ctx, ui, mod, new Set(), true);
    expect(hDev).toContain('background:#123456');
    expect(hUi).toContain('background:#123456');
    // data-mod / --mod-c 供悬浮联动跨泳道描边
    expect(hDev).toContain(`data-mod="${mod.name}"`);
    expect(hDev).toContain('--mod-c:#123456');
  });

  it('取不到需求色时兜底回阶段色（条不会变透明）', () => {
    const ctx = makeCtx();
    const mod = ctx.state.modules[0];
    const bar = mod.bars.find(b => b.id === 'm1-dev');
    const html = barHtml(ctx, bar, mod, new Set(), true);
    expect(html).toContain(`background:${PCOL[bar.p]}`);
    expect(html).not.toContain('--mod-c');
  });

  it('需求行输出标识色点，充当颜色图例', () => {
    const ctx = makeCtx();
    ctx.modColors = { 官网改版: '#123456' };
    const html = renderModView(null, ctx, new Set());
    expect(html).toContain('mod-dot');
    expect(html).toContain('background:#123456');
  });
});

describe('core: resolveModuleColors 需求识别色', () => {
  it('尊重人工指定的颜色', () => {
    const map = resolveModuleColors([{ name: 'A', tagc: '#111111' }, { name: 'B', tagc: '#222222' }]);
    expect(map).toEqual({ A: '#111111', B: '#222222' });
  });

  it('历史数据全为默认色时按色板去重（否则整张图一个颜色，色条等于白加）', () => {
    const map = resolveModuleColors([
      { name: 'A', tagc: '#3b82f6' },
      { name: 'B', tagc: '#3b82f6' },
      { name: 'C', tagc: '#3b82f6' }
    ]);
    expect(map.A).toBe('#3b82f6');   // 首个保留人工值
    expect(map.B).not.toBe(map.A);
    expect(map.C).not.toBe(map.A);
    expect(map.C).not.toBe(map.B);
    expect(MODULE_PALETTE).toContain(map.B);
  });

  it('缺色需求补色时避开已被占用的手动色', () => {
    const map = resolveModuleColors([{ name: 'A', tagc: '#8b5cf6' }, { name: 'B' }]);
    expect(map.A).toBe('#8b5cf6');
    expect(map.B).not.toBe('#8b5cf6');
    expect(MODULE_PALETTE).toContain(map.B);
  });

  it('nextModuleColor 返回首个未占用色', () => {
    expect(nextModuleColor([])).toBe(MODULE_PALETTE[0]);
    expect(nextModuleColor([{ name: 'A', tagc: '#3b82f6' }])).toBe(MODULE_PALETTE[1]);
  });

  it('十六进制大小写不一时按同色处理（避免漏判撞色）', () => {
    const map = resolveModuleColors([{ name: 'A', tagc: '#3B82F6' }, { name: 'B', tagc: '#3b82f6' }]);
    expect(map.B).not.toBe(map.A);
  });
});

describe('core: resolveChosenColor 编辑器回显口径', () => {
  it('选的色未被占用时原样返回', () => {
    expect(resolveChosenColor('#123456', [{ name: 'A' }], 'A')).toBe('#123456');
  });

  it('选的色与其它需求撞色时，返回去重后实际生效的色（弹窗须回显它）', () => {
    const modules = [{ name: 'A', tagc: '#3b82f6' }, { name: 'B', tagc: '#f59e0b' }];
    const actual = resolveChosenColor('#3b82f6', modules, 'B');   // B 想改成 A 的蓝
    expect(actual).not.toBe('#3b82f6');
    expect(MODULE_PALETTE).toContain(actual);
  });

  it('待新建需求（modName 为空）用占位需求参与解析', () => {
    const actual = resolveChosenColor('#3b82f6', [{ name: 'A', tagc: '#3b82f6' }], '');
    expect(actual).not.toBe('#3b82f6');
  });
});

describe('views: bands 假期带与今日线', () => {
  const ctx = makeCtx();

  it('输出 hol-band 假期带', () => {
    const html = bands(ctx);
    expect(html).toContain('hol-band');
    // 中秋 9/25-9/27 在时间窗内
    expect(html).toContain('中秋');
  });

  it('输出 today 今日线', () => {
    const html = bands(ctx);
    expect(html).toContain('today-line');
  });
});

describe('views: 总览（report）里程碑名不重复日期', () => {
  // 默认数据里的里程碑 label 形如 "9/9 上线"（自带前导日期），
  // 而排期总览与里程碑一览本来就单独显示日期列，拼接后曾出现 "9/9 9/9 上线"
  it('label 自带日期时不再拼接日期', () => {
    const ctx = makeCtx();
    const html = renderReportView(null, ctx);
    expect(html).not.toContain('9/9 9/9');
    expect(html).toContain('9/9 上线');
  });

  it('里程碑一览只保留名字本身（日期在独立列）', () => {
    const ctx = makeCtx();
    // 里程碑一览消费 sched.tasks()，测试桩按真实 collect 的形态补上 mod / isMs
    ctx.sched.tasks = () => ctx.state.modules.flatMap(mo =>
      (mo.bars || []).map(b => ({ ...b, mod: mo.name, isMs: !!b.m }))
    );
    const html = renderReportView(null, ctx);
    expect(html).toContain('rml-name');
    expect(html).not.toMatch(/rml-name">\s*\d{1,2}\/\d{1,2}/);
  });
});

describe('views: 总览（report）待排期需求', () => {
  it('待排期需求只显示「待排期」，不画排期条', () => {
    const ctx = makeCtx();
    const target = ctx.state.modules[0];      // 官网改版
    target.unscheduled = true;
    const html = renderReportView(null, ctx);
    expect(html).toContain('待排期');
    expect(html).toContain('rtl2-unsched');                       // 轨道里给的是待排期提示，不是排期条
    expect(html).not.toContain(`data-report-mod="${target.name}"`); // 不参与下钻
    // 同页其他需求照常渲染
    expect(html).toContain('数据看板');
    expect(html).toContain('rtl2-bar');
  });
});

describe('views: 总览（report）不再挂归档区', () => {
  // 归档需求原先在总览/甘特图底部各有一个折叠区，查看要滚到页面最底；
  // 现改为独立「归档」页面（见下方 describe），两处底部折叠区都已移除。
  it('归档需求不出现在总览的任何区块里', () => {
    const ctx = makeCtx();
    ctx.state.modules[0].archived = true;      // 官网改版
    const html = renderReportView(null, ctx);
    expect(html).not.toContain('data-report-mod="官网改版"');
    expect(html).not.toContain('data-arch-head');
    expect(html).not.toContain('已归档需求');
  });

  it('即使 viewState 里残留 archOpen 也不影响渲染（该状态已废弃）', () => {
    const ctx = makeCtx();
    ctx.state.modules[0].archived = true;
    ctx.archOpen = true;
    const html = renderReportView(null, ctx);
    expect(html).not.toContain('data-report-mod="官网改版"');
  });
});

describe('views: msLabel 里程碑标签', () => {
  it('名字含日期时不重复追加', () => {
    expect(msLabel({ label: '9/9 上线', m: '2026-03-16' }, '9/9 上线')).toBe('9/9 上线');
  });
  it('名字无日期时追加日期', () => {
    expect(msLabel({ m: '2026-03-16' }, '提测')).toBe('提测 3/16');
  });
  it('未传名字时回退 label，最后兜底「里程碑」', () => {
    expect(msLabel({ label: '上线', m: '2026-03-16' }, '')).toBe('上线 3/16');
    expect(msLabel({ m: '2026-03-16' }, '')).toBe('里程碑 3/16');
  });
});

describe('core: milestoneName 里程碑命名', () => {
  it('剥掉历史数据里冗余的「需求名 」前缀', () => {
    expect(milestoneName({ label: '标保督导 提测', p: 'sit' }, '标保督导')).toBe('提测');
  });
  it('label 退化成「里程碑」这种通用词时回退阶段名', () => {
    expect(milestoneName({ label: '标保督导 里程碑', p: 'sit' }, '标保督导')).toBe('测试(SIT)');
    expect(milestoneName({ p: 'go' }, '')).toBe('上线');
  });
  it('保留用户自定义的业务名（含日期）', () => {
    expect(milestoneName({ label: '9/16 短险佣金有数', p: 'cfm' }, '数据看板')).toBe('9/16 短险佣金有数');
  });
  it('需求名含正则元字符也不会误剥或抛错', () => {
    expect(milestoneName({ label: '需求评审', p: 'cfm' }, '县域-得分排名')).toBe('需求评审');
    expect(milestoneName({ label: '县域-得分排名 需求评审', p: 'cfm' }, '县域-得分排名')).toBe('需求评审');
  });
  it('无任何可用信息时兜底「里程碑」', () => {
    expect(milestoneName({ p: 'unknown-phase' }, '')).toBe('里程碑');
    expect(milestoneName(null, '任意需求')).toBe('里程碑');
  });
});

describe('views: 非工作日列底色（按工作日口径，不按周六周日）', () => {
  const S = new Date(2026, 7, 12);   // 2026-08-12 周三
  const E = new Date(2026, 7, 18);   // 2026-08-18 周二
  const seg = (l, r) => `linear-gradient(90deg,rgba(100,116,139,0) ${l}px,rgba(100,116,139,.06) ${l}px,rgba(100,116,139,.06) ${r}px,rgba(100,116,139,0) ${r}px)`;

  it('周末休息 → 周六周日两列连成一段（偏移 3 天起，宽 2 天）', () => {
    expect(nonWorkdayBg(S, E, 10, weekendOnly)).toBe(seg(30, 50));
  });

  it('调休补班的周末要上班 → 该周末不涂（这是"按周末硬算"必然画错的场景）', () => {
    // 周六 8/15 补班（上班），只有周日 8/16 休息
    const isWd = d => (d.getDate() === 15 ? true : weekendOnly(d));
    expect(nonWorkdayBg(S, E, 10, isWd)).toBe(seg(40, 50));
  });

  it('法定假日落在周三 → 工作日照样涂（旧实现完全漏掉这种情况）', () => {
    const isWd = d => d.getDate() !== 12 && weekendOnly(d);
    expect(nonWorkdayBg(S, E, 10, isWd)).toBe(`${seg(0, 10)},${seg(30, 50)}`);
  });

  it('全程都是工作日 → none（不产生空渐变）', () => {
    expect(nonWorkdayBg(S, E, 10, () => true)).toBe('none');
  });

  it('缺参数 / 区间反向 时退化为 none（旧数据不受影响）', () => {
    expect(nonWorkdayBg(null, E, 13, weekendOnly)).toBe('none');
    expect(nonWorkdayBg(S, E, 0, weekendOnly)).toBe('none');
    expect(nonWorkdayBg(S, E, 13, null)).toBe('none');
    expect(nonWorkdayBg(E, S, 13, weekendOnly)).toBe('none');
  });

  it('区间跨月/跨年也能正确合并（按日序推进，不受月份边界影响）', () => {
    // 2026-08-31 周一 ~ 2026-09-02 周三，全程放假 → 一段 0~30px
    expect(nonWorkdayBg(new Date(2026, 7, 31), new Date(2026, 8, 2), 10, () => false)).toBe(seg(0, 30));
  });
});

describe('views: renderAll 横向滚动位置保持', () => {
  // 最小 DOM 替身：renderAll 只用到 innerHTML / style.width / classList
  function shell(scrollLeft) {
    const gantt = { innerHTML: '', style: {}, classList: { add() {}, remove() {} } };
    const gsc = { scrollLeft };
    return { gantt, gsc };
  }

  // renderAll 额外依赖 sched.detectProblems（冲突高亮）
  const ctxFor = (gantt, gsc, extra) => {
    const ctx = makeCtx();
    ctx.sched.detectProblems = () => [];
    return { ...ctx, view: 'mod', gantt, gsc, getEl: () => null, ...extra };
  };

  it('未显式传 scrollLeft 时沿用当前滚动位置（删除任务等无参重绘不回到最左）', () => {
    const { gantt, gsc } = shell(720);
    renderAll(ctxFor(gantt, gsc));
    expect(gsc.scrollLeft).toBe(720);
  });

  it('显式传 scrollLeft 时以其为准（初始渲染 render(0) 仍可回到最左）', () => {
    const { gantt, gsc } = shell(720);
    renderAll(ctxFor(gantt, gsc, { scrollLeft: 0 }));
    expect(gsc.scrollLeft).toBe(0);
  });

  it('缩放定位：显式 scrollLeft 覆盖当前值', () => {
    const { gantt, gsc } = shell(720);
    renderAll(ctxFor(gantt, gsc, { scrollLeft: 1200 }));
    expect(gsc.scrollLeft).toBe(1200);
  });
});

describe('views: renderModDetailRows 需求阶段明细', () => {
  it('每个普通任务一行，含阶段色条、日期、人日、负责人、进度', () => {
    const ctx = makeCtx();
    const mo = { name: 'X', bars: [
      { id: 'a', p: 'dev', s: '2026-08-12', e: '2026-08-14', w: 3, done: 50, res: ['张三'] },
      { id: 'b', p: 'sit', s: '2026-08-17', e: '2026-08-18', w: 2, done: 0, res: [] }
    ] };
    const html = renderModDetailRows(mo, ctx);
    expect((html.match(/class="rmod-row"/g) || []).length).toBe(2);
    expect(html).toContain('rmod-dates');
    expect(html).toContain('人日');
    expect(html).toContain('rmod-pct-bar');
    expect(html).toContain('张三');
  });

  it('里程碑不占明细行', () => {
    const ctx = makeCtx();
    const mo = { name: 'X', bars: [
      { id: 'a', p: 'dev', s: '2026-08-12', e: '2026-08-14', w: 3, done: 0, res: [] },
      { id: 'm', m: '2026-08-20', p: 'go', label: '上线' }
    ] };
    expect((renderModDetailRows(mo, ctx).match(/class="rmod-row"/g) || []).length).toBe(1);
  });

  it('空需求返回空串（台账展开区据此不渲染该段）', () => {
    expect(renderModDetailRows({ name: 'X', bars: [] }, makeCtx())).toBe('');
    expect(renderModDetailRows({ name: 'X' }, makeCtx())).toBe('');
  });
});

// 台账渲染需要一个带 versions / reqFilter / reqSort 的 ctx
function makeReqCtx() {
  const ctx = makeCtx();
  ctx.state.versions = [{ id: 'v1', name: 'V2.3', date: '2026-09-09', shipped: false, shippedAt: null, mods: ['官网改版'] }];
  ctx.reqFilter = { kw: '', status: 'all', pri: 'all', ver: 'all', scope: 'all', unscheduled: 'all' };
  ctx.reqSort = { key: 'order', dir: 'asc' };
  return ctx;
}

describe('views: 需求台账主行表格', () => {
  it('渲染表头列与容器类', () => {
    const html = renderReqView(null, makeReqCtx());
    expect(html).toContain('req-wrap');
    expect(html).toContain('class="req-table"');
    ['需求', '状态', '描述', '文档', '所属版本', '排期', '进度', '上线情况', '操作']
      .forEach(h => expect(html).toContain(h));
  });

  it('标题区给出全量与筛选后计数', () => {
    const html = renderReqView(null, makeReqCtx());
    expect(html).toMatch(/共 \d+ 个需求/);
  });

  it('默认展示全部需求（含待排期与归档），归档行带标记', () => {
    const ctx = makeReqCtx();
    ctx.state.modules[1].archived = true;
    ctx.state.modules[2].unscheduled = true;
    const html = renderReqView(null, ctx);
    expect(html).toContain('data-req-row="官网改版"');
    expect(html).toContain('data-req-row="数据看板"');
    expect(html).toContain('data-req-row="移动端适配"');
    expect(html).toContain('req-badge-arch');
    expect(html).toContain('待排期');
  });

  it('未填写描述与文档时显示占位符，不留空白', () => {
    const html = renderReqView(null, makeReqCtx());
    expect(html).toContain('req-desc');
    expect(html).toContain('req-doc-empty');
  });

  it('筛选后计数反映筛选结果', () => {
    const ctx = makeReqCtx();
    ctx.reqFilter = { ...ctx.reqFilter, kw: '看板' };
    const html = renderReqView(null, ctx);
    expect(html).not.toContain('data-req-row="官网改版"');
    expect(html).toContain('data-req-row="数据看板"');
  });

  it('无命中时给空态与重置入口', () => {
    const ctx = makeReqCtx();
    ctx.reqFilter = { ...ctx.reqFilter, kw: '不存在的需求' };
    const html = renderReqView(null, ctx);
    expect(html).toContain('arch-empty');
    expect(html).toContain('data-req-reset');
  });

  it('操作列与新建按钮带 req-act（只读时靠 CSS 隐藏）', () => {
    const html = renderReqView(null, makeReqCtx());
    expect(html).toMatch(/<th[^>]*class="[^"]*req-act/);
    expect(html).toMatch(/class="btn primary req-act" data-req-new/);
  });

  it('上线情况列区分「未加入版本」与版本状态', () => {
    const html = renderReqView(null, makeReqCtx());
    expect(html).toContain('未加入版本');   // 数据看板 / 移动端适配均无版本
    expect(html).toContain('V2.3');        // 官网改版有版本
  });
});

describe('views: 需求台账展开档案', () => {
  it('未展开时不渲染档案行', () => {
    const html = renderReqView(null, makeReqCtx());
    expect(html).not.toContain('req-detail-tr');
  });

  it('展开后依次包含描述、文档、上线情况、排期进度、阶段明细、里程碑六段', () => {
    const ctx = makeReqCtx();
    toggleReqExpanded('官网改版');
    const html = renderReqView(null, ctx);
    toggleReqExpanded('官网改版');   // 复位，避免污染其它用例
    expect(html).toContain('req-detail-tr');
    ['desc', 'doc', 'ship', 'progress', 'phases', 'ms']
      .forEach(s => expect(html).toContain(`data-req-sec="${s}"`));
  });

  it('描述以原文渲染并保留换行（用 pre-wrap 而非转义丢失）', () => {
    const ctx = makeReqCtx();
    ctx.state.modules[0].desc = '第一行\n第二行';
    toggleReqExpanded('官网改版');
    const html = renderReqView(null, ctx);
    toggleReqExpanded('官网改版');
    expect(html).toContain('req-desc-full');
    expect(html).toContain('第一行');
  });

  it('未填写描述时给出提示文案，不留空白', () => {
    const ctx = makeReqCtx();
    delete ctx.state.modules[0].desc;
    toggleReqExpanded('官网改版');
    const html = renderReqView(null, ctx);
    toggleReqExpanded('官网改版');
    expect(html).toContain('未填写描述');
  });

  it('文档链接带 target=_blank 与 rel=noopener', () => {
    const ctx = makeReqCtx();
    ctx.state.modules[0].docUrl = 'https://example.com/prd';
    toggleReqExpanded('官网改版');
    const html = renderReqView(null, ctx);
    toggleReqExpanded('官网改版');
    expect(html).toContain('href="https://example.com/prd"');
    expect(html).toMatch(/target="_blank"[^>]*rel="noopener noreferrer"/);
  });

  it('javascript: 伪协议链接一律不渲染为可点链接', () => {
    const ctx = makeReqCtx();
    ctx.state.modules[0].docUrl = 'javascript:alert(1)';
    toggleReqExpanded('官网改版');
    const html = renderReqView(null, ctx);
    toggleReqExpanded('官网改版');
    expect(html).not.toContain('javascript:');
  });

  it('阶段明细复用 renderModDetailRows 的 .rmod-row 结构', () => {
    const ctx = makeReqCtx();
    toggleReqExpanded('官网改版');
    const html = renderReqView(null, ctx);
    toggleReqExpanded('官网改版');
    expect(html).toContain('class="rmod-row"');
  });

  it('只有被点开的那一条输出档案行', () => {
    const ctx = makeReqCtx();
    toggleReqExpanded('数据看板');
    const html = renderReqView(null, ctx);
    toggleReqExpanded('数据看板');
    expect((html.match(/class="req-detail-tr"/g) || []).length).toBe(1);
  });
});

// 渲染视图层测试：锁定 barHtml/bands/msLabel/renderHeader 模板输出，防止渲染回归
import { describe, it, expect, beforeEach } from 'vitest';
import { F } from '../src/core/dates.js';
import { defaultModules, defaultResources, defaultHolidays } from '../src/core/default-data.js';
import { PCOL } from '../src/core/default-data.js';
import { barHtml, bands, msLabel, renderModView } from '../src/views/mod-view.js';
import { milestoneName } from '../src/core/mod-tag.js';
import { resolveModuleColors, nextModuleColor, resolveChosenColor, MODULE_PALETTE } from '../src/core/mod-color.js';
import { priorityBadge, lifecycleBadge } from '../src/views/badge.js';
import { renderAll, nonWorkdayBg, weekendOnly } from '../src/views/index.js';
import { renderReportView } from '../src/views/report-view.js';
import { renderModDetailRows, renderModCard } from '../src/views/mod-card.js';
import { renderReqView, toggleReqExpanded, shipInfo } from '../src/views/req-view.js';
import { userStore } from '../src/store/user-store.js';

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
  // 需求泳道默认全折叠（见 core/mod-fold.js，键缺失即折叠）。
  // 本文件锁的是**展开态**的模板输出（任务条 / 里程碑标签等），故显式全部展开，
  // 免得断言跟着产品默认值一起变。折叠默认值本身有 tests/mod-fold.test.js 盯着。
  const collapsed = {};
  state.modules.forEach(m => { collapsed[m.name] = false; });
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
    collapsed,
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

describe('views: 应达基线（与进度填充同坐标）', () => {
  // 条按时间轴对齐，填充却是「工作量占条宽的百分比」—— 同一根条里混了两套坐标，
  // 计划前紧后松时填充右端会被读成时间点（"活干到 10/7 了"），看着"越过"今日线，
  // 与已经判出来的「延期」自相矛盾。应达基线补上同坐标的参照。
  const tightThenLoose = () => ({
    name: '前紧后松', pri: '',
    bars: [
      { id: 'a', p: 'req', s: '2026-08-13', e: '2026-08-13', done: 0, res: [] }, // 已到期 → PV 全额计入
      { id: 'b', p: 'go', s: '2026-10-01', e: '2026-10-02', done: 0, res: [] }    // 未开始 → PV 不计
    ]
  });

  it('排期总览：基线位置走工作量口径，不是日历位置', () => {
    const ctx = makeCtx();                       // today = 2026-08-20
    ctx.state.modules = [tightThenLoose()];
    const html = renderReportView(null, ctx);
    const m = html.match(/rtl2-bar-plan" style="left:([\d.]+)%"/);
    expect(m).not.toBeNull();
    const left = Number(m[1]);
    // 工作量口径：已到期的 1 人日 / 共 3 人日 ≈ 33.3%
    expect(left).toBeGreaterThan(30);
    expect(left).toBeLessThan(37);
    // 日历口径（旧「今日（应达）」线的算法）只有 (8/20−8/13)/(10/2−8/13) ≈ 14%，两者必须区分开
    expect(left).toBeGreaterThan(20);
  });

  it('需求卡片：同时保留今日线（日历）与应达基线（工作量）', () => {
    const ctx = makeCtx();
    const card = renderModCard(tightThenLoose(), ctx);
    expect(card).toContain('rmod-bar-plan');
    expect(card).toContain('rmod-bar-today');    // 今日线标的是日历位置，本身没错，保留
    const m = card.match(/rmod-bar-plan" style="left:([\d.]+)%"/);
    expect(Number(m[1])).toBeGreaterThan(30);    // ≈33.3%，而非日历 14%
  });
});

describe('views: 总览（report）按需求默认排序（进行中优先）', () => {
  // 三条需求、各自只放一个任务，状态决定档位：
  //   已逾期（结束日已过、有人负责、未完成）→ tier 0，最前
  //   进行中（今日落在任务窗口内）        → tier 3
  //   已完成（done=100）                → tier 6，沉底
  // 数组顺序刻意排成"已完成在前"，证明是排序在起作用而不是碰巧。
  //
  // ⚠️ 逾期判定要求任务**有人负责**（isOverdueTask 排除未分配资源的任务），故都带上 res。
  //    名称前缀（甲/乙/丙）是故意的：这三条的名字会作为**普通文字**出现在页面上，
  //    若用「已逾期」这种既是名字又是状态文案的字符串去 indexOf，会撞上顶部指标里的
  //    「逾期任务」等字样，量出来的顺序就是假的。
  function threeMods() {
    const bar = (id, s, e, done) => ({ id, p: 'dev', s, e, w: 5, done, res: ['张三'] });
    return [
      { name: '甲需求已完成', bars: [bar('a', '2026-08-01', '2026-08-05', 100)] },
      { name: '乙需求进行中', bars: [bar('b', '2026-08-18', '2026-08-25', 40)] },
      { name: '丙需求已逾期', bars: [bar('c', '2026-08-01', '2026-08-07', 0)] }
    ];
  }

  // 「排期总览」的行顺序：直接解析 rtl2 行的行头（`<span class="rtl2-name">需求名</span>`）。
  // 不能靠 indexOf(需求名) 量位置 —— 需求名在整页里出现多次（桌面行、移动卡片、
  // 卡片内 title），量到的是"文案里第一次提到它"，排出来会是个恒真的假顺序。
  const rowsOf = html => [...html.matchAll(/<span class="rtl2-name">([^<]+)<\/span>/g)].map(m => m[1]);

  const NAMES = ['丙需求已逾期', '乙需求进行中', '甲需求已完成'];

  const EXPECTED = ['乙需求进行中', '丙需求已逾期', '甲需求已完成'];

  it('排期总览按「进行中优先」排，不再用数据数组顺序', () => {
    const ctx = makeCtx();
    ctx.state.modules = threeMods();
    expect(rowsOf(renderReportView(null, ctx))).toEqual(EXPECTED);
  });

  it('与台账默认列表同源：同一批数据在两页排出同一次序', () => {
    const ctx = makeCtx();
    ctx.state.modules = threeMods();
    const reportOrder = rowsOf(renderReportView(null, ctx));

    // 台账默认排序（group/asc）走的是同一份 sortModsDefault；行用 data-req-row 标出
    const reqCtx = makeReqCtx();
    reqCtx.state.modules = threeMods();
    reqCtx.reqSort = { key: 'group', dir: 'asc' };
    const req = renderReqView(null, reqCtx);
    const reqOrder = NAMES
      .map(n => ({ n, i: req.indexOf(`data-req-row="${n}"`) }))
      .sort((a, b) => a.i - b.i)
      .map(x => x.n);

    expect(reqOrder).toEqual(EXPECTED);
    expect(reportOrder).toEqual(reqOrder);
  });

  it('待排期需求整档排在推进中之后，但不落到已完成之后', () => {
    const ctx = makeCtx();
    const mods = threeMods();
    mods.push({ name: '丁需求待排期', unscheduled: true, bars: [{ id: 'd', p: 'dev', s: '2026-08-01', e: '2026-08-05', w: 5, done: 0, res: [] }] });
    ctx.state.modules = mods;
    const order = rowsOf(renderReportView(null, ctx));
    expect(order.indexOf('丁需求待排期')).toBeGreaterThan(order.indexOf('乙需求进行中'));
    expect(order.indexOf('丁需求待排期')).toBeLessThan(order.indexOf('甲需求已完成'));
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

  it('view=req 走整页文档分支：渲染台账表格、宽度 100%、加 report-mode', () => {
    const { gantt, gsc } = shell(0);
    const ctx = ctxFor(gantt, gsc, { view: 'req' });
    ctx.state.versions = [{ id: 'v1', name: 'V2.3', date: '2026-09-09', shipped: false, shippedAt: null, mods: ['官网改版'] }];
    ctx.reqFilter = { kw: '', status: 'all', pri: 'all', ver: 'all', scope: 'all', unscheduled: 'all' };
    ctx.reqSort = { key: 'order', dir: 'asc' };
    let reportMode = false;
    gantt.classList.add = cls => { if (cls === 'report-mode') reportMode = true; };
    renderAll(ctx);
    expect(gantt.innerHTML).toContain('class="req-table"');
    expect(gantt.innerHTML).toContain('data-req-row=');
    expect(gantt.style.width).toBe('100%');
    expect(reportMode).toBe(true);
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
    ['需求', '提出人', '状态', '生命周期', '文档', '所属版本', '排期与进度', '关键时间', '操作']
      .forEach(h => expect(html).toContain(h));
    // 描述已不再单列（收进展开档案），主行只留文档入口，避免空列白占宽度
    expect(html).not.toContain('<th class="req-col-opt">描述</th>');
    // 上线情况同理：读的是版本口径，铺在表里与「状态」列互相干扰，收进展开档案
    expect(html).not.toContain('上线情况</th>');
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

  it('待排期需求不显示排期与进度、关键时间（日期没定，进度与卡点都不可信）', () => {
    // 故意给这条需求塞上真实任务与两个卡点里程碑：证明是"按待排期状态抑制"，
    // 而不是"恰好没数据所以没渲染"
    const bars = [
      { id: 'a', p: 'dev', s: '2026-08-01', e: '2026-08-07', w: 5, done: 40, res: [] },
      { id: 'c', p: 'cfm', m: '2026-08-05', label: '需求确认' },
      { id: 't', p: 'sit', m: '2026-08-20', label: '提测' }
    ];
    const htmlOf = unscheduled => {
      const ctx = makeReqCtx();
      ctx.state.modules = [{ name: '样本需求', unscheduled, bars }];
      return renderReqView(null, ctx);
    };

    const waiting = htmlOf(true);
    // 排期列只剩「待排期」三个字，卡点列留空占位
    expect(waiting).toContain('<td class="req-c-plan"><span class="req-muted">待排期</span></td>');
    expect(waiting).toContain('<td class="req-c-gate"><span class="req-muted">—</span></td>');
    expect(waiting).not.toContain('req-pbar');    // 没有进度条
    expect(waiting).not.toContain('req-devi');    // 没有偏差
    expect(waiting).not.toContain('req-gate');    // 没有卡点 chip
    expect(waiting).not.toContain('8/5');         // 卡点日期一个都不露

    // 同一份数据、只切掉待排期标记：两列照常给出（证明上面的"空"是抑制出来的）
    const scheduled = htmlOf(false);
    expect(scheduled).toContain('req-pbar');
    expect(scheduled).toContain('req-gate');
    expect(scheduled).not.toContain('req-muted">待排期');
  });

  it('「进行中优先」排序下渲染拖拽手柄与分组档位，其它排序下都不渲染', () => {
    const ctx = makeReqCtx();
    ctx.reqSort = { key: 'group', dir: 'asc' };
    const on = renderReqView(null, ctx);
    expect(on).toContain('默认排序');   // 排序下拉里能选到（默认项就叫这四个字）
    expect(on).toContain('data-req-drag="官网改版"');
    expect(on).toMatch(/data-req-tier="\d"/);

    // 其它排序的档内先后由排序键决定，拖了也会被重排回去 → 不给手柄
    ctx.reqSort = { key: 'pri', dir: 'asc' };
    const off = renderReqView(null, ctx);
    expect(off).not.toContain('data-req-drag');
    expect(off).not.toContain('data-req-tier');
  });

  it('未填写文档时显示占位符，不留空白', () => {
    const html = renderReqView(null, makeReqCtx());
    expect(html).toContain('req-doc-empty');
  });

  it('有文档时渲染可点开的文字链接（不是图标）', () => {
    const ctx = makeReqCtx();
    ctx.state.modules[0].docUrl = 'https://example.feishu.cn/docx/abc';
    const html = renderReqView(null, ctx);
    expect(html).toContain('class="req-doc"');
    expect(html).toContain('需求文档');
    expect(html).toContain('rel="noopener noreferrer"');   // 外链必须带 noopener
  });

  it('生命周期与提出人支持行内编辑（展示版与编辑版同时渲染，由 CSS 二选一）', () => {
    const ctx = makeReqCtx();
    ctx.state.modules[0].lifecycle = '已确认';
    ctx.state.modules[0].proposedBy = '张三';
    const html = renderReqView(null, ctx);

    expect(html).toContain('req-inline-view');                 // 展示版（只读时露出的那份）
    expect(html).toContain('data-req-inline="lifecycle"');
    expect(html).toContain('data-req-inline="proposedBy"');
    // 当前值要预选 / 回填，原值记进 data-prev —— 提交时靠它判断「有没有真的变」
    expect(html).toContain('data-prev="已确认"');
    expect(html).toContain('data-prev="张三"');
    expect(html).toMatch(/<option value="已确认" selected/);
    expect(html).toContain('value="张三"');
    // 「未设置」档必须在：否则编辑一次老数据就会把「未设置」悄悄变成「待确认」
    expect(html).toContain('<option value="">未设置</option>');
    // 提出人候选来自全量需求的已有值（不是写死在 HTML 里）
    expect(html).toContain('<datalist id="reqProposerList">');
    expect(html).toContain('<option value="张三"></option>');
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

  it('上线情况不再单列，但仍能从展开档案里看到', () => {
    const ctx = makeReqCtx();
    expect(renderReqView(null, ctx)).not.toContain('req-c-ship');

    toggleReqExpanded('官网改版');
    const expanded = renderReqView(null, ctx);
    toggleReqExpanded('官网改版');   // 复位，别把展开态留给后面的用例
    expect(expanded).toContain('<i>所属版本</i>');
    expect(expanded).toContain('<i>计划上线</i>');
    expect(expanded).toContain('<i>实际上线</i>');
  });

  it('进度列显示偏差，延后时进度条变色（与总览卡片同口径）', () => {
    const ctx = makeReqCtx();
    // 造一个"计划已到期但未完成"的任务 + 一个远期的收口任务：
    // PV 被前段的任务顶高、EV 为 0 → 偏差为负 → 必须显示「延后」且进度条转红
    ctx.state.modules[0].bars = [
      { id: 'a', p: 'dev', s: '2026-08-01', e: '2026-08-07', w: 5, done: 0, res: [] },
      { id: 'b', p: 'go', s: '2026-12-01', e: '2026-12-01', w: 1, done: 0, res: [] }
    ];
    const html = renderReqView(null, ctx);
    expect(html).toContain('req-devi');
    expect(html).toContain('延后');
    expect(html).toContain('<i class="late"');   // 进度条填充转红
  });

  it('已完成的需求不再报偏差（回归：100% 却标「超前」）', () => {
    const ctx = makeReqCtx();                       // today = 2026-08-20
    // 复现「县域银保」的形状：活全干完了（EV 100%），但计划把最后 1 人日
    // 排到 12/1 才到期 → PV 只有 83.3%，旧实现会打出「超前 17%」，
    // 与同一行的「已完成」标签自相矛盾。
    ctx.state.modules[0].bars = [
      { id: 'a', p: 'dev', s: '2026-08-01', e: '2026-08-07', w: 5, done: 100, res: [] }, // 已到期且完成
      { id: 'b', p: 'go', s: '2026-12-01', e: '2026-12-01', w: 1, done: 100, res: [] }   // 未到期但已完成
    ];
    const html = renderReqView(null, ctx);
    expect(html).not.toContain('req-devi');         // 不渲染偏差标记
    expect(html).not.toContain('超前');
    expect(html).toContain('100% · 6.0/6 人日');    // 完成度照常展示
  });

  it('已归档的需求不体现延后（进度条中性色，不再报偏差）', () => {
    // 同一份数据、只切 archived 开关：未归档要如实提示，归档后不该再提示
    const render = archived => {
      const ctx = makeReqCtx();                     // today = 2026-08-20
      const mo = {
        name: '归档样本',
        bars: [
          { id: 'a', p: 'dev', s: '2026-08-01', e: '2026-08-07', w: 5, done: 0, res: [] }, // 已到期未完成
          { id: 'b', p: 'go', s: '2026-12-01', e: '2026-12-01', w: 1, done: 0, res: [] }   // 远期收口
        ]
      };
      if (archived) mo.archived = true;
      ctx.state.modules = [mo];                     // 只留一条，避免其他需求的文案干扰断言
      return renderReqView(null, ctx);
    };
    expect(render(false)).toContain('延后');                        // 未归档：如实提示
    expect(render(false)).toContain('<i class="late"');             // 且进度条转红
    const arch = render(true);
    expect(arch).toContain('req-badge-arch');                       // 归档标记照常
    expect(arch).not.toContain('延后');                             // 但不再提示延后
    expect(arch).not.toContain('req-devi');
    expect(arch).toContain('<i class="archived"');                  // 进度条转中性色
  });
});

// ============================================================
// Task 12：台账的归档 / 删除按钮按需求归属显隐
//   分界线不是"只读与否"（协作者不是只读），而是"这条需求归不归我"。
//   行内字段编辑（生命周期 / 提出人 / 所属版本）走字段级口径，保持放开。
// ============================================================
describe('views: 台账归档/删除按需求归属显隐（Task 12）', () => {
  beforeEach(() => { userStore.reset(); });

  const renderWith = (mods, user) => {
    const ctx = makeReqCtx();
    ctx.state.modules = mods;
    userStore.set({ readonly: false, ...user });
    return renderReqView(null, ctx);
  };

  it('协作者：只有自己创建的需求带归档/删除，别人的与无主的都不带', () => {
    const html = renderWith([
      { name: '我的需求', owner: '张三', bars: [], pri: 'P1' },
      { name: '别人的需求', owner: '李四', bars: [], pri: 'P1' },
      { name: '无主需求', bars: [], pri: 'P1' }
    ], { access: 'collab', resourceName: '张三', role: 'user' });

    expect(html).toContain('data-req-del="我的需求"');
    expect(html).toContain('data-req-archive="我的需求"');
    expect(html).not.toContain('data-req-del="别人的需求"');
    expect(html).not.toContain('data-req-archive="别人的需求"');
    // 无主需求 ≠ 可认领：归属级动作只给全权
    expect(html).not.toContain('data-req-del="无主需求"');
    // 编辑按钮始终在：字段级编辑对协作者放开（弹窗里再按归属置灰名字/归属）
    expect(html).toContain('data-req-edit="别人的需求"');
    // 行内字段编辑也保持放开
    expect(html).toContain('data-req-inline="lifecycle"');
  });

  it('全权用户：所有需求（含别人的与无主的）都能归档/删除', () => {
    const html = renderWith([
      { name: '我的需求', owner: '张三', bars: [], pri: 'P1' },
      { name: '别人的需求', owner: '李四', bars: [], pri: 'P1' },
      { name: '无主需求', bars: [], pri: 'P1' }
    ], { access: 'full', resourceName: '张三', role: 'admin' });

    ['我的需求', '别人的需求', '无主需求'].forEach(n => {
      expect(html).toContain(`data-req-del="${n}"`);
      expect(html).toContain(`data-req-archive="${n}"`);
    });
  });

  it('只读身份：一条都不渲染（除 CSS 外还有这层显隐）', () => {
    const html = renderWith([
      { name: '我的需求', owner: '张三', bars: [], pri: 'P1' }
    ], { access: 'readonly', readonly: true, resourceName: '张三' });
    expect(html).not.toContain('data-req-del="我的需求"');
  });
});

describe('views: 需求台账「上线情况」措辞', () => {
  // 这段（展开档案里的「上线情况」）取 versionStatus 的版本口径，其中「进行中」
  // （版本有成员已开工）和「已逾期」（版本过了上线日没发）会与「状态」列的 moduleTag 撞词。
  // 同一处两个「进行中」/两个「已逾期」且含义不同，读者分不清说的是需求还是版本 ——
  // 这也是它从主行那一列收进档案的原因之一。
  it('用上线口径措辞，不复述需求状态', () => {
    // 显式造一个"计划已到期但未完成"的需求，不依赖默认数据的完成度
    const withVer = (date, shipped) => {
      const ctx = makeReqCtx();                      // today = 2026-08-20
      ctx.state.modules = [{
        name: '样本需求',
        bars: [{ id: 'a', p: 'dev', s: '2026-08-01', e: '2026-08-07', w: 5, done: 0, res: [] }]
      }];
      ctx.state.versions = [{
        id: 'v1', name: 'V1', date,
        shipped: !!shipped, shippedAt: shipped ? '2026-08-19' : null, mods: ['样本需求']
      }];
      return ctx;
    };
    const text = (date, shipped) => {
      const ctx = withVer(date, shipped);
      return shipInfo(ctx.state.modules[0], ctx).text;
    };

    // 版本在做 → 「未上线」，而不是与状态列重复的「进行中」
    expect(text('2026-12-01')).toBe('未上线');
    // 人工标记上线
    expect(text('2026-12-01', true)).toBe('已上线');
    // 过了上线日仍未完成 → 「上线逾期」，而不是需求口径的「已逾期」
    expect(text('2026-08-01')).toBe('上线逾期');
  });
});

describe('views: 需求台账展开档案', () => {
  it('未展开时不渲染档案行', () => {
    const html = renderReqView(null, makeReqCtx());
    expect(html).not.toContain('req-detail-tr');
  });

  it('展开后依次包含提出与生命周期、描述、文档、上线情况、排期进度、阶段明细、里程碑七段', () => {
    const ctx = makeReqCtx();
    ctx.state.modules[0].lifecycle = '已确认';
    toggleReqExpanded('官网改版');
    const html = renderReqView(null, ctx);
    toggleReqExpanded('官网改版');   // 复位，避免污染其它用例
    expect(html).toContain('req-detail-tr');
    ['propose', 'desc', 'doc', 'ship', 'progress', 'phases', 'ms']
      .forEach(s => expect(html).toContain(`data-req-sec="${s}"`));
    // 档案行的 colspan 给的是远超实际列数的值（浏览器会自动收敛到实际列数），
    // 这样以后增删列就不必回来同步这个数字 —— 它已经从 9 漂到 12 过一次
    expect(html).toContain('colspan="20"');
  });

  it('展开档案的「提出与生命周期」里，提测取里程碑而不是 SIT 任务', () => {
    const ctx = makeReqCtx();
    ctx.state.modules[0].bars = [
      { id: 'sit-task', s: '2026-08-17', e: '2026-08-21', p: 'sit', w: 5, res: [] },
      { id: 'tice', m: '2026-08-24', p: 'sit', label: '提测' }
    ];
    toggleReqExpanded('官网改版');
    const html = renderReqView(null, ctx);
    toggleReqExpanded('官网改版');
    // 只在「提出与生命周期」小节内断言：整页里 8/17 是 SIT 任务自己的日期（阶段明细 / 排期都会渲染），
    // 对整页断言 not.toContain('8/17') 会把正确实现判成失败
    const sec = html.slice(html.indexOf('data-req-sec="propose"'), html.indexOf('data-req-sec="desc"'));
    expect(sec).toContain('8/24');       // 提测 = 提测里程碑
    expect(sec).not.toContain('8/17');   // 而不是 SIT 任务的开始日
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

describe('views: 生命周期徽标', () => {
  it('五档各自映射到 lc-* 类名（结构固定，配色在 CSS）', () => {
    expect(lifecycleBadge('待分析')).toContain('class="lc lc-analyze"');
    expect(lifecycleBadge('待确认')).toBe('<span class="lc lc-todo" title="生命周期（人工维护）：待确认">待确认</span>');
    expect(lifecycleBadge('已确认')).toContain('class="lc lc-ok"');
    expect(lifecycleBadge('已提测')).toContain('class="lc lc-sit"');
    expect(lifecycleBadge('已上线')).toContain('class="lc lc-live"');
  });

  it('未设置（缺字段 / 非法值）渲染 lc-none，不留空白', () => {
    [undefined, null, '', '已上线 '].forEach(v => {
      expect(lifecycleBadge(v)).toContain('class="lc lc-none"');
      expect(lifecycleBadge(v)).toContain('未设置');
    });
  });
});

describe('需求台账：提出 / 生命周期 / 关键时间三列', () => {
  it('三个列头齐全且可点排序', () => {
    const html = renderReqView(null, makeReqCtx());
    expect(html).toContain('data-req-sort="proposed"');
    expect(html).toContain('data-req-sort="lifecycle"');
    expect(html).toContain('data-req-sort="confirm"');
    expect(html).toMatch(/>提出/);
    expect(html).toMatch(/>生命周期/);
    expect(html).toMatch(/>关键时间/);
  });

  it('提出列显示提出人与日期，缺值时显示「—」', () => {
    const ctx = makeReqCtx();
    ctx.state.modules[0].proposedBy = '张三';
    ctx.state.modules[0].proposedAt = '2026-08-01';
    const html = renderReqView(null, ctx);
    expect(html).toContain('req-prop');
    expect(html).toContain('张三');
    expect(html).toContain('8/1');
    // 另两条需求都没有提出信息 → 渲染占位符而不是空白
    expect(html).toContain('req-muted">—');
  });

  it('生命周期列：有值出对应徽标，未设置出 lc-none', () => {
    const ctx = makeReqCtx();
    ctx.state.modules[0].lifecycle = '已提测';
    const html = renderReqView(null, ctx);
    expect(html).toContain('class="lc lc-sit"');
    expect(html).toContain('class="lc lc-none"');   // 其余两条需求未设置
  });

  it('关键时间列取确认与提测里程碑，测试任务不算提测', () => {
    const ctx = makeReqCtx();
    ctx.state.modules = [{
      name: '卡点样本',
      bars: [
        { id: 'cfm', m: '2026-08-14', p: 'cfm', label: '需求确认' },
        { id: 'sit-task', s: '2026-08-17', e: '2026-08-21', p: 'sit', w: 5, res: [] },
        { id: 'tice', m: '2026-08-24', p: 'sit', label: '提测' }
      ]
    }];
    const html = renderReqView(null, ctx);
    expect(html).toContain('req-gate');
    expect(html).toContain('8/14');                  // 确认
    expect(html).toContain('8/24');                  // 提测（不是 8/17 的测试任务）
  });

  it('没有任何里程碑的需求，关键时间显示「—」', () => {
    const ctx = makeReqCtx();
    ctx.state.modules = [{ name: '空需求', bars: [] }];
    const html = renderReqView(null, ctx);
    expect(html).not.toContain('req-gate');
    expect(html).toContain('req-muted">—');
  });

  it('列头数与主行单元格数一致（9 列，防止加列时只改一半）', () => {
    // 12 → 11：删掉「描述」列（描述收进展开档案，主行只留文档入口）
    // 11 → 10：「排期」与「进度」合并成一列（区间在上、完成度在下）
    // 10 →  9：删掉「上线情况」列（版本口径，同样收进展开档案）
    const ctx = makeReqCtx();
    ctx.state.modules = [{ name: '单条', bars: [] }];
    const html = renderReqView(null, ctx);
    const thead = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
    const tbody = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
    // 用 /<th[\s>]/ 而不是 /<th/：后者会把 <thead> 也算成一个列头
    expect((thead.match(/<th[\s>]/g) || []).length).toBe(9);
    expect((tbody.match(/<td[\s>]/g) || []).length).toBe(9);
  });

  it('筛选条有生命周期下拉，含五档选项与「未设置」', () => {
    const html = renderReqView(null, makeReqCtx());
    expect(html).toContain('data-req-f="lifecycle"');
    ['全部生命周期', '待分析', '待确认', '已确认', '已提测', '已上线']
      .forEach(t => expect(html).toContain(`>${t}</option>`));
    expect(html).toContain('>未设置</option>');   // 老数据的"未设置"必须能被单独筛出来
  });
});

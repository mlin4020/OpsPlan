// 资源工作视图测试：
//   1) taskStatus 的状态口径（与需求级 moduleTag / isOverdueTask 同源，不能各算一套）
//   2) renderWorkView 的按人分组、优先级、排序、未分配 / 归档剔除 / 空态处理
//   3) 接入契约：桌面与手机导航入口、非时间轴视图的工具栏收敛、CSS 顺序与窄屏版式
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { F } from '../src/core/dates.js';
import { defaultModules, defaultResources, defaultHolidays } from '../src/core/default-data.js';
import { taskStatus, TASK_STATUS_RANK } from '../src/core/task-status.js';
import {
  UNASSIGNED, defaultWorkFilter, describeWorkFilter, isWorkFilterActive,
  normalizeWorkFilter, personScope, taskMatchesFilter
} from '../src/core/work-filter.js';
import { renderWorkView } from '../src/views/work-view.js';
import { renderAll } from '../src/views/index.js';
import { buildShellHTML, buildViewerShellHTML } from '../src/components/shell.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(ROOT, 'src/styles/gantt.css'), 'utf8');
const toolbarSrc = readFileSync(resolve(ROOT, 'src/components/toolbar.js'), 'utf8');
const componentsSrc = readFileSync(resolve(ROOT, 'src/components/index.js'), 'utf8');
const standaloneSrc = readFileSync(resolve(ROOT, 'src/main-standalone.js'), 'utf8');
const ganttSrc = readFileSync(resolve(ROOT, 'src/main-gantt.js'), 'utf8');

// 模拟 sched.tasks()：直接引用原 bar 对象并补 mod / isMs（见 scheduler/index.js 的 collect）
function flatten(mods) {
  const out = [];
  mods.forEach(mo => mo.bars.forEach(b => {
    const t = Object.assign(b, { mod: mo.name, isMs: !!b.m });
    if (!t.isMs && !Array.isArray(t.res)) t.res = [];
    out.push(t);
  }));
  return out;
}

// 构造最小渲染 ctx（与 renderAll 的 buildViewCtx 契约对齐，见 views.test.js 的 makeCtx）
function makeCtx(over) {
  const state = {
    modules: defaultModules(),
    resources: defaultResources(),
    start: F('2026-08-12'),
    end: F('2026-11-30')
  };
  const isWd = d => { const w = d.getDay(); return w !== 0 && w !== 6; };
  const ctx = {
    state,
    sched: { tasks: () => flatten(state.modules) },
    holidays: defaultHolidays(),
    today: F('2026-08-20'),
    modColors: {},
    workday: {
      workDays: (s, e) => {
        let n = 0; const d = F(s); const end = F(e);
        while (d <= end) { if (isWd(d)) n++; d.setDate(d.getDate() + 1); }
        return n;
      }
    }
  };
  return Object.assign(ctx, over);
}

// 取手机端主断点（与 mobile-layout.test.js 的 phoneCss 同源：文件中最后一个 ≤767px 块）
const mainPhoneStart = css.lastIndexOf('@media (max-width:767px)');

describe('taskStatus: 单条任务的状态口径', () => {
  const day = F('2026-08-20');
  const T = over => ({ id: 'x', p: 'dev', s: '2026-08-18', e: '2026-08-22', done: 0, res: ['张三'], ...over });

  it('已完成优先于逾期（结束日已过但做完了，不算逾期）', () => {
    expect(taskStatus(T({ s: '2026-08-01', e: '2026-08-10', done: 100 }), day))
      .toEqual({ key: 'done', text: '已完成', color: '#10b981' });
  });

  it('结束日已过且有人负责 → 已逾期', () => {
    const st = taskStatus(T({ s: '2026-08-01', e: '2026-08-10', done: 30 }), day);
    expect(st.key).toBe('overdue');
    expect(st.text).toBe('已逾期');
  });

  it('今日落在 [s,e] 区间内 → 进行中（与需求级 started 同一窗口）', () => {
    expect(taskStatus(T({ s: '2026-08-18', e: '2026-08-22' }), day).key).toBe('doing');
    expect(taskStatus(T({ s: '2026-08-20', e: '2026-08-20' }), day).key).toBe('doing');
  });

  it('未开工（开始日在未来）→ 未开始', () => {
    expect(taskStatus(T({ s: '2026-08-25', e: '2026-08-28' }), day).key).toBe('todo');
  });

  it('已过期但没人负责 → 未开始（逾期的定义是"有人负责且没做完"，无人认领不记在某个人头上）', () => {
    expect(taskStatus(T({ s: '2026-08-01', e: '2026-08-10', done: 0, res: [] }), day).key).toBe('todo');
  });

  it('里程碑不判逾期（0 天单点，不占工作量，本页也不列它）', () => {
    expect(taskStatus({ isMs: true, s: '2026-08-01', e: '2026-08-01', done: 0, res: ['张三'] }, day).key).toBe('todo');
  });

  it('排序权重覆盖全部状态，且"逾期在前、已完成在后"', () => {
    ['overdue', 'doing', 'todo', 'done'].forEach(k => expect(typeof TASK_STATUS_RANK[k]).toBe('number'));
    expect(TASK_STATUS_RANK.overdue).toBeLessThan(TASK_STATUS_RANK.doing);
    expect(TASK_STATUS_RANK.doing).toBeLessThan(TASK_STATUS_RANK.todo);
    expect(TASK_STATUS_RANK.todo).toBeLessThan(TASK_STATUS_RANK.done);
  });
});

describe('renderWorkView: 按人汇总的任务清单', () => {
  it('每个人一块，任务行带所属需求与优先级（优先级取自需求）', () => {
    const html = renderWorkView(null, makeCtx());
    // 人名是可点的筛选入口（点一下只看这个人）：有任务的人渲染成 button，没任务的是 span
    expect(html).toContain('class="rwk-pname" data-wk-pick="张三"');
    expect(html).toContain('class="rwk-pname" data-wk-pick="吴十"');
    // 张三名下确实挂着官网改版的任务，而官网改版是 P0
    expect(html).toContain('class="pri pri-p0"');
    expect(html).toContain('class="pri pri-p3"');
    expect(html).toContain('rwk-mod-t">官网改版');
  });

  it('状态徽标复用 .tag（不另立一套），底色取自 taskStatus 的数据色', () => {
    const html = renderWorkView(null, makeCtx());
    // 8/20 时默认数据的任务都还没开工 → 全部灰色未开始
    expect(html).toMatch(/<span class="tag rwk-state" style="background:#94a3b8" title="[^"]+">未开始<\/span>/);
  });

  it('里程碑不进清单（里程碑是时间点，不是"手里的活儿"）', () => {
    const html = renderWorkView(null, makeCtx());
    expect(html).not.toContain('9/9 上线');
    expect(html).not.toContain('11/13 整体上线');
  });

  it('指标口径：人员任务只算已分配的阶段任务；归档需求整体退出本页', () => {
    const mods = defaultModules();
    const assigned = mods.flatMap(m => m.bars.filter(b => !b.m && b.res && b.res.length));
    const ctx = makeCtx();
    expect(renderWorkView(null, ctx)).toContain(`<b>${assigned.length}</b><span>人员任务</span>`);
    // 归档后该需求的任务既不进清单也不进指标（人不再被这段活占着）
    ctx.state.modules[0].archived = true;
    const archN = ctx.state.modules[0].bars.filter(b => !b.m && b.res && b.res.length).length;
    expect(renderWorkView(null, ctx)).toContain(`<b>${assigned.length - archN}</b><span>人员任务</span>`);
  });

  it('归档需求的任务整条不进清单（归档即收口，要看历史去「需求台账」页）', () => {
    const ctx = makeCtx();
    ctx.state.modules[0].archived = true;
    const archN = ctx.state.modules[0].bars.filter(b => !b.m).length;
    const html = renderWorkView(null, ctx);
    expect(html).not.toContain('rwk-mod-t">官网改版');
    expect(html).not.toContain('rwk-chip arch');     // 行内不再有归档徽标
    expect(html).not.toContain('>已归档</span>');
    expect(html).not.toContain('rwk-row is-arch');   // 也不再靠置灰表达
    // 但要说清"数字去哪了"，否则和甘特图一比会以为丢数据
    expect(html).toContain(`已隐藏 ${archN} 项归档需求的任务`);
  });

  it('任务全部归档时给的是"只剩归档需求了"，不是"还没有任何任务"', () => {
    const ctx = makeCtx();
    ctx.state.modules.forEach(m => { m.archived = true; });
    const html = renderWorkView(null, ctx);
    expect(html).toContain('只剩归档需求了');
    expect(html).toContain('「需求台账」页');
    expect(html).not.toContain('还没有任何任务');
  });

  it('未分配任务单独成组（没人认领的活儿最容易漏）', () => {
    const ctx = makeCtx();
    ctx.state.modules[1].bars.find(b => b.id === 'm2-dev').res = [];
    const html = renderWorkView(null, ctx);
    const tail = html.slice(html.indexOf('rwk-person is-unassigned'));
    expect(tail).toContain('数据看板');
    expect(tail).toContain('待认领');
  });

  it('清单里出现但已不在资源库的人名兜底成组，任务不会凭空消失', () => {
    const ctx = makeCtx();
    ctx.state.modules[1].bars.find(b => b.id === 'm2-dev').res = ['赵老板'];
    const html = renderWorkView(null, ctx);
    expect(html).toContain('资源库外');
    expect(html).toContain('rwk-pname" data-wk-pick="赵老板"');
  });

  it('没有任务的人在册也出现（空档可看产能）', () => {
    const ctx = makeCtx();
    ctx.state.resources.push({ id: 'newbie', name: '新人甲', role: '开发', color: '#0ea5e9' });
    const html = renderWorkView(null, ctx);
    expect(html).toContain('rwk-person is-idle');
    expect(html).toContain('rwk-pname">新人甲');
    expect(html).toContain('暂无任务');
  });

  it('同一人内排序：逾期 → 进行中 → 未开始 → 已完成', () => {
    const ctx = makeCtx({ today: F('2026-08-20') });
    ctx.state.modules = [{
      name: '排序样例', tag: '冲刺中', tagc: '#ef4444', pri: 'P1',
      bars: [
        { id: 'a', s: '2026-09-20', e: '2026-09-25', p: 'dev', w: 4, done: 0, res: ['张三'], dep: [], manual: false, ignore: false },
        { id: 'b', s: '2026-08-01', e: '2026-08-05', p: 'req', w: 3, done: 40, res: ['张三'], dep: [], manual: false, ignore: false },
        { id: 'c', s: '2026-08-10', e: '2026-08-12', p: 'ui', w: 2, done: 100, res: ['张三'], dep: [], manual: false, ignore: false },
        { id: 'd', s: '2026-08-18', e: '2026-08-22', p: 'sit', w: 3, done: 0, res: ['张三'], dep: [], manual: false, ignore: false }
      ]
    }];
    ctx.state.resources = [{ id: 'r1', name: '张三', role: '需求', color: '#3b82f6' }];
    const html = renderWorkView(null, ctx);
    const idx = ['需求分析', '测试(SIT)', '开发', 'UI设计'].map(n => html.indexOf(`>${n}</b>`));
    expect(idx.every(i => i > -1)).toBe(true);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it('完全没任务时给下一步指引，而不是一张白卡片', () => {
    const ctx = makeCtx();
    ctx.state.modules = [];
    ctx.state.resources = [];
    const html = renderWorkView(null, ctx);
    expect(html).toContain('arch-empty');
    expect(html).toContain('还没有任何任务');
  });
});

// ---------------------------------------------------------------------------
// 筛选：本页最常见的用法是"员工查自己手里的活"，所以人员维度必须是第一公民
// 数据集刻意做成四种状态各一条、且有未分配任务，便于逐一核对"筛出来的就是显示的"
// ---------------------------------------------------------------------------
function filterCtx(filter) {
  const ctx = makeCtx({ workFilter: filter });
  ctx.state = {
    start: F('2026-08-12'),
    end: F('2026-11-30'),
    resources: [
      { id: 'r1', name: '张三', role: '需求', color: '#3b82f6' },
      { id: 'r2', name: '李四', role: '开发', color: '#10b981' }
    ],
    modules: [
      {
        name: '官网改版', tag: '冲刺中', tagc: '#ef4444', pri: 'P0', bars: [
          { id: 'a1', s: '2026-08-01', e: '2026-08-05', p: 'dev', w: 5, done: 40, res: ['张三'], dep: [], manual: false, ignore: false },
          { id: 'a2', s: '2026-09-20', e: '2026-09-25', p: 'ui', w: 4, done: 0, res: ['李四'], dep: [], manual: false, ignore: false }
        ]
      },
      {
        name: '数据看板', tag: '待启动', tagc: '#3b82f6', pri: 'P1', bars: [
          { id: 'b1', s: '2026-08-10', e: '2026-08-12', p: 'dev', w: 3, done: 100, res: ['张三'], dep: [], manual: false, ignore: false },
          { id: 'b2', s: '2026-08-18', e: '2026-08-22', p: 'sit', w: 3, done: 0, res: [], dep: [], manual: false, ignore: false }
        ]
      }
    ]
  };
  ctx.sched = { tasks: () => flatten(ctx.state.modules) };
  return ctx;
}

describe('work-filter: 筛选口径（纯逻辑）', () => {
  const today = F('2026-08-20');
  const deps = { today, modPri: { 官网改版: 'P0', 数据看板: 'P1' } };
  const T = over => ({ id: 't', mod: '官网改版', p: 'dev', s: '2026-08-01', e: '2026-08-05', done: 40, res: ['张三'], ...over });

  it('空白筛选 = 不过滤（空数组是"不限"，不是"一个都不要"）', () => {
    expect(isWorkFilterActive(defaultWorkFilter())).toBe(false);
    expect(taskMatchesFilter(T({}), defaultWorkFilter(), deps)).toBe(true);
  });

  it('脏值被归一化剔除（未知状态 key / 非法优先级不会让筛选永远筛空）', () => {
    const n = normalizeWorkFilter({ states: ['overdue', 'nope'], pris: ['P0', 'P9'], q: 'x', person: 0 });
    expect(n.states).toEqual(['overdue']);
    expect(n.pris).toEqual(['P0']);
    expect(n.person).toBe('');   // 0 视为未设置
  });

  it('人员：具体人名 / 未分配 互斥，且未分配不命中已排人的任务', () => {
    expect(taskMatchesFilter(T({}), { ...defaultWorkFilter(), person: '张三' }, deps)).toBe(true);
    expect(taskMatchesFilter(T({}), { ...defaultWorkFilter(), person: '李四' }, deps)).toBe(false);
    expect(taskMatchesFilter(T({}), { ...defaultWorkFilter(), person: UNASSIGNED }, deps)).toBe(false);
    expect(taskMatchesFilter(T({ res: [] }), { ...defaultWorkFilter(), person: UNASSIGNED }, deps)).toBe(true);
    expect(personScope(normalizeWorkFilter({ person: UNASSIGNED }))).toBe('unassigned');
    expect(personScope(defaultWorkFilter())).toBe(null);
  });

  it('状态与优先级取同一套口径（"已逾期"筛出来的必须恰好是显示"已逾期"的那几条）', () => {
    const overdue = { ...defaultWorkFilter(), states: ['overdue'] };
    expect(taskMatchesFilter(T({}), overdue, deps)).toBe(true);
    // 同一条任务改成已完成 → 不再命中"已逾期"（与徽标口径同源）
    expect(taskMatchesFilter(T({ done: 100 }), overdue, deps)).toBe(false);
    expect(taskMatchesFilter(T({}), { ...defaultWorkFilter(), pris: ['P0'] }, deps)).toBe(true);
    expect(taskMatchesFilter(T({}), { ...defaultWorkFilter(), pris: ['P1'] }, deps)).toBe(false);
    // 未设置（''）是刻意的可筛选项：没有 pri 的需求最容易被漏掉
    expect(taskMatchesFilter(T({ mod: '无优先级需求' }), { ...defaultWorkFilter(), pris: [''] }, deps)).toBe(true);
  });

  it('关键词匹配任务名 / 需求名 / 人名（员工通常直接搜自己）', () => {
    const q = s => ({ ...defaultWorkFilter(), q: s });
    expect(taskMatchesFilter(T({ name: '联调' }), q('联调'), deps)).toBe(true);
    expect(taskMatchesFilter(T({}), q('官网'), deps)).toBe(true);
    expect(taskMatchesFilter(T({}), q('张三'), deps)).toBe(true);
    expect(taskMatchesFilter(T({}), q('李四'), deps)).toBe(false);
  });

  it('条件描述用于标题回显（让用户知道"现在筛的是什么"）', () => {
    const d = describeWorkFilter({ q: '登录', person: '张三', states: ['overdue'], pris: ['P0'] }, deps);
    expect(d).toContain('张三');
    expect(d).toContain('关键词「登录」');
    expect(d).toContain('已逾期');
    expect(d).toContain('P0');
  });
});

describe('renderWorkView: 筛选', () => {
  it('筛选条常驻：搜索框 / 人员下拉 / 状态与优先级多选 / 重置', () => {
    const html = renderWorkView(null, filterCtx());
    expect(html).toContain('data-wk-q');
    expect(html).toContain('data-wk-person');
    expect(html).toContain('data-wk-state="overdue"');
    expect(html).toContain('data-wk-pri=""');            // 未设置
    expect(html).toContain('data-wk-reset');
    // 未筛选时重置按钮不可点（避免"点了没反应"）
    expect(html).toMatch(/data-wk-reset disabled/);
  });

  it('人员下拉把每个人的任务数标出来，未分配单独一项', () => {
    const html = renderWorkView(null, filterCtx());
    expect(html).toContain('>张三（2）</option>');
    expect(html).toContain('>李四（1）</option>');
    expect(html).toContain(`>未分配（1）</option>`);
  });

  it('人员下拉的任务数同样不含归档（否则和实际列出的条数对不上）', () => {
    const ctx = filterCtx();
    ctx.state.modules[0].archived = true;   // 官网改版：张三 1 项、李四 1 项 → 归零后张三剩 1、李四剩 0
    ctx.sched = { tasks: () => flatten(ctx.state.modules) };
    const html = renderWorkView(null, ctx);
    expect(html).toContain('>张三（1）</option>');
    expect(html).toContain('>李四（0）</option>');
    expect(html).not.toContain('>张三（2）</option>');
  });

  it('按人筛选：只渲染这个人的块，别人的块整块不出现', () => {
    const html = renderWorkView(null, filterCtx({ ...defaultWorkFilter(), person: '张三' }));
    expect(html).toContain('data-wk-pick="张三"');
    expect(html).not.toContain('data-wk-pick="李四"');
    expect(html).not.toContain('rwk-person is-unassigned');
    // 张三名下两条（官网改版 · 逾期 / 数据看板 · 已完成）都在，李四那条（UI设计）不该在
    expect(html).toContain('rwk-mod-t">官网改版');
    expect(html).toContain('rwk-mod-t">数据看板');
    expect(html).not.toContain('>UI设计</b>');
  });

  it('按人筛选时指标条跟随（否则顶部数字和下面的清单对不上）', () => {
    const html = renderWorkView(null, filterCtx({ ...defaultWorkFilter(), person: '张三' }));
    expect(html).toContain('<b>2</b><span>人员任务</span>');
    expect(html).toContain('<b class="red">1</b><span>已逾期</span>');
    expect(html).toContain('已筛选：张三');
  });

  it('筛选到具体某人时「有任务人员」不被共享任务撑成全员（否则看着像筛选没生效）', () => {
    const ctx = filterCtx({ ...defaultWorkFilter(), person: '李四' });
    // 全员参与的收口任务（现实中就是"回归验证"这类）：不加处理的话两个人都会算成"有任务"
    ctx.state.modules[0].bars.push({ id: 'a3', s: '2026-08-01', e: '2026-08-03', p: 'reg', w: 2, done: 0, res: ['张三', '李四'], dep: [], manual: false, ignore: false });
    ctx.sched = { tasks: () => flatten(ctx.state.modules) };
    expect(renderWorkView(null, ctx)).toContain('<b>1<i>/2</i></b>');
    // 同理：只看"未分配"时没有执行人，这个数字应当是 0 而不是全员
    const un = filterCtx({ ...defaultWorkFilter(), person: UNASSIGNED });
    expect(renderWorkView(null, un)).toContain('<b>0<i>/2</i></b>');
  });

  it('筛"未分配"：只剩未分配块（没人认领的活儿本身就是一个维度）', () => {
    const html = renderWorkView(null, filterCtx({ ...defaultWorkFilter(), person: UNASSIGNED }));
    expect(html).toContain('rwk-person is-unassigned');
    expect(html).not.toContain('data-wk-pick="张三"');
    expect(html).toContain('rwk-mod-t">数据看板');
    expect(html).not.toContain('rwk-mod-t">官网改版');
  });

  it('按状态筛选：没命中的人整块不渲染（避免一屏「暂无任务」淹没结果）', () => {
    const html = renderWorkView(null, filterCtx({ ...defaultWorkFilter(), states: ['overdue'] }));
    expect(html).toContain('data-wk-pick="张三"');
    expect(html).not.toContain('data-wk-pick="李四"');       // 李四只有未开始的任务
    expect(html).not.toContain('rwk-person is-unassigned');  // 未分配那条是"进行中"
    expect(html).not.toContain('rwk-person is-idle');
  });

  it('按优先级筛选：走需求级优先级（任务自己没有 pri）', () => {
    const html = renderWorkView(null, filterCtx({ ...defaultWorkFilter(), pris: ['P1'] }));
    expect(html).toContain('rwk-mod-t">数据看板');
    expect(html).not.toContain('rwk-mod-t">官网改版');
  });

  it('关键词筛选：命中任务名 / 需求名', () => {
    const byMod = renderWorkView(null, filterCtx({ ...defaultWorkFilter(), q: '官网' }));
    expect(byMod).toContain('rwk-mod-t">官网改版');
    expect(byMod).not.toContain('rwk-mod-t">数据看板');

    const byName = renderWorkView(null, filterCtx({ ...defaultWorkFilter(), q: '测试' }));
    expect(byName).toContain('测试(SIT)');
    expect(byName).toContain('rwk-person is-unassigned');
  });

  it('筛不出东西时给的是"换个条件"而不是"没有任务"，并给一键重置', () => {
    const html = renderWorkView(null, filterCtx({ ...defaultWorkFilter(), pris: ['P3'] }));
    expect(html).toContain('没有符合筛选条件的任务');
    expect(html).toContain('rwk-f-reset-lg');
    expect(html).not.toContain('还没有任何任务');
  });

  it('筛选段全部由 data-wk-* 驱动（事件走委托，重绘后不必重绑）', () => {
    const html = renderWorkView(null, filterCtx({ ...defaultWorkFilter(), states: ['overdue'], pris: ['P0'] }));
    expect(html).toMatch(/class="rwk-f-chip on" data-wk-state="overdue"/);
    expect(html).toMatch(/class="rwk-f-chip on" data-wk-pri="P0"/);
    expect(html).toMatch(/class="rwk-f-chip" data-wk-state="doing"/);
    expect(html).not.toMatch(/data-wk-reset disabled/);   // 有筛选时可点
  });

  it('重绘后输入框不会被清空（关键词回填进 value，否则打字会被自己的重绘吃掉）', () => {
    const html = renderWorkView(null, filterCtx({ ...defaultWorkFilter(), q: '官网' }));
    expect(html).toContain('value="官网"');
  });
});

describe('资源工作视图：接入契约', () => {
  it('renderAll 按 data-view="work" 分发到本页（整页文档形态）', () => {
    const ctx = makeCtx();
    const gantt = { innerHTML: '', style: {}, classList: { add() {}, remove() {} } };
    const gsc = { scrollLeft: 0, scrollTop: 0 };
    renderAll({
      ...ctx,
      view: 'work',
      gantt,
      gsc,
      getEl: () => null,
      collapsed: {},
      sched: { ...ctx.sched, detectProblems: () => [], tasksById: () => ({}) }
    });
    expect(gantt.innerHTML).toContain('资源工作视图');
    expect(gantt.innerHTML).toContain('rwk-people');
  });

  it('桌面视图组与手机底栏都有入口（否则用户找不到这一页）', () => {
    const shell = buildShellHTML();
    expect(shell).toContain('data-view="work"');
    expect(shell).toMatch(/<button class="mnav-item" data-view="work">/);
    // 导出的单文件查看器是另一套壳，同样要能切到这一页
    expect(buildViewerShellHTML()).toContain('data-view="work"');
  });

  it('非时间轴视图：手机上收敛顶栏操作，且缩放/滚轮不劫持', () => {
    expect(toolbarSrc).toMatch(/classList\.toggle\('work-view', v === 'work'\)/);
    expect(css).toMatch(/body\.work-view \[data-report-hide\]\{display:none\}/);
    expect(css).toMatch(/body\.work-view \.msheet-item\[data-zoom-only\]\{display:none\}/);
  });

  it('筛选条在两个入口都绑上（导出单文件没有组件层，必须自己调一次）', () => {
    expect(componentsSrc).toContain("import { bindWorkFilter } from './work-filter.js';");
    expect(componentsSrc).toContain('bindWorkFilter(deps)');
    expect(standaloneSrc).toContain("import { bindWorkFilter } from './components/work-filter.js';");
    expect(standaloneSrc).toMatch(/bindWorkFilter\(\{ gantt:/);
    // ?me=某人 深链：没有账号↔资源人名的映射，只能靠 URL 参数表达"我是谁"
    expect(ganttSrc).toContain('person: meFromQuery');
    expect(standaloneSrc).toContain("person: (params.get('me') || '').trim()");
    // 筛选条件必须经 ctx 传给视图层（放 viewState，切视图来回不丢）
    expect(ganttSrc).toContain('workFilter: viewState.workFilter');
    expect(standaloneSrc).toContain('workFilter: viewState.workFilter');
  });

  it('筛选条样式：基础规则与窄屏覆盖都要排在手机主断点之前', () => {
    const tools = css.indexOf('.rwk-tools{display:flex');
    const phone = css.indexOf('.rwk-tools{gap:6px}');
    expect(tools).toBeGreaterThan(-1);
    expect(phone).toBeGreaterThan(tools);
    expect(phone).toBeLessThan(mainPhoneStart);
    // 窄屏：搜索框独占一行（挤在一行会拖出横向滚动）
    expect(css).toMatch(/@media \(max-width:767px\)\{[\s\S]*?\.rwk-f-q\{flex:1 1 100%/);
    // 选中态用品牌色（跟随主题），状态色仍是数据色（不随换肤）
    expect(css).toMatch(/\.rwk-f-chip\.on\{background:var\(--accent-soft\)/);
  });

  it('样式契约：名字换行不省略、桌面六列 / 窄屏折两行、基础规则排在手机主断点之前', () => {
    // 名字必须看得全（这一页就是用来核对谁在做什么的）
    expect(css).toMatch(/\.rwk-main\{[^}]*flex-wrap:wrap/);
    expect(css).toMatch(/\.rwk-name\{[^}]*overflow-wrap:anywhere/);
    expect(css).toMatch(/\.rwk-row\{[^}]*grid-template-columns:3px minmax\(0,1fr\) auto auto auto auto/);
    // 窄屏把日期与进度挪到第二行，避免横向平移
    expect(css).toMatch(/@media \(max-width:767px\)\{[\s\S]*?\.rwk-row\{grid-template-columns:3px minmax\(0,1fr\) auto auto;grid-template-areas:"steel main pri state" "steel dates dates prog"/);
    // 顺序不变量：基础规则 → 窄屏覆盖 → 手机主断点。
    // 反了的话同优先级的桌面声明会在文件顺序上压过窄屏声明（手机端变回桌面版式），
    // 且 mobile-layout.test.js 的 phoneCss 取"最后一个 ≤767px 块"，会被这条覆盖块顶掉
    const base = css.indexOf('.rwk-people{');
    const override = css.indexOf('.rwk-row{grid-template-columns:3px minmax(0,1fr) auto auto;');
    expect(base).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(-1);
    expect(base).toBeLessThan(override);
    expect(override).toBeLessThan(mainPhoneStart);
  });
});

// 版本（迭代）测试
//
// 覆盖三块最容易出事的地方：
//   1) 排期联动：加入版本 → 需求的「上线」里程碑被钉住（manual=true，自动计划改不动）；
//      改版本日 → 批量回写；移出/删版本 → 解锁并回落到依赖算出的日期
//   2) 成员名单的一致性：改名 / 删需求 时版本名单必须同步（否则成员"凭空消失"且无报错）
//   3) 序列化白名单：撤销 / 导入导出 必须带上 versions
//      —— 本项目状态序列化到处是白名单，漏一处就会"撤销后版本没了、需求上线日却回滚了"
import { describe, it, expect, beforeEach } from 'vitest';
import { planStore } from '../src/store/plan-store.js';
import { userStore } from '../src/store/user-store.js';
import { defaultModules, defaultResources } from '../src/core/default-data.js';
import { createWorkday } from '../src/core/workday.js';
import { createScheduler } from '../src/scheduler/index.js';
import { createPersistence } from '../src/scheduler/persistence.js';
import {
  versionOfMap, versionProgress, versionStatus, sortVersions, isGoMs, findGoMs
} from '../src/core/versions.js';

// node 环境无全局 localStorage（save 内部 try/catch 也兜底，这里显式提供）
if (typeof globalThis.localStorage === 'undefined') {
  const m = new Map();
  globalThis.localStorage = {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); }
  };
}

function makeSched() {
  planStore.set({ modules: defaultModules(), resources: defaultResources(), versions: [] });
  return createScheduler({ planStore, userStore, W: createWorkday({}) });
}

const mods = () => planStore.state.modules;
const versions = () => planStore.state.versions;
const findMod = name => mods().find(m => m.name === name);
// 上线里程碑：默认/历史数据里那条**没有 p 字段**（形如 { m:'2026-09-09', label:'9/9 上线' }），
// 故识别口径与实现保持一致：p === 'go' 或 label 含「上线」
const goMs = name => (findMod(name).bars || [])
  .find(b => b.m && (b.p === 'go' || /上线/.test(String(b.label || ''))));

describe('版本：加入 / 改期 / 移出 / 删除的排期联动', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('加入版本：成员需求的「上线」里程碑被钉到版本日并转为手动锁定', () => {
    const sched = makeSched();
    const msCountBefore = findMod('官网改版').bars.filter(b => b.m).length;
    sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版', '数据看板'] });

    for (const name of ['官网改版', '数据看板']) {
      const ms = goMs(name);
      expect(ms.m).toBe('2026-10-29');
      expect(ms.manual).toBe(true);   // 钉住：一键自动计划不再改动它
    }
    expect(versions()[0].mods).toEqual(['官网改版', '数据看板']);
    // 钉的必须是"原来那个"上线里程碑：默认数据的里程碑没有 p 字段，
    // 识别口径一旦只看 p === 'go' 就会补建一个新的（图上多出一个菱形）
    expect(findMod('官网改版').bars.filter(b => b.m).length).toBe(msCountBefore);
  });

  it('自动计划不会把版本上线日冲掉（钉住的正是这个语义）', () => {
    const sched = makeSched();
    sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版'] });
    sched.computeSchedule();               // 全量重排所有自动任务
    expect(goMs('官网改版').m).toBe('2026-10-29');
  });

  it('改版本日：所有成员的上线日跟着改', () => {
    const sched = makeSched();
    const v = sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版', '数据看板'] }).version;
    sched.updateVersion(v.id, { date: '2026-11-05' });
    expect(goMs('官网改版').m).toBe('2026-11-05');
    expect(goMs('数据看板').m).toBe('2026-11-05');
  });

  it('移出成员：解锁并回落到依赖算出的日期（不再卡在版本日）', () => {
    const sched = makeSched();
    const v = sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版', '数据看板'] }).version;
    sched.removeModFromVersion(v.id, '数据看板');

    expect(versions()[0].mods).toEqual(['官网改版']);
    const ms = goMs('数据看板');
    expect(ms.manual).toBe(false);
    // 数据看板末阶段 UAT 结束 10/14 → 自动上线日回到依赖允许的最早工作日
    expect(ms.m).toBe('2026-10-15');
    expect(goMs('官网改版').m).toBe('2026-10-29');   // 仍在版本里的不受影响
  });

  it('删除版本：成员全部解锁，版本本身移除', () => {
    const sched = makeSched();
    const v = sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版'] }).version;
    sched.deleteVersion(v.id);
    expect(versions().length).toBe(0);
    expect(goMs('官网改版').manual).toBe(false);
    expect(goMs('官网改版').m).toBe('2026-09-09');   // 默认数据里原本的自动上线日
  });

  it('一条需求只能属于一个版本：已在别的版本 → 拒绝加入并说明原因', () => {
    const sched = makeSched();
    sched.createVersion({ name: 'V1', date: '2026-10-01', mods: ['官网改版'] });
    const r = sched.createVersion({ name: 'V2', date: '2026-11-01', mods: ['官网改版', '数据看板'] });

    expect(r.rejected.map(x => x.name)).toEqual(['官网改版']);
    expect(r.rejected[0].reason).toContain('V1');
    expect(versions()[1].mods).toEqual(['数据看板']);
    expect(goMs('官网改版').m).toBe('2026-10-01');   // 归属没被 V2 抢走
  });

  it('已归档需求不允许加入版本（归档=收口，与"待上线"语义冲突）', () => {
    const sched = makeSched();
    sched.archiveModule('数据看板', true);
    const r = sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['数据看板'] });
    expect(r.rejected[0].reason).toContain('已归档');
    expect(versions()[0].mods).toEqual([]);
  });

  it('需求没有「上线」里程碑时自动补建一个（依赖挂到最后一个普通任务）', () => {
    const sched = makeSched();
    sched.addModule({ name: '新需求', autoCreate: false });
    sched.addTask({ mod: '新需求', p: 'dev', start: '2026-09-01', dur: 3 });

    const r = sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['新需求'] });
    expect(r.rejected).toEqual([]);
    const ms = goMs('新需求');
    expect(ms).toBeTruthy();
    expect(ms.m).toBe('2026-10-29');
    expect(ms.manual).toBe(true);
    expect(ms.dep.length).toBe(1);   // 解锁后还能由依赖算出合理日期，不留孤儿里程碑
  });

  it('待排期需求加入版本：先只登记，改为「已排期」后才钉上线日', () => {
    const sched = makeSched();
    sched.addModule({ name: '待排期需求', autoCreate: false, unscheduled: true });
    const r = sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['待排期需求'] });

    expect(r.rejected).toEqual([]);
    expect(versions()[0].mods).toEqual(['待排期需求']);
    expect(goMs('待排期需求')).toBeFalsy();          // 日期还不可信，不钉

    sched.updateModule({ name: '待排期需求', unscheduled: false });
    expect(goMs('待排期需求').m).toBe('2026-10-29'); // 排期后补钉
  });

  it('标记上线 / 取消上线：记录实际上线日，可反复切换', () => {
    const sched = makeSched();
    const v = sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版'] }).version;

    sched.shipVersion(v.id, true, '2026-11-02');
    expect(versions()[0].shipped).toBe(true);
    expect(versions()[0].shippedAt).toBe('2026-11-02');

    sched.updateVersion(v.id, { shippedAt: '2026-11-03' });   // 编辑弹窗里改实际上线日
    expect(versions()[0].shippedAt).toBe('2026-11-03');

    sched.shipVersion(v.id, false);
    expect(versions()[0].shipped).toBe(false);
    expect(versions()[0].shippedAt).toBe(null);
  });

  it('标记上线不会自动归档成员（归档要靠显式的那一下）', () => {
    const sched = makeSched();
    const v = sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版', '数据看板'] }).version;
    sched.shipVersion(v.id, true);
    expect(findMod('官网改版').archived).toBeFalsy();

    const n = sched.archiveVersionMods(v.id);
    expect(n).toBe(2);
    expect(findMod('官网改版').archived).toBe(true);
  });

  it('成员一致性：需求改名 / 删除时版本名单同步（否则成员凭空消失）', () => {
    const sched = makeSched();
    sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版', '数据看板'] });

    sched.updateModule({ oldName: '数据看板', name: '数据看板2' });
    expect(versions()[0].mods).toContain('数据看板2');

    sched.deleteModule('官网改版');
    expect(versions()[0].mods).toEqual(['数据看板2']);
  });

  it('新建版本：名称必填且唯一、上线日必填', () => {
    const sched = makeSched();
    expect(() => sched.createVersion({ name: '', date: '2026-10-01' })).toThrow('版本名称不能为空');
    expect(() => sched.createVersion({ name: 'V1', date: '' })).toThrow('请选择上线日');
    sched.createVersion({ name: 'V1', date: '2026-10-01' });
    expect(() => sched.createVersion({ name: 'V1', date: '2026-11-01' })).toThrow('版本已存在');
  });

  it('只读模式：所有写入口静默失效 / 新增抛错', () => {
    const sched = makeSched();
    const v = sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版'] }).version;
    userStore.set({ readonly: true });

    expect(() => sched.createVersion({ name: 'V2', date: '2026-11-01' })).toThrow();
    sched.updateVersion(v.id, { date: '2026-12-01' });
    sched.shipVersion(v.id, true);
    sched.deleteVersion(v.id);

    expect(versions().length).toBe(1);
    expect(versions()[0].date).toBe('2026-10-29');
    expect(versions()[0].shipped).toBe(false);
  });
});

// 需求台账「所属版本」的行内下拉：一次改归属。
// 原先只能进版本弹窗"先取消勾选、再去另一个版本勾选"——两步，且中间态是"无版本"。
describe('版本：台账行内直接改归属（setModuleVersion）', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('从 V1 改到 V2：两个版本的名单同时更新，上线日跟新版本走', () => {
    const sched = makeSched();
    const v1 = sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版', '数据看板'] }).version;
    const v2 = sched.createVersion({ name: 'V2', date: '2026-11-30' }).version;

    const r = sched.setModuleVersion('官网改版', v2.id);
    expect(r.changed).toBe(true);
    expect(r.from.id).toBe(v1.id);
    expect(r.to.id).toBe(v2.id);
    expect(versions()[0].mods).toEqual(['数据看板']);   // 原版本自动移出，不必手动取消勾选
    expect(versions()[1].mods).toEqual(['官网改版']);
    expect(goMs('官网改版').m).toBe('2026-11-30');      // 钉到新版本的上线日
    expect(goMs('官网改版').manual).toBe(true);
    expect(goMs('数据看板').m).toBe('2026-10-29');      // 同版本的另一条不受影响
  });

  it('改成「未加入版本」：解锁并回落到依赖算出的日期', () => {
    const sched = makeSched();
    sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版'] });

    const r = sched.setModuleVersion('官网改版', null);
    expect(r.changed).toBe(true);
    expect(r.to).toBe(null);
    expect(versions()[0].mods).toEqual([]);
    expect(goMs('官网改版').manual).toBe(false);
    expect(goMs('官网改版').m).toBe('2026-09-09');   // 默认数据里原本的自动上线日
  });

  it('选到当前已属的版本 / 本来就无版本：算无变化，不动数据', () => {
    const sched = makeSched();
    const v = sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版'] }).version;
    expect(sched.setModuleVersion('官网改版', v.id).changed).toBe(false);
    expect(sched.setModuleVersion('数据看板', null).changed).toBe(false);
    expect(versions()[0].mods).toEqual(['官网改版']);
  });

  it('已归档需求不能改入版本：抛错说明原因（下拉靠它回滚）', () => {
    const sched = makeSched();
    const v = sched.createVersion({ name: 'V1', date: '2026-10-29' }).version;
    sched.archiveModule('数据看板', true);
    expect(() => sched.setModuleVersion('数据看板', v.id)).toThrow('已归档');
    expect(versions()[0].mods).toEqual([]);
  });

  it('待排期需求改入版本：先只登记成员，改为「已排期」后才钉上线日', () => {
    const sched = makeSched();
    sched.addModule({ name: '待排期需求', autoCreate: false, unscheduled: true });
    const v = sched.createVersion({ name: 'V1', date: '2026-10-29' }).version;

    sched.setModuleVersion('待排期需求', v.id);
    expect(versions()[0].mods).toEqual(['待排期需求']);
    expect(goMs('待排期需求')).toBeFalsy();           // 日期还不可信，不钉

    sched.updateModule({ name: '待排期需求', unscheduled: false });
    expect(goMs('待排期需求').m).toBe('2026-10-29');
  });

  it('只读模式：静默失效，两边名单都不动', () => {
    const sched = makeSched();
    sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版'] });
    const v2 = sched.createVersion({ name: 'V2', date: '2026-11-30' }).version;
    userStore.set({ readonly: true });

    expect(sched.setModuleVersion('官网改版', v2.id)).toBe(null);
    expect(versions()[0].mods).toEqual(['官网改版']);
    expect(versions()[1].mods).toEqual([]);
  });
});

describe('版本：序列化白名单（漏一处就静默丢数据）', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('撤销/重做会把版本与成员上线日一起回滚（history 快照必须含 versions）', () => {
    const sched = makeSched();
    sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版'] });
    expect(versions().length).toBe(1);
    expect(goMs('官网改版').m).toBe('2026-10-29');

    sched.undo();
    // 关键：版本没了、上线日也必须回滚，不能只回滚一半
    expect(versions().length).toBe(0);
    expect(goMs('官网改版').m).toBe('2026-09-09');

    sched.redo();
    expect(versions().length).toBe(1);
    expect(goMs('官网改版').m).toBe('2026-10-29');
  });

  it('导出 JSON / 导入 JSON 往返保留版本', () => {
    const sched = makeSched();
    sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版'] });
    const json = sched.exportJSON();
    expect(JSON.parse(json).versions[0].name).toBe('V1');

    planStore.set({ versions: [] });
    sched.importJSON(json);
    expect(planStore.state.versions.length).toBe(1);
    expect(planStore.state.versions[0].mods).toEqual(['官网改版']);
  });

  it('导入一份没有 versions 的老数据文件 → 版本清空（导入是整份替换语义）', () => {
    const sched = makeSched();
    sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版'] });
    const clean = JSON.parse(sched.exportJSON());
    delete clean.versions;
    sched.importJSON(clean);
    expect(planStore.state.versions).toEqual([]);
  });

  it('同步/本地载荷（buildPayload）带上 versions', () => {
    // persistence 是白名单式的：这里直接对着载荷断言，防止将来有人漏加字段
    const ctx = {
      getState: () => planStore.state,
      setState: patch => planStore.set(patch),
      KEY: () => 'test-key',
      CALC_VER: 5,
      recordInitial: () => {},
      pushToServer: () => Promise.resolve(false),
      assertEditable: () => true
    };
    const p = createPersistence(ctx);
    planStore.set({ versions: [{ id: 'v1', name: 'V1', date: '2026-10-29', shipped: false, shippedAt: null, mods: [] }] });
    expect(p.buildPayload().versions.length).toBe(1);
  });
});

describe('版本：状态 / 完成度', () => {
  const state = () => planStore.state;

  beforeEach(() => {
    planStore.reset();
    userStore.reset();
    planStore.set({ modules: defaultModules(), resources: defaultResources(), versions: [] });
  });

  it('versionOfMap 反查：需求名 → 所属版本（重复归属以先出现的为准）', () => {
    const map = versionOfMap([
      { id: 'a', name: 'V1', mods: ['官网改版'] },
      { id: 'b', name: 'V2', mods: ['官网改版', '数据看板'] }
    ]);
    expect(map['官网改版'].name).toBe('V1');
    expect(map['数据看板'].name).toBe('V2');
  });

  it('版本完成度 = 成员需求人日加权（与需求卡片同口径）', () => {
    const workday = createWorkday({});
    const v = { id: 'v1', name: 'V1', date: '2026-10-29', mods: ['官网改版'], shipped: false, shippedAt: null };
    const st = versionProgress(v, state(), workday);
    // 官网改版 6 个普通任务：前 3 个 100%、后 3 个未填完成度（默认 0）
    expect(st.work).toBeGreaterThan(0);
    expect(st.pct).toBeGreaterThan(0);
    expect(st.pct).toBeLessThan(100);
  });

  it('版本状态：已上线 > 待上线 > 已逾期 > 进行中 > 未开始', () => {
    const today = new Date(2026, 8, 21);   // 2026-09-21
    const task = (s, e, done) => ({ id: s + done, p: 'dev', s, e, done, res: ['张三'] });
    const doneMods = [{ name: 'A', bars: [task('2026-09-01', '2026-09-05', 100)] }];
    const doingMods = [{ name: 'B', bars: [task('2026-09-15', '2026-09-25', 40)] }];
    const futureMods = [{ name: 'C', bars: [task('2026-10-01', '2026-10-10', 0)] }];
    const keyOf = (date, mods, shipped) => versionStatus(
      { id: 'v', name: 'V', date, shipped: !!shipped, shippedAt: null, mods: mods.map(m => m.name) },
      { modules: mods },
      today
    ).key;

    expect(keyOf('2026-09-01', doneMods, true)).toBe('shipped');
    expect(keyOf('2026-09-01', doneMods)).toBe('ready');     // 全部做完但还没标记上线
    expect(keyOf('2026-09-01', doingMods)).toBe('overdue');  // 过了上线日仍有未完成
    expect(keyOf('2026-10-30', doingMods)).toBe('doing');    // 未到期且已开工
    expect(keyOf('2026-10-30', futureMods)).toBe('todo');    // 未到期且都还没开工
  });

  it('版本排序按上线日倒序（最新的排最前），缺日期的排最后', () => {
    const list = sortVersions([
      { id: 'a', name: 'V1', date: '2026-10-01' },
      { id: 'b', name: 'V2', date: '2026-12-01' },
      { id: 'c', name: 'V3', date: '2026-11-01' },
      { id: 'd', name: '无日期' }
    ]);
    expect(list.map(v => v.name)).toEqual(['V2', 'V3', 'V1', '无日期']);
  });
});

describe('版本页面：渲染契约', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  it('renderVersionView 输出版本卡与成员行（成员默认收起，展开后出成员）', async () => {
    const { renderVersionView, toggleVersionExpanded } = await import('../src/views/version-view.js');
    const { buildViewCtx } = await import('../src/views/index.js');
    const sched = makeSched();
    const v = sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版'] }).version;

    const ctx = buildViewCtx({
      state: planStore.state,
      sched,
      today: new Date(2026, 8, 21),
      workday: createWorkday({}),
      holidays: []
    });
    // 默认收起：只出头行（版本多时不会一屏铺开）
    const collapsed = renderVersionView({}, ctx);
    expect(collapsed).toContain('ver-card');
    expect(collapsed).toContain('V1');
    expect(collapsed).not.toContain('官网改版');

    toggleVersionExpanded(v.id);
    const html = renderVersionView({}, ctx);
    expect(html).toContain('官网改版');
    // 成员行的"×"带版本 id 与需求名，供组件层委托使用
    expect(html).toMatch(/data-ver-remove="[^"]+" data-mod="官网改版"/);
    // 卡头整行可点开（三角仍是显式入口）
    expect(html).toMatch(/<div class="ver-hd" data-ver-toggle="/);
  });

  it('成员行的「改版本」下拉：有别的版本才给，且只列版本（移出交给 ×）', async () => {
    const { renderVersionView, toggleVersionExpanded } = await import('../src/views/version-view.js');
    const { buildViewCtx } = await import('../src/views/index.js');
    const sched = makeSched();
    const v1 = sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版'] }).version;
    const view = () => renderVersionView({}, buildViewCtx({
      state: planStore.state, sched, today: new Date(2026, 8, 21), workday: createWorkday({}), holidays: []
    }));

    toggleVersionExpanded(v1.id);
    // 只有一个版本时不给下拉：唯一选项就是它自己
    expect(view()).not.toContain('data-ver-move');

    const v2 = sched.createVersion({ name: 'V2', date: '2026-11-30' }).version;
    const html = view();
    toggleVersionExpanded(v1.id);   // 复位，别把展开态留给后面的用例
    expect(html).toMatch(new RegExp(`data-ver-move="${v1.id}" data-mod="官网改版"`));
    expect(html).toContain(`<option value="${v1.id}" selected>V1（10/29）</option>`);
    expect(html).toContain(`<option value="${v2.id}">V2（11/30）</option>`);
  });

  // Task 12：删除版本 / 一键归档是"全权动作"，协作者看不到；其余版本操作保持放开
  it('协作者看不到「删除版本」「归档本版本全部需求」，但能「加需求 / 编辑 / 标记上线」', async () => {
    const { renderVersionView, toggleVersionExpanded } = await import('../src/views/version-view.js');
    const { buildViewCtx } = await import('../src/views/index.js');
    const sched = makeSched();
    const v = sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版'] }).version;
    sched.shipVersion(v.id, true);   // 归档按钮只在已上线版本上出现
    toggleVersionExpanded(v.id);
    const view = () => renderVersionView({}, buildViewCtx({
      state: planStore.state, sched, today: new Date(2026, 8, 21), workday: createWorkday({}), holidays: []
    }));

    userStore.set({ readonly: false, access: 'collab', resourceName: '张三', role: 'user' });
    const collab = view();
    expect(collab).not.toContain('data-ver-del');
    expect(collab).not.toContain('data-ver-archive');
    // 其余版本操作对协作者放开
    expect(collab).toContain(`data-ver-add="${v.id}"`);
    expect(collab).toContain(`data-ver-edit="${v.id}"`);
    expect(collab).toContain(`data-ver-unship="${v.id}"`);

    userStore.set({ readonly: false, access: 'full', resourceName: '张三', role: 'admin' });
    const full = view();
    toggleVersionExpanded(v.id);   // 复位，别把展开态留给后面的用例
    expect(full).toContain(`data-ver-del="${v.id}"`);
    expect(full).toContain(`data-ver-archive="${v.id}"`);
  });

  it('没有版本时渲染空态与「新建版本」按钮', async () => {
    const { renderVersionView } = await import('../src/views/version-view.js');
    const { buildViewCtx } = await import('../src/views/index.js');
    const sched = makeSched();
    const ctx = buildViewCtx({
      state: planStore.state,
      sched,
      today: new Date(2026, 8, 21),
      workday: createWorkday({}),
      holidays: []
    });
    const html = renderVersionView({}, ctx);
    expect(html).toContain('ver-empty');
    expect(html).toContain('data-ver-new');
  });

  it('需求台账「所属版本」列是可换版本的下拉（不再是纯展示）', async () => {
    const { renderReqView, toggleReqExpanded } = await import('../src/views/req-view.js');
    const { buildViewCtx } = await import('../src/views/index.js');
    const sched = makeSched();
    const v = sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版'] }).version;

    const ctx = buildViewCtx({
      state: planStore.state,
      sched,
      today: new Date(2026, 8, 21),
      workday: createWorkday({}),
      holidays: []
    });
    const html = renderReqView({}, ctx);
    // data-prev = 当前归属的版本 id：组件层靠它与选中值比对，相同就不写数据
    expect(html).toContain(`data-req-inline="version" data-name="官网改版" data-prev="${v.id}"`);
    expect(html).toContain('<option value="">未加入版本</option>');
    expect(html).toContain(`<option value="${v.id}" selected>V1（10/29）</option>`);

    // 展开档案里的「所属版本」同样能换（那里是细读这一栏的地方，两份都要能用）
    toggleReqExpanded('官网改版');
    const expanded = renderReqView({}, ctx);
    toggleReqExpanded('官网改版');   // 复位，别把展开态留给后面的用例
    expect(expanded).toContain('<i>所属版本</i>');
    expect((expanded.match(/data-req-inline="version"/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('需求卡片与甘特需求行带版本徽标（新增需求不加、不加进版本就没有）', async () => {
    const { renderModCard } = await import('../src/views/mod-card.js');
    const { buildViewCtx } = await import('../src/views/index.js');
    const sched = makeSched();
    sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版'] });

    const ctx = buildViewCtx({
      state: planStore.state,
      sched,
      today: new Date(2026, 8, 21),
      workday: createWorkday({}),
      holidays: []
    });
    expect(renderModCard(findMod('官网改版'), ctx)).toContain('ver-badge');
    expect(renderModCard(findMod('数据看板'), ctx)).not.toContain('ver-badge');
  });

  it('甘特需求行的次要信息区也带版本徽标（与卡片同一份 versionBadge）', async () => {
    const { renderModView } = await import('../src/views/mod-view.js');
    const { buildViewCtx } = await import('../src/views/index.js');
    const sched = makeSched();
    sched.createVersion({ name: 'V1', date: '2026-10-29', mods: ['官网改版'] });

    const ctx = buildViewCtx({
      state: planStore.state,
      sched,
      today: new Date(2026, 8, 21),
      workday: createWorkday({}),
      holidays: [],
      collapsed: {},
      modColors: {},
      conflictSet: new Set()
    });
    const html = renderModView({}, ctx, new Set());
    expect(html).toContain('ver-badge');
  });
});

describe('版本：界面接入契约（新增视图要同步的注册点）', () => {
  it('主壳注册了版本入口与版本弹窗；查看器壳只注册入口', async () => {
    const { buildShellHTML, buildViewerShellHTML } = await import('../src/components/shell.js');
    const main = buildShellHTML();
    expect(main).toContain('data-view="version"');
    expect(main).toMatch(/class="mnav-item" data-view="version"/);   // 手机底部导航
    expect(main).toMatch(/id="verModal"/);
    expect(main).toMatch(/id="verPicker"/);
    expect(main).toMatch(/id="inpVerName"/);
    expect(main).toMatch(/id="inpVerDate"/);
    expect(main).toMatch(/id="verActualRow"/);
    expect(main).toMatch(/id="btnSaveVer"/);

    const viewer = buildViewerShellHTML();
    expect(viewer).toContain('data-view="version"');
    expect(viewer).not.toContain('verModal');   // 只读查看器不带编辑弹窗
  });

  it('主壳与查看器都把 version 列进 ?view= 白名单（否则深链打不开）', async () => {
    const fs = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const read = p => fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
    expect(read('../src/main-gantt.js')).toMatch(/'work', 'version'\]/);
    expect(read('../src/main-standalone.js')).toMatch(/'work', 'version'\]/);
    // 查看器要能渲染版本页成员：数据里有 versions 才谈得上
    expect(read('../src/main-standalone.js')).toMatch(/versions: Array\.isArray\(injected\.versions\)/);
    expect(read('../src/main-standalone.js')).toMatch(/bindVersionPage\(/);
  });

  it('renderAll 把 version 当整页文档视图分发', async () => {
    const fs = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = fs.readFileSync(fileURLToPath(new URL('../src/views/index.js', import.meta.url)), 'utf8');
    expect(src).toMatch(/view === 'req' \|\| view === 'work' \|\| view === 'version'/);
    expect(src).toMatch(/renderVersionView\(gantt, full\)/);
  });
});

describe('versions: 上线里程碑识别（isGoMs / findGoMs）', () => {
  it('p === go 的里程碑算上线', () => {
    expect(isGoMs({ m: '2026-09-09', p: 'go' })).toBe(true);
  });

  it('没有 p 字段但 label 含「上线」也算（默认/历史数据的形状）', () => {
    expect(isGoMs({ m: '2026-09-09', label: '9/9 上线' })).toBe(true);
    expect(isGoMs({ m: '2026-11-13', label: '整体上线' })).toBe(true);
  });

  it('非里程碑、或无上线语义的里程碑都不算', () => {
    expect(isGoMs({ s: '2026-09-01', e: '2026-09-05', p: 'go' })).toBe(false);  // 没有 m，不是里程碑
    expect(isGoMs({ m: '2026-09-09', p: 'sit', label: '提测' })).toBe(false);
    expect(isGoMs(null)).toBe(false);
  });

  it('findGoMs 取最后一个上线里程碑', () => {
    const mo = { name: 'A', bars: [
      { id: 'x', m: '2026-09-09', label: '9/9 上线' },
      { id: 'y', m: '2026-11-13', p: 'go', label: '上线' }
    ] };
    expect(findGoMs(mo).id).toBe('y');
  });

  it('找不到时返回 null', () => {
    expect(findGoMs({ name: 'A', bars: [{ id: 'x', m: '2026-09-09', p: 'sit', label: '提测' }] })).toBe(null);
    expect(findGoMs({ name: 'A' })).toBe(null);
    expect(findGoMs(null)).toBe(null);
  });
});

// 版本页成员行「改版本」下拉的委托行为。
// 与 tests/req-page.test.js 同一套路：捕获 change 处理器，用假 event.target 直接驱动 ——
// 只断言"动了下拉 → 调了什么、界面怎么回滚"，不需要真 DOM。
describe('版本页面：成员行改版本的委托', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  // els：弹窗控件的桩（modal 相关用例才需要）；不传时 getEl 一律 null
  function makeEnv(sched, els) {
    const calls = [];
    const handlers = {};
    const deps = {
      doc: {},
      getEl: id => (els && els[id]) || null,
      gantt: { addEventListener: (type, fn) => { handlers[type] = fn; } },
      planStore,
      sched: sched || {
        setModuleVersion: (name, id) => { calls.push(['move', name, id]); return { to: { id, name: 'V2' } }; }
      },
      toast: m => calls.push(['toast', m]),
      today: () => new Date(2026, 8, 21),
      render: () => calls.push(['render'])
    };
    return import('../src/components/version-page.js').then(({ bindVersionPage }) => {
      bindVersionPage(deps);
      return { calls, change: e => handlers.change(e), click: e => handlers.click(e) };
    });
  }

  // 造 n 个版本：V1（1 月上线）… Vn（n 月上线）。
  // 上线日倒序 → Vn 最前，故每页 6 个时第 2 页是"最旧的那几个"，方便断言翻页
  function seedVersions(sched, n) {
    const out = {};
    for (let i = n; i >= 1; i--) {
      out[i] = sched.createVersion({ name: 'V' + i, date: `2026-${String(i).padStart(2, '0')}-10` }).version;
    }
    return out;
  }

  // 假元素保持同一引用：失败 / 只读时要断言它被回滚成原值
  function moveEvent(dataset, value) {
    const el = { dataset, value };
    return { el, evt: { target: { closest: sel => (sel === '[data-ver-move]' ? el : null) } } };
  }

  it('选到另一个版本：调 setModuleVersion + 重绘 + 提示，并把目标卡展开', async () => {
    const { isVersionExpanded, toggleVersionExpanded } = await import('../src/views/version-view.js');
    const env = await makeEnv();
    env.change(moveEvent({ verMove: 'ver_1', mod: '官网改版' }, 'ver_2').evt);

    expect(env.calls).toContainEqual(['move', '官网改版', 'ver_2']);
    expect(env.calls).toContainEqual(['render']);
    expect(env.calls).toContainEqual(['toast', '已把「官网改版」调整到「V2」']);
    // 不展开目标卡的话，改完那一行会从当前卡里消失，界面上等于"点完没反应"
    expect(isVersionExpanded('ver_2')).toBe(true);
    toggleVersionExpanded('ver_2');   // 复位，别把展开态留给后面的用例
  });

  it('选回当前版本 / 空值：不写数据也不重绘', async () => {
    const env = await makeEnv();
    env.change(moveEvent({ verMove: 'ver_1', mod: '官网改版' }, 'ver_1').evt);
    env.change(moveEvent({ verMove: 'ver_1', mod: '官网改版' }, '').evt);
    expect(env.calls.some(c => c[0] === 'move' || c[0] === 'render')).toBe(false);
  });

  it('只读：不改数据，并把下拉回滚到原版本', async () => {
    userStore.set({ readonly: true });
    const env = await makeEnv();
    const { el, evt } = moveEvent({ verMove: 'ver_1', mod: '官网改版' }, 'ver_2');
    env.change(evt);
    expect(el.value).toBe('ver_1');
    expect(env.calls.some(c => c[0] === 'move')).toBe(false);
  });

  it('失败（如已归档需求）：回滚下拉并报错，不停在"已改好"的样子', async () => {
    const env = await makeEnv({
      setModuleVersion: () => { throw new Error('已归档需求不能加入版本，请先取消归档'); }
    });
    const { el, evt } = moveEvent({ verMove: 'ver_1', mod: '官网改版' }, 'ver_2');
    env.change(evt);
    expect(el.value).toBe('ver_1');
    expect(env.calls).toContainEqual(['toast', '已归档需求不能加入版本，请先取消归档']);
    expect(env.calls.some(c => c[0] === 'render')).toBe(false);
  });

  it('改版本后翻到目标版本所在的那一页（分页后不翻页就等于"需求不见了"）', async () => {
    const { setVersionPage, getVersionPage, versionPageOf } = await import('../src/views/version-view.js');
    const sched = makeSched();
    const v = seedVersions(sched, 8);
    setVersionPage(1);   // 从 V8 挪到 V1：V1 在最后一页

    const env = await makeEnv();
    env.change(moveEvent({ verMove: v[8].id, mod: '官网改版' }, v[1].id).evt);

    expect(getVersionPage()).toBe(versionPageOf(planStore.state, v[1].id));
    expect(getVersionPage()).toBe(2);
    setVersionPage(1);   // 复位，别把页码留给后面的用例
  });
});

// 版本页列表的分页：每页 6 个，一页装得下就不渲染分页条。
// 「新建完看不见自己刚建的版本」是分页最容易踩的坑，故这里连翻页行为一起盯住。
describe('版本页面：列表分页', () => {
  beforeEach(() => { planStore.reset(); userStore.reset(); });

  function makeView() {
    return import('../src/views/version-view.js').then(async (mod) => {
      const { buildViewCtx } = await import('../src/views/index.js');
      const sched = createScheduler({ planStore, userStore, W: createWorkday({}) });
      return {
        ...mod,
        sched,
        view: () => mod.renderVersionView({}, buildViewCtx({
          state: planStore.state, sched,
          today: new Date(2026, 8, 21), workday: createWorkday({}), holidays: []
        }))
      };
    });
  }

  it('不超过一页时不出分页条', async () => {
    const t = await makeView();
    t.setVersionPage(1);
    t.sched.createVersion({ name: 'V1', date: '2026-10-01' });
    t.sched.createVersion({ name: 'V2', date: '2026-11-01' });
    expect(t.view()).not.toContain('ver-pager');
  });

  it('超过一页：按上线日倒序分页，首页放最新的那些', async () => {
    const t = await makeView();
    const v = {};
    for (let i = 7; i >= 1; i--) v[i] = t.sched.createVersion({ name: 'V' + i, date: `2026-${String(i).padStart(2, '0')}-10` }).version;

    t.setVersionPage(1);
    const p1 = t.view();
    expect(p1).toContain('ver-pager');
    expect(p1).toContain('第 1 / 2 页');
    expect(p1).toContain(`data-ver-id="${v[7].id}"`);    // 最新的一版在最前
    expect(p1).toContain(`data-ver-id="${v[2].id}"`);
    expect(p1).not.toContain(`data-ver-id="${v[1].id}"`); // 最旧的那版被挤到第二页
    expect(p1).toContain('data-ver-page="0" disabled');   // 首页的「上一页」不可点

    t.setVersionPage(2);
    const p2 = t.view();
    expect(p2).toContain('第 2 / 2 页');
    expect(p2).toContain(`data-ver-id="${v[1].id}"`);
    expect(p2).toContain('data-ver-page="3" disabled');   // 末页的「下一页」不可点
    t.setVersionPage(1);
  });

  it('页码越界时钳到最后一页（删掉版本后不会停在空页上）', async () => {
    const t = await makeView();
    for (let i = 7; i >= 1; i--) t.sched.createVersion({ name: 'V' + i, date: `2026-${String(i).padStart(2, '0')}-10` });
    t.setVersionPage(9);
    const html = t.view();
    expect(t.getVersionPage()).toBe(2);
    expect(html).toContain('第 2 / 2 页');
    t.setVersionPage(1);
  });

  it('新建版本后翻到它所在的那一页（否则"保存完看不见刚建的那版"）', async () => {
    const t = await makeView();
    // 8 个版本占满第一页（每页 6 个），新建的那版上线日最早 → 必然落在第 2 页
    for (let i = 8; i >= 1; i--) t.sched.createVersion({ name: 'V' + i, date: `2026-${String(i).padStart(2, '0')}-10` });
    t.setVersionPage(1);

    let saveFn = null;
    const els = {
      inpVerName: { value: 'V新' },
      inpVerDate: { value: '2026-01-01' },
      verPicker: { querySelectorAll: () => [] },
      verActualRow: { hidden: true },
      inpVerActual: { value: '' },
      btnSaveVer: { addEventListener: (type, fn) => { saveFn = fn; } },
      btnCancelVer: { addEventListener: () => {} }
    };
    const { bindVersionPage } = await import('../src/components/version-page.js');
    bindVersionPage({
      doc: {}, getEl: id => els[id] || null,
      gantt: { addEventListener: () => {} },
      planStore, sched: t.sched,
      toast: () => {}, today: () => new Date(2026, 8, 21), render: () => {}
    });
    saveFn();   // 相当于点了弹窗里的「保存」

    const nv = planStore.state.versions.find(x => x.name === 'V新');
    expect(nv).toBeTruthy();
    expect(t.getVersionPage()).toBe(t.versionPageOf(planStore.state, nv.id));
    expect(t.getVersionPage()).toBe(2);   // 9 个版本 / 每页 6 → 第 2 页
    t.setVersionPage(1);                  // 复位，别把页码留给后面的用例
  });

  it('分页按钮走委托翻页，只读下也能翻（纯查看动作）', async () => {
    // 与上面的 makeEnv 同套路：捕获 click 处理器，用假 event.target 驱动
    const calls = [];
    const handlers = {};
    const { bindVersionPage } = await import('../src/components/version-page.js');
    const { setVersionPage, getVersionPage } = await import('../src/views/version-view.js');
    bindVersionPage({
      doc: {}, getEl: () => null,
      gantt: { addEventListener: (type, fn) => { handlers[type] = fn; } },
      planStore,
      sched: {},
      toast: m => calls.push(['toast', m]),
      today: () => new Date(2026, 8, 21),
      render: () => calls.push(['render'])
    });
    userStore.set({ readonly: true });
    setVersionPage(1);
    handlers.click({ target: { closest: sel => (sel.indexOf('[data-ver-page]') >= 0 ? { dataset: { verPage: '2' } } : null) } });
    expect(getVersionPage()).toBe(2);
    expect(calls).toContainEqual(['render']);
    setVersionPage(1);
  });
});

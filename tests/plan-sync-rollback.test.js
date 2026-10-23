// ============================================================
// plan-sync 在「保存成功」路径上的行为测试。
//
// 与 tests/services.test.js 的分工：那里 mock 掉 projects.js 聚焦数据映射；
// 这里额外接入真实 persistence + scheduler，验证保存在成功后、
// 被拒后回滚对 localStorage 兜底与并发保存的影响（修复轮 1 的 Important-1/2）。
// projects.js 同样 mock（不碰真实网络），但 isDenied / errMsg 走真实实现。
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { planStore } from '../src/store/plan-store.js';
import { userStore } from '../src/store/user-store.js';

const mocks = vi.hoisted(() => ({
  loadPlan: vi.fn(),
  savePlan: vi.fn()
}));
// isDenied / errMsg 保持真实实现：用 importOriginal 透传，避免"把结果喂进去"式的同义反复测试
vi.mock('../src/services/projects.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadPlan: mocks.loadPlan, savePlan: mocks.savePlan };
});

const { createPlanSync } = await import('../src/services/plan-sync.js');
const { createScheduler } = await import('../src/scheduler/index.js');
const { createWorkday } = await import('../src/core/workday.js');

// localStorage 兜底用（node 环境没有 localStorage）
function installLocalStorage() {
  const map = new Map();
  const store = {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
    clear: () => map.clear()
  };
  vi.stubGlobal('localStorage', store);
  return store;
}

const PLAN_KEY = 'sched-plan-p1';
const shell = name => [{ name, bars: [{ id: 't1', s: '2026-09-01', e: '2026-09-03' }] }];

describe('plan-sync × persistence：被拒回滚（Important-1/2）', () => {
  let store;
  let sched;
  let sync;

  beforeEach(() => {
    vi.useFakeTimers();
    store = installLocalStorage();
    planStore.reset();
    userStore.reset();
    mocks.loadPlan.mockReset();
    mocks.savePlan.mockReset();
    userStore.set({ projectId: 'p1' });
    sync = createPlanSync({ planStore, userStore, sched: null });
    sched = createScheduler({ planStore, userStore, W: createWorkday({ holidays: [] }), sync });
    sync.setSched(sched);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('回滚成功后 localStorage 兜底被改写成服务器版本（否则离线打开会看到被拒的改动）', async () => {
    planStore.set({ modules: shell('本地乱改的'), resources: [], versions: [] });
    mocks.savePlan.mockResolvedValue({ error: { code: '42501', message: '无权修改他人负责的任务' } });
    mocks.loadPlan.mockResolvedValue({
      data: { plan: { modules: shell('服务器版本'), resources: [], versions: [] } },
      error: null
    });

    // 走真实 persistence.save：防抖 300ms 后先写 localStorage 再 pushToServer
    sched.save(true);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(100);   // 等防抖回调里的 pushToServer + 回滚链跑完

    expect(planStore.state.modules[0].name).toBe('服务器版本');
    expect(JSON.parse(store.getItem(PLAN_KEY)).modules[0].name).toBe('服务器版本');
    // 回滚绝不能反过来再推一次服务端（死循环）
    expect(mocks.savePlan).toHaveBeenCalledTimes(1);
  });

  it('回滚请求在途时用户又保存成功 → 过期的回滚响应被丢弃，不覆盖新改动（Important-2）', async () => {
    userStore.set({ projectId: 'p1', user: { email: 'me@x.com' } });
    planStore.set({ modules: shell('改动A'), resources: [], versions: [] });

    // ① A 被拒，回滚请求挂起
    let releaseRollback;
    const rollbackGate = new Promise(resolve => { releaseRollback = resolve; });
    mocks.loadPlan.mockReturnValue(rollbackGate.then(() => ({
      data: { plan: { modules: shell('A之前的服务器版本'), resources: [], versions: [] } },
      error: null
    })));
    mocks.savePlan.mockResolvedValueOnce({ error: { code: '42501', message: '无权修改他人负责的任务' } });
    const firstSave = sync.pushToServer();
    // 等 savePlan 的 then 执行、回滚请求发出
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.loadPlan).toHaveBeenCalledTimes(1);

    // ② 用户在回滚返回前又改 B 并保存成功
    planStore.set({ modules: shell('改动A+B'), resources: [], versions: [] });
    mocks.savePlan.mockResolvedValueOnce({ error: null });
    const secondSave = sync.pushToServer();
    expect(await secondSave).toBe(true);

    // ③ 回滚响应此时才回来（脚本是 A 之前的旧版本）
    releaseRollback();
    expect(await firstSave).toBe(false);
    await vi.advanceTimersByTimeAsync(0);

    // 过期响应必须丢弃：内存仍是刚存成功的 A+B
    expect(planStore.state.modules[0].name).toBe('改动A+B');
  });

  it('回滚失败（网络还断着）→ 内存与 localStorage 都保持原样，并提示恢复失败（Minor-5）', async () => {
    const seen = [];
    // sched 首次上报后，plan-sync 会改用注入的 statusFn；先占位再接线，保证不漏掉第一条
    sync.setSyncStatus(() => {});
    sync.setSyncStatus((state, info) => seen.push([state, info]));
    planStore.set({ modules: shell('本地乱改的'), resources: [], versions: [] });
    mocks.savePlan.mockResolvedValue({ error: { code: '42501', message: '无权修改他人负责的任务' } });
    mocks.loadPlan.mockResolvedValue({ data: null, error: { message: 'offline' } });

    await sync.pushToServer();

    // 回滚失败时内存保持被拒的改动（回滚没东西可写），并明确告诉用户去刷新
    expect(planStore.state.modules[0].name).toBe('本地乱改的');
    const msgs = seen.filter(([s]) => s === 'fail').map(([, info]) => info.msg);
    expect(msgs[0]).toBeDefined();
    // 不能在回滚发起前就断言"已回滚"
    expect(msgs[0]).not.toContain('已回滚');
    expect(msgs[0]).toContain('正在恢复服务器版本');
    // 回滚失败要补一条明确提示（文案"恢复服务器版本失败，请刷新页面"）
    expect(msgs.some(m => m.includes('失败，请刷新页面'))).toBe(true);
  });

  it('回滚失败时 localStorage 仍是原样，不被半途改写（仅内存未动不足以说明兜底安全）', async () => {
    sync.setSyncStatus(() => {});
    planStore.set({ modules: shell('本地乱改的'), resources: [], versions: [] });
    mocks.savePlan.mockResolvedValue({ error: { code: '42501', message: '无权修改他人负责的任务' } });
    mocks.loadPlan.mockResolvedValue({ data: null, error: { message: 'offline' } });

    sched.save(true);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(100);   // 等防抖回调里的 pushToServer + 回滚链跑完

    // 仍是被拒的 plan（回滚失败时无从修复兜底，用户下次刷新会对齐到服务端）
    expect(JSON.parse(store.getItem(PLAN_KEY)).modules[0].name).toBe('本地乱改的');
  });

  it('回滚成功 → 提示里的措辞不再是"已回滚"（改版后回滚完成后才给结论）', async () => {
    const seen = [];
    sync.setSyncStatus((state, info) => seen.push([state, info]));
    planStore.set({ modules: shell('本地乱改的'), resources: [], versions: [] });
    mocks.savePlan.mockResolvedValue({ error: { code: '42501', message: '无权修改他人负责的任务' } });
    mocks.loadPlan.mockResolvedValue({
      data: { plan: { modules: shell('服务器版本'), resources: [], versions: [] } },
      error: null
    });

    await sync.pushToServer();

    const msgs = seen.filter(([s]) => s === 'fail').map(([, info]) => info.msg);
    expect(msgs[0]).toContain('正在恢复服务器版本');
    expect(msgs.some(m => m.includes('失败，请刷新页面'))).toBe(false);
    expect(planStore.state.modules[0].name).toBe('服务器版本');
  });
});

// ============================================================
// 修复轮 2：epoch 判据从「pushToServer 入口计数」改为「成功保存完成计数」。
// 只有 error 为空（保存真的落到服务器）才推进版本号；回滚带着发起时的序号比对，
// 期间没有**成功**保存就照常应用。下面 a/b 两类场景正是旧判据误杀回滚的现场。
// ============================================================
describe('plan-sync × persistence：epoch 判据（修复轮 2）', () => {
  let store;
  let sched;
  let sync;

  beforeEach(() => {
    vi.useFakeTimers();
    store = installLocalStorage();
    planStore.reset();
    userStore.reset();
    mocks.loadPlan.mockReset();
    mocks.savePlan.mockReset();
    userStore.set({ projectId: 'p1', user: { email: 'me@x.com' } });
    sync = createPlanSync({ planStore, userStore, sched: null });
    sched = createScheduler({ planStore, userStore, W: createWorkday({ holidays: [] }), sync });
    sync.setSched(sched);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a. 回滚在途时另一次保存"网络异常"（promise reject）→ 不算成功保存，回滚照常生效', async () => {
    planStore.set({ modules: shell('本地乱改的'), resources: [], versions: [] });
    mocks.savePlan.mockResolvedValueOnce({ error: { code: '42501', message: '无权修改他人负责的任务' } });
    // 回滚请求挂起，稍后才返回
    let releaseRollback;
    const gate = new Promise(resolve => { releaseRollback = resolve; });
    mocks.loadPlan.mockReturnValue(gate.then(() => ({
      data: { plan: { modules: shell('服务器版本'), resources: [], versions: [] } },
      error: null
    })));

    const first = sync.pushToServer();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.loadPlan).toHaveBeenCalledTimes(1);

    // 回滚还在途，用户又改了一版，这次保存是**网络层 reject**（没到达服务器）
    planStore.set({ modules: shell('本地乱改的第二版'), resources: [], versions: [] });
    mocks.savePlan.mockRejectedValueOnce(new Error('network down'));
    expect(await sync.pushToServer()).toBe(false);

    // 回滚响应回来：由于没有「成功保存」，必须应用服务器版本（旧判据会把它误判为过期丢弃）
    releaseRollback();
    expect(await first).toBe(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(planStore.state.modules[0].name).toBe('服务器版本');
    expect(JSON.parse(store.getItem(PLAN_KEY)).modules[0].name).toBe('服务器版本');
  });

  it('b. 连续两次被拒（同一防抖窗口内的双重推送）→ 后一次生效，回滚不被自己作废', async () => {
    planStore.set({ modules: shell('本地乱改的'), resources: [], versions: [] });
    mocks.savePlan.mockResolvedValue({ error: { code: '42501', message: '无权修改他人负责的任务' } });
    // 第一条回滚很慢（旧判据下会被第二次推送作废），第二条回滚正常即时。
    // ⚠️ loadPlan 在真实实现里是 async（总是返回 Promise），mock 也必须返回 Promise，
    //    否则 plan-sync 里的 `loadPlan(...).then(...)` 直接 TypeError → 走 .catch → 'failed'。
    let releaseFirst;
    let loadCalls = 0;
    const firstRollback = new Promise(resolve => {
      releaseFirst = () => resolve({
        data: { plan: { modules: shell('服务器版本(第一次回滚)'), resources: [], versions: [] } },
        error: null
      });
    });
    mocks.loadPlan.mockImplementation(() => {
      loadCalls += 1;
      if (loadCalls === 1) return firstRollback;      // 第一条回滚：挂起
      return Promise.resolve({                        // 第二条回滚：即时返回
        data: { plan: { modules: shell('服务器版本(第二次回滚)'), resources: [], versions: [] } },
        error: null
      });
    });

    const first = sync.pushToServer();
    await vi.advanceTimersByTimeAsync(0);
    const second = sync.pushToServer();
    expect(await second).toBe(false);          // 第二次被拒 → 已回滚
    expect(planStore.state.modules[0].name).toBe('服务器版本(第二次回滚)');

    // 第一次的回滚此刻才回来：期间没有任何**成功**保存，结论仍有效 → 应用，
    // 保证最终对齐到服务端最新版本（而不是"后发先至"的旧快照）
    releaseFirst();
    expect(await first).toBe(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(planStore.state.modules[0].name).toBe('服务器版本(第一次回滚)');
    expect(JSON.parse(store.getItem(PLAN_KEY)).modules[0].name).toBe('服务器版本(第一次回滚)');
  });

  it('b2. importJSON 的真实双重推送（ctx.save() + 防抖）→ 回滚最终仍生效，不被自己作废', async () => {
    planStore.set({ modules: shell('导入前的数据'), resources: [], versions: [] });
    mocks.savePlan.mockResolvedValue({ error: { code: '42501', message: '无权修改他人负责的任务' } });
    mocks.loadPlan.mockResolvedValue({
      data: { plan: { modules: shell('服务器版本'), resources: [], versions: [] } },
      error: null
    });

    // importJSON 内会 ctx.save() → 300ms 后推送；同一窗口内的另一次 save() 会被防抖合并成
    // 一次推送。这里显式再调一次以复现"双重推送"（两次 pushToServer 相邻发生）。
    sched.importJSON(JSON.stringify({ modules: shell('导入的'), resources: [] }));
    sync.pushToServer();                        // 第一次推送（被拒 → 回滚在途）
    await vi.advanceTimersByTimeAsync(300);     // 防抖到点 → 第二次推送 + 两条回滚
    await vi.advanceTimersByTimeAsync(100);

    // 最终必须对齐到服务器版本；旧判据下第一次回滚会被第二次推送作废
    expect(planStore.state.modules[0].name).toBe('服务器版本');
    expect(JSON.parse(store.getItem(PLAN_KEY)).modules[0].name).toBe('服务器版本');
  });

  it('b3. 真正的成功保存介入 → 在途回滚被判过期丢弃，且不弹"恢复失败"打扰用户', async () => {
    const seen = [];
    sync.setSyncStatus((state, info) => seen.push([state, info]));
    planStore.set({ modules: shell('改动A'), resources: [], versions: [] });
    mocks.savePlan.mockResolvedValueOnce({ error: { code: '42501', message: '无权修改他人负责的任务' } });
    let releaseRollback;
    mocks.loadPlan.mockReturnValue(new Promise(resolve => {
      releaseRollback = () => resolve({
        data: { plan: { modules: shell('A之前的服务器版本'), resources: [], versions: [] } },
        error: null
      });
    }));

    const first = sync.pushToServer();
    await vi.advanceTimersByTimeAsync(0);

    // 期间用户又改并**保存成功** → committed 推进，A 的回滚结论作废
    planStore.set({ modules: shell('改动A+B'), resources: [], versions: [] });
    mocks.savePlan.mockResolvedValueOnce({ error: null });
    expect(await sync.pushToServer()).toBe(true);
    expect(planStore.state.modules[0].name).toBe('改动A+B');

    releaseRollback();
    expect(await first).toBe(false);
    await vi.advanceTimersByTimeAsync(0);

    // 过期 → 不覆盖新改动
    expect(planStore.state.modules[0].name).toBe('改动A+B');
    // 过期 → 不补发"恢复服务器版本失败"（界面与库里对齐的是那份更新的成功保存）
    const msgs = seen.filter(([s]) => s === 'fail').map(([, info]) => info.msg);
    expect(msgs[0]).toContain('正在恢复服务器版本');
    expect(msgs.some(m => m.includes('失败，请刷新页面'))).toBe(false);
  });
});

// ============================================================
// 修复轮 2 回归：applyPlanToStore 的空排期短路分支必须同样重建索引与周期。
// 旧版把 collect()/applyCycle() 写在 else 分支里，空排期直接 return 就跳过了。
// ============================================================
describe('plan-sync：applyPlanToStore 空排期短路分支（重构回归）', () => {
  let store;
  let sched;
  let sync;

  beforeEach(() => {
    vi.useFakeTimers();
    store = installLocalStorage();
    planStore.reset();
    userStore.reset();
    mocks.loadPlan.mockReset();
    mocks.savePlan.mockReset();
    userStore.set({ projectId: 'p1', user: { email: 'me@x.com' } });
    sync = createPlanSync({ planStore, userStore, sched: null });
    sched = createScheduler({ planStore, userStore, W: createWorkday({ holidays: [] }), sync });
    sync.setSched(sched);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('服务器返回空排期（modules 非数组）→ 索引清空且周期收回默认窗口', async () => {
    // 先放一份有内容的本地数据，让索引/周期都非空
    planStore.set({ modules: shell('旧数据'), resources: [], versions: [] });
    sched.collect();
    sched.applyCycle();
    expect(sched.tasks().length).toBe(1);
    const beforeCycle = { s: planStore.state.start.getTime(), e: planStore.state.end.getTime() };

    mocks.loadPlan.mockResolvedValue({ data: { plan: {} }, error: null });
    expect(await sync.loadFromServer()).toBe(true);

    expect(planStore.state.modules).toEqual([]);
    // 索引必须跟着清空（旧回归：短路直接 return，tasks 仍留着 1 条僵尸任务）
    expect(sched.tasks().length).toBe(0);
    expect(Object.keys(sched.tasksById()).length).toBe(0);
    // 周期必须重算：收回默认窗口（与旧项目的 9/1–9/3 不同）
    expect(planStore.state.start.getTime()).not.toBe(beforeCycle.s);
  });
});

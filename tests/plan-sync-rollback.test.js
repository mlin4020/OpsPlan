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
// isDenied / errMsg 保持真实实现：用 importActual 透传，避免"把结果喂进去"式的同义反复测试
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

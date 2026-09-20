// services 数据层测试：验证 plan-sync 的 loadFromServer / pushToServer 同步逻辑
// 通过 vi.mock 隔离 projects.js 的 loadPlan/savePlan，聚焦数据映射与同步状态上报。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { planStore } from '../src/store/plan-store.js';
import { userStore } from '../src/store/user-store.js';

// mock projects 服务（避免触碰真实 supabase client）
const mocks = vi.hoisted(() => ({
  loadPlan: vi.fn(),
  savePlan: vi.fn(),
  errMsg: vi.fn(e => e && e.message || '')
}));
vi.mock('../src/services/projects.js', () => mocks);

import { createPlanSync } from '../src/services/plan-sync.js';

function makeDeps() {
  const sched = { collect: vi.fn() };
  const onSyncStatus = vi.fn();
  const sync = createPlanSync({ planStore, userStore, sched, onSyncStatus });
  return { sched, onSyncStatus, sync };
}

describe('plan-sync: loadFromServer', () => {
  beforeEach(() => {
    planStore.reset();
    userStore.reset();
    mocks.loadPlan.mockReset();
    mocks.savePlan.mockReset();
  });

  it('无 projectId 时不请求并返回 false', async () => {
    const { sync, onSyncStatus } = makeDeps();
    const ok = await sync.loadFromServer();
    expect(ok).toBe(false);
    expect(mocks.loadPlan).not.toHaveBeenCalled();
    expect(onSyncStatus).not.toHaveBeenCalled();
  });

  it('加载有效排期：写回 planStore 并重建索引', async () => {
    userStore.set({ projectId: 'p1' });
    const plan = {
      v: 1, calcVer: 5, savedAt: 1700000000000, savedBy: 'a@b.com',
      start: '2026-08-12', end: '2026-10-31',
      modules: [{ name: 'M', bars: [{ id: 't1', s: '2026-09-01', e: '2026-09-03' }] }],
      resources: [{ id: 'r1', name: '张三', role: '开发', color: '#3b82f6' }]
    };
    mocks.loadPlan.mockResolvedValue({ data: { plan }, error: null });
    const { sync, sched, onSyncStatus } = makeDeps();
    const ok = await sync.loadFromServer();
    expect(ok).toBe(true);
    expect(planStore.state.modules).toEqual(plan.modules);
    expect(planStore.state.resources).toEqual(plan.resources);
    expect(planStore.state.start).toEqual(new Date(2026, 7, 12));
    expect(planStore.state.end).toEqual(new Date(2026, 9, 31));
    expect(sched.collect).toHaveBeenCalled();
    expect(onSyncStatus).toHaveBeenCalledWith('ok', expect.objectContaining({ savedBy: 'a@b.com' }));
  });

  it('算法版本不符时返回 false（数据作废）', async () => {
    userStore.set({ projectId: 'p1' });
    mocks.loadPlan.mockResolvedValue({ data: { plan: { v: 1, calcVer: 4, modules: [] } }, error: null });
    const { sync } = makeDeps();
    const ok = await sync.loadFromServer();
    expect(ok).toBe(false);
  });

  it('服务端报错返回 false', async () => {
    userStore.set({ projectId: 'p1' });
    mocks.loadPlan.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { sync } = makeDeps();
    const ok = await sync.loadFromServer();
    expect(ok).toBe(false);
  });
});

describe('plan-sync: pushToServer', () => {
  beforeEach(() => {
    planStore.reset();
    userStore.reset();
    mocks.loadPlan.mockReset();
    mocks.savePlan.mockReset();
  });

  it('只读项目不推送并返回 false', async () => {
    userStore.set({ projectId: 'p1', readonly: true });
    const { sync } = makeDeps();
    const ok = await sync.pushToServer();
    expect(ok).toBe(false);
    expect(mocks.savePlan).not.toHaveBeenCalled();
  });

  it('推送成功：载荷含时间窗口与数据，上报 ok', async () => {
    userStore.set({ projectId: 'p1', user: { email: 'me@x.com' } });
    planStore.set({
      modules: [{ name: 'M', bars: [] }],
      resources: [],
      start: new Date(2026, 7, 12),
      end: new Date(2026, 9, 31)
    });
    mocks.savePlan.mockResolvedValue({ data: null, error: null });
    const { sync, onSyncStatus } = makeDeps();
    const ok = await sync.pushToServer();
    expect(ok).toBe(true);
    const [pid, payload] = mocks.savePlan.mock.calls[0];
    expect(pid).toBe('p1');
    expect(payload.calcVer).toBe(5);
    expect(payload.start).toBe('2026-08-12');
    expect(payload.end).toBe('2026-10-31');
    expect(payload.savedBy).toBe('me@x.com');
    expect(payload.modules).toEqual(planStore.state.modules);
    expect(onSyncStatus).toHaveBeenCalledWith('ok', expect.objectContaining({ savedBy: 'me@x.com' }));
  });

  it('推送失败上报 fail 并返回 false', async () => {
    userStore.set({ projectId: 'p1' });
    mocks.savePlan.mockResolvedValue({ data: null, error: { message: 'no' } });
    const { sync, onSyncStatus } = makeDeps();
    const ok = await sync.pushToServer();
    expect(ok).toBe(false);
    expect(onSyncStatus).toHaveBeenCalledWith('fail', expect.any(Object));
  });
});

// ---------- supabase 客户端单例 ----------
// 回归：创建后 window.supabase 被覆盖为 client（无 createClient），
// 再次 getClient() 必须复用缓存而不是校验 UMD 返回 null。
describe('supabase client 单例', () => {
  const mod = '../src/services/supabase.js';
  // 注意：vitest 对动态 import 的模块按 URL 缓存单例（同一模块实例），
  // 因此两个用例共享 sb——先测「未配置」再测「配置后缓存复用」，顺序固定。

  it('未配置时返回 null 且不抛异常', async () => {
    vi.stubGlobal('window', { supabase: { createClient: () => ({}) }, SUPABASE_CONFIG: {} });
    const supabaseService = await import(mod);
    expect(supabaseService.initSupabase()).toBe(null);
    expect(supabaseService.getClient()).toBe(null);
    vi.unstubAllGlobals();
  });

  it('首次初始化后 getClient 复用缓存（不因 UMD 覆盖而失效）', async () => {
    const fakeClient = { auth: {}, from: () => {} };
    const umd = { createClient: () => fakeClient };
    const win = { supabase: umd, SUPABASE_CONFIG: { url: 'u', anonKey: 'k' } };

    // 隔离模块实例（每次 fresh import），并把 window 替换为 fake
    vi.stubGlobal('window', win);
    const supabaseService = await import(mod);

    const first = supabaseService.initSupabase();
    expect(first).toBe(fakeClient);
    // 模拟旧代码/其他模块覆盖 window.supabase 为 client 后的二次调用
    win.supabase = fakeClient;
    const second = supabaseService.getClient();
    expect(second).toBe(fakeClient);   // 必须仍返回缓存，而非 null
    vi.unstubAllGlobals();
  });
});

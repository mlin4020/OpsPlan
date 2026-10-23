// projects.js 的 isDenied / errMsg 纯函数测试。
//
// 为什么单独放一个文件：tests/services.test.js 用
//   vi.mock('../src/services/projects.js', () => mocks)
// 把整条 `import { isDenied } from '../src/services/projects.js'` 替换成了 spy，
// 在那里无论怎么断言，测到的都是 mock 的返回值 —— 真实判定逻辑零覆盖。
// vi.mock 的替换是按「被测模块 id」生效的，只有在本文件（不 mock 它）里
// 才能拿到真实实现。
//
// projects.js 顶层只 import './backend.js'（不含副作用），backend.js 内部才是
// 动态 import 后端实现，所以这里 import 真实模块不会初始化 Supabase client。
import { describe, it, expect } from 'vitest';
import { isDenied, errMsg } from '../src/services/projects.js';

describe('projects.isDenied（真实实现，设计文档 §6.2）', () => {
  it('code = 42501 → 判为拒绝', () => {
    expect(isDenied({ code: '42501', message: '无权修改他人负责的任务' })).toBe(true);
  });

  it('code = 42501 但 message 不含关键词 → 仍判为拒绝（errcode 是权威信号）', () => {
    expect(isDenied({ code: '42501', message: 'permission denied' })).toBe(true);
  });

  // 修复轮 2：code 可能被序列化成数字。严格 === '42501' 会让判定失效
  // （既不算拒绝、errMsg 也不透出服务端 message）。
  it('code = 42501（数字）→ 仍判为拒绝', () => {
    expect(isDenied({ code: 42501, message: 'permission denied' })).toBe(true);
  });

  it('P0002「项目不存在」→ 不判为拒绝（非权限类，回滚没有意义）', () => {
    expect(isDenied({ code: 'P0002', message: '项目不存在' })).toBe(false);
  });

  it('57014「超时」→ 不判为拒绝（非权限类，网络/超时不该丢本地改动）', () => {
    expect(isDenied({ code: '57014', message: '超时' })).toBe(false);
  });

  it('无 code 但文案含「无权」→ 判为拒绝', () => {
    expect(isDenied({ message: '你无权修改该项目的排期' })).toBe(true);
  });

  it('无 code 但文案含「未指定对应人员」→ 判为拒绝', () => {
    expect(isDenied({ message: '任务 t1 未指定对应人员，无法判定权限' })).toBe(true);
  });

  it('无 code 但文案含「仅管理员」→ 判为拒绝', () => {
    expect(isDenied({ message: '仅管理员可修改他人资源' })).toBe(true);
  });

  it('isDenied(null) 不抛异常且返回 false', () => {
    expect(() => isDenied(null)).not.toThrow();
    expect(isDenied(null)).toBe(false);
  });

  it('isDenied({})（无 code 无 message）不抛异常且返回 false', () => {
    expect(() => isDenied({})).not.toThrow();
    expect(isDenied({})).toBe(false);
  });
});

describe('projects.errMsg（真实实现）', () => {
  it('42501 → 原样透出服务端的具体原因（不压成笼统文案）', () => {
    const msg = '无权修改他人负责的任务（id=t9）';
    expect(errMsg({ code: '42501', message: msg })).toBe(msg);
  });

  it('42501 但无 message → 兜底「无权限执行该操作」', () => {
    expect(errMsg({ code: '42501' })).toBe('无权限执行该操作');
  });

  it('42501（数字 code）→ 同样透出/兜底（不因类型不同而退化成通用文案）', () => {
    expect(errMsg({ code: 42501, message: '无权修改他人负责的任务（id=t9）' }))
      .toBe('无权修改他人负责的任务（id=t9）');
    expect(errMsg({ code: 42501 })).toBe('无权限执行该操作');
  });

  it('非 42501 → 透出 message', () => {
    expect(errMsg({ code: 'P0002', message: '项目不存在' })).toBe('项目不存在');
  });

  it('非 42501 且无 message → 兜底「操作失败」', () => {
    expect(errMsg({ code: '57014' })).toBe('操作失败');
  });

  it('errMsg(null) → 空串，不抛异常', () => {
    expect(errMsg(null)).toBe('');
  });
});

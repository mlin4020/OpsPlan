// auth 服务测试：聚焦 friendlyAuthError 的错误本地化映射
// auth.js 依赖 supabase.js（内部对 window 做了守卫），在 node 环境下导入安全。
import { describe, it, expect } from 'vitest';
import { friendlyAuthError } from '../src/services/auth.js';

describe('auth: friendlyAuthError', () => {
  it('空错误返回空串', () => {
    expect(friendlyAuthError(null)).toBe('');
    expect(friendlyAuthError(undefined)).toBe('');
  });

  it('邮箱限流映射为中文并给出处理建议', () => {
    const msg = friendlyAuthError({ message: 'email rate limit exceeded' });
    expect(msg).toContain('限流');
    expect(msg).not.toMatch(/^email rate limit exceeded$/);
  });

  it('over_email_send_rate_limit 同样识别为限流', () => {
    expect(friendlyAuthError({ message: 'over_email_send_rate_limit' })).toContain('限流');
  });

  it('常见登录错误映射为中文', () => {
    expect(friendlyAuthError({ message: 'Invalid login credentials' })).toContain('密码不正确');
    expect(friendlyAuthError({ message: 'Email not confirmed' })).toContain('尚未验证');
    expect(friendlyAuthError({ message: 'User already registered' })).toContain('已注册');
  });

  it('未命中的错误原样透出，便于排查', () => {
    expect(friendlyAuthError({ message: 'some brand new error' })).toBe('some brand new error');
  });

  it('非 Error 对象（字符串）也能处理', () => {
    expect(friendlyAuthError('Invalid login credentials')).toContain('密码不正确');
  });
});

// 登录页独立路由 + 游客登录的契约
//
// 拆页之后最容易静默坏掉的是"接线"这一类东西：按钮改了 id、页面忘了加进构建入口、
// 守卫写成 href（返回键来回弹）。这些都是"能跑但不对"的错，靠渲染单测测不出来，
// 故对着源码与页面结构钉住。
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isGuest, enterGuest, leaveGuest } from '../src/services/auth.js';

const read = p => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

// node 环境没有 localStorage（真机上的读写都是 try/catch 兜底，这里补一个可观测的替身）
if (typeof globalThis.localStorage === 'undefined') {
  const m = new Map();
  globalThis.localStorage = {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    clear: () => { m.clear(); }
  };
}

describe('游客身份标记（登录页点一下，之后免登录）', () => {
  beforeEach(() => localStorage.clear());

  it('默认不是游客', () => {
    expect(isGuest()).toBe(false);
  });

  it('enterGuest 之后 isGuest 为真；leaveGuest 清掉', () => {
    enterGuest();
    expect(isGuest()).toBe(true);
    leaveGuest();
    expect(isGuest()).toBe(false);
  });

  it('标记存在 localStorage（新开标签页也算游客，不必每次重选）', () => {
    enterGuest();
    expect(localStorage.getItem('opsplan.guest')).toBe('1');
  });
});

describe('登录页独立路由', () => {
  it('login.html 只有登录 / 注册 / 游客三件事，不放项目列表', () => {
    const html = read('../login.html');
    expect(html).toContain('id="loginForm"');
    expect(html).toContain('id="regForm"');
    expect(html).toContain('id="btnGuest"');       // 游客入口
    expect(html).toContain('id="loginSub"');       // 登录/注册切换时要改的那行文案
    expect(html).not.toContain('projGrid');        // 列表不在这页
  });

  it('项目列表页不再内嵌登录卡片，未登录时跳登录页', () => {
    const html = read('../index.html');
    expect(html).not.toContain('id="viewLogin"');
    expect(html).not.toContain('id="loginForm"');
    expect(html).toContain('id="projGrid"');

    const js = read('../src/main-index.js');
    // 守卫：没有会话也不是游客 → 去登录页；且用 replace 免得返回键在"列表↔登录"之间来回弹
    expect(js).toMatch(/location\.replace\('login\.html'\)/);
    expect(js).toMatch(/isGuest\(\)/);
    expect(js).not.toMatch(/location\.href = 'login\.html'[\s\S]{0,40}\/\*?\s*守卫/);
  });

  it('登录页提交成功后回列表页；游客按钮只做本机标记、不碰后端', () => {
    const js = read('../src/main-login.js');
    expect(js).toMatch(/enterGuest\(\)/);
    expect(js).toMatch(/leaveGuest\(\)/);          // 真登录后要清掉游客标记
    expect(js).toMatch(/location\.replace\(HOME\)/);
    // 游客路径里不能出现 login / signUp：它必须是一次纯本地跳转
    const guestFn = js.slice(js.indexOf('function doGuest'), js.indexOf('function showReg'));
    expect(guestFn).not.toMatch(/login\(|signUp\(/);
  });

  it('已登录访问登录页会跳过表单，但资料读不到时不能跳（否则与列表页互相弹）', () => {
    const js = read('../src/main-login.js');
    const skip = js.slice(js.indexOf('function skipIfSignedIn'));
    expect(skip).toMatch(/getSession\(\)/);
    expect(skip).toMatch(/getProfile\(/);
    expect(skip).toMatch(/if \(error\) return;/);
  });

  it('vite 多页入口包含 login.html（漏了则部署后 404，dev 下看不出来）', () => {
    expect(read('../vite.config.js')).toMatch(/login: 'login\.html'/);
  });
});

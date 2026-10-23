// ============================================================
// Task 13：用户管理页的数据层与保护规则
//
// 为什么单独一个文件：这里要 mock 掉 supabase client 来断言"查询形状"
// （select 里到底有没有 resource_name、update 落库的 body 长什么样），
// 与 tests/services.test.js（mock 掉整个 projects 门面）互斥。
//
// 三个必须钉住的点（每一个都对应一个真实故障形态）：
//   1) listUsers 的 select 漏 resource_name → 「未指定」徽标永远显示，漏配发现机制失效；
//   2) 空串必须落成 null → 空字符串会让"未指定"与"指定了空名字"两种状态混在一起；
//   3) 两条保护（不能改自己 / 不能降级最后一个管理员）→ 误操作后没人能改回来。
// ============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- supabase client 替身：只记录调用形状，不发网络请求 ----
const db = { selects: [], updates: [], eqs: [], rpcs: [] };
const fakeClient = {
  from(table) {
    return {
      select(cols) {
        db.selects.push({ table, cols });
        return {
          order: () => Promise.resolve({ data: [], error: null }),
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) })
        };
      },
      update(body) {
        db.updates.push({ table, body });
        return {
          eq: (col, val) => {
            db.eqs.push({ col, val });
            return Promise.resolve({ data: null, error: null });
          }
        };
      }
    };
  },
  rpc(name, args) {
    db.rpcs.push({ name, args });
    return Promise.resolve({ data: [{ name: ' 张三 ' }, { name: '李四' }], error: null });
  }
};

vi.mock('../src/services/supabase.js', () => ({
  getClient: () => fakeClient,
  isReady: () => true,
  resolveConfig: () => ({})
}));

const { supabaseBackend } = await import('../src/services/backends/supabase.js');
const { feishuBackend } = await import('../src/services/backends/feishu.js');
const projects = await import('../src/services/projects.js');
const { roleChangeGuard } = await import('../src/utils/permission.js');

beforeEach(() => {
  db.selects.length = 0; db.updates.length = 0; db.eqs.length = 0; db.rpcs.length = 0;
});

describe('supabase 后端：listUsers 必须带 resource_name', () => {
  it('select 列表含 resource_name（漏了它「未指定」徽标永远显示）', async () => {
    await supabaseBackend.listUsers();
    expect(db.selects).toHaveLength(1);
    expect(db.selects[0].table).toBe('profiles');
    expect(db.selects[0].cols).toContain('resource_name');
  });
});

describe('supabase 后端：updateProfile', () => {
  it('三个字段都能改，且只改传进来的那些', async () => {
    await supabaseBackend.updateProfile('u1', { display_name: ' 张三 ', role: 'admin', resource_name: ' 李四 ' });
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].table).toBe('profiles');
    expect(db.updates[0].body).toEqual({ display_name: '张三', role: 'admin', resource_name: '李四' });
    expect(db.eqs).toEqual([{ col: 'id', val: 'u1' }]);
  });

  it('role 只认 admin / 其余一律 user（前端不制造第三种角色）', async () => {
    await supabaseBackend.updateProfile('u1', { role: '超级管理员' });
    expect(db.updates[0].body.role).toBe('user');
  });

  it('resource_name 空串 → null（未指定），不是空字符串', async () => {
    await supabaseBackend.updateProfile('u1', { resource_name: '   ' });
    expect(db.updates[0].body.resource_name).toBeNull();
  });

  it('不传 role / resource_name 时不会顺手把它们写回（否则会撞守卫触发器）', async () => {
    await supabaseBackend.updateProfile('u1', { display_name: '王五' });
    expect(Object.keys(db.updates[0].body)).toEqual(['display_name']);
  });
});

describe('supabase 后端：listResourceNames', () => {
  it('走 list_resource_names() RPC 并取出 name（去重归一化由服务端负责，这里只解包）', async () => {
    const { data, error } = await supabaseBackend.listResourceNames();
    expect(db.rpcs[0].name).toBe('list_resource_names');
    expect(error).toBeNull();
    expect(data).toEqual([' 张三 ', '李四']);   // 不在前端二次 trim：服务端已 btrim，别改口径
  });
});

describe('projects 门面：updateProfile / listResourceNames 透传', () => {
  it('updateProfile(userId, patch) 原样透传到后端', async () => {
    const spy = vi.spyOn(supabaseBackend, 'updateProfile');
    // 门面走 getBackend()，这里直接换掉工厂返回值太重；改为断言门面函数存在且参数透传
    expect(typeof projects.updateProfile).toBe('function');
    const r = await projects.updateProfile('u1', { role: 'user' });
    expect(r).toBeTruthy();
    expect(spy).toHaveBeenCalledWith('u1', { role: 'user' });
    spy.mockRestore();
  });

  it('默认导出同步替换：有 updateProfile / listResourceNames，没有 setAdmin', () => {
    expect(typeof projects.default.updateProfile).toBe('function');
    expect(typeof projects.default.listResourceNames).toBe('function');
    expect(projects.default.setAdmin).toBeUndefined();
  });
});

// ---- 飞书后端：签名对齐 + 字段透出（不做校验） ----
describe('飞书后端：updateProfile 与 resource_name 透出', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.unstubAllGlobals(); });

  const stubFetch = users => {
    const calls = [];
    const fn = async (url, opts) => {
      calls.push({ url: String(url), opts });
      return { ok: true, json: async () => ({ users }) };
    };
    globalThis.fetch = fn;
    vi.stubGlobal('window', {
      FEISHU_CONFIG: { bridgeUrl: 'http://127.0.0.1:8787', appToken: 'app' }
    });
    return calls;
  };

  it('listUsers 透出 resource_name；取不到时是空串而不是 undefined', async () => {
    stubFetch([
      { id: 'u1', display_name: '张三', role: 'user', resource_name: '张三' },
      { id: 'u2', display_name: '李四', role: 'user' }
    ]);
    const { data } = await feishuBackend.listUsers();
    expect(data[0].resource_name).toBe('张三');
    expect(data[1].resource_name).toBe('');       // 渲染层不必再防 undefined
  });

  it('updateProfile 按 patch.role 推断账号类型，并透传姓名', async () => {
    const calls = stubFetch([]);
    await feishuBackend.updateProfile('rec1', { display_name: '王五', role: 'admin', resource_name: '王五' });
    const body = JSON.parse(calls[0].opts.body);
    expect(body.fields['账号类型']).toBe('admin');
    expect(body.fields['姓名']).toBe('王五');
  });

  it('listResourceNames 在飞书模式返回空候选（靠人工填写），但仍要能真调', async () => {
    stubFetch([]);
    const { data, error } = await feishuBackend.listResourceNames();
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

// ---- 两条保护：抽成 permission.js 的纯函数，避免 UI 里散落 if/else ----
describe('permission.roleChangeGuard：用户管理的两条保护', () => {
  const me = { id: 'me' };
  const users = [
    { id: 'me', role: 'admin', display_name: '我' },
    { id: 'a', role: 'admin', display_name: '甲' },
    { id: 'b', role: 'user', display_name: '乙' }
  ];

  it('不能改自己的角色（否则误操作把自己降级后没人能改回来）', () => {
    const g = roleChangeGuard(users[0], users, me);
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/自己/);
  });

  it('不能降级最后一个管理员（否则系统没有管理员）', () => {
    const onlyAdmin = [{ id: 'me', role: 'user' }, { id: 'a', role: 'admin' }];
    const g = roleChangeGuard(onlyAdmin[1], onlyAdmin, me);
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/最后一个管理员/);
  });

  it('还有别的管理员时可降级', () => {
    expect(roleChangeGuard(users[1], users, me).ok).toBe(true);
  });

  it('普通用户随时可改（升管理员不受这两条限制）', () => {
    expect(roleChangeGuard(users[2], users, me).ok).toBe(true);
  });

  it('找不到目标用户时不给改（防御：列表过期）', () => {
    expect(roleChangeGuard(null, users, me).ok).toBe(false);
  });
});

// ---- 页面接线（main-index 是带副作用的入口，不能 import，只能钉源码契约） ----
describe('用户管理页接线（静态契约）', () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
  const js = readFileSync(resolve(ROOT, 'src/main-index.js'), 'utf8');

  it('编辑用户弹窗齐备：姓名 / 角色 / 对应人员 + 候选 datalist', () => {
    ['maskEditUser', 'inpEuName', 'selEuRole', 'inpEuResName', 'btnEuSave'].forEach(id => {
      expect(html).toContain('id="' + id + '"');
    });
    expect(html).toContain('list="resNameList"');
    expect(html).toContain('id="resNameList"');
  });

  it('列表有「编辑」入口，并用「未指定」徽标暴露漏配', () => {
    expect(js).toContain('data-edituser');
    expect(js).toContain('badge warn');
    expect(js).toContain("u.resource_name");
  });

  it('两条保护走 permission.roleChangeGuard（不散落 if/else），禁用时不提交 role', () => {
    expect(js).toContain('roleChangeGuard');
    expect(js).toMatch(/if \(!\$\('selEuRole'\)\.disabled\) patch\.role/);
  });

  it('进页面就拉「对应人员」候选，保存后刷新列表与负责人下拉', () => {
    expect(js).toMatch(/loadUsers\(\); fillOwnerSelects\(\); fillResNameOptions\(\);/);
    expect(js).toMatch(/listResourceNames\(\)/);
  });

  it('非管理员没有进入编辑用户的路径（面板不显示 + loadUsers 直接返回）', () => {
    expect(js).toMatch(/async function loadUsers\(\) \{\s*\n[\s\S]{0,200}?if \(!isAdmin\(\)\) return;/);
    expect(js).toContain("$('adminSection').style.display = isAdmin() ? '' : 'none'");
  });
});

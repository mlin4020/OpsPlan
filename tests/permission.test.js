import { describe, it, expect } from 'vitest';
import {
  ACCESS, resolveAccess, ctxOf, isMilestone, taskMine, modMine,
  canEditModuleFields, canManageModule, canEditTask, canEditMilestone, canTouchTask,
  canEditResources, canEditVersion, canDeleteVersion, canArchiveVersionMods,
  canPlan, canEditProjectMeta, canDeleteProject, canManageUsers
} from '../src/utils/permission.js';

// 注意：这里**不要**手写「collab + 空人名」这种组合的常量。
// 真源 resolveAccess 的定义就是「collab ⟺ 已登录 且 resource_name 非空」，
// 所以「没配人名」必然落到 readonly —— 手写一个 collab+空人名 的 fixture 是在测一个
// 真源永远产生不出来的状态（测试噪声，且会与 canEditTask/canEditModuleFields 的语义打架）。
// 「没配人名 ⇒ 只读」这条不变量由下面的 `ctxOf 派生` 用例现算来锁定。
const FULL = { access: ACCESS.FULL, rname: '张三', role: 'admin' };
const OWNER = { access: ACCESS.FULL, rname: '张三', role: 'user' };
const COLLAB = { access: ACCESS.COLLAB, rname: '张三', role: 'user' };
const READONLY = { access: ACCESS.READONLY, rname: '', role: 'user' };

describe('resolveAccess', () => {
  it('管理员与所属人都是 full，优先于人名', () => {
    expect(resolveAccess({ role: 'admin' })).toBe(ACCESS.FULL);
    expect(resolveAccess({ isOwner: true })).toBe(ACCESS.FULL);
    expect(resolveAccess({ role: 'admin', resourceName: '' })).toBe(ACCESS.FULL);
  });
  it('配了人名才是 collab，否则只读', () => {
    expect(resolveAccess({ resourceName: '张三' })).toBe(ACCESS.COLLAB);
    expect(resolveAccess({ resourceName: '  ' })).toBe(ACCESS.READONLY);
    expect(resolveAccess({})).toBe(ACCESS.READONLY);
    expect(resolveAccess()).toBe(ACCESS.READONLY);
  });
});

describe('ctxOf 向后兼容', () => {
  it('未指定 access 且非只读 → full（等价改造前的“能改”）', () => {
    expect(ctxOf({ readonly: false, resourceName: '', role: 'user' }).access).toBe(ACCESS.FULL);
  });
  it('readonly 为真压过 access', () => {
    expect(ctxOf({ readonly: true, access: ACCESS.FULL, role: 'admin' }).access).toBe(ACCESS.READONLY);
  });
  it('显式 access 被保留；空入参不炸', () => {
    expect(ctxOf({ readonly: false, access: ACCESS.COLLAB }).access).toBe(ACCESS.COLLAB);
    expect(() => ctxOf()).not.toThrow();
    expect(ctxOf().rname).toBe('');
    expect(ctxOf().role).toBe('user');
  });
});

describe('没配对应人员 ⇒ 只读 ⇒ 一切写权限为假', () => {
  // ⚠️ 必须用 `resolveAccess`（身份映射的真源）现算，**不能用 `ctxOf`**。
  //   ctxOf 是 `userStore.state → ctx` 的适配层，它对"未显式给 access 且非只读"
  //   有一个刻意的向后兼容兜底（返回 'full'，为了让「守卫改造」先于「放权」上线时零行为变化）。
  //   拿 ctxOf 去断言"没人名 ⇒ 只读"，测到的是那个兜底行为，不是身份映射 —— 两者不是一回事。
  //   手写常量（旧版的 NO_NAME）或误用适配层（本节的初版），都会造出真源产生不出来的状态。
  it('resolveAccess 把"有人名之外的一切"都落到只读', () => {
    expect(resolveAccess({ role: 'user', resourceName: '' })).toBe(ACCESS.READONLY);
    expect(resolveAccess({ role: 'user', resourceName: '   ' })).toBe(ACCESS.READONLY);
    expect(resolveAccess({ role: 'user' })).toBe(ACCESS.READONLY);
  });

  it('由真源派生的「人名缺失」ctx：一切写权限为假', () => {
    const access = resolveAccess({ role: 'user', resourceName: '' });
    const anon = { access, rname: '', role: 'user' };
    expect(access).toBe(ACCESS.READONLY);
    expect(canEditTask({ res: [] }, anon)).toBe(false);        // 连"未分配可认领"也不给
    expect(canEditTask({ res: ['张三'] }, anon)).toBe(false);
    expect(canEditModuleFields(anon)).toBe(false);
    expect(canManageModule({ owner: '张三' }, anon)).toBe(false);
    expect(canPlan(anon)).toBe(false);
  });
});

describe('taskMine', () => {
  it('未分配的普通任务（res 空数组）任何人可编辑', () => {
    expect(taskMine({ res: [] }, '张三')).toBe(true);
    expect(taskMine({ res: [] }, '')).toBe(true);
  });
  it('res 含我 / 不含我', () => {
    expect(taskMine({ res: ['张三', '李四'] }, '张三')).toBe(true);
    expect(taskMine({ res: ['李四'] }, '张三')).toBe(false);
    expect(taskMine({ res: ['李四'] }, '')).toBe(false);
  });
  it('里程碑没有 res 键 → false（不能当成“未分配”）', () => {
    expect(taskMine({ m: '2026-09-09', label: '上线' }, '张三')).toBe(false);
  });
});

describe('modMine', () => {
  it('归属匹配才为真；无主 / 无人名 → false', () => {
    expect(modMine({ owner: '张三' }, '张三')).toBe(true);
    expect(modMine({ owner: '李四' }, '张三')).toBe(false);
    expect(modMine({}, '张三')).toBe(false);
    expect(modMine({ owner: '张三' }, '')).toBe(false);
    expect(modMine(null, '张三')).toBe(false);
  });
});

describe('任务级判定', () => {
  it('full 全放行', () => expect(canEditTask({ res: ['李四'] }, FULL)).toBe(true));
  it('collab 只看归属', () => {
    expect(canEditTask({ res: ['张三'] }, COLLAB)).toBe(true);
    expect(canEditTask({ res: [] }, COLLAB)).toBe(true);
    expect(canEditTask({ res: ['李四'] }, COLLAB)).toBe(false);
  });
  it('readonly 一律拒绝', () => {
    expect(canEditTask({ res: [] }, READONLY)).toBe(false);
    expect(canEditTask({ res: ['张三'] }, READONLY)).toBe(false);
    expect(canEditTask({ res: ['李四'] }, READONLY)).toBe(false);
  });
});

describe('需求级判定', () => {
  it('字段级：full 与 collab 都可以，readonly 不行', () => {
    expect(canEditModuleFields(FULL)).toBe(true);
    expect(canEditModuleFields(COLLAB)).toBe(true);
    expect(canEditModuleFields(READONLY)).toBe(false);
  });
  it('归属级：collab 仅限自己的需求，无主需求也不行', () => {
    expect(canManageModule({ owner: '李四' }, FULL)).toBe(true);
    expect(canManageModule({ owner: '张三' }, COLLAB)).toBe(true);
    expect(canManageModule({ owner: '李四' }, COLLAB)).toBe(false);
    expect(canManageModule({}, COLLAB)).toBe(false);
    expect(canManageModule({ owner: '张三' }, READONLY)).toBe(false);
  });
});

describe('里程碑与统一入口', () => {
  const ms = { m: '2026-09-09', label: '9/9 上线' };
  const task = { res: ['李四'] };
  it('isMilestone 只认 m 键', () => {
    expect(isMilestone(ms)).toBe(true);
    expect(isMilestone(task)).toBe(false);
    expect(isMilestone(null)).toBe(false);
  });
  it('里程碑手动编辑跟需求归属走（不是任务 res）', () => {
    expect(canEditTask(ms, COLLAB)).toBe(false);
    expect(canEditMilestone(ms, { owner: '张三' }, COLLAB)).toBe(true);
    expect(canEditMilestone(ms, { owner: '李四' }, COLLAB)).toBe(false);
  });
  it('canTouchTask 按形态分流', () => {
    expect(canTouchTask(task, { owner: '张三' }, COLLAB)).toBe(false);   // 普通任务：看 res
    expect(canTouchTask(ms, { owner: '张三' }, COLLAB)).toBe(true);      // 里程碑：看需求归属
    expect(canTouchTask(task, { owner: '李四' }, FULL)).toBe(true);
    expect(canTouchTask(ms, { owner: '李四' }, READONLY)).toBe(false);
  });
});

describe('其余判定', () => {
  it('资源库 / 自动计划 / 项目元数据 / 版本删除 / 一键归档：仅 full', () => {
    [canEditResources, canPlan, canEditProjectMeta, canDeleteVersion, canArchiveVersionMods]
      .forEach(fn => {
        expect(fn(FULL)).toBe(true);
        expect(fn(COLLAB)).toBe(false);
        expect(fn(READONLY)).toBe(false);
      });
  });
  it('版本编辑：full 与 collab', () => {
    expect(canEditVersion(FULL)).toBe(true);
    expect(canEditVersion(COLLAB)).toBe(true);
    expect(canEditVersion(READONLY)).toBe(false);
  });
  it('删项目与用户管理：仅管理员（所属人也不行）', () => {
    expect(canDeleteProject(FULL)).toBe(true);
    expect(canDeleteProject(OWNER)).toBe(false);
    expect(canManageUsers(FULL)).toBe(true);
    expect(canManageUsers(OWNER)).toBe(false);
    expect(canManageUsers(COLLAB)).toBe(false);
  });
});

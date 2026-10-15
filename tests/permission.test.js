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

// ============================================================
// 跨身份交叉矩阵
//
// 为什么要有这一节（不是为了补漏，而是把覆盖补成显式的）：
//   后面还有 16 个任务（数据层守卫、界面收敛、服务端 plpgsql 校验）全部建立在这组
//   判定函数之上，都按同一组规则实现。上面各节的用例是「按函数分节」写的，高阶判定
//   （canEditTask / canEditModuleFields / canManageModule）只跑过**单一元素** res。
//   而这类实现里最危险的改动是**静默回归**：有人把 `taskMine` 的 `includes` 重构成
//   `some(...)`、或把形态判断挪走 —— 这类改动不会让上面任何一条用例变红。
//   下面用「多人 res × 四身份」的交叉矩阵把这些组合钉死：任一条被改坏都会立即转红。
//
// 注意：这里只新增用例，**未改动**上方任何既有用例。
// ============================================================
describe('跨身份交叉矩阵（多人 res × 四身份）', () => {
  // 为什么先钉住矩阵的前提：矩阵的每一行都依赖这四个常量的身份档位本身没被误标。
  //   FULL/OWNER 的 access 同为 full，区别只在 role（owner 非 admin）——这是刻意的：
  //   项目级判定（删项目/用户管理）靠 role 区分两者，任务级判定两者等价。
  it('四个身份常量的档位是矩阵的前提', () => {
    expect([FULL.access, OWNER.access, COLLAB.access, READONLY.access])
      .toEqual([ACCESS.FULL, ACCESS.FULL, ACCESS.COLLAB, ACCESS.READONLY]);
    expect(FULL.role).toBe('admin');
    expect(OWNER.role).toBe('user');
    expect(COLLAB.rname).toBe('张三');
    expect(READONLY.rname).toBe('');
  });

  // ---- 1. canEditTask × 多人 res ----
  // 挡的回归：把 taskMine 的 `t.res.includes(rname)` 改成 `t.res.some(...)` 之类的
  // 形态等价但语义漂移的写法；或把「res 为空数组 = 未分配可认领」这条放行挪到 full 分支里。
  describe('canEditTask × 多人 res', () => {
    it('res 含我（多元素）→ collab 放行', () => {
      // 挡：includes 被改成「只看第一个元素」/「要求全部匹配」等写法。
      expect(canEditTask({ res: ['张三', '李四'] }, COLLAB)).toBe(true);
    });
    it('res 不含我（多元素）→ collab 拒绝', () => {
      // 挡：把归属判断退化成「res 非空即放行」。
      expect(canEditTask({ res: ['李四', '王五'] }, COLLAB)).toBe(false);
    });
    it('res 含我（多元素）→ readonly 仍拒绝', () => {
      // 挡：把「先判 isCollab」这一层短路掉（只要归属命中就放行）。
      expect(canEditTask({ res: ['张三', '李四'] }, READONLY)).toBe(false);
    });
    it('res 不含我（多元素）→ full 仍放行', () => {
      // 挡：把 full 的全放行改成「也要归属命中」。
      expect(canEditTask({ res: ['张三', '李四'] }, FULL)).toBe(true);
    });
    it('★ res 为空（未分配）：collab 可认领、readonly 不可 —— 两者必须区分', () => {
      // 本节最关键的一条：它同时锁住两个方向。
      //   挡 A：把「未分配可认领」从 taskMine 挪进 collab 之外的档位（readonly 被误放行）。
      //   挡 B：把「未分配」当成「没有归属」直接拒绝（collab 被误拒）。
      //   只有 isCollab 这一档才够得到「未分配放行」分支 —— 这一条把这个不对称钉死。
      expect(canEditTask({ res: [] }, COLLAB)).toBe(true);
      expect(canEditTask({ res: [] }, READONLY)).toBe(false);
      expect(canEditTask({ res: [] }, FULL)).toBe(true);      // full 不受归属影响
      expect(canEditTask({ res: [] }, OWNER)).toBe(true);     // owner 等价 full
    });
  });

  // ---- 2. canEditModuleFields × 四身份 ----
  // 挡的回归：把字段级判定从「full || collab」收窄成「仅 full」，
  // 或把 collab 那条分支误接到 modMine（字段级不看归属）。
  // 四个身份必须全部显式断言 —— 只测三个的话，漏掉的那个档位被改坏不会被发现。
  describe('canEditModuleFields × 四身份', () => {
    it('full / owner / collab 都为真，readonly 为假', () => {
      expect(canEditModuleFields(FULL)).toBe(true);
      expect(canEditModuleFields(OWNER)).toBe(true);
      expect(canEditModuleFields(COLLAB)).toBe(true);
      expect(canEditModuleFields(READONLY)).toBe(false);
    });
  });

  // ---- 3. canManageModule × 归属 × 四身份 ----
  // 挡的回归：把归属级判定与字段级判定混为一谈（都返回 true）、
  // 或把「无主需求」放开给 collab（设计上无主需求只有 full 能动）。
  describe('canManageModule × 归属 × 四身份', () => {
    it('归属命中：collab 放行', () => {
      expect(canManageModule({ owner: '张三' }, COLLAB)).toBe(true);
    });
    it('归属不命中：collab 拒绝', () => {
      expect(canManageModule({ owner: '李四' }, COLLAB)).toBe(false);
    });
    it('无主需求：collab 拒绝（无主不等于可认领）', () => {
      // 与任务层的「res:[] 可认领」形成对照：任务未分配可认领，需求无主不可动。
      expect(canManageModule({}, COLLAB)).toBe(false);
    });
    it('归属命中：owner 放行（owner 等价 full，不受归属影响）', () => {
      expect(canManageModule({ owner: '李四' }, OWNER)).toBe(true);
    });
    it('归属命中：readonly 仍拒绝', () => {
      expect(canManageModule({ owner: '张三' }, READONLY)).toBe(false);
    });
  });

  // ---- 4. canTouchTask 的形态分流（显式钉死）----
  // 这是整个权限模型里最容易搞错的一处：同一个 ctx、同一个「我」，
  // 普通任务看 res、里程碑看需求归属 —— 两者结果可以相反。
  // 挡的回归：把 canTouchTask 直接写成 canEditTask（里程碑会被当成 res 缺失/未分配而误放行）。
  describe('canTouchTask 的形态分流', () => {
    it('★ 同一 collab 身份下：普通任务因 res 不含我而拒，里程碑因需求归我而放行', () => {
      const task = { res: ['李四'] };                    // 普通任务：不含我
      const ms = { m: '2026-09-09', label: '9/9 上线' }; // 里程碑：无 res
      const mo = { owner: '张三' };                      // 需求归我

      // 若 canTouchTask 退化成「直接调 canEditTask」：里程碑没有 res 数组 → taskMine 返回 false，
      // 于是里程碑会被拒（下面第一行仍为 true 即挡不住这一改法）——真正的分水岭在第二组：
      // 里程碑「无 res」既不能当成「未分配可认领」（那是任务层语义），也不能当成「无归属即拒」。
      expect(canTouchTask(task, mo, COLLAB)).toBe(false);  // 任务分支：看 res
      expect(canTouchTask(ms, mo, COLLAB)).toBe(true);     // 里程碑分支：看需求归属

      // 反向对照：需求不归我时，两条分支都拒（锁定「里程碑确实走了需求归属」而非无条件放行）
      expect(canTouchTask(ms, { owner: '李四' }, COLLAB)).toBe(false);

      // 形态判定真源：里程碑走 canEditMilestone，普通任务走 canEditTask —— 显式对齐
      expect(canTouchTask(ms, mo, COLLAB)).toBe(canEditMilestone(ms, mo, COLLAB));
      expect(canTouchTask(task, mo, COLLAB)).toBe(canEditTask(task, COLLAB));
    });
  });
});

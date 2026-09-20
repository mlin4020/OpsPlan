// 默认数据（从 gantt-data.js 迁移）
// 说明：这里集中定义排期阶段名/颜色、默认资源、默认需求、默认假期带。
// 对外提供深拷贝工厂函数，保证调用方修改返回对象不影响内部默认值。

// 阶段名（阶段 key -> 中文名）
export const PNAME = { req:"需求分析", ui:"UI设计", cfm:"需求确认", dev:"开发", sit:"测试(SIT)", uat:"UAT", go:"上线", reg:"回归测试" };
// 阶段颜色
export const PCOL  = { req:"#3b82f6", ui:"#06b6d4", cfm:"#f59e0b", dev:"#10b981", sit:"#8b5cf6", uat:"#ec4899", go:"#ef4444", reg:"#64748b" };
// 阶段 key 列表（按 PNAME 的 key 生成）
export const PHASE_LIST = Object.keys(PNAME);

// 新建需求默认初始化的阶段（按交付流程顺序）
// 回归测试（reg）是项目级「回归验证」的整体收口，不属于单个需求的交付链路，故不在默认模板内；
// PNAME/PCOL 仍保留 reg 定义，兼容历史数据（如「回归验证」需求）与单任务阶段的编辑选择。
export const MODULE_PHASES = ['req', 'ui', 'cfm', 'dev', 'sit', 'uat', 'go'];

// 上述阶段中「以里程碑（0 天单点卡点）形式初始化」的阶段：
// 需求确认是一次评审卡点，不占工期，故建为里程碑而非带周期的任务
export const MODULE_MILESTONE_PHASES = ['cfm'];

// 需求优先级（P0 最高 → P3 最低，数组顺序即严重度顺序）。
// 只用于标记与排序提示，**不参与排期计算**：优先级不改变任务的日期推算口径，
// 也不自动重排需求顺序（顺序由左侧列手工拖拽决定，自动重排会与之打架）。
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
// 新建需求的默认优先级（P2 = 中等）。历史数据没有 pri 字段时保持"未设置"，不替用户补一个假值。
export const PRIORITY_DEFAULT = 'P2';
// 归一化：只接受 P0~P3，其余（含 null/undefined/''/任意字符串）一律返回 null 表示「未设置」
export const normalizePriority = v => (PRIORITIES.includes(v) ? v : null);

// 默认资源人员列表（工作组规划器泳道 / 冲突检测用）
const RESOURCES = [
  { id:"zhangsan", name:"张三", role:"需求", color:"#3b82f6" },
  { id:"lisi",     name:"李四", role:"需求", color:"#06b6d4" },
  { id:"wangwu",   name:"王五", role:"UI",   color:"#f59e0b" },
  { id:"zhaoliu",  name:"赵六", role:"UI",   color:"#ec4899" },
  { id:"qianqi",   name:"钱七", role:"开发", color:"#10b981" },
  { id:"sunba",    name:"孙八", role:"开发", color:"#8b5cf6" },
  { id:"zhoujiu",  name:"周九", role:"开发", color:"#ef4444" },
  { id:"wushi",    name:"吴十", role:"测试", color:"#64748b" }
];

// 默认需求排期数据（结构见 gantt-data.js 注释说明）
const MODULES = [
 { name:"官网改版", tag:"冲刺中", tagc:"#ef4444", per:"全栈", pri:"P0", bars:[
   { id:"m1-req", s:"2026-08-26", e:"2026-08-28", p:"req", w:3,   done:100, res:["张三"], dep:[], manual:false, ignore:false },
   { id:"m1-ui",  s:"2026-08-26", e:"2026-08-28", p:"ui",  w:3,   done:100, res:["王五"], dep:[], manual:false, ignore:false },
   { id:"m1-cfm", s:"2026-08-31", e:"2026-08-31", p:"cfm", w:1,   done:100, res:["钱七"], dep:[{id:"m1-ui",lag:0}], manual:false, ignore:false },
   { id:"m1-dev", s:"2026-09-01", e:"2026-09-04", p:"dev", w:4,          res:["钱七"], dep:[{id:"m1-cfm",lag:0}], manual:false, ignore:false },
   { id:"m1-sit", s:"2026-09-07", e:"2026-09-07", p:"sit", w:1,          res:["吴十"], dep:[{id:"m1-dev",lag:0}], manual:false, ignore:false },
   { id:"m1-uat", s:"2026-09-08", e:"2026-09-08", p:"uat", w:1,          res:["吴十"], dep:[{id:"m1-sit",lag:0}], manual:false, ignore:false },
   { m:"2026-09-09", label:"9/9 上线" }
 ]},
 { name:"数据看板", tag:"优先启动", tagc:"#f59e0b", per:"需求1+UI1", pri:"P1", bars:[
   { id:"m2-req", s:"2026-09-03", e:"2026-09-07", p:"req", w:5,   res:["张三"], dep:[], manual:false, ignore:false },
   { id:"m2-ui",  s:"2026-09-03", e:"2026-09-07", p:"ui",  w:5,   res:["王五"], dep:[], manual:false, ignore:false },
   { id:"m2-cfm", s:"2026-09-08", e:"2026-09-08", p:"cfm", w:1,   res:["张三"], dep:[{id:"m2-req",lag:0}], manual:false, ignore:false },
   { id:"m2-dev", s:"2026-09-23", e:"2026-10-09", p:"dev", w:17,  res:["孙八"], dep:[{id:"m2-cfm",lag:0}], manual:true,  ignore:false },
   { id:"m2-sit", s:"2026-10-12", e:"2026-10-13", p:"sit", w:2,   res:["吴十"], dep:[{id:"m2-dev",lag:0}], manual:false, ignore:false },
   { id:"m2-uat", s:"2026-10-14", e:"2026-10-14", p:"uat", w:1,   res:["吴十"], dep:[{id:"m2-sit",lag:0}], manual:false, ignore:false },
   { m:"2026-10-23", label:"10/23 上线" }
 ]},
 { name:"移动端适配", tag:"开发优先", tagc:"#3b82f6", per:"需求2+UI1", pri:"P2", bars:[
   { id:"m3-req", s:"2026-09-03", e:"2026-09-07", p:"req", w:5,   res:["李四"], dep:[], manual:false, ignore:false },
   { id:"m3-ui",  s:"2026-09-08", e:"2026-09-11", p:"ui",  w:4,   res:["赵六"], dep:[{id:"m3-req",lag:0}], manual:false, ignore:false },
   { id:"m3-cfm", s:"2026-09-14", e:"2026-09-14", p:"cfm", w:1,   res:["李四"], dep:[{id:"m3-ui",lag:0}], manual:false, ignore:false },
   { id:"m3-dev", s:"2026-09-15", e:"2026-09-26", p:"dev", w:12,  res:["钱七"], dep:[{id:"m3-cfm",lag:0}], manual:false, ignore:false },
   { id:"m3-sit", s:"2026-09-28", e:"2026-09-29", p:"sit", w:2,   res:["吴十"], dep:[{id:"m3-dev",lag:0}], manual:false, ignore:false },
   { id:"m3-uat", s:"2026-09-30", e:"2026-09-30", p:"uat", w:1,   res:["吴十"], dep:[{id:"m3-sit",lag:0}], manual:false, ignore:false },
   { m:"2026-10-01", label:"10/1 上线" }
 ]},
 { name:"权限中心", tag:"顺延", tagc:"#8b5cf6", per:"需求+UI", pri:"P3", bars:[
   { id:"m4-req", s:"2026-09-09", e:"2026-09-11", p:"req", w:3,   res:["张三"], dep:[], manual:false, ignore:false },
   { id:"m4-ui",  s:"2026-09-14", e:"2026-09-15", p:"ui",  w:2,   res:["王五"], dep:[{id:"m4-req",lag:0}], manual:false, ignore:false },
   { id:"m4-cfm", s:"2026-09-16", e:"2026-09-16", p:"cfm", w:1,   res:["张三"], dep:[{id:"m4-ui",lag:0}], manual:false, ignore:false },
   { id:"m4-dev", s:"2026-10-12", e:"2026-10-23", p:"dev", w:12,  res:["周九"], dep:[{id:"m4-cfm",lag:0}], manual:false, ignore:false },
   { id:"m4-sit", s:"2026-10-26", e:"2026-10-27", p:"sit", w:2,   res:["吴十"], dep:[{id:"m4-dev",lag:0}], manual:false, ignore:false },
   { id:"m4-uat", s:"2026-10-28", e:"2026-10-28", p:"uat", w:1,   res:["吴十"], dep:[{id:"m4-sit",lag:0}], manual:false, ignore:false },
   { m:"2026-10-29", label:"10/29 上线" }
 ]},
 { name:"性能优化", tag:"顺延", tagc:"#10b981", per:"需求+UI", bars:[
   { id:"m5-req", s:"2026-09-16", e:"2026-09-22", p:"req", w:7,   res:["李四"], dep:[], manual:false, ignore:false },
   { id:"m5-ui",  s:"2026-09-23", e:"2026-09-24", p:"ui",  w:2,   res:["赵六"], dep:[{id:"m5-req",lag:0}], manual:false, ignore:false },
   { id:"m5-cfm", s:"2026-09-25", e:"2026-09-25", p:"cfm", w:1,   res:["李四"], dep:[{id:"m5-ui",lag:0}], manual:false, ignore:false },
   { id:"m5-dev", s:"2026-10-26", e:"2026-11-03", p:"dev", w:9,   res:["周九"], dep:[{id:"m5-cfm",lag:0}], manual:false, ignore:false },
   { id:"m5-sit", s:"2026-11-04", e:"2026-11-05", p:"sit", w:2,   res:["吴十"], dep:[{id:"m5-dev",lag:0}], manual:false, ignore:false },
   { id:"m5-uat", s:"2026-11-06", e:"2026-11-06", p:"uat", w:1,   res:["吴十"], dep:[{id:"m5-sit",lag:0}], manual:false, ignore:false },
   { m:"2026-11-10", label:"11/10 上线" }
 ]},
 { name:"回归验证", tag:"收官", tagc:"#64748b", per:"全员", bars:[
   { id:"m6-reg", s:"2026-11-11", e:"2026-11-12", p:"reg", w:2,
     res:["张三","李四","王五","赵六","钱七","孙八","周九","吴十"],
     dep:[{id:"m1-uat",lag:1},{id:"m2-uat",lag:1},{id:"m3-uat",lag:1},{id:"m4-uat",lag:1},{id:"m5-uat",lag:1}],
     manual:false, ignore:false },
   { m:"2026-11-13", label:"11/13 整体上线" }
 ]}
];

// 默认假期带（元素含 Date 对象）
const HOLIDAYS = [
  { s:new Date(2026,8,25), e:new Date(2026,8,27), n:"中秋" },
  { s:new Date(2026,9,1),  e:new Date(2026,9,7),  n:"国庆" }
];

// 深拷贝工厂：返回 MODULES 的深拷贝（源数据无 Date，JSON 深拷贝即可）
export function defaultModules() {
  return JSON.parse(JSON.stringify(MODULES));
}

// 返回 RESOURCES 深拷贝
export function defaultResources() {
  return JSON.parse(JSON.stringify(RESOURCES));
}

// 返回 HOLIDAYS 深拷贝；元素含 Date 对象，JSON 深拷贝后需重建 Date
export function defaultHolidays() {
  return HOLIDAYS.map(h => ({
    s: new Date(h.s.getFullYear(), h.s.getMonth(), h.s.getDate()),
    e: new Date(h.e.getFullYear(), h.e.getMonth(), h.e.getDate()),
    n: h.n
  }));
}

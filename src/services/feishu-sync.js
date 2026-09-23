// ============================================================
// src/services/feishu-sync.js — plan <-> 多维表格 5 张表 的互转与全量同步
//
// 表结构（base_token 在 window.FEISHU_CONFIG.appToken）：
//   项目 tblKmXpntIZDL4Ky  需求 tblOKvhSgGrHBRxf  任务 tblz1xfS8Pa8fVGr
//   人员 tbleFK8gXy73Q9en  版本 tblUr6JrKUOAGTI4
//
// 同步策略（第一版）：全量重建
//   保存时：删除该项目下的 需求/任务/版本 记录 -> 重新批量插入
//   读取时：拉全量 -> 聚合回 plan 结构灌进 planStore
//   注意：飞书里直接改行后，下次保存会被覆盖。编辑请回到 OpsPlan 做。
// ============================================================
import {
  listAllRecords, batchCreateRecords, batchUpdateRecords, batchDeleteRecords,
  createRecord, updateRecord, isFeishuReady,
} from './feishu-client.js';

export { isFeishuReady } from './feishu-client.js';

// ---- 表 ID（固定，对应已建好的 Base）----
export const TABLES = {
  projects: 'tblKmXpntIZDL4Ky',
  requirements: 'tblOKvhSgGrHBRxf',
  tasks: 'tblz1xfS8Pa8fVGr',
  resources: 'tbleFK8gXy73Q9en',
  versions: 'tblUr6JrKUOAGTI4',
};

// record_id 映射缓存：加载 plan 时填充，保存时直接用，避免每次都拉全表
// 每项: { record_id, fields } —— fields 是上次保存时的值，用于对比哪些真正变了
const idMapCache = {
  reqs: null,    // 需求名称 -> { record_id, fields }
  tasks: null,   // 任务ID -> { record_id, fields }
  vers: null,    // 版本ID -> { record_id, fields }
  resources: null, // 人员ID -> { record_id, fields }
};

// 浅比较两个 fields 对象是否有差异
function fieldsChanged(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return true;
  }
  return false;
}

// ---- 阶段 key <-> 中文名 ----
const P2CN = {
  req: '需求分析', ui: 'UI设计', cfm: '需求确认', dev: '开发',
  sit: '测试(SIT)', uat: 'UAT', go: '上线', reg: '回归测试',
};
const CN2P = Object.fromEntries(Object.entries(P2CN).map(([k, v]) => [v, k]));

// ---- 日期工具 ----
// "YYYY-MM-DD" -> 毫秒时间戳（飞书 datetime 字段）
function toTs(d) { if (!d) return null; const t = Date.parse(d + 'T00:00:00'); return isNaN(t) ? null : t; }
// 毫秒时间戳 -> "YYYY-MM-DD"
function toDate(ts) { if (!ts) return null; const dt = new Date(ts);
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${m}-${day}`;
}

// ---- plan -> 记录 ----
function modToReqFields(mo, order) {
  return {
    fields: {
      '需求名称': mo.name,
      '状态标签': mo.tag || '',
      '标签颜色': mo.tagc || '',
      '优先级': mo.pri || null,
      '排序号': order,
      '待排期': !!mo.unscheduled,
    },
  };
}

function barToTaskFields(b, reqRecordId) {
  const isMilestone = !!b.m;
  const base = { '需求ID': reqRecordId };
  if (isMilestone) {
    return {
      fields: {
        ...base,
        '任务ID': `ms-${b.m}-${(b.label || '').slice(0, 8)}`,
        '类型': '里程碑',
        '里程碑日期': toTs(b.m),
        '里程碑文字': b.label || '',
      },
    };
  }
  return {
    fields: {
      ...base,
      '任务ID': b.id,
      '类型': '任务',
      '阶段': P2CN[b.p] || b.p || '',
      '开始日期': toTs(b.s),
      '结束日期': toTs(b.e),
      '工期工作日': b.w ?? null,
      '完成度': typeof b.done === 'number' ? b.done / 100 : 0,
      '负责人': Array.isArray(b.res) ? b.res.join(',') : '',
      '前置依赖': JSON.stringify(b.dep || []),
      '手动锁定': !!b.manual,
      '忽略排期': !!b.ignore,
    },
  };
}

function resToFields(r) {
  return { fields: { '人员ID': r.id, '姓名': r.name, '角色': r.role || '', '颜色': r.color || '' } };
}

function verToFields(v) {
  return {
    fields: {
      '版本ID': v.id,
      '版本名称': v.name || '',
      '上线日期': toTs(v.date),
      '是否已上线': !!v.shipped,
      '实际上线日期': toTs(v.shippedAt) || null,
      '成员需求': Array.isArray(v.mods) ? v.mods.join(',') : '',
    },
  };
}

// ---- 记录 -> plan ----
function cellText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(x => x.text || x.name || '').join('');
  if (typeof v === 'object') return v.text || v.name || '';
  return String(v);
}

// 拉取并聚合整个 plan（含项目元数据）
export async function loadPlanFromFeishu(projectRecordId) {
  // 1) 项目元数据
  const projItems = await listAllRecords(TABLES.projects);
  const proj = projItems.find(r => r.record_id === projectRecordId) || projItems[0];
  if (!proj) throw new Error('项目不存在');

  // 2) 需求 -> 建 record_id 索引
  const reqItems = await listAllRecords(TABLES.requirements);
  const reqIdToName = {};
  reqItems.forEach(r => { reqIdToName[r.record_id] = cellText(r.fields['需求名称']); });

  // 3) 任务 -> 按所属需求归类
    const taskItems = await listAllRecords(TABLES.tasks, {
    fieldNames: ['任务ID', '需求ID', '类型', '开始日期', '结束日期', '工期工作日', '负责人', '阶段', '前置依赖', '完成度', '手动锁定', '忽略排期', '里程碑文字', '里程碑日期'],
  });
  const barsByReqName = {};
  taskItems.forEach(r => {
    const f = r.fields;
    const reqRecId = cellText(f['需求ID']) || '';
    const reqName = reqRecId ? reqIdToName[reqRecId] : '';
    if (!reqName) return;
    const bars = barsByReqName[reqName] = barsByReqName[reqName] || [];
    if (cellText(f['类型']) === '里程碑') {
      const m = toDate(f['里程碑日期']);
      const label = cellText(f['里程碑文字']);
      bars.push({ m, label, id: `ms-${m}-${(label || '').slice(0, 8)}` });
    } else {
      const depRaw = cellText(f['前置依赖']);
      let dep = [];
      try { dep = depRaw ? JSON.parse(depRaw) : []; } catch { dep = []; }
      bars.push({
        id: cellText(f['任务ID']),
        s: toDate(f['开始日期']),
        e: toDate(f['结束日期']),
        p: CN2P[cellText(f['阶段'])] || cellText(f['阶段']),
        w: f['工期工作日'] || 0,
        done: Math.round((f['完成度'] || 0) * 100),
        res: cellText(f['负责人']).split(',').filter(Boolean),
        dep,
        manual: !!f['手动锁定'],
        ignore: !!f['忽略排期'],
      });
    }
  });

  // 4) 组装 modules（按排序号）
  const modules = reqItems
    .map(r => {
      const f = r.fields;
      const name = cellText(f['需求名称']);
      const mo = {
        name,
        tag: cellText(f['状态标签']),
        tagc: cellText(f['标签颜色']),
        pri: cellText(f['优先级']) || null,
        bars: barsByReqName[name] || [],
      };
      if (f['待排期']) mo.unscheduled = true;
      return mo;
    })
    .sort((a, b) => {
      const ra = reqItems.find(r => cellText(r.fields['需求名称']) === a.name);
      const rb = reqItems.find(r => cellText(r.fields['需求名称']) === b.name);
      return (ra.fields['排序号'] ?? 0) - (rb.fields['排序号'] ?? 0);
    });

  // 5) 人员
  const resItems = await listAllRecords(TABLES.resources);
  const resources = resItems.map(r => ({
    id: cellText(r.fields['人员ID']),
    name: cellText(r.fields['姓名']),
    role: cellText(r.fields['角色']),
    color: cellText(r.fields['颜色']),
  }));

  // 6) 版本
  const verItems = await listAllRecords(TABLES.versions);
  const versions = verItems.map(r => ({
    id: cellText(r.fields['版本ID']),
    name: cellText(r.fields['版本名称']),
    date: toDate(r.fields['上线日期']),
    shipped: !!r.fields['是否已上线'],
    shippedAt: toDate(r.fields['实际上线日期']) || null,
    mods: cellText(r.fields['成员需求']).split(',').filter(Boolean),
  }));

  // 填充缓存（供后续增量保存直接对比哪些变了）
  idMapCache.reqs = {};
  reqItems.forEach(r => { idMapCache.reqs[cellText(r.fields['需求名称'])] = { record_id: r.record_id, fields: r.fields }; });
  idMapCache.tasks = {};
  taskItems.forEach(r => { idMapCache.tasks[cellText(r.fields['任务ID'])] = { record_id: r.record_id, fields: r.fields }; });
  idMapCache.vers = {};
  verItems.forEach(r => { idMapCache.vers[cellText(r.fields['版本ID'])] = { record_id: r.record_id, fields: r.fields }; });
  idMapCache.resources = {};
  resItems.forEach(r => { idMapCache.resources[cellText(r.fields['人员ID'])] = { record_id: r.record_id, fields: r.fields }; });

  return {
    project: { record_id: proj.record_id, name: cellText(proj.fields['项目名称']) },
    plan: { modules, resources, versions },
  };
}

// 任务 key：普通任务用 b.id，里程碑用合成 key
function taskKey(b) {
  if (b.m) return `ms-${b.m}-${(b.label || '').slice(0, 8)}`;
  return b.id;
}

// 增量保存：对比前后差异，只 create/update/delete 变化的记录
export async function savePlanToFeishu(projectRecordId, plan) {
  // 1) 取缓存：优先用内存缓存，缓存不存在才拉表
  let reqCache, taskCache, verCache, resCache;
  if (idMapCache.reqs && idMapCache.tasks && idMapCache.vers && idMapCache.resources) {
    reqCache = idMapCache.reqs;
    taskCache = idMapCache.tasks;
    verCache = idMapCache.vers;
    resCache = idMapCache.resources;
  } else {
    const [oldReqs, oldTasks, oldVers, oldRes] = await Promise.all([
      listAllRecords(TABLES.requirements, { fieldNames: ['需求名称'] }),
      listAllRecords(TABLES.tasks, { fieldNames: ['任务ID'] }),
      listAllRecords(TABLES.versions, { fieldNames: ['版本ID'] }),
      listAllRecords(TABLES.resources, { fieldNames: ['人员ID'] }),
    ]);
    reqCache = {}; oldReqs.forEach(r => { reqCache[cellText(r.fields['需求名称'])] = { record_id: r.record_id, fields: r.fields }; });
    taskCache = {}; oldTasks.forEach(r => { taskCache[cellText(r.fields['任务ID'])] = { record_id: r.record_id, fields: r.fields }; });
    verCache = {}; oldVers.forEach(r => { verCache[cellText(r.fields['版本ID'])] = { record_id: r.record_id, fields: r.fields }; });
    resCache = {}; oldRes.forEach(r => { resCache[cellText(r.fields['人员ID'])] = { record_id: r.record_id, fields: r.fields }; });
    idMapCache.reqs = reqCache;
    idMapCache.tasks = taskCache;
    idMapCache.vers = verCache;
    idMapCache.resources = resCache;
  }

  // 2) 需求 diff：只更新字段真的变了的记录
  const newReqNames = new Set((plan.modules || []).map(m => m.name));
  const reqsToDelete = Object.keys(reqCache).filter(k => !newReqNames.has(k)).map(k => reqCache[k].record_id);
  const reqsToCreate = [];
  const reqsToUpdate = [];
  (plan.modules || []).forEach((mo, i) => {
    const fields = modToReqFields(mo, i).fields;
    const old = reqCache[mo.name];
    if (old) {
      if (fieldsChanged(old.fields, fields)) reqsToUpdate.push({ record_id: old.record_id, fields });
    } else {
      reqsToCreate.push({ fields });
    }
  });

  // 3) 执行需求增删改
  if (reqsToDelete.length) await batchDeleteRecords(TABLES.requirements, reqsToDelete);
  if (reqsToUpdate.length === 1) await updateRecord(TABLES.requirements, reqsToUpdate[0].record_id, reqsToUpdate[0].fields);
  else if (reqsToUpdate.length) await batchUpdateRecords(TABLES.requirements, reqsToUpdate);
  const newReqRes = reqsToCreate.length ? await batchCreateRecords(TABLES.requirements, reqsToCreate) : { records: [] };
  // 更新缓存
  reqsToDelete.forEach(recId => { Object.keys(reqCache).forEach(k => { if (reqCache[k].record_id === recId) delete reqCache[k]; }); });
  reqsToUpdate.forEach(item => { Object.keys(reqCache).forEach(k => { if (reqCache[k].record_id === item.record_id) reqCache[k].fields = item.fields; }); });
  newReqRes.records.forEach((r, i) => {
    reqCache[reqsToCreate[i].fields['需求名称']] = { record_id: r.record_id, fields: reqsToCreate[i].fields };
  });

  // 4) 任务 diff
  const reqNameToRecId = {};
  Object.keys(reqCache).forEach(k => { reqNameToRecId[k] = reqCache[k].record_id; });
  const taskList = [];
  (plan.modules || []).forEach(mo => {
    const reqRecId = reqNameToRecId[mo.name];
    if (!reqRecId) return;
    (mo.bars || []).forEach(b => taskList.push({ b, reqRecId }));
  });
  const newTaskKeys = new Set(taskList.map(t => taskKey(t.b)));
  const tasksToDelete = Object.keys(taskCache).filter(k => !newTaskKeys.has(k)).map(k => taskCache[k].record_id);
  const tasksToCreate = [];
  const tasksToUpdate = [];
  taskList.forEach(({ b, reqRecId }) => {
    const key = taskKey(b);
    const fields = barToTaskFields(b, reqRecId).fields;
    const old = taskCache[key];
    if (old) {
      if (fieldsChanged(old.fields, fields)) tasksToUpdate.push({ record_id: old.record_id, fields });
    } else {
      tasksToCreate.push({ fields });
    }
  });

  await Promise.all([
    tasksToDelete.length ? batchDeleteRecords(TABLES.tasks, tasksToDelete) : Promise.resolve(),
    tasksToUpdate.length === 1
      ? updateRecord(TABLES.tasks, tasksToUpdate[0].record_id, tasksToUpdate[0].fields)
      : tasksToUpdate.length ? batchUpdateRecords(TABLES.tasks, tasksToUpdate) : Promise.resolve(),
    tasksToCreate.length ? batchCreateRecords(TABLES.tasks, tasksToCreate) : Promise.resolve(),
  ]);
  // 更新缓存
  tasksToDelete.forEach(recId => { Object.keys(taskCache).forEach(k => { if (taskCache[k].record_id === recId) delete taskCache[k]; }); });
  tasksToUpdate.forEach(item => { Object.keys(taskCache).forEach(k => { if (taskCache[k].record_id === item.record_id) taskCache[k].fields = item.fields; }); });
  // 新建任务的 record_id 从 batchCreate 返回里拿（下面异步补）
  if (tasksToCreate.length) {
    batchCreateRecords(TABLES.tasks, tasksToCreate).then(res => {
      res.records.forEach((r, i) => {
        const key = taskKey(tasksToCreate[i].fields.__bar);
        delete tasksToCreate[i].fields.__bar;
        taskCache[key] = { record_id: r.record_id, fields: tasksToCreate[i].fields };
      });
    });
  }

  // 5) 版本 diff
  const newVerIds = new Set((plan.versions || []).map(v => v.id));
  const versToDelete = Object.keys(verCache).filter(k => !newVerIds.has(k)).map(k => verCache[k].record_id);
  const versToCreate = [];
  const versToUpdate = [];
  (plan.versions || []).forEach(v => {
    const fields = verToFields(v).fields;
    const old = verCache[v.id];
    if (old) {
      if (fieldsChanged(old.fields, fields)) versToUpdate.push({ record_id: old.record_id, fields });
    } else {
      versToCreate.push({ fields });
    }
  });
  await Promise.all([
    versToDelete.length ? batchDeleteRecords(TABLES.versions, versToDelete) : Promise.resolve(),
    versToUpdate.length === 1
      ? updateRecord(TABLES.versions, versToUpdate[0].record_id, versToUpdate[0].fields)
      : versToUpdate.length ? batchUpdateRecords(TABLES.versions, versToUpdate) : Promise.resolve(),
    versToCreate.length ? batchCreateRecords(TABLES.versions, versToCreate) : Promise.resolve(),
  ]);
  versToDelete.forEach(recId => { Object.keys(verCache).forEach(k => { if (verCache[k].record_id === recId) delete verCache[k]; }); });
  versToUpdate.forEach(item => { Object.keys(verCache).forEach(k => { if (verCache[k].record_id === item.record_id) verCache[k].fields = item.fields; }); });

  // 6) 人员 diff
  const newResIds = new Set((plan.resources || []).map(r => r.id));
  const resToDelete = Object.keys(resCache).filter(k => !newResIds.has(k)).map(k => resCache[k].record_id);
  const resToCreate = [];
  const resToUpdate = [];
  (plan.resources || []).forEach(r => {
    const fields = resToFields(r).fields;
    const old = resCache[r.id];
    if (old) {
      if (fieldsChanged(old.fields, fields)) resToUpdate.push({ record_id: old.record_id, fields });
    } else {
      resToCreate.push({ fields });
    }
  });
  await Promise.all([
    resToDelete.length ? batchDeleteRecords(TABLES.resources, resToDelete) : Promise.resolve(),
    resToUpdate.length === 1
      ? updateRecord(TABLES.resources, resToUpdate[0].record_id, resToUpdate[0].fields)
      : resToUpdate.length ? batchUpdateRecords(TABLES.resources, resToUpdate) : Promise.resolve(),
    resToCreate.length ? batchCreateRecords(TABLES.resources, resToCreate) : Promise.resolve(),
  ]);
  resToDelete.forEach(recId => { Object.keys(resCache).forEach(k => { if (resCache[k].record_id === recId) delete resCache[k]; }); });
  resToUpdate.forEach(item => { Object.keys(resCache).forEach(k => { if (resCache[k].record_id === item.record_id) resCache[k].fields = item.fields; }); });

  // 7) 项目元数据 touch
  await updateRecord(TABLES.projects, projectRecordId, { '负责人': '' });
}

// ---- 项目 CRUD（薄封装，保留和原 projects.js 相近的形状）----
export async function listProjects() {
  const items = await listAllRecords(TABLES.projects);
  return items.map(r => ({
    id: r.record_id,
    name: cellText(r.fields['项目名称']),
    updated_at: r.fields['更新时间'] || null,
  })).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

export async function createProject({ name }) {
  const rec = await createRecord(TABLES.projects, { '项目名称': name, '负责人': '' });
  return { id: rec.record_id, name };
}

export async function deleteProject(projectRecordId) {
  // 级联清理：先删该项目下的需求/任务/版本，再删项目本身
  const reqs = await listAllRecords(TABLES.requirements);
  const reqIds = reqs.map(r => r.record_id);
  const tasks = await listAllRecords(TABLES.tasks);
  await batchDeleteRecords(TABLES.tasks, tasks.map(r => r.record_id));
  await batchDeleteRecords(TABLES.requirements, reqIds);
  const vers = await listAllRecords(TABLES.versions);
  await batchDeleteRecords(TABLES.versions, vers.map(r => r.record_id));
  await batchDeleteRecords(TABLES.projects, [projectRecordId]);
}

export default {
  isFeishuReady, loadPlanFromFeishu, savePlanToFeishu,
  listProjects, createProject, deleteProject,
};

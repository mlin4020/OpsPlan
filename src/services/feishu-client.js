// ============================================================
// src/services/feishu-client.js — 飞书多维表格 HTTP 客户端
// 经 Cloudflare Worker 中转，Worker 负责注入 tenant_access_token。
// 配置：window.FEISHU_CONFIG = { bridgeUrl, appToken }
//   bridgeUrl  = Worker 地址，如 https://opsplan-feishu-bridge.xxx.workers.dev
//   appToken   = 多维表格 app_token（GbWXb263UahpHRsh6FmcloncnV3）
// ============================================================

function config() {
  return (typeof window !== 'undefined' && window.FEISHU_CONFIG) || {};
}

export function isFeishuReady() {
  const c = config();
  return !!(c.bridgeUrl && c.appToken);
}

// 拼请求 URL：/bitable/v1/apps/{app}/tables/{table}/records...
function pathToUrl(path) {
  const { bridgeUrl, appToken } = config();
  const base = bridgeUrl.replace(/\/+$/, '');
  // 把 {app_token} 占位替换成实际值
  const p = path.replace('{app_token}', appToken);
  return `${base}/api${p}`;
}

async function request(method, path, body) {
  const resp = await fetch(pathToUrl(path), {
    method,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { code: -1, msg: 'bad json', raw: text }; }
  if (data.code !== 0) {
    const err = new Error(data.msg || `feishu api error ${data.code}`);
    err.code = data.code;
    err.data = data;
    throw err;
  }
  return data.data;
}

// 分页拉全量 records；field_names 只返回指定字段（减少数据量，加速）
export async function listAllRecords(tableId, { filter, fieldNames } = {}) {
  const out = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ page_size: '500' });
    if (filter) q.set('filter', filter);
    if (fieldNames && fieldNames.length) q.set('field_names', JSON.stringify(fieldNames));
    if (pageToken) q.set('page_token', pageToken);
    const data = await request('GET',
      `/bitable/v1/apps/{app_token}/tables/${tableId}/records?${q.toString()}`);
    (data.items || []).forEach(r => out.push(r));
    pageToken = data.has_more ? data.page_token : '';
  } while (pageToken);
  return out;
}

export async function batchCreateRecords(tableId, records) {
  // 飞书单批最多 1000 条；这里分 200 一片，聚合所有返回的 records
  const chunks = [];
  for (let i = 0; i < records.length; i += 200) chunks.push(records.slice(i, i + 200));
  const all = [];
  for (const chunk of chunks) {
    const data = await request('POST',
      `/bitable/v1/apps/{app_token}/tables/${tableId}/records/batch_create`,
      { records: chunk });
    (data.records || []).forEach(r => all.push(r));
  }
  return { records: all };
}

export function batchDeleteRecords(tableId, recordIds) {
  if (!recordIds.length) return Promise.resolve();
  const chunks = [];
  for (let i = 0; i < recordIds.length; i += 200) chunks.push(recordIds.slice(i, i + 200));
  return chunks.reduce((p, ids) =>
    p.then(() => request('POST',
      `/bitable/v1/apps/{app_token}/tables/${tableId}/records/batch_delete`,
      { records: ids })),
    Promise.resolve());
}

export function updateRecord(tableId, recordId, fields) {
  return request('PUT',
    `/bitable/v1/apps/{app_token}/tables/${tableId}/records/${recordId}`,
    { fields });
}

// 批量更新：每条记录可以有不同 fields
export async function batchUpdateRecords(tableId, records) {
  if (!records.length) return { records: [] };
  const chunks = [];
  for (let i = 0; i < records.length; i += 200) chunks.push(records.slice(i, i + 200));
  const all = [];
  for (const chunk of chunks) {
    const data = await request('POST',
      `/bitable/v1/apps/{app_token}/tables/${tableId}/records/batch_update`,
      { records: chunk });
    (data.records || []).forEach(r => all.push(r));
  }
  return { records: all };
}

export function createRecord(tableId, fields) {
  return request('POST',
    `/bitable/v1/apps/{app_token}/tables/${tableId}/records`,
    { fields });
}

export default { isFeishuReady, listAllRecords, batchCreateRecords, batchDeleteRecords, updateRecord, createRecord };

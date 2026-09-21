// 排期状态管理：替代直接读写 window.MODULES/RESOURCES/START/END
// 渲染层与调度引擎通过 subscribe 感知变更
import { DEFAULT_START, DEFAULT_END } from '../core/constants.js';

// versions：版本（迭代）列表。顶层数组，**不在 modules 里**（版本是独立实体，需求只是成员）。
// ⚠️ 所有序列化出口都是白名单式的，加字段必须逐处补（同步 / 本地 / 导入导出 / 撤销），
//    详见本文件与 services/plan-sync.js、scheduler/{persistence,history}.js。
export const planStore = {
  state: { modules: [], resources: [], versions: [], start: DEFAULT_START, end: DEFAULT_END, calcVer: 5 },
  _listeners: new Set(),
  subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); },
  set(patch) { Object.assign(this.state, patch); this.emit(); },
  reset() {
    this.state = { modules: [], resources: [], versions: [], start: DEFAULT_START, end: DEFAULT_END, calcVer: 5 };
    this.emit();
  },
  emit() { this._listeners.forEach(fn => { try { fn(this.state); } catch (e) {} }); }
};

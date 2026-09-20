// 排期状态管理：替代直接读写 window.MODULES/RESOURCES/START/END
// 渲染层与调度引擎通过 subscribe 感知变更
import { DEFAULT_START, DEFAULT_END } from '../core/constants.js';

export const planStore = {
  state: { modules: [], resources: [], start: DEFAULT_START, end: DEFAULT_END, calcVer: 5 },
  _listeners: new Set(),
  subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); },
  set(patch) { Object.assign(this.state, patch); this.emit(); },
  reset() {
    this.state = { modules: [], resources: [], start: DEFAULT_START, end: DEFAULT_END, calcVer: 5 };
    this.emit();
  },
  emit() { this._listeners.forEach(fn => { try { fn(this.state); } catch (e) {} }); }
};

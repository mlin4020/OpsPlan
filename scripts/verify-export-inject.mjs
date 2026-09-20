// 临时验证脚本：模拟 utils/export.js 的注入流程，生成注入测试数据的导出文件
// 两种场景：空白项目（modules=[]，应显示空态）与有数据项目（应渲染模块）
import { readFileSync, writeFileSync } from 'node:fs';
import { injectPlanData } from '../src/utils/export.js';

const tpl = readFileSync('public/export-template.html', 'utf-8');

// 场景1：空白项目导出（modules 为空数组 → 打开后不应出现默认"官网改版"）
const emptyPlan = {
  v: 1,
  name: '空白项目验证',
  savedAt: 1755744000000,
  savedBy: '测试导出',
  start: '2026-08-12',
  end: '2026-10-31',
  modules: [],
  resources: []
};

// 场景2：有数据项目导出（单个模块，验证只读渲染）
const dataPlan = {
  v: 1,
  name: '注入验证项目',
  savedAt: 1755744000000,
  savedBy: '测试导出',
  start: '2026-08-12',
  end: '2026-10-31',
  modules: [
    {
      name: '注入验证模块',
      tag: '测试',
      tagc: '#3b82f6',
      per: '开发1',
      bars: [
        { id: 'inj-dev', s: '2026-09-01', e: '2026-09-05', p: 'dev', w: 5, res: ['张三'], dep: [], manual: false, ignore: false }
      ]
    }
  ],
  resources: [{ id: 'zhangsan', name: '张三', role: '开发', color: '#10b981' }]
};

for (const [key, plan] of [['empty', emptyPlan], ['data', dataPlan]]) {
  const out = injectPlanData(tpl, plan);
  writeFileSync(`public/export-${key}.html`, out, 'utf-8');
  console.log(`[${key}] injected size: ${out.length}`);
  console.log(`[${key}] name injected: ${out.indexOf(plan.name) !== -1}`);
}
console.log('DONE');

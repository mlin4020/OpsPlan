// export.js 单文件导出工具测试
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildExportPayload, injectPlanData, fetchExportTemplate, buildExportHTML } from '../src/utils/export.js';

describe('buildExportPayload', () => {
  it('组装含时间窗口与数据的注入载荷', () => {
    const payload = buildExportPayload({
      name: '示例项目',
      modules: [{ name: 'M', bars: [] }],
      resources: [{ id: 'r1', name: '张三' }],
      start: new Date(2026, 7, 12),
      end: new Date(2026, 9, 31),
      savedBy: 'a@b.com'
    });
    expect(payload).toMatchObject({
      v: 1, name: '示例项目', savedBy: 'a@b.com',
      start: '2026-08-12', end: '2026-10-31',
      modules: [{ name: 'M', bars: [] }],
      resources: [{ id: 'r1', name: '张三' }]
    });
  });

  it('name 缺省为空字符串', () => {
    const payload = buildExportPayload({ modules: [], resources: [] });
    expect(payload.name).toBe('');
  });

  it('start/end 缺失时不输出该字段', () => {
    const payload = buildExportPayload({ modules: [], resources: [], start: null, end: null });
    expect(payload.start).toBeUndefined();
    expect(payload.end).toBeUndefined();
  });
});

describe('injectPlanData', () => {
  const tpl = '<html><body><script type="application/json" id="plan-data">__PLAN_DATA__</script></body></html>';

  it('替换 #plan-data 注入点占位符', () => {
    const out = injectPlanData(tpl, { modules: [], v: 1 });
    expect(out).toContain('id="plan-data">{"modules":[],"v":1}</script>');
    expect(out).not.toContain('__PLAN_DATA__');
  });

  it('防御 </script> 闭合：转义为 <\\/script>', () => {
    // 任务名里含 </script> 时不会被当作 HTML 闭合
    const payload = { modules: [{ name: 'M', bars: [{ name: '</script><b>x</b>' }] }], v: 1 };
    const out = injectPlanData(tpl, payload);
    // JSON 序列化中 </ 被转义为 <\/
    expect(out).toContain('<\\/script>');
    expect(out).not.toContain('"</script>"');
  });

  it('缺少注入点锚点时报错', () => {
    expect(() => injectPlanData('<html>no anchor</html>', {})).toThrow('缺少 #plan-data 注入点');
  });
});

describe('fetchExportTemplate / buildExportHTML', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('buildExportHTML 拉取模板并注入数据', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html><script type="application/json" id="plan-data">__PLAN_DATA__</script></html>')
    });
    const out = await buildExportHTML({ modules: [], v: 1 });
    expect(fetchSpy).toHaveBeenCalledWith('export-template.html', expect.anything());
    expect(out).toContain('id="plan-data">');
  });

  it('模板加载失败（非 ok）时抛错', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 404 });
    await expect(buildExportHTML({})).rejects.toThrow('导出模板加载失败');
  });
});

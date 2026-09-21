// 移动端版式测试：把「PC / 移动两套 UI」的骨架与关键断点规则钉住，
// 防止后续改动把手机端悄悄退回成"缩小版桌面"（进度条挤成一团、需求名被裁、抽屉关不掉）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildShellHTML, buildViewerShellHTML } from '../src/components/shell.js';
import { F } from '../src/core/dates.js';
import { defaultModules, defaultResources, defaultHolidays } from '../src/core/default-data.js';
import { renderReportView } from '../src/views/report-view.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(ROOT, 'src/styles/gantt.css'), 'utf8');

// 取出手机端主样式块（文件末尾那个 ≤767px 断点，而非散落在总览小节里的 .rmod-grid 断点）
// 用正则而非字面量：构建压缩会把 `@media(` 规范成 `@media (`，
// 写死空格的断言会让整个套件在收集阶段就挂掉（曾经如此），和样式正确性无关。
function phoneCss() {
  const re = /@media\s*\(max-width:\s*767px\)\s*\{/g;
  let start = -1, m;
  while ((m = re.exec(css)) !== null) start = m.index;
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) return css.slice(start, i + 1); }
  }
  throw new Error('未找到 ≤767px 断点闭合位置');
}

function makeCtx() {
  const state = {
    modules: defaultModules(),
    resources: defaultResources(),
    start: F('2026-08-12'),
    end: F('2026-10-31')
  };
  return {
    state,
    sched: {
      tasks: () => [], problems: () => [], cycleTasks: () => [], tasksById: () => ({}),
      diff: (a, b) => Math.round((a - b) / 864e5),
      addDays: (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
    },
    holidays: defaultHolidays(),
    today: F('2026-09-01'),
    dayW: 34,
    zoom: 0,
    collapsed: {},
    fmtD: d => (d.getMonth() + 1) + '/' + d.getDate(),
    modRange: mo => {
      let s = null, e = null;
      mo.bars.forEach(b => {
        if (b.m) return;
        const d = F(b.s); if (!s || d < s) s = d;
        const de = F(b.e); if (!e || de > e) e = de;
      });
      return s && e ? { start: s, end: e } : null;
    },
    workday: {
      spanDays: (s, e) => Math.round((F(e) - F(s)) / 864e5) + 1,
      workDays: (s, e) => {
        let n = 0; const d = F(s); const end = F(e);
        while (d <= end) { const w = d.getDay(); if (w !== 0 && w !== 6) n++; d.setDate(d.getDate() + 1); }
        return n;
      }
    },
    X: d => Math.round((d - state.start) / 864e5) * 34
  };
}

describe('移动端：排期页骨架', () => {
  const html = buildShellHTML();

  it('提供底部标签导航（三个视图 + 更多）', () => {
    expect(html).toContain('class="mnav"');
    ['report', 'mod', 'res'].forEach(v => {
      expect(html).toMatch(new RegExp(`mnav-item"[^>]*data-view="${v}"`));
    });
    expect(html).toContain('id="mMore"');
  });

  it('高频操作进标题栏右上角（＋任务 / 排期问题），不再单开白色操作条', () => {
    expect(html).toContain('class="hero-acts"');
    expect(html).toContain('id="mAddTask"');
    expect(html).toContain('id="mProblems"');
    // 移动端问题徽标与桌面徽标分开，避免同一 id 重复导致其中一处永远不更新
    expect(html).toContain('id="probCountM"');
    // 白色独立操作条已废弃
    expect(html).not.toContain('class="mbar"');
  });

  it('缩放 / 定位今天收进「更多」弹层（用 data-act，无桌面按钮可代理）', () => {
    ['zoom-out', 'zoom-in', 'go-today'].forEach(a => {
      expect(html).toContain(`data-act="${a}"`);
    });
  });

  it('「更多」弹层用 data-proxy 代理桌面按钮，新增操作无需重写业务逻辑', () => {
    expect(html).toContain('id="mSheet"');
    ['btnAddModule', 'btnAddTask', 'btnAutoPlan', 'btnProblems', 'expAll', 'colAll', 'btnUndo', 'btnRedo', 'btnResLib', 'btnExport', 'btnExportHTML', 'btnImport']
      .forEach(p => expect(html).toContain(`data-proxy="${p}"`));
    // 服务器相关操作在未进入项目时不展示
    expect(html).toContain('data-proxy="btnBackList" data-server-only');
  });

  it('导出只读查看器复用底部导航，但不给「更多」（无编辑操作）', () => {
    const viewer = buildViewerShellHTML();
    expect(viewer).toContain('class="mnav"');
    expect(viewer).not.toContain('id="mMore"');
  });
});

describe('移动端：抽屉可关闭', () => {
  const html = buildShellHTML();

  it('三个抽屉（任务详情 / 排期问题 / 需求表单）都带拖拽手柄和带文字的关闭按钮', () => {
    // 每个抽屉各一个手柄 + 一个「× 关闭」按钮
    expect(html.match(/class="drawer-grab"/g)).toHaveLength(3);
    expect(html.match(/class="close-txt">关闭</g)).toHaveLength(3);
    expect(html).toContain('id="btnCloseTaskDrawer"');
    expect(html).toContain('id="btnCloseDrawer"');
    expect(html).toContain('id="btnCloseModDrawer"');
  });

  it('新增/编辑需求是抽屉而不是弹窗（与「新增任务」同一套形态）', () => {
    // 曾经是居中小弹窗：#modNewModal + .modal，表单被压在 440px 里，与任务抽屉两种观感
    expect(html).toContain('class="drawer form-drawer" id="modNewDrawer"');
    expect(html).toContain('id="modNewMask"');
    expect(html).not.toContain('id="modNewModal"');
    // 表单主体必须在 .drawer-body 内，否则抽屉内滚动与间距逻辑失效
    const start = html.indexOf('id="modNewDrawer"');
    const end = html.indexOf('id="btnNewModCancel"');
    expect(start).toBeGreaterThan(-1);
    expect(html.slice(start, end)).toContain('class="drawer-body"');
    expect(html.slice(start, end)).toContain('class="drawer-foot"');
  });

  it('需求抽屉与任务抽屉共用一套尺寸，且手机端同为底部抽屉', () => {
    const css = readFileSync(resolve(ROOT, 'src/styles/gantt.css'), 'utf8');
    // 桌面：同宽同内间距同按钮尺寸
    expect(css).toMatch(/\.drawer\.task-drawer,\.drawer\.form-drawer\{width:400px/);
    expect(css).toMatch(/\.drawer\.task-drawer \.drawer-body,\.drawer\.form-drawer \.drawer-body\{gap:14px/);
    expect(css).toMatch(/\.drawer\.task-drawer \.drawer-foot \.btn,\.drawer\.form-drawer \.drawer-foot \.btn\{flex:none/);
    // 手机：底部抽屉（.drawer 前缀的断点规则已覆盖 .form-drawer），按钮拉满整行
    const phone = phoneCss();
    expect(phone).toMatch(/\.drawer\.task-drawer \.drawer-foot \.btn,\.drawer\.form-drawer \.drawer-foot \.btn\{flex:1 1 0/);
  });

  it('需求抽屉里有优先级控件（无 / P0~P3 五档），且徽标样式齐全', () => {
    expect(html).toContain('id="segModPri"');
    // 「无」是合法状态：老数据没有 pri，编辑时必须能原样保留「未设置」
    ['', 'P0', 'P1', 'P2', 'P3'].forEach(p => expect(html).toContain(`data-pri="${p}"`));
    ['p0', 'p1', 'p2', 'p3'].forEach(k => {
      expect(css).toContain(`.pri-${k}{`);
    });
    // 徽标是浅底描边的轻量样式，不能做成和状态标签一样的实心色块
    expect(css).toMatch(/\.pri\{[^}]*border:1px solid/);
  });

  it('优先级从控件到数据层接线完整（打开回显 + 保存写入）', () => {
    const modals = readFileSync(resolve(ROOT, 'src/components/modals.js'), 'utf8');
    // 打开：新建给默认档，编辑回显实际值（无 pri 的老数据落到「无」）
    expect(modals).toMatch(/renderModPriSeg\(PRIORITY_DEFAULT, deps\)/);
    expect(modals).toMatch(/renderModPriSeg\(mo\.pri, deps\)/);
    // 保存：新增与编辑两条路径都要带上 pri
    expect(modals).toMatch(/addModule\(\{[^}]*pri: readModPri\(deps\)/);
    expect(modals).toMatch(/updateModule\(\{[^}]*pri: readModPri\(deps\)/);
  });

  it('归档视图收敛工具栏：隐去排期操作按钮，但保留 hero 统计', () => {
    const toolbar = readFileSync(resolve(ROOT, 'src/components/toolbar.js'), 'utf8');
    // 归档页与总览一样在 body 上打标记（但与之区分：归档页要保留 hero 统计）
    expect(toolbar).toMatch(/classList\.toggle\('arch-view', v === 'arch'\)/);
    expect(css).toMatch(/body\.arch-view \[data-report-hide\]:not\(\.stats\)\{display:none\}/);
    expect(css).toMatch(/body\.arch-view \.msheet-item\[data-zoom-only\]\{display:none\}/);
    // 归档页没有时间轴，缩放对它无意义（且不该劫持 Ctrl+滚轮）
    // —— 资源工作视图（work）同属非时间轴视图，一并排除，故这条断言的钉死文本随之扩展
    expect(toolbar).toMatch(/return v !== 'report' && v !== 'arch' && v !== 'work';/);
    // 手机顶栏的 ＋任务 / 排期问题 属于排期操作，必须跟着一起收敛
    expect(html).toMatch(/class="hero-acts" data-report-hide/);
  });

  it('需求状态标签 .tag 是独立类（曾因限定在 .mname 内而漏样式）', () => {
    // 曾写作 `.mname .tag`：放在 .mname 外的用法（归档行）完全吃不到样式，
    // 退化成 16px 默认深色字压在内联底色上，即"黑字压荧光绿大块"
    expect(css).toMatch(/\n\.tag\{font-size:9px/);
    expect(css).not.toMatch(/\.mname \.tag\{/);
    // 同类坑：识别色点也要能独立使用
    expect(css).toMatch(/\n\.mod-dot\{/);
    expect(css).not.toMatch(/\.mname \.mod-dot\{/);
  });

  it('需求抽屉关闭态用 .open（抽屉语义），且 Esc / 遮罩 / 手柄都能关', () => {
    const modals = readFileSync(resolve(ROOT, 'src/components/modals.js'), 'utf8');
    const index = readFileSync(resolve(ROOT, 'src/components/index.js'), 'utf8');
    // 移动端下拉关闭的实现在抽屉外壳模块（drawers.js 已瘦身为装配入口，见其文件头）
    const drawerShell = readFileSync(resolve(ROOT, 'src/components/drawer-shell.js'), 'utf8');
    // 开关都是抽屉语义的 .open（不是弹窗的 .show）
    expect(modals).toMatch(/getEl\('modNewDrawer'\)/);
    expect(modals).toMatch(/classList\.add\('open'\)/);
    expect(modals).toMatch(/classList\.remove\('open'\)/);
    expect(modals).not.toMatch(/modNewModal/);
    expect(modals).toMatch(/on\('btnCloseModDrawer'/);
    // Esc：弹窗优先，其次抽屉（需求抽屉与任务抽屉同层）
    expect(index).toMatch(/getElementById\('modNewDrawer'\)[\s\S]*?classList\.contains\('open'\)/);
    expect(index).not.toMatch(/getElementById\('modNewModal'\)/);
    // 移动端下拉关闭：手柄/头部拖拽超阈值即收
    expect(drawerShell).toMatch(/'taskDrawer', 'probDrawer', 'modNewDrawer'/);
  });
});

describe('移动端：总览排期总览改为纵向卡片', () => {
  const ctx = makeCtx();

  it('每个需求一张卡片，里程碑按日期落在进度条上（菱形 + 分层标签）', () => {
    const html = renderReportView(null, ctx);
    expect(html).toContain('class="mtl"');
    expect(html.match(/class="mtl-card/g).length).toBe(ctx.state.modules.length);
    // 菱形标记：带层索引 --li，靠 CSS 下移标签去重叠；不再是条下方的胶囊清单
    expect(html).toContain('class="mtl-ml ');
    expect(html).toMatch(/--li:\d/);
    expect(html).not.toContain('mtl-chip');
    // 条 = 需求排期区间，今日落在条上的位置即「今日应达」
    expect(html).toContain('class="mtl-today"');
  });

  it('桌面横向时间轴仍然渲染（两套结构同时输出，由 CSS 按断点取舍）', () => {
    const html = renderReportView(null, ctx);
    expect(html).toContain('class="rtl2"');
    expect(html).toContain('rtl2-bar');
  });

  it('待排期需求的移动端卡片也不参与下钻', () => {
    const c = makeCtx();
    const target = c.state.modules[0];
    target.unscheduled = true;
    const html = renderReportView(null, c);
    expect(html).toContain('mtl-card is-unsched');
    expect(html).not.toContain(`data-report-mod="${target.name}"`);
  });
});

describe('内容区：可读性与层次（桌面/移动共用）', () => {
  it('全站不再用极浅灰当文字色（灰底灰字属高严重度可读性问题）', () => {
    // 取所有「文字色」声明，排除 scrollbar-color 这类非文字用途
    const textColors = [...css.matchAll(/(?<![-\w])color:(#[0-9a-f]{6})/gi)].map(m => m[1].toLowerCase());
    ['#b3bfd0', '#c3cbdb'].forEach(c => {
      expect(textColors, `${c} 不应用作文字色`).not.toContain(c);
    });
    expect(css).toMatch(/\.dcell\{color:#64748b/);   // 日期刻度达到 AA
  });

  it('表头三行有明确层次：月行最深、日行次之、星期行最淡', () => {
    const lum = hex => {
      const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const grab = re => (css.match(re) || ['', ''])[1];
    const L = (re) => {
      const hex = grab(re);
      expect(hex, `未匹配到 ${re}`).toMatch(/^#[0-9a-f]{6}$/i);
      return lum(hex);
    };
    const month = L(/\.thead \.months\{[^}]*color:(#[0-9a-f]{6})/i);
    const day = L(/\.thead \.days\{[^}]*color:(#[0-9a-f]{6})/i);
    const week = L(/\.thead \.weeks\{[^}]*color:(#[0-9a-f]{6})/i);
    expect(month, '月行应最深').toBeLessThan(day);
    expect(day, '日行应比星期行深').toBeLessThan(week);
  });

  it('时间轴非工作日底色走 --nowork-bg（按工作日口径，不是固定周末周期）', () => {
    expect(css).toMatch(/\.gbody \.track\{background-image:var\(--nowork-bg/);
    // 绝不能退回"周六周日 7 天周期"的重复渐变：补班的周末要上班、放假的周三不上班
    expect(css).not.toMatch(/repeating-linear-gradient\(90deg,\s*transparent 0 var\(--we-off/);
    expect(css).not.toContain('--we-period');
  });

  it('行 hover 高亮与冻结列投影都在', () => {
    // 名称列跟着整行一起点亮，否则"这条任务属于哪一行"仍要靠猜
    expect(css).toMatch(/\.gbody \.bar-row:hover,\.gbody \.res-row:hover\{background:#e9f2fd\}/);
    expect(css).toMatch(/\.gbody \.bar-row:hover>\.mname,\.gbody \.res-row:hover>\.mname\{background:#e9f2fd\}/);
    expect(css).toMatch(/\.mname\{[^}]*box-shadow:4px 0 8px -4px/);
  });

  it('甘特图不做斑马纹（行区分靠分隔线与 hover，不靠隔行底色）', () => {
    expect(css).not.toMatch(/nth-child\(even\)/);
  });

  it('需求行折行后，右侧轨道必须跟着撑高（否则进度条跑出行外）', () => {
    // 左列只有 200px，放不下「名字 + 优先级 + 状态 + 周期 + 人员」时折行，行高由内容撑开
    expect(css).toMatch(/\.gbody \.mod-row\{position:relative;min-height:34px;height:auto/);
    expect(css).toMatch(/\.gbody \.mod-row \.mname\{[^}]*white-space:normal/);
    expect(css).toMatch(/\.gbody \.mod-row \.mname-main\{[^}]*flex-wrap:wrap/);
    expect(css).toMatch(/\.gbody \.mod-row \.mname-sub\{[^}]*flex-wrap:wrap/);
    // 关键：.track 的子元素全是绝对定位、自身内容高度为 0，只留 .track{height:100%}
    // 会在 height:auto 的行里解析成 0 高 —— 进度条/今天线/假期带会集体跑出行外（"进度条和需求错位"）。
    // stretch 只对交叉轴尺寸为 auto 的元素生效，所以 height:auto 和 align-self 必须成对出现。
    expect(css).toMatch(/\.gbody \.mod-row \.track\{align-self:stretch;height:auto\}/);
    // 任务行/资源行行高固定，不能被牵连放开折行（否则第二行被裁成半行残字）
    expect(css).not.toMatch(/\.gbody \.bar-row \.mname\{[^}]*white-space:normal/);
    expect(css).not.toMatch(/\.gbody \.res-row \.mname\{[^}]*white-space:normal/);
  });

  it('工作组规划器：人与人的行距拉开，单泳道也给足高度', () => {
    const resView = readFileSync(resolve(ROOT, 'src/views/res-view.js'), 'utf8');
    // 单泳道 52px（原 38px），多泳道 28px/条 —— 相邻两人的任务条不能再贴在一起
    expect(resView).toMatch(/Math\.max\(52, laneN \* 28\)/);
    expect(css).toMatch(/\.gbody \.res-row\{height:52px;border-bottom:1px solid #dbe5f2/);
  });

  it('任务条尺寸与圆角一致（条 / 进度填充不能各圆各的）', () => {
    const barR = (css.match(/\.bar\{[^}]*border-radius:(\d+)px/) || [])[1];
    const fillR = (css.match(/\.bar-progress\{[^}]*border-radius:(\d+)px/) || [])[1];
    expect(barR).toBeTruthy();
    expect(fillR).toBe(barR);
  });
});

describe('工具栏：分段控件与按钮质感', () => {
  it('工具栏用 .tseg，与任务抽屉的阶段选择器 .seg 分属两个类名', () => {
    // 两者都是"灰底凹槽 + 按钮"，但尺寸与选中态语义不同。
    // 曾经复用同一个 .seg，导致抽屉的 padding 盖住工具栏、工具栏的内阴影漏进抽屉。
    expect(css).toMatch(/\.tseg\{/);
    expect(css).toMatch(/\.tseg \.btn\.on\{background:#fff/);
    // 抽屉那套必须原样保留
    expect(css).toMatch(/\.seg\{display:flex;gap:6px\}/);
    expect(css).toMatch(/\.seg \.btn\.on\{background:var\(--blue\)/);
    // 工具栏 DOM 必须用新类名
    expect(buildShellHTML()).toContain('class="tgroup tseg"');
  });

  it('按钮三态齐备：默认有投影、hover 有主题色光晕、按下有位移', () => {
    expect(css).toMatch(/\.btn\{[^}]*box-shadow:0 1px 1\.5px/);
    expect(css).toMatch(/\.btn:hover\{[^}]*var\(--accent-ring\)/);
    expect(css).toMatch(/\.btn:active\{transform:translateY\(\.5px\)/);
  });

  it('主操作按钮用同色渐变做立体感（顶部亮、底部沉）', () => {
    expect(css).toMatch(/\.btn\.primary\{background:linear-gradient\(180deg,var\(--accent\),var\(--accent-strong\)\)/);
  });

  it('任务条 / 进度条走扁平风：纯色 + 细描边，不叠渐变与厚投影', () => {
    // 条的主色是内联 background 简写，一旦在上面叠渐变高光就会回到"立体拟物"观感；
    // 这里钉住扁平约定，避免以后又被人加回 ::before 高光层。
    expect(css).not.toMatch(/\.bar::before/);
    expect(css).toMatch(/\.bar\{[^}]*box-shadow:0 0 0 1px rgba\(15,23,42,\.08\)/);
    expect(css).not.toMatch(/\.bar:hover\{[^}]*scaleY/);
    // 进度填充：纯白半透明 + 右缘 1px 分界线，无渐变
    expect(css).toMatch(/\.bar-progress\{[^}]*background:rgba\(255,255,255,\.42\)/);
    expect(css).toMatch(/\.bar-progress\{[^}]*inset -1px 0 0/);
    expect(css).not.toMatch(/\.bar-progress\{[^}]*linear-gradient/);
  });

  it('负责人标签带资源色点（与规划器头像同色）', () => {
    expect(css).toMatch(/\.bar \.res-chip\{[^}]*display:inline-flex/);
    expect(css).toMatch(/\.bar \.res-chip i\{[^}]*border-radius:50%/);
    // 渲染侧：色点颜色取自 resource.color，取不到才回退灰色
    const modView = readFileSync(resolve(ROOT, 'src/views/mod-view.js'), 'utf8');
    expect(modView).toMatch(/res-chip-txt/);
    expect(modView).toMatch(/\|\| '#94a3b8'/);
  });

  it('归档入口的数量徽标用中性灰，不占用「问题 / 逾期」的红色语义', () => {
    const html = buildShellHTML();
    // 红色在本项目专指"有问题/逾期"（排期问题徽标、逾期数字）；归档只是计数，
    // 红点会让人以为归档里出了状况。桌面工具栏 ×2 + 移动端底部导航 ×1 都挂中性类。
    expect(html).toContain('class="badge badge-neutral" id="archNavCount"');
    expect(html).toContain('class="badge mnav-badge badge-neutral" id="archNavCountM"');
    // 导出单文件（只读查看器）里的归档入口同样是中性色
    expect(buildViewerShellHTML()).toContain('class="badge badge-neutral" id="archNavCount"');
    expect(css).toMatch(/\.badge-neutral\{background:var\(--slate\)\}/);
    // 默认徽标仍是红，问题徽标不得被改成中性色
    expect(css).toMatch(/\.badge\{[^}]*background:var\(--red\)/);
    expect(html).toMatch(/class="badge" id="probCount"/);
  });
});

describe('移动端：断点规则', () => {
  const phone = phoneCss();

  it('移动端组件在桌面端默认不参与布局', () => {
    // 允许尾部再跟一项：压缩会把相邻的同声明规则（.close-txt{display:none}）合并进同一条
    expect(css).toMatch(/\.hero-acts,\.mnav,\.msheet,\.msheet-mask,\.mtl,\.drawer-grab(,\.close-txt)?\{display:none\}/);
    expect(css).toMatch(/\.close-txt\{display:none\}/);
  });

  it('手机端隐藏桌面工具栏、启用底部导航与纵向卡片', () => {
    // 同样容忍规则合并：压缩后可能是 `.toolbar.toolbar-full,.view-nav{display:none}`
    expect(phone).toMatch(/\.toolbar\.toolbar-full(,\.view-nav)?\{display:none\}/);
    expect(phone).toMatch(/\.mnav\{display:flex/);
    expect(phone).toMatch(/\.mtl\{display:flex/);
    expect(phone).toContain('.rtl2{display:none}');   // 横向时间轴在窄屏必然压字
  });

  it('左列加宽 + 需求名折两行完整显示 + 触摸目标放大', () => {
    expect(phone).toContain('--mname-w:146px');
    // 长需求名（如「标保督导增加渠道日报页面」）在手机上必须折行而不是被省略号截掉
    expect(phone).toMatch(/\.mname \.mname-main \.mname-txt\{[^}]*-webkit-line-clamp:2/);
    // 名称折行时行高需自适应，否则第二行会被裁掉
    expect(phone).toMatch(/\.gbody \.mod-row\{min-height:48px;height:auto\}/);
  });

  it('品牌强调色全局跟随主题（--blue 指向 --accent），PC 与移动端同源', () => {
    // 桌面端历史代码里大量使用 var(--blue)，把它指到主题强调色上，
    // 等于按钮 / 链接 / 选中态 / 滑块在两端都跟随主题，不再各用一套主色
    expect(css).toMatch(/--blue:var\(--accent\)/);
    // 只在 :root 定义一次，不在媒体查询里另写一份，避免两端漂移
    expect(phone).not.toMatch(/--blue:/);
    // 状态色（红/琥珀/绿）是数据语义，任何断点都不得重新定义
    expect(css).not.toMatch(/@media[^{]*\{[\s\S]*?--red:|@media[^{]*\{[\s\S]*?--green:|@media[^{]*\{[\s\S]*?--amber:/);
  });

  it('抽屉改为底部抽屉并给出安全区留白', () => {
    expect(phone).toMatch(/\.drawer,\.drawer\.task-drawer\{[^}]*bottom:0/);
    expect(phone).toMatch(/\.drawer,\.drawer\.task-drawer\{[^}]*translateY\(102%\)/);
    expect(phone).toContain('safe-area-inset-bottom');
  });
});

// ============================================================
// 飞书多维表格连接配置（把本文件复制为 feishu-config.js 后填写）
// feishu-config.js 不要提交到 git（已在 .gitignore）
// ============================================================
window.FEISHU_CONFIG = {
  // 后端开关：true → 走飞书 bridge；false 或缺省 → 走 Supabase。
  // 两个配置可以同时存在，靠这个字段切换后端，不需要改任何代码或 HTML。
  enabled: false,

  // 你部署的 Cloudflare Worker 地址（wrangler deploy 完成后得到）
  bridgeUrl: 'https://opsplan-feishu-bridge.your-subdomain.workers.dev',

  // 多维表格 app_token（从 Base URL 里取：https://xxx.feishu.cn/base/<这一段>）
  // 当前建的库：OpsPlan 项目库
  appToken: 'GbWXb263UahpHRsh6FmcloncnV3',
};

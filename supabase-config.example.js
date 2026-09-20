// ============================================================
// Supabase 连接配置（示例文件）
//
// 使用方法：复制本文件为 supabase-config.js，填入自己的项目信息
//   Supabase Dashboard → Settings → API：
//     Project URL        → url
//     anon public key    → anonKey
//
// 注意：
//   1) supabase-config.js 已加入 .gitignore，不会提交到仓库；
//   2) anon key 设计上可公开，但前提是已开启并收紧 RLS 行级安全策略
//      （建表脚本见 deploy/supabase/migration.sql），否则任何人都能读写数据；
//   3) service_role key 权限等价于数据库管理员，绝不可写入前端配置。
// ============================================================
window.SUPABASE_CONFIG = {
  url: 'https://YOUR-PROJECT-REF.supabase.co',
  anonKey: 'YOUR_SUPABASE_ANON_KEY'
};

import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

// 在目录树中按文件名精确查找文件（standalone 单文件模板）
function findFile(dir, target) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      const found = findFile(full, target);
      if (found) return found;
    } else if (name === target) {
      return full;
    }
  }
  return null;
}

// 多页入口：排期页(gantt.html) + 登录/列表页(index.html)
// export 模式：仅构建 standalone 单文件导出模板
export default defineConfig(({ mode }) => {
  const isExport = mode === 'export';
  return {
    build: {
      rollupOptions: {
        input: isExport
          ? { standalone: 'src/standalone.html' }
          : { index: 'index.html', gantt: 'gantt.html' }
      },
      outDir: isExport ? 'dist/export' : 'dist',
      assetsInlineLimit: 100000000,
      emptyOutDir: true
    },
    plugins: [
      ...(isExport ? [viteSingleFile()] : []),
      // export 模式：构建后把单文件模板复制为 public/export-template.html，
      // 供 dev server 与主构建（dist/）提供，运行时 export.js fetch 它注入数据。
      isExport && {
        name: 'copy-export-template',
        apply: 'build',
        closeBundle() {
          // 单文件模板构建产物（standalone 单页，文件名因 Vite 相对目录规则在 src/ 下）
          const distExport = resolve(ROOT, 'dist/export');
          const from = findFile(distExport, 'standalone.html');
          if (!from) throw new Error('[export] 未找到 dist/export/src/standalone.html 单文件模板');
          const publicDir = resolve(ROOT, 'public');
          mkdirSync(publicDir, { recursive: true });
          const to = resolve(publicDir, 'export-template.html');
          // Windows 上目标文件已存在时 cpSync 覆盖会抛 EPERM（报 "operation completed successfully"），
          // 先删除再复制，保证 build:export 可重复执行。
          rmSync(to, { force: true });
          cpSync(from, to);
          console.log('[export] export-template.html -> public/');
        }
      },
      // 外部脚本（supabase UMD / 项目配置）不进打包图，构建后原样复制到 dist
      !isExport && {
        name: 'copy-root-assets',
        apply: 'build',
        closeBundle() {
          const outDir = resolve(ROOT, 'dist');
          [['lib/supabase.js', 'lib/supabase.js'], ['supabase-config.js', 'supabase-config.js']].forEach(
            ([from, to]) => {
              const src = resolve(ROOT, from);
              // supabase-config.js 属本地私有配置（已 gitignore），新克隆的仓库里可能不存在：
              // 跳过并提示，避免整个构建因缺文件而中断。
              if (!existsSync(src)) {
                console.warn(
                  `[copy-root-assets] 跳过缺失文件 ${from}（请复制 supabase-config.example.js 为 supabase-config.js 并填写配置）`
                );
                return;
              }
              cpSync(src, resolve(outDir, to));
            }
          );
        }
      }
    ].filter(Boolean),
    // dev server：默认 8000；--host 暴露局域网（start 脚本会自动加 --host）
    server: { port: 8000, strictPort: false, host: true }
  };
});

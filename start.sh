#!/usr/bin/env bash
# ============================================================
#  排期管理平台 - 启动脚本（Git Bash / macOS / Linux）
#  流程：安装依赖(如缺失) -> 启动 Vite 开发服务器 -> 打开浏览器
#  用法：./start.sh [端口]    默认端口 8000
#  说明：新架构为 Vite ES Module 工程，必须用 Vite dev server 启动
#        （gantt.html 依赖 Vite 转换 import './style.css' 等模块语法）
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

PORT="${1:-8000}"
URL="http://localhost:${PORT}/index.html"

# 1) 检查 Node（Vite 必需）
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js，请先安装 Node.js 18+ 后重试。"
  exit 1
fi

# 2) 安装依赖（首次或 node_modules 缺失时）
if [ ! -d node_modules ]; then
  echo "[1/3] 首次运行，安装依赖 ..."
  npm install
else
  echo "[1/3] 依赖已就绪"
fi

# 3) 启动 Vite 开发服务器（--host 暴露局域网）
echo "[2/3] 启动 Vite 开发服务器: http://localhost:${PORT}/"
npm run dev -- --port "$PORT" --host &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

# 4) 打开浏览器（等 2 秒确保服务已就绪）
sleep 2
echo "[3/3] 打开浏览器: ${URL}"
case "$(uname)" in
  Darwin)  open "$URL" ;;
  Linux)   xdg-open "$URL" >/dev/null 2>&1 || echo "请在浏览器手动访问: ${URL}" ;;
  *)       cmd.exe /c start "" "$URL" || echo "请在浏览器手动访问: ${URL}" ;;
esac

# 打印局域网访问地址（macOS/Linux 用 ip 命令）
echo ""
echo "局域网访问地址（同一网络下的其他电脑可用）："
if command -v ip >/dev/null 2>&1; then
  ip -4 addr show 2>/dev/null | grep -oP 'inet \K[\d.]+' | grep -v '^127\.' | sed "s/^/    http:\/\/&:${PORT}\/index.html/" || true
elif command -v ifconfig >/dev/null 2>&1; then
  ifconfig 2>/dev/null | grep 'inet ' | grep -v '127.0.0.1' | awk '{print "    http://"$2":'"${PORT}"'/index.html"}' || true
fi

echo ""
echo "服务已启动，按 Ctrl+C 停止。"
wait

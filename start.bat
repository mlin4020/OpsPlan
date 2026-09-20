@echo off
rem ============================================================
rem  排期管理平台 - 启动脚本（Windows 双击即用）
rem  流程：安装依赖(如缺失) -> 启动 Vite 开发服务器 -> 打开浏览器
rem  用法：双击本文件，或命令行执行 start.bat [端口]   默认端口 8000
rem  说明：新架构为 Vite ES Module 工程，必须用 Vite dev server 启动
rem        （gantt.html 依赖 Vite 转换 import './style.css' 等模块语法）
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

set PORT=8000
if not "%~1"=="" set PORT=%~1
set URL=http://localhost:%PORT%/index.html

rem 1) 检查 Node（Vite 必需）
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 18+ 后重试。
    pause
    exit /b 1
)

rem 2) 安装依赖（首次或 node_modules 缺失时）
if not exist node_modules (
    echo [1/3] 首次运行，安装依赖 ...
    call npm install
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
) else (
    echo [1/3] 依赖已就绪
)

rem 3) 启动 Vite 开发服务器（后台新窗口，--host 暴露局域网）
echo [2/3] 启动 Vite 开发服务器: http://localhost:%PORT%/
start "sched-vite-dev" cmd /k "npm run dev -- --port %PORT% --host"

rem 4) 打开浏览器（等 2 秒确保服务已就绪）
timeout /t 2 /nobreak >nul
echo [3/3] 打开浏览器 ...
start "" "%URL%"
echo.
echo 局域网访问地址（同一网络下的其他电脑可用）：
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    echo    http://%%a:%PORT%/index.html
)
echo.
echo 服务已启动，关闭「sched-vite-dev」窗口即可停止。

@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 星光教育 AI 助手

echo.
echo  ================================================
echo   * 星光教育 AI 智能助手 启动器
echo  ================================================
echo.

:: ====================================================
::  在下面这行引号内填入你的 DeepSeek API Key
::  示例: set API_KEY=sk-abc123def456
:: ====================================================
set API_KEY=sk-07cadda576314359a6c4b217df12882a


:: ─── 检测 Node.js ────────────────────────────────────
echo [1/3] 检测 Node.js...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  未检测到 Node.js！
    echo  请到 https://nodejs.org 下载 LTS 版本安装
    echo  安装完成后重新双击本文件
    start https://nodejs.org
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo Node.js OK: %NODE_VER%

:: ─── 写入 .env ───────────────────────────────────────
echo.
echo [2/3] 写入 API Key...
echo DEEPSEEK_API_KEY=%API_KEY%> .env
echo SCHOOL_NAME=星光教育>> .env
echo PORT=3000>> .env
echo .env 已生成

:: ─── 安装依赖 ─────────────────────────────────────────
echo.
echo [3/3] 检查依赖...
if not exist "node_modules" (
    echo  首次运行，安装依赖中（约需1分钟）...
    npm install
    if %errorlevel% neq 0 (
        echo  安装失败！请检查网络后重试
        pause
        exit /b 1
    )
    echo  依赖安装完成
)
echo 依赖 OK

:: ─── 启动 ─────────────────────────────────────────────
echo.
echo  ================================================
echo   服务启动中，2秒后浏览器自动打开
echo   关闭此窗口 = 停止服务
echo  ================================================
echo.
start /b cmd /c "timeout /t 2 >nul && start http://localhost:3000"
node server.js
echo.
echo 服务已停止
pause

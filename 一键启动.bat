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
::  密钥只放在本机 .env，不要写进本文件或提交到 Git
:: ====================================================
if not exist ".env" (
    copy /y ".env.example" ".env" >nul
    echo  已生成 .env，请用记事本填写 DEEPSEEK_API_KEY、MONGODB_URI 和 JWT_SECRET。
    start notepad ".env"
    echo  填写并保存后，请重新运行本启动器。
    pause
    exit /b 0
)


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

:: ─── 检查 .env ───────────────────────────────────────
echo.
echo [2/3] 检查本地配置...
findstr /B /C:"DEEPSEEK_API_KEY=your_deepseek_api_key_here" .env >nul
if %errorlevel% equ 0 (
    echo  .env 中的 DEEPSEEK_API_KEY 尚未填写。
    start notepad ".env"
    pause
    exit /b 1
)
echo .env 配置已读取

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

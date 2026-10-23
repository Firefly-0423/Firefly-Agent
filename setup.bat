@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [Firefly] 开始初始化...

echo [1/4] 安装依赖...
call npm ci
if errorlevel 1 (
    echo [错误] npm install 失败
    pause
    exit /b 1
)

echo [2/4] 构建原生截图助手...
call npm run build:screenshot-helper
if errorlevel 1 (
    echo [错误] build:screenshot-helper 失败
    pause
    exit /b 1
)

echo [3/4] 构建项目...
call npm run build
if errorlevel 1 (
    echo [错误] npm run build 失败
    pause
    exit /b 1
)

echo [4/4] 链接 firefly 命令...
call npm link
if errorlevel 1 (
    echo [错误] npm link 失败
    pause
    exit /b 1
)

echo.
echo [Firefly] Setup complete. Development requires an absolute existing isolation directory.
echo Run: start.bat "isolation directory"
echo Or set FIREFLY_ISOLATION_ROOT in the current terminal before running start.bat.
echo New terminals and double-click launches do not inherit temporary variables from another terminal.
pause

@echo off
chcp 65001 >nul
cd /d "%~dp0"

if /i "%~1"=="link" goto link
if not "%~1"=="" (
    echo [错误] setup.bat 只接受一个可选参数：link
    pause
    exit /b 1
)

echo [Firefly] 开始初始化...

echo [1/4] 安装依赖...
call pnpm install --frozen-lockfile
if errorlevel 1 (
    echo [错误] pnpm install 失败。请先安装 pnpm 12.10.1，参见 docs/contributing/development.md
    pause
    exit /b 1
)

echo [2/4] 准备 Electron 程序...
call pnpm exec install-electron
if errorlevel 1 (
    echo [错误] install-electron 失败
    pause
    exit /b 1
)

echo [3/4] 构建原生截图助手...
call pnpm run build:screenshot-helper
if errorlevel 1 (
    echo [错误] build:screenshot-helper 失败
    pause
    exit /b 1
)

echo [4/4] 构建项目...
call pnpm run build
if errorlevel 1 (
    echo [错误] pnpm run build 失败
    pause
    exit /b 1
)

echo.
echo [Firefly] Setup complete. Run start.bat to launch Firefly from this folder.
echo Its data stays in output\development-profile here, apart from an installed Firefly.
echo To keep it elsewhere: start.bat "absolute existing directory", or set FIREFLY_ISOLATION_ROOT first.
echo Optional: run "setup.bat link" to register a global firefly command.
pause
exit /b 0

:link
echo [可选] 注册全局 firefly 命令...
if not exist "%~dp0dist\cli\index.js" (
    echo [错误] 还没有构建，请先运行 setup.bat
    pause
    exit /b 1
)
call pnpm link --global
if errorlevel 1 (
    echo [错误] pnpm link --global 失败。如果提示没有全局目录，先运行一次 pnpm setup 再重开终端。
    pause
    exit /b 1
)
echo [Firefly] firefly 命令已注册。
pause
exit /b 0

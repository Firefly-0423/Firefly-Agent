@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
if errorlevel 1 exit /b 1

if not "%~2"=="" goto usage
if not "%~1"=="" set "FIREFLY_ISOLATION_ROOT=%~1"
if defined FIREFLY_ISOLATION_ROOT goto run
if defined FIREFLY_ISOLATED_SMOKE_APPDATA goto run

:usage
echo [Error] FIREFLY_RUNTIME_ISOLATION_REQUIRED: development needs an explicit isolation root.
echo Usage: start.bat "absolute existing isolation directory"
echo Or set FIREFLY_ISOLATION_ROOT before running this script.
echo The root must not overlap production appData. This script does not create directories.
pause
exit /b 1

:run
node "%~dp0dist\cli\index.js" run
set "FIREFLY_START_EXIT=%errorlevel%"
if "%FIREFLY_START_EXIT%"=="0" exit /b 0
echo [Error] firefly run exited with code %FIREFLY_START_EXIT%
pause
exit /b %FIREFLY_START_EXIT%

@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
if errorlevel 1 exit /b 1

if not "%~2"=="" goto usage
if not "%~1"=="" set "FIREFLY_ISOLATION_ROOT=%~1"
rem Without a root, firefly run keeps the data in this checkout's output\development-profile.
goto run

:usage
echo [Error] start.bat takes at most one argument: an optional absolute, existing data directory.
echo Without it, the data stays in output\development-profile inside this folder.
pause
exit /b 1

:run
node "%~dp0dist\cli\index.js" run
set "FIREFLY_START_EXIT=%errorlevel%"
if "%FIREFLY_START_EXIT%"=="0" exit /b 0
echo [Error] firefly run exited with code %FIREFLY_START_EXIT%
pause
exit /b %FIREFLY_START_EXIT%

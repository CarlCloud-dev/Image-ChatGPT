@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo   Image-ChatGPT  Electron dev
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 goto :no_node
where npm.cmd >nul 2>nul
if errorlevel 1 goto :no_npm

if not exist "node_modules\electron" goto :install_deps
if not exist "node_modules\playwright-core" goto :install_deps
goto :deps_ready

:install_deps
echo [init] installing npm dependencies...
npm.cmd install
if errorlevel 1 goto :deps_fail

:deps_ready

echo [start] Image-ChatGPT (Chrome / Edge mode)
npm.cmd start
goto :eof

:no_node
echo [error] node not found
pause
goto :eof

:no_npm
echo [error] npm.cmd not found
pause
goto :eof

:deps_fail
echo [error] npm install failed
pause
goto :eof

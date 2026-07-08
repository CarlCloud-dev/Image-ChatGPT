@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo   Image-ChatGPT  Electron build
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 goto :no_node
where npm.cmd >nul 2>nul
if errorlevel 1 goto :no_npm

if not exist "node_modules\electron" (
  echo [init] installing npm dependencies...
  npm.cmd install
  if errorlevel 1 goto :deps_fail
)

echo [build] creating Windows app directory...
echo.
npm.cmd run build
if errorlevel 1 goto :build_fail

echo.
echo [done] see dist-electron\
echo.
pause
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

:build_fail
echo.
echo [error] build failed
pause
goto :eof

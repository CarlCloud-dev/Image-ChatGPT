@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ==========================================
echo   Image-ChatGPT  portable folder build
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 goto :no_node

echo [build] creating dist-electron\Image-ChatGPT\ ...
echo.
node "scripts\build-win-dir.js"
if errorlevel 1 goto :build_fail

echo.
echo [done] dist-electron\Image-ChatGPT\Image-ChatGPT.exe
echo [copy] copy the entire dist-electron\Image-ChatGPT\ folder to use it portably
echo.
pause
exit /b 0

:no_node
echo [error] node not found
pause
exit /b 1

:build_fail
echo.
echo [error] build failed
pause
exit /b 1

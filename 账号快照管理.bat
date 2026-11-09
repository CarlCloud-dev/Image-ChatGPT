@echo off
setlocal EnableExtensions
cd /d "%~dp0"

:menu
cls
echo =======================================================
echo          ChatGPT / Gemini 账号登录态快照管理器
echo =======================================================
echo.
echo [1] 备份当前已登录账号 (生成快照，约 2MB)
echo [2] 查看所有已保存的快照列表
echo [3] 一键恢复登录态 (从快照还原，避免频繁重新登录风控)
echo [4] 删除指定的快照
echo [0] 退出
echo.
echo =======================================================
set /p opt="请选择操作 [0-4]: "

if "%opt%"=="1" goto do_backup
if "%opt%"=="2" goto do_list
if "%opt%"=="3" goto do_restore
if "%opt%"=="4" goto do_delete
if "%opt%"=="0" exit /b 0
goto menu

:do_backup
cls
echo -------------------------------------------------------
echo 备份当前已登录账号
echo -------------------------------------------------------
echo.
echo 请选择平台:
echo [1] ChatGPT
echo [2] Gemini
set /p p_opt="选择 [1/2]: "
set p_name=chatgpt
if "%p_opt%"=="2" set p_name=gemini

echo.
echo 请选择浏览器引擎:
echo [1] Edge (默认)
echo [2] Chrome
set /p e_opt="选择 [1/2, 直接回车为 Edge]: "
set e_name=edge
if "%e_opt%"=="2" set e_name=chrome

echo.
set /p tag="请输入账号备注名称 (如: 主号 / 备用号, 默认 default): "
if "%tag%"=="" set tag=default

echo.
node scripts\snapshot-manager.js backup %p_name% %e_name% %tag%
echo.
pause
goto menu

:do_list
cls
node scripts\snapshot-manager.js list
echo.
pause
goto menu

:do_restore
cls
echo -------------------------------------------------------
echo 恢复账号登录态
echo (注意: 恢复前请先在托盘或任务管理器中关闭本应用)
echo -------------------------------------------------------
node scripts\snapshot-manager.js list
set /p r_id="请输入要恢复的快照序号: "
if "%r_id%"=="" goto menu

echo.
node scripts\snapshot-manager.js restore %r_id%
echo.
pause
goto menu

:do_delete
cls
node scripts\snapshot-manager.js list
set /p d_id="请输入要删除的快照序号: "
if "%d_id%"=="" goto menu

echo.
node scripts\snapshot-manager.js delete %d_id%
echo.
pause
goto menu
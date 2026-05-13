@echo off
setlocal
set SCRIPT_DIR=%~dp0
set SIDECAR_DIR=%SCRIPT_DIR%..\sidecar

if not defined PSTUI_SIDECAR_HOST set PSTUI_SIDECAR_HOST=127.0.0.1
if not defined PSTUI_SIDECAR_PORT set PSTUI_SIDECAR_PORT=17900

python "%SIDECAR_DIR%\pstui_sidecar.py" --host %PSTUI_SIDECAR_HOST% --port %PSTUI_SIDECAR_PORT% %*

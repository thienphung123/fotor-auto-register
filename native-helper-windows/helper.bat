@echo off
REM Wrapper duoc Chrome goi qua Native Messaging.
REM Phai absolute path vi Chrome khong inherit PATH user.
REM Neu node.exe khong o PATH default, sua duong dan o duoi.

REM Tu dong tim node.exe
where node.exe >nul 2>&1
if %ERRORLEVEL%==0 (
    for /f "delims=" %%i in ('where node.exe') do (
        set "NODE_EXE=%%i"
        goto :found
    )
)

REM Fallback paths
if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_EXE=C:\Program Files\nodejs\node.exe"
    goto :found
)
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
    set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
    goto :found
)

echo {"ok":false,"error":"node_not_found"} >&2
exit /b 1

:found
"%NODE_EXE%" "%~dp0helper.js" %*

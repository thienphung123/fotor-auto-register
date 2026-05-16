@echo off
REM ============================================================================
REM wg-elevated.bat - Chay boi Scheduled Task as NT AUTHORITY\SYSTEM
REM Khong UAC, khong can Chrome admin -> helper.js trigger qua schtasks /run
REM
REM Doc action tu C:\ProgramData\fotor-vpn-helper\action.txt
REM Format: "INSTALL <conf-path>"  hoac "UNINSTALL <tunnel-name>"
REM ============================================================================

set DATA_DIR=C:\ProgramData\fotor-vpn-helper
set ACTION_FILE=%DATA_DIR%\action.txt
set RESULT_FILE=%DATA_DIR%\result.txt
set LOG_FILE=%DATA_DIR%\elevated.log

REM Truc khi xoa result cu
if exist "%RESULT_FILE%" del /f /q "%RESULT_FILE%" >nul 2>&1

if not exist "%ACTION_FILE%" (
    echo [%date% %time%] action file missing >> "%LOG_FILE%"
    echo ERR_NO_ACTION_FILE > "%RESULT_FILE%"
    exit /b 1
)

REM Doc dong dau action.txt
set /p LINE=<"%ACTION_FILE%"
echo [%date% %time%] action: %LINE% >> "%LOG_FILE%"

for /f "tokens=1,*" %%a in ("%LINE%") do (
    set ACTION=%%a
    set PARAM=%%b
)

set WG_EXE=C:\Program Files\WireGuard\wireguard.exe
if not exist "%WG_EXE%" (
    echo [%date% %time%] wireguard.exe not found >> "%LOG_FILE%"
    echo ERR_NO_WIREGUARD > "%RESULT_FILE%"
    exit /b 2
)

if /I "%ACTION%"=="INSTALL" (
    echo [%date% %time%] installtunnelservice %PARAM% >> "%LOG_FILE%"
    "%WG_EXE%" /installtunnelservice "%PARAM%" >> "%LOG_FILE%" 2>&1
    if errorlevel 1 (
        echo ERR_INSTALL_%ERRORLEVEL% > "%RESULT_FILE%"
        exit /b 3
    )
    echo OK > "%RESULT_FILE%"
    exit /b 0
)

if /I "%ACTION%"=="UNINSTALL" (
    echo [%date% %time%] uninstalltunnelservice %PARAM% >> "%LOG_FILE%"
    "%WG_EXE%" /uninstalltunnelservice "%PARAM%" >> "%LOG_FILE%" 2>&1
    if errorlevel 1 (
        echo ERR_UNINSTALL_%ERRORLEVEL% > "%RESULT_FILE%"
        exit /b 4
    )
    echo OK > "%RESULT_FILE%"
    exit /b 0
)

echo [%date% %time%] unknown action: %ACTION% >> "%LOG_FILE%"
echo ERR_UNKNOWN_ACTION > "%RESULT_FILE%"
exit /b 5

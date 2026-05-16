# =====================================================================
# Fotor VPN Helper - WireGuard Installer (Windows)
# =====================================================================
# Cach dung:
#   .\install.ps1 -ExtensionId <CHROME_EXTENSION_ID>
#
#   .\install.ps1 -Uninstall
# =====================================================================
[CmdletBinding()]
param(
    [string]$ExtensionId,
    [switch]$Uninstall,
    [string]$ConfigDir = "C:\WireGuard\Surfshark",
    [string]$InstallDir = "$env:LOCALAPPDATA\fotor-vpn-helper"
)

$ErrorActionPreference = 'Stop'

# Check admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "❌ Vui long chay PowerShell as Administrator (chuot phai -> Run as administrator)" -ForegroundColor Red
    Write-Host "   Wire-Guard tunnel install/uninstall yeu cau quyen admin." -ForegroundColor Yellow
    exit 1
}

# Registry keys cho TAT CA browsers (Chrome, Edge, Brave, Chrome Beta/Dev)
# duoc xu ly trong block install/uninstall ben duoi

# ---------- UNINSTALL ----------
if ($Uninstall) {
    Write-Host "==> Uninstall mode" -ForegroundColor Cyan

    # Bring down any active tunnels
    $wgExe = "$env:ProgramFiles\WireGuard\wireguard.exe"
    if (Test-Path $wgExe) {
        $tunnels = sc.exe query type= service state= all | Select-String -Pattern 'WireGuardTunnel\$(.+)' -AllMatches |
            ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value.Trim() }
        foreach ($t in $tunnels) {
            Write-Host "  Bring down tunnel: $t" -ForegroundColor Yellow
            & $wgExe '/uninstalltunnelservice' $t 2>$null
        }
    }

    # Xoa keys o moi browser (HKCU + HKLM)
    $UninstallBrowserKeys = @(
        'Software\Google\Chrome\NativeMessagingHosts\com.fotor.vpn',
        'Software\Microsoft\Edge\NativeMessagingHosts\com.fotor.vpn',
        'Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.fotor.vpn',
        'Software\Google\Chrome Beta\NativeMessagingHosts\com.fotor.vpn',
        'Software\Google\Chrome Dev\NativeMessagingHosts\com.fotor.vpn'
    )
    foreach ($subKey in $UninstallBrowserKeys) {
        foreach ($hive in @('HKCU:', 'HKLM:')) {
            $key = "$hive\$subKey"
            if (Test-Path $key) {
                try { Remove-Item $key -Force; Write-Host "  Removed: $key" -ForegroundColor Yellow }
                catch { Write-Host "  ⚠️  $key (can admin)" -ForegroundColor DarkYellow }
            }
        }
    }
    if (Test-Path $InstallDir) {
        Remove-Item $InstallDir -Recurse -Force
        Write-Host "  Removed install dir: $InstallDir" -ForegroundColor Yellow
    }
    if (Test-Path "C:\ProgramData\fotor-vpn-helper") {
        Remove-Item "C:\ProgramData\fotor-vpn-helper" -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "  Removed ProgramData dir" -ForegroundColor Yellow
    }
    try {
        Unregister-ScheduledTask -TaskName "FotorWG-Elevated" -Confirm:$false -ErrorAction Stop
        Write-Host "  Removed Scheduled Task: FotorWG-Elevated" -ForegroundColor Yellow
    } catch {}
    Write-Host "✅ Uninstall xong." -ForegroundColor Green
    exit 0
}

# ---------- INSTALL ----------
if (-not $ExtensionId) {
    Write-Host "❌ Thieu -ExtensionId. Vao chrome://extensions, bat Developer mode, copy ID cua 'Fotor Auto Register'." -ForegroundColor Red
    exit 1
}
if ($ExtensionId -notmatch '^[a-p]{32}$') {
    # Chrome extension IDs chi chua chu cai a-p (KHONG so, KHONG q-z)
    # Confusion phu bien: 'l' (chu L thuong) vs '1' (so 1), 'i' vs '1'
    Write-Host "❌ Extension ID SAI FORMAT! Chua bao gio chua so." -ForegroundColor Red
    Write-Host "   Cac chu phai a-p (vd 'l' khong phai '1', 'i' khong phai '1')" -ForegroundColor Yellow
    Write-Host "   Vao chrome://extensions hoac edge://extensions -> Developer mode -> copy ID can than" -ForegroundColor Yellow
    Write-Host "   Da nhan: $ExtensionId" -ForegroundColor Yellow
    exit 1
}

Write-Host "==> Installing Fotor VPN Helper" -ForegroundColor Cyan
Write-Host "    Extension ID: $ExtensionId"
Write-Host "    Install dir : $InstallDir"
Write-Host "    Config dir  : $ConfigDir"

# 1. Check WireGuard
$wgExe = "$env:ProgramFiles\WireGuard\wireguard.exe"
if (-not (Test-Path $wgExe)) {
    $wgExe = "${env:ProgramFiles(x86)}\WireGuard\wireguard.exe"
}
if (-not (Test-Path $wgExe)) {
    Write-Host "❌ WireGuard for Windows chua cai. Tai tai:" -ForegroundColor Red
    Write-Host "   https://www.wireguard.com/install/" -ForegroundColor Yellow
    exit 1
}
Write-Host "  ✓ WireGuard: $wgExe" -ForegroundColor Green

# 2. Check Node.js
try {
    $nodeVer = & node --version 2>$null
    Write-Host "  ✓ Node.js: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "❌ Node.js chua cai. Tai LTS tai:" -ForegroundColor Red
    Write-Host "   https://nodejs.org" -ForegroundColor Yellow
    exit 1
}

# 3. Tao install dir
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Write-Host "  ✓ Install dir created" -ForegroundColor Green

# 4. Copy files
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Copy-Item -Path "$ScriptDir\helper.js"        -Destination "$InstallDir\helper.js"        -Force
Copy-Item -Path "$ScriptDir\helper.bat"       -Destination "$InstallDir\helper.bat"       -Force
Copy-Item -Path "$ScriptDir\wg-elevated.bat"  -Destination "$InstallDir\wg-elevated.bat"  -Force
Write-Host "  ✓ Copied helper files" -ForegroundColor Green

# 4b. Tao ProgramData dir cho action/result files (accessible boi SYSTEM + user)
$DataDir = "C:\ProgramData\fotor-vpn-helper"
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
try {
    $acl = Get-Acl $DataDir
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        "BUILTIN\Users", "FullControl",
        "ContainerInherit,ObjectInherit", "None", "Allow"
    )
    $acl.SetAccessRule($rule)
    Set-Acl $DataDir $acl
    Write-Host "  ✓ ProgramData dir + ACL: $DataDir" -ForegroundColor Green
} catch {
    Write-Host "  ⚠️  Khong set ACL cho $DataDir (van OK nhung neu loi 'access denied' khi chay -> sua ACL tay)" -ForegroundColor Yellow
}

# 4c. Tao Scheduled Task chay as SYSTEM (KHONG can Chrome admin, KHONG UAC moi lan)
$TaskName = "FotorWG-Elevated"
try {
    # Principal: chay nhu user hien tai voi Highest privilege + S4U logon.
    # S4U (Service-for-User) cho phep task chay khong can mat khau, dung cached
    # admin token cua user (user must be Administrator group member).
    # Voi setup nay, schtasks /run thanh cong khi triggered tu user session
    # (non-admin Chrome/Edge), task chay voi admin token, wireguard.exe OK.
    # KHONG dung SYSTEM principal vi user khong co quyen /run task SYSTEM.
    $taskAction = New-ScheduledTaskAction -Execute "$InstallDir\wg-elevated.bat"
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -RunLevel Highest -LogonType S4U
    $taskSettings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
        -Hidden
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null
    Write-Host "  ✓ Scheduled Task: $TaskName (RunAs $env:USERNAME Highest+S4U, no password, no UAC)" -ForegroundColor Green
} catch {
    Write-Host "  ❌ Khong tao duoc Scheduled Task: $_" -ForegroundColor Red
    Write-Host "      Tunnel rotate se fail. Can admin PS de tao task." -ForegroundColor Yellow
}

# 5. Tao manifest voi extension ID + path tuyet doi toi helper.bat
$manifestPath = "$InstallDir\com.fotor.vpn.json"
$helperBat = ("$InstallDir\helper.bat") -replace '\\','\\'
$manifest = @"
{
    "name": "com.fotor.vpn",
    "description": "Fotor VPN Helper (WireGuard rotate)",
    "path": "$helperBat",
    "type": "stdio",
    "allowed_origins": [
        "chrome-extension://$ExtensionId/"
    ]
}
"@
# PS 5.1's "-Encoding UTF8" = UTF-8 with BOM, nhưng Chrome JSON parser STRICT
# (RFC 8259) khong chap nhan BOM -> reject manifest -> "host is forbidden".
# Phai ghi UTF-8 KHONG BOM. Cach duy nhat tren PS 5.1: WriteAllText voi false flag.
[System.IO.File]::WriteAllText($manifestPath, $manifest, [System.Text.UTF8Encoding]::new($false))
Write-Host "  ✓ Manifest written (UTF-8 no BOM): $manifestPath" -ForegroundColor Green

# 6. Register native host vao TAT CA Chromium-based browsers
# HKCU: non-admin browser. HKLM: admin browser (security policy).
# Browsers supported: Chrome, Edge, Brave, Chrome Beta/Dev/Canary
$BrowserKeys = @(
    'Software\Google\Chrome\NativeMessagingHosts',
    'Software\Microsoft\Edge\NativeMessagingHosts',
    'Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
    'Software\Google\Chrome Beta\NativeMessagingHosts',
    'Software\Google\Chrome Dev\NativeMessagingHosts'
)
foreach ($subKey in $BrowserKeys) {
    foreach ($hive in @('HKCU:', 'HKLM:')) {
        $parent = "$hive\$subKey"
        $key = "$parent\com.fotor.vpn"
        try {
            if (-not (Test-Path $parent)) {
                New-Item -Path $parent -Force -ErrorAction Stop | Out-Null
            }
            New-Item -Path $key -Value $manifestPath -Force -ErrorAction Stop | Out-Null
            Write-Host "  ✓ $hive\$subKey\com.fotor.vpn" -ForegroundColor Green
        } catch {
            if ($hive -eq 'HKLM:') {
                # HKLM can admin -> warning only
                Write-Host "  ⚠️  $hive can admin PS (browser admin se fail)" -ForegroundColor DarkYellow
            } else {
                Write-Host "  ⚠️  $hive fail: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
    }
}

# 7. Check / tao config dir
if (-not (Test-Path $ConfigDir)) {
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
    Write-Host "  ✓ Config dir created: $ConfigDir (de file .conf vao day)" -ForegroundColor Yellow
} else {
    $confCount = (Get-ChildItem $ConfigDir -Filter '*.conf' -File -ErrorAction SilentlyContinue).Count
    Write-Host "  ✓ Config dir: $ConfigDir ($confCount file .conf)" -ForegroundColor Green
    if ($confCount -eq 0) {
        Write-Host "    ⚠️  Chua co file .conf! Tai Surfshark dashboard -> Manual setup -> WireGuard," -ForegroundColor Yellow
        Write-Host "        copy file .conf vao $ConfigDir" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "✅ DONE!" -ForegroundColor Green
Write-Host ""
Write-Host "Buoc tiep theo:" -ForegroundColor Cyan
Write-Host "  1. Restart Chrome (close het tab + Chrome process) de load native host"
Write-Host "  2. Mo extension popup -> bam 🔄 Doi IP ngay"
Write-Host "  3. Xem log neu loi: $InstallDir\helper.log"
Write-Host ""
Write-Host "Test thu cong (khong qua extension):" -ForegroundColor Cyan
Write-Host "  cd `"$InstallDir`""
Write-Host "  node test-status.js   # se viet o duoi neu can"
Write-Host ""
Write-Host "Go cai dat:" -ForegroundColor Cyan
Write-Host "  .\install.ps1 -Uninstall"

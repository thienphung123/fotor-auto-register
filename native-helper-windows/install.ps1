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

$RegKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.fotor.vpn'

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

    if (Test-Path $RegKey) {
        Remove-Item $RegKey -Force
        Write-Host "  Removed registry key: $RegKey" -ForegroundColor Yellow
    }
    if (Test-Path $InstallDir) {
        Remove-Item $InstallDir -Recurse -Force
        Write-Host "  Removed install dir: $InstallDir" -ForegroundColor Yellow
    }
    Write-Host "✅ Uninstall xong." -ForegroundColor Green
    exit 0
}

# ---------- INSTALL ----------
if (-not $ExtensionId) {
    Write-Host "❌ Thieu -ExtensionId. Vao chrome://extensions, bat Developer mode, copy ID cua 'Fotor Auto Register'." -ForegroundColor Red
    exit 1
}
if ($ExtensionId -notmatch '^[a-z]{32}$') {
    Write-Host "⚠️  Extension ID khong dung format (32 chu thuong). Tiep tuc..." -ForegroundColor Yellow
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
Copy-Item -Path "$ScriptDir\helper.js"  -Destination "$InstallDir\helper.js"  -Force
Copy-Item -Path "$ScriptDir\helper.bat" -Destination "$InstallDir\helper.bat" -Force
Write-Host "  ✓ Copied helper files" -ForegroundColor Green

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
Set-Content -Path $manifestPath -Value $manifest -Encoding UTF8
Write-Host "  ✓ Manifest written: $manifestPath" -ForegroundColor Green

# 6. Register vao Chrome registry
if (-not (Test-Path 'HKCU:\Software\Google\Chrome\NativeMessagingHosts')) {
    New-Item -Path 'HKCU:\Software\Google\Chrome\NativeMessagingHosts' -Force | Out-Null
}
New-Item -Path $RegKey -Value $manifestPath -Force | Out-Null
Write-Host "  ✓ Registry: $RegKey -> $manifestPath" -ForegroundColor Green

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

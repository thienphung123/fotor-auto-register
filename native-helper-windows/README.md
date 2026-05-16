# Fotor VPN Helper — WireGuard for Windows

Native Messaging Host cho extension `Fotor Auto Register` để **tự động đổi IP qua WireGuard** trên Windows. Nhẹ + nhanh hơn OpenVPN (~2-4s/rotate).

## Yêu cầu

| | Cách cài |
|---|---|
| **WireGuard for Windows** | https://www.wireguard.com/install/ (cần admin lúc cài) |
| **Node.js LTS** | https://nodejs.org (có thể cài per-user, không cần admin) |
| **WireGuard `.conf` files** | Surfshark dashboard → Manual setup → **WireGuard** → tải các config server bạn muốn dùng |

## Cài đặt

### 1. Lấy Chrome Extension ID

1. Mở `chrome://extensions`
2. Bật **Developer mode** (góc phải trên)
3. Tìm **Fotor Auto Register** → copy `ID` (chuỗi 32 chữ thường, vd `abcdefghijklmnopqrstuvwxyz123456`)

### 2. Để file `.conf` vào folder

Mặc định: `C:\WireGuard\Surfshark\` — copy nhiều file vào đây càng tốt (helper sẽ random pick, không lặp đến khi cạn pool).

Vd:
```
C:\WireGuard\Surfshark\
├── us-nyc.conf
├── nl-ams.conf
├── jp-tok.conf
└── sg-sgp.conf
```

Muốn folder khác? Truyền `-ConfigDir` lúc cài.

### 3. Chạy installer (PowerShell **Admin**)

```powershell
# Mở PowerShell as Administrator
cd <path\to\repo>\native-helper-windows
.\install.ps1 -ExtensionId abcdefghijklmnopqrstuvwxyz123456
```

Custom config dir:
```powershell
.\install.ps1 -ExtensionId abc... -ConfigDir "D:\MyVPN\Configs"
```

### 4. Restart Chrome **toàn bộ** (close tất cả tab + process Chrome)

Native Host chỉ load khi Chrome khởi động fresh.

### 5. Test

Mở extension popup → bấm **🔄 Đổi IP ngay (OpenVPN)** (button cũ — vẫn dùng cùng giao thức Native Messaging).

Kết quả mong đợi: ~2-4s sau popup hiện `✅ IP mới: x.x.x.x (server-name)`.

## Test thủ công không qua extension

```powershell
cd $env:LOCALAPPDATA\fotor-vpn-helper

# STATUS
$body = '{"action":"STATUS"}'
$header = [BitConverter]::GetBytes([uint32]$body.Length)
[byte[]]$bytes = $header + [Text.Encoding]::UTF8.GetBytes($body)
$bytes | Set-Content -Path test-input.bin -Encoding Byte
Get-Content test-input.bin -Encoding Byte | & .\helper.bat | Format-Hex
```

Nếu lười: chỉ cần `Get-Content $env:LOCALAPPDATA\fotor-vpn-helper\helper.log` để xem log.

## Cách hoạt động

1. Extension `background.js` gọi `chrome.runtime.connectNative('com.fotor.vpn')` + post `{action:'ROTATE'}`
2. Chrome đọc registry `HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.fotor.vpn` → path manifest
3. Manifest trỏ tới `helper.bat` → spawn `node helper.js`
4. `helper.js`:
   - `wg show` xem tunnel nào đang up → `wireguard.exe /uninstalltunnelservice <name>`
   - Random pick 1 file `.conf` từ pool (skip configs đã dùng cho đến khi cạn)
   - `wireguard.exe /installtunnelservice <conf-path>` → tunnel up trong 1-3s
   - `https://api.ipify.org` xác nhận IP mới
5. Reply JSON `{ok:true, server:"us-nyc", oldIp:"1.2.3.4", newIp:"5.6.7.8"}` về extension

## Gỡ cài đặt

```powershell
.\install.ps1 -Uninstall
```

Sẽ:
- Bring down mọi tunnel WireGuard đang quản lý
- Xoá registry key
- Xoá folder `%LOCALAPPDATA%\fotor-vpn-helper`

## Troubleshooting

| Lỗi | Nguyên nhân | Fix |
|---|---|---|
| Extension báo `native_host_missing` | Chưa restart Chrome sau install | Tắt hết Chrome process (Task Manager) → mở lại |
| `wireguard_exe_not_found` | WireGuard chưa cài hoặc cài ở chỗ lạ | Cài lại từ wireguard.com, hoặc sửa `WG_EXE_CANDIDATES` trong `helper.js` |
| `no_configs_found` | Folder `C:\WireGuard\Surfshark\` rỗng | Copy file `.conf` vào |
| `wg_up_failed` | Config sai / DNS / firewall | Xem `helper.log`, thử bật manual qua WireGuard GUI |
| Helper crash | Permission, antivirus | Chạy lại installer as admin, thêm exception cho `helper.bat` trong AV |
| Chrome reset không có quyền uninstall service | Không elevated | PowerShell as Administrator lúc install (Chrome con sẽ kế thừa quyền qua native host) |

> **Note**: Chrome chạy native host với CÙNG quyền user của Chrome. Nếu Chrome chạy không-admin, helper cũng không-admin → `wireguard.exe /installtunnelservice` sẽ fail (cần admin). Workaround: chạy Chrome as administrator (chuột phải Chrome shortcut → Run as administrator). Hoặc xem mục "Auto-elevate" dưới.

## Auto-elevate (advanced)

Nếu không muốn chạy Chrome as admin, có thể tạo Scheduled Task chạy helper với "Highest privileges":

1. Task Scheduler → Create Task
2. General: `Run with highest privileges` ✓
3. Trigger: On demand
4. Action: `helper.bat`
5. Đổi `helper.bat` thành: `schtasks /run /tn "FotorVpnHelper"` (sẽ tạo task này thay vì chạy node trực tiếp)

Nhưng cần thêm cơ chế trả message ngược về Chrome — phức tạp. Đơn giản hơn là chạy Chrome as admin.

## Logs

`%LOCALAPPDATA%\fotor-vpn-helper\helper.log` (auto-rotate khi >5MB, giữ 3 file).

```powershell
Get-Content $env:LOCALAPPDATA\fotor-vpn-helper\helper.log -Tail 50 -Wait
```

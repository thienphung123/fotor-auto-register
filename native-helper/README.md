# Fotor VPN Helper (Native Messaging Host)

Helper Node.js chạy trên VPS Ubuntu (root). Nhận lệnh từ Chrome Extension để xoay IP qua OpenVPN + Surfshark configs.

## 1. Yêu cầu

- VPS Ubuntu 22.04 / 24.04
- Login bằng **root** (Chrome cũng chạy as root)
- Tài khoản Surfshark có **Manual Setup credentials** (lấy ở dashboard Surfshark → Manual Setup → tab OpenVPN → Get credentials). Đây là username/password **KHÁC** với mật khẩu đăng nhập Surfshark thường.
- Đã có folder `.ovpn` configs (download từ Surfshark dashboard)

## 2. Setup

### 2.1 Upload helper lên VPS
Trên máy local (PowerShell):
```powershell
scp -r f:\vibecode\fotor-auto-register\native-helper root@<VPS_IP>:/root/
```

### 2.2 Upload Surfshark configs
```powershell
ssh root@<VPS_IP> "mkdir -p /opt/surfshark/configs"
scp C:\Users\ACER\Downloads\Surfshark_Config\*.ovpn root@<VPS_IP>:/opt/surfshark/configs/
```

### 2.3 Tạo file auth trên VPS
SSH vào VPS:
```bash
nano /opt/surfshark/auth.txt
```
Nội dung (2 dòng — username và password từ Surfshark Manual Setup):
```
<service-username>
<service-password>
```
Lưu rồi:
```bash
chmod 600 /opt/surfshark/auth.txt
```

### 2.4 Lấy Chrome Extension ID
- Mở `chrome://extensions` trên Chrome của VPS
- Bật **Developer mode** (góc phải)
- Tìm "Fotor Auto Register" → copy ID (ví dụ: `abcdefghijklmnopqrstuvwxyzabcdef`)

### 2.5 Chạy installer
```bash
cd /root/native-helper
chmod +x install.sh helper.sh
sudo ./install.sh <CHROME_EXT_ID>
```

Script sẽ:
- Cài `openvpn` + `nodejs`
- Copy `helper.js` + `helper.sh` vào `/opt/fotor-vpn-helper/`
- Đăng ký Native Messaging Host vào `/etc/opt/chrome/native-messaging-hosts/com.fotor.vpn.json`
- Patch tất cả `.ovpn` để dùng `auth.txt`

### 2.6 Restart Chrome
```bash
pkill chrome
sleep 2
google-chrome &
```

## 3. Test

### Test thủ công (không qua extension)
Status check:
```bash
printf '\x10\x00\x00\x00{"action":"STATUS"}' | /opt/fotor-vpn-helper/helper.sh
```

Test rotate (sẽ kill openvpn cũ + connect server mới):
```bash
printf '\x10\x00\x00\x00{"action":"ROTATE"}' | /opt/fotor-vpn-helper/helper.sh
```

### Test qua Extension
1. Mở popup extension → click **🔄 Đổi IP ngay**
2. Đợi 10-15s → badge hiển thị IP mới hoặc lỗi
3. Mở DevTools service worker (`chrome://extensions` → "service worker") để xem log

## 4. Troubleshooting

### Helper không phản hồi
```bash
tail -f /var/log/fotor-vpn/helper.log
```

### Lỗi "Specified native messaging host not found"
- Sai extension ID → chạy lại `install.sh` với ID đúng
- Chrome chưa restart sau khi cài → `pkill chrome` rồi mở lại

### Lỗi "AUTH_FAILED"
- Sai user/pass trong `/opt/surfshark/auth.txt` (phải là Manual Setup creds, KHÔNG phải pass đăng nhập)

### Lỗi "connect_timeout"
- Server VPN đó down → helper đã auto retry với server khác
- Nếu retry vẫn fail → check `tail -f /var/log/fotor-vpn/helper.log`

### IP không đổi sau ROTATE
- VPS provider (Vultr) có thể block UDP outbound → dùng config `_tcp.ovpn` thay vì `_udp.ovpn`
- Test thủ công: `openvpn --config /opt/surfshark/configs/<file>.ovpn`

### SSH/VNC rớt sau khi rotate
- Bình thường KHÔNG xảy ra (conntrack giữ session inbound). Nếu có:
  - Thêm vào tất cả `.ovpn`: `pull-filter ignore "redirect-gateway"` (chỉ tunnel browser, không tunnel toàn VPS)
  - Hoặc setup split-tunneling bằng iptables marking

## 5. Cấu trúc file

```
/opt/fotor-vpn-helper/
├── helper.js            # Native messaging host (Node.js)
└── helper.sh            # Wrapper Chrome gọi vào

/opt/surfshark/
├── auth.txt             # username/password Manual Setup (chmod 600)
└── configs/
    └── *.ovpn           # Surfshark OpenVPN configs

/etc/opt/chrome/native-messaging-hosts/
└── com.fotor.vpn.json   # Manifest đăng ký với Chrome

/var/lib/fotor-vpn/
└── state.json           # Track server đã dùng (random no-repeat)

/var/log/fotor-vpn/
└── helper.log           # Log (rotate khi >5MB, giữ 3 file)
```

## 6. Action protocol

Extension gửi JSON:
```json
{ "action": "ROTATE" }   // hoặc "STATUS" / "STOP"
```

Helper trả JSON:
```json
{ "ok": true, "server": "ad-leu.prod.surfshark.com_tcp", "oldIp": "1.2.3.4", "newIp": "85.203.x.x" }
```

Hoặc khi lỗi:
```json
{ "ok": false, "error": "connect_timeout", "detail": "..." }
```

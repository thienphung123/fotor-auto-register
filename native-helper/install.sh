#!/usr/bin/env bash
# === Fotor VPN Helper - Installer (Ubuntu / root) ===
# Cách dùng:
#   sudo ./install.sh <CHROME_EXTENSION_ID>
# CHROME_EXTENSION_ID: lấy ở chrome://extensions (bật Developer mode) -> Fotor Auto Register -> ID
set -e

EXT_ID="${1:?Cần truyền extension ID. Vào chrome://extensions copy ID của Fotor Auto Register.}"

if [ "$(id -u)" -ne 0 ]; then
    echo "Vui lòng chạy với sudo (cần quyền ghi /opt và /etc)."
    exit 1
fi

echo "==> Cài dependencies (openvpn, nodejs, curl)..."
apt update -qq
apt install -y openvpn nodejs curl

NODE_VER=$(node --version 2>/dev/null || echo "missing")
echo "node version: $NODE_VER"

echo "==> Tạo thư mục..."
mkdir -p /opt/fotor-vpn-helper
mkdir -p /opt/surfshark/configs
mkdir -p /var/lib/fotor-vpn
mkdir -p /var/log/fotor-vpn

echo "==> Copy helper..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cp "$SCRIPT_DIR/helper.js" /opt/fotor-vpn-helper/
cp "$SCRIPT_DIR/helper.sh" /opt/fotor-vpn-helper/
chmod 755 /opt/fotor-vpn-helper/helper.sh
chmod 644 /opt/fotor-vpn-helper/helper.js

echo "==> Đăng ký Native Messaging Host cho Chrome (extension ID: $EXT_ID)..."
# Chrome stable trên Linux đọc manifest từ:
#   /etc/opt/chrome/native-messaging-hosts/<name>.json (system-wide)
#   ~/.config/google-chrome/NativeMessagingHosts/<name>.json (per-user)
# Vì chạy as root + Chrome cũng bằng root -> dùng cả hai để chắc.
NM_DIRS=(
    "/etc/opt/chrome/native-messaging-hosts"
    "/root/.config/google-chrome/NativeMessagingHosts"
)
for d in "${NM_DIRS[@]}"; do
    mkdir -p "$d"
    sed "s|__EXT_ID__|${EXT_ID}|g" "$SCRIPT_DIR/com.fotor.vpn.json" > "$d/com.fotor.vpn.json"
    chmod 644 "$d/com.fotor.vpn.json"
    echo "  -> $d/com.fotor.vpn.json"
done

echo ""
echo "==> KIỂM TRA CẤU HÌNH:"
if [ ! -f /opt/surfshark/auth.txt ]; then
    echo "  ⚠️  CHƯA CÓ /opt/surfshark/auth.txt !"
    echo "      Tạo file đó với 2 dòng (username + password Manual Setup từ Surfshark dashboard):"
    echo "      nano /opt/surfshark/auth.txt"
    echo "      chmod 600 /opt/surfshark/auth.txt"
fi

OVPN_COUNT=$(ls /opt/surfshark/configs/*.ovpn 2>/dev/null | wc -l)
echo "  Số file .ovpn trong /opt/surfshark/configs/: $OVPN_COUNT"
if [ "$OVPN_COUNT" -eq 0 ]; then
    echo "  ⚠️  CHƯA CÓ FILE .ovpn ! Upload (scp) Surfshark configs vào /opt/surfshark/configs/"
fi

# Auto patch auth-user-pass nếu chưa làm
if [ "$OVPN_COUNT" -gt 0 ]; then
    NEED_PATCH=$(grep -L "^auth-user-pass /opt/surfshark/auth.txt" /opt/surfshark/configs/*.ovpn 2>/dev/null | wc -l)
    if [ "$NEED_PATCH" -gt 0 ]; then
        echo "  -> Patching $NEED_PATCH file .ovpn để dùng auth.txt..."
        sed -i 's|^auth-user-pass$|auth-user-pass /opt/surfshark/auth.txt|' /opt/surfshark/configs/*.ovpn
    fi
fi

echo ""
echo "==> XONG! Restart Chrome (toàn bộ process) để load native host:"
echo "    pkill chrome; sleep 2; google-chrome &"
echo ""
echo "Test thủ công bằng tay (không qua extension):"
echo "    echo -n -e '\\x10\\x00\\x00\\x00{\"action\":\"STATUS\"}' | /opt/fotor-vpn-helper/helper.sh | xxd"
echo ""
echo "Xem log:"
echo "    tail -f /var/log/fotor-vpn/helper.log"

#!/usr/bin/env bash
# === Fotor VPN Helper - WireGuard Installer (Ubuntu / root) ===
# Cách dùng:
#   sudo ./install-wireguard.sh <CHROME_EXTENSION_ID>
# CHROME_EXTENSION_ID: chrome://extensions (Developer mode) -> Fotor Auto Register -> ID
set -e

EXT_ID="${1:?Cần truyền extension ID. Vào chrome://extensions copy ID của Fotor Auto Register.}"

if [ "$(id -u)" -ne 0 ]; then
    echo "Vui lòng chạy với sudo (cần quyền ghi /etc và bring up wg-quick)."
    exit 1
fi

echo "==> Cài dependencies (wireguard-tools, nodejs, curl, resolvconf)..."
apt update -qq
apt install -y wireguard-tools nodejs curl resolvconf

NODE_VER=$(node --version 2>/dev/null || echo "missing")
WG_VER=$(wg --version 2>/dev/null | head -1 || echo "missing")
echo "node : $NODE_VER"
echo "wg   : $WG_VER"

echo "==> Tạo thư mục..."
mkdir -p /opt/fotor-vpn-helper
mkdir -p /var/lib/fotor-vpn
mkdir -p /var/log/fotor-vpn
# /etc/wireguard đã tồn tại sau khi cài wireguard-tools

echo "==> Copy WireGuard helper..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cp "$SCRIPT_DIR/helper-wireguard.js" /opt/fotor-vpn-helper/helper.js  # rename để wrapper sh không phải đổi
cp "$SCRIPT_DIR/helper.sh" /opt/fotor-vpn-helper/
chmod 755 /opt/fotor-vpn-helper/helper.sh
chmod 644 /opt/fotor-vpn-helper/helper.js

echo "==> Đăng ký Native Messaging Host cho Chrome (extension ID: $EXT_ID)..."
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
echo "==> KIỂM TRA CẤU HÌNH WIREGUARD:"
WG_COUNT=$(ls /etc/wireguard/*.conf 2>/dev/null | wc -l)
echo "  Số file .conf trong /etc/wireguard/: $WG_COUNT"
if [ "$WG_COUNT" -eq 0 ]; then
    echo "  ⚠️  CHƯA CÓ FILE .conf!"
    echo "      Lấy WireGuard configs từ Surfshark dashboard (Manual setup -> WireGuard),"
    echo "      upload (scp) vào /etc/wireguard/, vd:"
    echo "        scp us-nyc.conf root@vps:/etc/wireguard/"
    echo "        scp nl-ams.conf root@vps:/etc/wireguard/"
    echo "      chmod 600 /etc/wireguard/*.conf"
else
    echo "  Configs hiện có:"
    ls /etc/wireguard/*.conf | xargs -n1 basename
fi

# Cảnh báo nếu permission của .conf quá rộng (WireGuard sẽ warning)
if [ "$WG_COUNT" -gt 0 ]; then
    LOOSE=$(find /etc/wireguard -maxdepth 1 -name '*.conf' -not -perm 600 | wc -l)
    if [ "$LOOSE" -gt 0 ]; then
        echo "  -> Sửa permission $LOOSE file .conf về 600..."
        chmod 600 /etc/wireguard/*.conf
    fi
fi

echo ""
echo "==> XONG! Restart Chrome (toàn bộ process) để load native host:"
echo "    pkill chrome; sleep 2; google-chrome &"
echo ""
echo "Test thủ công (không qua extension) — STATUS:"
echo "    printf '\\x12\\x00\\x00\\x00{\"action\":\"STATUS\"}' | /opt/fotor-vpn-helper/helper.sh | xxd | head -5"
echo ""
echo "Test rotate IP:"
echo "    printf '\\x12\\x00\\x00\\x00{\"action\":\"ROTATE\"}' | /opt/fotor-vpn-helper/helper.sh | xxd | head -10"
echo ""
echo "Xem log:"
echo "    tail -f /var/log/fotor-vpn/helper.log"
echo ""
echo "Gỡ helper cũ (OpenVPN) nếu vẫn đang chạy:"
echo "    pkill openvpn 2>/dev/null"

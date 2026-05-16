#!/usr/bin/env bash
# === Fotor Credit Monitor — Installer (Ubuntu VPS) ===
# Cài service tracking credit acc chủ qua Puppeteer headless.
set -e

if [ "$(id -u)" -ne 0 ]; then
    echo "❌ Cần sudo (ghi /opt + systemd)."
    exit 1
fi

INSTALL_DIR=/opt/fotor-credit
LOG_DIR=/var/log/fotor-credit

echo "==> Tạo dirs..."
mkdir -p $INSTALL_DIR $LOG_DIR

echo "==> Cài Node.js 18+ và dependencies cho Chromium..."
if ! command -v node >/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
fi

# Puppeteer Chromium deps
apt update -qq
apt install -y \
    ca-certificates fonts-liberation \
    libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 \
    libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc-s1 libglib2.0-0 \
    libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 \
    libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 \
    libxi6 libxrandr2 libxrender1 libxss1 libxtst6 lsb-release wget \
    xdg-utils 2>/dev/null || echo "Một số package optional, tiếp tục..."

NODE_VER=$(node --version)
echo "node: $NODE_VER"

echo "==> Copy files..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cp "$SCRIPT_DIR/monitor.js"     $INSTALL_DIR/
cp "$SCRIPT_DIR/package.json"   $INSTALL_DIR/
cp "$SCRIPT_DIR/fotor-credit.service" /etc/systemd/system/

echo "==> Cài npm dependencies (puppeteer + Chromium ~150MB)..."
cd $INSTALL_DIR
npm install --omit=dev

systemctl daemon-reload

echo ""
echo "==> XONG. Service stateless — extension sẽ tự gửi cookies acc chủ qua POST."
echo "    KHÔNG cần export cookies tay (acc chủ xoay vòng theo queue)."
echo ""
echo "Lệnh quản lý:"
echo "    systemctl enable --now fotor-credit       # bật + auto-start"
echo "    systemctl status fotor-credit             # xem state"
echo "    journalctl -u fotor-credit -f             # follow log"
echo "    tail -f /var/log/fotor-credit/monitor.log # log app"
echo ""
echo "Test endpoint health (không cần cookies):"
echo "    curl http://127.0.0.1:8765/health"
echo ""
echo "Test credit check (truyền cookies từ Chrome thật):"
echo '    curl -X POST http://127.0.0.1:8765/credit/check \\'
echo '      -H "Content-Type: application/json" \\'
echo '      -d "{\"cookies\":[{\"name\":\"sessionid\",\"value\":\"...\",\"domain\":\".fotor.com\"}]}"'

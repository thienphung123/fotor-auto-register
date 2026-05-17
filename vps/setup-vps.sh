#!/usr/bin/env bash
# Fotor VPS Proxy - One-shot setup script
# Usage: sudo bash setup-vps.sh
set -e

INSTALL_DIR="/opt/fotor-proxy"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
ENV_FILE="$INSTALL_DIR/.env"

echo "==> Fotor VPS Proxy installer"
echo ""

if [[ $EUID -ne 0 ]]; then
    echo "❌ Must run as root (sudo)"
    exit 1
fi

# --- 1. Deps ---
echo "[1/6] Checking Docker..."
if ! command -v docker >/dev/null; then
    echo "❌ Docker chua cai. Cai bang: curl -fsSL https://get.docker.com | sh"
    exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
    echo "❌ docker compose plugin missing. Cai: apt install -y docker-compose-plugin"
    exit 1
fi
echo "  ✓ docker $(docker --version)"

# --- 2. Folder + files ---
echo "[2/6] Setup install dir: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR/api" "$INSTALL_DIR/api/certs"

# Copy files (assume script chay tu thu muc da co files)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp -f "$SCRIPT_DIR/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
cp -f "$SCRIPT_DIR/api/server.js" "$INSTALL_DIR/api/server.js"
cp -f "$SCRIPT_DIR/api/countries.js" "$INSTALL_DIR/api/countries.js"
cp -f "$SCRIPT_DIR/api/package.json" "$INSTALL_DIR/api/package.json"
cp -f "$SCRIPT_DIR/api/Dockerfile" "$INSTALL_DIR/api/Dockerfile"
echo "  ✓ files copied"

# --- 3. .env ---
echo "[3/6] Configure .env"
if [[ -f "$ENV_FILE" ]]; then
    echo "  ✓ .env existed, keep current (delete to regenerate)"
else
    # Prompt Surfshark creds
    read -p "  Surfshark Service User: " SS_USER
    read -p "  Surfshark Service Pass: " SS_PASS

    # Random secrets
    API_TOKEN=$(openssl rand -hex 24)
    P_USER="fotor_$(openssl rand -hex 4)"
    P_PASS=$(openssl rand -hex 16)

    cat > "$ENV_FILE" <<EOF
SURFSHARK_USER=$SS_USER
SURFSHARK_PASS=$SS_PASS
VPS_API_TOKEN=$API_TOKEN
PROXY_USER=$P_USER
PROXY_PASS=$P_PASS
EOF
    chmod 600 "$ENV_FILE"
    echo "  ✓ .env created"
fi

# --- 4. Firewall ---
echo "[4/6] UFW firewall"
if command -v ufw >/dev/null; then
    ufw allow 1080/tcp comment 'fotor proxy slot 1' >/dev/null 2>&1 || true
    ufw allow 1081/tcp comment 'fotor proxy slot 2' >/dev/null 2>&1 || true
    ufw allow 1082/tcp comment 'fotor proxy slot 3' >/dev/null 2>&1 || true
    ufw allow 8443/tcp comment 'fotor api'         >/dev/null 2>&1 || true
    echo "  ✓ ufw rules added (1080-1082, 8443)"
else
    echo "  ⚠️  ufw not installed - GCP firewall: open these ports in console"
fi

# --- 5. Docker compose up ---
echo "[5/6] docker compose up -d"
cd "$INSTALL_DIR"
docker compose pull
docker compose build api
docker compose up -d
sleep 3
docker compose ps

# --- 6. Print credentials ---
echo ""
echo "============================================================"
echo "✅ Setup DONE"
echo "============================================================"
source "$ENV_FILE"
PUBLIC_IP=$(curl -s ifconfig.me || echo "<your-vps-ip>")
echo ""
echo "📋 Copy block sau vao extension popup -> VPS Config:"
echo ""
echo "  VPS Host:     $PUBLIC_IP"
echo "  API Token:    $VPS_API_TOKEN"
echo "  Proxy User:   $PROXY_USER"
echo "  Proxy Pass:   $PROXY_PASS"
echo ""
echo "🔧 Test commands:"
echo "  curl -k https://$PUBLIC_IP:8443/"
echo "  curl -k -H 'Authorization: Bearer $VPS_API_TOKEN' https://$PUBLIC_IP:8443/status"
echo "  curl -k -H 'Authorization: Bearer $VPS_API_TOKEN' -X POST 'https://$PUBLIC_IP:8443/rotate?slot=1'"
echo "  curl -x http://$PROXY_USER:$PROXY_PASS@$PUBLIC_IP:1080 https://ifconfig.me"
echo ""
echo "📜 Logs:"
echo "  docker compose -f $COMPOSE_FILE logs -f"
echo "  docker compose -f $COMPOSE_FILE logs -f gluetun-1"
echo ""
echo "⏳ Cho ~60-90s cho 3 tunnel up lan dau (xem logs gluetun-N)"

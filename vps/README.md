# Fotor VPS Proxy (Gluetun + Surfshark OpenVPN)

3 slot proxy chay tren VPS Linux, moi slot la 1 OpenVPN tunnel toi Surfshark. Extension Chrome cau hinh proxy de chi route Chrome qua VPS, **host PC khong bi anh huong**.

## Architecture
```
Chrome → http://PROXY_USER:PROXY_PASS@vps:1080 ─┐
Chrome → http://PROXY_USER:PROXY_PASS@vps:1081 ─┼─ gluetun container N → Surfshark
Chrome → http://PROXY_USER:PROXY_PASS@vps:1082 ─┘

Extension popup "Đổi IP" → POST https://vps:8443/rotate?slot=1
   API → gluetun-N control API → swap country → restart OpenVPN → return new IP
```

## Yeu cau
- VPS Linux (Ubuntu 22.04+, Debian 12+) co Docker + docker compose plugin.
- Port mo: 1080-1082, 8443 (cloud firewall + ufw).
- Surfshark account voi **Service Credentials** (lay o https://my.surfshark.com/vpn/manual-setup/main → tab Manual setup → OpenVPN → Credentials).

## Setup

### Tu repo
```bash
git clone https://github.com/thienphung123/fotor-auto-register.git
cd fotor-auto-register/vps
sudo bash setup-vps.sh
```

Script se:
1. Hoi Surfshark Service User + Pass
2. Sinh random `VPS_API_TOKEN`, `PROXY_USER`, `PROXY_PASS`
3. Tao `/opt/fotor-proxy/` + `.env`
4. Mo firewall ufw (neu co)
5. `docker compose up -d` 3 gluetun + 1 api
6. In ra credentials cho extension

### GCP firewall (neu chua mo)
```bash
gcloud compute firewall-rules create fotor-proxy \
    --allow tcp:1080-1082,tcp:8443 \
    --source-ranges 0.0.0.0/0 \
    --description "Fotor VPS proxy"
```

## Test sau setup
```bash
PUBLIC_IP=$(curl -s ifconfig.me)
source /opt/fotor-proxy/.env

# 1. API alive
curl -k https://$PUBLIC_IP:8443/

# 2. Status 3 slot (cho ~60-90s sau khi up)
curl -k -H "Authorization: Bearer $VPS_API_TOKEN" https://$PUBLIC_IP:8443/status

# 3. Rotate slot 1
curl -k -H "Authorization: Bearer $VPS_API_TOKEN" -X POST "https://$PUBLIC_IP:8443/rotate?slot=1"

# 4. Proxy lam viec chua
curl -x "http://$PROXY_USER:$PROXY_PASS@$PUBLIC_IP:1080" https://ifconfig.me
```

## Endpoints

| Method | Path | Mo ta |
|---|---|---|
| GET | `/` | Ping (no auth) |
| GET | `/status` | Trang thai 3 slot + current country/IP |
| GET | `/ip?slot=N` | Public IP cua slot N |
| POST | `/rotate?slot=N[&country=X]` | Swap country slot N. Khong truyen `country` → random tu pool ~80 country |
| POST | `/stop?slot=N` | Stop OpenVPN slot N |

Auth: `Authorization: Bearer <VPS_API_TOKEN>` (tru `/`).

## Quan ly

```bash
cd /opt/fotor-proxy

# Xem logs
docker compose logs -f
docker compose logs -f gluetun-1
docker compose logs -f api

# Restart
docker compose restart

# Update images
docker compose pull && docker compose up -d

# Stop hoan toan
docker compose down
```

## Troubleshooting

**Gluetun khong up tunnel**
```bash
docker compose logs gluetun-1 | tail -50
```
Thuong loi: Surfshark creds sai → check `.env` SURFSHARK_USER/PASS.

**API 401 unauthorized**
- Token sai. Check `cat /opt/fotor-proxy/.env | grep VPS_API_TOKEN`.

**Self-signed cert warning trong browser**
- Binh thuong. Extension `host_permissions` accept cert qua background fetch.
- Khong mo `https://vps:8443/` truc tiep trong tab browser.

**Rotate timeout**
- Surfshark server cua country do co the dang qua tai. Thu rotate lai voi country khac:
  `POST /rotate?slot=1&country=Sweden`

## Bao mat

- `.env` chmod 600, chi root doc duoc.
- VPS_API_TOKEN 48 hex chars (192-bit entropy) → khong brute force noi.
- HTTP proxy auth user/pass random.
- Self-signed TLS cho API (extension trust qua host_permission).
- Khong expose control API gluetun (port 8000) ra ngoai - chi noi bo Docker network.

## Costs
- VPS GCP e2-micro (free tier): 0.25 vCPU, 1GB RAM → vua du chay 3 gluetun + 1 api.
- Bandwidth: 1GB egress/thang free tier → enough cho ~10k page loads.
- Neu chay nhieu hon → upgrade e2-small ($13/thang) hoac mo Always Free tier khac.

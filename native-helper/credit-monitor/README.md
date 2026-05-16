# Fotor Credit Monitor (Stateless)

Service nhẹ trên VPS Linux để check credit acc Fotor bằng cách scrape DOM.
**KHÔNG tự giữ session** — extension tự lấy cookies từ Chrome chính + POST vào service mỗi lần cần check.

## Tại sao stateless?

Acc chủ xoay vòng theo queue ref-link: khi 1 link đủ 10 ref → tool chuyển sang link của acc khác → "acc chủ" thay đổi liên tục. Export cookies tay 1 lần không khả thi.

**Cơ chế**: extension tự `chrome.cookies.getAll({domain: 'fotor.com'})` ngay sau mỗi reg → save vào storage theo email → khi cần check credit của acc nào, extension gửi cookies của acc đó qua POST.

## Setup VPS (1 lần)

```bash
cd ~/fotor-auto-register/native-helper/credit-monitor
sudo ./install.sh
sudo systemctl enable --now fotor-credit
sudo systemctl status fotor-credit
```

Installer sẽ cài Node.js 20 + Chromium deps + puppeteer (~200MB).

## API

| Method | Path | Body | Mô tả |
|--------|------|------|-------|
| GET | /health | - | Service alive check |
| POST | /credit/check | `{cookies, reload?, email?}` | Set cookies → reload /rewards → scrape credit |

Request:
```json
{
  "cookies": [
    { "name": "session", "value": "abc", "domain": ".fotor.com", "path": "/" }
  ],
  "reload": true,
  "email": "acc-chu@imail.edu.vn"
}
```

Response:
```json
{ "credit": 140, "ts": "2026-05-17T02:30Z", "email": "acc-chu@imail.edu.vn", "error": null }
```

Cookies hết hạn / sai:
```json
{ "credit": null, "error": "cookies_invalid_or_expired" }
```

## Cấu hình env

| Biến | Default | Mô tả |
|------|---------|-------|
| FOTOR_PORT | 8765 | HTTP port (bind 127.0.0.1) |
| FOTOR_LOG | /var/log/fotor-credit/monitor.log | Log path |

## Logs

```bash
tail -f /var/log/fotor-credit/monitor.log
journalctl -u fotor-credit -f
```

Debug HTML khi scrape fail: `/tmp/fotor-credit-debug.html`.

## Test thủ công

```bash
# Health
curl http://127.0.0.1:8765/health

# Check credit (giả lập extension gửi cookies)
curl -X POST http://127.0.0.1:8765/credit/check \
  -H "Content-Type: application/json" \
  -d '{"cookies":[{"name":"_ga","value":"...","domain":".fotor.com"}]}'
```

## Performance

- Mỗi request `POST /credit/check`: 5-10s (reload /rewards + đợi DOM render)
- Headless Chromium giữ chạy → RAM ~150-200MB
- 1 request/lần (busy=true reject parallel)

## Troubleshooting

| Lỗi | Fix |
|---|---|
| `cookies_invalid_or_expired` | Cookies acc đó hết hạn / sai. Extension cần lấy cookies mới |
| `credit_pattern_not_found` | Fotor đổi UI. Xem `/tmp/fotor-credit-debug.html` |
| `busy_try_later` | Request đang xử lý. Retry sau 5s |
| Chromium launch fail | `apt install -y libnss3 libatk-bridge2.0-0 libgbm1 libxss1` |
| `Could not find Chrome` | `cd /opt/fotor-credit && npx puppeteer browsers install chrome` |

## Gỡ cài

```bash
sudo systemctl disable --now fotor-credit
sudo rm /etc/systemd/system/fotor-credit.service
sudo rm -rf /opt/fotor-credit /var/log/fotor-credit
sudo systemctl daemon-reload
```

## Security

- Bind `127.0.0.1:8765` only → không expose internet
- Cookies truyền qua POST body (localhost) → không qua disk
- Service chạy headless không phải user-facing

# Tools

## `find-credit-api.js`

Script DevTools Console tự động sniff API credit của Fotor để dev biết URL + headers + body.

### Cách dùng (3 phút)

1. **Login acc chủ** ở Chrome thường (KHÔNG incognito)
2. Vào `https://www.fotor.com/rewards/`
3. **F12 → tab Console** → Click "Allow paste" nếu Chrome cảnh báo
4. Mở file `find-credit-api.js`, **Ctrl+A → Ctrl+C** copy toàn bộ
5. Paste vào Console → Enter
6. Console hiển thị `🎯 Credit Sniffer ARMED. Reload trang (F5)...`
7. **Reload trang (F5)** — script tự bắt mọi XHR/fetch
8. Đợi ~12 giây — script tự phân tích, in báo cáo, **auto-copy vào clipboard**
9. Paste (Ctrl+V) vào chat gửi dev

### Kết quả mẫu

```
=== FOTOR CREDIT API CANDIDATE ===

Best match (score=70):
URL:    https://www.fotor.com/api/user/balance
METHOD: GET
STATUS: 200

--- Request Headers ---
{ "x-csrf-token": "...", "Accept": "application/json" }

--- Response Body (raw) ---
{"code":0,"data":{"credits":145,"freeCredits":0}}

--- Detected credit field ---
credits = 145

--- Top 3 candidates (URL only) ---
#1 (score=70) GET https://www.fotor.com/api/user/balance
...
```

### Troubleshooting

- **"Không tìm thấy candidate"**: Thử click thêm vài nút trên `/rewards` (vd vào tab "My Credits" / "History") rồi đợi sniffer in lại
- **"Allow paste" không hiện**: Chrome ≥ 96 chặn paste vào Console. Gõ `allow pasting` (không phải lệnh thật) → enter, hoặc disable trong Settings → DevTools
- **Auto-copy fail**: copy thủ công block text trong Console (chuột phải → Copy)

### Privacy

Script chỉ chạy local trong DevTools, **không gửi data ra ngoài**. Phần `Request Headers` có thể chứa cookie/token — bạn có thể mask `Cookie` field trước khi gửi nếu lo ngại.

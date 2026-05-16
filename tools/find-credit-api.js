// =====================================================================
// Fotor Credit API Sniffer — paste-able vào DevTools Console
// =====================================================================
// MỤC ĐÍCH: Tự động hook fetch + XHR, log mọi response có chứa số "credit"
// và auto-copy URL + headers + body của candidate tốt nhất vào clipboard.
//
// CÁCH DÙNG:
//   1. Mở Chrome thường, login acc chủ Fotor
//   2. Vào https://www.fotor.com/rewards/
//   3. F12 → tab Console → paste TOÀN BỘ script này → Enter
//   4. Reload trang (F5)
//   5. Script chạy ~10s tự động, in ra kết quả + copy clipboard
//   6. Paste (Ctrl+V) vào Telegram/chat gửi cho dev
// =====================================================================

(() => {
    const captured = [];
    const KEYWORDS = /credit|balance|coin|point|reward|carrot/i;

    // --- Hook fetch ---
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
        const req = args[0];
        const url = typeof req === 'string' ? req : (req?.url || '');
        const init = args[1] || {};
        const startedAt = Date.now();
        const res = await origFetch.apply(this, args);
        try {
            const cloned = res.clone();
            const text = await cloned.text();
            captured.push({
                kind: 'fetch',
                url,
                method: (init.method || (req?.method) || 'GET').toUpperCase(),
                status: res.status,
                requestHeaders: init.headers || {},
                responseHeaders: Object.fromEntries(res.headers.entries()),
                body: text,
                elapsedMs: Date.now() - startedAt,
            });
        } catch (e) { /* ignore */ }
        return res;
    };

    // --- Hook XHR ---
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const origSetHdr = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__sniff = { method: method.toUpperCase(), url, headers: {}, startedAt: 0 };
        return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        if (this.__sniff) this.__sniff.headers[k] = v;
        return origSetHdr.call(this, k, v);
    };
    XMLHttpRequest.prototype.send = function (...args) {
        if (this.__sniff) {
            this.__sniff.startedAt = Date.now();
            const xhr = this;
            this.addEventListener('loadend', () => {
                try {
                    captured.push({
                        kind: 'xhr',
                        url: xhr.__sniff.url,
                        method: xhr.__sniff.method,
                        status: xhr.status,
                        requestHeaders: xhr.__sniff.headers,
                        responseHeaders: xhr.getAllResponseHeaders(),
                        body: xhr.responseText || '',
                        elapsedMs: Date.now() - xhr.__sniff.startedAt,
                    });
                } catch (e) { /* ignore */ }
            });
        }
        return origSend.apply(this, args);
    };

    console.log('%c🎯 Credit Sniffer ARMED. Reload trang (F5) để bắt request...', 'color:#27ae60;font-weight:bold;font-size:14px');
    console.log('Sau 12s tôi sẽ tự phân tích và copy kết quả vào clipboard.');

    // --- Analyzer ---
    setTimeout(async () => {
        console.log(`%c[Sniffer] Đã bắt ${captured.length} requests. Đang phân tích...`, 'color:#2980b9');

        // Filter: chỉ giữ requests TO fotor.com với JSON body có keyword
        const candidates = captured.filter(c => {
            if (!/fotor\.com/i.test(c.url)) return false;
            if (c.status >= 400) return false;
            if (!c.body) return false;
            // Ưu tiên JSON
            const isJson = c.body.trim().startsWith('{') || c.body.trim().startsWith('[');
            if (!isJson) return false;
            return KEYWORDS.test(c.body);
        });

        // Score: số lần keyword match + có số nguyên 0-9999 cạnh keyword
        const scored = candidates.map(c => {
            let score = 0;
            const matches = c.body.match(/credit|balance|coin|point|reward|carrot/gi) || [];
            score += matches.length * 10;
            // Bonus: keyword cạnh số
            if (/(credit|balance|coin|point|reward)["']?\s*:\s*\d+/i.test(c.body)) score += 50;
            // Penalty: body quá to (likely page render, not API)
            if (c.body.length > 50000) score -= 30;
            return { ...c, score };
        }).sort((a, b) => b.score - a.score);

        if (scored.length === 0) {
            console.log('%c❌ Không tìm thấy candidate. Thử reload lại trang hoặc click vào nút khác trên /rewards.', 'color:#e74c3c;font-weight:bold');
            console.log('Tất cả requests đã bắt:', captured.map(c => `[${c.status}] ${c.method} ${c.url}`));
            return;
        }

        console.log(`%c✅ Tìm thấy ${scored.length} candidates. Top 3:`, 'color:#27ae60;font-weight:bold');
        scored.slice(0, 3).forEach((c, i) => {
            console.log(`%c#${i + 1} (score=${c.score}) ${c.method} ${c.url}`, 'color:#16a085');
        });

        const best = scored[0];
        const tryParse = (() => { try { return JSON.parse(best.body); } catch { return null; } })();

        // Try detect credit number
        let detectedCredit = null;
        const findNum = (obj, depth = 0) => {
            if (detectedCredit != null || depth > 5) return;
            if (obj == null) return;
            if (typeof obj === 'object') {
                for (const [k, v] of Object.entries(obj)) {
                    if (KEYWORDS.test(k) && typeof v === 'number') {
                        detectedCredit = { key: k, value: v };
                        return;
                    }
                    findNum(v, depth + 1);
                }
            }
        };
        if (tryParse) findNum(tryParse);

        const report = [
            '=== FOTOR CREDIT API CANDIDATE ===',
            '',
            'Best match (score=' + best.score + '):',
            'URL:    ' + best.url,
            'METHOD: ' + best.method,
            'STATUS: ' + best.status,
            '',
            '--- Request Headers ---',
            JSON.stringify(best.requestHeaders, null, 2),
            '',
            '--- Response Body (raw) ---',
            best.body.length > 4000 ? best.body.slice(0, 4000) + '\n...[truncated, tổng ' + best.body.length + ' ký tự]' : best.body,
            '',
            '--- Detected credit field ---',
            detectedCredit ? `${detectedCredit.key} = ${detectedCredit.value}` : '(không tự detect được — dev sẽ xem JSON ở trên)',
            '',
            '--- Top 3 candidates (URL only) ---',
            ...scored.slice(0, 3).map((c, i) => `#${i + 1} (score=${c.score}) ${c.method} ${c.url}`),
            '',
            '=== END ===',
        ].join('\n');

        console.log(report);

        // Copy to clipboard
        try {
            await navigator.clipboard.writeText(report);
            console.log('%c📋 ĐÃ COPY vào clipboard! Paste (Ctrl+V) gửi cho dev.', 'color:#27ae60;font-weight:bold;font-size:14px');
        } catch (e) {
            console.log('%c⚠️ Auto-copy fail. Copy thủ công block text bên trên.', 'color:#e67e22');
        }
    }, 12000);
})();

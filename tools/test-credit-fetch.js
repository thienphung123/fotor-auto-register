// =====================================================================
// QUICK TEST — paste vào Console khi đang login acc chủ Fotor
// (KHÔNG cần ở /rewards, ở tab Fotor nào cũng được — miễn cùng origin)
// =====================================================================
// Nó sẽ test: background `fetch()` /rewards có lấy được số credit không?
// Nếu return số 140 (hoặc số bạn thấy) -> dev có thể code background scrape.
// =====================================================================

(async () => {
    console.log('%c🔍 Test fetch /rewards...', 'color:#2980b9;font-weight:bold');
    try {
        const html = await fetch('https://www.fotor.com/rewards/', {
            credentials: 'include',
            headers: { 'Accept': 'text/html' }
        }).then(r => r.text());

        console.log('HTML length:', html.length);

        // Try multiple patterns to find credit number
        const patterns = [
            /Credits?\s*[:：]?\s*<[^>]+>(\d+)<\/[^>]+>/i,
            /Credits?\s*[:：]?\s*(\d+)/i,
            /"credits?"\s*:\s*(\d+)/i,
            /"balance"\s*:\s*(\d+)/i,
            /data-credits?="(\d+)"/i,
        ];

        let found = null;
        for (const p of patterns) {
            const m = html.match(p);
            if (m) { found = { pattern: p.toString(), value: m[1], match: m[0].slice(0, 100) }; break; }
        }

        // Also try inline JSON state
        const stateMatch = html.match(/window\.__(?:INITIAL_STATE|NUXT|NEXT_DATA|APOLLO_STATE)__\s*=\s*({[\s\S]*?});?\s*<\/script>/);
        const inlineJson = stateMatch ? stateMatch[1].slice(0, 200) + '...' : null;

        const report = {
            urlTested: 'https://www.fotor.com/rewards/',
            httpStatus: 'OK (assumed)',
            htmlLen: html.length,
            creditFound: found,
            inlineJsonStateExists: !!inlineJson,
            inlineJsonSample: inlineJson,
            // Có dấu hiệu page render full HTML không (đã login)?
            looksLoggedIn: /sign\s*out|logout/i.test(html) && !/sign\s*up.*get.*started/i.test(html.slice(0, 5000)),
            sampleHtml1k: html.slice(0, 1000),
        };

        console.log('%c==== RESULT ====', 'color:#27ae60;font-weight:bold;font-size:14px');
        console.log(report);

        if (found) {
            console.log('%c✅ Tìm thấy credit = ' + found.value, 'color:#27ae60;font-weight:bold;font-size:18px');
        } else {
            console.log('%c⚠️ Không match regex. Kiểm tra sampleHtml1k để dò pattern khác.', 'color:#e67e22');
        }

        // Copy report
        const txt = JSON.stringify(report, null, 2);
        try {
            await navigator.clipboard.writeText(txt);
            console.log('%c📋 Đã copy report vào clipboard. Paste cho dev.', 'color:#27ae60;font-weight:bold');
        } catch (e) {
            console.log('Auto-copy fail. Right-click result object → Copy.');
        }
    } catch (e) {
        console.error('❌ Fetch fail:', e);
        console.log('Có thể: cookie expired, hoặc Fotor block fetch từ console (CSP). Thử mở https://www.fotor.com/rewards/ trên tab → F5 → đảm bảo login → paste lại script.');
    }
})();

// =====================================================================
// V2 — Verbose: tìm mọi vị trí số xuất hiện gần keyword credit/balance
// =====================================================================

(async () => {
    console.log('%c🔍 V2: fetch + scan...', 'color:#2980b9;font-weight:bold;font-size:14px');

    const html = await fetch('https://www.fotor.com/rewards/', {
        credentials: 'include',
        headers: { 'Accept': 'text/html' }
    }).then(r => r.text());

    console.log('HTML length:', html.length);

    // 1. Tìm xem số credit user thấy trên UI (vd 140) có trong HTML không?
    //    User vào prompt() báo số họ thấy.
    const userCredit = prompt('Số credit bạn thấy trên page là bao nhiêu? (vd 140)') || '140';
    const re = new RegExp('\\b' + userCredit + '\\b', 'g');
    const matches = [...html.matchAll(re)];
    console.log(`%cTìm "${userCredit}" trong HTML: ${matches.length} lần xuất hiện`,
        matches.length > 0 ? 'color:#27ae60;font-weight:bold' : 'color:#e74c3c;font-weight:bold');

    if (matches.length > 0) {
        console.log('%cContext xung quanh mỗi lần (50 ký tự trước+sau):', 'color:#16a085');
        matches.slice(0, 10).forEach((m, i) => {
            const start = Math.max(0, m.index - 50);
            const end = Math.min(html.length, m.index + userCredit.length + 50);
            console.log(`#${i + 1} @${m.index}: ...${html.slice(start, end).replace(/\s+/g, ' ')}...`);
        });
    }

    // 2. Tìm mọi keyword liên quan
    console.log('%c--- Tất cả vị trí "credit" (không phân biệt hoa thường) ---', 'color:#9b59b6');
    const creditMatches = [...html.matchAll(/credit/gi)].slice(0, 15);
    creditMatches.forEach((m, i) => {
        const start = Math.max(0, m.index - 30);
        const end = Math.min(html.length, m.index + 60);
        console.log(`#${i + 1} @${m.index}: ${html.slice(start, end).replace(/\s+/g, ' ')}`);
    });

    // 3. Tìm tất cả script tags có thể chứa user data
    console.log('%c--- <script type="application/json"> hoặc data scripts ---', 'color:#9b59b6');
    const scriptDataRe = /<script[^>]*>([\s\S]*?credits?[\s\S]*?)<\/script>/gi;
    const scriptMatches = [...html.matchAll(scriptDataRe)].slice(0, 5);
    scriptMatches.forEach((m, i) => {
        console.log(`#${i + 1}: ${m[1].slice(0, 300).replace(/\s+/g, ' ')}...`);
    });

    // 4. Check login state
    const isAnon = /sign\s*up\s*free|get\s*started\s*free/i.test(html.slice(0, 10000));
    const hasUserMenu = /sign[\s_-]?out|logout|my\s*profile|my\s*library/i.test(html);
    console.log(`%cLogin state: anon=${isAnon}, hasUserMenu=${hasUserMenu}`,
        hasUserMenu ? 'color:#27ae60' : 'color:#e74c3c');

    // 5. So sánh DOM hiện tại (đã render) vs HTML fetch (raw)
    if (location.href.includes('/rewards')) {
        const domText = document.body.innerText;
        const domCreditMatch = domText.match(/Credits?[:\s]+(\d+)/i);
        console.log('%c--- DOM rendered (page hiện tại) ---', 'color:#9b59b6');
        console.log('DOM credit match:', domCreditMatch ? domCreditMatch[0] : 'không tìm thấy');
        console.log('Top 200 ký tự innerText:', domText.slice(0, 200));
    } else {
        console.log('%c⚠️  Đang không ở /rewards. Mở tab https://www.fotor.com/rewards/ và chạy lại để so DOM.', 'color:#e67e22');
    }

    // 6. Try to find inline JSON with user data
    const jsonScripts = [...html.matchAll(/<script[^>]*type="application\/(?:ld\+)?json"[^>]*>([\s\S]*?)<\/script>/gi)];
    console.log(`%cInline JSON scripts: ${jsonScripts.length}`, 'color:#9b59b6');
    jsonScripts.slice(0, 3).forEach((m, i) => {
        console.log(`JSON #${i + 1}:`, m[1].slice(0, 400));
    });

    // 7. Headers - check what cookies are being sent
    console.log('%c--- Cookies hiện đang có (document.cookie) ---', 'color:#9b59b6');
    console.log(document.cookie.slice(0, 500));

    console.log('%c=== HẾT ===', 'color:#2c3e50;font-weight:bold');
    console.log('Copy toàn bộ output (chuột phải Console -> Save as...) hoặc screenshot gửi dev.');
})();

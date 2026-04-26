// Hook.js - Chạy trong MAIN world TRƯỚC KHI Fotor load (document_start)
// Mục tiêu: Tự chặn luôn window.prompt, đọc link, và gửi về content.js

(function() {
    // Stealth: Mask automation markers
    try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch (e) {}

    // Hook.js - Chạy trong MAIN world TRƯỚC KHI Fotor load (document_start)
    const _prompt = window.prompt;
    window.prompt = function(msg, defaultValue) {
        // Fotor gọi hàm này với defaultValue = link referral
        if (defaultValue && typeof defaultValue === 'string' && defaultValue.includes('fotor.com')) {
            // Gửi link về content.js qua postMessage
            window.postMessage({ type: 'FOTOR_REF_LINK', link: defaultValue }, '*');
            // Trả về defaultValue để Fotor nghĩ user đã bấm OK (không cần hiện popup)
            return defaultValue;
        }
        // Với các prompt khác thì hiện bình thường
        return _prompt.apply(this, arguments);
    };

    // Cũng chặn clipboard API
    if (navigator.clipboard && navigator.clipboard.writeText) {
        const _write = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = function(t) {
            if (t && t.includes('fotor.com/referrer')) {
                window.postMessage({ type: 'FOTOR_REF_LINK', link: t }, '*');
            }
            return _write(t);
        };
    }
})();

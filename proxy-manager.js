// === VPS Proxy Manager ===
// Quan ly chrome.proxy.settings de route Chrome qua VPS proxy (gluetun + Surfshark).
// Auth HTTP proxy bang webRequest.onAuthRequired tra creds tu chrome.storage.
//
// API extension dung:
//   - getVpsConfig() / saveVpsConfig({host, apiToken, proxyUser, proxyPass})
//   - setProxySlot(slot)        // set chrome.proxy toi VPS slot 1/2/3
//   - clearProxy()              // direct mode
//   - rotateProxy()             // cycle slot + goi VPS API rotate
//   - getStatus()               // GET /status tu VPS API
//   - testConnection()          // ping VPS API
//
// VPS slot -> port mapping:
//   slot 1 -> port 1080
//   slot 2 -> port 1081
//   slot 3 -> port 1082

'use strict';

const VPS_PROXY_PORT_BASE = 1080;  // slot 1 = 1080, slot 2 = 1081, slot 3 = 1082
const VPS_API_PORT = 8443;
const VPS_SLOTS = [1, 2, 3];
const STORAGE_KEY = 'vpsProxyConfig';
const STATE_KEY = 'vpsProxyState';

// === Config persistence ===
async function getVpsConfig() {
    const db = await chrome.storage.local.get([STORAGE_KEY]);
    return db[STORAGE_KEY] || { host: '', apiToken: '', proxyUser: '', proxyPass: '', currentSlot: 1, enabled: false };
}

async function saveVpsConfig(cfg) {
    const current = await getVpsConfig();
    const merged = { ...current, ...cfg };
    await chrome.storage.local.set({ [STORAGE_KEY]: merged });
    return merged;
}

async function getProxyState() {
    const db = await chrome.storage.local.get([STATE_KEY]);
    return db[STATE_KEY] || { currentSlot: 1, currentIp: null, currentCountry: null, lastRotateAt: 0 };
}

async function saveProxyState(state) {
    const current = await getProxyState();
    await chrome.storage.local.set({ [STATE_KEY]: { ...current, ...state } });
}

// === chrome.proxy.settings ===
async function setProxySlot(slot) {
    const cfg = await getVpsConfig();
    if (!cfg.host) throw new Error('vps_host_missing');
    if (slot < 1 || slot > VPS_SLOTS.length) throw new Error('invalid_slot:' + slot);

    const port = VPS_PROXY_PORT_BASE + (slot - 1);
    const proxyConfig = {
        mode: 'fixed_servers',
        rules: {
            singleProxy: {
                scheme: 'http',
                host: cfg.host,
                port
            },
            // Khong proxy local + VPS API + Telegram (extension goi truc tiep)
            bypassList: [
                'localhost',
                '127.0.0.1',
                '<local>',
                cfg.host,                          // skip VPS host
                'api.telegram.org'
            ]
        }
    };
    await chrome.proxy.settings.set({ value: proxyConfig, scope: 'regular' });
    await saveProxyState({ currentSlot: slot, lastRotateAt: Date.now() });
    console.log('[ProxyManager] proxy set to', cfg.host + ':' + port, 'slot', slot);
}

async function clearProxy() {
    await chrome.proxy.settings.set({
        value: { mode: 'direct' },
        scope: 'regular'
    });
    await saveProxyState({ currentSlot: null, currentIp: null });
    console.log('[ProxyManager] proxy cleared (direct)');
}

// === Auth handler ===
// Khi proxy yeu cau auth, tra ve creds tu storage
function attachAuthHandler() {
    if (chrome.webRequest && chrome.webRequest.onAuthRequired) {
        // Idempotent: remove + add
        try { chrome.webRequest.onAuthRequired.removeListener(handleAuthRequired); } catch (_) {}
        chrome.webRequest.onAuthRequired.addListener(
            handleAuthRequired,
            { urls: ['<all_urls>'] },
            ['blocking']
        );
        console.log('[ProxyManager] auth handler attached');
    } else {
        console.warn('[ProxyManager] webRequest.onAuthRequired not available');
    }
}

function handleAuthRequired(details, callback) {
    // Chi xu ly proxy auth (khong xu ly server auth like Fotor login)
    if (!details.isProxy) {
        if (callback) callback({});
        return {};
    }
    // Async lay config
    chrome.storage.local.get([STORAGE_KEY]).then(db => {
        const cfg = db[STORAGE_KEY] || {};
        if (cfg.proxyUser && cfg.proxyPass) {
            console.log('[ProxyManager] providing proxy auth for', details.url);
            callback({ authCredentials: { username: cfg.proxyUser, password: cfg.proxyPass } });
        } else {
            callback({ cancel: true });
        }
    }).catch(() => callback({ cancel: true }));
    return; // sync return = will call callback async
}

// === VPS API calls ===
async function vpsApiFetch(path, opts = {}) {
    const cfg = await getVpsConfig();
    if (!cfg.host || !cfg.apiToken) throw new Error('vps_config_missing');
    const url = `http://${cfg.host}:${VPS_API_PORT}${path}`;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs || 45000);
    try {
        const res = await fetch(url, {
            method: opts.method || 'GET',
            headers: {
                'Authorization': `Bearer ${cfg.apiToken}`,
                ...(opts.body ? { 'Content-Type': 'application/json' } : {})
            },
            body: opts.body ? JSON.stringify(opts.body) : undefined,
            signal: ctrl.signal
        });
        clearTimeout(timeout);
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        if (!res.ok) throw new Error(`vps_api_${res.status}: ${(json && json.error) || text.slice(0, 200)}`);
        return json;
    } catch (e) {
        clearTimeout(timeout);
        if (e.name === 'AbortError') throw new Error('vps_api_timeout');
        throw e;
    }
}

async function testConnection() {
    return vpsApiFetch('/', { timeoutMs: 8000 });
}

async function getStatus() {
    return vpsApiFetch('/status', { timeoutMs: 10000 });
}

async function rotateApi(slot, country) {
    const q = country ? `?slot=${slot}&country=${encodeURIComponent(country)}` : `?slot=${slot}`;
    return vpsApiFetch('/rotate' + q, { method: 'POST', timeoutMs: 60000 });
}

// === High-level: rotate proxy ===
async function rotateProxy(opts = {}) {
    const cfg = await getVpsConfig();
    const state = await getProxyState();
    // Cycle slot 1 -> 2 -> 3 -> 1...
    const nextSlot = ((state.currentSlot || 0) % VPS_SLOTS.length) + 1;

    // Bao VPS rotate slot do (random country tu pool)
    const result = await rotateApi(nextSlot, opts.country || null);
    if (!result || !result.ok) {
        throw new Error('vps_rotate_failed: ' + JSON.stringify(result));
    }

    // Set Chrome proxy toi slot do
    await setProxySlot(nextSlot);

    await saveProxyState({
        currentSlot: nextSlot,
        currentIp: result.ip,
        currentCountry: result.country,
        lastRotateAt: Date.now()
    });

    return {
        ok: true,
        slot: nextSlot,
        ip: result.ip,
        country: result.country,
        region: result.region,
        elapsedMs: result.elapsedMs
    };
}

// === Export to global (service worker context) ===
globalThis.ProxyManager = {
    getVpsConfig,
    saveVpsConfig,
    getProxyState,
    saveProxyState,
    setProxySlot,
    clearProxy,
    attachAuthHandler,
    testConnection,
    getStatus,
    rotateApi,
    rotateProxy,
    VPS_SLOTS,
    VPS_PROXY_PORT_BASE,
    VPS_API_PORT
};

// Auto-attach auth handler on service worker startup
attachAuthHandler();

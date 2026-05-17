// Fotor VPS API - Rotate orchestrator
// HTTPS server :8443, Bearer token auth, control gluetun containers qua HTTP API
//
// Endpoints:
//   GET  /                       -> { ok: true, service: 'fotor-vps-api', slots: [...] }
//   GET  /status                 -> trang thai 3 slot (running/stopped + current country)
//   GET  /ip?slot=N              -> public IP cua slot N (1-3)
//   POST /rotate?slot=N&country=X -> swap country cho slot N, return { ip, country, server }
//                                    Neu khong truyen country -> random tu countries.js
//   POST /stop?slot=N            -> stop OpenVPN slot N (giu container nhung dung tunnel)
//
// Auth: header `Authorization: Bearer <VPS_API_TOKEN>`
//
// Gluetun control API: GET/PUT http://gluetun-N:8000/v1/openvpn/{status,settings,...}
//                      GET     http://gluetun-N:8000/v1/publicip/ip
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const COUNTRIES = require('./countries.js');

const PORT = parseInt(process.env.PORT || '8443', 10);
const TOKEN = process.env.VPS_API_TOKEN || '';
const SLOTS_RAW = (process.env.SLOTS || 'gluetun-1:8000,gluetun-2:8000,gluetun-3:8000').split(',');
const CREDIT_MONITOR_HOST = process.env.CREDIT_MONITOR_HOST || 'credit-monitor';
const CREDIT_MONITOR_PORT = parseInt(process.env.CREDIT_MONITOR_PORT || '8765', 10);
const SLOTS = SLOTS_RAW.map((s, i) => {
    const [host, port] = s.split(':');
    return { index: i + 1, host: host.trim(), port: parseInt(port, 10) || 8000 };
});

const CERT_DIR = path.join(__dirname, 'certs');
const CERT_PATH = path.join(CERT_DIR, 'server.crt');
const KEY_PATH = path.join(CERT_DIR, 'server.key');

if (!TOKEN || TOKEN.length < 16) {
    console.error('FATAL: VPS_API_TOKEN missing or too short');
    process.exit(1);
}

// === Self-signed cert ===
function ensureCert() {
    if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
        console.log('[cert] reusing existing cert at', CERT_PATH);
        return;
    }
    fs.mkdirSync(CERT_DIR, { recursive: true });
    console.log('[cert] generating self-signed cert (4096-bit RSA, 10 years)...');
    // Note: openssl available in node:22-alpine via apk add openssl in Dockerfile
    execSync(
        `openssl req -x509 -newkey rsa:4096 -nodes -keyout "${KEY_PATH}" -out "${CERT_PATH}" -days 3650 -subj "/CN=fotor-vps-api" -addext "subjectAltName=DNS:fotor-vps-api,DNS:localhost,IP:0.0.0.0"`,
        { stdio: 'inherit' }
    );
    console.log('[cert] generated');
}
ensureCert();

// === Helper: call gluetun control API ===
function gluetunRequest(slot, opts) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: slot.host,
            port: slot.port,
            path: opts.path,
            method: opts.method || 'GET',
            timeout: opts.timeout || 30000,
            headers: opts.body ? { 'Content-Type': 'application/json' } : {}
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const j = data ? JSON.parse(data) : null;
                    resolve({ status: res.statusCode, body: j, raw: data });
                } catch (e) {
                    resolve({ status: res.statusCode, body: null, raw: data });
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('gluetun timeout: ' + opts.path)); });
        if (opts.body) req.write(JSON.stringify(opts.body));
        req.end();
    });
}

// === Wait gluetun back up after restart ===
async function waitTunnelUp(slot, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const r = await gluetunRequest(slot, { path: '/v1/vpn/status', timeout: 3000 });
            if (r.status === 200 && r.body && r.body.status === 'running') return true;
        } catch (_) {}
        await new Promise(r => setTimeout(r, 1000));
    }
    return false;
}

// === Rotate logic ===
const slotState = SLOTS.map(s => ({ slot: s.index, currentCountry: null, lastRotateAt: 0 }));

function pickRandomCountry(excludeList = []) {
    const pool = COUNTRIES.filter(c => !excludeList.includes(c));
    if (pool.length === 0) return COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)];
    return pool[Math.floor(Math.random() * pool.length)];
}

async function rotateSlot(slotIdx, requestedCountry) {
    const slot = SLOTS[slotIdx - 1];
    if (!slot) throw new Error('invalid slot: ' + slotIdx);

    // Tranh dung lai cung country voi 2 slot khac
    const inUse = slotState
        .filter(s => s.slot !== slotIdx)
        .map(s => s.currentCountry)
        .filter(Boolean);
    const country = requestedCountry || pickRandomCountry(inUse);

    console.log(`[rotate] slot ${slotIdx}: -> ${country}`);

    // Step 1: PUT /v1/vpn/settings (new path, /v1/openvpn/settings deprecated)
    // Body shape: { provider: { server_selection: { countries: [...] } } }
    const setRes = await gluetunRequest(slot, {
        method: 'PUT',
        path: '/v1/vpn/settings',
        body: { provider: { serverSelection: { countries: [country] } } }
    });
    if (setRes.status !== 200 && setRes.status !== 204) {
        // Fallback try snake_case
        const retry = await gluetunRequest(slot, {
            method: 'PUT',
            path: '/v1/vpn/settings',
            body: { provider: { server_selection: { countries: [country] } } }
        });
        if (retry.status !== 200 && retry.status !== 204) {
            throw new Error(`settings update fail (${setRes.status}/${retry.status}): ${setRes.raw}`);
        }
    }

    // Step 2: stop -> start VPN to apply new settings
    await gluetunRequest(slot, { method: 'PUT', path: '/v1/vpn/status', body: { status: 'stopped' } });
    await new Promise(r => setTimeout(r, 1500));
    await gluetunRequest(slot, { method: 'PUT', path: '/v1/vpn/status', body: { status: 'running' } });

    // Step 3: wait tunnel back up (poll via /v1/vpn/status)
    const ok = await waitTunnelUp(slot, 30000);
    if (!ok) throw new Error('tunnel did not come up within 30s');

    // Step 4: fetch new IP
    await new Promise(r => setTimeout(r, 2000));
    const ipRes = await gluetunRequest(slot, { path: '/v1/publicip/ip', timeout: 5000 });
    const ip = ipRes.body && ipRes.body.public_ip ? ipRes.body.public_ip : null;

    slotState[slotIdx - 1].currentCountry = country;
    slotState[slotIdx - 1].lastRotateAt = Date.now();

    return { slot: slotIdx, country, ip, region: ipRes.body && ipRes.body.region || null };
}

// === HTTP handlers ===
function jsonReply(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

function checkAuth(req) {
    const h = req.headers['authorization'] || '';
    return h === `Bearer ${TOKEN}`;
}

function parseQuery(url) {
    const q = url.split('?')[1] || '';
    const out = {};
    q.split('&').forEach(kv => {
        if (!kv) return;
        const [k, v] = kv.split('=');
        out[decodeURIComponent(k)] = decodeURIComponent(v || '');
    });
    return out;
}

async function handleRequest(req, res) {
    const startTime = Date.now();
    const url = req.url || '/';
    const pathname = url.split('?')[0];
    const query = parseQuery(url);

    try {
        // Public ping (no auth)
        if (req.method === 'GET' && pathname === '/') {
            return jsonReply(res, 200, {
                ok: true,
                service: 'fotor-vps-api',
                slots: SLOTS.map(s => ({ slot: s.index, host: s.host }))
            });
        }

        if (!checkAuth(req)) return jsonReply(res, 401, { ok: false, error: 'unauthorized' });

        if (req.method === 'GET' && pathname === '/status') {
            const results = await Promise.all(SLOTS.map(async (slot) => {
                try {
                    const [statusRes, ipRes] = await Promise.all([
                        gluetunRequest(slot, { path: '/v1/vpn/status', timeout: 3000 }),
                        gluetunRequest(slot, { path: '/v1/publicip/ip', timeout: 3000 }).catch(() => ({ body: null }))
                    ]);
                    return {
                        slot: slot.index,
                        status: statusRes.body && statusRes.body.status,
                        country: slotState[slot.index - 1].currentCountry,
                        ip: ipRes.body && ipRes.body.public_ip,
                        region: ipRes.body && ipRes.body.region,
                        city: ipRes.body && ipRes.body.city
                    };
                } catch (e) {
                    return { slot: slot.index, error: e.message };
                }
            }));
            return jsonReply(res, 200, { ok: true, slots: results });
        }

        if (req.method === 'GET' && pathname === '/ip') {
            const slotIdx = parseInt(query.slot, 10);
            if (!slotIdx || slotIdx < 1 || slotIdx > SLOTS.length) {
                return jsonReply(res, 400, { ok: false, error: 'invalid slot' });
            }
            const r = await gluetunRequest(SLOTS[slotIdx - 1], { path: '/v1/publicip/ip', timeout: 5000 });
            return jsonReply(res, 200, { ok: true, slot: slotIdx, ...r.body });
        }

        if (req.method === 'POST' && pathname === '/rotate') {
            const slotIdx = parseInt(query.slot, 10);
            if (!slotIdx || slotIdx < 1 || slotIdx > SLOTS.length) {
                return jsonReply(res, 400, { ok: false, error: 'invalid slot' });
            }
            const result = await rotateSlot(slotIdx, query.country || null);
            return jsonReply(res, 200, { ok: true, ...result, elapsedMs: Date.now() - startTime });
        }

        // === Credit monitor proxy ===
        // POST /credit/check {cookies, reload?, email?} -> forward to credit-monitor:8765
        if (req.method === 'POST' && pathname === '/credit/check') {
            const body = await new Promise((resolve, reject) => {
                const chunks = [];
                req.on('data', c => chunks.push(c));
                req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                req.on('error', reject);
            });
            const result = await new Promise((resolve, reject) => {
                const upstreamReq = http.request({
                    host: CREDIT_MONITOR_HOST,
                    port: CREDIT_MONITOR_PORT,
                    path: '/credit/check',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                    timeout: 60000
                }, (upstreamRes) => {
                    let data = '';
                    upstreamRes.on('data', c => data += c);
                    upstreamRes.on('end', () => resolve({ status: upstreamRes.statusCode, body: data }));
                });
                upstreamReq.on('error', reject);
                upstreamReq.on('timeout', () => { upstreamReq.destroy(); reject(new Error('credit_monitor_timeout')); });
                upstreamReq.write(body);
                upstreamReq.end();
            });
            res.writeHead(result.status || 200, { 'Content-Type': 'application/json' });
            return res.end(result.body);
        }

        if (req.method === 'POST' && pathname === '/stop') {
            const slotIdx = parseInt(query.slot, 10);
            if (!slotIdx || slotIdx < 1 || slotIdx > SLOTS.length) {
                return jsonReply(res, 400, { ok: false, error: 'invalid slot' });
            }
            await gluetunRequest(SLOTS[slotIdx - 1], { method: 'PUT', path: '/v1/vpn/status', body: { status: 'stopped' } });
            return jsonReply(res, 200, { ok: true, slot: slotIdx, status: 'stopped' });
        }

        return jsonReply(res, 404, { ok: false, error: 'not_found', path: pathname });
    } catch (e) {
        console.error('[handler] error:', e.message);
        return jsonReply(res, 500, { ok: false, error: 'internal', detail: e.message });
    }
}

// === Start server ===
const httpsOpts = {
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH)
};
const server = https.createServer(httpsOpts, handleRequest);
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[fotor-vps-api] listening on https://0.0.0.0:${PORT}`);
    console.log(`[fotor-vps-api] slots: ${SLOTS.map(s => s.host).join(', ')}`);
    console.log(`[fotor-vps-api] token: ${TOKEN.slice(0, 4)}...${TOKEN.slice(-4)} (len ${TOKEN.length})`);
});

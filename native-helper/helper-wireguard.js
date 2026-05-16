#!/usr/bin/env node
// === Fotor VPN Helper — WireGuard Edition (Native Messaging Host) ===
// Chạy as root trên Ubuntu VPS. Nhận lệnh từ Chrome Extension qua stdio Native Messaging.
//
// WireGuard nhanh hơn OpenVPN: tunnel up trong 1-3s vs 8-15s, memory ~5MB vs ~30MB.
//
// Action ROTATE: bring down all wg interfaces -> random pick .conf không lặp
//                -> wg-quick up <name> -> verify IP -> reply { ok, server, newIp }
// Action STATUS: trả về { connected, currentInterface, ip }
// Action STOP:   bring down all wg interfaces, trả ok
//
// Chrome Native Messaging protocol: 4-byte little-endian length + UTF-8 JSON.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

// === CẤU HÌNH ===
const CONFIG_DIR     = '/etc/wireguard';                // standard WG location
const STATE_FILE     = '/var/lib/fotor-vpn/state.json';
const LOG_DIR        = '/var/log/fotor-vpn';
const LOG_FILE       = path.join(LOG_DIR, 'helper.log');
const LOG_MAX_BYTES  = 5 * 1024 * 1024; // 5MB
const LOG_KEEP       = 3;
const IP_CHECK_TIMEOUT = 5000;

// === LOGGING ===
function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} }
ensureDir(LOG_DIR);
ensureDir(path.dirname(STATE_FILE));

function rotateLogIfNeeded() {
    try {
        const st = fs.statSync(LOG_FILE);
        if (st.size < LOG_MAX_BYTES) return;
        for (let i = LOG_KEEP - 1; i >= 1; i--) {
            const a = `${LOG_FILE}.${i}`;
            const b = `${LOG_FILE}.${i + 1}`;
            if (fs.existsSync(a)) fs.renameSync(a, b);
        }
        fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch (_) {}
}
function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try { rotateLogIfNeeded(); fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}

// === NATIVE MESSAGING I/O ===
function readNativeMessage() {
    return new Promise((resolve, reject) => {
        let header = Buffer.alloc(0);
        let body = Buffer.alloc(0);
        let phase = 'header';
        let bodyLen = 0;
        const onData = (chunk) => {
            if (phase === 'header') {
                header = Buffer.concat([header, chunk]);
                if (header.length >= 4) {
                    bodyLen = header.readUInt32LE(0);
                    body = Buffer.concat([body, header.slice(4)]);
                    phase = 'body';
                    if (body.length >= bodyLen) finish();
                }
            } else {
                body = Buffer.concat([body, chunk]);
                if (body.length >= bodyLen) finish();
            }
        };
        const finish = () => {
            process.stdin.removeListener('data', onData);
            process.stdin.removeListener('end', onEnd);
            try { resolve(JSON.parse(body.slice(0, bodyLen).toString('utf8'))); }
            catch (e) { reject(e); }
        };
        const onEnd = () => reject(new Error('stdin closed'));
        process.stdin.on('data', onData);
        process.stdin.on('end', onEnd);
    });
}

function writeNativeMessage(obj) {
    const buf = Buffer.from(JSON.stringify(obj), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(buf.length, 0);
    process.stdout.write(Buffer.concat([header, buf]));
}

// === STATE ===
function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch (_) { return { used: [] }; }
}
function saveState(s) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { log('saveState err: ' + e.message); }
}

// === WG CONTROL ===
function listConfigs() {
    try {
        return fs.readdirSync(CONFIG_DIR)
            .filter(f => f.endsWith('.conf'))
            .map(f => path.basename(f, '.conf')); // chỉ giữ tên không có .conf (wg-quick syntax)
    } catch (e) { log('listConfigs err: ' + e.message); return []; }
}

function pickConfig() {
    const all = listConfigs();
    if (all.length === 0) return null;
    let state = loadState();
    let pool = all.filter(c => !state.used.includes(c));
    if (pool.length === 0) {
        log('Đã quay hết ' + all.length + ' WG configs -> reset cycle.');
        state = { used: [] };
        pool = all.slice();
    }
    const picked = pool[Math.floor(Math.random() * pool.length)];
    state.used.push(picked);
    saveState(state);
    return picked;
}

function getActiveInterfaces() {
    // `wg show interfaces` trả về list interface name space-separated, hoặc empty
    try {
        const out = execSync('wg show interfaces 2>/dev/null', { encoding: 'utf8' }).trim();
        return out ? out.split(/\s+/) : [];
    } catch (_) { return []; }
}

function bringDownAll() {
    const active = getActiveInterfaces();
    for (const iface of active) {
        try {
            log('wg-quick down ' + iface);
            execSync(`wg-quick down ${iface} 2>&1`, { encoding: 'utf8', timeout: 10000 });
        } catch (e) {
            log('wg-quick down ' + iface + ' err: ' + (e.message || e));
        }
    }
}

function bringUp(name) {
    log('wg-quick up ' + name);
    try {
        const out = execSync(`wg-quick up ${name} 2>&1`, { encoding: 'utf8', timeout: 15000 });
        log('wg-quick up output: ' + out.slice(0, 500));
        return true;
    } catch (e) {
        log('wg-quick up ' + name + ' FAILED: ' + (e.message || e));
        if (e.stderr) log('stderr: ' + e.stderr.toString().slice(0, 500));
        return false;
    }
}

function fetchIP() {
    return new Promise((resolve) => {
        const req = https.get('https://api.ipify.org', { timeout: IP_CHECK_TIMEOUT }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data.trim()));
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

// === ACTIONS ===
async function actionRotate() {
    const oldIp = await fetchIP();
    log('Old IP: ' + oldIp);
    bringDownAll();

    const cfg = pickConfig();
    if (!cfg) return { ok: false, error: 'no_configs_found', dir: CONFIG_DIR };
    log('Picked WG config: ' + cfg);

    let upped = bringUp(cfg);
    if (!upped) {
        // Thử config khác
        const cfg2 = pickConfig();
        if (cfg2 && cfg2 !== cfg) {
            upped = bringUp(cfg2);
            if (upped) {
                await new Promise(r => setTimeout(r, 1500));
                const newIp = await fetchIP();
                return { ok: true, server: cfg2, oldIp, newIp, retried: true };
            }
        }
        return { ok: false, error: 'wg_up_failed', server: cfg };
    }

    // Đợi 1.5s cho route table settle
    await new Promise(r => setTimeout(r, 1500));
    const newIp = await fetchIP();
    log('New IP: ' + newIp);
    return { ok: true, server: cfg, oldIp, newIp };
}

async function actionStatus() {
    const active = getActiveInterfaces();
    const ip = await fetchIP();
    return {
        ok: true,
        connected: active.length > 0,
        currentInterface: active[0] || null,
        activeInterfaces: active,
        ip
    };
}

async function actionStop() {
    bringDownAll();
    return { ok: true };
}

// === MAIN ===
(async () => {
    try {
        const msg = await readNativeMessage();
        log('Received: ' + JSON.stringify(msg));
        let result;
        switch ((msg && msg.action) || '') {
            case 'ROTATE': result = await actionRotate(); break;
            case 'STATUS': result = await actionStatus(); break;
            case 'STOP':   result = await actionStop();   break;
            default: result = { ok: false, error: 'unknown_action', action: msg && msg.action };
        }
        log('Reply: ' + JSON.stringify(result));
        writeNativeMessage(result);
        setTimeout(() => process.exit(0), 100);
    } catch (e) {
        log('FATAL: ' + (e && e.stack || e));
        try { writeNativeMessage({ ok: false, error: 'helper_crash', detail: String(e && e.message || e) }); } catch (_) {}
        process.exit(1);
    }
})();

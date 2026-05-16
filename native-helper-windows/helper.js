#!/usr/bin/env node
// === Fotor VPN Helper — WireGuard for Windows (Native Messaging Host) ===
// Cài thông qua install.ps1 (chạy as Administrator).
//
// Yêu cầu:
//   - WireGuard for Windows: https://www.wireguard.com/install/
//   - Node.js LTS: https://nodejs.org
//   - File .conf để ở folder cố định (mặc định C:\WireGuard\Surfshark\*.conf)
//
// Cơ chế:
//   - Dùng `wireguard.exe /installtunnelservice <conf-path>` để bring up
//   - Dùng `wireguard.exe /uninstalltunnelservice <name>` để bring down
//   - Cycle qua list .conf, không lặp đến khi cạn
//
// LƯU Ý: tunnel service install/uninstall yêu cầu admin. Helper này phải chạy
// elevated. Cài bằng install.ps1 -AsAdmin để Chrome gọi qua scheduled task admin.

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const https = require('https');

// === CẤU HÌNH ===
const CONFIG_DIR = process.env.FOTOR_WG_CONFIG_DIR || 'C:\\WireGuard\\Surfshark';
const STATE_DIR  = path.join(process.env.LOCALAPPDATA || 'C:\\Temp', 'fotor-vpn-helper');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const LOG_DIR    = STATE_DIR;
const LOG_FILE   = path.join(LOG_DIR, 'helper.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP   = 3;
const IP_CHECK_TIMEOUT = 5000;

// wireguard.exe path - thử các nơi thông thường
const WG_EXE_CANDIDATES = [
    'C:\\Program Files\\WireGuard\\wireguard.exe',
    'C:\\Program Files (x86)\\WireGuard\\wireguard.exe',
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'WireGuard', 'wireguard.exe') : null,
].filter(Boolean);

function findWgExe() {
    for (const p of WG_EXE_CANDIDATES) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

// === LOGGING ===
function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} }
ensureDir(LOG_DIR);
ensureDir(STATE_DIR);

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
    catch (_) { return { used: [], currentTunnel: null }; }
}
function saveState(s) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
    catch (e) { log('saveState err: ' + e.message); }
}

// === WG CONTROL ===
function listConfigs() {
    try {
        return fs.readdirSync(CONFIG_DIR)
            .filter(f => f.toLowerCase().endsWith('.conf'))
            .map(f => ({
                name: path.basename(f, path.extname(f)),  // tên không có .conf
                path: path.join(CONFIG_DIR, f)
            }));
    } catch (e) { log('listConfigs err: ' + e.message + ' (dir=' + CONFIG_DIR + ')'); return []; }
}

function pickConfig() {
    const all = listConfigs();
    if (all.length === 0) return null;
    let state = loadState();
    let pool = all.filter(c => !state.used.includes(c.name));
    if (pool.length === 0) {
        log('Đã quay hết ' + all.length + ' WG configs -> reset cycle.');
        state = { used: [], currentTunnel: state.currentTunnel };
        pool = all.slice();
    }
    const picked = pool[Math.floor(Math.random() * pool.length)];
    state.used.push(picked.name);
    saveState(state);
    return picked;
}

function listActiveTunnels() {
    // Liệt kê các tunnel service Windows đang được WireGuard quản lý
    // Service name format: WireGuardTunnel$<TunnelName>
    try {
        const out = execSync('sc.exe query type= service state= all', { encoding: 'utf8', timeout: 5000 });
        const matches = [...out.matchAll(/SERVICE_NAME:\s*WireGuardTunnel\$([^\r\n]+)/g)];
        return matches.map(m => m[1].trim());
    } catch (e) { log('listActiveTunnels err: ' + e.message); return []; }
}

function bringDownAll(wgExe) {
    const active = listActiveTunnels();
    for (const name of active) {
        try {
            log('uninstall tunnel: ' + name);
            execFileSync(wgExe, ['/uninstalltunnelservice', name], { timeout: 10000 });
        } catch (e) {
            log('uninstall ' + name + ' err: ' + (e.message || e));
        }
    }
    return active.length;
}

function bringUp(wgExe, configPath) {
    try {
        log('install tunnel: ' + configPath);
        execFileSync(wgExe, ['/installtunnelservice', configPath], { timeout: 15000 });
        return true;
    } catch (e) {
        log('install tunnel FAILED: ' + (e.message || e));
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
    const wgExe = findWgExe();
    if (!wgExe) return { ok: false, error: 'wireguard_exe_not_found', searched: WG_EXE_CANDIDATES };

    const oldIp = await fetchIP();
    log('Old IP: ' + oldIp);

    const downCount = bringDownAll(wgExe);
    log('Brought down ' + downCount + ' tunnels');

    const cfg = pickConfig();
    if (!cfg) return { ok: false, error: 'no_configs_found', dir: CONFIG_DIR };
    log('Picked WG: ' + cfg.name + ' (' + cfg.path + ')');

    let upped = bringUp(wgExe, cfg.path);
    if (!upped) {
        const cfg2 = pickConfig();
        if (cfg2 && cfg2.name !== cfg.name) {
            upped = bringUp(wgExe, cfg2.path);
            if (upped) {
                let state = loadState(); state.currentTunnel = cfg2.name; saveState(state);
                await new Promise(r => setTimeout(r, 2000));
                const newIp = await fetchIP();
                return { ok: true, server: cfg2.name, oldIp, newIp, retried: true };
            }
        }
        return { ok: false, error: 'wg_up_failed', server: cfg.name };
    }

    let state = loadState(); state.currentTunnel = cfg.name; saveState(state);

    // Đợi 2s cho tunnel + DNS + route settle
    await new Promise(r => setTimeout(r, 2000));
    const newIp = await fetchIP();
    log('New IP: ' + newIp);
    return { ok: true, server: cfg.name, oldIp, newIp };
}

async function actionStatus() {
    const wgExe = findWgExe();
    const active = listActiveTunnels();
    const ip = await fetchIP();
    return {
        ok: true,
        wireguardInstalled: !!wgExe,
        wireguardPath: wgExe,
        connected: active.length > 0,
        currentTunnel: active[0] || null,
        activeTunnels: active,
        ip,
        configDir: CONFIG_DIR,
        availableConfigs: listConfigs().map(c => c.name)
    };
}

async function actionStop() {
    const wgExe = findWgExe();
    if (!wgExe) return { ok: false, error: 'wireguard_exe_not_found' };
    const downCount = bringDownAll(wgExe);
    let state = loadState(); state.currentTunnel = null; saveState(state);
    return { ok: true, broughtDown: downCount };
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

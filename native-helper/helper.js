#!/usr/bin/env node
// === Fotor VPN Helper (Native Messaging Host) ===
// Chạy as root trên Ubuntu VPS. Nhận lệnh từ Chrome Extension qua stdio Native Messaging.
// Action ROTATE: kill openvpn cũ -> random pick .ovpn (không lặp đến khi cạn) -> spawn mới
//                -> đợi tunnel up -> verify IP -> reply { ok, server, newIp }
// Action STATUS: trả về { connected, currentServer, ip }
// Action STOP:   kill openvpn, trả ok
//
// Chrome Native Messaging protocol: 4-byte little-endian length + UTF-8 JSON.

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const https = require('https');

// === CẤU HÌNH ===
const CONFIG_DIR     = '/opt/surfshark/configs';
const AUTH_FILE      = '/opt/surfshark/auth.txt';
const STATE_FILE     = '/var/lib/fotor-vpn/state.json';   // lưu danh sách server đã dùng
const LOG_DIR        = '/var/log/fotor-vpn';
const LOG_FILE       = path.join(LOG_DIR, 'helper.log');
const LOG_MAX_BYTES  = 5 * 1024 * 1024; // 5MB
const LOG_KEEP       = 3;
const CONNECT_TIMEOUT_MS = 25000;
const IP_CHECK_TIMEOUT   = 5000;

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
// Frame: [4 bytes LE length][UTF-8 JSON]
function readNativeMessage() {
    return new Promise((resolve, reject) => {
        let header = Buffer.alloc(0);
        let body = Buffer.alloc(0);
        let need = 4;
        let phase = 'header';
        let bodyLen = 0;

        const onData = (chunk) => {
            if (phase === 'header') {
                header = Buffer.concat([header, chunk]);
                if (header.length >= 4) {
                    bodyLen = header.readUInt32LE(0);
                    const rest = header.slice(4);
                    body = Buffer.concat([body, rest]);
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
            try {
                const json = JSON.parse(body.slice(0, bodyLen).toString('utf8'));
                resolve(json);
            } catch (e) { reject(e); }
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

// === STATE (server đã dùng - không lặp đến khi cạn) ===
function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch (_) { return { used: [] }; }
}
function saveState(s) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { log('saveState err: ' + e.message); }
}

function listConfigs() {
    try {
        return fs.readdirSync(CONFIG_DIR)
            .filter(f => f.endsWith('.ovpn'))
            .map(f => path.join(CONFIG_DIR, f));
    } catch (e) { log('listConfigs err: ' + e.message); return []; }
}

function pickConfig() {
    const all = listConfigs();
    if (all.length === 0) return null;
    let state = loadState();
    let pool = all.filter(c => !state.used.includes(c));
    if (pool.length === 0) {
        log('Đã quay hết ' + all.length + ' server -> reset cycle, bắt đầu lại.');
        state = { used: [] };
        pool = all.slice();
    }
    const picked = pool[Math.floor(Math.random() * pool.length)];
    state.used.push(picked);
    saveState(state);
    return picked;
}

// === OPENVPN CONTROL ===
function killOpenVPN() {
    try { execSync('pkill -TERM openvpn 2>/dev/null', { stdio: 'ignore' }); } catch (_) {}
    // Đợi process exit hẳn
    return new Promise(r => setTimeout(r, 1500));
}

function spawnOpenVPN(configPath) {
    return new Promise((resolve, reject) => {
        const args = [
            '--config', configPath,
            '--auth-user-pass', AUTH_FILE,
            '--script-security', '2',
            '--verb', '3',
            '--connect-retry-max', '2'
        ];
        log('Spawning: openvpn ' + args.join(' '));
        const child = spawn('openvpn', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

        let resolved = false;
        const timeout = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            log('OpenVPN timeout sau ' + CONNECT_TIMEOUT_MS + 'ms');
            try { child.kill('SIGTERM'); } catch (_) {}
            reject(new Error('connect_timeout'));
        }, CONNECT_TIMEOUT_MS);

        const onLine = (data) => {
            const s = data.toString();
            if (s.includes('Initialization Sequence Completed')) {
                if (resolved) return;
                resolved = true;
                clearTimeout(timeout);
                log('OpenVPN tunnel UP');
                child.unref(); // detach để parent có thể exit không kill child
                resolve(child);
            } else if (/AUTH_FAILED|auth-failure|Cannot resolve/i.test(s)) {
                if (resolved) return;
                resolved = true;
                clearTimeout(timeout);
                log('OpenVPN auth/dns failed: ' + s.trim().slice(0, 200));
                try { child.kill('SIGTERM'); } catch (_) {}
                reject(new Error('auth_failed'));
            }
        };
        child.stdout.on('data', onLine);
        child.stderr.on('data', onLine);
        child.on('error', (e) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timeout);
            reject(e);
        });
    });
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
    await killOpenVPN();
    const cfg = pickConfig();
    if (!cfg) return { ok: false, error: 'no_configs_found', dir: CONFIG_DIR };
    const server = path.basename(cfg, '.ovpn');
    log('Picked server: ' + server);
    try {
        await spawnOpenVPN(cfg);
    } catch (e) {
        log('spawnOpenVPN failed: ' + e.message);
        // Thử lại với config khác
        const cfg2 = pickConfig();
        if (cfg2 && cfg2 !== cfg) {
            try {
                await spawnOpenVPN(cfg2);
                const newIp2 = await fetchIP();
                return { ok: true, server: path.basename(cfg2, '.ovpn'), oldIp, newIp: newIp2, retried: true };
            } catch (e2) {
                return { ok: false, error: 'connect_failed', detail: e2.message };
            }
        }
        return { ok: false, error: 'connect_failed', detail: e.message };
    }
    // Đợi 2s cho route table settle rồi mới check IP
    await new Promise(r => setTimeout(r, 2000));
    const newIp = await fetchIP();
    log('New IP: ' + newIp);
    return { ok: true, server, oldIp, newIp };
}

async function actionStatus() {
    let connected = false;
    try {
        const out = execSync('pgrep -a openvpn 2>/dev/null', { encoding: 'utf8' });
        connected = out.trim().length > 0;
    } catch (_) {}
    const ip = await fetchIP();
    return { ok: true, connected, ip };
}

async function actionStop() {
    await killOpenVPN();
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
        // Cho stdout flush rồi exit
        setTimeout(() => process.exit(0), 100);
    } catch (e) {
        log('FATAL: ' + (e && e.stack || e));
        try { writeNativeMessage({ ok: false, error: 'helper_crash', detail: String(e && e.message || e) }); } catch (_) {}
        process.exit(1);
    }
})();

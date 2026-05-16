#!/usr/bin/env node
// === Fotor Credit Monitor — STATELESS (VPS Linux) ===
// Headless Chromium, KHÔNG tự giữ session — extension gửi cookies theo mỗi request.
// Lý do: acc chủ xoay vòng theo queue ref-link, không thể login cố định 1 acc.
//
// Endpoints:
//   POST /credit/check        body: { cookies:[...], reload?:bool }
//                             → đặt cookies vào page, (optionally) reload /rewards,
//                               scrape "Credits: N" → trả về { credit, ts, email?, error }
//   GET  /health              → service alive check

const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.FOTOR_PORT || '8765', 10);
const REWARDS_URL = 'https://www.fotor.com/rewards/';
const LOG_FILE = process.env.FOTOR_LOG || '/var/log/fotor-credit/monitor.log';
const SCRAPE_TIMEOUT_MS = 15000;

function ensureDir(p) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) {} }
ensureDir(LOG_FILE);
function log(...args) {
    const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
    try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
    console.log(line.trim());
}

let browser = null;
let page = null;
let busy = false;

async function initBrowser() {
    log('[init] Launching headless Chromium...');
    browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
        ],
    });
    page = await browser.newPage();
    await page.setUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });
    // Block ảnh + font để load nhanh
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const t = req.resourceType();
        if (t === 'image' || t === 'font' || t === 'media') req.abort();
        else req.continue();
    });
    log('[init] Browser ready');
}

function normalizeCookies(input) {
    // Hỗ trợ EditThisCookie / chrome.cookies API / Puppeteer raw
    return input.map(c => {
        const out = {
            name: c.name,
            value: c.value,
            domain: c.domain || '.fotor.com',
            path: c.path || '/',
            secure: c.secure !== false,
            httpOnly: c.httpOnly || false,
        };
        // sameSite normalize
        const ss = String(c.sameSite || '').toLowerCase();
        if (ss === 'lax' || ss === 'no_restriction' || ss === 'unspecified') out.sameSite = 'Lax';
        else if (ss === 'strict') out.sameSite = 'Strict';
        else out.sameSite = 'None';
        // expiry
        if (c.expirationDate && c.expirationDate > 0) {
            out.expires = Math.floor(c.expirationDate);
        }
        return out;
    });
}

async function checkCredit({ cookies, reload = true, email = null }) {
    if (busy) {
        return { credit: null, error: 'busy_try_later', email };
    }
    busy = true;
    try {
        // Clear cookies cũ
        const oldCookies = await page.cookies();
        if (oldCookies.length > 0) {
            await page.deleteCookie(...oldCookies);
        }
        // Set cookies mới
        const normalized = normalizeCookies(cookies || []);
        if (normalized.length > 0) {
            await page.setCookie(...normalized);
            log(`[check] Set ${normalized.length} cookies for email=${email || '?'}`);
        }
        // Reload or just navigate
        if (reload || page.url() !== REWARDS_URL) {
            await page.goto(REWARDS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        }
        // Đợi DOM credit render
        try {
            await page.waitForFunction(
                () => /Credits[:\s]+\d+/i.test(document.body.innerText),
                { timeout: SCRAPE_TIMEOUT_MS }
            );
        } catch (_) { /* fallthrough — vẫn scrape */ }

        const text = await page.evaluate(() => document.body.innerText);
        const m = text.match(/Credits[:\s]+(\d+)/i);
        if (m) {
            const result = {
                credit: parseInt(m[1], 10),
                ts: new Date().toISOString(),
                email,
                error: null,
            };
            log(`[check] credit=${result.credit} email=${email || '?'}`);
            return result;
        }
        const isAnon = /sign\s*up\s*free|get\s*started/i.test(text.slice(0, 3000));
        const err = isAnon ? 'cookies_invalid_or_expired' : 'credit_pattern_not_found';
        log(`[check] ERR email=${email || '?'}: ${err}`);
        try { fs.writeFileSync('/tmp/fotor-credit-debug.html', await page.content()); } catch (_) {}
        return { credit: null, error: err, ts: new Date().toISOString(), email };
    } catch (e) {
        log(`[check] FATAL: ${e.message}`);
        return { credit: null, error: 'goto_failed:' + e.message, ts: new Date().toISOString(), email };
    } finally {
        busy = false;
    }
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}

function startServer() {
    const server = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');

        if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

        const url = new URL(req.url, `http://localhost:${PORT}`);

        if (req.method === 'GET' && url.pathname === '/health') {
            return res.end(JSON.stringify({
                ok: !!page,
                busy,
                uptimeSec: Math.floor(process.uptime()),
            }));
        }

        if (req.method === 'POST' && url.pathname === '/credit/check') {
            try {
                const body = await readBody(req);
                const result = await checkCredit({
                    cookies: body.cookies || [],
                    reload: body.reload !== false,
                    email: body.email || null,
                });
                return res.end(JSON.stringify(result));
            } catch (e) {
                res.statusCode = 400;
                return res.end(JSON.stringify({ error: 'bad_request', detail: e.message }));
            }
        }

        res.statusCode = 404;
        res.end(JSON.stringify({
            error: 'not_found',
            endpoints: ['GET /health', 'POST /credit/check {cookies, reload?, email?}'],
        }));
    });

    server.listen(PORT, '127.0.0.1', () => {
        log(`[http] Listening on 127.0.0.1:${PORT}`);
    });
}

async function shutdown(signal) {
    log(`[shutdown] ${signal} -> closing browser`);
    try { if (browser) await browser.close(); } catch (_) {}
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

initBrowser()
    .then(() => startServer())
    .catch(e => {
        log('[init] FATAL:', e.stack || e.message);
        process.exit(1);
    });

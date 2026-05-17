#!/usr/bin/env node
// === Fotor Credit Monitor - STATELESS (Docker, VPS) ===
// Headless Chromium, KHONG tu giu session - extension gui cookies theo moi request.
// Phien ban Docker dung puppeteer-core + Chromium system installed (apt).
//
// Endpoints:
//   POST /credit/check        body: { cookies:[...], reload?:bool, email?:string }
//                             -> dat cookies vao page, (optionally) reload /rewards,
//                                scrape "Credits: N" -> tra ve { credit, ts, email?, error }
//   GET  /health              -> service alive check

const puppeteer = require('puppeteer-core');
const http = require('http');

const PORT = parseInt(process.env.FOTOR_PORT || '8765', 10);
const REWARDS_URL = 'https://www.fotor.com/rewards/';
const SCRAPE_TIMEOUT_MS = 15000;
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

function log(...args) {
    const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
    console.log(line);
}

let browser = null;
let page = null;
let busy = false;

async function initBrowser() {
    log('[init] Launching Chromium at', CHROMIUM_PATH);
    browser = await puppeteer.launch({
        executablePath: CHROMIUM_PATH,
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
    // Block anh + font de load nhanh
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const t = req.resourceType();
        if (t === 'image' || t === 'font' || t === 'media') req.abort();
        else req.continue();
    });
    log('[init] Browser ready');
}

function normalizeCookies(input) {
    return (input || []).map(c => {
        const out = {
            name: c.name,
            value: c.value,
            domain: c.domain || '.fotor.com',
            path: c.path || '/',
            secure: c.secure !== false,
            httpOnly: c.httpOnly || false,
        };
        const ss = String(c.sameSite || '').toLowerCase();
        if (ss === 'lax' || ss === 'no_restriction' || ss === 'unspecified') out.sameSite = 'Lax';
        else if (ss === 'strict') out.sameSite = 'Strict';
        else out.sameSite = 'None';
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
        const oldCookies = await page.cookies();
        if (oldCookies.length > 0) await page.deleteCookie(...oldCookies);
        const normalized = normalizeCookies(cookies);
        if (normalized.length > 0) {
            await page.setCookie(...normalized);
            log(`[check] set ${normalized.length} cookies email=${email || '?'}`);
        }
        if (reload || page.url() !== REWARDS_URL) {
            await page.goto(REWARDS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        }
        try {
            await page.waitForFunction(
                () => /Credits[:\s]+\d+/i.test(document.body.innerText),
                { timeout: SCRAPE_TIMEOUT_MS }
            );
        } catch (_) {}

        const text = await page.evaluate(() => document.body.innerText);
        const m = text.match(/Credits[:\s]+(\d+)/i);
        if (m) {
            const credit = parseInt(m[1], 10);
            log(`[check] credit=${credit} email=${email || '?'}`);
            return { credit, ts: new Date().toISOString(), email, error: null };
        }
        const isAnon = /sign\s*up\s*free|get\s*started/i.test(text.slice(0, 3000));
        const err = isAnon ? 'cookies_invalid_or_expired' : 'credit_pattern_not_found';
        log(`[check] ERR email=${email || '?'}: ${err}`);
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
            return res.end(JSON.stringify({ ok: !!page, busy, uptimeSec: Math.floor(process.uptime()) }));
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

    server.listen(PORT, '0.0.0.0', () => {
        log(`[http] listening on 0.0.0.0:${PORT}`);
    });
}

(async () => {
    try {
        await initBrowser();
        startServer();
    } catch (e) {
        log('[fatal] startup err:', e.message);
        process.exit(1);
    }
})();

process.on('SIGINT', async () => { try { if (browser) await browser.close(); } catch (_) {}; process.exit(0); });
process.on('SIGTERM', async () => { try { if (browser) await browser.close(); } catch (_) {}; process.exit(0); });

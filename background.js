// === OPENVPN AUTO-ROTATE (qua Native Messaging) ===
// Trên VPS Ubuntu, có 1 Node.js helper chạy as root tại /opt/fotor-vpn-helper/helper.js
// nhận lệnh ROTATE qua stdio Native Messaging, kill openvpn cũ và spawn .ovpn mới.
// Helper trả về { ok: true, server, newIp } khi tunnel up thành công.
// Nếu helper không có (chưa cài) hoặc lỗi -> trả false -> fallback PAUSE manual.
const NATIVE_HOST_NAME = 'com.fotor.vpn';
const ROTATE_TIMEOUT_MS = 35000; // Helper thường mất 8-15s, để 35s buffer

// === Fotor referral policy (cập nhật 5/2026) ===
// Fotor đổi thưởng từ 10pt/ref lên 20pt/ref → chỉ cần 10 ref/link là đủ 200pt full credit.
// Trước đó (2024-04/2026) là 20 ref/link. Sau này nếu Fotor đổi nữa, chỉ sửa 2 constant này.
const REF_LIMIT = 10;   // số ref đủ cho 1 link → coi link đó xong, chuyển link kế tiếp
const BATCH_SIZE = 10;  // pool đủ N acc "đã đủ ref" → snapshot gửi 1 file Telegram
const EXPECTED_DELTA = 20;       // mỗi ref hợp lệ → acc chủ +20 credit
const ZERO_DELTA_ALERT_N = 3;    // N lần liên tiếp delta=0 → Telegram alert (IP nghi trùng)
const CREDIT_HISTORY_CAP = 200;

// === Credit Monitor (stateless Puppeteer service local trên VPS) ===
// Setup: native-helper/credit-monitor/ + sudo systemctl enable --now fotor-credit
const CREDIT_MONITOR_URL = 'http://127.0.0.1:8765/credit/check';
const CREDIT_FETCH_TIMEOUT_MS = 30000;

async function callCreditMonitor(cookies, email) {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), CREDIT_FETCH_TIMEOUT_MS);
        const res = await fetch(CREDIT_MONITOR_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookies, reload: true, email }),
            signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!res.ok) return { credit: null, error: 'http_' + res.status };
        return await res.json();
    } catch (e) {
        return { credit: null, error: 'monitor_unreachable:' + (e.message || e) };
    }
}

async function harvestFotorCookies() {
    try {
        const cookies = await chrome.cookies.getAll({ domain: 'fotor.com' });
        // chrome.cookies API trả format đã chuẩn cho Puppeteer-like, chỉ cần map thêm sameSite
        return cookies.map(c => ({
            name: c.name, value: c.value, domain: c.domain, path: c.path,
            secure: c.secure, httpOnly: c.httpOnly,
            sameSite: c.sameSite || 'no_restriction',
            expirationDate: c.expirationDate || null,
        }));
    } catch (e) {
        console.warn('[CreditTracker] harvest cookies err:', e);
        return [];
    }
}

async function rotateOpenVPN() {
    return new Promise((resolve) => {
        let port;
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            try { if (port) port.disconnect(); } catch (_) {}
            resolve(result);
        };
        try {
            port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
        } catch (e) {
            console.log('[OpenVPN] Không kết nối được native host:', e.message);
            return resolve({ ok: false, error: 'native_host_missing' });
        }

        const timeoutId = setTimeout(() => {
            console.log('[OpenVPN] Helper timeout sau', ROTATE_TIMEOUT_MS, 'ms');
            finish({ ok: false, error: 'timeout' });
        }, ROTATE_TIMEOUT_MS);

        port.onMessage.addListener((msg) => {
            console.log('[OpenVPN] Helper reply:', msg);
            clearTimeout(timeoutId);
            finish(msg || { ok: false, error: 'empty_reply' });
        });

        port.onDisconnect.addListener(() => {
            const err = chrome.runtime.lastError;
            console.log('[OpenVPN] Native port disconnected:',
                err && err.message ? err.message : '(no error)');
            clearTimeout(timeoutId);
            finish({ ok: false, error: (err && err.message) || 'disconnected' });
        });

        setBadge('VPN', '#9b59b6');
        port.postMessage({ action: 'ROTATE' });
    });
}

// Manual rotate trigger (gọi từ popup button "Đổi IP ngay")
async function manualRotateOpenVPN() {
    setBadge('VPN', '#9b59b6');
    const result = await rotateOpenVPN();
    if (result.ok) {
        const db = await chrome.storage.local.get(['currentCount']);
        setBadge(String(db.currentCount || 0), '#27ae60');
        sendTelegram(
            `🔄 <b>Manual rotate IP</b>\n⏰ ${nowVN()}\n✅ Server: ${result.server || '?'}\n📡 IP mới: ${result.newIp || '?'}`,
            { silent: true }
        );
    } else {
        setBadge('!VPN', '#e74c3c');
    }
    return result;
}

// === TELEGRAM BOT (Alert + Storage) ===
// Người dùng cấu hình bot token + chat id qua popup. Lưu vào chrome.storage.local
// dưới key 'telegramConfig' = { botToken, chatId, enabled }.
async function getTelegramConfig() {
    const db = await chrome.storage.local.get(['telegramConfig']);
    return db.telegramConfig || { botToken: '', chatId: '', enabled: false };
}

// Định dạng datetime VN: 2024-04-27 02:15:33
function nowVN() {
    const d = new Date();
    // toLocaleString với Asia/Ho_Chi_Minh timezone
    const vn = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
    const pad = (n) => String(n).padStart(2, '0');
    return `${vn.getFullYear()}-${pad(vn.getMonth()+1)}-${pad(vn.getDate())} ${pad(vn.getHours())}:${pad(vn.getMinutes())}:${pad(vn.getSeconds())}`;
}

// Gửi 1 FILE txt qua Telegram Bot API (sendDocument).
// Dùng cho batch BATCH_SIZE acc / batch 50 acc -> gọn 1 file thay vì spam tin nhắn.
async function sendTelegramDocument(filename, content, caption = '', opts = {}) {
    const cfg = await getTelegramConfig();
    if (!cfg.enabled || !cfg.botToken || !cfg.chatId) {
        console.log('[Telegram] Chưa cấu hình bot, bỏ qua gửi file.');
        return false;
    }
    try {
        const form = new FormData();
        form.append('chat_id', cfg.chatId);
        form.append('document', new Blob([content], { type: 'text/plain;charset=utf-8' }), filename);
        if (caption) form.append('caption', caption);
        form.append('parse_mode', 'HTML');
        form.append('disable_notification', String(opts.silent === true));

        const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendDocument`, {
            method: 'POST',
            body: form
        });
        const json = await res.json();
        if (!json.ok) {
            console.log('[Telegram] sendDocument error:', json);
            return false;
        }
        return true;
    } catch (e) {
        console.log('[Telegram] sendDocument fetch error:', e);
        return false;
    }
}

// opts.silent = true -> message không kêu chuông/rung điện thoại (mute)
// Theo yêu cầu user: chỉ Captcha mới báo (loud), tin nhắn acc/milestone đều silent.
async function sendTelegram(text, opts = {}) {
    const cfg = await getTelegramConfig();
    if (!cfg.enabled || !cfg.botToken || !cfg.chatId) {
        console.log('[Telegram] Chưa cấu hình bot, bỏ qua gửi.');
        return false;
    }
    try {
        const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: cfg.chatId,
                text: text,
                parse_mode: opts.parseMode || 'HTML',
                disable_web_page_preview: true,
                disable_notification: opts.silent === true
            })
        });
        const json = await res.json();
        if (!json.ok) {
            console.log('[Telegram] API error:', json);
            return false;
        }
        return true;
    } catch (e) {
        console.log('[Telegram] fetch error:', e);
        return false;
    }
}

// === DESKTOP NOTIFICATION (cảnh báo trực tiếp khi đang ngồi máy) ===
function notifyDesktop(title, message) {
    try {
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiBmaWxsPSIjZTc0YzNjIi8+PHRleHQgeD0iMzIiIHk9IjQyIiBmb250LXNpemU9IjMwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSJ3aGl0ZSI+ITwvdGV4dD48L3N2Zz4=',
            title: title || 'Fotor Auto Register',
            message: message || '',
            priority: 2,
            requireInteraction: true
        });
    } catch (e) { console.log('[Notify] error:', e); }
}

function generatePassword(length = 12) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
  let pass = "";
  for (let i = 0; i < length; i++) {
    pass += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  pass += "A1a!"; 
  return pass;
}

// === GLOBAL WATCHDOG (dùng chrome.alarms để bền với MV3 SW restart) ===
// setTimeout sẽ MẤT khi service worker ngủ (MV3 SW chỉ sống ~30s khi không có event).
// chrome.alarms persist qua SW lifecycle -> tab kẹt sẽ được skip đúng giờ.
const WATCHDOG_ALARM = 'globalWatchdog';
const GLOBAL_TIMEOUT_MIN = 2; // 2 phút

function resetWatchdog() {
    chrome.alarms.create(WATCHDOG_ALARM, { delayInMinutes: GLOBAL_TIMEOUT_MIN });
}

function stopWatchdog() {
    chrome.alarms.clear(WATCHDOG_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === WATCHDOG_ALARM) {
        console.log('[WATCHDOG] Quá 2 phút chưa xong! Tự động Skip lượt này...');
        skipIteration();
    }
});

// === BADGE STATUS ===
function setBadge(text, color) {
  chrome.action.setBadgeText({ text: String(text || '') });
  chrome.action.setBadgeBackgroundColor({ color: color || '#e67e22' });
}

// Bơm mã đè đè qua MAIN world để lách CSP của Fotor
chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0 && details.url.includes('fotor.com')) {
        chrome.scripting.executeScript({
            target: {tabId: details.tabId},
            files: ['hook.js'],
            world: 'MAIN',
            injectImmediately: true
        }).catch(err => console.log('CSP Bypass Inject Error:', err));
    }
}, {url: [{hostContains: 'fotor.com'}]});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startProcess') {
    startNextIteration();
  } else if (message.action === 'emailFetched') {
    handleEmailFetched(message.email, sender.tab.id);
  } else if (message.action === 'fotorFormSubmitted') {
    handleFotorFormSubmitted(sender.tab.id);
  } else if (message.action === 'codeFetched') {
    handleCodeFetched(message.code);
  } else if (message.action === 'registrationDone') {
    handleRegistrationDone(sender.tab.id, message.refLink);
  } else if (message.action === 'navToRewards') {
    chrome.storage.local.set({ flowState: 'GET_REWARDS_LINK' }, () => {
      chrome.tabs.update(sender.tab.id, { url: 'https://www.fotor.com/rewards/' });
    });
  } else if (message.action === 'skipCurrent') {
    console.log('[Skip] Nhận lệnh skip từ content script...');
    skipIteration();
  } else if (message.action === 'CAPTCHA_DETECTED') {
    handleCaptchaDetected(sender && sender.tab && sender.tab.id, message.reason || 'Captcha');
  } else if (message.action === 'resumeAfterCaptcha') {
    handleResumeAfterCaptcha();
  } else if (message.action === 'manualRotateVPN') {
    manualRotateOpenVPN().then(r => sendResponse(r));
    return true; // giữ message channel open cho async sendResponse
  }
});

// Khi gặp Captcha/IP block:
// - Thử rotateOpenVPN qua native helper trên VPS → auto đổi IP → skip lượt → tiếp tục
// - Nếu helper không có / lỗi → PAUSE + Telegram alert LOUD → user remote vào xử thủ công
async function handleCaptchaDetected(fotorTabId, reason) {
    stopWatchdog();
    const db = await chrome.storage.local.get(['isRunning', 'currentCount', 'targetCount', 'tempEmail']);
    if (!db.isRunning) return;

    const time = nowVN();
    const progress = `${db.currentCount || 0}/${db.targetCount || '?'}`;

    // Thử auto-rotate qua OpenVPN native helper
    const vpnResult = await rotateOpenVPN();

    if (vpnResult && vpnResult.ok) {
        console.log('[Captcha+OpenVPN] IP đã đổi:', vpnResult.newIp, 'server:', vpnResult.server);
        setBadge(String(db.currentCount || 0), '#e67e22');
        sendTelegram(
            `🔄 <b>Captcha → Auto xoay IP (OpenVPN)</b>\n` +
            `⏰ ${time}\n` +
            `📍 Lý do: ${reason}\n` +
            `📊 ${progress}\n` +
            `🌍 Server: <code>${vpnResult.server || '?'}</code>\n` +
            `📡 IP mới: <code>${vpnResult.newIp || '?'}</code>\n` +
            `✅ Tiếp tục tự động.`,
            { silent: true }
        );
        skipIteration();
        return;
    }

    // Surfshark không có → PAUSE + alert LOUD để user xử thủ công
    await chrome.storage.local.set({
        isRunning: false,
        pauseReason: 'captcha',
        flowState: 'PAUSED_CAPTCHA'
    });
    setBadge('!CAP', '#e74c3c');

    const text = `🛑 <b>CAPTCHA - Cần đổi IP thủ công</b>\n` +
                 `⏰ ${time}\n` +
                 `📍 Lý do: ${reason}\n` +
                 `📊 Tiến độ: ${progress}\n` +
                 `📧 Email: <code>${db.tempEmail || '(chưa có)'}</code>\n\n` +
                 `👉 Remote vào đổi IP Surfshark, rồi bấm <b>"Tiếp tục"</b> trong popup.`;
    sendTelegram(text); // LOUD - không truyền silent
    notifyDesktop('🛑 Fotor Auto - Gặp Captcha!', `Cần remote vào đổi IP. ${progress} | ${time}`);
    console.log('[Captcha] Surfshark không có. PAUSED. Đợi user resume.');
}

async function handleResumeAfterCaptcha() {
    const db = await chrome.storage.local.get(['pauseReason']);
    if (db.pauseReason !== 'captcha') {
        console.log('[Resume] Không có pause vì captcha, bỏ qua.');
        return;
    }
    await chrome.storage.local.set({
        isRunning: true,
        pauseReason: null,
        flowState: 'START_IMAIL'
    });
    setBadge('GO', '#27ae60');
    sendTelegram(`▶️ <b>Đã tiếp tục</b> sau Captcha\n⏰ ${nowVN()}`, { silent: true });
    console.log('[Resume] Tiếp tục chu trình.');
    skipIteration(); // đóng tab cũ + mở lượt mới
}

async function startNextIteration() {
  const db = await chrome.storage.local.get(['isRunning', 'currentCount', 'targetCount', 'emailProvider']);
  if (!db.isRunning) return;

  if (db.currentCount >= db.targetCount) {
    chrome.storage.local.set({ isRunning: false, flowState: 'FINISHED' });
    setBadge('DONE', '#27ae60');
    return;
  }

  setBadge(`${db.currentCount||0}`, '#e67e22');
  const provider = db.emailProvider || 'imail';
  const emailUrl = provider === 'tempmailo' ? 'https://temp-mailo.org/' : 'https://imail.edu.vn/';

  resetWatchdog(); // Bắt đầu tính giờ cho lượt mới

  chrome.browsingData.remove(
    { origins: ['https://www.fotor.com', 'https://temp-mailo.org'] },
    { "cookies": true, "localStorage": true },
    async () => {
      await chrome.storage.local.set({ flowState: 'START_IMAIL', tempEmail: '', randomPass: '', imailTabId: null, fotorTabId: null, fotorCode: null });
      chrome.tabs.create({ url: emailUrl, active: true }, (tab) => {
        chrome.storage.local.set({ imailTabId: tab.id });
      });
    }
  );
}

async function skipIteration() {
  const db = await chrome.storage.local.get(['imailTabId', 'fotorTabId']);
  if (db.imailTabId) chrome.tabs.remove(db.imailTabId).catch(()=>{});
  if (db.fotorTabId) chrome.tabs.remove(db.fotorTabId).catch(()=>{});
  
  setTimeout(startNextIteration, 500);
}

// Bắt lệnh Blacklist Domain
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'blacklistDomainAndSkip') {
    if (message.domain) {
        chrome.storage.local.get({ blacklistedDomains: [] }, (db) => {
           let list = db.blacklistedDomains;
           if (!list.includes(message.domain)) list.push(message.domain);
           chrome.storage.local.set({ blacklistedDomains: list }, () => {
                skipIteration();
           });
        });
    } else {
        skipIteration();
    }
  }
});

async function handleEmailFetched(email, tabId) {
  const db = await chrome.storage.local.get(['flowState', 'isRunning', 'targetUrl']);
  if (db.flowState !== 'START_IMAIL' && db.flowState !== 'WAIT_EMAIL') return;

  const password = generatePassword();
  
  await chrome.storage.local.set({
    flowState: 'GO_FOTOR',
    tempEmail: email,
    randomPass: password
  });

  const url = db.targetUrl || 'https://www.fotor.com/';

  // Mở Fotor ở link được setup
  chrome.tabs.create({ url: url, active: true }, (tab) => {
    chrome.storage.local.set({ fotorTabId: tab.id });
  });
}

async function handleFotorFormSubmitted(fotorTabId) {
  await chrome.storage.local.set({ flowState: 'WAIT_IMAIL_CODE' });
  const db = await chrome.storage.local.get(['imailTabId']);
  if (db.imailTabId) {
    chrome.tabs.sendMessage(db.imailTabId, { action: 'startPollCode' }).catch(()=> {});
    chrome.tabs.update(db.imailTabId, { active: true });
  }
}

async function handleCodeFetched(code) {
  await chrome.storage.local.set({ flowState: 'WAIT_FOTOR_CODE', fotorCode: code });
  const db = await chrome.storage.local.get(['fotorTabId']);
  if (db.fotorTabId) {
    chrome.tabs.sendMessage(db.fotorTabId, { action: 'fillCode', code: code }).catch(()=> {});
    chrome.tabs.update(db.fotorTabId, { active: true });
  }
}

async function handleRegistrationDone(tabId, refLink = 'Không rõ') {
  stopWatchdog(); // Hoàn thành -> Dừng tính giờ
  const db = await chrome.storage.local.get([
      'successList', 'currentCount', 'tempEmail', 'randomPass',
      'imailTabId', 'fotorTabId', 'targetUrl', 'referralUsage',
      'refLinkQueue', 'targetCount', 'completedRefAccs'
  ]);

  const createdAt = nowVN();
  // Format mỗi dòng: createdAt | email | pass | refLink-của-acc-này
  // (acc Fotor chỉ valid 7 ngày nên cần datetime để tracking bán/dùng)
  const accLine = `${createdAt} | ${db.tempEmail} | ${db.randomPass} | ${refLink}`;
  const newList = db.successList || [];
  newList.push(accLine);

  let queue = db.refLinkQueue || [];
  if (refLink && refLink.includes('fotor.com/referrer') && !queue.includes(refLink)) {
      queue.push(refLink);
  }

  let usage = db.referralUsage || 0;
  usage++;

  let tUrl = db.targetUrl;
  let usedRefLinks = db.usedRefLinks || [];

  // Pool "đã đủ ref": các acc của ta mà ref-link của chúng đã được dùng đủ REF_LIMIT lần.
  // Mỗi acc trong pool = 1 acc đã ăn full credit (cao giá trị, có thể bán/dùng).
  let completedRefAccs = db.completedRefAccs || [];
  let batchToSend = null; // khi pool đủ BATCH_SIZE -> snapshot ra đây để gửi file

  if (usage >= REF_LIMIT && queue.length > 0) {
      // Link tUrl vừa đạt REF_LIMIT ref -> CHỦ của link tUrl = acc "đã đủ ref".
      usedRefLinks.push({ link: tUrl, usedAt: new Date().toISOString() });

      // Tìm acc trong successList có refLink == tUrl (acc đó là chủ link).
      // Nếu tUrl là seed-link của user (không phải acc của ta tạo) -> không có trong list, skip.
      const ownerLine = newList.find(line => line.endsWith(' | ' + tUrl));
      if (ownerLine) {
          completedRefAccs.push(ownerLine);
          console.log(`[ĐủRef] Acc "đã đủ ref" mới: ${ownerLine}. Pool: ${completedRefAccs.length}/${BATCH_SIZE}`);
      } else {
          console.log(`[ĐủRef] Link gốc của user vừa đủ ${REF_LIMIT}, không phải acc của ta. Skip pool.`);
      }

      // Pool đủ BATCH_SIZE -> snapshot BATCH_SIZE đầu, giữ phần dư
      if (completedRefAccs.length >= BATCH_SIZE) {
          batchToSend = completedRefAccs.slice(0, BATCH_SIZE);
          completedRefAccs = completedRefAccs.slice(BATCH_SIZE);
      }

      tUrl = queue.shift();
      usage = 0;
  }

  const newCount = (db.currentCount || 0) + 1;

  // === CREDIT TRACKING ===
  // 1. Lưu cookies + email vừa reg vào storage (acc này có thể thành chủ link sau)
  // 2. Tìm chủ của targetUrl hiện tại (acc chủ thật) trong successList → lookup cookies
  // 3. POST credit-monitor với cookies acc chủ → so delta vs lần trước
  let creditDb = await chrome.storage.local.get([
      'accCookies', 'linkToEmail', 'lastOwnerCredit', 'creditHistory'
  ]);
  let accCookies = creditDb.accCookies || {};
  let linkToEmail = creditDb.linkToEmail || {};
  let lastOwnerCredit = creditDb.lastOwnerCredit || {};
  let creditHistory = creditDb.creditHistory || [];

  // Harvest cookies của acc CON vừa reg (đang login tab Fotor)
  const accConEmail = db.tempEmail;
  if (accConEmail) {
      const cookies = await harvestFotorCookies();
      if (cookies.length > 0) {
          accCookies[accConEmail] = cookies;
          console.log(`[CreditTracker] Harvested ${cookies.length} cookies for ${accConEmail}`);
      }
      // Map refLink của acc CON (link mà acc CON SỞ HỮU, để batch sau đến lượt)
      if (refLink && refLink.includes('fotor.com/referrer')) {
          linkToEmail[refLink] = accConEmail;
      }
  }

  // Xác định acc chủ HIỆN TẠI: chủ của db.targetUrl (link đang dùng để reg ref)
  // db.targetUrl ở đây là tUrl TRƯỚC KHI shift (nếu vừa đủ REF_LIMIT mới shift)
  // → owner của link cũ vừa nhận +20, không phải link mới shift sang
  const currentOwnerLink = db.targetUrl;
  const currentOwnerEmail = linkToEmail[currentOwnerLink] || null;
  let creditEvent = null;

  if (currentOwnerEmail && accCookies[currentOwnerEmail]) {
      const result = await callCreditMonitor(accCookies[currentOwnerEmail], currentOwnerEmail);
      const newCredit = result.credit;
      const prevCredit = lastOwnerCredit[currentOwnerEmail] ?? null;
      const delta = (newCredit != null && prevCredit != null) ? (newCredit - prevCredit) : null;

      creditEvent = {
          ts: createdAt,
          ownerEmail: currentOwnerEmail,
          ownerLink: currentOwnerLink,
          accConEmail,
          prevCredit, newCredit, delta,
          error: result.error || null,
      };
      creditHistory.push(creditEvent);
      if (creditHistory.length > CREDIT_HISTORY_CAP) {
          creditHistory.splice(0, creditHistory.length - CREDIT_HISTORY_CAP);
      }
      if (newCredit != null) {
          lastOwnerCredit[currentOwnerEmail] = newCredit;
      }
      console.log(`[CreditTracker] Owner ${currentOwnerEmail}: ${prevCredit} → ${newCredit} (Δ${delta})`);
  } else {
      // Acc chủ = seed link của user (không có trong successList) → không track được
      console.log(`[CreditTracker] No owner email for ${currentOwnerLink} (seed link or cookies missing)`);
  }

  await chrome.storage.local.set({
    successList: newList,
    currentCount: newCount,
    flowState: 'DONE_ONE',
    referralUsage: usage,
    targetUrl: tUrl,
    refLinkQueue: queue,
    usedRefLinks: usedRefLinks,
    completedRefAccs: completedRefAccs,
    accCookies, linkToEmail, lastOwnerCredit, creditHistory
  });

  // Alert nếu N lần liên tiếp delta=0 cho cùng owner (Fotor không count → IP nghi trùng)
  if (creditEvent && creditEvent.delta === 0) {
      const recentSameOwner = creditHistory
          .filter(e => e.ownerEmail === creditEvent.ownerEmail)
          .slice(-ZERO_DELTA_ALERT_N);
      if (recentSameOwner.length === ZERO_DELTA_ALERT_N &&
          recentSameOwner.every(e => e.delta === 0)) {
          sendTelegram(
              `⚠️ <b>IP nghi trùng!</b>\n` +
              `Acc chủ <code>${creditEvent.ownerEmail}</code> KHÔNG tăng credit ${ZERO_DELTA_ALERT_N} lần liên tiếp.\n` +
              `Credit vẫn ở ${creditEvent.newCredit}. Cân nhắc rotate IP.`,
              { silent: false }
          );
      }
  }

  // === GỬI TELEGRAM (silent - không kêu chuông, chỉ vào history) ===
  // Đủ BATCH_SIZE acc "đã đủ ref" -> gửi file
  if (batchToSend && batchToSend.length > 0) {
      const fname = `Fotor_DuRef_${BATCH_SIZE}acc_${Date.now()}.txt`;
      const fileContent =
          `=== ${BATCH_SIZE} TÀI KHOẢN ĐÃ ĐỦ REF (full credit) ===\n` +
          `Thời điểm gửi: ${createdAt}\n` +
          `Tổng đã làm: ${newCount}/${db.targetCount}\n` +
          `Pool còn lại sau gói này: ${completedRefAccs.length} acc\n` +
          `Mỗi acc dưới đây đã có ${REF_LIMIT} người ref dưới link của nó.\n` +
          `============================================\n\n` +
          batchToSend.join('\n');
      const caption =
          `🏆 <b>${BATCH_SIZE} acc ĐÃ ĐỦ REF</b> (full credit)\n` +
          `📊 Tổng: ${newCount}/${db.targetCount}\n` +
          `💎 Pool còn: ${completedRefAccs.length} acc đợi đủ ${BATCH_SIZE}`;
      sendTelegramDocument(fname, fileContent, caption, { silent: true });
  }

  // Auto-save txt local mỗi 50 acc (phòng lag/crash mất data) - KHÔNG gửi Telegram
  if (newCount % 50 === 0) {
      const content = newList.join('\n');
      const b64 = btoa(unescape(encodeURIComponent(content)));
      chrome.downloads.download({
          url: 'data:text/plain;charset=utf-8;base64,' + b64,
          filename: `Fotor_Accounts_AUTO_${newCount}_` + Date.now() + '.txt',
          saveAs: false
      });
  }

  if (db.imailTabId) chrome.tabs.remove(db.imailTabId).catch(()=>{});
  if (db.fotorTabId) chrome.tabs.remove(db.fotorTabId).catch(()=>{});

  // Hoàn thành target -> gửi file final + pool còn dư (silent)
  if (newCount >= db.targetCount) {
      const content = newList.join('\n');
      const b64 = btoa(unescape(encodeURIComponent(content)));
      chrome.downloads.download({
          url: 'data:text/plain;charset=utf-8;base64,' + b64,
          filename: 'Fotor_Accounts_FINAL_' + Date.now() + '.txt',
          saveAs: false
      });

      let finalContent =
          `=== FULL LIST ${newCount} ACCOUNTS ===\n` +
          `Hoàn thành lúc: ${nowVN()}\n` +
          `=====================================\n\n` +
          content;
      let finalCaption = `🎉 <b>HOÀN THÀNH!</b> Đã tạo ${newCount} acc.\n⏰ ${nowVN()}`;
      if (completedRefAccs.length > 0) {
          finalContent +=
              `\n\n=== POOL ĐÃ ĐỦ REF CÒN LẠI (chưa đủ ${BATCH_SIZE} để gửi gói) ===\n` +
              completedRefAccs.join('\n');
          finalCaption += `\n💎 Pool đã đủ ref còn dư: ${completedRefAccs.length} acc (đính kèm trong file)`;
      }
      sendTelegramDocument(
          `Fotor_FINAL_${newCount}_${Date.now()}.txt`,
          finalContent,
          finalCaption,
          { silent: true }
      );
  }

  setTimeout(startNextIteration, 2000);
}

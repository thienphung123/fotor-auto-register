function generatePassword(length = 12) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
  let pass = "";
  for (let i = 0; i < length; i++) {
    pass += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  pass += "A1a!"; 
  return pass;
}

// === GLOBAL WATCHDOG ===
let globalWatchdog = null;
const GLOBAL_TIMEOUT_MS = 120000; // 2 phút

function resetWatchdog() {
  if (globalWatchdog) clearTimeout(globalWatchdog);
  globalWatchdog = setTimeout(() => {
    console.log('[WATCHDOG] Quá 2 phút chưa xong! Tự động Skip lượt này...');
    skipIteration();
  }, GLOBAL_TIMEOUT_MS);
}

function stopWatchdog() {
  if (globalWatchdog) clearTimeout(globalWatchdog);
  globalWatchdog = null;
}

// === BADGE STATUS ===
function setBadge(text, color) {
  chrome.action.setBadgeText({ text: String(text || '') });
  chrome.action.setBadgeBackgroundColor({ color: color || '#e67e22' });
}

// KHẨN CẤP: Dọn dẹp tàn dư Proxy chết ngay khi Extension khởi động
// Tránh việc trình duyệt bị treo ở màn hình ERR_PROXY_CONNECTION_FAILED mãi mãi
if (chrome.proxy && chrome.proxy.settings) {
    chrome.proxy.settings.clear({ scope: 'regular' }, () => {
        console.log('[Sơ cứu] Đã ép tắt sạch mọi thiết lập Proxy bị lỗi dính lại.');
    });
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
  } else if (message.action === 'rotateVPN') {
    // Người dùng nhận thấy Proxy dính Captcha Robot -> Xóa sạch Proxy và Reset web
    chrome.proxy.settings.clear({ scope: 'regular' }, () => {
        console.log('[Proxy] Đã tắt proxy hoàn toàn theo yêu cầu. Load lại web...');
        skipIteration(); // Bỏ qua lượt lỗi này và load lại chu trình mới bằng mạng thật
    });
  } else if (message.action === 'skipCurrent') {
    console.log('[Skip] Nhận lệnh skip từ content script...');
    skipIteration();
  }
});

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
  const db = await chrome.storage.local.get(['successList', 'currentCount', 'tempEmail', 'randomPass', 'imailTabId', 'fotorTabId', 'targetUrl', 'referralUsage', 'refLinkQueue', 'targetCount']);
  
  const newList = db.successList || [];
  newList.push(`${db.tempEmail}|${db.randomPass}|${refLink}`);

  let queue = db.refLinkQueue || [];
  if (refLink && refLink.includes('fotor.com/referrer') && !queue.includes(refLink)) {
      queue.push(refLink);
  }

  let usage = db.referralUsage || 0;
  usage++;

  let tUrl = db.targetUrl;
  let usedRefLinks = db.usedRefLinks || [];

  if (usage >= 20 && queue.length > 0) {
      // Ghi note link vừa dùng xong 20 lần
      usedRefLinks.push({ link: tUrl, usedAt: new Date().toISOString() });
      tUrl = queue.shift();
      usage = 0;
  }

  await chrome.storage.local.set({
    successList: newList,
    currentCount: db.currentCount + 1,
    flowState: 'DONE_ONE',
    referralUsage: usage,
    targetUrl: tUrl,
    refLinkQueue: queue,
    usedRefLinks: usedRefLinks
  });

  if (db.imailTabId) chrome.tabs.remove(db.imailTabId).catch(()=>{});
  if (db.fotorTabId) chrome.tabs.remove(db.fotorTabId).catch(()=>{});

  if (db.currentCount + 1 >= db.targetCount) {
      const content = newList.join('\n');
      const b64 = btoa(unescape(encodeURIComponent(content)));
      chrome.downloads.download({
          url: 'data:text/plain;charset=utf-8;base64,' + b64,
          filename: 'Fotor_Accounts_' + Date.now() + '.txt',
          saveAs: false
      });
  }
  
  setTimeout(startNextIteration, 2000);
}

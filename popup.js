// === Fotor referral policy (đồng bộ với background.js) ===
// Fotor (5/2026): 20pt/ref → 10 ref/link là đủ 200pt full credit.
const REF_LIMIT = 10;

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('startBtn').addEventListener('click', async () => {
    const targetCount = parseInt(document.getElementById('targetCount').value, 10);
    const targetUrl = document.getElementById('targetUrl').value.trim() || 'https://www.fotor.com/';
    const emailProvider = document.getElementById('emailProvider').value;
    
    if (isNaN(targetCount) || targetCount < 1) {
      alert("Vui lòng nhập số lượng hợp lệ.");
      return;
    }

    // KHÔNG xóa successList cũ khi bắt đầu lại - chỉ reset tiến trình
    await chrome.storage.local.set({ 
      targetCount: targetCount,
      targetUrl: targetUrl,
      emailProvider: emailProvider,
      currentCount: 0,
      isRunning: true,
      flowState: 'START_IMAIL',
      tempEmail: '',
      randomPass: ''
    });

    updateUI();
    chrome.runtime.sendMessage({ action: 'startProcess' });
  });

  document.getElementById('stopBtn').addEventListener('click', async () => {
    // Tự động lưu file trước khi dừng
    chrome.storage.local.get('successList', (db) => {
        const list = db.successList || [];
        if (list.length > 0) {
            autoSave(list);
        }
    });
    await chrome.storage.local.set({ isRunning: false, flowState: 'STOPPED' });
    updateUI();
  });

  document.getElementById('downloadBtn').addEventListener('click', () => {
    chrome.storage.local.get('successList', (db) => {
        const list = db.successList || [];
        if (list.length === 0) return alert('Chưa cày được tài khoản nào bạn ơi!');
        autoSave(list);
    });
  });

  // Restore saved provider selection
  chrome.storage.local.get(['emailProvider'], (data) => {
    if (data.emailProvider) document.getElementById('emailProvider').value = data.emailProvider;
  });

  // === Manual Rotate VPN (đổi IP qua OpenVPN helper trên VPS) ===
  document.getElementById('rotateVpnBtn').addEventListener('click', () => {
    const btn = document.getElementById('rotateVpnBtn');
    const vpnStatus = document.getElementById('vpnStatus');
    const original = btn.innerText;
    btn.disabled = true;
    btn.innerText = '⏳ Đang đổi IP...';
    vpnStatus.innerText = 'Helper đang kill openvpn cũ + connect server mới (10-30s)...';
    vpnStatus.style.color = '#9b59b6';
    chrome.runtime.sendMessage({ action: 'manualRotateVPN' }, (res) => {
      btn.disabled = false;
      btn.innerText = original;
      if (chrome.runtime.lastError) {
        vpnStatus.innerText = '❌ Lỗi: ' + chrome.runtime.lastError.message;
        vpnStatus.style.color = '#e74c3c';
        return;
      }
      if (res && res.ok) {
        vpnStatus.innerText = `✅ Server: ${res.server || '?'} | IP: ${res.newIp || '?'}`;
        vpnStatus.style.color = '#27ae60';
      } else {
        const err = (res && res.error) || 'unknown';
        vpnStatus.innerText = `❌ Fail: ${err}${res && res.detail ? ' - ' + res.detail : ''}`;
        vpnStatus.style.color = '#e74c3c';
      }
    });
  });

  // === Resume sau Captcha ===
  document.getElementById('resumeBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'resumeAfterCaptcha' });
    document.getElementById('status').innerText = 'Đang tiếp tục...';
    setTimeout(updateUI, 800);
  });

  // === VPS Proxy config ===
  function setVpsStatus(text, color) {
    const el = document.getElementById('vpsStatus');
    if (el) { el.innerHTML = text; el.style.color = color || '#666'; }
  }

  // Restore VPS config
  chrome.runtime.sendMessage({ action: 'getVpsConfig' }, (cfg) => {
    if (cfg) {
      document.getElementById('vpsHost').value = cfg.host || '';
      document.getElementById('vpsApiToken').value = cfg.apiToken || '';
      document.getElementById('vpsProxyUser').value = cfg.proxyUser || '';
      document.getElementById('vpsProxyPass').value = cfg.proxyPass || '';
      document.getElementById('vpsEnabled').checked = !!cfg.enabled;
      if (cfg.enabled && cfg.host && cfg.apiToken) {
        setVpsStatus('✅ Đang bật - VPS: <code>' + cfg.host + '</code>', '#27ae60');
      }
    }
  });

  document.getElementById('vpsSaveBtn').addEventListener('click', () => {
    const cfg = {
      host: document.getElementById('vpsHost').value.trim(),
      apiToken: document.getElementById('vpsApiToken').value.trim(),
      proxyUser: document.getElementById('vpsProxyUser').value.trim(),
      proxyPass: document.getElementById('vpsProxyPass').value.trim(),
      enabled: document.getElementById('vpsEnabled').checked
    };
    chrome.runtime.sendMessage({ action: 'saveVpsConfig', config: cfg }, (resp) => {
      if (chrome.runtime.lastError) {
        setVpsStatus('❌ Lưu fail: ' + chrome.runtime.lastError.message, '#e74c3c');
        return;
      }
      const missing = [];
      if (!cfg.host) missing.push('host');
      if (!cfg.apiToken) missing.push('token');
      if (!cfg.proxyUser) missing.push('proxyUser');
      if (!cfg.proxyPass) missing.push('proxyPass');
      if (missing.length > 0) {
        setVpsStatus('⚠️ Đã lưu nhưng thiếu: ' + missing.join(', '), '#e67e22');
      } else {
        setVpsStatus('💾 Đã lưu lúc ' + new Date().toLocaleTimeString('vi-VN'), '#27ae60');
      }
    });
  });

  document.getElementById('vpsTestBtn').addEventListener('click', () => {
    setVpsStatus('⏳ Đang test kết nối VPS...', '#9b59b6');
    chrome.runtime.sendMessage({ action: 'testVpsConnection' }, (resp) => {
      if (chrome.runtime.lastError) {
        setVpsStatus('❌ ' + chrome.runtime.lastError.message, '#e74c3c');
        return;
      }
      if (resp && resp.ok) {
        let html = '✅ Kết nối OK: ' + (resp.service || 'fotor-vps-api');
        if (resp.statusReport && resp.statusReport.slots) {
          html += '<br>' + resp.statusReport.slots.map(s =>
            `Slot ${s.slot}: ${s.status || '?'} | ${s.city || s.region || s.country || '?'} | ${s.ip || '?'}`
          ).join('<br>');
        }
        setVpsStatus(html, '#27ae60');
      } else {
        setVpsStatus('❌ Test fail: ' + (resp && resp.error || 'unknown'), '#e74c3c');
      }
    });
  });

  document.getElementById('vpsClearProxyBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'clearVpsProxy' }, (resp) => {
      if (resp && resp.ok) {
        setVpsStatus('⏹️ Đã clear proxy (direct mode). Chrome dùng IP thật của PC.', '#7f8c8d');
      } else {
        setVpsStatus('❌ Clear fail: ' + (resp && resp.error || 'unknown'), '#e74c3c');
      }
    });
  });

  // === Telegram config ===
  // Restore
  chrome.storage.local.get(['telegramConfig'], (data) => {
    const cfg = data.telegramConfig || {};
    document.getElementById('tgBotToken').value = cfg.botToken || '';
    document.getElementById('tgChatId').value = cfg.chatId || '';
    document.getElementById('tgEnabled').checked = !!cfg.enabled;
    if (cfg.enabled && cfg.botToken && cfg.chatId) {
      document.getElementById('tgStatus').innerText = '✅ Đang bật';
      document.getElementById('tgStatus').style.color = '#27ae60';
    }
  });

  document.getElementById('tgSaveBtn').addEventListener('click', () => {
    const cfg = {
      botToken: document.getElementById('tgBotToken').value.trim(),
      chatId: document.getElementById('tgChatId').value.trim(),
      enabled: document.getElementById('tgEnabled').checked
    };
    chrome.storage.local.set({ telegramConfig: cfg }, () => {
      const tgStatus = document.getElementById('tgStatus');
      if (cfg.enabled && (!cfg.botToken || !cfg.chatId)) {
        tgStatus.innerText = '⚠️ Đã bật nhưng thiếu token/chatId!';
        tgStatus.style.color = '#e67e22';
      } else {
        tgStatus.innerText = '💾 Đã lưu lúc ' + new Date().toLocaleTimeString('vi-VN');
        tgStatus.style.color = '#27ae60';
      }
    });
  });

  document.getElementById('tgTestBtn').addEventListener('click', async () => {
    const tgStatus = document.getElementById('tgStatus');
    tgStatus.innerText = '⏳ Đang gửi test...';
    tgStatus.style.color = '#666';
    const botToken = document.getElementById('tgBotToken').value.trim();
    const chatId = document.getElementById('tgChatId').value.trim();
    if (!botToken || !chatId) {
      tgStatus.innerText = '❌ Cần điền Bot Token và Chat ID trước!';
      tgStatus.style.color = '#e74c3c';
      return;
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '🧪 Test từ Fotor Auto Register\n⏰ ' + new Date().toLocaleString('vi-VN'),
          parse_mode: 'HTML'
        })
      });
      const json = await res.json();
      if (json.ok) {
        tgStatus.innerText = '✅ Đã gửi! Kiểm tra Telegram của bạn.';
        tgStatus.style.color = '#27ae60';
      } else {
        tgStatus.innerText = '❌ Lỗi: ' + (json.description || 'Unknown');
        tgStatus.style.color = '#e74c3c';
      }
    } catch (e) {
      tgStatus.innerText = '❌ Network error: ' + e.message;
      tgStatus.style.color = '#e74c3c';
    }
  });
});

function autoSave(list) {
    chrome.storage.local.get(['usedRefLinks', 'targetUrl', 'referralUsage', 'refLinkQueue'], (db) => {
        const used = db.usedRefLinks || [];

        let summary = '\r\n\r\n===== THỐNG KÊ =====\r\n';
        summary += `Tổng tài khoản đã tạo: ${list.length}\r\n`;
        summary += `Ref đang dùng: ${db.targetUrl || '?'} (${db.referralUsage || 0}/${REF_LIMIT} lần)\r\n`;
        summary += `Kho link chờ: ${(db.refLinkQueue || []).length} link\r\n`;

        if (used.length > 0) {
            summary += `\r\nRef đã cày đủ ${REF_LIMIT} lần:\r\n`;
            used.forEach(u => {
                summary += `  ${u.link} - hoàn thành lúc ${new Date(u.usedAt).toLocaleString('vi-VN')}\r\n`;
            });
        }

        const noRef = list.filter(l => l.endsWith('|Không có Ref')).length;
        if (noRef > 0) summary += `\r\nLưu ý: ${noRef} tài khoản không lấy được Ref link!\r\n`;

        const content = list.join('\r\n') + summary;
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        chrome.downloads.download({
            url: url,
            filename: 'Fotor_Accounts_' + new Date().toISOString().slice(0,19).replace(/:/g,'-') + '.txt',
            saveAs: false
        }, () => URL.revokeObjectURL(url));
    });
}

function updateUI() {
  chrome.storage.local.get(['isRunning', 'currentCount', 'targetCount', 'successList',
                            'flowState', 'referralUsage', 'refLinkQueue', 'usedRefLinks', 'targetUrl',
                            'pauseReason'], (res) => {
    const usage    = res.referralUsage || 0;
    const queueLen = (res.refLinkQueue || []).length;
    const used     = res.usedRefLinks  || [];

    // Ref usage bar
    const usageEl = document.getElementById('refUsageInfo');
    if (usageEl) {
      const currentLink = res.targetUrl ? res.targetUrl.replace('https://www.fotor.com/referrer/','').replace('https://www.fotor.com/','') : '?';
      let html = `🔥 <b>Link đang dùng:</b> <span style="color:#2980b9">${currentLink}</span> (${usage}/${REF_LIMIT} lượt) | Kho chờ: ${queueLen}`;
      if (used.length > 0) {
        html += `<br><span style="color:#27ae60">✅ Đã xong ${REF_LIMIT} lần: ` + used.map(u => {
            const code = u.link.replace('https://www.fotor.com/referrer/','');
            return code + ' (' + new Date(u.usedAt).toLocaleTimeString('vi-VN') + ')';
          }).join(', ') + `</span>`;
      }
      usageEl.innerHTML = html;
    }

    // Credit tracker (acc chủ)
    chrome.storage.local.get(['lastOwnerCredit', 'creditHistory'], (cdb) => {
      const el = document.getElementById('creditInfo');
      if (!el) return;
      const hist = cdb.creditHistory || [];
      if (hist.length === 0) {
        el.innerHTML = '💎 <b>Credit acc chủ:</b> chưa có data (đợi acc chủ đầu tiên reg xong)';
        return;
      }
      const last = hist[hist.length - 1];
      const last5 = hist.slice(-5);
      const ok = last5.filter(e => e.delta === 20).length;
      const zero = last5.filter(e => e.delta === 0).length;
      const err = last5.filter(e => e.error).length;
      const icon = last.delta === 20 ? '✅' : last.delta === 0 ? '⚠️' : last.error ? '❌' : '?';
      const ownerShort = (last.ownerEmail || '?').split('@')[0];
      el.innerHTML =
        `💎 <b>Acc chủ:</b> <code>${ownerShort}</code> = ${last.newCredit ?? '?'} ${icon} ` +
        `(Δ${last.delta ?? '?'}) · 5 gần: ${ok}OK/${zero}ko-tăng/${err}lỗi` +
        (last.error ? `<br><span style="color:#e67e22">⚠️ ${last.error}</span>` : '');
    });

    const startBtn  = document.getElementById('startBtn');
    const stopBtn   = document.getElementById('stopBtn');
    const resumeBtn = document.getElementById('resumeBtn');
    const statusEl  = document.getElementById('status');

    if (res.isRunning) {
      startBtn.style.display  = 'none';
      stopBtn.style.display   = 'block';
      resumeBtn.style.display = 'none';
      let stateMsg = res.flowState || '';
      if (res.flowState === 'START_IMAIL' || res.flowState === 'WAIT_EMAIL')    stateMsg = 'Đang lấy Email (iMail)...';
      if (res.flowState === 'GO_FOTOR'   || res.flowState === 'WAIT_FOTOR_FORM') stateMsg = 'Đang điền Fotor Form...';
      if (res.flowState === 'WAIT_IMAIL_CODE')                                   stateMsg = 'Đang chờ mã xác minh từ Email...';
      if (res.flowState === 'WAIT_FOTOR_CODE')                                   stateMsg = 'Đang nhập mã vào Fotor...';
      if (res.flowState === 'GET_REWARDS_LINK')                                  stateMsg = 'Đang lấy link Ref...';
      statusEl.innerText = `Đang chạy (${res.currentCount || 0}/${res.targetCount}) - ${stateMsg}`;
      statusEl.style.color = '#555';
    } else if (res.pauseReason === 'captcha') {
      startBtn.style.display  = 'none';
      stopBtn.style.display   = 'block';
      resumeBtn.style.display = 'block';
      statusEl.innerHTML = `🛑 <b style="color:#e74c3c">PAUSE - Captcha!</b><br>Đổi IP Surfshark xong → bấm "Tiếp tục"<br>(${res.currentCount || 0}/${res.targetCount})`;
    } else {
      startBtn.style.display  = 'block';
      stopBtn.style.display   = 'none';
      resumeBtn.style.display = 'none';
      statusEl.innerText = 'Đã dừng.';
      statusEl.style.color = '#555';
    }
    
    // Đồng bộ link ref đang chạy vào input (nếu không đang gõ)
    if (res.targetUrl && document.activeElement !== document.getElementById('targetUrl')) {
      document.getElementById('targetUrl').value = res.targetUrl;
    }

    const list = res.successList || [];
    document.getElementById('successList').value = list.length > 0 ? list.join('\n') : '';
  });
}

updateUI();
setInterval(updateUI, 1500);

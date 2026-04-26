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
});

function autoSave(list) {
    chrome.storage.local.get(['usedRefLinks', 'targetUrl', 'referralUsage', 'refLinkQueue'], (db) => {
        const used = db.usedRefLinks || [];

        let summary = '\r\n\r\n===== THỐNG KÊ =====\r\n';
        summary += `Tổng tài khoản đã tạo: ${list.length}\r\n`;
        summary += `Ref đang dùng: ${db.targetUrl || '?'} (${db.referralUsage || 0}/20 lần)\r\n`;
        summary += `Kho link chờ: ${(db.refLinkQueue || []).length} link\r\n`;

        if (used.length > 0) {
            summary += '\r\nRef đã cày đủ 20 lần:\r\n';
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
                            'flowState', 'referralUsage', 'refLinkQueue', 'usedRefLinks', 'targetUrl'], (res) => {
    const usage    = res.referralUsage || 0;
    const queueLen = (res.refLinkQueue || []).length;
    const used     = res.usedRefLinks  || [];

    // Ref usage bar
    const usageEl = document.getElementById('refUsageInfo');
    if (usageEl) {
      const currentLink = res.targetUrl ? res.targetUrl.replace('https://www.fotor.com/referrer/','').replace('https://www.fotor.com/','') : '?';
      let html = `🔥 <b>Link đang dùng:</b> <span style="color:#2980b9">${currentLink}</span> (${usage}/20 lượt) | Kho chờ: ${queueLen}`;
      if (used.length > 0) {
        html += `<br><span style="color:#27ae60">✅ Đã xong 20 lần: ` + used.map(u => {
            const code = u.link.replace('https://www.fotor.com/referrer/','');
            return code + ' (' + new Date(u.usedAt).toLocaleTimeString('vi-VN') + ')';
          }).join(', ') + `</span>`;
      }
      usageEl.innerHTML = html;
    }

    if (res.isRunning) {
      document.getElementById('startBtn').style.display = 'none';
      document.getElementById('stopBtn').style.display  = 'block';
      let stateMsg = res.flowState || '';
      if (res.flowState === 'START_IMAIL' || res.flowState === 'WAIT_EMAIL')    stateMsg = 'Đang lấy Email (iMail)...';
      if (res.flowState === 'GO_FOTOR'   || res.flowState === 'WAIT_FOTOR_FORM') stateMsg = 'Đang điền Fotor Form...';
      if (res.flowState === 'WAIT_IMAIL_CODE')                                   stateMsg = 'Đang chờ mã xác minh từ Email...';
      if (res.flowState === 'WAIT_FOTOR_CODE')                                   stateMsg = 'Đang nhập mã vào Fotor...';
      if (res.flowState === 'GET_REWARDS_LINK')                                  stateMsg = 'Đang lấy link Ref...';
      document.getElementById('status').innerText = `Đang chạy (${res.currentCount || 0}/${res.targetCount}) - ${stateMsg}`;
    } else {
      document.getElementById('startBtn').style.display = 'block';
      document.getElementById('stopBtn').style.display  = 'none';
      document.getElementById('status').innerText = 'Đã dừng.';
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

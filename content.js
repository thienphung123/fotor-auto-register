const hostname = window.location.hostname;

// Phát hiện lỗi 405 trên iMail và tự cứu ngay
if (hostname.includes('imail.edu.vn')) {
    const checkError = () => {
        const bodyText = (document.body && document.body.innerText) || '';
        if (bodyText.includes('405 Method Not Allowed') || bodyText.includes('An Error Occurred')) {
            window.location.href = 'https://imail.edu.vn/';
            return true;
        }
        return false;
    };
    // Check ngay và check lại sau 1s (document_start chưa có body)
    if (!checkError()) {
        setTimeout(checkError, 1000);
    }
}

// Bác sĩ giám sát: Tự động bỏ qua nếu trang Fotor bị kẹt ở màn hình Cloudflare hoặc Load trắng
if (hostname.includes('fotor.com')) {
    let fotorStuckAttempts = 0;
    const fotorWatchdog = setInterval(() => {
        const title = document.title.toLowerCase();
        const bodyText = (document.body && document.body.innerText) || '';
        
        // Nếu tiêu đề là "Just a moment..." hoặc trang trắng xóa quá lâu
        if (title.includes('just a moment') || title.includes('security verification') || (bodyText.length < 10 && document.readyState === 'complete')) {
            fotorStuckAttempts++;
            if (fotorStuckAttempts > 20) { // Đợi 20 giây cho Cloudflare tự vượt
                clearInterval(fotorWatchdog);
                updatePanelStatus('⚠️ Bị kẹt ở màn hình Cloudflare quá lâu! Đang bỏ qua lượt này...');
                setTimeout(() => { chrome.runtime.sendMessage({ action: 'skipCurrent' }); }, 1500);
            }
        } else {
            fotorStuckAttempts = 0; // Reset nếu đã load vào trang thật
        }
    }, 1000);
}

chrome.storage.local.get(null, (db) => {
  if (!db.isRunning) return;

  if (window.location.href.includes('fotor.com/rewards') && db.flowState === 'GET_REWARDS_LINK') {
      createPanel('Fotor Reward', 'Đang quét mã giới thiệu...');
        let attempts = 0;
        
        // Lắng nghe kết quả từ hook.js (MAIN world injection)
        window.addEventListener('message', (e) => {
            if ((e.data.type === 'FOTOR_REF_LINK' || e.data.type === 'FOTOR_STOLEN_LINK') && !window.fotorLinkDone) {
                window.fotorLinkDone = true;
                const link = e.data.link || e.data.text;
                updatePanelStatus('✅ Đã chặn Ref Link: ' + link);
                setTimeout(() => { chrome.runtime.sendMessage({ action: 'registrationDone', refLink: link }); }, 1000);
            }
        });

        let intv = setInterval(() => {
            attempts++;
            
            chrome.storage.local.get(['isRunning'], (r) => {
                if (r.isRunning === false) { clearInterval(intv); return; }
            });

            if (window.fotorLinkDone) return;

            // Xoá cookie banner tránh che nút
            const cookieBanner = Array.from(document.querySelectorAll('div')).reverse().find(el => {
                const text = el.innerText || '';
                return text.includes('We use cookies') && text.length < 300;
            });
            if (cookieBanner) cookieBanner.remove();

            // Tìm nút Copy Link và bấm đúng 1 lần
            const btn = Array.from(document.querySelectorAll('*')).reverse().find(el => {
                const t = (el.innerText || '').toLowerCase().trim();
                return t === 'copy link' || t === 'sao chép liên kết';
            });

            if (btn && !window.fotorClicked && attempts >= 3) {
                window.fotorClicked = true;
                updatePanelStatus('Đang bấm Copy Link...');
                try { btn.scrollIntoView({block: 'center'}); } catch(e){}
                setTimeout(() => { btn.click(); }, 300);
            }

            if (!window.fotorClicked) {
                updatePanelStatus('Chờ nút Copy Link... (' + attempts + ')');
            } else {
                updatePanelStatus('Chờ hook.js bắt link... (' + attempts + ')');
            }

            if (attempts > 20) {
                clearInterval(intv);
                updatePanelStatus('Timeout! Lưu không có Ref.');
                setTimeout(() => { chrome.runtime.sendMessage({ action: 'registrationDone', refLink: 'Không có Ref' }); }, 1500);
            }
        }, 1000);
        return;
  }

  if (hostname.includes('imail.edu.vn')) {
    handleImailLogic(db);
  } else if (hostname.includes('temp-mailo.org')) {
    handleTempMailoLogic(db);
  } else if (hostname.includes('fotor.com')) {
    handleFotorLogic(db);
  }
});

// --- TEMP-MAILO.ORG LOGIC ---
function handleTempMailoLogic(db) {
  createPanel('TMail - System', db.flowState, '', db);

  if (db.flowState === 'START_IMAIL') {
    let attempts = 0;

    const interval = setInterval(() => {
      chrome.storage.local.get(['isRunning'], (r) => {
          if (r.isRunning === false) { clearInterval(interval); return; }
      });
      try {
        attempts++;
        updatePanelStatus('Đang đọc email TMail... (' + attempts + ')');

        // Temp-mailo.org tự tạo email ngẫu nhiên khi load trang (sau khi clear cookie)
        // Email được hiển thị trong dropdown ở trên cùng trang
        // Tìm nó trong các thẻ có text dạng "user@domain"
        let emailStr = null;

        // Ưu tiên: tìm trong select/input hoặc các div hiển thị email
        const selects = document.querySelectorAll('select, option');
        for (let el of selects) {
          const text = (el.value || el.innerText || '').trim();
          if (text.includes('@') && text.includes('.') && text.length < 50 && !text.includes(' ')) {
            emailStr = text; break;
          }
        }

        // Fallback: quét tất cả elements
        if (!emailStr) {
          const allEls = document.querySelectorAll('span, div, p, input, label, h1, h2, h3, h4, h5, h6');
          for (let el of allEls) {
            if (el.closest && el.closest('#fotor-auto-reg-panel')) continue;
            const text = (el.value || el.innerText || el.textContent || '').trim();
            if (text.includes('@') && text.includes('.') && text.length >= 6 && text.length < 60
                && !text.includes(' ') && !text.includes('\n')) {
              if (el.offsetHeight > 0 || el.offsetWidth > 0) {
                emailStr = text; break;
              }
            }
          }
        }

        if (emailStr) {
           // Kiểm tra domain có bị blacklist không (giống iMail)
           chrome.storage.local.get({ blacklistedDomains: [] }, (storage) => {
               const domain = emailStr.split('@')[1];
               if (storage.blacklistedDomains && storage.blacklistedDomains.includes(domain)) {
                   clearInterval(interval);
                   updatePanelStatus(`@${domain} bị sổ đen! Đang skip và lấy tab mới...`);
                   // Gửi về background để xóa cookie + mở tab mới (không reload trang vì sẽ cùng domain)
                   setTimeout(() => {
                       chrome.runtime.sendMessage({ action: 'blacklistDomainAndSkip', domain: null }); // domain null = không thêm vào list lần nữa, chỉ skip
                   }, 1000);
               } else {
                   clearInterval(interval);
                   updatePanelStatus('Đã lấy email: ' + emailStr);
                   chrome.runtime.sendMessage({ action: 'emailFetched', email: emailStr });
               }
           });
        } else if (attempts > 15) {
           updatePanelStatus('Không lấy được email sau 15 giây! Bỏ qua...');
           clearInterval(interval);
           setTimeout(() => { chrome.runtime.sendMessage({ action: 'skipCurrent' }); }, 1000);
        }
      } catch (e) {
        console.error('TMail email read error:', e);
      }
    }, 1500);
  }

  // Lắng nghe lệnh poll code (giống iMail)
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'startPollCode') {
      updatePanelStatus('Đang chờ thư từ Fotor...');
      pollForFotorEmailTMail();
    }
  });

  if (db.flowState === 'WAIT_IMAIL_CODE') {
    pollForFotorEmailTMail();
  }
}

function pollForFotorEmailTMail() {
  chrome.storage.local.get(['tempEmail'], (db) => {
    let attempts = 0;
    let codeInterval = setInterval(() => {
      chrome.storage.local.get(['isRunning'], (r) => {
          if (r.isRunning === false) clearInterval(codeInterval);
      });
      try {
        attempts++;
        
        if (attempts >= 30) {
            clearInterval(codeInterval);
            updatePanelStatus('Đợi 60s không thấy thư! Bỏ qua lượt...');
            setTimeout(() => {
                chrome.runtime.sendMessage({ action: 'skipCurrent' });
            }, 1000);
            return;
        }
        
        // Bấm Refresh inbox mỗi 6 giây
        if (attempts % 3 === 0 && !window.hasClickedFotorMail) {
          const refreshBtn = Array.from(document.querySelectorAll('a, button, span, div')).find(b => {
             const text = (b.innerText || b.textContent || '').toLowerCase().trim();
             return text === 'refresh';
          });
          if (refreshBtn) refreshBtn.click();
        }

        // Click vào email Fotor nếu thấy
        if (!window.hasClickedFotorMail) {
            const fotorMail = Array.from(document.querySelectorAll('a, div, span, td, p, li, h5, h6')).find(el => {
                const text = (el.innerText || el.textContent || '').toLowerCase();
                return (text.includes('fotor support') || text.includes('support@fotor') || 
                        text.includes('fotor registration') || text.includes('verify your email')) 
                       && text.length < 200
                       && (el.offsetHeight > 0 || el.offsetWidth > 0);
            });
            if (fotorMail) {
                updatePanelStatus('Đang mở thư Fotor...');
                fotorMail.click();
                window.hasClickedFotorMail = true;
            } else {
                updatePanelStatus(`Chờ thư Fotor... (${attempts}/25)`);
            }
            return; // Chờ vòng sau để đọc code (sau khi thư mở)
        }

        // Sau khi đã click thư - đọc toàn bộ text bao gồm cả iframe
        let allText = (document.body.innerText || document.body.textContent || '');
        Array.from(document.querySelectorAll('iframe')).forEach(f => {
           try { if (f.contentDocument && f.contentDocument.body) allText += ' ' + f.contentDocument.body.innerText; } catch(e){}
        });

        // Tìm mã code 4-6 chữ số
        const matches = allText.match(/\b\d{4,6}\b/g) || [];
        let code = matches.find(m => m.length === 6);
        if (!code) code = matches.find(m => !['2024','2025','2026','2027'].includes(m));

        if (code) {
            clearInterval(codeInterval);
            updatePanelStatus('Đã lấy Code: ' + code);
            chrome.runtime.sendMessage({ action: 'codeFetched', code: code });
        } else {
            updatePanelStatus(`Đọc code từ thư... (${attempts}/25)`);
        }
      } catch (e) {
        console.log('TMail poll error', e);
      }
    }, 2000);
  });
}

// --- IMAIL LOGIC ---
function handleImailLogic(db) {
  createPanel('iMail - System', db.flowState, db.tempEmail, db);

  if (db.flowState === 'START_IMAIL') {
    let attempts = 0;
    const interval = setInterval(() => {
      chrome.storage.local.get(['isRunning'], (r) => {
          if (r.isRunning === false) clearInterval(interval);
      });
      try {
        attempts++;
        
        let emailStr = null;
        let createRandomBtn = null;

        const allEls = Array.from(document.querySelectorAll('*'));
        
        for (let el of allEls) {
          if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT' || el.tagName === 'META') continue;
          
          // Kiểm tra xem có email không (Bỏ qua panel Extension và các thẻ tàng hình)
          if (el.closest && el.closest('#fotor-auto-reg-panel')) continue;
          
          if (el.tagName === 'INPUT' && el.type !== 'hidden' && el.value && el.value.includes('@') && el.value.includes('.')) {
             if (el.offsetHeight > 0 || el.offsetWidth > 0) emailStr = el.value.trim();
          }
          if (el.childNodes && el.childNodes.length === 1) {
             const text = (el.innerText || el.textContent || '').trim();
             // Email đạt chuẩn độ dài và không chứa khoảng trắng
             if (text.includes('@') && text.includes('.') && text.length >= 5 && text.length < 40 && !text.includes(' ') && !text.includes('\n')) {
                // Chỉ nhận email nếu chữ đó ĐANG ĐƯỢC HIỂN THỊ trên màn hình thật (chống Autofill Chrome)
                if (el.offsetHeight > 0 || el.offsetWidth > 0) emailStr = text;
             }
          }

          // Kiểm tra xem có nút Create a Random Email không
          if (!createRandomBtn) {
            const btnText = (el.innerText || el.textContent || el.value || '').toLowerCase().trim();
            if ((btnText.includes('create a random email') || btnText.includes('tạo email ngẫu nhiên')) && (!el.children || el.children.length === 0)) {
              createRandomBtn = el;
            }
          }
        }

        // Ưu tiên Dùng Email luôn nếu đã có
        if (emailStr) {
             chrome.storage.local.get({ blacklistedDomains: [] }, (storage) => {
                 const domain = emailStr.split('@')[1];
                 if (storage.blacklistedDomains && storage.blacklistedDomains.includes(domain)) {
                      updatePanelStatus(`Domain @${domain} đã bị đưa vào Sổ Đen! Bấm New để lấy mail khác...`);
                      const newBtn = Array.from(document.querySelectorAll('*')).find(b => {
                          const t = (b.innerText || '').toLowerCase().trim();
                          return t === 'new' || t === '+ new' || t === 'tạo mới';
                      });
                      if (newBtn) {
                           newBtn.click();
                           setTimeout(() => { emailStr = null; }, 500);
                      } else {
                           setTimeout(() => { window.location.href = 'https://imail.edu.vn/'; }, 1000);
                      }
                 } else {
                      clearInterval(interval);
                      updatePanelStatus('Đã lấy được mail xịn: ' + emailStr);
                      chrome.runtime.sendMessage({ action: 'emailFetched', email: emailStr });
                 }
             });
          } else if (createRandomBtn) {
          updatePanelStatus('Đang click nút tạo mail mới...');
          createRandomBtn.click();
        } else if (attempts > 15) { 
          updatePanelStatus('Timeout lấy mail iMail! Bỏ qua...');
          clearInterval(interval);
          chrome.runtime.sendMessage({ action: 'skipCurrent' });
        }
      } catch (e) {
        console.error(e);
      }
    }, 1500);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'startPollCode') {
      updatePanelStatus('Đang chờ thư từ Fotor...');
      pollForFotorEmail();
    }
  });

  if (db.flowState === 'WAIT_IMAIL_CODE') {
    pollForFotorEmail();
  }
}

function pollForFotorEmail() {
  chrome.storage.local.get(['tempEmail'], (db) => {
    let attempts = 0;
    let codeInterval = setInterval(() => {
      chrome.storage.local.get(['isRunning'], (r) => {
          if (r.isRunning === false) clearInterval(codeInterval);
      });
      try {
        attempts++;
        
        if (attempts >= 30) { // 60 giây không thấy email thì huỷ
            clearInterval(codeInterval);
            updatePanelStatus('Đợi 60s không thấy thư Fotor! Bỏ qua lượt...');
            setTimeout(() => {
                chrome.runtime.sendMessage({ action: 'skipCurrent' });
            }, 1000);
            return;
        }
        
        if (attempts % 4 === 0) {
          const refreshBtn = Array.from(document.querySelectorAll('a, button, span')).find(b => {
             const text = (b.innerText || b.textContent || '').toLowerCase();
             return text.includes('refresh');
          });
          if (refreshBtn) refreshBtn.click();
        }

        const panel = document.getElementById('fotor-auto-reg-panel');
        if (panel) panel.style.display = 'none';

        let allText = (document.body.innerText || document.body.textContent || '');
        
        Array.from(document.querySelectorAll('iframe')).forEach(f => {
           try { if (f.contentDocument && f.contentDocument.body) allText += ' ' + f.contentDocument.body.innerText; } catch(e){}
        });

        if (panel) panel.style.display = 'block';

        if (window.location.href.includes('google_vignette')) {
            updatePanelStatus('Phát hiện Ad Google, đang bỏ qua...');
            window.location.href = 'https://imail.edu.vn/';
            return;
        }

        const els = Array.from(document.querySelectorAll('*')).filter(el => {
            const text = (el.innerText || el.textContent || '').toLowerCase();
            return text.includes('fotor support') && el.childNodes && el.childNodes.length <= 2 && (el.tagName === 'A' || el.tagName === 'SPAN' || el.tagName === 'TD' || el.tagName === 'DIV');
        });
          
        if (els.length > 0 && !window.hasClickedImailFotorText) {
            updatePanelStatus('Đang mở thư Fotor...');
            if (els[0].tagName === 'A' && els[0].href) {
                window.location.href = els[0].href;
            } else {
                els[0].click(); 
            }
            window.hasClickedImailFotorText = true; 
        }

        const matches = allText.match(/\b\d{4,6}\b/g) || [];
        let code = matches.find(m => m.length === 6); 
        if (!code) code = matches.find(m => !['2024','2025','2026','2027'].includes(m));

        if (code) {
            clearInterval(codeInterval);
            updatePanelStatus('Đã giải mã được Code: ' + code);
            chrome.runtime.sendMessage({ action: 'codeFetched', code: code });
        } else {
            updatePanelStatus(`Đang chờ thư Fotor... (Check ${attempts}/15)`);
        }
      } catch (e) {
        console.log('Poll error', e);
      }
    }, 2000);
  });
}


// --- FOTOR LOGIC ---
function handleFotorLogic(db) {
  createPanel('Fotor Auto Reg', db.flowState, db.tempEmail, db);

  if (db.flowState === 'GO_FOTOR') {
    let fotorStep = 1; // 1: Nhập Email, 2: Nhập Password, 3: Chờ Captcha/Submit
    let attempts = 0;
    
    const interval = setInterval(() => {
      if (window.isFotorPaused) return; // Nếu đang Pause thì không chạy Auto (Pause button)
      attempts++;
      
      // Kiểm tra lỗi Rate Limit (Try again / Thử lại / Lỗi kết nối) liên tục
      const bText = document.body.innerText.toLowerCase();
      const rateLimitMatch = bText.includes('something wrong with the connection') || bText.includes('try again later') || bText.includes('too many') || bText.includes('thử lại');
      
      if (rateLimitMatch) {
          window.retryCount = (window.retryCount || 0) + 1;
          
          if (window.retryCount > 6) {
              // Bị giam kẹt quá 6 lần (~30s) -> Xoay IP
              clearInterval(interval);
              updatePanelStatus('Bị Fotor block cứng. Bắt đầu tải Proxy mới xoay IP...');
              chrome.runtime.sendMessage({ action: 'rotateVPN' });
              return;
          }

          updatePanelStatus(`Thao tác quá nhanh! Gặp lỗi Fotor (Retrying ${window.retryCount}/6)...`);
          
          // Bấm nút Retry (nếu có)
          const retryBtn = Array.from(document.querySelectorAll('button')).find(b => {
             const t = (b.innerText || '').toLowerCase();
             return t.includes('retry') || t.includes('thử lại') || t.includes('try again');
          });
          if (retryBtn) retryBtn.click();
          
          // Dịch màn hình hoặc click ngẫu nhiên để chống Bot detector
          window.scrollBy(0, 10);
          
          attempts = 0; // Kéo giãn nhịp
          // Bỏ qua logic bên dưới trong vòng lặp này để câu giờ cho Fotor load lại (1 tick = 1s, nó sẽ chờ)
          return;
      } else {
          window.retryCount = 0; // Mất lỗi màn hình thì reset đếm
      }

      if (fotorStep === 1) {
        // Step 1: Input Email and click Continue
        const emailInput = document.querySelector('input[type="email"], input[placeholder*="email" i], input[placeholder*="Vui lòng nhập địa chỉ" i], input[name="email"]');
        if (emailInput) {
          updatePanelStatus('Điền Email...');
          fillInput(emailInput, db.tempEmail);
          
          setTimeout(() => {
             const continueBtn = Array.from(document.querySelectorAll('button')).find(b => 
                b.innerText.toLowerCase().includes('tiếp tục') || b.innerText.toLowerCase().includes('continue') || b.innerText.toLowerCase().includes('next')
             );
             if (continueBtn && !continueBtn.disabled && !continueBtn.hasAttribute('disabled')) {
               continueBtn.click();
               fotorStep = 2; // Chuyển qua bước password
               attempts = 0;
             }
          }, 500);
        } else {
          // Có thể cần ấn nút "Tiếp tục với Email" trước
          const openEmailBtn = Array.from(document.querySelectorAll('button, div')).find(b => 
             (b.innerText && b.innerText.includes('Tiếp tục với Email')) || 
             (b.innerText && b.innerText.toLowerCase() === 'continue with email') || 
             (b.innerText && b.innerText.toLowerCase() === 'sign up')
          );
          if (openEmailBtn && attempts % 3 === 0) openEmailBtn.click();
          if (attempts > 30) {
              updatePanelStatus('Không thấy Form Fotor sau 30s! Bỏ qua...');
              chrome.runtime.sendMessage({ action: 'skipCurrent' });
          }
        }
      } 
      else if (fotorStep === 2) {
        // Step 2: Input Password, check terms, click Create account
        const passInput = document.querySelector('input[type="password"]');
        if (passInput) {
          updatePanelStatus('Điền Password và click đồng ý Điều Khoản...');
          fillInput(passInput, db.randomPass);
          
          // Cảm biến dấu Checkbox bằng mắt thường 
          let isChecked = false;
          const checkbox = document.querySelector('input[type="checkbox"]');
          if (checkbox) isChecked = checkbox.checked;
          else {
              const checkBoxDiv = document.querySelector('.checkBoxSignUp_inner');
              // Kiểm tra xem thẻ khung đã đổi màu active hoặc vẽ thêm SVG (dấu tick) chưa
              if (checkBoxDiv && (checkBoxDiv.querySelector('svg') || checkBoxDiv.innerHTML.includes('svg') || checkBoxDiv.className.includes('active'))) isChecked = true;
          }
          
          if (!window.hasClickedFotorTerms && !isChecked) {
              window.hasClickedFotorTerms = true;
              setTimeout(() => { window.hasClickedFotorTerms = false; }, 3000); // Khoá ngàm 3s chống ấn phím bật/tắp liên thanh

              Array.from(document.querySelectorAll('div, form')).forEach(d => {
                  try { if (d.scrollHeight > d.clientHeight) d.scrollTop = d.scrollHeight + 1000; } catch(e){}
              });
              
              const fc = (el) => {
                  if(!el) return;
                  try { el.scrollIntoView({block: 'center'}); el.click(); } catch(e){}
              };

              if (checkbox) {
                 fc(checkbox);
                 const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked")?.set;
                 if (nativeSet) nativeSet.call(checkbox, true);
                 checkbox.checked = true;
                 checkbox.dispatchEvent(new Event('change', {bubbles: true}));
              } else {
                 // Giao diện tĩnh không input: Chỉ ấn ĐÚNG 1 thẻ duy nhất
                 const box = document.querySelector('.checkBoxSignUp') || document.querySelector('.agreementBox');
                 if (box) fc(box);
                 else {
                     const termsText = Array.from(document.querySelectorAll('*')).reverse().find(el => {
                        const t = (el.innerText || '').toLowerCase().replace(/\s+/g, ' ');
                        return t.includes('by continuing, you agree') || t.includes('đồng ý với điều khoản');
                     });
                     if (termsText) fc(termsText.parentElement || termsText);
                 }
              }
          }
            
          const submitBtn = Array.from(document.querySelectorAll('button')).find(b => 
            b.innerText.toLowerCase().includes('tạo tài khoản') || 
            b.innerText.toLowerCase().includes('create my account') ||
            b.innerText.toLowerCase().includes('sign up')
          );
              
          if (submitBtn && !submitBtn.disabled && !submitBtn.hasAttribute('disabled')) {
            updatePanelStatus('Đang ấn Tạo tài khoản...');
            submitBtn.click();
            fotorStep = 3; // Nâng lên step 3
            attempts = 0;
          } else {
            updatePanelStatus('Đang chờ nút Tạo Tài Khoản được kích hoạt...');
          }
        }
      } else if (fotorStep === 3) {
         attempts++;
         // Step 3: Đợi màn hình chuyển sang điền mã code, hoặc có Text "Check your email"
         const isCodeScreen = document.querySelector('input[placeholder*="xác minh" i], input[placeholder*="code" i], input[name*="code" i], input[placeholder*="mã" i]');
         const bodyText = document.body.innerText.toLowerCase();
         const isWaitText = bodyText.includes('kiểm tra email của bạn') || bodyText.includes('check your email') || bodyText.includes('verification code');

         if (isCodeScreen || isWaitText) {
             chrome.runtime.sendMessage({ action: 'fotorFormSubmitted' });
             updatePanelStatus('Đã Submit thành công! Đang báo Imail lấy mã...');
             fotorStep = 4;
             attempts = 0;
         } else {
             updatePanelStatus('Đang chờ Fotor duyệt Form/Xác thực...');
             // Self-healing: Quá 5 giây form chưa bay -> Báo lỗi lùi step
             const passInput = document.querySelector('input[type="password"]');
             if (passInput && attempts > 5) {
                 fotorStep = 2;
                 attempts = 0;
                 updatePanelStatus('Submit rỗng nên kẹt, đang thử bấm lại...');
             }
         }
      } else if (fotorStep === 4) {
         attempts++;
         chrome.storage.local.get(['fotorCode'], (dbKey) => {
             if (dbKey.fotorCode) {
                 clearInterval(interval);
                 fillFotorCode(dbKey.fotorCode);
             } else if (attempts % 5 === 0) {
                 updatePanelStatus('Vẫn đang đợi Imail lấy Code...');
             }
         });
      }
    }, 1000);
  }

  // Chờ và Nhập Code
  function fillFotorCode(code) {
      updatePanelStatus('Đang nhập mã Code: ' + code);
      const numberInputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"]'));
      
      let codeBoxFilled = false;
      // Check standard 4-6 box inputs
      if (numberInputs.length >= 4 && !numberInputs[0].placeholder?.toLowerCase()?.includes('xác minh')) {
        const codeDigits = code.split('');
        for (let i = 0; i < Math.min(numberInputs.length, codeDigits.length); i++) {
          fillInput(numberInputs[i], codeDigits[i]);
        }
        codeBoxFilled = true;
      } else {
        // Tìm ô nhập một dòng
        const codeInput = document.querySelector('input[placeholder*="xác minh" i], input[placeholder*="code" i], input[name*="code" i], input[placeholder*="mã" i]') || document.querySelector('input[type="text"]');
        if (codeInput) {
            fillInput(codeInput, code);
            codeBoxFilled = true;
        }
      }
      
      if (!codeBoxFilled) updatePanelStatus('Không tìm thấy ô nhập code!');
      
      let verifyAttempts = 0;
      const verifyInterval = setInterval(() => {
         verifyAttempts++;
         
         // Kiểm tra màn hình thành công (Fotor hiển thị Try Now hoặc Great job)
         const bodyText = document.body.innerText.toLowerCase();
         const isSuccess = bodyText.includes('great job') || bodyText.includes('earned 10 credits') || bodyText.includes('ready to try your first edit') || Array.from(document.querySelectorAll('button')).some(b => b.innerText.toLowerCase().includes('try now'));
         
         if (isSuccess) {
             clearInterval(verifyInterval);
             updatePanelStatus('Verify thành công (Thấy giao diện Start dạo)! Cất cánh sang trang nhận thưởng Rewards...');
             setTimeout(() => {
                 chrome.runtime.sendMessage({ action: 'navToRewards' });
             }, 1500);
             return;
         }

         const confirmBtn = Array.from(document.querySelectorAll('button')).find(b => {
             const t = (b.innerText || '').toLowerCase().trim();
             return (t.includes('verify') || t.includes('xác minh') || t.includes('xác nhận') || t.includes('confirm') || t.includes('create account') || t.includes('create my account')) && !t.includes('try now') && !t.includes('send again');
         });
         
         if (confirmBtn) {
             const hasCaptcha = document.querySelector('iframe[title*="recaptcha" i]');
             
             if (!confirmBtn.disabled && !confirmBtn.hasAttribute('disabled')) {
                 updatePanelStatus('Đang đợi mạng click Hoàn Tất/Create...');
                 confirmBtn.click();
             } else {
                 if (hasCaptcha) {
                     updatePanelStatus('⚠️ Fotor yêu cầu: Vui lòng dùng tay click vào ô "I\'m not a robot"!');
                 } else {
                     updatePanelStatus('Đang chờ nút Hoàn Tất/Create sáng lên...');
                 }
                 // Tương tác lại vào input để kích hoạt nút
                 const codeInput = document.querySelector('input[placeholder*="xác minh" i], input[placeholder*="code" i], input[name*="code" i], input[placeholder*="mã" i]') || document.querySelector('input[type="text"]');
                 if (codeInput && verifyAttempts % 3 === 0) {
                     codeInput.dispatchEvent(new Event('input', { bubbles: true }));
                 }
             }
         } else if (verifyAttempts > 10) {
             updatePanelStatus('Đã Submit xong mã Code! Chờ màn hình load tự động...');
         }
         
         if (verifyAttempts > 45) {
             clearInterval(verifyInterval);
             updatePanelStatus('Verify quá lâu (Timeout)! Quá trình kẹt.');
         }
      }, 1000);
  }

}

// Utils
function fillInput(input, value) {
  if (!input) return;
  if (input.value === value) return; // Chống ghi đè liên tục gây đơ Event React
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.blur();
}

function createPanel(title, flowState, email = '', db = {}) {
  if (!document.body) {
      setTimeout(() => createPanel(title, flowState, email, db), 100);
      return;
  }
  if (document.getElementById('fotor-auto-reg-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'fotor-auto-reg-panel';
  panel.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; background: #fff;
    border: 2px solid #2196F3; border-radius: 8px; padding: 15px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 999999;
    font-family: sans-serif; width: 260px;
  `;

  let emailHtml = email ? `<p style="margin: 0 0 5px 0; font-size: 13px;"><strong>Email:</strong> <span style="color:#d32f2f;">${email}</span></p>` : '';
  let progressText = (typeof db.currentCount !== 'undefined') ? `(${db.currentCount}/${db.targetCount})` : '';

  panel.innerHTML = `
    <h4 style="margin: 0 0 10px 0; color: #2196F3;">${title}</h4>
    ${emailHtml}
    <p style="margin: 0 0 5px 0; font-size: 12px; color: #444;"><strong>Trạng thái:</strong> <span style="color: blue;">${flowState}</span> ${progressText}</p>
    <p id="fotor-panel-status" style="margin: 0 0 15px 0; font-size: 12px; color: #666;">Đang xử lý...</p>
    
    <div style="display: flex; justify-content: space-between; gap: 5px;">
       <button id="fotor-pause-btn" style="flex: 1; padding: 6px; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 10px; font-weight: bold;">Tạm Dừng Auto</button>
       <button id="fotor-force-next-btn" style="flex: 1; padding: 6px; background: #FF9800; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 10px; font-weight: bold;">Bỏ Qua Lượt Này</button>
    </div>
  `;
  document.body.appendChild(panel);

  const pauseBtn = document.getElementById('fotor-pause-btn');
  pauseBtn.addEventListener('click', () => {
    window.isFotorPaused = !window.isFotorPaused;
    if (window.isFotorPaused) {
      pauseBtn.innerText = 'Tiếp Tục Auto';
      pauseBtn.style.background = '#4CAF50';
    } else {
      pauseBtn.innerText = 'Tạm Dừng Auto';
      pauseBtn.style.background = '#f44336';
    }
  });

  const nextBtn = document.getElementById('fotor-force-next-btn');
  nextBtn.addEventListener('click', () => {
      updatePanelStatus('Đang bỏ qua lượt này...');
      chrome.runtime.sendMessage({ action: 'blacklistDomainAndSkip', domain: null });
  });
}

function updatePanelStatus(text) {
  const statusEl = document.getElementById('fotor-panel-status');
  if (statusEl) statusEl.innerText = text;
}

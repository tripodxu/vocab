/**
 * vocab-auth.js — 词汇工具的认证与云同步模块
 * 完全独立，可配置 API 地址，不依赖任何外部框架
 *
 * 使用方式：
 *   <script src="vocab-auth.js"></script>
 *   VocabAuth.configure({ apiBase: '' });  // 空=同源
 *   VocabAuth.init();                      // 检查登录态并渲染UI
 *   VocabAuth.isLoggedIn()                 // 是否已登录
 *   VocabAuth.saveProgress(chapterId, data)
 *   VocabAuth.loadProgress(chapterId)
 *   VocabAuth.loadAllProgress()
 *   VocabAuth.onLogin(callback)            // 登录成功回调
 *   VocabAuth.onSync(callback)             // 同步完成回调
 */
;(function(global) {
  'use strict';

  var TOKEN_KEY = 'vocab:account-token';
  var apiBase = '';
  var token = '';
  var loggedIn = false;
  var email = '';
  var syncTimer = null;
  var loginCallbacks = [];
  var syncCallbacks = [];

  // ===== 配置 =====
  function configure(opts) {
    if (opts.apiBase !== undefined) apiBase = opts.apiBase;
  }

  // ===== HTTP =====
  function headers() {
    var h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  function apiFetch(path, opts) {
    opts = opts || {};
    var mergedHeaders = {};
    var h = headers();
    for (var k in h) mergedHeaders[k] = h[k];
    if (opts.headers) { for (var k2 in opts.headers) mergedHeaders[k2] = opts.headers[k2]; }
    return fetch(apiBase + path, {
      method: opts.method || 'GET',
      headers: mergedHeaders,
      body: opts.body || undefined
    }).then(function(res) {
      if (res.status === 401) { logout_local(); return null; }
      return res.json().catch(function() { return { error: 'network_error', msg: '网络错误' }; });
    }).catch(function() { return { error: 'network_error', msg: '网络错误' }; });
  }

  // ===== 认证状态 =====
  function isLoggedIn() { return loggedIn; }
  function getUserEmail() { return email; }

  function logout_local() {
    loggedIn = false; token = ''; email = '';
    localStorage.removeItem(TOKEN_KEY);
    renderUI();
  }

  function saveToken(t) {
    token = t;
    localStorage.setItem(TOKEN_KEY, t);
  }

  // ===== 初始化 =====
  function init() {
    // 读取token（兼容旧key）
    token = localStorage.getItem(TOKEN_KEY) || localStorage.getItem('art-rank:account-token') || '';
    if (token && !localStorage.getItem(TOKEN_KEY)) {
      localStorage.setItem(TOKEN_KEY, token); // 迁移到新key
    }
    console.log('[VocabAuth] init, token:', token ? token.substring(0,8)+'...' : 'none');
    // 绑定UI事件
    bindUI();
    // 检查登录态
    if (token) {
      apiFetch('/api/account/profile').then(function(data) {
        if (data && data.email) {
          loggedIn = true; email = data.email;
          console.log('[VocabAuth] logged in as', email);
          renderUI();
        } else {
          console.warn('[VocabAuth] token invalid, logging out');
          logout_local();
        }
      });
    } else {
      renderUI();
    }
  }

  // ===== 登录/注册 =====
  function login(em, pw) {
    return apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: em, password: pw })
    }).then(function(result) {
      if (!result) return { error: '网络错误' };
      if (result.error) return result;
      if (result.token) {
        saveToken(result.token);
        loggedIn = true;
        return apiFetch('/api/account/profile').then(function(p) {
          email = p && p.email ? p.email : em;
          renderUI();
          for (var i = 0; i < loginCallbacks.length; i++) loginCallbacks[i](email);
          return { ok: true };
        });
      }
      return { error: '未知错误' };
    });
  }

  function register(em, pw, nickname) {
    return apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: em, password: pw, nickname: nickname || '' })
    }).then(function(result) {
      if (!result) return { error: '网络错误' };
      if (result.error) return result;
      if (result.token) {
        saveToken(result.token);
        loggedIn = true;
        return apiFetch('/api/account/profile').then(function(p) {
          email = p && p.email ? p.email : em;
          renderUI();
          for (var i = 0; i < loginCallbacks.length; i++) loginCallbacks[i](email);
          return { ok: true };
        });
      }
      return { error: '未知错误' };
    });
  }

  function logout() {
    logout_local();
  }

  // ===== 云同步 =====
  function saveProgress(chapterId, data) {
    if (!token) { console.log('[VocabSync] skip save - no token'); return Promise.resolve(null); }
    console.log('[VocabSync] saving chapter', chapterId, 'words:', (data.wrongBookIds||[]).length, 'wrong,', (data.newWordBookIds||[]).length, 'new');
    return apiFetch('/api/vocab/progress/' + chapterId, {
      method: 'PUT',
      body: JSON.stringify(data)
    }).then(function(r) {
      if (r && !r.error) { showSyncDot(); console.log('[VocabSync] chapter', chapterId, 'saved OK'); }
      else { console.warn('[VocabSync] save failed:', r); }
      return r;
    });
  }

  function loadProgress(chapterId) {
    if (!loggedIn) return Promise.resolve(null);
    return apiFetch('/api/vocab/progress/' + chapterId).then(function(r) {
      return r && r.data ? r.data : null;
    });
  }

  function loadAllProgress() {
    if (!token) return Promise.resolve(null);
    return apiFetch('/api/vocab/progress').then(function(r) {
      return r && r.chapters ? r.chapters : null;
    });
  }

  function debounceSave(chapterId, data) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function() { saveProgress(chapterId, data); }, 1000);
  }

  // ===== 设置同步 =====
  function saveSettings(settings) {
    if (!token) return Promise.resolve(null);
    console.log('[VocabSync] saving settings');
    return apiFetch('/api/vocab/settings', {
      method: 'PUT',
      body: JSON.stringify(settings)
    });
  }

  function loadSettings() {
    if (!token) return Promise.resolve(null);
    return apiFetch('/api/vocab/settings').then(function(r) {
      return r && r.settings ? r.settings : null;
    });
  }

  // ===== 回调 =====
  function onLogin(cb) { loginCallbacks.push(cb); }
  function onSync(cb) { syncCallbacks.push(cb); }

  // ===== UI =====
  function renderUI() {
    var emailEl = document.getElementById('userEmail');
    var loginBtn = document.getElementById('loginBtn');
    var logoutBtn = document.getElementById('logoutBtn');
    if (!emailEl || !loginBtn || !logoutBtn) return;
    if (loggedIn && email) {
      emailEl.textContent = email;
      emailEl.style.display = 'inline';
      loginBtn.style.display = 'none';
      logoutBtn.style.display = 'inline';
    } else {
      emailEl.style.display = 'none';
      loginBtn.style.display = 'inline';
      logoutBtn.style.display = 'none';
    }
  }

  function showSyncDot() {
    var el = document.getElementById('syncIndicator');
    if (!el) return;
    el.classList.add('visible');
    setTimeout(function() { el.classList.remove('visible'); }, 2000);
  }

  function bindUI() {
    var loginBtn = document.getElementById('loginBtn');
    var logoutBtn = document.getElementById('logoutBtn');
    if (loginBtn) loginBtn.addEventListener('click', function() { showModal('login'); });
    if (logoutBtn) logoutBtn.addEventListener('click', function() { logout(); });
  }

  function showModal(mode) {
    var overlay = document.createElement('div');
    overlay.className = 'auth-modal-overlay';
    overlay.innerHTML =
      '<div class="auth-modal">' +
        '<h2>' + (mode === 'login' ? '登录' : '注册') + '</h2>' +
        '<input type="email" id="authEmail" placeholder="邮箱">' +
        '<input type="password" id="authPassword" placeholder="密码（至少6位）">' +
        (mode === 'register' ? '<input type="text" id="authNickname" placeholder="昵称">' : '') +
        '<div class="auth-error" id="authError"></div>' +
        '<button class="primary" style="width:100%;justify-content:center;" id="authSubmit">' +
          (mode === 'login' ? '登录' : '注册') +
        '</button>' +
        '<div class="auth-switch" id="authSwitch">' +
          (mode === 'login' ? '没有账号？注册' : '已有账号？登录') +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

    document.getElementById('authSwitch').addEventListener('click', function() {
      overlay.remove();
      showModal(mode === 'login' ? 'register' : 'login');
    });

    document.getElementById('authSubmit').addEventListener('click', function() {
      var em = document.getElementById('authEmail').value.trim();
      var pw = document.getElementById('authPassword').value;
      var errorEl = document.getElementById('authError');
      if (!em || !pw) { errorEl.textContent = '请填写邮箱和密码'; return; }
      if (pw.length < 6) { errorEl.textContent = '密码至少6位'; return; }

      var action;
      if (mode === 'login') {
        action = login(em, pw);
      } else {
        var nick = document.getElementById('authNickname');
        var nickname = nick ? nick.value.trim() : em.split('@')[0];
        action = register(em, pw, nickname);
      }
      action.then(function(result) {
        if (result && result.error) { errorEl.textContent = result.msg || result.error; return; }
        if (result && result.ok) { overlay.remove(); }
      });
    });
  }

  // ===== 暴露 API =====
  global.VocabAuth = {
    configure: configure,
    init: init,
    isLoggedIn: isLoggedIn,
    getUserEmail: getUserEmail,
    login: login,
    register: register,
    logout: logout,
    saveProgress: saveProgress,
    loadProgress: loadProgress,
    loadAllProgress: loadAllProgress,
    debounceSave: debounceSave,
    saveSettings: saveSettings,
    loadSettings: loadSettings,
    onLogin: onLogin,
    onSync: onSync
  };

})(window);

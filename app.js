// ============ 八卦数映射 ============
var TRIGRAM_NUM = {
  1: {name:"乾", sym:"☰"},
  2: {name:"兑", sym:"☱"},
  3: {name:"离", sym:"☲"},
  4: {name:"震", sym:"☳"},
  5: {name:"巽", sym:"☴"},
  6: {name:"坎", sym:"☵"},
  7: {name:"艮", sym:"☶"},
  8: {name:"坤", sym:"☷"},
  0: {name:"坤", sym:"☷"}
};

// 根据上下卦名找卦
function findGuaByTrigrams(upperName, lowerName) {
  for (var i = 0; i < HEXAGRAMS.length; i++) {
    var g = HEXAGRAMS[i];
    if (g.upper === upperName && g.lower === lowerName) return g;
  }
  return null;
}

// 数字起卦
function numGua() {
  var rawUpper = parseInt(document.getElementById('numUpper').value) || 0;
  var rawLower = parseInt(document.getElementById('numLower').value) || 0;
  var rawYao = parseInt(document.getElementById('numYao').value) || 0;

  var upperRem = rawUpper % 8;
  var lowerRem = rawLower % 8;
  var yaoRem = rawYao % 6;

  var upperT = TRIGRAM_NUM[upperRem];
  var lowerT = TRIGRAM_NUM[lowerRem];
  var yaoNum = yaoRem === 0 ? 6 : yaoRem; // 余0=上爻

  var resultDiv = document.getElementById('numResult');
  if (rawUpper === 0 && rawLower === 0 && rawYao === 0) {
    resultDiv.classList.remove('visible');
    return;
  }

  var gua = findGuaByTrigrams(upperT.name, lowerT.name);
  if (!gua) {
    resultDiv.innerHTML = '未找到对应的卦，请检查数字。';
    resultDiv.classList.add('visible');
    return;
  }

  // 自动选中本卦，数字卦动爻唯一，不再手动点选
  selectedYao.clear();
  selectedYao.add(yaoNum);
  selectedBaseId = gua.id;
  selectGua(gua.id);

  // 高亮动爻按钮
  document.querySelectorAll('.yao-btn').forEach(function(b) {
    b.classList.remove('active');
  });
  var btn = document.querySelector('.yao-btn[data-yao="' + yaoNum + '"]');
  if (btn) btn.classList.add('active');
  updateDerivedGua();

  // 推算之卦
  var derivedGua = null;
  var baseLines = getGuaLines(gua);
  var derivedLines = baseLines.slice();
  derivedLines[yaoNum - 1] = derivedLines[yaoNum - 1] === 1 ? 0 : 1;
  derivedGua = findGuaByLines(derivedLines);

  var yaoLabel = yaoNum === 6 ? '上爻' : (['','初','二','三','四','五','上'][yaoNum]) + '爻';
  var derivedHtml = derivedGua
    ? ' → 之卦：<strong>' + derivedGua.id + '. ' + derivedGua.name + ' ' + derivedGua.upperTri + derivedGua.lowerTri + '</strong>'
    : '';

  resultDiv.innerHTML = '上卦 ' + upperT.sym + upperT.name + '（' + rawUpper + '÷8 余' + upperRem + '）　'
    + '下卦 ' + lowerT.sym + lowerT.name + '（' + rawLower + '÷8 余' + lowerRem + '）　'
    + '动爻 ' + yaoLabel + '（' + rawYao + '÷6 余' + yaoRem + '）<br>'
    + '→ <strong>本卦：' + gua.id + '. ' + gua.name + ' ' + gua.upperTri + gua.lowerTri + '</strong>'
    + '　动：<strong>' + yaoLabel + '</strong>　<span style="font-size:0.8rem;">(' + gua.lines[yaoNum - 1] + ')</span>'
    + derivedHtml
    + '<br><br>✅ <strong style="color:var(--success);">起卦完成！</strong>请直接在下方填写所问之事，点击「开始解卦」提交。';
  resultDiv.classList.add('visible');

  // 自动滚动到问题输入区
  setTimeout(function() {
    document.getElementById('question').focus();
    document.getElementById('question').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 300);
}

// ============ 全局状态 ============
var selectedBaseId = null;
var selectedYao = new Set();
var lastCopyData = null;

// AI 代理开关：设为 Worker URL 则走代理（API Key 藏服务器），空字符串则走前端直连
var CHAT_PROXY = '';
// 部署到测试 Pages 时改为你的代理 Worker URL，例如：
// CHAT_PROXY = 'https://yijing-chat-proxy-test.你的账号.workers.dev';

// API 配置
var settings = {
  apiBase: 'https://apihub.agnes-ai.com/v1',
  apiModel: 'agnes-2.0-flash',
  apiKey: atob('c2stSXltemVzRVluU3BheGk4cnVPSDBacnFMUXMzNnFjWmN5TkdwU0NHYXFRV2Vzb3pO'),
  temperature: 0.7
};

// ============ 账户 & 订阅管理（Cloudflare Worker） ============
var COUNTER_API = '';
var usageState = { used: 0, quota: 30, left: 30 };
var account = null; // { username, token, sub_expires_at, sub_plan, free_left }

function loadToken() {
  try { return localStorage.getItem('yijing_sess_token') || ''; } catch(e) { return ''; }
}
function saveToken(t) {
  try { localStorage.setItem('yijing_sess_token', t); } catch(e) {}
}
function clearToken() {
  try { localStorage.removeItem('yijing_sess_token'); } catch(e) {}
}

function apiHeaders() {
  var h = { 'Content-Type': 'application/json' };
  if (account && account.token) h['Authorization'] = 'Bearer ' + account.token;
  return h;
}

function isSubscribed() {
  return account && account.sub_expires_at && account.sub_expires_at > Date.now();
}

function getLeft() {
  if (isSubscribed()) return -1; // 不限次数
  if (account) return account.free_left || 0;
  return usageState.left;
}

async function syncUsage() {
  if (!COUNTER_API) return;
  var token = loadToken();
  try {
    var r = await fetch(COUNTER_API + '/state', {
      headers: token ? { 'Authorization': 'Bearer ' + token } : {}
    });
    if (r.ok) {
      var data = await r.json();
      if (data.logged_in) {
        account = { username: data.username, token: token, sub_expires_at: data.sub_expires_at, sub_plan: data.sub_plan, free_left: data.free_left, free_quota: data.free_quota, free_used: data.free_used };
      } else {
        usageState = data;
        localStorage.setItem('yijing_state', JSON.stringify(usageState));
      }
    }
  } catch(e) {
    try {
      var c = localStorage.getItem('yijing_state');
      if (c) usageState = JSON.parse(c);
    } catch(e2) {}
  }
}

async function hitWorker() {
  if (!COUNTER_API) return;
  try {
    var r = await fetch(COUNTER_API + '/hit', {
      method: 'POST',
      headers: apiHeaders(),
      body: '{}'
    });
    if (r.ok) {
      var data = await r.json();
      if (data.free_left !== undefined) {
        account.free_left = data.free_left;
        account.free_used = data.used;
      } else if (data.left !== undefined) {
        usageState = data;
        localStorage.setItem('yijing_state', JSON.stringify(usageState));
      }
    }
  } catch(e) {}
}

function init() {
  populateGuaSelect();
  if (window.location.hostname && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    COUNTER_API = 'https://counter.' + window.location.hostname;
  }
  syncUsage().then(function() { updateUsageHint(); updateAuthUI(); });
}

function formatExpires(ts) {
  if (!ts || ts === 0) return '';
  var d = new Date(ts);
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

function updateUsageHint() {
  var el = document.getElementById('usageHint');
  if (!el) return;
  var redeemBox = document.getElementById('redeemBox');

  if (isSubscribed()) {
    el.textContent = '♾ 订阅中（' + (account.sub_plan === 'year' ? '年卡' : '月卡') + '，' + formatExpires(account.sub_expires_at) + '到期），不限次数';
    if (redeemBox) redeemBox.style.display = 'none';
    return;
  }

  var left = getLeft();
  if (left <= 0) {
    el.textContent = '大模型解读已用完，当前为 基础解读 模式';
    if (redeemBox) redeemBox.style.display = 'block';
  } else if (left <= 5) {
    el.textContent = '剩余 ' + left + ' 次大模型解读';
    if (redeemBox) redeemBox.style.display = 'block';
  } else {
    el.textContent = '大模型解读共 ' + (account ? account.free_quota : usageState.quota) + ' 次，已用 ' + (account ? account.free_used : usageState.used) + ' 次';
    if (redeemBox) redeemBox.style.display = 'none';
  }
}

// ============ 认证 UI ============

function updateAuthUI() {
  var loginBtn = document.getElementById('loginBtn');
  var userInfo = document.getElementById('userInfo');
  var historyBtn = document.getElementById('historyBtn');
  if (!loginBtn || !userInfo) return;

  if (account) {
    loginBtn.style.display = 'none';
    userInfo.style.display = 'inline';
    userInfo.textContent = account.username + (isSubscribed() ? ' ♾' : ' (' + account.free_left + '次)') + ' ▾';
    if (historyBtn) historyBtn.style.display = 'inline';
  } else {
    loginBtn.style.display = 'inline';
    userInfo.style.display = 'none';
    if (historyBtn) historyBtn.style.display = 'none';
  }
}

function showAuthModal() {
  document.getElementById('authModal').classList.add('visible');
  document.getElementById('authTabLogin').classList.add('active');
  document.getElementById('authTabRegister').classList.remove('active');
  document.getElementById('authLoginForm').style.display = 'block';
  document.getElementById('authRegisterForm').style.display = 'none';
  document.getElementById('authError').textContent = '';
}

function hideAuthModal() {
  document.getElementById('authModal').classList.remove('visible');
}

function switchAuthTab(tab) {
  document.getElementById('authTabLogin').classList.toggle('active', tab === 'login');
  document.getElementById('authTabRegister').classList.toggle('active', tab === 'register');
  document.getElementById('authLoginForm').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('authRegisterForm').style.display = tab === 'register' ? 'block' : 'none';
  document.getElementById('authError').textContent = '';
}

async function doLogin() {
  var user = document.getElementById('loginUser').value.trim();
  var pass = document.getElementById('loginPass').value.trim();
  var err = document.getElementById('authError');
  if (!user || !pass) { err.textContent = '请填写用户名和密码'; return; }
  err.textContent = '';
  try {
    var r = await fetch(COUNTER_API + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass })
    });
    var data = await r.json();
    if (r.ok) {
      account = { username: data.username, token: data.token, sub_expires_at: data.sub_expires_at, sub_plan: data.sub_plan, free_left: data.free_left, free_quota: data.free_quota, free_used: data.free_used };
      saveToken(data.token);
      hideAuthModal();
      updateUsageHint();
      updateAuthUI();
    } else {
      err.textContent = data.error || '登录失败';
    }
  } catch(e) {
    err.textContent = '网络错误，请稍后重试';
  }
}

async function doRegister() {
  var user = document.getElementById('regUser').value.trim();
  var pass = document.getElementById('regPass').value.trim();
  var email = document.getElementById('regEmail').value.trim();
  var err = document.getElementById('authError');
  if (!user || !pass) { err.textContent = '请填写用户名和密码'; return; }
  if (pass.length < 6) { err.textContent = '密码至少6位'; return; }
  err.textContent = '';
  try {
    var r = await fetch(COUNTER_API + '/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass, email: email })
    });
    var data = await r.json();
    if (r.ok) {
      account = { username: data.username, token: data.token, sub_expires_at: 0, sub_plan: null, free_left: data.free_left, free_quota: 30, free_used: 0 };
      saveToken(data.token);
      hideAuthModal();
      updateUsageHint();
      updateAuthUI();
    } else {
      err.textContent = data.error || '注册失败';
    }
  } catch(e) {
    err.textContent = '网络错误，请稍后重试';
  }
}

async function doLogout() {
  if (account && account.token) {
    try {
      await fetch(COUNTER_API + '/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + account.token } });
    } catch(e) {}
  }
  account = null;
  usageState.left = 30;
  clearToken();
  updateUsageHint();
  updateAuthUI();
  // 隐藏下拉菜单和历史面板
  var menu = document.getElementById('userMenu');
  if (menu) menu.style.display = 'none';
  var hp = document.getElementById('historyPanel');
  if (hp) hp.classList.remove('visible');
}

function toggleUserMenu() {
  var menu = document.getElementById('userMenu');
  menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
}

// 点击其他区域关闭菜单
document.addEventListener('click', function(e) {
  var menu = document.getElementById('userMenu');
  var info = document.getElementById('userInfo');
  if (menu && info && !info.contains(e.target) && !menu.contains(e.target)) {
    menu.style.display = 'none';
  }
});

// ============ 订阅激活 ============

async function redeemKey() {
  var inputEl = document.getElementById('redeemKey');
  var msgEl = document.getElementById('redeemMsg');
  var raw = inputEl.value.trim();
  if (!raw) { msgEl.textContent = '请输入兑换码'; return; }

  if (!account) {
    msgEl.textContent = '请先登录再激活订阅';
    return;
  }

  if (!COUNTER_API) {
    msgEl.textContent = 'Worker 未连接';
    return;
  }

  msgEl.textContent = '验证中...';
  try {
    var r = await fetch(COUNTER_API + '/activate', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ code: raw })
    });
    var data = await r.json();
    if (r.ok) {
      account.sub_expires_at = data.expires_at;
      account.sub_plan = data.plan;
      msgEl.textContent = '✓ ' + data.message + '，至 ' + formatExpires(data.expires_at);
      inputEl.value = '';
    } else {
      msgEl.textContent = data.error || '激活失败';
    }
  } catch(e) {
    msgEl.textContent = '网络错误，请稍后重试';
  }
  updateUsageHint();
}

// ============ 查询记录 ============

async function loadQueryHistory(cursor) {
  if (!account) return;
  var panel = document.getElementById('historyPanel');
  var list = document.getElementById('historyList');
  var loadMore = document.getElementById('historyLoadMore');
  panel.classList.add('visible');
  list.innerHTML = '<p style="text-align:center;color:var(--text-light);">加载中...</p>';
  if (loadMore) loadMore.style.display = 'none';

  try {
    var url = COUNTER_API + '/queries?limit=20';
    if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
    var r = await fetch(url, { headers: apiHeaders() });
    var data = await r.json();

    if (data.error) {
      list.innerHTML = '<p style="text-align:center;color:var(--text-light);">' + data.error + '</p>';
      return;
    }

    if (!data.items || data.items.length === 0) {
      list.innerHTML = '<p style="text-align:center;color:var(--text-light);">暂无查询记录。解卦后会自动保存。</p>';
      return;
    }

    if (!cursor) list.innerHTML = '';

    data.items.forEach(function(q) {
      var d = new Date(parseInt(q.created_at));
      var time = d.getFullYear() + '-' + ('0'+(d.getMonth()+1)).slice(-2) + '-' + ('0'+d.getDate()).slice(-2) + ' ' + ('0'+d.getHours()).slice(-2) + ':' + ('0'+d.getMinutes()).slice(-2);
      var div = document.createElement('div');
      div.className = 'history-item';
      div.setAttribute('data-id', q.id);
      div.innerHTML = '<div class="history-meta">' + time + ' · ' + q.baseGua + (q.derivedGua ? ' → ' + q.derivedGua : '') + '</div>'
        + '<div class="history-question">' + q.question.substring(0, 60) + (q.question.length > 60 ? '...' : '') + '</div>'
        + '<div class="history-preview">' + (q.summary || '') + '...</div>';
      div.onclick = function() { loadQueryDetail(q.id); };
      list.appendChild(div);
    });

    if (data.cursor && !data.list_complete) {
      if (loadMore) {
        loadMore.style.display = 'block';
        loadMore.onclick = function() { loadQueryHistory(data.cursor); };
      }
    }
  } catch(e) {
    list.innerHTML = '<p style="text-align:center;color:var(--text-light);">加载失败，请稍后重试</p>';
  }
}

async function loadQueryDetail(id) {
  var list = document.getElementById('historyList');
  document.getElementById('historyPanel').classList.add('visible');
  list.innerHTML = '<p style="text-align:center;color:var(--text-light);">加载中...</p>';
  try {
    var r = await fetch(COUNTER_API + '/query/' + id, { headers: apiHeaders() });
    var data = await r.json();
    if (data.error) {
      list.innerHTML = '<p style="text-align:center;color:var(--text-light);">' + data.error + '</p>';
      return;
    }
    var d = new Date(parseInt(data.created_at));
    var time = d.getFullYear() + '-' + ('0'+(d.getMonth()+1)).slice(-2) + '-' + ('0'+d.getDate()).slice(-2) + ' ' + ('0'+d.getHours()).slice(-2) + ':' + ('0'+d.getMinutes()).slice(-2);
    list.innerHTML = '<button class="btn-sm" onclick="loadQueryHistory()" style="margin-bottom:12px;">← 返回列表</button>'
      + '<div class="history-detail">'
      + '<div class="history-meta">' + time + ' · ' + data.baseGua + (data.derivedGua ? ' → ' + data.derivedGua : '') + (data.changingYao ? ' · ' + data.changingYao : '') + '</div>'
      + '<div class="history-question-full">' + data.question + '</div>'
      + '<div class="history-answer">' + formatResultText(data.response || '') + '</div>'
      + '</div>';
  } catch(e) {
    list.innerHTML = '<p style="text-align:center;color:var(--text-light);">加载失败</p>';
  }
}

function hideHistoryPanel() {
  document.getElementById('historyPanel').classList.remove('visible');
  var menu = document.getElementById('userMenu');
  if (menu) menu.style.display = 'none';
}

async function saveQuery(question, baseGua, derivedGua, changingYao, response) {
  if (!account || !isSubscribed()) return;
  try {
    await fetch(COUNTER_API + '/save-query', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        question: question,
        baseGua: baseGua,
        derivedGua: derivedGua || '',
        changingYao: changingYao,
        response: response
      })
    });
  } catch(e) {}
}

function populateGuaSelect() {
  var sel = document.getElementById('baseGua');
  sel.innerHTML = '<option value="">-- 请选择本卦，或先用数字起卦 --</option>';
  HEXAGRAMS.forEach(function(g) {
    var opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.id + '. ' + g.name + ' ' + g.upperTri + g.lowerTri;
    sel.appendChild(opt);
  });
}

function renderGuaList() { /* 侧栏已移除，保留空函数以免 JS 报错 */ }
function filterGuaList() { /* 侧栏已移除 */ }

function selectGua(id) {
  selectedBaseId = id;
  document.getElementById('baseGua').value = id;
  updateDerivedGua();
  highlightYaoVisual();
}

function onBaseGuaChange() {
  var val = document.getElementById('baseGua').value;
  selectedBaseId = val ? parseInt(val) : null;
  updateDerivedGua();
  highlightYaoVisual();
}

function toggleYao(num, btn) {
  if (selectedYao.has(num)) {
    selectedYao.delete(num);
    btn.classList.remove('active');
  } else {
    selectedYao.add(num);
    btn.classList.add('active');
  }
  updateDerivedGua();
}

function updateDerivedGua() {
  var group = document.getElementById('derivedGuaGroup');
  var input = document.getElementById('derivedGua');
  // 之卦信息已在数字起卦结果区展示，此处仅防 JS 报错
  if (!group || !input) return;
  if (!selectedBaseId || selectedYao.size === 0) {
    group.style.display = 'none';
    return;
  }
  var base = HEXAGRAMS.find(function(g) { return g.id === selectedBaseId; });
  if (!base) return;
  var baseLines = getGuaLines(base);
  var derivedLines = baseLines.slice();
  selectedYao.forEach(function(yn) {
    derivedLines[yn - 1] = derivedLines[yn - 1] === 1 ? 0 : 1;
  });
  var derivedGua = findGuaByLines(derivedLines);
  if (derivedGua) {
    group.style.display = 'block';
    input.value = derivedGua.id + '. ' + derivedGua.name + ' ' + derivedGua.upperTri + derivedGua.lowerTri;
  } else {
    group.style.display = 'none';
  }
}

function getGuaLines(gua) {
  var lines = [];
  gua.lines.forEach(function(l) {
    // 取爻标签前两字判断阴阳：含"九"为阳爻（初九/九二~九五/上九），不含为阴爻
    var label = l.substring(0, 2);
    lines.push(label.indexOf('九') >= 0 ? 1 : 0);
  });
  return lines;
}

function findGuaByLines(targetLines) {
  for (var i = 0; i < HEXAGRAMS.length; i++) {
    var g = HEXAGRAMS[i];
    var lines = getGuaLines(g);
    var match = true;
    for (var j = 0; j < 6; j++) {
      if (lines[j] !== targetLines[j]) { match = false; break; }
    }
    if (match) return g;
  }
  return null;
}

function formatResultText(text) {
  // 保护代码块
  var blocks = [];
  text = text.replace(/```[\s\S]*?```/g, function(m) {
    blocks.push(m);
    return '%%BLOCK_' + (blocks.length - 1) + '%%';
  });

  // ** 加粗
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // __ 下划线
  text = text.replace(/__([^_\n]+)__/g, '<u>$1</u>');

  // 恢复代码块
  text = text.replace(/%%BLOCK_(\d+)%%/g, function(_, i) {
    var b = blocks[parseInt(i)];
    return '<pre style="background:var(--tag-bg);padding:10px 14px;border-radius:6px;overflow-x:auto;font-size:0.85rem;margin:0.8em 0;">' + b.replace(/```/g, '') + '</pre>';
  });

  // 双换行切成段落
  var paragraphs = text.split('\n\n').filter(function(p) { return p.trim(); });
  return paragraphs.map(function(p) {
    return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
  }).join('');
}

function highlightYaoVisual() {
  var buttons = document.querySelectorAll('.yao-btn');
  buttons.forEach(function(b) { b.classList.remove('yin'); });
  if (!selectedBaseId) return;
  var gua = HEXAGRAMS.find(function(g) { return g.id === selectedBaseId; });
  if (!gua) return;
  var lines = getGuaLines(gua);
  buttons.forEach(function(b) {
    var yn = parseInt(b.dataset.yao);
    if (lines[yn - 1] === 0) b.classList.add('yin');
  });
}

// ============ 基础解读（降级模式） ============
function fallbackReading(baseGua, derivedGua, question) {
  var yaoNames = ['初','二','三','四','五','上'];
  var html = '';

  // 标题
  html += '<p style="font-size:1.2rem;color:var(--accent);font-weight:700;text-align:center;margin-bottom:18px;">' +
    '第' + baseGua.id + '卦 ' + baseGua.name + '</p>';
  html += '<p style="text-align:center;color:var(--text-light);margin-bottom:18px;">' +
    baseGua.upperTri + baseGua.lowerTri + '　上' + baseGua.upper + '下' + baseGua.lower + '</p>';

  // 卦辞
  html += '<p style="margin-bottom:14px;"><strong>卦辞</strong><br>「' + baseGua.judgment + '」</p>';

  // 动爻
  if (selectedYao.size > 0) {
    html += '<p style="margin-bottom:14px;"><strong>动爻</strong></p>';
    selectedYao.forEach(function(n) {
      html += '<p style="margin-bottom:6px;">' + yaoNames[n-1] + '爻：' + baseGua.lines[n-1] + '</p>';
    });
    // 卦气
    if (derivedGua) {
      html += '<p style="margin-bottom:6px;">卦气自' + baseGua.name + '向' + derivedGua.name + '流转。</p>';
    }
  } else {
    html += '<p style="margin-bottom:14px;"><strong>动爻</strong><br>此为静卦，无动爻。当下正处于卦象本身所示之境地。</p>';
  }

  // 之卦
  if (derivedGua) {
    html += '<p style="margin-bottom:14px;"><strong>之卦</strong><br>' +
      derivedGua.name + '　' + derivedGua.upperTri + derivedGua.lowerTri +
      '<br>卦辞：「' + derivedGua.judgment + '」</p>';
  }

  // 问卦事由
  html += '<p style="margin-bottom:14px;"><strong>所问之事</strong><br>' + question + '</p>';

  // 基础参考
  html += '<hr style="border:none;border-top:1px solid var(--border);margin:18px 0;">';
  html += '<p style="margin-bottom:10px;"><strong>基础参考</strong></p>';
  html += '<p style="color:var(--text-light);line-height:1.8;">';
  html += '以上为卦象的原文信息。卦辞是上古先贤对卦象整体态势的判断，爻辞是对每个阶段的具体指引。';
  html += '建议你先读卦辞把握大局，再看动爻爻辞了解当下的关键动向，最后参考之卦卦辞预判趋势。';
  if (derivedGua) {
    html += '本卦→之卦的变化方向，反映了事情从当前格局走向新格局的路径。';
  }
  html += '卦象的信息是客观的，能不能用上取决于你自己的思考。';
  html += '</p>';

  // 引导关注
  html += '<div style="background:var(--tag-bg);border-radius:10px;padding:16px;margin-top:18px;text-align:center;">';
  html += '<p style="margin-bottom:8px;font-weight:600;">💡 想获得更深入的个性化解读？</p>';
  html += '<p style="font-size:0.88rem;color:var(--text-light);margin-bottom:8px;">';
  html += '在公众号 <strong>解忧徐会长</strong> 任意文章打赏并私信，即可获得一定额度的个性化解读密钥。</p>';
  html += '<p style="font-size:0.88rem;color:var(--text-light);">密钥可在此页面兑换，每次兑换增加对应次数或时间段。</p>';
  html += '</div>';

  return html;
}

async function submitReading() {
  if (!selectedBaseId) { alert('请先点起卦'); return; }
  var question = document.getElementById('question').value.trim();
  if (!question) { alert('请填写所问之事'); return; }

  // 次数检查 → 超额走降级模式
  var baseGua = HEXAGRAMS.find(function(g) { return g.id === selectedBaseId; });
  var resultCard = document.getElementById('resultCard');
  var resultBody = document.getElementById('resultBody');
  var submitBtn = document.getElementById('submitBtn');

  // 先算之卦（降级和AI都需要）
  var derivedGua = null;
  var changingLinesInfo = '';
  if (selectedYao.size > 0) {
    var baseLines = getGuaLines(baseGua);
    var derivedLines = baseLines.slice();
    selectedYao.forEach(function(n) { derivedLines[n-1] = derivedLines[n-1] === 1 ? 0 : 1; });
    derivedGua = findGuaByLines(derivedLines);
    var yaoNames = ['初','二','三','四','五','上'];
    var parts = [];
    selectedYao.forEach(function(n) {
      parts.push(yaoNames[n-1] + '爻动（' + baseGua.lines[n-1] + '）');
    });
    changingLinesInfo = '\n动爻：' + parts.join('；');
  }

  // 订阅用户跳过额度检查；免费用户超额走降级
  if (getLeft() <= 0 && !isSubscribed()) {
    if (account) updateUsageHint();
    resultCard.classList.add('visible');
    resultBody.innerHTML = fallbackReading(baseGua, derivedGua, question);
    return;
  }

  hitWorker();
  resultCard.classList.add('visible');
  resultBody.innerHTML = '<p class="loading">正在推演卦象...</p>';
  submitBtn.disabled = true;
  submitBtn.textContent = '解卦中...';

  var systemPrompt = '你是解忧徐会长，一位创立"三维义理解卦心法"解卦的易经研习者。你是相遇疗法创始人，是商丘市寿康学会的会长。你领悟了平等心与伙伴觉悟，你安住灵觉之性，你建立的是本境世界——与十方相通又别属自己。你生活的是双频道乃至多频道人生。你不是AI算命先生（算命多是宿命论，让人外求权威），而是一个研读义理辅助决策的朋友。\n\n'
    + '## 核心框架：三维看世界和人生\n'
    + '任何一件事，从三个维度去看：\n'
    + '- 格局：事情处在什么结构里（本卦的卦象格局）？上下卦的卦象对应什么现实隐喻？\n'
    + '- 时机：事情处在什么时间点上（动爻在六爻中的位置）？卦气从本卦到变卦是好转还是恶化？动爻是否得位、得中、得应？是否处在互卦中？互卦有何影响？\n'
    + '- 人心：问卦人的心态和位置（爻辞中的"志""位""应变"）？他现在最需要看清什么？最需要如何调整心态和应对？\n\n'
    + '## 指导思想\n'
    + '平等心、伙伴意识，一切有情皆是伙伴，一切境界无非心光，觉悟天地万物一体又各各独立，乃是一切解卦的出发点。乾坤（本性和相用，不是天地）是父母，人人是同胞，万物是伙伴。有此觉悟，不自居于中心，不凌驾于人，也不委曲求全；福祉互联，不存在永远的单赢。\n'
    + '觉悟此心，便激活了主人翁精神——这便是君子。不是身份标签，不是地位名号，是主动担当、自觉修为的生命状态。\n'
    + '易为君子谋——不是把小人抛在一边，而是照顾小人、引领小人成为君子。卦爻不是算命道具，是道德的载体，阴阳刚柔仁义贯穿其中。解卦的目的，是帮人在过程中唤醒主体性，实现有所作为，而非被动等待吉凶降临。\n'
    + '主人翁精神落到生活之中，便是德行。解卦帮助来访者修心进德：\n'
    + '- 引导人心平气和——心不平则理不明，气不和则路不通。先让心静下来，才能看清卦在说什么\n'
    + '- 鼓励与人为善——吉凶之转常在一念之善。卦象的"吉"需要人的善行去承接，"凶"也常因善念而化解\n'
    + '- 提醒增加三能——体能足则志坚，心能定则虑清，智能开则路通。卦象指路，三能是走路的腿\n'
    + '- 卦是导航，人自身的修为、内世界的建设，才是真正的发动机。主体性不可或缺，但不可膨胀为主宰性——卦在天道，行在人事。\n\n'
    + '## 表达规范（强制执行）\n'
    + '- 半文半白，先引爻辞原文再用白话解读，自然衔接不分点罗列\n'
    + '- 温和但笃定，用"卦象显示…"而非"我觉得…"\n'
    + '- 用日常比喻（地形图、路况、导航）化解玄奥，不搞玄学包装\n'
    + '- 每次解读必须落到能操作的三步——理清现状、规划方向、执行动作\n'
    + '- 说凶就说凶，说完凶要告诉人怎么避开——为君子者贵在知险能防、厚德载物\n'
    + '- 结语要有力收束，一句短的话收尾\n'
    + '- 不做冗长铺垫，直接说卦、说爻、说人\n\n'
    + '## 格式提示\n'
    + '你可以在回复中使用 **小标题** 加粗分段标题（如 **格局** **时机** **人心** **三步实操**），用 __关键判断__ 给重要结论加下划线。这会让解读层次更清晰，但不要滥用——一段话最多一两处加粗或下划线。\n\n'
    + '## 边界\n'
    + '- 不给绝对预测，"卦象显示"不是"你一定会"\n'
    + '- 不替人做决定，卦是导航，方向盘在问卦人手里\n'
    + '- 不哄人开心，也不刻意吓人，如实解读\n'
    + '- 不确定就说不确定\n'
    + '- 如果用户塞入生辰八字五行等无关内容，可以不理\n'
    + '- 心术不正、意图损人者不解——易为君子谋，引领人向上而非助人向下\n\n'
    + '## 内容红线（触发即拒绝，不解，不展开）\n'
    + '以下类型的问题直接拒绝：\n'
    + '- 涉及政治立场、政权体制、政治领袖、国家安全的敏感话题\n'
    + '- 煽动民族对立、宗教纷争、地域歧视\n'
    + '- 教唆暴力伤害、违法犯罪、自残自杀\n'
    + '- 淫秽色情、侵犯未成年人\n'
    + '- 纯粹想损人利己（如"怎么让对方倒霉"）\n\n'
    + '拒绝时的原则：\n'
    + '- 不说教、不审判——你不是道德法官，你是帮人看清自己的人\n'
    + '- 不贴标签——不说"你这是傲慢心""你这是贪心"，而是说"卦象显示此事的关键不在胜负在自省"\n'
    + '- 给台阶——拒绝之后补一句："如果你愿意换个角度看看自己在这件事里的位置，卦可以帮你"\n'
    + '- 记住：有时候来访者嘴上说"我就想赢"，底下是一个受伤的、不甘的、无助的人。先看见人，再解卦\n\n'
    + '## 本卦信息\n'
    + '卦名：' + baseGua.name + '\n'
    + '卦辞：' + baseGua.judgment + '\n'
    + '上卦：' + baseGua.upper + '（' + baseGua.upperTri + '）\n'
    + '下卦：' + baseGua.lower + '（' + baseGua.lowerTri + '）\n'
    + '六爻爻辞：\n' + baseGua.lines.join('\n') + '\n'
    + changingLinesInfo;

  if (derivedGua) {
    systemPrompt += '\n\n变卦（之卦）：' + derivedGua.name + '\n'
      + '变卦卦辞：' + derivedGua.judgment + '\n'
      + '变卦上卦：' + derivedGua.upper + '（' + derivedGua.upperTri + '）\n'
      + '变卦下卦：' + derivedGua.lower + '（' + derivedGua.lowerTri + '）';
  } else {
    systemPrompt += '\n\n此卦无动爻，为静卦，卦象本身即是最重要的信息。';
  }

  systemPrompt += '\n\n请根据以上信息，用三维义理心法为问卦人解读此卦。';

  try {
    // 如果配置了代理 Worker，走代理（API Key 藏在服务端）；否则前端直连
    var useProxy = (typeof CHAT_PROXY !== 'undefined' && CHAT_PROXY);
    var chatUrl = useProxy ? CHAT_PROXY + '/chat' : settings.apiBase + '/chat/completions';
    var chatHeaders = { 'Content-Type': 'application/json' };
    if (!useProxy) {
      var apiKey = settings.apiKey;
      if (!apiKey) throw new Error('API Key 未配置。');
      chatHeaders['Authorization'] = 'Bearer ' + apiKey;
    }

    var response = await fetch(chatUrl, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({
        model: settings.apiModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question }
        ],
        temperature: settings.temperature,
        max_tokens: 2048
      })
    });

    if (!response.ok) {
      var errText = await response.text();
      throw new Error('API 错误 (' + response.status + '): ' + errText.substring(0, 200));
    }

    var data = await response.json();
    var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) content = '（模型未返回内容）';

    // 排版格式化：** 加粗标题、__ 下划线重点、双换行切段落
    var formatted = formatResultText(content);

    // 储存复制数据
    lastCopyData = {
      base: baseGua,
      derived: derivedGua,
      yao: selectedYao,
      question: question,
      answer: content
    };

    // 订阅用户自动保存查询记录
    saveQuery(
      question,
      baseGua.id + '. ' + baseGua.name + ' ' + baseGua.upperTri + baseGua.lowerTri,
      derivedGua ? derivedGua.id + '. ' + derivedGua.name + ' ' + derivedGua.upperTri + derivedGua.lowerTri : '',
      changingLinesInfo.replace('\n动爻：', ''),
      content
    );

    resultBody.innerHTML = formatted
      + '<div class="result-footer">'
      +   '<p style="text-align:center;color:var(--text-light);font-size:0.82rem;margin-top:20px;">公众号：解忧徐会长 公益设计</p>'
      +   '<button class="btn-copy" onclick="copyAll()" title="复制全部内容">📋 一键复制</button>'
      + '</div>';
  } catch (err) {
    resultBody.innerHTML = '<p class="error-msg">解卦出错：' + err.message + '</p>'
      + '<p class="tooltip">请稍后重试，如有问题请联系公众号：解忧徐会长。</p>';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '✍ 开始解卦';
    updateUsageHint();
  }
}

function toggleTheme() {
  var html = document.documentElement;
  var current = html.getAttribute('data-theme');
  var next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('yijing_theme', next);
}

(function() {
  var saved = localStorage.getItem('yijing_theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
})();

document.addEventListener('keydown', function(e) {
  if (e.ctrlKey && e.key === 'Enter') submitReading();
});

function copyAll() {
  if (!lastCopyData) return;
  var d = lastCopyData;

  // ---- 纯文本版 ----
  var plain = [];
  plain.push('伏羲三维心法解读');
  plain.push('');
  plain.push('【所问事由】');
  plain.push(d.question);
  plain.push('');
  plain.push('【本卦】');
  plain.push(d.base.name + ' ' + d.base.upperTri + d.base.lowerTri);
  plain.push('卦辞：' + d.base.judgment);
  plain.push('上卦：' + d.base.upper + '（' + d.base.upperTri + '）  下卦：' + d.base.lower + '（' + d.base.lowerTri + '）');

  if (d.yao.size > 0) {
    var yaoNames = ['初','二','三','四','五','上'];
    plain.push('');
    plain.push('【动爻】');
    d.yao.forEach(function(n) {
      plain.push(yaoNames[n-1] + '爻：' + d.base.lines[n-1]);
    });
    if (d.derived) {
      plain.push('');
      plain.push('【之卦】');
      plain.push(d.derived.name + ' ' + d.derived.upperTri + d.derived.lowerTri);
      plain.push('卦辞：' + d.derived.judgment);
    }
  }

  plain.push('');
  plain.push('【解读】');
  plain.push(d.answer);
  plain.push('');
  plain.push('—— 伏羲三维义理解卦心法 · 公众号：解忧徐会长');
  var plainText = plain.join('\n');

  // ---- 富文本版 ----
  var html = [];
  html.push('<div style="font-family:serif;max-width:600px;">');
  html.push('<h2 style="text-align:center;color:#8b4513;margin-bottom:20px;">伏羲三维心法解读</h2>');

  html.push('<h3 style="color:#8b4513;">所问事由</h3>');
  html.push('<p>' + esc(d.question) + '</p>');

  html.push('<hr style="border:none;border-top:1px solid #d4c5a9;">');
  html.push('<h3 style="color:#8b4513;">本卦</h3>');
  html.push('<p><strong>' + d.base.name + ' ' + d.base.upperTri + d.base.lowerTri + '</strong></p>');
  html.push('<p>卦辞：' + esc(d.base.judgment) + '</p>');
  html.push('<p>上卦' + d.base.upperTri + '为' + d.base.upper + '，下卦' + d.base.lowerTri + '为' + d.base.lower + '</p>');

  if (d.yao.size > 0) {
    var yaoNames = ['初','二','三','四','五','上'];
    html.push('<hr style="border:none;border-top:1px solid #d4c5a9;">');
    html.push('<h3 style="color:#8b4513;">动爻</h3>');
    d.yao.forEach(function(n) {
      html.push('<p><strong>' + yaoNames[n-1] + '爻：</strong>' + esc(d.base.lines[n-1]) + '</p>');
    });
    if (d.derived) {
      html.push('<hr style="border:none;border-top:1px solid #d4c5a9;">');
      html.push('<h3 style="color:#8b4513;">之卦</h3>');
      html.push('<p><strong>' + d.derived.name + ' ' + d.derived.upperTri + d.derived.lowerTri + '</strong></p>');
      html.push('<p>卦辞：' + esc(d.derived.judgment) + '</p>');
    }
  }

  html.push('<hr style="border:none;border-top:1px solid #d4c5a9;">');
  html.push('<h3 style="color:#8b4513;">解读</h3>');
  // 还原富文本格式
  var answerHtml = esc(d.answer);
  answerHtml = answerHtml.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  answerHtml = answerHtml.replace(/__([^_\n]+)__/g, '<u>$1</u>');
  answerHtml = answerHtml.replace(/\n\n/g, '</p><p>');
  answerHtml = answerHtml.replace(/\n/g, '<br>');
  html.push('<p>' + answerHtml + '</p>');

  html.push('<hr style="border:none;border-top:1px solid #d4c5a9;">');
  html.push('<p style="text-align:center;color:#8b4513;font-size:0.85rem;">—— 伏羲三维义理解卦心法 · 公众号：解忧徐会长</p>');
  html.push('</div>');
  var htmlText = html.join('\n');

  // ---- 写入剪贴板 ----
  function done() {
    var btn = document.querySelector('.btn-copy');
    if (btn) {
      var orig = btn.textContent;
      btn.textContent = '✅ 已复制（含格式）';
      btn.classList.add('copied');
      setTimeout(function() {
        btn.textContent = orig;
        btn.classList.remove('copied');
      }, 2000);
    }
  }

  if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
    try {
      var blobHtml = new Blob([htmlText], { type: 'text/html' });
      var blobPlain = new Blob([plainText], { type: 'text/plain' });
      navigator.clipboard.write([
        new ClipboardItem({
          'text/html': blobHtml,
          'text/plain': blobPlain
        })
      ]).then(done).catch(function() { fallbackCopy(plainText); done(); });
    } catch(e) { fallbackCopy(plainText); done(); }
  } else {
    fallbackCopy(plainText);
    done();
  }
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch(e) {}
  document.body.removeChild(ta);
}

init();
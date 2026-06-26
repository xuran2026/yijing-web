// Cloudflare Worker — 解忧徐会长 解卦次数 + 账户 + 订阅管理
// KV 命名空间 COUNTER
// Key 约定:
//   acct:<username>  → { passhash, salt, email, sub_expires_at, sub_plan, created_at, free_used, free_quota }
//   sess:<token>     → { username, expires_at }
//   query:<username>:<ts> → { question, baseGua, derivedGua, changingYao, response, created_at }
//   code:<code>      → { plan, days, max_uses, used, assigned_to[] }
//   u:<ip>           → { used, quota }  非登录用户的免费额度
// 部署后自定义域名指向本 Worker

var SUB_CODES = {
  'XYMONTH-A7K3': { plan: 'month', days: 30, max_uses: 10 },
  'XYYEAR-C5P8':  { plan: 'year',  days: 365, max_uses: 5 }
};

function genToken(prefix) {
  prefix = prefix || '';
  var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var t = prefix;
  for (var i = 0; i < 32; i++) t += chars[Math.floor(Math.random() * chars.length) | 0];
  return t;
}

// SHA-256 + salt 密码哈希（Web Crypto）
async function hashPassword(password, salt) {
  salt = salt || genToken('');
  var enc = new TextEncoder();
  var key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  var bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  var arr = Array.from(new Uint8Array(bits));
  return { hash: arr.map(function(b) { return ('0' + b.toString(16)).slice(-2); }).join(''), salt: salt };
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var path = url.pathname;
    var ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    var cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    function reply(data, status) {
      status = status || 200;
      var h = Object.assign({ 'Content-Type': 'application/json' }, cors);
      return new Response(JSON.stringify(data), { status: status, headers: h });
    }

    // 解析 Bearer token
    function getBearerToken() {
      var auth = request.headers.get('Authorization') || '';
      var m = auth.match(/^Bearer\s+(.+)$/i);
      return m ? m[1].trim() : '';
    }

    // 验证登录态 → { username, account }
    async function authSession() {
      var token = getBearerToken();
      if (!token) return null;
      var raw = await env.COUNTER.get('sess:' + token);
      if (!raw) return null;
      var sess = JSON.parse(raw);
      if (Date.now() > sess.expires_at) {
        await env.COUNTER.delete('sess:' + token);
        return null;
      }
      var acctRaw = await env.COUNTER.get('acct:' + sess.username);
      if (!acctRaw) return null;
      return { username: sess.username, account: JSON.parse(acctRaw), token: token };
    }

    async function loadUser(ip) {
      var raw = await env.COUNTER.get('u:' + ip);
      return raw ? JSON.parse(raw) : { used: 0, quota: 30 };
    }

    // ============== 账户 ==============

    // POST /register
    if (path === '/register' && request.method === 'POST') {
      var body = await request.json();
      var username = (body.username || '').trim().toLowerCase();
      var password = (body.password || '').trim();
      var email = (body.email || '').trim();

      if (!username || username.length < 3 || username.length > 20) return reply({ error: '用户名需3-20位' }, 400);
      if (!password || password.length < 6) return reply({ error: '密码需至少6位' }, 400);
      if (username.match(/[^a-z0-9_-]/)) return reply({ error: '用户名仅支持字母数字下划线' }, 400);

      var existing = await env.COUNTER.get('acct:' + username);
      if (existing) return reply({ error: '用户名已存在' }, 409);

      var ph = await hashPassword(password);
      var now = Date.now();
      var acct = {
        passhash: ph.hash,
        salt: ph.salt,
        email: email,
        sub_expires_at: 0,
        sub_plan: null,
        created_at: now,
        free_used: 0,
        free_quota: 30
      };
      await env.COUNTER.put('acct:' + username, JSON.stringify(acct));

      // 自动登录
      var token = genToken('sess_');
      await env.COUNTER.put('sess:' + token, JSON.stringify({ username: username, expires_at: now + 30 * 24 * 60 * 60 * 1000 }));
      return reply({ token: token, username: username, sub_expires_at: 0, free_left: 30 });
    }

    // POST /login
    if (path === '/login' && request.method === 'POST') {
      var body = await request.json();
      var username = (body.username || '').trim().toLowerCase();
      var password = (body.password || '').trim();

      var raw = await env.COUNTER.get('acct:' + username);
      if (!raw) return reply({ error: '用户名或密码错误' }, 401);
      var acct = JSON.parse(raw);
      var ph = await hashPassword(password, acct.salt);
      if (ph.hash !== acct.passhash) return reply({ error: '用户名或密码错误' }, 401);

      var now = Date.now();
      var token = genToken('sess_');
      await env.COUNTER.put('sess:' + token, JSON.stringify({ username: username, expires_at: now + 30 * 24 * 60 * 60 * 1000 }));

      return reply({
        token: token,
        username: username,
        sub_expires_at: acct.sub_expires_at || 0,
        sub_plan: acct.sub_plan || null,
        free_used: acct.free_used || 0,
        free_quota: acct.free_quota || 30,
        free_left: Math.max(0, (acct.free_quota || 30) - (acct.free_used || 0))
      });
    }

    // POST /logout
    if (path === '/logout' && request.method === 'POST') {
      var token = getBearerToken();
      if (token) await env.COUNTER.delete('sess:' + token);
      return reply({ ok: true });
    }

    // ============== 状态 & 次数 ==============

    // GET /state —— 获取当前状态（优先登录态）
    if (path === '/state' && request.method === 'GET') {
      var auth = await authSession();
      if (auth) {
        return reply({
          logged_in: true,
          username: auth.username,
          sub_expires_at: auth.account.sub_expires_at || 0,
          sub_plan: auth.account.sub_plan || null,
          free_used: auth.account.free_used || 0,
          free_quota: auth.account.free_quota || 30,
          free_left: Math.max(0, (auth.account.free_quota || 30) - (auth.account.free_used || 0))
        });
      }
      var s = await loadUser(ip);
      s.left = Math.max(0, s.quota - s.used);
      s.logged_in = false;
      return reply(s);
    }

    // POST /hit —— 记录一次解卦
    if (path === '/hit' && request.method === 'POST') {
      var body = {};
      try { body = await request.json(); } catch(e) {}

      var auth = await authSession();

      if (auth) {
        // 检查是否订阅中
        var subbed = auth.account.sub_expires_at && auth.account.sub_expires_at > Date.now();
        if (subbed) {
          return reply({
            username: auth.username,
            allowed: true,
            subscription: { plan: auth.account.sub_plan, expires_at: auth.account.sub_expires_at },
            free_left: -1
          });
        }

        // 免费用户：扣登录账户的免费额度
        auth.account.free_used = (auth.account.free_used || 0) + 1;
        auth.account.free_quota = auth.account.free_quota || 30;
        var left = Math.max(0, auth.account.free_quota - auth.account.free_used);
        var allowed = auth.account.free_used <= auth.account.free_quota;
        await env.COUNTER.put('acct:' + auth.username, JSON.stringify(auth.account));
        return reply({
          username: auth.username,
          used: auth.account.free_used,
          quota: auth.account.free_quota,
          free_left: left,
          allowed: allowed
        });
      }

      // 未登录：IP-based
      var s = await loadUser(ip);
      var allowed = s.used < s.quota;
      s.used++;
      s.left = Math.max(0, s.quota - s.used);
      await env.COUNTER.put('u:' + ip, JSON.stringify(s));
      return reply({ used: s.used, quota: s.quota, left: s.left, allowed: allowed });
    }

    // ============== 查询记录 ==============

    // GET /queries —— 获取查询历史（需登录）
    if (path === '/queries' && request.method === 'GET') {
      var auth = await authSession();
      if (!auth) return reply({ error: '请先登录' }, 401);

      // 检查订阅：订阅中才能查看历史
      var subbed = auth.account.sub_expires_at && auth.account.sub_expires_at > Date.now();
      if (!subbed) return reply({ error: '订阅用户才能查看查询记录' }, 403);

      var cursor = url.searchParams.get('cursor') || '';
      var limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
      var prefix = 'query:' + auth.username + ':';

      var opts = { prefix: prefix, limit: limit };
      if (cursor) opts.cursor = cursor;
      var list = await env.COUNTER.list(opts);

      var items = [];
      for (var i = 0; i < list.keys.length; i++) {
        var key = list.keys[i].name;
        var raw = await env.COUNTER.get(key);
        if (raw) {
          var q = JSON.parse(raw);
          q.id = key.split(':').pop();
          // 不返回完整回复（太大了），用摘要
          var resp = q.response || '';
          q.summary = resp.substring(0, 120);
          delete q.response;
          items.push(q);
        }
      }

      return reply({ items: items, cursor: list.cursor, list_complete: list.list_complete });
    }

    // GET /query/:id —— 获取单条查询详情（需登录）  
    if (path.match(/^\/query\/(.+)/) && request.method === 'GET') {
      var auth = await authSession();
      if (!auth) return reply({ error: '请先登录' }, 401);
      var subbed = auth.account.sub_expires_at && auth.account.sub_expires_at > Date.now();
      if (!subbed) return reply({ error: '订阅用户才能查看记录' }, 403);

      var id = path.match(/^\/query\/(.+)/)[1];
      var raw = await env.COUNTER.get('query:' + auth.username + ':' + id);
      if (!raw) return reply({ error: '记录不存在' }, 404);
      return reply(JSON.parse(raw));
    }

    // POST /save-query —— 保存查询结果（需登录）
    if (path === '/save-query' && request.method === 'POST') {
      var auth = await authSession();
      if (!auth) return reply({ error: '请先登录' }, 401);

      var body = await request.json();
      var ts = Date.now().toString();
      var record = {
        question: body.question || '',
        baseGua: body.baseGua || '',
        derivedGua: body.derivedGua || '',
        changingYao: body.changingYao || '',
        response: body.response || '',
        created_at: ts
      };
      await env.COUNTER.put('query:' + auth.username + ':' + ts, JSON.stringify(record));
      return reply({ id: ts, ok: true });
    }

    // ============== 订阅激活 & 恢复 ==============

    // POST /activate —— 激活兑换码（需登录）
    if (path === '/activate' && request.method === 'POST') {
      var auth = await authSession();
      if (!auth) return reply({ error: '请先登录再激活订阅' }, 401);

      var body = await request.json();
      var code = (body.code || '').trim();
      var cfg = SUB_CODES[code];
      if (!cfg) return reply({ error: '无效兑换码' }, 400);

      var codeKey = 'code:' + code;
      var raw = await env.COUNTER.get(codeKey);
      var codeData = raw ? JSON.parse(raw) : { used: 0, assigned_to: [] };
      if (codeData.max_uses === undefined) codeData.max_uses = cfg.max_uses;

      if (codeData.used >= codeData.max_uses) {
        return reply({ error: '此兑换码已用完' }, 400);
      }

      // 检查该用户是否已用此码激活过
      if (codeData.assigned_to.indexOf(auth.username) !== -1) {
        return reply({ error: '你已经使用过此兑换码' }, 400);
      }

      codeData.used++;
      codeData.assigned_to.push(auth.username);
      await env.COUNTER.put(codeKey, JSON.stringify(codeData));

      // 给账户加订阅
      var now = Date.now();
      var existingExpiry = auth.account.sub_expires_at || 0;
      // 如果已有有效订阅，叠加；否则从现在开始
      var startFrom = existingExpiry > now ? existingExpiry : now;
      var newExpiry = startFrom + cfg.days * 24 * 60 * 60 * 1000;
      auth.account.sub_expires_at = newExpiry;
      auth.account.sub_plan = cfg.plan;
      await env.COUNTER.put('acct:' + auth.username, JSON.stringify(auth.account));

      return reply({
        plan: cfg.plan,
        expires_at: newExpiry,
        days: cfg.days,
        message: (cfg.plan === 'year' ? '年卡' : '月卡') + '已激活'
      });
    }

    // ============== 管理 ==============

    function checkAdmin() {
      var mk = (request.headers.get('X-Admin-Key') || '').trim();
      return mk && mk === (env.ADMIN_KEY || '');
    }

    // GET /admin/users —— 列出所有用户
    if (path === '/admin/users' && request.method === 'GET') {
      if (!checkAdmin()) return reply({ error: '无权限' }, 403);

      var cursor = url.searchParams.get('cursor') || '';
      var limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 200);
      var opts = { prefix: 'acct:', limit: limit };
      if (cursor) opts.cursor = cursor;

      var list = await env.COUNTER.list(opts);
      var users = [];
      for (var i = 0; i < list.keys.length; i++) {
        var raw = await env.COUNTER.get(list.keys[i].name);
        if (raw) {
          var acct = JSON.parse(raw);
          var isSub = acct.sub_expires_at && acct.sub_expires_at > Date.now();
          users.push({
            username: list.keys[i].name.replace('acct:', ''),
            email: acct.email || '',
            sub_expires_at: acct.sub_expires_at || 0,
            sub_plan: acct.sub_plan || null,
            subscribed: isSub,
            created_at: acct.created_at || 0,
            free_used: acct.free_used || 0,
            free_quota: acct.free_quota || 30
          });
        }
      }
      return reply({ users: users, cursor: list.cursor, list_complete: list.list_complete });
    }

    // GET /admin/codes —— 列出所有兑换码
    if (path === '/admin/codes' && request.method === 'GET') {
      if (!checkAdmin()) return reply({ error: '无权限' }, 403);

      var list = await env.COUNTER.list({ prefix: 'code:', limit: 200 });
      var codes = [];
      for (var i = 0; i < list.keys.length; i++) {
        var raw = await env.COUNTER.get(list.keys[i].name);
        if (raw) {
          var cd = JSON.parse(raw);
          codes.push({
            code: list.keys[i].name.replace('code:', ''),
            plan: cd.plan,
            days: cd.days,
            max_uses: cd.max_uses || 1,
            used: cd.used || 0,
            assigned_to: cd.assigned_to || []
          });
        }
      }
      return reply({ codes: codes });
    }

    // GET /admin/user/:username —— 查看单个用户详情
    if (path.match(/^\/admin\/user\/(.+)/) && request.method === 'GET') {
      if (!checkAdmin()) return reply({ error: '无权限' }, 403);
      var uname = path.match(/^\/admin\/user\/(.+)/)[1];
      var raw = await env.COUNTER.get('acct:' + uname);
      if (!raw) return reply({ error: '用户不存在' }, 404);
      var acct = JSON.parse(raw);

      var queries = [];
      var qlist = await env.COUNTER.list({ prefix: 'query:' + uname + ':', limit: 50 });
      for (var i = 0; i < qlist.keys.length; i++) {
        var qr = await env.COUNTER.get(qlist.keys[i].name);
        if (qr) {
          var q = JSON.parse(qr);
          q.id = qlist.keys[i].name.split(':').pop();
          queries.push({ id: q.id, question: q.question, baseGua: q.baseGua, derivedGua: q.derivedGua, created_at: q.created_at });
        }
      }

      return reply({
        username: uname,
        email: acct.email || '',
        sub_expires_at: acct.sub_expires_at || 0,
        sub_plan: acct.sub_plan || null,
        subscribed: acct.sub_expires_at && acct.sub_expires_at > Date.now(),
        created_at: acct.created_at || 0,
        free_used: acct.free_used || 0,
        free_quota: acct.free_quota || 30,
        queries: queries
      });
    }

    // POST /admin/gen-code —— 生成兑换码（需管理密钥）
    if (path === '/admin/gen-code' && request.method === 'POST') {
      if (!checkAdmin()) return reply({ error: '无权限' }, 403);

      var body = await request.json();
      var plan = body.plan || 'month';
      var days = body.days || (plan === 'year' ? 365 : 30);
      var max_uses = body.max_uses || 1;
      var prefix = body.prefix || (plan === 'year' ? 'XYYEAR-' : 'XYMONTH-');
      var count = body.count || 1;

      var codes = [];
      for (var i = 0; i < count; i++) {
        var c = prefix + genToken('').substring(0, 8).toUpperCase();
        var cfg = { plan: plan, days: days, max_uses: max_uses };
        SUB_CODES[c] = cfg;
        await env.COUNTER.put('code:' + c, JSON.stringify({ plan: plan, days: days, max_uses: max_uses, used: 0, assigned_to: [] }));
        codes.push(c);
      }

      return reply({ codes: codes });
    }

    // POST /admin/grant —— 手动给账户加订阅
    if (path === '/admin/grant' && request.method === 'POST') {
      if (!checkAdmin()) return reply({ error: '无权限' }, 403);

      var body = await request.json();
      var username = (body.username || '').trim().toLowerCase();
      var days = body.days || 30;
      var plan = body.plan || 'month';

      var raw = await env.COUNTER.get('acct:' + username);
      if (!raw) return reply({ error: '用户不存在' }, 404);
      var acct = JSON.parse(raw);
      var now = Date.now();
      var startFrom = (acct.sub_expires_at && acct.sub_expires_at > now) ? acct.sub_expires_at : now;
      acct.sub_expires_at = startFrom + days * 24 * 60 * 60 * 1000;
      acct.sub_plan = plan;
      await env.COUNTER.put('acct:' + username, JSON.stringify(acct));
      return reply({ username: username, expires_at: acct.sub_expires_at, plan: plan });
    }

    return new Response('Not Found', { status: 404, headers: cors });
  }
};

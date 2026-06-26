// 内容审核：检查用户问题是否触发红线
// 返回空字符串表示通过；返回非空字符串是给用户的拒绝回复
function checkContent(text) {
  if (!text) return '';
  var t = text;

  // 红线一：违法暴力
  if (/杀人|伤人|害人|谋杀|虐待|暴力.*伤害/.test(t)) return '卦象是帮助人看清自己、修正自己，不是帮人伤害他人的。这个方向不能解。如果你愿意换个角度——看看自己在这件事里的位置和心态——卦可以帮你。';
  if (/制造.*(炸弹|武器|毒药|毒品)|贩毒|制毒/.test(t)) return '这个方向卦不能解。易为君子谋——卦不是工具，是镜子。如果你愿意照照自己现在的处境和心态，卦可以帮你。';

  // 红线二：政治颠覆
  if (/推翻.*(政权|政府)|颠覆.*国家|分裂.*国家|颜色革命|武装.*起义|政变/.test(t)) return '涉及政权和政治体制的问题，卦不能解。卦是帮人看清个人处境的，不是参与政治的工具。';

  // 红线三：仇恨煽动
  if (/种族.*(灭绝|清洗|歧视)|纳粹|法西斯|哪个民族/.test(t)) return '卦不分民族、不辨种族，只看人心。煽动对立和仇恨的问题，不在解卦范围内。';

  return '';
}

// Cloudflare Worker — AI 代理（测试版）
// 作用：前端发 /chat 请求到此 Worker，Worker 带上 API Key 转发到 AI 后端
// 好处：API Key 只存在 Cloudflare 环境变量里，前端源码永不暴露
//
// 部署步骤：
//   1. cd yijing-split/worker-proxy
//   2. wrangler secret put AI_API_KEY  → 填入你的 agnes-ai API Key（不带 Bearer 前缀）
//   3. wrangler deploy
//   4. 记录 Worker URL，填入 app.js 的 CHAT_PROXY 变量

export default {
  async fetch(request, env) {
    var cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    var url = new URL(request.url);

    // POST /chat → 转发到 AI API
    if (url.pathname === '/chat' && request.method === 'POST') {
      if (!env.AI_API_KEY) {
        return new Response(JSON.stringify({ error: 'AI_API_KEY 未配置' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      }

      var body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: '请求格式错误' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      }

      // 内容审核：在调用 AI 之前拦截明显违规的问题
      var question = (body.messages || []).filter(function(m) { return m.role === 'user'; }).map(function(m) { return m.content; }).join(' ');
      var blocked = checkContent(question);
      if (blocked) {
        return new Response(JSON.stringify({
          choices: [{
            message: { role: 'assistant', content: blocked }
          }]
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      }

      try {

        var aiResp = await fetch('https://apihub.agnes-ai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + env.AI_API_KEY
          },
          body: JSON.stringify(body)
        });

        var data = await aiResp.json();

        return new Response(JSON.stringify(data), {
          status: aiResp.status,
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: '代理请求失败: ' + e.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...cors }
        });
      }
    }

    // 健康检查
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, hasKey: !!env.AI_API_KEY }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...cors }
      });
    }

    return new Response('Not Found', { status: 404, headers: cors });
  }
};

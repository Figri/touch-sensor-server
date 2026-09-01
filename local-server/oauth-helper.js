/*
 * OAuth Helper — 最小化 OAuth 2.1 Provider
 *
 * Claude 自定义连接器强制走 OAuth 流程，即使服务器不需要认证。
 * 这个模块提供一个"自动批准"的 OAuth，让 Claude 能连上。
 *
 * 端点：
 *   GET  /.well-known/oauth-authorization-server  — OAuth 元数据
 *   GET  /.well-known/oauth-protected-resource    — 资源元数据
 *   POST /oauth/register                           — 动态客户端注册
 *   GET  /oauth/authorize                          — 授权页面（自动批准）
 *   POST /oauth/token                              — 令牌端点
 */

const crypto = require('crypto');

// 自动批准页面
function getAutoApprovePage(redirectUri, state, client_id) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>授权</title>
<style>
body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f2f5}
.card{background:#fff;border-radius:12px;padding:32px;max-width:380px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.icon{font-size:48px;margin-bottom:16px}
h2{font-size:18px;margin-bottom:8px;color:#1a1a1a}
p{font-size:14px;color:#888;margin-bottom:24px;line-height:1.5}
.btn{display:inline-block;padding:12px 32px;background:#4f8cff;color:#fff;border:none;border-radius:8px;font-size:15px;text-decoration:none;cursor:pointer}
</style>
</head>
<body>
<div class="card">
  <div class="icon">🤗</div>
  <h2>touchDoll 授权</h2>
  <p>Claude 正在请求访问触摸玩偶数据，点击下方按钮授权。</p>
  <a href="#" id="approve" class="btn">授权连接</a>
</div>
<script>
document.getElementById('approve').addEventListener('click', function(e){
  e.preventDefault();
  var params = new URLSearchParams(window.location.search);
  var redirectUri = params.get('redirect_uri');
  var state = params.get('state');
  var code = 'auto_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
  var url = redirectUri + '?code=' + encodeURIComponent(code) + '&state=' + encodeURIComponent(state || '');
  window.location.href = url;
});
</script>
</body>
</html>`;
}

function handleOAuth(req, res, parsedUrl, body) {
  const host = req.headers.host || 'localhost:3000';
  const baseUrl = `https://${host}`;

  // GET /.well-known/oauth-authorization-server
  if (req.method === 'GET' && parsedUrl.pathname === '/.well-known/oauth-authorization-server') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
    }));
    return true;
  }

  // GET /.well-known/oauth-protected-resource
  if (req.method === 'GET' && parsedUrl.pathname === '/.well-known/oauth-protected-resource') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      resource: baseUrl,
      authorization_servers: [baseUrl],
    }));
    return true;
  }

  // POST /oauth/register — 动态客户端注册
  if (req.method === 'POST' && parsedUrl.pathname === '/oauth/register') {
    const clientId = 'touchdoll_' + crypto.randomBytes(8).toString('hex');
    const clientSecret = 'secret_' + crypto.randomBytes(16).toString('hex');
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }));
    return true;
  }

  // GET /oauth/authorize — 授权页面（自动批准）
  if (req.method === 'GET' && parsedUrl.pathname === '/oauth/authorize') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getAutoApprovePage());
    return true;
  }

  // POST /oauth/token — 令牌端点
  if (req.method === 'POST' && parsedUrl.pathname === '/oauth/token') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      access_token: 'touchdoll_access_' + crypto.randomBytes(16).toString('hex'),
      token_type: 'Bearer',
      expires_in: 86400,
      refresh_token: 'touchdoll_refresh_' + crypto.randomBytes(16).toString('hex'),
    }));
    return true;
  }

  return false;
}

module.exports = { handleOAuth };

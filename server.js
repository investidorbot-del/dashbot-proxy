// ─────────────────────────────────────────────────────────────────
//  Dashbot Proxy + License Server
//  Deploy: https://render.com (Node.js, free tier)
// ─────────────────────────────────────────────────────────────────
const https   = require('https');
const http    = require('http');
const url     = require('url');
const crypto  = require('crypto');

// ── Configuração via variáveis de ambiente ────────────────────────
const PORT         = process.env.PORT || 3000;
const MASTER_KEY   = process.env.JSONBIN_MASTER_KEY || '';
const DATA_BIN     = process.env.JSONBIN_DATA_BIN   || '';
const CMD_BIN      = process.env.JSONBIN_CMD_BIN    || '';
const LICENSE_BIN  = process.env.JSONBIN_LICENSE_BIN|| ''; // novo bin para licenças
const PROXY_TOKEN  = process.env.DASHBOT_TOKEN      || 'dashbot2024';
const ADMIN_USER   = process.env.ADMIN_USER         || 'admin';
const ADMIN_PASS   = process.env.ADMIN_PASS         || 'admin123'; // TROQUE ISSO!
// ─────────────────────────────────────────────────────────────────

// Cache de licenças em memória (recarrega do JSONBin periodicamente)
let licenseCache = {};
let lastLicenseLoad = 0;
const LICENSE_CACHE_TTL = 60000; // 1 minuto

// ── Helpers JSONBin ───────────────────────────────────────────────
function jsonbinRequest(method, binId, body, callback) {
  const options = {
    hostname: 'api.jsonbin.io', port: 443,
    path: `/v3/b/${binId}${method==='GET'?'/latest':''}`,
    method,
    headers: { 'Content-Type':'application/json', 'X-Master-Key':MASTER_KEY, 'X-Bin-Meta':'false' }
  };
  if(body) options.headers['Content-Length'] = Buffer.byteLength(body);
  const req = https.request(options, res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => callback(null, res.statusCode, data));
  });
  req.on('error', err => callback(err, -1, ''));
  if(body) req.write(body);
  req.end();
}

async function getLicenses() {
  return new Promise(resolve => {
    if(!LICENSE_BIN){ resolve({}); return; }
    const now = Date.now();
    if(now - lastLicenseLoad < LICENSE_CACHE_TTL){ resolve(licenseCache); return; }
    jsonbinRequest('GET', LICENSE_BIN, null, (err, code, data) => {
      if(err || code !== 200){ resolve(licenseCache); return; }
      try {
        const parsed = JSON.parse(data);
        licenseCache = parsed.licenses || {};
        lastLicenseLoad = now;
        resolve(licenseCache);
      } catch(e){ resolve(licenseCache); }
    });
  });
}

async function saveLicenses(licenses) {
  return new Promise(resolve => {
    if(!LICENSE_BIN){ resolve(false); return; }
    const body = JSON.stringify({ licenses });
    jsonbinRequest('PUT', LICENSE_BIN, body, (err, code) => {
      licenseCache = licenses;
      lastLicenseLoad = Date.now();
      resolve(code === 200);
    });
  });
}

// ── Helpers HTTP ──────────────────────────────────────────────────
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type':'application/json',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type,Authorization,X-Dashbot-Token',
  });
  res.end(body);
}

function sendHTML(res, html) {
  res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' });
  res.end(html);
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
  });
}

function checkAdminAuth(req) {
  const auth = req.headers['authorization'] || '';
  if(!auth.startsWith('Basic ')) return false;
  const decoded = Buffer.from(auth.slice(6), 'base64').toString();
  const [user, pass] = decoded.split(':');
  return user === ADMIN_USER && pass === ADMIN_PASS;
}

// ── Verificação de licença ────────────────────────────────────────
async function checkLicense(mt5Account) {
  const licenses = await getLicenses();
  const key = String(mt5Account);
  const lic = licenses[key];
  if(!lic) return { plan: 'free', valid: false };

  const now = Date.now();
  if(lic.expiresAt && now > lic.expiresAt) {
    return { plan: 'free', valid: false, expired: true };
  }
  return { plan: lic.plan || 'premium', valid: true,
           expiresAt: lic.expiresAt, name: lic.name || '' };
}

// ── Servidor Principal ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;

  if(method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type,Authorization,X-Dashbot-Token',
    });
    res.end(); return;
  }

  // ── Health check ──────────────────────────────────────────────
  if(path === '/' || path === '/health') {
    sendJSON(res, 200, { status:'ok', service:'Dashbot Server', ts:Date.now() });
    return;
  }

  // ── Valida licença por conta MT5 (chamado pelo Dashbot no init) ─
  // GET /validate?account=12345678&token=xxx
  if(path === '/validate' && method === 'GET') {
    const token = parsed.query.token || '';
    if(PROXY_TOKEN && token !== PROXY_TOKEN) { sendJSON(res,401,{error:'Token invalido'}); return; }
    const account = parsed.query.account || '';
    if(!account) { sendJSON(res,400,{error:'account obrigatorio'}); return; }
    const result = await checkLicense(account);
    sendJSON(res, 200, result);
    return;
  }

  // ── Proxy dados MT5 → JSONBin ────────────────────────────────
  const token = parsed.query.token || req.headers['x-dashbot-token'] || '';
  if(PROXY_TOKEN && token !== PROXY_TOKEN && !path.startsWith('/admin')) {
    sendJSON(res, 401, { error:'Token invalido' }); return;
  }

  if(path === '/update' && method === 'POST') {
    const body = await readBody(req);
    if(!DATA_BIN){ sendJSON(res,500,{error:'DATA_BIN nao configurado'}); return; }
    jsonbinRequest('PUT', DATA_BIN, body, (err, code) => {
      if(err||code!==200) sendJSON(res,502,{error:'JSONBin erro',code});
      else sendJSON(res,200,{ok:true});
    });
    return;
  }

  if(path === '/data' && method === 'GET') {
    if(!DATA_BIN){ sendJSON(res,500,{error:'DATA_BIN nao configurado'}); return; }
    jsonbinRequest('GET', DATA_BIN, null, (err, code, data) => {
      if(err||code!==200) sendJSON(res,502,{error:'JSONBin erro',code});
      else { try{ sendJSON(res,200,JSON.parse(data)); }catch(e){ sendJSON(res,502,{error:'JSON invalido'}); } }
    });
    return;
  }

  if(path === '/command' && method === 'POST') {
    const body = await readBody(req);
    if(!CMD_BIN){ sendJSON(res,500,{error:'CMD_BIN nao configurado'}); return; }
    let pb; try{ pb=JSON.parse(body); }catch(e){ sendJSON(res,400,{error:'JSON invalido'}); return; }
    const validCmds=['ligar','desligar','pausar','retomar','fechar',''];
    if(!validCmds.includes(pb.cmd||'')){ sendJSON(res,400,{error:'Comando invalido'}); return; }
    jsonbinRequest('PUT', CMD_BIN, body, (err, code) => {
      if(err||code!==200) sendJSON(res,502,{error:'JSONBin erro',code});
      else sendJSON(res,200,{ok:true,cmd:pb.cmd});
    });
    return;
  }

  if(path === '/command' && method === 'GET') {
    if(!CMD_BIN){ sendJSON(res,500,{error:'CMD_BIN nao configurado'}); return; }
    jsonbinRequest('GET', CMD_BIN, null, (err, code, data) => {
      if(err||code!==200) sendJSON(res,502,{error:'JSONBin erro',code});
      else { try{ sendJSON(res,200,JSON.parse(data)); }catch(e){ sendJSON(res,502,{error:'JSON invalido'}); } }
    });
    return;
  }

  // ════════════════════════════════════════════════════════════════
  //  PAINEL ADMIN
  // ════════════════════════════════════════════════════════════════

  // Login admin
  if(path === '/admin' || path === '/admin/') {
    if(!checkAdminAuth(req)) {
      res.writeHead(401, { 'WWW-Authenticate':'Basic realm="Dashbot Admin"', 'Content-Type':'text/plain' });
      res.end('Acesso negado'); return;
    }
    const licenses = await getLicenses();
    sendHTML(res, buildAdminHTML(licenses));
    return;
  }

  // API admin — adicionar/renovar licença
  if(path === '/admin/license' && method === 'POST') {
    if(!checkAdminAuth(req)) { sendJSON(res,401,{error:'Nao autorizado'}); return; }
    const body = await readBody(req);
    let data; try{ data=JSON.parse(body); }catch(e){ sendJSON(res,400,{error:'JSON invalido'}); return; }
    const { account, name, months } = data;
    if(!account||!months){ sendJSON(res,400,{error:'account e months obrigatorios'}); return; }

    const licenses = await getLicenses();
    const key = String(account);
    const existing = licenses[key];
    const now = Date.now();

    // Se já tem licença ativa, renova a partir do vencimento; senão, conta do agora
    const baseDate = (existing && existing.expiresAt && existing.expiresAt > now)
                     ? existing.expiresAt : now;
    const expiresAt = baseDate + (parseInt(months) * 30 * 24 * 60 * 60 * 1000);

    licenses[key] = {
      account: key, name: name || '', plan: 'premium',
      expiresAt, activatedAt: existing ? existing.activatedAt : now,
      renewedAt: now, months: parseInt(months)
    };

    const ok = await saveLicenses(licenses);
    sendJSON(res, ok?200:500, { ok, account:key, expiresAt,
      expiresStr: new Date(expiresAt).toLocaleDateString('pt-BR') });
    return;
  }

  // API admin — revogar licença
  if(path === '/admin/license' && method === 'DELETE') {
    if(!checkAdminAuth(req)) { sendJSON(res,401,{error:'Nao autorizado'}); return; }
    const body = await readBody(req);
    let data; try{ data=JSON.parse(body); }catch(e){ sendJSON(res,400,{error:'JSON invalido'}); return; }
    const { account } = data;
    if(!account){ sendJSON(res,400,{error:'account obrigatorio'}); return; }

    const licenses = await getLicenses();
    const key = String(account);
    if(!licenses[key]){ sendJSON(res,404,{error:'Licenca nao encontrada'}); return; }
    delete licenses[key];
    const ok = await saveLicenses(licenses);
    sendJSON(res, ok?200:500, { ok, account:key, removed:true });
    return;
  }

  // API admin — listar licenças (JSON)
  if(path === '/admin/licenses' && method === 'GET') {
    if(!checkAdminAuth(req)) { sendJSON(res,401,{error:'Nao autorizado'}); return; }
    const licenses = await getLicenses();
    sendJSON(res, 200, { licenses, total: Object.keys(licenses).length });
    return;
  }

  sendJSON(res, 404, { error:'Rota nao encontrada' });
});

// ── HTML do Painel Admin ──────────────────────────────────────────
function buildAdminHTML(licenses) {
  const now = Date.now();
  const rows = Object.values(licenses).map(l => {
    const exp = new Date(l.expiresAt);
    const active = l.expiresAt > now;
    const daysLeft = Math.ceil((l.expiresAt - now) / 86400000);
    return `<tr>
      <td><strong>${l.account}</strong></td>
      <td>${l.name||'—'}</td>
      <td><span class="badge ${active?'ok':'exp'}">${active?'ATIVO':'EXPIRADO'}</span></td>
      <td>${exp.toLocaleDateString('pt-BR')}</td>
      <td style="color:${active&&daysLeft<=7?'#f59e0b':active?'#10b981':'#ef4444'}">${active?daysLeft+' dias':'—'}</td>
      <td>
        <button onclick="renovar('${l.account}','${l.name||''}',1)" class="btn-sm renew">+1 mês</button>
        <button onclick="renovar('${l.account}','${l.name||''}',3)" class="btn-sm renew">+3 meses</button>
        <button onclick="revogar('${l.account}')" class="btn-sm del">Revogar</button>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashbot — Painel Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0c14;color:#e2e8f0;font-family:system-ui,sans-serif;min-height:100vh}
.header{background:#0f1220;border-bottom:1px solid #1e2438;padding:16px 24px;display:flex;align-items:center;justify-content:space-between}
.logo{font-size:20px;font-weight:800}.logo span{color:#3b82f6}
.main{padding:24px;max-width:1100px;margin:0 auto}
h2{font-size:18px;font-weight:700;margin-bottom:16px;color:#f1f5f9}
.card{background:#0f1220;border:1px solid #1e2438;border-radius:12px;padding:20px;margin-bottom:20px}
.form-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.form-group{display:flex;flex-direction:column;gap:4px}
label{font-size:12px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
input,select{background:#1a1f35;border:1px solid #1e2438;border-radius:8px;color:#e2e8f0;padding:8px 12px;font-size:14px;outline:none;min-width:140px}
input:focus,select:focus{border-color:#3b82f6}
.btn{background:#1e3a8a;border:1px solid #3b82f6;color:#3b82f6;border-radius:8px;padding:9px 18px;font-size:13px;font-weight:700;cursor:pointer;transition:all .2s}
.btn:hover{background:#3b82f6;color:#fff}
.btn-sm{border-radius:6px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;border:1px solid;transition:all .2s}
.renew{background:#064e3b;color:#10b981;border-color:#10b981}.renew:hover{background:#10b981;color:#000}
.del{background:#450a0a;color:#ef4444;border-color:#ef4444}.del:hover{background:#ef4444;color:#fff}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#64748b;padding:8px 12px;border-bottom:1px solid #1e2438}
td{padding:10px 12px;border-bottom:1px solid #0f1220;font-size:13px}
tr:hover td{background:#0d1024}
.badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;letter-spacing:.05em}
.badge.ok{background:#064e3b;color:#10b981;border:1px solid #10b981}
.badge.exp{background:#450a0a;color:#ef4444;border:1px solid #ef4444}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px}
.stat{background:#0f1220;border:1px solid #1e2438;border-radius:10px;padding:16px;text-align:center}
.stat-val{font-size:28px;font-weight:800;color:#3b82f6}
.stat-lbl{font-size:11px;color:#64748b;margin-top:4px;text-transform:uppercase;letter-spacing:.06em}
.msg{padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:12px;display:none}
.msg.ok{background:#064e3b;color:#10b981;border:1px solid #10b981}
.msg.err{background:#450a0a;color:#ef4444;border:1px solid #ef4444}
@media(max-width:600px){.form-row{flex-direction:column}.stat-val{font-size:22px}}
</style>
</head>
<body>
<div class="header">
  <div class="logo">Dash<span>bot</span> — Admin</div>
  <span style="font-size:12px;color:#475569">InvestidorBot</span>
</div>
<div class="main">

  <!-- Stats -->
  <div class="stats">
    <div class="stat">
      <div class="stat-val">${Object.keys(licenses).length}</div>
      <div class="stat-lbl">Total de Licenças</div>
    </div>
    <div class="stat">
      <div class="stat-val" style="color:#10b981">${Object.values(licenses).filter(l=>l.expiresAt>now).length}</div>
      <div class="stat-lbl">Ativas</div>
    </div>
    <div class="stat">
      <div class="stat-val" style="color:#ef4444">${Object.values(licenses).filter(l=>l.expiresAt<=now).length}</div>
      <div class="stat-lbl">Expiradas</div>
    </div>
    <div class="stat">
      <div class="stat-val" style="color:#f59e0b">${Object.values(licenses).filter(l=>l.expiresAt>now&&(l.expiresAt-now)<7*86400000).length}</div>
      <div class="stat-lbl">Vencem em 7 dias</div>
    </div>
  </div>

  <!-- Adicionar licença -->
  <div class="card">
    <h2>Adicionar / Renovar Licença</h2>
    <div id="msg" class="msg"></div>
    <div class="form-row" style="margin-top:12px">
      <div class="form-group">
        <label>Conta MT5</label>
        <input type="number" id="account" placeholder="Ex: 12345678">
      </div>
      <div class="form-group">
        <label>Nome do cliente</label>
        <input type="text" id="name" placeholder="João Silva">
      </div>
      <div class="form-group">
        <label>Meses</label>
        <select id="months">
          <option value="1">1 mês</option>
          <option value="3">3 meses</option>
          <option value="6">6 meses</option>
          <option value="12">12 meses</option>
        </select>
      </div>
      <button class="btn" onclick="ativar()">Ativar Premium</button>
    </div>
  </div>

  <!-- Tabela de licenças -->
  <div class="card">
    <h2>Licenças Cadastradas</h2>
    ${Object.keys(licenses).length === 0
      ? '<p style="color:#64748b;font-size:14px;padding:20px 0">Nenhuma licença cadastrada ainda.</p>'
      : `<table>
          <thead><tr>
            <th>Conta MT5</th><th>Nome</th><th>Status</th>
            <th>Vence em</th><th>Dias restantes</th><th>Ações</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`
    }
  </div>

</div>
<script>
const base = window.location.origin;

async function req(method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + btoa('${ADMIN_USER}:${ADMIN_PASS}')
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return r.json();
}

function showMsg(text, ok) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.className = 'msg ' + (ok?'ok':'err');
  el.style.display = 'block';
  setTimeout(() => el.style.display='none', 4000);
}

async function ativar() {
  const account = document.getElementById('account').value;
  const name    = document.getElementById('name').value;
  const months  = document.getElementById('months').value;
  if(!account){ showMsg('Informe o número da conta MT5', false); return; }
  const r = await req('POST', '/admin/license', { account, name, months: parseInt(months) });
  if(r.ok) { showMsg('Licença ativada! Vence em: ' + r.expiresStr, true); setTimeout(()=>location.reload(),1500); }
  else showMsg('Erro ao ativar: ' + (r.error||'desconhecido'), false);
}

async function renovar(account, name, months) {
  const r = await req('POST', '/admin/license', { account, name, months });
  if(r.ok) { showMsg('Renovado! Vence em: ' + r.expiresStr, true); setTimeout(()=>location.reload(),1500); }
  else showMsg('Erro: ' + (r.error||'desconhecido'), false);
}

async function revogar(account) {
  if(!confirm('Revogar licença da conta ' + account + '?')) return;
  const r = await req('DELETE', '/admin/license', { account });
  if(r.ok) { showMsg('Licença revogada.', true); setTimeout(()=>location.reload(),1500); }
  else showMsg('Erro: ' + (r.error||'desconhecido'), false);
}
</script>
</body>
</html>`;
}

server.listen(PORT, () => {
  console.log('Dashbot Server rodando na porta', PORT);
  console.log('Admin: /admin');
  console.log('DATA_BIN:', DATA_BIN||'(nao configurado)');
  console.log('LICENSE_BIN:', LICENSE_BIN||'(nao configurado)');
});

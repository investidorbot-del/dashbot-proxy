// ─────────────────────────────────────────────────────────────────
//  Dashbot License Server v2
//  Trial 14 dias → Premium mensal
//  Deploy: https://render.com
// ─────────────────────────────────────────────────────────────────
const https  = require('https');
const http   = require('http');
const url    = require('url');

const PORT        = process.env.PORT               || 3000;
const MASTER_KEY  = process.env.JSONBIN_MASTER_KEY || '';
const DATA_BIN    = process.env.JSONBIN_DATA_BIN   || '';
const CMD_BIN     = process.env.JSONBIN_CMD_BIN    || '';
const LICENSE_BIN = process.env.JSONBIN_LICENSE_BIN|| '';
const PROXY_TOKEN = process.env.DASHBOT_TOKEN      || 'dashbot2024';
const ADMIN_USER  = process.env.ADMIN_USER         || 'admin';
const ADMIN_PASS  = process.env.ADMIN_PASS         || 'admin123';

const TRIAL_DAYS  = 14;
const DAY_MS      = 86400000;

// ── Cache licenças ────────────────────────────────────────────────
let licenseCache = {};
let lastLoad = 0;
const CACHE_TTL = 30000; // 30s

function jsonbinRequest(method, binId, body, cb) {
  const opts = {
    hostname: 'api.jsonbin.io', port: 443,
    path: `/v3/b/${binId}${method==='GET'?'/latest':''}`,
    method,
    headers: {
      'Content-Type':'application/json',
      'X-Master-Key': MASTER_KEY,
      'X-Bin-Meta':   'false'
    }
  };
  if(body) opts.headers['Content-Length'] = Buffer.byteLength(body);
  const req = https.request(opts, res => {
    let d=''; res.on('data',c=>d+=c); res.on('end',()=>cb(null,res.statusCode,d));
  });
  req.on('error', err => cb(err,-1,''));
  if(body) req.write(body);
  req.end();
}

async function getLicenses() {
  return new Promise(resolve => {
    if(!LICENSE_BIN){ resolve({}); return; }
    const now = Date.now();
    if(now-lastLoad < CACHE_TTL){ resolve(licenseCache); return; }
    jsonbinRequest('GET', LICENSE_BIN, null, (err,code,data) => {
      if(err||code!==200){ resolve(licenseCache); return; }
      try{
        const p = JSON.parse(data);
        licenseCache = p.licenses||{};
        lastLoad = now;
        resolve(licenseCache);
      } catch(e){ resolve(licenseCache); }
    });
  });
}

async function saveLicenses(licenses) {
  return new Promise(resolve => {
    if(!LICENSE_BIN){ resolve(false); return; }
    jsonbinRequest('PUT', LICENSE_BIN, JSON.stringify({licenses}), (err,code) => {
      licenseCache = licenses;
      lastLoad = Date.now();
      resolve(code===200);
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
  res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
  res.end(html);
}

function readBody(req) {
  return new Promise(resolve => {
    let b=''; req.on('data',c=>b+=c); req.on('end',()=>resolve(b));
  });
}

function checkAdminAuth(req) {
  const auth = req.headers['authorization']||'';
  if(!auth.startsWith('Basic ')) return false;
  const [u,p] = Buffer.from(auth.slice(6),'base64').toString().split(':');
  return u===ADMIN_USER && p===ADMIN_PASS;
}

function ptDate(ts) {
  return new Date(ts).toLocaleDateString('pt-BR');
}

// ── Lógica de licença ─────────────────────────────────────────────
// Tipos: 'trial' | 'premium' | 'expired'
async function validateAccount(account) {
  const licenses = await getLicenses();
  const key = String(account);
  const now = Date.now();
  let lic = licenses[key];

  // Primeira vez — cria trial automaticamente
  if(!lic) {
    lic = {
      account:     key,
      name:        '',
      type:        'trial',
      trialStart:  now,
      trialEnd:    now + TRIAL_DAYS * DAY_MS,
      premiumStart:null,
      premiumEnd:  null,
      lastSeen:    now,
      firstSeen:   now,
    };
    licenses[key] = lic;
    await saveLicenses(licenses);
    const daysLeft = TRIAL_DAYS;
    return { plan:'free', type:'trial', valid:true, daysLeft, trialEnd:lic.trialEnd };
  }

  // Atualiza lastSeen
  lic.lastSeen = now;

  // Premium ativo
  if(lic.type==='premium' && lic.premiumEnd && now < lic.premiumEnd) {
    const daysLeft = Math.ceil((lic.premiumEnd-now)/DAY_MS);
    licenses[key] = lic;
    await saveLicenses(licenses);
    return { plan:'premium', type:'premium', valid:true, daysLeft, premiumEnd:lic.premiumEnd };
  }

  // Premium expirado — NÃO volta para free, fecha
  if(lic.type==='premium' && lic.premiumEnd && now >= lic.premiumEnd) {
    lic.type = 'expired';
    licenses[key] = lic;
    await saveLicenses(licenses);
    return { plan:'none', type:'expired_premium', valid:false, daysLeft:0 };
  }

  // Trial ativo
  if(lic.type==='trial' && now < lic.trialEnd) {
    const daysLeft = Math.ceil((lic.trialEnd-now)/DAY_MS);
    licenses[key] = lic;
    await saveLicenses(licenses);
    return { plan:'free', type:'trial', valid:true, daysLeft, trialEnd:lic.trialEnd };
  }

  // Trial expirado — fecha
  if(lic.type==='trial' && now >= lic.trialEnd) {
    lic.type = 'expired';
    licenses[key] = lic;
    await saveLicenses(licenses);
    return { plan:'none', type:'expired_trial', valid:false, daysLeft:0 };
  }

  // Expirado (qualquer tipo)
  return { plan:'none', type:'expired', valid:false, daysLeft:0 };
}

// ── Servidor ──────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname.replace(/\/+$/,'')||'/';
  const method = req.method;

  if(method==='OPTIONS'){
    res.writeHead(204,{
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type,Authorization,X-Dashbot-Token',
    });
    res.end(); return;
  }

  // Health
  if(path==='/'||path==='/health'){
    sendJSON(res,200,{status:'ok',service:'Dashbot Server v2',ts:Date.now()});
    return;
  }

  // ── Validar licença ───────────────────────────────────────────
  if(path==='/validate' && method==='GET'){
    const token = parsed.query.token||'';
    if(PROXY_TOKEN && token!==PROXY_TOKEN){ sendJSON(res,401,{error:'Token invalido'}); return; }
    const account = parsed.query.account||'';
    if(!account){ sendJSON(res,400,{error:'account obrigatorio'}); return; }
    const result = await validateAccount(account);
    sendJSON(res,200,result);
    return;
  }

  // Token check para demais rotas (exceto admin)
  const token = parsed.query.token||req.headers['x-dashbot-token']||'';
  if(PROXY_TOKEN && token!==PROXY_TOKEN && !path.startsWith('/admin')){
    sendJSON(res,401,{error:'Token invalido'}); return;
  }

  // ── Dados MT5 ─────────────────────────────────────────────────
  if(path==='/update' && method==='POST'){
    const body = await readBody(req);
    if(!DATA_BIN){ sendJSON(res,500,{error:'DATA_BIN nao configurado'}); return; }
    jsonbinRequest('PUT',DATA_BIN,body,(err,code)=>{
      sendJSON(res,code===200?200:502,{ok:code===200});
    });
    return;
  }

  if(path==='/data' && method==='GET'){
    if(!DATA_BIN){ sendJSON(res,500,{error:'DATA_BIN nao configurado'}); return; }
    jsonbinRequest('GET',DATA_BIN,null,(err,code,data)=>{
      if(err||code!==200) sendJSON(res,502,{error:'JSONBin erro'});
      else { try{ sendJSON(res,200,JSON.parse(data)); }catch(e){ sendJSON(res,502,{error:'JSON invalido'}); } }
    });
    return;
  }

  if(path==='/command' && method==='POST'){
    const body = await readBody(req);
    if(!CMD_BIN){ sendJSON(res,500,{error:'CMD_BIN nao configurado'}); return; }
    let pb; try{ pb=JSON.parse(body); }catch(e){ sendJSON(res,400,{error:'JSON invalido'}); return; }
    const valid=['ligar','desligar','pausar','retomar','fechar',''];
    if(!valid.includes(pb.cmd||'')){ sendJSON(res,400,{error:'Comando invalido'}); return; }
    jsonbinRequest('PUT',CMD_BIN,body,(err,code)=>{
      sendJSON(res,code===200?200:502,{ok:code===200,cmd:pb.cmd});
    });
    return;
  }

  if(path==='/command' && method==='GET'){
    if(!CMD_BIN){ sendJSON(res,500,{error:'CMD_BIN nao configurado'}); return; }
    jsonbinRequest('GET',CMD_BIN,null,(err,code,data)=>{
      if(err||code!==200) sendJSON(res,502,{error:'JSONBin erro'});
      else { try{ sendJSON(res,200,JSON.parse(data)); }catch(e){ sendJSON(res,502,{error:'JSON invalido'}); } }
    });
    return;
  }

  // ════════════════════════════════════════════════════════════════
  //  PAINEL ADMIN
  // ════════════════════════════════════════════════════════════════
  if(path==='/admin'||path==='/admin/'){
    if(!checkAdminAuth(req)){
      res.writeHead(401,{'WWW-Authenticate':'Basic realm="Dashbot Admin"','Content-Type':'text/plain'});
      res.end('Acesso negado'); return;
    }
    const licenses = await getLicenses();
    sendHTML(res, buildAdminHTML(licenses));
    return;
  }

  // Ativar/Renovar Premium
  if(path==='/admin/license' && method==='POST'){
    if(!checkAdminAuth(req)){ sendJSON(res,401,{error:'Nao autorizado'}); return; }
    const body = await readBody(req);
    let data; try{ data=JSON.parse(body); }catch(e){ sendJSON(res,400,{error:'JSON invalido'}); return; }
    const { account, name, months } = data;
    if(!account||!months){ sendJSON(res,400,{error:'account e months obrigatorios'}); return; }

    const licenses = await getLicenses();
    const key = String(account);
    const now = Date.now();
    const existing = licenses[key];

    // Base: se já tem premium ativo renova a partir do fim; senão do agora
    const base = (existing&&existing.premiumEnd&&existing.premiumEnd>now)
                 ? existing.premiumEnd : now;
    const premiumEnd = base + parseInt(months)*30*DAY_MS;

    licenses[key] = {
      account:      key,
      name:         name||existing?.name||'',
      type:         'premium',
      trialStart:   existing?.trialStart||now,
      trialEnd:     existing?.trialEnd||(now+TRIAL_DAYS*DAY_MS),
      premiumStart: existing?.premiumStart||now,
      premiumEnd,
      lastSeen:     existing?.lastSeen||now,
      firstSeen:    existing?.firstSeen||now,
    };

    const ok = await saveLicenses(licenses);
    sendJSON(res,ok?200:500,{
      ok, account:key,
      premiumEnd, expiresStr: ptDate(premiumEnd)
    });
    return;
  }

  // Revogar
  if(path==='/admin/license' && method==='DELETE'){
    if(!checkAdminAuth(req)){ sendJSON(res,401,{error:'Nao autorizado'}); return; }
    const body = await readBody(req);
    let data; try{ data=JSON.parse(body); }catch(e){ sendJSON(res,400,{error:'JSON invalido'}); return; }
    const key = String(data.account||'');
    if(!key){ sendJSON(res,400,{error:'account obrigatorio'}); return; }
    const licenses = await getLicenses();
    if(!licenses[key]){ sendJSON(res,404,{error:'Nao encontrado'}); return; }
    delete licenses[key];
    const ok = await saveLicenses(licenses);
    sendJSON(res,ok?200:500,{ok,account:key});
    return;
  }

  sendJSON(res,404,{error:'Rota nao encontrada'});
});

// ── HTML Admin ────────────────────────────────────────────────────
function buildAdminHTML(licenses) {
  const now = Date.now();
  const all = Object.values(licenses);

  const trials   = all.filter(l=>l.type==='trial'  &&now<l.trialEnd);
  const premiums = all.filter(l=>l.type==='premium' &&l.premiumEnd&&now<l.premiumEnd);
  const expired  = all.filter(l=>l.type==='expired'||(l.type==='trial'&&now>=l.trialEnd)||(l.type==='premium'&&l.premiumEnd&&now>=l.premiumEnd));
  const recent24 = all.filter(l=>l.lastSeen&&(now-l.lastSeen)<86400000);

  function statusBadge(l) {
    if(l.type==='premium'&&l.premiumEnd&&now<l.premiumEnd)
      return `<span class="badge premium">PREMIUM</span>`;
    if(l.type==='trial'&&now<l.trialEnd)
      return `<span class="badge trial">TRIAL</span>`;
    return `<span class="badge expired">EXPIRADO</span>`;
  }

  function daysInfo(l) {
    if(l.type==='premium'&&l.premiumEnd&&now<l.premiumEnd){
      const d=Math.ceil((l.premiumEnd-now)/DAY_MS);
      return `<span style="color:${d<=7?'#f59e0b':'#10b981'}">${d}d restantes</span>`;
    }
    if(l.type==='trial'&&now<l.trialEnd){
      const d=Math.ceil((l.trialEnd-now)/DAY_MS);
      return `<span style="color:${d<=3?'#f59e0b':'#60a5fa'}">${d}d de trial</span>`;
    }
    return `<span style="color:#ef4444">Expirado</span>`;
  }

  function lastSeenStr(l) {
    if(!l.lastSeen) return '—';
    const diff = now-l.lastSeen;
    if(diff<3600000)  return Math.floor(diff/60000)+'min atrás';
    if(diff<86400000) return Math.floor(diff/3600000)+'h atrás';
    return ptDate(l.lastSeen);
  }

  const rows = all.sort((a,b)=>(b.lastSeen||0)-(a.lastSeen||0)).map(l=>`
    <tr>
      <td><strong>${l.account}</strong></td>
      <td>${l.name||'—'}</td>
      <td>${statusBadge(l)}</td>
      <td>${daysInfo(l)}</td>
      <td style="font-size:11px;color:#64748b">${lastSeenStr(l)}</td>
      <td style="font-size:11px;color:#64748b">${l.firstSeen?ptDate(l.firstSeen):'—'}</td>
      <td>
        <button onclick="renovar('${l.account}','${l.name||''}',1)" class="btn-sm prem">+1m</button>
        <button onclick="renovar('${l.account}','${l.name||''}',3)" class="btn-sm prem">+3m</button>
        <button onclick="revogar('${l.account}')" class="btn-sm del">✕</button>
      </td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashbot Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#08090f;color:#e2e8f0;font-family:system-ui,sans-serif;min-height:100vh}
.hdr{background:#0d0f1a;border-bottom:1px solid #1e2438;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
.logo{font-size:18px;font-weight:800}.logo span{color:#3b82f6}
.main{padding:20px;max-width:1200px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.stat{background:#0d0f1a;border:1px solid #1e2438;border-radius:10px;padding:16px;text-align:center}
.stat-val{font-size:30px;font-weight:800}
.stat-lbl{font-size:10px;color:#64748b;margin-top:4px;text-transform:uppercase;letter-spacing:.06em}
.card{background:#0d0f1a;border:1px solid #1e2438;border-radius:12px;padding:18px}
.card-title{font-size:13px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px}
.form-row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}
.fg{display:flex;flex-direction:column;gap:4px}
label{font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
input,select{background:#131624;border:1px solid #1e2438;border-radius:8px;color:#e2e8f0;padding:8px 12px;font-size:13px;outline:none}
input:focus,select:focus{border-color:#3b82f6}
.btn{background:#1e3a8a;border:1px solid #3b82f6;color:#60a5fa;border-radius:8px;padding:9px 18px;font-size:13px;font-weight:700;cursor:pointer;transition:all .15s}
.btn:hover{background:#3b82f6;color:#fff}
.btn-sm{border-radius:6px;padding:4px 9px;font-size:11px;font-weight:700;cursor:pointer;border:1px solid;margin-right:2px;transition:all .15s}
.prem{background:#064e3b;color:#10b981;border-color:#10b981}.prem:hover{background:#10b981;color:#000}
.del{background:#450a0a;color:#ef4444;border-color:#ef4444}.del:hover{background:#ef4444;color:#fff}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#475569;padding:8px 10px;border-bottom:1px solid #1e2438}
td{padding:9px 10px;border-bottom:1px solid #0d0f1a;font-size:13px;vertical-align:middle}
tr:hover td{background:#0a0c18}
.badge{font-size:10px;font-weight:700;padding:2px 9px;border-radius:20px;letter-spacing:.05em;white-space:nowrap}
.badge.premium{background:#1a3a2a;color:#10b981;border:1px solid #10b981}
.badge.trial{background:#1a2a3a;color:#60a5fa;border:1px solid #3b82f6}
.badge.expired{background:#2a1a1a;color:#ef4444;border:1px solid #ef4444}
.msg{padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:10px;display:none}
.msg.ok{background:#064e3b;color:#10b981;border:1px solid #10b981}
.msg.err{background:#450a0a;color:#ef4444;border:1px solid #ef4444}
.tabs{display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap}
.tab{padding:6px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:1px solid #1e2438;background:#0a0c18;color:#64748b;transition:all .15s}
.tab.active{background:#1e3a8a;border-color:#3b82f6;color:#60a5fa}
.tbl-wrap{overflow-x:auto}
@media(max-width:600px){.form-row{flex-direction:column}.stat-val{font-size:22px}}
</style>
</head>
<body>
<div class="hdr">
  <div class="logo">Dash<span>bot</span> <span style="font-size:12px;color:#475569;font-weight:400">— Painel Admin v2</span></div>
  <span style="font-size:11px;color:#475569">InvestidorBot</span>
</div>
<div class="main">

  <!-- Stats -->
  <div class="stats">
    <div class="stat">
      <div class="stat-val">${all.length}</div>
      <div class="stat-lbl">Total de Contas</div>
    </div>
    <div class="stat">
      <div class="stat-val" style="color:#60a5fa">${trials.length}</div>
      <div class="stat-lbl">Em Trial</div>
    </div>
    <div class="stat">
      <div class="stat-val" style="color:#10b981">${premiums.length}</div>
      <div class="stat-lbl">Premium Ativo</div>
    </div>
    <div class="stat">
      <div class="stat-val" style="color:#ef4444">${expired.length}</div>
      <div class="stat-lbl">Expirados</div>
    </div>
    <div class="stat">
      <div class="stat-val" style="color:#f59e0b">${recent24.length}</div>
      <div class="stat-lbl">Ativos (24h)</div>
    </div>
  </div>

  <!-- Ativar licença -->
  <div class="card">
    <div class="card-title">Ativar / Renovar Premium</div>
    <div id="msg" class="msg"></div>
    <div class="form-row">
      <div class="fg">
        <label>Conta MT5</label>
        <input type="number" id="iAccount" placeholder="Ex: 12345678" style="width:160px">
      </div>
      <div class="fg">
        <label>Nome do cliente</label>
        <input type="text" id="iName" placeholder="João Silva" style="width:180px">
      </div>
      <div class="fg">
        <label>Período</label>
        <select id="iMonths">
          <option value="1">1 mês</option>
          <option value="3">3 meses</option>
          <option value="6">6 meses</option>
          <option value="12">12 meses</option>
        </select>
      </div>
      <button class="btn" onclick="ativar()">✓ Ativar Premium</button>
    </div>
  </div>

  <!-- Tabela -->
  <div class="card">
    <div class="card-title">Usuários</div>
    <div class="tabs">
      <div class="tab active" onclick="filtrar('todos',this)">Todos (${all.length})</div>
      <div class="tab" onclick="filtrar('trial',this)">Trial (${trials.length})</div>
      <div class="tab" onclick="filtrar('premium',this)">Premium (${premiums.length})</div>
      <div class="tab" onclick="filtrar('expired',this)">Expirados (${expired.length})</div>
      <div class="tab" onclick="filtrar('recent',this)">Ativos 24h (${recent24.length})</div>
    </div>
    <div class="tbl-wrap">
      <table id="tbl">
        <thead><tr>
          <th>Conta MT5</th><th>Nome</th><th>Status</th>
          <th>Período</th><th>Último acesso</th><th>Desde</th><th>Ações</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${all.length===0?'<p style="color:#475569;padding:20px;font-size:13px">Nenhum usuário ainda.</p>':''}
    </div>
  </div>

</div>
<script>
const B = window.location.origin;
const AUTH = 'Basic ' + btoa('${ADMIN_USER}:${ADMIN_PASS}');

async function api(method, path, body) {
  const r = await fetch(B+path, {
    method,
    headers:{'Content-Type':'application/json','Authorization':AUTH},
    body: body?JSON.stringify(body):undefined
  });
  return r.json();
}

function showMsg(txt,ok){
  const e=document.getElementById('msg');
  e.textContent=txt; e.className='msg '+(ok?'ok':'err'); e.style.display='block';
  setTimeout(()=>e.style.display='none',4000);
}

async function ativar(){
  const account=document.getElementById('iAccount').value;
  const name=document.getElementById('iName').value;
  const months=document.getElementById('iMonths').value;
  if(!account){showMsg('Informe a conta MT5',false);return;}
  const r=await api('POST','/admin/license',{account,name,months:parseInt(months)});
  if(r.ok){showMsg('Premium ativado! Vence: '+r.expiresStr,true);setTimeout(()=>location.reload(),1500);}
  else showMsg('Erro: '+(r.error||'desconhecido'),false);
}

async function renovar(account,name,months){
  const r=await api('POST','/admin/license',{account,name,months});
  if(r.ok){showMsg('Renovado! Vence: '+r.expiresStr,true);setTimeout(()=>location.reload(),1500);}
  else showMsg('Erro: '+(r.error||'desconhecido'),false);
}

async function revogar(account){
  if(!confirm('Remover conta '+account+'? Esta ação não pode ser desfeita.'))return;
  const r=await api('DELETE','/admin/license',{account});
  if(r.ok){showMsg('Conta removida.',true);setTimeout(()=>location.reload(),1500);}
  else showMsg('Erro: '+(r.error||'desconhecido'),false);
}

// Filtro de tabela client-side
const rowData = ${JSON.stringify(all.map(l=>({
  account:l.account,
  type: l.type==='premium'&&l.premiumEnd&&Date.now()<l.premiumEnd?'premium':
        l.type==='trial'&&Date.now()<l.trialEnd?'trial':'expired',
  recent: l.lastSeen&&(Date.now()-l.lastSeen)<86400000
})))};

function filtrar(tipo, btn){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  btn.classList.add('active');
  const rows=[...document.querySelectorAll('#tbl tbody tr')];
  rows.forEach((row,i)=>{
    const d=rowData[i];
    let show=false;
    if(tipo==='todos') show=true;
    else if(tipo==='trial') show=d.type==='trial';
    else if(tipo==='premium') show=d.type==='premium';
    else if(tipo==='expired') show=d.type==='expired';
    else if(tipo==='recent') show=d.recent;
    row.style.display=show?'':'none';
  });
}
</script>
</body>
</html>`;
}

server.listen(PORT,()=>{
  console.log('Dashbot Server v2 na porta',PORT);
  console.log('LICENSE_BIN:',LICENSE_BIN||'(nao configurado)');
});

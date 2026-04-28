// ─────────────────────────────────────────────────────────────────
//  Dashbot Server v3 — Auth + Licenças + Produtos
//  Deploy: https://render.com
// ─────────────────────────────────────────────────────────────────
const https  = require('https');
const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const PORT        = process.env.PORT               || 3000;
const MASTER_KEY  = process.env.JSONBIN_MASTER_KEY || '';
const DATA_BIN    = process.env.JSONBIN_DATA_BIN   || '';
const CMD_BIN     = process.env.JSONBIN_CMD_BIN    || '';
const LICENSE_BIN = process.env.JSONBIN_LICENSE_BIN|| '';
const AUTH_BIN    = process.env.JSONBIN_AUTH_BIN   || '';
const PROXY_TOKEN = process.env.DASHBOT_TOKEN      || 'dashbot2024';
const ADMIN_USER  = process.env.ADMIN_USER         || 'admin';
const ADMIN_PASS  = process.env.ADMIN_PASS         || 'admin123';

const TRIAL_DAYS  = 14;
const DAY_MS      = 86400000;

// ── Cache ─────────────────────────────────────────────────────────
let licenseCache = {}; let lastLicLoad = 0;
let authCache    = {}; let lastAuthLoad = 0;
const CACHE_TTL  = 20000;

function hashPw(pw) {
  return crypto.createHash('sha256').update(pw+'dashbot_salt_2024').digest('hex');
}
function genToken(account) {
  return crypto.createHash('sha256')
    .update(account+'_'+Date.now()+'_'+Math.random()).digest('hex');
}
function ptDate(ms) {
  return new Date(ms).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'});
}

// ── JSONBin ───────────────────────────────────────────────────────
function jbReq(method, binId, body, cb) {
  if(!binId){ cb(new Error('No binId'),-1,''); return; }
  const bodyStr = body ? JSON.stringify(body) : null;
  const safeBinId = encodeURIComponent(binId).replace(/%2F/g,'/');
  const opts = {
    hostname:'api.jsonbin.io', port:443,
    path:'/v3/b/'+safeBinId+(method==='GET'?'/latest':''),
    method,
    headers:{'Content-Type':'application/json','X-Master-Key':MASTER_KEY,'X-Bin-Meta':'false'}
  };
  if(bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
  const req = https.request(opts, res => {
    let d=''; res.on('data',c=>d+=c); res.on('end',()=>cb(null,res.statusCode,d));
  });
  req.on('error', err => cb(err,-1,''));
  if(bodyStr) req.write(bodyStr);
  req.end();
}

function readBody(req) {
  return new Promise(r => { let b=''; req.on('data',c=>b+=c); req.on('end',()=>r(b)); });
}

// ── DB helpers ────────────────────────────────────────────────────
async function getLics() {
  return new Promise(resolve => {
    if(!LICENSE_BIN){ resolve({}); return; }
    const now = Date.now();
    if(now-lastLicLoad < CACHE_TTL){ resolve(licenseCache); return; }
    jbReq('GET', LICENSE_BIN, null, (err,code,data) => {
      if(!err && code===200) try {
        const p = JSON.parse(data); licenseCache = p.licenses||{}; lastLicLoad = now;
      } catch(e){}
      resolve(licenseCache);
    });
  });
}
async function saveLics(lics) {
  return new Promise(resolve => {
    jbReq('PUT', LICENSE_BIN, {licenses:lics}, (err,code) => {
      if(!err && code===200){ licenseCache=lics; lastLicLoad=Date.now(); }
      resolve(!err && code===200);
    });
  });
}
async function getAuth() {
  return new Promise(resolve => {
    if(!AUTH_BIN){ if(!authCache.users)authCache.users={}; if(!authCache.tokens)authCache.tokens={}; resolve(authCache); return; }
    const now = Date.now();
    if(now-lastAuthLoad < CACHE_TTL){ resolve(authCache); return; }
    jbReq('GET', AUTH_BIN, null, (err,code,data) => {
      if(!err && code===200) try { const p=JSON.parse(data); authCache=p.auth||{}; lastAuthLoad=now; } catch(e){}
      if(!authCache.users)  authCache.users  = {};
      if(!authCache.tokens) authCache.tokens = {};
      resolve(authCache);
    });
  });
}
async function saveAuth(db) {
  return new Promise(resolve => {
    if(!AUTH_BIN){ authCache=db; resolve(true); return; }
    jbReq('PUT', AUTH_BIN, {auth:db}, (err,code) => {
      if(!err && code===200){ authCache=db; lastAuthLoad=Date.now(); }
      resolve(!err && code===200);
    });
  });
}

// ── License check ─────────────────────────────────────────────────
function checkLic(lic) {
  const now = Date.now();
  if(!lic) return {valid:false,plan:'none',expired:true};
  if(lic.type==='premium') {
    if(lic.premiumEnd && now < lic.premiumEnd)
      return {valid:true,plan:'premium',daysLeft:Math.ceil((lic.premiumEnd-now)/DAY_MS)};
    return {valid:false,plan:'expired',expired:true};
  }
  const trialEnd = lic.trialEnd || ((lic.trialStart||now) + TRIAL_DAYS*DAY_MS);
  if(now < trialEnd)
    return {valid:true,plan:'trial',daysLeft:Math.ceil((trialEnd-now)/DAY_MS)};
  return {valid:false,plan:'expired',expired:true};
}

// ── Token verify ──────────────────────────────────────────────────
async function verifySession(token) {
  if(!token) return null;
  const db = await getAuth();
  for(const k of Object.keys(db.tokens||{})) {
    const t = db.tokens[k];
    if(t.token===token && t.type==='session' && t.expires>Date.now()) return t;
  }
  return null;
}

// ── HTTP ──────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type,Authorization,X-Dashbot-Token,X-Auth-Token'
};
function sendJSON(res,code,obj){
  const b=JSON.stringify(obj);
  res.writeHead(code,{...CORS,'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)});
  res.end(b);
}
function sendHTML(res,html){
  res.writeHead(200,{...CORS,'Content-Type':'text/html;charset=utf-8'});
  res.end(html);
}
function adminAuth(req){
  const a=req.headers['authorization']||'';
  if(!a.startsWith('Basic ')) return false;
  const [u,p]=Buffer.from(a.slice(6),'base64').toString().split(':');
  return u===ADMIN_USER && p===ADMIN_PASS;
}

// ── Server ────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────

http.createServer(async (req, res) => {
  const parsed  = new URL(req.url,'http://localhost');
  const reqPath = parsed.pathname;
  const method  = req.method.toUpperCase();
  const qs      = parsed.searchParams;

  if(method==='OPTIONS'){ res.writeHead(204,CORS); res.end(); return; }

  // Health check para o Render
  if(reqPath==='/health'||reqPath==='/ping'){
    sendJSON(res,200,{status:'ok','service':'Dashbot Server v3',ts:Date.now()});
    return;
  }

  // Serve o dashboard web — sem cache para garantir versão atualizada
  if(reqPath==='/'||reqPath==='/dashbot'||reqPath==='/dashbot/'){
    const htmlPath = path.join(__dirname,'dashbot_web.html');
    if(fs.existsSync(htmlPath)){
      res.writeHead(200,{
        ...CORS,
        'Content-Type':'text/html;charset=utf-8',
        'Cache-Control':'no-store, no-cache, must-revalidate',
        'Pragma':'no-cache',
        'Expires':'0'
      });
      res.end(fs.readFileSync(htmlPath));
    } else {
      sendJSON(res,404,{error:'dashbot_web.html not found on server'});
    }
    return;
  }

  // /validate — EA valida licença
  if(reqPath==='/validate'){
    const account = qs.get('account')||'';
    const lics = await getLics();
    const now  = Date.now();
    let lic = lics[account];
    if(!lic){
      lic={account,type:'trial',trialStart:now,trialEnd:now+TRIAL_DAYS*DAY_MS,firstSeen:now,lastSeen:now};
      lics[account]=lic; await saveLics(lics);
    } else {
      lics[account].lastSeen=now; await saveLics(lics);
    }
    const s=checkLic(lic);
    sendJSON(res,200,{...s,account,trialStart:lic.trialStart,trialEnd:lic.trialEnd||null,premiumEnd:lic.premiumEnd||null});
    return;
  }

  // /auth/check — verifica se conta tem senha (sem cache)
  if(reqPath==='/auth/check'){
    const account=qs.get('account')||'';
    if(!account){sendJSON(res,400,{error:'account obrigatório'});return;}
    // Força leitura fresca do banco (sem cache)
    lastAuthLoad=0;
    const lics=await getLics();
    const now=Date.now();
    if(!lics[account]){
      lics[account]={account,type:'trial',trialStart:now,
        trialEnd:now+TRIAL_DAYS*DAY_MS,firstSeen:now,lastSeen:now};
      await saveLics(lics);
    }
    const s=checkLic(lics[account]);
    if(!s.valid){sendJSON(res,403,{error:'Licença expirada'});return;}
    // Leitura fresca do auth DB
    const db=await getAuth();
    const hasPassword=!!(db.users&&db.users[String(account)]&&db.users[String(account)].passwordHash);
    if(hasPassword){
      sendJSON(res,200,{hasPassword:true,plan:s.plan});
    } else {
      const setupToken=genToken(account);
      if(!db.tokens) db.tokens={};
      db.tokens['setup_'+account]={token:setupToken,account,
        expires:Date.now()+600000,type:'setup'};
      await saveAuth(db);
      sendJSON(res,200,{hasPassword:false,setupToken,account,plan:s.plan});
    }
    return;
  }

  // /auth/mt5-link — EA abre link de primeiro acesso
  if(reqPath==='/auth/mt5-link' && method==='POST'){
    const token=qs.get('token')||'';
    if(token!==PROXY_TOKEN){sendJSON(res,401,{error:'Token inválido'});return;}
    const body=await readBody(req);
    let data; try{data=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
    const {account}=data;
    if(!account){sendJSON(res,400,{error:'account obrigatório'});return;}

    const lics=await getLics();
    const now=Date.now();
    // Cria trial automaticamente se conta não existe
    if(!lics[account]){
      lics[account]={account,type:'trial',trialStart:now,
        trialEnd:now+TRIAL_DAYS*DAY_MS,firstSeen:now,lastSeen:now};
      await saveLics(lics);
    }
    const s=checkLic(lics[account]);
    if(!s.valid){sendJSON(res,403,{error:'Licença expirada',expired:true});return;}

    const db=await getAuth();
    const setupToken=genToken(account);
    if(!db.tokens) db.tokens={};
    db.tokens['setup_'+account]={token:setupToken,account,expires:Date.now()+600000,type:'setup'};
    await saveAuth(db);
    const hasPassword=!!db.users?.[String(account)];
    sendJSON(res,200,{ok:true,setupToken,account,plan:s.plan,hasPassword});
    return;
  }

  // /auth/setup-password — cadastra senha no primeiro acesso
  if(reqPath==='/auth/setup-password' && method==='POST'){
    const body=await readBody(req);
    let data; try{data=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
    const {setupToken,password}=data;
    if(!setupToken||!password){sendJSON(res,400,{error:'Campos obrigatórios'});return;}
    if(password.length<6){sendJSON(res,400,{error:'Senha mínimo 6 caracteres'});return;}
    const db=await getAuth();
    let account=null;
    for(const k of Object.keys(db.tokens||{})){
      const t=db.tokens[k];
      if(t.token===setupToken&&t.type==='setup'&&t.expires>Date.now()){
        account=t.account; delete db.tokens[k]; break;
      }
    }
    if(!account){sendJSON(res,401,{error:'Token inválido ou expirado'});return;}
    db.users[account]={account,passwordHash:hashPw(password),createdAt:Date.now()};
    const sessionToken=genToken(account);
    db.tokens['sess_'+account+'_'+Date.now()]={token:sessionToken,account,expires:Date.now()+30*DAY_MS,type:'session'};
    await saveAuth(db);
    const lics=await getLics(); const s=checkLic(lics[account]);
    sendJSON(res,200,{ok:true,sessionToken,account,plan:s.plan,valid:s.valid});
    return;
  }

  // /auth/login — login com conta+senha
  if(reqPath==='/auth/login' && method==='POST'){
    const body=await readBody(req);
    let data; try{data=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
    const {account,password}=data;
    if(!account||!password){sendJSON(res,400,{error:'Campos obrigatórios'});return;}
    const db=await getAuth();
    const user=db.users[String(account)];
    if(!user||user.passwordHash!==hashPw(password)){sendJSON(res,401,{error:'Conta ou senha incorretos'});return;}
    const lics=await getLics(); const s=checkLic(lics[String(account)]);
    const sessionToken=genToken(account);
    if(!db.tokens) db.tokens={};
    db.tokens['sess_'+account+'_'+Date.now()]={token:sessionToken,account:String(account),expires:Date.now()+30*DAY_MS,type:'session'};
    await saveAuth(db);
    sendJSON(res,200,{ok:true,sessionToken,account:String(account),plan:s.plan,valid:s.valid,daysLeft:s.daysLeft});
    return;
  }

  // /auth/verify — verifica sessão
  if(reqPath==='/auth/verify'){
    const tok=qs.get('token')||req.headers['x-auth-token']||'';
    const sess=await verifySession(tok);
    if(!sess){sendJSON(res,401,{error:'Sessão inválida'});return;}
    const lics=await getLics(); const s=checkLic(lics[sess.account]);
    sendJSON(res,200,{ok:true,account:sess.account,plan:s.plan,valid:s.valid,daysLeft:s.daysLeft});
    return;
  }

  // /data — dados do dashboard (filtrado por conta da sessão)
  if(reqPath==='/data'){
    const tok=qs.get('token')||req.headers['x-auth-token']||'';
    let sessionAccount=null;
    if(tok!==PROXY_TOKEN){
      const sess=await verifySession(tok);
      if(!sess){sendJSON(res,401,{error:'Não autorizado'});return;}
      sessionAccount=sess.account;
    } else {
      // EA acessando — pode passar account como query param
      sessionAccount=qs.get('account')||null;
    }
    return new Promise(resolve=>{
      jbReq('GET',DATA_BIN,null,(err,code,rawData)=>{
        if(err||code!==200){sendJSON(res,500,{error:'Sem dados'});resolve();return;}
        try{
          const all=JSON.parse(rawData);
          if(sessionAccount){
            // Retorna apenas dados da conta do usuário logado
            const acctData=all[sessionAccount]||all; // fallback se ainda formato antigo
            // Se os dados têm a conta diretamente (formato antigo), filtra EAs
            if(acctData.eas && !all[sessionAccount]){
              // Formato antigo — um único objeto com todos os EAs
              // Não conseguimos filtrar sem account no EA — retorna tudo por ora
              sendJSON(res,200,acctData);
            } else {
              sendJSON(res,200,acctData.eas?acctData:{eas:[],ts:Date.now()});
            }
          } else {
            sendJSON(res,200,all);
          }
        }catch(e){sendJSON(res,500,{error:'Parse error'});}
        resolve();
      });
    });
  }

  // /update — EA envia dados (indexado por account)
  if(reqPath==='/update' && method==='POST'){
    const tok=qs.get('token')||'';
    if(tok!==PROXY_TOKEN){sendJSON(res,401,{error:'Não autorizado'});return;}
    const body=await readBody(req);
    let payload;
    try{payload=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
    const account=payload.account||qs.get('account')||null;
    return new Promise(resolve=>{
      if(account){
        // Formato novo: salva indexado por conta
        jbReq('GET',DATA_BIN,null,(err,code,rawData)=>{
          let all={};
          if(!err&&code===200) try{all=JSON.parse(rawData);}catch(e){}
          all[account]=payload;
          jbReq('PUT',DATA_BIN,all,(err2,code2)=>{
            sendJSON(res,!err2&&code2===200?200:500,{ok:!err2&&code2===200});
            resolve();
          });
        });
      } else {
        // Formato antigo: salva direto (compatibilidade)
        jbReq('PUT',DATA_BIN,payload,(err,code)=>{
          sendJSON(res,err||code!==200?500:200,{ok:!err&&code===200});
          resolve();
        });
      }
    });
  }

  // /command — comandos EA/Web
  if(reqPath==='/command'){
    const tok=qs.get('token')||req.headers['x-auth-token']||'';
    if(tok!==PROXY_TOKEN){
      const sess=await verifySession(tok);
      if(!sess){sendJSON(res,401,{error:'Não autorizado'});return;}
    }
    if(method==='GET'){
      return new Promise(resolve=>{
        jbReq('GET',CMD_BIN,null,(err,code,data)=>{
          try{sendJSON(res,200,JSON.parse(data));}
          catch(e){sendJSON(res,200,{cmd:'none'});}
          resolve();
        });
      });
    }
    if(method==='POST'){
      const body=await readBody(req);
      return new Promise(resolve=>{
        jbReq('PUT',CMD_BIN,JSON.parse(body),(err,code)=>{
          sendJSON(res,!err&&code===200?200:500,{ok:!err&&code===200});
          resolve();
        });
      });
    }
  }

  // /admin — painel admin
  if(reqPath.startsWith('/admin')){
    if(!adminAuth(req)){
      res.writeHead(401,{'WWW-Authenticate':'Basic realm="Dashbot Admin"',...CORS});
      res.end('Não autorizado'); return;
    }
    if((reqPath==='/admin'||reqPath==='/admin/')&&method==='GET'){
      const lics=await getLics(); const db=await getAuth();
      const now=Date.now();
      let rows=''; let stats={total:0,premium:0,trial:0,expired:0,active:0};
      for(const [acct,lic] of Object.entries(lics)){
        if(acct.startsWith('_')) continue;
        const s=checkLic(lic); stats.total++;
        if(s.plan==='premium')stats.premium++;
        else if(s.plan==='trial')stats.trial++;
        else stats.expired++;
        if(lic.lastSeen&&now-lic.lastSeen<7*DAY_MS)stats.active++;
        const hasPw=!!db.users?.[acct];
        const bc=s.plan==='premium'?'#10b981':s.plan==='trial'?'#3b82f6':'#ef4444';
        rows+=`<tr><td><code>${acct}</code></td><td>${lic.name||'—'}</td>
          <td><span class="badge" style="background:${bc}">${s.plan}</span></td>
          <td>${s.daysLeft||0}d</td>
          <td>${lic.lastSeen?new Date(lic.lastSeen).toLocaleDateString('pt-BR'):'—'}</td>
          <td>${hasPw?'✅':'❌'}</td>
          <td>
            <button class="btn-sm" onclick="renovar('${acct}','${lic.name||''}',1)">+1m</button>
            <button class="btn-sm" onclick="renovar('${acct}','${lic.name||''}',3)">+3m</button>
            <button class="btn-sm btn-red" onclick="revogar('${acct}')">Revogar</button>
            <button class="btn-sm" onclick="resetPw('${acct}')">↺ Senha</button>
          </td></tr>`;
      }
      const products=lics._products||[];
      const prodRows=products.length?products.map(p=>`<tr>
        <td><code>${p.id}</code></td><td>${p.name}</td><td>${p.type}</td>
        <td>R$ ${p.price||'—'}</td><td>${p.trialDays||0}d</td><td>${p.active?'✅':'❌'}</td>
        <td><button class="btn-sm btn-red" onclick="delProd('${p.id}')">✕</button></td>
      </tr>`).join(''):'<tr><td colspan="7" style="color:#8b949e;text-align:center;padding:16px">Nenhum produto</td></tr>';
      sendHTML(res,buildAdminHTML(rows,stats,prodRows));
      return;
    }
    if(reqPath==='/admin/license'&&method==='POST'){
      const body=await readBody(req);
      let d; try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const lics=await getLics(); const now=Date.now(); const key=String(d.account);
      const ex=lics[key]; const base=(ex?.premiumEnd&&ex.premiumEnd>now)?ex.premiumEnd:now;
      lics[key]={...(ex||{}),account:key,name:d.name||ex?.name||'',type:'premium',
        trialStart:ex?.trialStart||now,trialEnd:ex?.trialEnd||(now+TRIAL_DAYS*DAY_MS),
        premiumStart:ex?.premiumStart||now,premiumEnd:base+(parseInt(d.months)||1)*30*DAY_MS,
        lastSeen:ex?.lastSeen||now,firstSeen:ex?.firstSeen||now};
      const ok=await saveLics(lics);
      sendJSON(res,ok?200:500,{ok,expiresStr:ptDate(lics[key].premiumEnd)});
      return;
    }
    if(reqPath==='/admin/license'&&method==='DELETE'){
      const body=await readBody(req);
      let d; try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const lics=await getLics();
      if(lics[String(d.account)]){lics[String(d.account)].type='revoked';lics[String(d.account)].premiumEnd=0;lics[String(d.account)].trialEnd=0;}
      sendJSON(res,await saveLics(lics)?200:500,{ok:true});
      return;
    }
    if(reqPath==='/admin/manual'&&method==='POST'){
      const body=await readBody(req);
      let d; try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const lics=await getLics(); const now=Date.now(); const key=String(d.account);
      const ex=lics[key]; const daysMs=parseInt(d.days)*DAY_MS; let end,entry;
      if(d.type==='trial_ext'){
        end=now+daysMs;
        entry={...(ex||{}),account:key,name:d.name||ex?.name||'',type:'trial',
          trialStart:ex?.trialStart||now,trialEnd:end,lastSeen:ex?.lastSeen||now,firstSeen:ex?.firstSeen||now};
      } else {
        const base=(ex?.premiumEnd&&ex.premiumEnd>now)?ex.premiumEnd:now; end=base+daysMs;
        entry={...(ex||{}),account:key,name:d.name||ex?.name||'',type:'premium',
          trialStart:ex?.trialStart||now,trialEnd:ex?.trialEnd||(now+TRIAL_DAYS*DAY_MS),
          premiumStart:ex?.premiumStart||now,premiumEnd:end,
          lastSeen:ex?.lastSeen||now,firstSeen:ex?.firstSeen||now,note:'Manual/Bonus'};
      }
      lics[key]=entry; const ok=await saveLics(lics);
      sendJSON(res,ok?200:500,{ok,expiresStr:ptDate(end)});
      return;
    }
    if(reqPath==='/admin/reset-password'&&method==='POST'){
      const body=await readBody(req);
      let d; try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const db=await getAuth();
      delete db.users[String(d.account)];
      for(const k of Object.keys(db.tokens||{}))
        if(db.tokens[k].account===String(d.account)) delete db.tokens[k];
      sendJSON(res,await saveAuth(db)?200:500,{ok:true});
      return;
    }
    if(reqPath==='/admin/products'){
      const lics=await getLics();
      if(method==='GET'){sendJSON(res,200,{products:lics._products||[]});return;}
      if(method==='POST'){
        const body=await readBody(req);
        let d; try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
        if(!d.name||!d.type){sendJSON(res,400,{error:'name e type obrigatórios'});return;}
        if(!lics._products) lics._products=[];
        const prod={id:'prod_'+Date.now(),name:d.name,type:d.type,
          description:d.description||'',price:d.price||null,currency:d.currency||'BRL',
          trialDays:d.trialDays||0,active:true,createdAt:Date.now()};
        lics._products.push(prod);
        const ok=await saveLics(lics);
        sendJSON(res,ok?200:500,{ok,product:prod});
        return;
      }
      if(method==='DELETE'){
        const body=await readBody(req);
        let d; try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
        lics._products=(lics._products||[]).filter(p=>p.id!==d.id);
        sendJSON(res,await saveLics(lics)?200:500,{ok:true});
        return;
      }
    }
    sendJSON(res,404,{error:'Rota não encontrada'});
    return;
  }

  sendJSON(res,404,{error:'Not found'});

}).listen(PORT, ()=>{
  console.log("Dashbot Server v3 iniciado na porta "+PORT);
  // Ping inicial após 30s
  setTimeout(()=>{
    const p=https.request({hostname:"dashbot.investidorbot.com",path:"/ping",method:"GET"},()=>{}).on("error",()=>{});
    p.end();
  },30000);
  // Keep-alive: ping a cada 14 minutos para evitar sleep no Render Free
  setInterval(()=>{
    const pingReq = https.request({
      hostname: 'dashbot.investidorbot.com',
      path: '/ping', method: 'GET'
    }, ()=>{}).on('error',()=>{});
    pingReq.end();
  }, 10 * 60 * 1000);
});

// ── Admin HTML ────────────────────────────────────────────────────
function buildAdminHTML(rows,stats,prodRows){
return `<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashbot Admin v3</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;padding:20px}
h1{color:#58a6ff;margin-bottom:4px;font-size:22px}
.sub{color:#8b949e;font-size:13px;margin-bottom:20px}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.stat{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 20px;min-width:100px;text-align:center}
.stat .n{font-size:26px;font-weight:700;color:#58a6ff}
.stat .l{font-size:11px;color:#8b949e;text-transform:uppercase;margin-top:2px}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:16px;margin-bottom:16px}
.card-title{font-size:13px;font-weight:700;color:#58a6ff;margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:6px 8px;border-bottom:1px solid #30363d;color:#8b949e;font-size:10px;text-transform:uppercase}
td{padding:6px 8px;border-bottom:1px solid #21262d;vertical-align:middle}
tr:hover td{background:#1c2128}
.badge{display:inline-block;padding:2px 6px;border-radius:10px;font-size:10px;font-weight:700;color:#fff}
.btn{background:#1f6feb;color:#fff;border:none;padding:7px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600}
.btn:hover{background:#388bfd}
.btn-sm{background:#21262d;color:#e6edf3;border:1px solid #30363d;padding:3px 7px;border-radius:4px;cursor:pointer;font-size:10px;margin:1px}
.btn-sm:hover{background:#30363d}
.btn-red{color:#f85149!important}
.form-row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}
.fg{display:flex;flex-direction:column;gap:3px}
label{font-size:10px;color:#8b949e;font-weight:600;text-transform:uppercase}
input,select{background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:5px 8px;border-radius:5px;font-size:12px}
input:focus,select:focus{outline:none;border-color:#388bfd}
.msg{padding:7px 12px;border-radius:6px;font-size:12px;margin-bottom:10px;display:none}
.msg.ok{background:#0d2e1f;border:1px solid #10b981;color:#10b981}
.msg.err{background:#2d1117;border:1px solid #f85149;color:#f85149}
</style></head><body>
<h1>🤖 Dashbot Admin v3</h1>
<p class="sub">Licenças · Usuários · Produtos</p>
<div class="stats">
  <div class="stat"><div class="n">${stats.total}</div><div class="l">Total</div></div>
  <div class="stat"><div class="n" style="color:#10b981">${stats.premium}</div><div class="l">Premium</div></div>
  <div class="stat"><div class="n" style="color:#3b82f6">${stats.trial}</div><div class="l">Trial</div></div>
  <div class="stat"><div class="n" style="color:#ef4444">${stats.expired}</div><div class="l">Expirados</div></div>
  <div class="stat"><div class="n" style="color:#f0c800">${stats.active}</div><div class="l">Ativos 7d</div></div>
</div>

<div class="card">
  <div class="card-title">➕ Ativar / Renovar Premium</div>
  <div id="msg" class="msg"></div>
  <div class="form-row">
    <div class="fg"><label>Conta MT5</label><input type="number" id="iAcc" placeholder="12345678" style="width:130px"></div>
    <div class="fg"><label>Nome</label><input type="text" id="iName" placeholder="João Silva" style="width:150px"></div>
    <div class="fg"><label>Período</label><select id="iMon"><option value="1">1 mês</option><option value="3">3 meses</option><option value="6">6 meses</option><option value="12">12 meses</option></select></div>
    <button class="btn" onclick="ativar()">✓ Ativar</button>
  </div>
</div>

<div class="card">
  <div class="card-title">🎁 Inserir Manualmente (Bônus / Trial)</div>
  <div id="msg2" class="msg"></div>
  <div class="form-row">
    <div class="fg"><label>Conta MT5</label><input type="number" id="mAcc" placeholder="12345678" style="width:130px"></div>
    <div class="fg"><label>Nome</label><input type="text" id="mName" placeholder="Nome" style="width:150px"></div>
    <div class="fg"><label>Tipo</label><select id="mType"><option value="trial_ext">Trial estendido</option><option value="bonus">Bônus Premium</option></select></div>
    <div class="fg"><label>Dias</label><input type="number" id="mDays" value="30" min="1" max="365" style="width:65px"></div>
    <button class="btn" style="background:#10b981" onclick="inserirManual()">➕ Inserir</button>
  </div>
</div>

<div class="card">
  <div class="card-title">📦 Produtos (EAs, Indicadores, etc.)</div>
  <div id="msg3" class="msg"></div>
  <div class="form-row" style="margin-bottom:12px">
    <div class="fg"><label>Nome</label><input type="text" id="pName" placeholder="Hulk EA v2" style="width:140px"></div>
    <div class="fg"><label>Tipo</label><select id="pType"><option value="ea">Expert Advisor</option><option value="indicator">Indicador</option><option value="dashboard">Dashboard</option><option value="other">Outro</option></select></div>
    <div class="fg"><label>Preço R$</label><input type="number" id="pPrice" placeholder="99.90" style="width:90px"></div>
    <div class="fg"><label>Trial (dias)</label><input type="number" id="pTrial" value="0" style="width:65px"></div>
    <div class="fg"><label>Descrição</label><input type="text" id="pDesc" placeholder="Opcional" style="width:180px"></div>
    <button class="btn" onclick="addProd()">+ Produto</button>
  </div>
  <table><thead><tr><th>ID</th><th>Nome</th><th>Tipo</th><th>Preço</th><th>Trial</th><th>Ativo</th><th></th></tr></thead>
  <tbody>${prodRows}</tbody></table>
</div>

<div class="card">
  <div class="card-title">👥 Usuários Registrados</div>
  <table><thead><tr><th>Conta</th><th>Nome</th><th>Plano</th><th>Dias</th><th>Último acesso</th><th>Senha</th><th>Ações</th></tr></thead>
  <tbody>${rows}</tbody></table>
</div>

<script>
const AUTH='Basic '+btoa('${ADMIN_USER}:${ADMIN_PASS}');
function showMsg(id,msg,ok){
  const el=document.getElementById(id);
  el.textContent=msg; el.className='msg '+(ok?'ok':'err'); el.style.display='block';
  setTimeout(()=>el.style.display='none',4000);
}
async function api(method,path,body){
  const r=await fetch(path,{method,headers:{'Content-Type':'application/json','Authorization':AUTH},body:body?JSON.stringify(body):undefined});
  return r.json();
}
async function ativar(){
  const r=await api('POST','/admin/license',{account:document.getElementById('iAcc').value,name:document.getElementById('iName').value,months:parseInt(document.getElementById('iMon').value)});
  if(r.ok){showMsg('msg','✅ Ativado até '+r.expiresStr,true);setTimeout(()=>location.reload(),1200);}
  else showMsg('msg','❌ '+(r.error||'Erro'),false);
}
async function renovar(a,n,m){
  const r=await api('POST','/admin/license',{account:a,name:n,months:m});
  if(r.ok){showMsg('msg','✅ '+r.expiresStr,true);setTimeout(()=>location.reload(),1200);}
  else showMsg('msg','❌ '+(r.error||'Erro'),false);
}
async function revogar(a){
  if(!confirm('Revogar '+a+'?')) return;
  const r=await api('DELETE','/admin/license',{account:a});
  if(r.ok) location.reload();
}
async function resetPw(a){
  if(!confirm('Resetar senha de '+a+'? O usuário refará o primeiro acesso.')) return;
  const r=await api('POST','/admin/reset-password',{account:a});
  if(r.ok) showMsg('msg','✅ Senha resetada',true);
}
async function inserirManual(){
  const r=await api('POST','/admin/manual',{account:document.getElementById('mAcc').value,name:document.getElementById('mName').value,type:document.getElementById('mType').value,days:parseInt(document.getElementById('mDays').value)});
  if(r.ok){showMsg('msg2','✅ Até '+r.expiresStr,true);setTimeout(()=>location.reload(),1200);}
  else showMsg('msg2','❌ '+(r.error||'Erro'),false);
}
async function addProd(){
  const r=await api('POST','/admin/products',{name:document.getElementById('pName').value,type:document.getElementById('pType').value,price:parseFloat(document.getElementById('pPrice').value)||null,trialDays:parseInt(document.getElementById('pTrial').value)||0,description:document.getElementById('pDesc').value});
  if(r.ok){showMsg('msg3','✅ Produto adicionado!',true);setTimeout(()=>location.reload(),1000);}
  else showMsg('msg3','❌ '+(r.error||'Erro'),false);
}
async function delProd(id){
  if(!confirm('Remover?')) return;
  const r=await api('DELETE','/admin/products',{id});
  if(r.ok) location.reload();
}
</script></body></html>`;
}

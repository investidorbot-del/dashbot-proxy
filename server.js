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

  // /auth/check — verifica se conta tem senha
  if(reqPath==='/auth/check'){
    const account=qs.get('account')||'';
    if(!account){sendJSON(res,400,{error:'account obrigatório'});return;}
    const lics=await getLics();
    const now=Date.now();
    if(!lics[account]){
      lics[account]={account,type:'trial',trialStart:now,
        trialEnd:now+TRIAL_DAYS*DAY_MS,firstSeen:now,lastSeen:now};
      await saveLics(lics);
    }
    const s=checkLic(lics[account]);
    if(!s.valid){sendJSON(res,403,{error:'Licença expirada'});return;}
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

  // /data — dados do dashboard (estritamente filtrado por conta)
  if(reqPath==='/data'){
    const tok=qs.get('token')||req.headers['x-auth-token']||'';
    let sessionAccount=null;
    if(tok!==PROXY_TOKEN){
      const sess=await verifySession(tok);
      if(!sess){sendJSON(res,401,{error:'Não autorizado'});return;}
      sessionAccount=sess.account;
    } else {
      sessionAccount=qs.get('account')||null;
    }
    return new Promise(resolve=>{
      jbReq('GET',DATA_BIN,null,(err,code,rawData)=>{
        if(err||code!==200){
          // Sem dados no servidor — retorna vazio com mensagem
          sendJSON(res,200,{eas:[],ts:Date.now(),offline:true,
            msg:'MT5 desconectado. Abra o Dashbot no MetaTrader 5.'});
          resolve(); return;
        }
        try{
          const all=JSON.parse(rawData);
          if(!sessionAccount){sendJSON(res,200,all);resolve();return;}
          // Busca dados da conta específica
          let acctData=null;
          if(all[sessionAccount]) {
            // Formato novo — indexado por conta
            acctData=all[sessionAccount];
          } else if(all.account===sessionAccount) {
            // Formato antigo mas com account correto
            acctData=all;
          } else if(all.eas && !all.account) {
            // Formato antigo sem account — verifica se os EAs são desta conta
            // Não podemos confirmar — retorna offline
            acctData=null;
          }
          if(acctData && acctData.eas){
            sendJSON(res,200,acctData);
          } else {
            // Conta não tem dados — MT5 não está enviando
            sendJSON(res,200,{eas:[],ts:Date.now(),offline:true,
              msg:'MT5 desconectado. Abra o Dashbot no MetaTrader 5.'});
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
    const account=String(payload.account||qs.get('account')||'');
    return new Promise(resolve=>{
      if(account){
        // Lê dados atuais, mescla e salva
        jbReq('GET',DATA_BIN,null,(err,code,rawData)=>{
          let all={};
          if(!err&&code===200){
            try{all=JSON.parse(rawData);}catch(e){all={};}
          }
          // Garante que all é objeto e não tem formato antigo misturado
          if(typeof all!=='object'||Array.isArray(all)||all.eas){all={};}
          all[account]=payload;
          jbReq('PUT',DATA_BIN,all,(err2,code2)=>{
            sendJSON(res,!err2&&code2===200?200:500,{ok:!err2&&code2===200});
            resolve();
          });
        });
      } else {
        // Sem account — salva direto (compatibilidade)
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
        const userProds=(lic.products||[]).map(p=>`<span style="background:#1e2438;padding:2px 6px;border-radius:4px;font-size:10px;margin:1px;display:inline-block">${p.name}</span>`).join('');
        const endDate=s.plan==='premium'?ptDate(lic.premiumEnd):s.plan==='trial'?ptDate(lic.trialEnd):'—';
        rows+=`<tr>
          <td><code>${acct}</code></td>
          <td>${lic.name||'—'}<br><small style="color:#64748b">${lic.email||''} ${lic.phone||''}</small></td>
          <td><span class="badge" style="background:${bc}">${s.plan}</span></td>
          <td>${endDate}</td>
          <td>${lic.lastSeen?new Date(lic.lastSeen).toLocaleDateString('pt-BR'):'—'}</td>
          <td>${hasPw?'✅':'❌'}</td>
          <td>${userProds||'—'}<br><button class="btn-sm" onclick="addUserProd('${acct}')">+ Produto</button></td>
          <td>
            <button class="btn-sm" onclick="editUser('${acct}','${(lic.name||'').replace(/'/g,"\\'")}','${lic.email||''}','${lic.phone||''}')">✏️ Editar</button>
            <button class="btn-sm" onclick="renovarModal('${acct}','${lic.name||''}')">📅 Licença</button>
            <button class="btn-sm" onclick="bonusModal('${acct}','${lic.name||''}')">🎁 Bônus</button>
            <button class="btn-sm btn-red" onclick="revogar('${acct}')">🚫 Revogar</button>
            <button class="btn-sm" onclick="resetPw('${acct}')">↺ Senha</button>
            <button class="btn-sm btn-red" onclick="delUser('${acct}')">🗑 Remover</button>
          </td></tr>`;
      }
      const products=lics._products||[];
      const prodRows=products.length?products.map(p=>`<tr>
        <td><code style="font-size:10px">${p.id}</code></td><td>${p.name}</td><td>${p.type}</td>
        <td>R$ ${p.price||'—'}</td><td>${p.trialDays||0}d</td>
        <td>Min:${p.minLots||0} Max:${p.maxLots||0}</td>
        <td>${p.instances||1}</td>
        <td>${p.active?'✅':'❌'}</td>
        <td><button class="btn-sm btn-red" onclick="delProd('${p.id}')">✕ Remover</button></td>
      </tr>`).join(''):'<tr><td colspan="9" style="color:#8b949e;text-align:center;padding:16px">Nenhum produto cadastrado</td></tr>';
      sendHTML(res,buildAdminHTML(rows,stats,prodRows,JSON.stringify(products)));
      return;
    }
    if(reqPath==='/admin/license'&&method==='POST'){
      const body=await readBody(req);
      let d; try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      if(!d.account){sendJSON(res,400,{error:'Conta obrigatória'});return;}
      const lics=await getLics(); const now=Date.now(); const key=String(d.account);
      const ex=lics[key];
      let end;
      if(d.endDate){end=new Date(d.endDate).getTime();}
      else{const base=(ex?.premiumEnd&&ex.premiumEnd>now)?ex.premiumEnd:now;end=base+(parseInt(d.months)||1)*30*DAY_MS;}
      lics[key]={...(ex||{}),account:key,name:d.name||ex?.name||'',type:'premium',
        trialStart:ex?.trialStart||now,trialEnd:ex?.trialEnd||(now+TRIAL_DAYS*DAY_MS),
        premiumStart:ex?.premiumStart||now,premiumEnd:end,
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
    // DELETE user completely
    if(reqPath==='/admin/user'&&method==='DELETE'){
      const body=await readBody(req);
      let d; try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const lics=await getLics(); const db=await getAuth();
      delete lics[String(d.account)];
      delete db.users?.[String(d.account)];
      for(const k of Object.keys(db.tokens||{}))
        if(db.tokens[k].account===String(d.account)) delete db.tokens[k];
      const ok1=await saveLics(lics); const ok2=await saveAuth(db);
      sendJSON(res,ok1&&ok2?200:500,{ok:ok1&&ok2});
      return;
    }
    // PUT user info (name, email, phone)
    if(reqPath==='/admin/user'&&method==='PUT'){
      const body=await readBody(req);
      let d; try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      if(!d.account){sendJSON(res,400,{error:'Conta obrigatória'});return;}
      const lics=await getLics(); const key=String(d.account);
      if(!lics[key]) lics[key]={account:key,type:'trial',trialStart:Date.now(),trialEnd:Date.now()+TRIAL_DAYS*DAY_MS,firstSeen:Date.now(),lastSeen:Date.now()};
      if(d.name!==undefined) lics[key].name=d.name;
      if(d.email!==undefined) lics[key].email=d.email;
      if(d.phone!==undefined) lics[key].phone=d.phone;
      const ok=await saveLics(lics);
      sendJSON(res,ok?200:500,{ok});
      return;
    }
    // GET user info
    if(reqPath==='/admin/user'&&method==='GET'){
      const account=qs.get('account')||'';
      const lics=await getLics(); const db=await getAuth();
      const lic=lics[account]||{};
      const hasPw=!!db.users?.[account];
      sendJSON(res,200,{account,name:lic.name||'',email:lic.email||'',phone:lic.phone||'',hasPw,products:lic.products||[]});
      return;
    }
    // POST assign product to user
    if(reqPath==='/admin/user-product'&&method==='POST'){
      const body=await readBody(req);
      let d; try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const lics=await getLics(); const key=String(d.account);
      if(!lics[key]){sendJSON(res,404,{error:'Usuário não encontrado'});return;}
      if(!lics[key].products) lics[key].products=[];
      // Avoid duplicate
      if(!lics[key].products.find(p=>p.id===d.productId)){
        const allProds=lics._products||[];
        const prod=allProds.find(p=>p.id===d.productId);
        if(prod) lics[key].products.push({id:prod.id,name:prod.name,assignedAt:Date.now()});
      }
      const ok=await saveLics(lics);
      sendJSON(res,ok?200:500,{ok});
      return;
    }
    // DELETE remove product from user
    if(reqPath==='/admin/user-product'&&method==='DELETE'){
      const body=await readBody(req);
      let d; try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const lics=await getLics(); const key=String(d.account);
      if(lics[key]&&lics[key].products)
        lics[key].products=lics[key].products.filter(p=>p.id!==d.productId);
      const ok=await saveLics(lics);
      sendJSON(res,ok?200:500,{ok});
      return;
    }
    if(reqPath==='/admin/manual'&&method==='POST'){
      const body=await readBody(req);
      let d; try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      if(!d.account){sendJSON(res,400,{error:'Conta obrigatória'});return;}
      const lics=await getLics(); const now=Date.now(); const key=String(d.account);
      const ex=lics[key]; let end,entry;
      if(d.endDate){end=new Date(d.endDate).getTime();}
      else{const daysMs=parseInt(d.days||30)*DAY_MS;end=now+daysMs;}
      if(d.type==='trial_ext'){
        entry={...(ex||{}),account:key,name:d.name||ex?.name||'',type:'trial',
          trialStart:ex?.trialStart||now,trialEnd:end,lastSeen:ex?.lastSeen||now,firstSeen:ex?.firstSeen||now};
      } else {
        const base=(ex?.premiumEnd&&ex.premiumEnd>now)?ex.premiumEnd:now;if(!d.endDate)end=base+(parseInt(d.days||30)*DAY_MS);
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
          trialDays:d.trialDays||0,minLots:d.minLots||0,maxLots:d.maxLots||0,
          instances:d.instances||1,active:true,createdAt:Date.now()};
        lics._products.push(prod);
        const ok=await saveLics(lics);
        sendJSON(res,ok?200:500,{ok,product:prod});
        return;
      }
      if(method==='PUT'){
        const body=await readBody(req);
        let d; try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
        lics._products=(lics._products||[]).map(p=>p.id===d.id?{...p,...d}:p);
        const ok=await saveLics(lics);
        sendJSON(res,ok?200:500,{ok});
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
function buildAdminHTML(rows,stats,prodRows,productsJson){
const prodsJs = productsJson||'[]';
return `<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashbot Admin v3</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;padding:16px}
h1{color:#58a6ff;margin-bottom:4px;font-size:20px}
.sub{color:#8b949e;font-size:12px;margin-bottom:16px}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.stat{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:10px 16px;min-width:90px;text-align:center}
.stat .n{font-size:22px;font-weight:700;color:#58a6ff}
.stat .l{font-size:10px;color:#8b949e;text-transform:uppercase;margin-top:2px}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px;margin-bottom:14px}
.card-title{font-size:12px;font-weight:700;color:#58a6ff;margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em}
.form-row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:8px}
.fg{display:flex;flex-direction:column;gap:3px}
label{font-size:10px;color:#8b949e;font-weight:600;text-transform:uppercase}
input,select{background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:5px 8px;border-radius:5px;font-size:12px}
input:focus,select:focus{outline:none;border-color:#388bfd}
input[type=date]{color-scheme:dark}
.btn{background:#1f6feb;color:#fff;border:none;padding:6px 12px;border-radius:5px;cursor:pointer;font-size:12px;font-weight:600}
.btn:hover{background:#388bfd}
.btn-green{background:#10b981}
.btn-green:hover{background:#059669}
.btn-sm{background:#21262d;color:#e6edf3;border:1px solid #30363d;padding:2px 6px;border-radius:4px;cursor:pointer;font-size:10px;margin:1px;white-space:nowrap}
.btn-sm:hover{background:#30363d}
.btn-red{color:#f85149!important}
.badge{display:inline-block;padding:2px 6px;border-radius:10px;font-size:10px;font-weight:700;color:#fff}
.msg{padding:6px 10px;border-radius:5px;font-size:12px;margin-bottom:8px;display:none}
.msg.ok{background:#0d2e1f;border:1px solid #10b981;color:#10b981}
.msg.err{background:#2d1117;border:1px solid #f85149;color:#f85149}
table{width:100%;border-collapse:collapse;font-size:11px}
th{text-align:left;padding:6px 8px;border-bottom:1px solid #30363d;color:#8b949e;font-size:10px;text-transform:uppercase;white-space:nowrap}
td{padding:5px 8px;border-bottom:1px solid #21262d;vertical-align:middle}
tr:hover td{background:#1c2128}
.modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:100;align-items:center;justify-content:center}
.modal-bg.open{display:flex}
.modal{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;min-width:320px;max-width:480px;width:90%}
.modal h3{color:#58a6ff;margin-bottom:16px;font-size:15px}
.modal .form-row{margin-bottom:12px}
.modal-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
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

<!-- Modais -->
<div class="modal-bg" id="modalLic">
  <div class="modal">
    <h3>📅 Gerenciar Licença</h3>
    <div id="msgLic" class="msg"></div>
    <div class="form-row"><div class="fg"><label>Conta</label><input id="licAcct" readonly style="opacity:.7;width:120px"></div>
    <div class="fg"><label>Nome</label><input id="licName" style="width:150px"></div></div>
    <div class="form-row">
      <div class="fg"><label>Atalhos</label>
        <div style="display:flex;gap:4px">
          <button class="btn-sm" onclick="licAddMonths(1)">+1m</button>
          <button class="btn-sm" onclick="licAddMonths(3)">+3m</button>
          <button class="btn-sm" onclick="licAddMonths(6)">+6m</button>
          <button class="btn-sm" onclick="licAddMonths(12)">+1a</button>
        </div>
      </div>
    </div>
    <div class="form-row">
      <div class="fg"><label>Data de expiração</label><input type="date" id="licDate" style="width:160px"></div>
    </div>
    <div class="modal-btns">
      <button class="btn-sm" onclick="closeModal('modalLic')">Cancelar</button>
      <button class="btn btn-green" onclick="saveLic()">✓ Salvar</button>
    </div>
  </div>
</div>

<div class="modal-bg" id="modalBonus">
  <div class="modal">
    <h3>🎁 Bônus / Trial</h3>
    <div id="msgBonus" class="msg"></div>
    <div class="form-row">
      <div class="fg"><label>Conta</label><input id="bonAcct" readonly style="opacity:.7;width:120px"></div>
      <div class="fg"><label>Tipo</label><select id="bonType" style="width:160px"><option value="trial_ext">Trial estendido</option><option value="bonus">Bônus Premium</option></select></div>
    </div>
    <div class="form-row">
      <div class="fg"><label>Atalhos</label>
        <div style="display:flex;gap:4px">
          <button class="btn-sm" onclick="bonAddDays(7)">+7d</button>
          <button class="btn-sm" onclick="bonAddDays(15)">+15d</button>
          <button class="btn-sm" onclick="bonAddDays(30)">+30d</button>
        </div>
      </div>
    </div>
    <div class="form-row">
      <div class="fg"><label>Data de expiração</label><input type="date" id="bonDate" style="width:160px"></div>
    </div>
    <div class="modal-btns">
      <button class="btn-sm" onclick="closeModal('modalBonus')">Cancelar</button>
      <button class="btn btn-green" onclick="saveBonus()">✓ Aplicar</button>
    </div>
  </div>
</div>

<div class="modal-bg" id="modalEdit">
  <div class="modal">
    <h3>✏️ Editar Usuário</h3>
    <div id="msgEdit" class="msg"></div>
    <div class="form-row"><div class="fg"><label>Conta MT5</label><input id="editAcct" readonly style="opacity:.7;width:120px"></div></div>
    <div class="form-row"><div class="fg"><label>Nome completo</label><input id="editName" style="width:100%"></div></div>
    <div class="form-row"><div class="fg"><label>E-mail</label><input id="editEmail" type="email" style="width:100%"></div></div>
    <div class="form-row"><div class="fg"><label>Telefone</label><input id="editPhone" style="width:100%"></div></div>
    <div class="modal-btns">
      <button class="btn-sm" onclick="closeModal('modalEdit')">Cancelar</button>
      <button class="btn btn-green" onclick="saveEdit()">✓ Salvar</button>
    </div>
  </div>
</div>

<div class="modal-bg" id="modalUserProd">
  <div class="modal">
    <h3>📦 Adicionar Produto ao Usuário</h3>
    <div id="msgUserProd" class="msg"></div>
    <div class="form-row"><div class="fg"><label>Conta MT5</label><input id="upAcct" readonly style="opacity:.7;width:120px"></div></div>
    <div class="form-row"><div class="fg" style="width:100%"><label>Produto</label>
      <select id="upProd" style="width:100%"><option value="">Selecione...</option></select>
    </div></div>
    <div class="modal-btns">
      <button class="btn-sm" onclick="closeModal('modalUserProd')">Cancelar</button>
      <button class="btn btn-green" onclick="saveUserProd()">✓ Atribuir</button>
    </div>
  </div>
</div>

<!-- Cards de ação rápida -->
<div class="card">
  <div class="card-title">➕ Ativar Premium</div>
  <div id="msg" class="msg"></div>
  <div class="form-row">
    <div class="fg"><label>Conta MT5 *</label><input type="number" id="iAcc" placeholder="Obrigatório" style="width:130px"></div>
    <div class="fg"><label>Nome</label><input type="text" id="iName" placeholder="Nome do cliente" style="width:150px"></div>
    <div class="fg"><label>Atalho</label><select id="iMon" style="width:100px"><option value="1">+1 mês</option><option value="3">+3 meses</option><option value="6">+6 meses</option><option value="12">+1 ano</option></select></div>
    <div class="fg"><label>ou data exata</label><input type="date" id="iDate" style="width:140px"></div>
    <button class="btn" onclick="ativar()">✓ Ativar</button>
  </div>
</div>

<div class="card">
  <div class="card-title">📦 Produtos</div>
  <div id="msg3" class="msg"></div>
  <div class="form-row" style="margin-bottom:12px;flex-wrap:wrap">
    <div class="fg"><label>Nome *</label><input type="text" id="pName" placeholder="Ex: Hulk EA v2" style="width:130px"></div>
    <div class="fg"><label>Tipo</label><select id="pType" style="width:120px"><option value="ea">Expert Advisor</option><option value="indicator">Indicador</option><option value="dashboard">Dashboard</option><option value="other">Outro</option></select></div>
    <div class="fg"><label>Preço R$</label><input type="number" id="pPrice" placeholder="99.90" style="width:80px"></div>
    <div class="fg"><label>Trial (dias)</label><input type="number" id="pTrial" value="0" style="width:60px"></div>
    <div class="fg"><label>Lote mín</label><input type="number" id="pMinLots" value="0" step="0.01" style="width:65px"></div>
    <div class="fg"><label>Lote máx</label><input type="number" id="pMaxLots" value="0" step="0.01" style="width:65px"></div>
    <div class="fg"><label>Instâncias</label><input type="number" id="pInst" value="1" min="1" style="width:60px"></div>
    <div class="fg"><label>Descrição</label><input type="text" id="pDesc" style="width:150px"></div>
    <button class="btn" onclick="addProd()">+ Produto</button>
  </div>
  <table><thead><tr><th>ID</th><th>Nome</th><th>Tipo</th><th>Preço</th><th>Trial</th><th>Lotes</th><th>Instâncias</th><th>Ativo</th><th></th></tr></thead>
  <tbody>${prodRows}</tbody></table>
</div>

<div class="card">
  <div class="card-title">👥 Usuários Registrados (${stats.total})</div>
  <div style="overflow-x:auto">
  <table><thead><tr><th>Conta</th><th>Nome / Contato</th><th>Plano</th><th>Expira</th><th>Último acesso</th><th>Senha</th><th>Produtos</th><th>Ações</th></tr></thead>
  <tbody>${rows}</tbody></table>
  </div>
</div>

<script>
const AUTH='Basic '+btoa('${ADMIN_USER}:${ADMIN_PASS}');
const PRODUCTS=${prodsJs};
let _licAcct='',_bonAcct='',_editAcct='',_upAcct='';

function showMsg(id,msg,ok){
  const el=document.getElementById(id);
  if(!el)return;
  el.textContent=msg; el.className='msg '+(ok?'ok':'err'); el.style.display='block';
  setTimeout(()=>el.style.display='none',4000);
}
async function api(method,path,body){
  const r=await fetch(path,{method,headers:{'Content-Type':'application/json','Authorization':AUTH},body:body?JSON.stringify(body):undefined});
  return r.json();
}
function closeModal(id){document.getElementById(id).classList.remove('open');}
function openModal(id){document.getElementById(id).classList.add('open');}

// Licença
function renovarModal(acct,name){
  _licAcct=acct;
  document.getElementById('licAcct').value=acct;
  document.getElementById('licName').value=name||'';
  // Seta data padrão para hoje + 1 mês
  const d=new Date(); d.setMonth(d.getMonth()+1);
  document.getElementById('licDate').value=d.toISOString().split('T')[0];
  openModal('modalLic');
}
function licAddMonths(m){
  const cur=document.getElementById('licDate').value;
  const d=cur?new Date(cur):new Date();
  d.setMonth(d.getMonth()+m);
  document.getElementById('licDate').value=d.toISOString().split('T')[0];
}
async function saveLic(){
  const endDate=document.getElementById('licDate').value;
  const name=document.getElementById('licName').value;
  if(!endDate){showMsg('msgLic','Selecione uma data',false);return;}
  const r=await api('POST','/admin/license',{account:_licAcct,name,endDate});
  if(r.ok){showMsg('msgLic','✅ Licença até '+r.expiresStr,true);setTimeout(()=>location.reload(),1200);}
  else showMsg('msgLic','❌ '+(r.error||'Erro'),false);
}

// Ativar premium rápido
async function ativar(){
  const acct=document.getElementById('iAcc').value;
  const name=document.getElementById('iName').value;
  const months=document.getElementById('iMon').value;
  const endDate=document.getElementById('iDate').value;
  if(!acct){showMsg('msg','⚠️ Conta MT5 obrigatória',false);return;}
  const r=await api('POST','/admin/license',{account:acct,name,months:parseInt(months),endDate:endDate||undefined});
  if(r.ok){showMsg('msg','✅ Premium até '+r.expiresStr,true);setTimeout(()=>location.reload(),1200);}
  else showMsg('msg','❌ '+(r.error||'Erro'),false);
}

// Bônus
function bonusModal(acct,name){
  _bonAcct=acct;
  document.getElementById('bonAcct').value=acct;
  const d=new Date(); d.setDate(d.getDate()+30);
  document.getElementById('bonDate').value=d.toISOString().split('T')[0];
  openModal('modalBonus');
}
function bonAddDays(days){
  const cur=document.getElementById('bonDate').value;
  const d=cur?new Date(cur):new Date();
  d.setDate(d.getDate()+days);
  document.getElementById('bonDate').value=d.toISOString().split('T')[0];
}
async function saveBonus(){
  const endDate=document.getElementById('bonDate').value;
  const type=document.getElementById('bonType').value;
  if(!endDate){showMsg('msgBonus','Selecione uma data',false);return;}
  const r=await api('POST','/admin/manual',{account:_bonAcct,type,endDate});
  if(r.ok){showMsg('msgBonus','✅ Aplicado até '+r.expiresStr,true);setTimeout(()=>location.reload(),1200);}
  else showMsg('msgBonus','❌ '+(r.error||'Erro'),false);
}

// Editar usuário
function editUser(acct,name,email,phone){
  _editAcct=acct;
  document.getElementById('editAcct').value=acct;
  document.getElementById('editName').value=name||'';
  document.getElementById('editEmail').value=email||'';
  document.getElementById('editPhone').value=phone||'';
  openModal('modalEdit');
}
async function saveEdit(){
  const name=document.getElementById('editName').value;
  const email=document.getElementById('editEmail').value;
  const phone=document.getElementById('editPhone').value;
  const r=await api('PUT','/admin/user',{account:_editAcct,name,email,phone});
  if(r.ok){showMsg('msgEdit','✅ Salvo!',true);setTimeout(()=>location.reload(),1000);}
  else showMsg('msgEdit','❌ Erro',false);
}

// Adicionar produto ao usuário
function addUserProd(acct){
  _upAcct=acct;
  document.getElementById('upAcct').value=acct;
  const sel=document.getElementById('upProd');
  sel.innerHTML='<option value="">Selecione...</option>';
  PRODUCTS.forEach(p=>{sel.innerHTML+='<option value="'+p.id+'">'+p.name+'</option>';});
  openModal('modalUserProd');
}
async function saveUserProd(){
  const productId=document.getElementById('upProd').value;
  if(!productId){showMsg('msgUserProd','Selecione um produto',false);return;}
  const r=await api('POST','/admin/user-product',{account:_upAcct,productId});
  if(r.ok){showMsg('msgUserProd','✅ Produto atribuído!',true);setTimeout(()=>location.reload(),1000);}
  else showMsg('msgUserProd','❌ '+(r.error||'Erro'),false);
}

// Revogar
async function revogar(acct){
  if(!confirm('Revogar licença de '+acct+'?'))return;
  const r=await api('DELETE','/admin/license',{account:acct});
  if(r.ok)location.reload();
  else showMsg('msg','❌ Erro',false);
}

// Reset senha
async function resetPw(acct){
  if(!confirm('Resetar senha de '+acct+'? O usuário precisará cadastrar nova senha via MT5.'))return;
  const r=await api('POST','/admin/reset-password',{account:acct});
  if(r.ok)alert('✅ Senha resetada! Usuário deve usar botão [Acessar Dashbot Web] no MT5.');
}

// Remover usuário completamente
async function delUser(acct){
  if(!confirm('⚠️ Remover COMPLETAMENTE o usuário '+acct+'?\nIsso apaga a licença, senha e todos os dados.'))return;
  const r=await api('DELETE','/admin/user',{account:acct});
  if(r.ok)location.reload();
  else alert('❌ Erro ao remover');
}

// Produtos
async function addProd(){
  const name=document.getElementById('pName').value;
  const type=document.getElementById('pType').value;
  if(!name){showMsg('msg3','⚠️ Nome obrigatório',false);return;}
  const r=await api('POST','/admin/products',{
    name,type,
    price:parseFloat(document.getElementById('pPrice').value)||null,
    trialDays:parseInt(document.getElementById('pTrial').value)||0,
    minLots:parseFloat(document.getElementById('pMinLots').value)||0,
    maxLots:parseFloat(document.getElementById('pMaxLots').value)||0,
    instances:parseInt(document.getElementById('pInst').value)||1,
    description:document.getElementById('pDesc').value
  });
  if(r.ok){showMsg('msg3','✅ Produto adicionado!',true);setTimeout(()=>location.reload(),1000);}
  else showMsg('msg3','❌ '+(r.error||'Erro'),false);
}
async function delProd(id){
  if(!confirm('Remover produto?'))return;
  const r=await api('DELETE','/admin/products',{id});
  if(r.ok)location.reload();
}

// Fecha modais clicando fora
document.querySelectorAll('.modal-bg').forEach(bg=>{
  bg.addEventListener('click',function(e){if(e.target===bg)bg.classList.remove('open');});
});
</script></body></html>`;
}

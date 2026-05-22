'use strict';

// Evitar crash por erros não tratados
process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const https  = require('https');
const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ── Configuração ──────────────────────────────────────────────────
const PORT         = process.env.PORT          || 3000;
const MONGO_URI    = process.env.MONGO_URI     || '';
const PROXY_TOKEN  = process.env.DASHBOT_TOKEN || 'dashbot2024';
const ADMIN_USER   = process.env.ADMIN_USER    || 'admin';
const ADMIN_PASS   = process.env.ADMIN_PASS    || 'admin123';
const OFFLINE_SECRET = process.env.OFFLINE_SECRET || 'dashbot_offline_secret_2024';

const TRIAL_DAYS = 14;
const DAY_MS     = 86400000;

const DEFAULT_PRODUCTS = [
  {id:'prod_1000000007',name:'Dashbot', type:'dashboard',description:'Painel de monitoramento',  minLots:0,maxLots:0,instances:1,active:true},
  {id:'prod_1000000001',name:'Hulk',    type:'ea',       description:'Expert Advisor Hulk',       minLots:0,maxLots:0,instances:1,active:true},
  {id:'prod_1000000002',name:'Tornado', type:'ea',       description:'Expert Advisor Tornado',    minLots:0,maxLots:0,instances:1,active:true},
  {id:'prod_1000000003',name:'Adam',    type:'ea',       description:'Expert Advisor Adam',       minLots:0,maxLots:0,instances:1,active:true},
  {id:'prod_1000000004',name:'Snake',   type:'ea',       description:'Expert Advisor Snake',      minLots:0,maxLots:0,instances:1,active:true},
  {id:'prod_1000000005',name:'Kryos',   type:'ea',       description:'Expert Advisor Kryos',      minLots:0,maxLots:0,instances:1,active:true},
  {id:'prod_1000000006',name:'Iron',    type:'ea',       description:'Expert Advisor Iron Robot', minLots:0,maxLots:0,instances:1,active:true},
];

// ── MongoDB ───────────────────────────────────────────────────────
let db = null; // MongoDB database instance

let mongoError = '';

async function connectMongo() {
  if (!MONGO_URI) {
    mongoError = 'MONGO_URI não configurado';
    console.warn('[MongoDB]', mongoError);
    return false;
  }
  try {
    // Verificar se mongodb está instalado
    let MongoClient;
    try {
      MongoClient = require('mongodb').MongoClient;
    } catch(e) {
      mongoError = 'Pacote mongodb não instalado. Adicione ao package.json: npm install mongodb';
      console.error('[MongoDB]', mongoError);
      return false;
    }
    console.log('[MongoDB] Conectando...');
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    db = client.db('dashbot');
    await db.collection('licenses').createIndex({ account: 1 }, { unique: true });
    await db.collection('auth').createIndex({ key: 1 }, { unique: true });
    await db.collection('cmd').createIndex({ key: 1 }, { unique: true });
    await db.collection('robots').createIndex({ magic: 1, account: 1 }, { unique: true });
    await db.collection('robots').createIndex({ lastSeen: 1 });
    console.log('[MongoDB] Conectado com sucesso!');
    mongoError = '';
    await ensureProducts();
    return true;
  } catch(e) {
    mongoError = e.message;
    console.error('[MongoDB] Erro:', e.message);
    return false;
  }
}

async function ensureProducts() {
  if (!db) return;
  const col = db.collection('products');
  for (const p of DEFAULT_PRODUCTS) {
    await col.updateOne({ id: p.id }, { $setOnInsert: p }, { upsert: true });
  }
}

// ── Cache em memória (fallback e performance) ─────────────────────
let _licsCache = null;
let _licsTime  = 0;
let _authCache = { users: {}, tokens: {} };
const CACHE_TTL = 300000; // 5 minutos

// ── Operações de licença ──────────────────────────────────────────
async function getLics() {
  if (_licsCache && Date.now() - _licsTime < CACHE_TTL) return _licsCache;
  if (!db) return _licsCache || { _products: DEFAULT_PRODUCTS };
  try { // eslint-disable-line
    const docs = await db.collection('licenses').find({}).toArray();
    const lics = { _products: [] };
    docs.forEach(doc => {
      const { _id, ...rest } = doc;
      lics[doc.account] = rest;
    });
    // Produtos do catálogo
    const prods = await db.collection('products').find({}).toArray();
    lics._products = prods.map(({ _id, ...p }) => p);
    if (!lics._products.length) lics._products = DEFAULT_PRODUCTS;
    _licsCache = lics;
    _licsTime  = Date.now();
    return lics;
  } catch(e) {
    console.error('[getLics]', e.message);
    return _licsCache || { _products: DEFAULT_PRODUCTS };
  }
}

async function saveLics(lics) {
  _licsCache = lics;
  _licsTime  = Date.now();
  if (!db) return true;
  try {
    const ops = [];
    for (const [key, val] of Object.entries(lics)) {
      if (key === '_products') continue;
      ops.push({
        updateOne: {
          filter: { account: key },
          update: { $set: { ...val, account: key } },
          upsert: true
        }
      });
    }
    if (ops.length) await db.collection('licenses').bulkWrite(ops);
    return true;
  } catch(e) {
    console.error('[saveLics]', e.message);
    return false;
  }
}

async function deleteLic(account) {
  if (!db) return true;
  try {
    await db.collection('licenses').deleteOne({ account });
    if (_licsCache) delete _licsCache[account];
    return true;
  } catch(e) { return false; }
}

// ── Auth ──────────────────────────────────────────────────────────
async function getAuth() {
  if (!db) return _authCache;
  try {
    const doc = await db.collection('auth').findOne({ key: 'main' });
    if (doc) { const { _id, key, ...rest } = doc; _authCache = rest; }
    if (!_authCache.users)  _authCache.users  = {};
    if (!_authCache.tokens) _authCache.tokens = {};
    return _authCache;
  } catch(e) { return _authCache; }
}

async function saveAuth(data) {
  _authCache = data;
  if (!db) return true;
  try {
    await db.collection('auth').updateOne(
      { key: 'main' },
      { $set: { key: 'main', ...data } },
      { upsert: true }
    );
    return true;
  } catch(e) { console.error('[saveAuth]', e.message); return false; }
}

// ── CMD (comandos DashBot) — roteado por magic number ────────────
// key = 'magic_<magic>' para comandos direcionados a um robo especifico
// key = 'account_<account>' para comandos broadcast para todos robos da conta
async function getCmd(account, magic) {
  if (!db) return { cmd: 'none' };
  try {
    // Prioridade: comando especifico para este magic > broadcast para a conta
    if (magic) {
      const specific = await db.collection('cmd').findOne({ key: 'magic_'+magic });
      if (specific && specific.cmd && specific.cmd !== 'none') {
        return { cmd: specific.cmd, magic: String(magic) };
      }
    }
    if (account) {
      const broadcast = await db.collection('cmd').findOne({ key: 'account_'+account });
      if (broadcast && broadcast.cmd && broadcast.cmd !== 'none') {
        return { cmd: broadcast.cmd, magic: null };
      }
    }
    return { cmd: 'none' };
  } catch(e) { return { cmd: 'none' }; }
}

async function saveCmd(payload, account, magic) {
  if (!db) return true;
  try {
    // Salvar com chave especifica (por magic) ou broadcast (por conta)
    const key = magic ? 'magic_'+magic : (account ? 'account_'+account : 'main');
    await db.collection('cmd').updateOne(
      { key },
      { $set: { key, ...payload, updatedAt: Date.now() } },
      { upsert: true }
    );
    return true;
  } catch(e) { return false; }
}

// Limpar comando apos o robo confirmar execucao
async function clearCmd(account, magic) {
  if (!db) return;
  try {
    const ops = [];
    if (magic)   ops.push(db.collection('cmd').updateOne({ key:'magic_'+magic },   { $set:{ cmd:'none' } }));
    if (account) ops.push(db.collection('cmd').updateOne({ key:'account_'+account },{ $set:{ cmd:'none' } }));
    await Promise.all(ops);
  } catch(e) {}
}

// ── Long-poll: waiters map ────────────────────────────────────────
// key = "magic_<magic>" or "account_<account>" → array of {res, timer}
const cmdWaiters = new Map();

function notifyWaiters(key, payload) {
  const waiters = cmdWaiters.get(key) || [];
  cmdWaiters.delete(key);
  for (const w of waiters) {
    clearTimeout(w.timer);
    if (!w.res.writableEnded) sendJSON(w.res, 200, payload);
  }
}

function addWaiter(key, res, timeoutMs = 25000) {
  if (!cmdWaiters.has(key)) cmdWaiters.set(key, []);
  const timer = setTimeout(() => {
    const list = cmdWaiters.get(key) || [];
    const idx = list.findIndex(w => w.res === res);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) cmdWaiters.delete(key);
    if (!res.writableEnded) sendJSON(res, 200, { cmd: 'none' });
  }, timeoutMs);
  cmdWaiters.get(key).push({ res, timer });
  // Clean up if client disconnects
  res.on('close', () => {
    const list = cmdWaiters.get(key) || [];
    const idx = list.findIndex(w => w.res === res);
    if (idx >= 0) { clearTimeout(list[idx].timer); list.splice(idx, 1); }
    if (list.length === 0) cmdWaiters.delete(key);
  });
}

// ── Produtos ──────────────────────────────────────────────────────
async function getProducts() {
  if (!db) return DEFAULT_PRODUCTS;
  try {
    const prods = await db.collection('products').find({}).toArray();
    return prods.length ? prods.map(({ _id, ...p }) => p) : DEFAULT_PRODUCTS;
  } catch(e) { return DEFAULT_PRODUCTS; }
}

async function saveProduct(prod) {
  if (!db) return true;
  try {
    await db.collection('products').updateOne(
      { id: prod.id },
      { $set: prod },
      { upsert: true }
    );
    return true;
  } catch(e) { return false; }
}

// ── Helpers ───────────────────────────────────────────────────────
function hashPw(pw)     { return crypto.createHash('sha256').update(pw+'dashbot_salt_2024').digest('hex'); }
function genToken(acct) { return crypto.createHash('sha256').update(acct+'_'+Date.now()+'_'+Math.random()).digest('hex'); }
function ptDate(ms)     { return new Date(ms).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'}); }

function checkLic(lic) {
  const now = Date.now();
  if (!lic) return { valid:false, plan:'none', expired:true };
  if (lic.type === 'lifetime') return { valid:true, plan:'lifetime', daysLeft:99999 };
  if (lic.type === 'premium') {
    if (lic.premiumEnd && now < lic.premiumEnd)
      return { valid:true, plan:'premium', daysLeft:Math.ceil((lic.premiumEnd-now)/DAY_MS) };
    return { valid:false, plan:'expired', expired:true };
  }
  if (lic.type === 'revoked') return { valid:false, plan:'revoked', expired:true };
  const trialEnd = lic.trialEnd || ((lic.trialStart||now) + TRIAL_DAYS*DAY_MS);
  if (now < trialEnd) return { valid:true, plan:'trial', daysLeft:Math.ceil((trialEnd-now)/DAY_MS) };
  return { valid:false, plan:'expired', expired:true };
}

async function verifySession(token) {
  if (!token) return null;
  const auth = await getAuth();
  for (const k of Object.keys(auth.tokens||{})) {
    const t = auth.tokens[k];
    if (t.token===token && t.type==='session' && t.expires>Date.now()) return t;
  }
  return null;
}

function readBody(req) {
  return new Promise(r => { let b=''; req.on('data',c=>b+=c); req.on('end',()=>r(b)); });
}

const CORS = {
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type,Authorization,X-Dashbot-Token,X-Auth-Token'
};
function sendJSON(res,code,obj) {
  const b=JSON.stringify(obj);
  res.writeHead(code,{...CORS,'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)});
  res.end(b);
}
function sendHTML(res,html) {
  res.writeHead(200,{...CORS,'Content-Type':'text/html;charset=utf-8'});
  res.end(html);
}
function adminAuth(req) {
  const a=req.headers['authorization']||'';
  if(!a.startsWith('Basic ')) return false;
  const [u,p]=Buffer.from(a.slice(6),'base64').toString().split(':');
  return u===ADMIN_USER && p===ADMIN_PASS;
}

// ── buildAdminHTML ────────────────────────────────────────────────
function buildAdminHTML(rows,stats,prodRows,productsJson) {
  const adminFile = path.join(__dirname, 'admin.html');
  let html;
  try { html = fs.readFileSync(adminFile,'utf-8'); }
  catch(e) { return '<h1 style="color:red;padding:20px">admin.html nao encontrado</h1>'; }
  const bootstrap = '<script id="db-data">window.__ROWS__='+JSON.stringify(rows)+';window.__STATS__='+JSON.stringify(stats)+';window.__PRODS__='+(productsJson||'[]')+';<\/script>';
  return html.replace('</body>', bootstrap+'\n</body>');
}

// ── HTTP Server ───────────────────────────────────────────────────
http.createServer(async(req,res)=>{
  const parsed  = new URL(req.url,'http://localhost');
  const reqPath = parsed.pathname;
  const qs      = parsed.searchParams;
  const method  = req.method.toUpperCase();

  if(method==='OPTIONS'){res.writeHead(204,CORS);res.end();return;}

  if(reqPath==='/health'||reqPath==='/ping'){
    sendJSON(res,200,{status:'ok',service:'Dashbot Server v3 (MongoDB)',mongo:!!db,ts:Date.now()});return;
  }

  // ── Status ────────────────────────────────────────────────────
  if(reqPath==='/status'){
    sendJSON(res,200,{
      ok:true,
      storage: db ? 'MongoDB Atlas' : 'Memoria',
      mongo_connected: !!db,
      mongo_error: mongoError||null,
      config:{
        MONGO_URI: MONGO_URI ? 'configurado ('+MONGO_URI.substring(0,30)+'...)' : 'NAO CONFIGURADO',
        ADMIN_USER, DASHBOT_TOKEN:PROXY_TOKEN
      },
      missing: !MONGO_URI ? ['MONGO_URI'] : (!db ? ['Verifique mongo_error'] : [])
    });return;
  }

  // ── validate-product (robô) ───────────────────────────────────
  if(reqPath==='/validate-product'){
    const account   = qs.get('account')||'';
    const productId = qs.get('product')||'';
    const token     = qs.get('token')||'';
    const accountType = qs.get('type')||'';
    if(token!==PROXY_TOKEN){sendJSON(res,401,{valid:false,error:'Token inválido'});return;}
    if(!account||!productId){sendJSON(res,400,{valid:false,error:'account e product obrigatórios'});return;}
    const lics = await getLics();
    const now2 = Date.now();
    const catalogProd = (lics._products||[]).find(p=>p.id===productId);
    if(!catalogProd){sendJSON(res,403,{valid:false,error:'Produto "'+productId+'" não encontrado.'});return;}
    if(catalogProd.active===false){sendJSON(res,403,{valid:false,error:'Produto desativado.'});return;}

    // Buscar licença e produto:
    // 1. Tentar pela conta principal (lics[account])
    // 2. Se não encontrar, varrer todos os usuários que têm este produto
    //    atribuído para esta conta (accountReal ou accountDemo)
    let lic = lics[account];
    let userProd = null;

    function findProd(licObj){
      return (licObj.products||[]).find(p=>{
        if(p.id!==productId) return false;
        if(accountType && p.accountType && p.accountType!==accountType) return false;
        // Verificar se a conta bate (accountReal, accountDemo, ou conta principal)
        const pReal=(p.accountReal||'').toString();
        const pDemo=(p.accountDemo||'').toString();
        const accStr=String(account);
        if(pReal||pDemo){
          if(p.accountType==='real' && pReal && pReal!==accStr) return false;
          if(p.accountType==='demo' && pDemo && pDemo!==accStr) return false;
          if(p.accountType!=='real' && p.accountType!=='demo'){
            if(pReal && pReal!==accStr && pDemo && pDemo!==accStr) return false;
          }
        }
        // Verificar expiração individual do produto
        if(p.expiry && p.expiry!=='lifetime'){
          let ed=p.expiry;
          const mBR=ed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
          if(mBR) ed=mBR[3]+'-'+mBR[2]+'-'+mBR[1];
          if(new Date(ed+' 23:59:59').getTime()<now2) return false;
        }
        return true;
      });
    }

    if(lic){
      userProd = findProd(lic);
    }

    // Se não encontrou pela conta principal, buscar por conta atribuída
    if(!userProd){
      try {
        const accStr=String(account);
        for(const k of Object.keys(lics)){
          if(k.startsWith('_')||k===accStr) continue;
          const candidate=lics[k];
          if(!candidate||typeof candidate!=='object') continue;
          // Verificação rápida: tem algum produto com esta conta?
          const prods=candidate.products||[];
          const hasAcc=prods.some(p=>
            p.id===productId &&
            (String(p.accountReal||'')=== accStr ||
             String(p.accountDemo||'')=== accStr)
          );
          if(!hasAcc) continue;
          const found=findProd(candidate);
          if(found){
            const cs=checkLic(candidate);
            if(cs.valid){lic=candidate;userProd=found;break;}
          }
        }
      } catch(e){console.error('[validate-product loop]',e.message);}
    }

    if(!lic){
      sendJSON(res,403,{valid:false,error:'Conta '+account+' não encontrada. Adquira uma licença em www.investidorbot.com'});return;
    }
    const s = checkLic(lic);
    if(!s.valid){sendJSON(res,403,{valid:false,error:'Licença expirada. Renove em www.investidorbot.com',plan:s.plan});return;}

    if(!userProd){
      // Verificar se o produto existe mas expirou
      const anyProd=(lic.products||[]).find(p=>p.id===productId);
      if(anyProd){
        sendJSON(res,403,{valid:false,error:'Licença do produto "'+catalogProd.name+'" expirada. Renove em www.investidorbot.com'});
      } else {
        sendJSON(res,403,{valid:false,error:'Produto "'+catalogProd.name+'" não licenciado para esta conta.'});
      }
      return;
    }
    // -- Validar expiração por produto (userProd.expiry) ----------
    if(userProd.expiry && userProd.expiry !== 'lifetime') {
      const prodExp = new Date(userProd.expiry + 'T23:59:59').getTime();
      if(Date.now() > prodExp) {
        sendJSON(res,403,{valid:false,error:'Licença expirada. Renove sua licença em www.investidorbot.com',plan:'expired'});
        return;
      }
    }

    // Atualizar lastSeen
    lic.lastSeen=now2;
    saveLics(lics).catch(()=>{});
    // daysLeft: usar o menor entre licença global e expiração do produto
    let effectiveDaysLeft = s.daysLeft;
    if(userProd.expiry && userProd.expiry !== 'lifetime') {
      const prodExp = new Date(userProd.expiry + 'T23:59:59').getTime();
      const prodDays = Math.ceil((prodExp - Date.now()) / (24*60*60*1000));
      if(prodDays < effectiveDaysLeft) effectiveDaysLeft = prodDays;
    }

    sendJSON(res,200,{
      valid:true,plan:s.plan,daysLeft:effectiveDaysLeft,account,productId,
      productName:catalogProd.name,
      minLots:parseFloat(userProd.minLots)||parseFloat(catalogProd.minLots)||0,
      maxLots:parseFloat(userProd.maxLots)||parseFloat(catalogProd.maxLots)||0,
      instances:(userProd.instances!==undefined&&userProd.instances!==null&&userProd.instances!=="")?parseInt(userProd.instances):parseInt(catalogProd.instances)||1,
      accountType:userProd.accountType||'',
      accountReal:userProd.accountReal||'',accountDemo:userProd.accountDemo||'',
      expiry:userProd.expiry||null,
      premiumEnd:lic.premiumEnd||null,
      message:'Licença ativa — '+catalogProd.name
    });return;
  }

  // ── validate-key (offline) ────────────────────────────────────
  if(reqPath==='/validate-key'&&method==='POST'){
    const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{valid:false,error:'JSON inválido'});return;}
    const {account,productId,key,accountType}=d;
    if(!account||!productId||!key){sendJSON(res,400,{valid:false,error:'Campos obrigatórios'});return;}
    try{
      const keyBytes=Buffer.from(key,'base64');const raw=keyBytes.toString('utf8');
      const parts=raw.split('|');if(parts.length<5){sendJSON(res,400,{valid:false,error:'Chave inválida'});return;}
      const [kProd,kAcct,kType,expiry,sig]=parts;
      if(kProd!==productId){sendJSON(res,403,{valid:false,error:'Chave para outro produto'});return;}
      if(kAcct!==String(account)){sendJSON(res,403,{valid:false,error:'Chave para outra conta'});return;}
      if(kType!==accountType){sendJSON(res,403,{valid:false,error:'Chave para tipo de conta diferente'});return;}
      const payload=kProd+'|'+kAcct+'|'+kType+'|'+expiry;
      const expected=crypto.createHmac('sha256',OFFLINE_SECRET).update(payload).digest('hex').substring(0,16);
      if(sig!==expected){sendJSON(res,403,{valid:false,error:'Assinatura inválida'});return;}
      if(expiry!=='lifetime'){const exp=new Date(expiry+' 23:59:59').getTime();if(Date.now()>exp){sendJSON(res,403,{valid:false,error:'Chave expirada em '+expiry});return;}}
      const lics=await getLics();const catProd=(lics._products||[]).find(p=>p.id===productId);
      sendJSON(res,200,{valid:true,plan:expiry==='lifetime'?'lifetime':'premium',account,productId,productName:catProd?catProd.name:productId,minLots:catProd?catProd.minLots:0,maxLots:catProd?catProd.maxLots:0,instances:catProd?catProd.instances:1});
    }catch(e){sendJSON(res,500,{valid:false,error:e.message});}
    return;
  }

  // ── command (DashBot MQ5) ─────────────────────────────────────
  if(reqPath==='/command'){
    const tok=qs.get('token')||req.headers['x-auth-token']||'';
    const qAccount=qs.get('account')||'';
    const qMagic=qs.get('magic')||'';
    if(tok!==PROXY_TOKEN){const sess=await verifySession(tok);if(!sess){sendJSON(res,401,{error:'Não autorizado'});return;}}
    if(method==='GET'){
      // Robo consulta com long-poll:
      // 1. Se ja tem comando pendente → responder imediatamente
      // 2. Se nao tem → segurar a conexao ate 25s; responder quando chegar comando ou timeout
      const c = await getCmd(qAccount, qMagic);
      if (c.cmd && c.cmd !== 'none') {
        sendJSON(res, 200, c);
        return;
      }
      // Nao ha comando — registrar waiter
      const waiterKey = qMagic ? 'magic_'+qMagic : 'account_'+qAccount;
      addWaiter(waiterKey, res, 25000);
      return; // resposta enviada pelo timeout ou por notifyWaiters()
    }
    if(method==='POST'){
      const body=await readBody(req);let payload;
      try{payload=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      // Normalizar comando
      if(payload.cmd){
        const c=payload.cmd.toLowerCase().trim();
        if(['iniciar','play','start','resume'].includes(c)) payload.cmd='iniciar';
        else if(['pausar','pause','stop'].includes(c)) payload.cmd='pausar';
        else if(['zerar','fechar','close','closeall'].includes(c)) payload.cmd='zerar';
        else if(['none','reset','clear'].includes(c)) payload.cmd='none';
      }
      // Se robo esta confirmando execucao (cmd=none), limpar slot
      if(payload.cmd==='none'){
        const pMagic=payload.magic||qMagic;
        const pAccount=payload.account||qAccount;
        await clearCmd(pAccount,pMagic);
        sendJSON(res,200,{ok:true,cmd:'none'});return;
      }
      // Dashboard enviando novo comando — salvar e notificar robos em espera
      const targetMagic=payload.magic||qMagic||null;
      const targetAccount=payload.account||qAccount||null;
      const ok=await saveCmd(payload,targetAccount,targetMagic);
      // Notificar imediatamente qualquer robo em long-poll aguardando este comando
      if(ok){
        const notifyPayload={cmd:payload.cmd,magic:targetMagic};
        if(targetMagic) notifyWaiters('magic_'+targetMagic, notifyPayload);
        else if(targetAccount) notifyWaiters('account_'+targetAccount, notifyPayload);
      }
      sendJSON(res,ok?200:500,{ok,cmd:payload.cmd,magic:targetMagic,account:targetAccount});return;
    }
  }

  // ── telemetry (recebe estado dos robos em tempo real) ────────────
  if(reqPath==='/telemetry'){
    const tok=qs.get('token')||req.headers['x-auth-token']||'';
    if(tok!==PROXY_TOKEN){const sess=await verifySession(tok);if(!sess){sendJSON(res,401,{error:'Não autorizado'});return;}}
    if(method==='POST'){
      const body=await readBody(req);let data;
      try{data=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      if(!data.magic){sendJSON(res,400,{error:'magic obrigatório'});return;}
      if(!db){sendJSON(res,200,{ok:true});return;}
      try{
        await db.collection('robots').updateOne(
          { magic: String(data.magic), account: String(data.account||'') },
          { $set: { ...data, magic: String(data.magic), account: String(data.account||''), lastSeen: Date.now() } },
          { upsert: true }
        );
        sendJSON(res,200,{ok:true});
      }catch(e){sendJSON(res,500,{error:e.message});}
      return;
    }
    sendJSON(res,405,{error:'Método não suportado'});return;
  }

  // ── robots (lista robos ativos para a Dashboard) ──────────────
  if(reqPath==='/robots'){
    const tok=qs.get('token')||req.headers['x-auth-token']||'';
    const sessCheck=await verifySession(tok);
    if(tok!==PROXY_TOKEN&&!sessCheck){sendJSON(res,401,{error:'Não autorizado'});return;}
    if(method==='GET'){
      if(!db){sendJSON(res,200,{robots:[]});return;}
      try{
        const qAccount=qs.get('account')||'';
        const cutoff=Date.now()-30000; // robos vistos nos ultimos 30s
        const filter={lastSeen:{$gt:cutoff}};
        if(qAccount) filter.account=String(qAccount);
        const docs=await db.collection('robots').find(filter).toArray();
        sendJSON(res,200,{robots:docs.map(d=>{delete d._id;return d;})});
      }catch(e){sendJSON(res,500,{error:e.message});}
      return;
    }
    sendJSON(res,405,{error:'Método não suportado'});return;
  }

  // ── auth/* ────────────────────────────────────────────────────
  if(reqPath==='/auth/check'){
    const account=qs.get('account')||'';
    if(!account){sendJSON(res,400,{error:'account obrigatório'});return;}
    const lics=await getLics();const lic=lics[account];
    if(!lic){sendJSON(res,404,{error:'Conta não encontrada'});return;}
    const s=checkLic(lic);const db2=await getAuth();
    const hasPassword=!!db2.users?.[account];
    if(!hasPassword){
      const setupToken=genToken(account);
      if(!db2.tokens)db2.tokens={};
      db2.tokens['setup_'+account]={token:setupToken,account,expires:Date.now()+600000,type:'setup'};
      await saveAuth(db2);
      sendJSON(res,200,{hasPassword:false,setupToken,account,plan:s.plan});
    } else {
      sendJSON(res,200,{hasPassword:true,account,plan:s.plan});
    }
    return;
  }

  if(reqPath==='/auth/setup-password'&&method==='POST'){
    const body=await readBody(req);let data;try{data=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
    const{setupToken,password}=data;if(!setupToken||!password){sendJSON(res,400,{error:'Campos obrigatórios'});return;}
    const db2=await getAuth();let account=null;
    for(const k of Object.keys(db2.tokens||{})){
      const t=db2.tokens[k];
      if(t.token===setupToken&&t.type==='setup'&&t.expires>Date.now()){account=t.account;delete db2.tokens[k];break;}
    }
    if(!account){sendJSON(res,400,{error:'Token inválido ou expirado'});return;}
    if(!db2.users)db2.users={};
    db2.users[account]={passwordHash:hashPw(password),createdAt:Date.now()};
    await saveAuth(db2);sendJSON(res,200,{ok:true,account});return;
  }

  if(reqPath==='/auth/login'&&method==='POST'){
    const body=await readBody(req);let data;try{data=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
    const{account,password}=data;
    const db2=await getAuth();const user=db2.users?.[account];
    if(!user||user.passwordHash!==hashPw(password)){sendJSON(res,401,{error:'Credenciais inválidas'});return;}
    const token=genToken(account);
    if(!db2.tokens)db2.tokens={};
    db2.tokens['session_'+account+'_'+Date.now()]={token,account,expires:Date.now()+7*DAY_MS,type:'session'};
    await saveAuth(db2);sendJSON(res,200,{ok:true,token,account});return;
  }

  if(reqPath==='/auth/verify'){
    const tok=req.headers['x-auth-token']||qs.get('token')||'';
    const sess=await verifySession(tok);
    if(!sess){sendJSON(res,401,{valid:false});return;}
    const lics=await getLics();const s=checkLic(lics[sess.account]);
    sendJSON(res,200,{valid:true,account:sess.account,plan:s.plan});return;
  }

  // ── Admin ─────────────────────────────────────────────────────
  if(reqPath.startsWith('/admin')){
    if(!adminAuth(req)){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Dashbot Admin"',...CORS});res.end('Não autorizado');return;}

    if((reqPath==='/admin'||reqPath==='/admin/')&&method==='GET'){
      const lics=await getLics();const now=Date.now();
      let rows='';let stats={total:0,premium:0,trial:0,expired:0,active:0,lifetime:0};
      for(const[acct,lic]of Object.entries(lics)){
        if(acct.startsWith('_'))continue;
        const s=checkLic(lic);stats.total++;
        if(s.plan==='lifetime')stats.lifetime=(stats.lifetime||0)+1;
        else if(s.plan==='premium')stats.premium++;
        else if(s.plan==='trial')stats.trial++;
        else stats.expired++;
        if(lic.lastSeen&&now-lic.lastSeen<7*DAY_MS)stats.active++;
        const bc=s.plan==='lifetime'?'#7c3aed':s.plan==='premium'?'#10b981':s.plan==='trial'?'#3b82f6':'#ef4444';
        const userProds=(lic.products||[]).map(p=>'<span style="background:#1e2438;padding:2px 6px;border-radius:4px;font-size:10px;margin:1px;display:inline-block">'+p.name+(p.accountType?'('+p.accountType+')':'')+'</span>').join('');
        const endDate=s.plan==='lifetime'?'Vitalícia':s.plan==='premium'?ptDate(lic.premiumEnd):s.plan==='trial'?ptDate(lic.trialEnd):'—';
        rows+='<tr>'
          +'<td><code>'+acct+'</code></td>'
          +'<td>'+(lic.name||'—')+'<br><small style="color:#64748b">'+(lic.email||'')+' '+(lic.phone||'')+'</small></td>'
          +'<td><span class="badge" style="background:'+bc+'">'+s.plan+'</span></td>'
          +'<td>'+endDate+'</td>'
          +'<td>'+(lic.lastSeen?new Date(lic.lastSeen).toLocaleDateString('pt-BR'):'—')+'</td>'
          +'<td>'+(userProds||'—')+'<br><button class="btn-sm" onclick="addUserProd(\''+acct+'\')">+ Produto</button></td>'
          +'<td>'
          +'<button class="btn-sm" onclick="editUser(\''+acct+'\',\''+encodeURIComponent(lic.name||'')+'\',\''+encodeURIComponent(lic.email||'')+'\',\''+encodeURIComponent(lic.phone||'')+'\')">&#x270F;&#xFE0F;</button> '
          +'<button class="btn-sm" onclick="bonusModal(\''+acct+'\',\''+encodeURIComponent(lic.name||'')+'\')">&#x1F4C5; Licenca</button> '
          +'<button class="btn-sm btn-red" onclick="revogar(\''+acct+'\')">&#x1F6AB;</button> '
          +'<button class="btn-sm" onclick="resetPw(\''+acct+'\')">&#x21BA;</button> '
          +'<button class="btn-sm btn-red" onclick="delUser(\''+acct+'\')">&#x1F5D1;</button>'
          +'</td></tr>';
      }
      const products=await getProducts();
      const prodRows=products.map(p=>'<tr><td><code style="font-size:10px">'+p.id+'</code></td><td><strong>'+p.name+'</strong></td><td>'+p.type+'</td><td>'+(p.minLots||0)+'</td><td>'+(p.maxLots||0)+'</td><td>'+(p.instances||1)+'</td><td style="color:#8b949e">'+(p.description||'—')+'</td></tr>').join('')||'<tr><td colspan="7" style="color:#8b949e;text-align:center;padding:16px">Nenhum produto</td></tr>';
      sendHTML(res,buildAdminHTML(rows,stats,prodRows,JSON.stringify(products)));return;
    }

    if(reqPath==='/admin/users-json'&&method==='GET'){
      const lics=await getLics();const now=Date.now();
      const users=[];let stats={total:0,premium:0,trial:0,expired:0,active:0,lifetime:0};
      for(const[acct,lic]of Object.entries(lics)){
        if(acct.startsWith('_'))continue;
        const s=checkLic(lic);stats.total++;
        if(s.plan==='lifetime')stats.lifetime=(stats.lifetime||0)+1;
        else if(s.plan==='premium')stats.premium++;
        else if(s.plan==='trial')stats.trial++;
        else stats.expired++;
        if(lic.lastSeen&&now-lic.lastSeen<7*DAY_MS)stats.active++;
        const endDate=s.plan==='lifetime'?'Vitalicia':s.plan==='premium'?ptDate(lic.premiumEnd):s.plan==='trial'?ptDate(lic.trialEnd):'—';
        users.push({account:acct,name:lic.name||'',email:lic.email||'',phone:lic.phone||'',plan:s.plan,endDate,lastSeen:lic.lastSeen?new Date(lic.lastSeen).toLocaleDateString('pt-BR'):'—',products:lic.products||[]});
      }
      sendJSON(res,200,{ok:true,users,stats});return;
    }

    if(reqPath==='/admin/register'&&method==='POST'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      if(!d.account){sendJSON(res,400,{error:'Conta MT5 obrigatória'});return;}
      const lics=await getLics();const now=Date.now();const key=String(d.account);
      const existing=lics[key];
      const initProds=existing&&existing.products?[...existing.products]:[];
      if(d.products&&Array.isArray(d.products)){
        d.products.forEach(up=>{
          const catProd=(lics._products||[]).find(p=>p.id===up.productId);
          const prodName=catProd?catProd.name:(up.name||up.productId);
          const idx=initProds.findIndex(p=>p.id===up.productId);
          const entry={id:up.productId,name:prodName,assignedAt:now,accountType:up.accountType||'',accountReal:up.accountReal||'',accountDemo:up.accountDemo||'',minLots:parseFloat(up.minLots)||0,maxLots:parseFloat(up.maxLots)||0,instances:parseInt(up.instances)||1};
          if(idx>=0)initProds[idx]=entry;else initProds.push(entry);
        });
      }
      let type='trial',premiumEnd=null;
      const trialEnd=(existing&&existing.trialEnd)||(now+TRIAL_DAYS*DAY_MS);
      if(d.lifetime){type='lifetime';}
      else if(d.endDate){
        type='premium';
        let ed=d.endDate;
        const mBR=ed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if(mBR) ed=mBR[3]+'-'+mBR[2]+'-'+mBR[1];
        premiumEnd=new Date(ed+' 23:59:59').getTime();
      }
      else if(existing&&(existing.type==='premium'||existing.type==='lifetime')){type=existing.type;premiumEnd=existing.premiumEnd||null;}
      lics[key]={...(existing||{}),account:key,name:d.name||(existing&&existing.name)||'',email:d.email||(existing&&existing.email)||'',phone:d.phone||(existing&&existing.phone)||'',type,trialStart:(existing&&existing.trialStart)||now,trialEnd,premiumStart:type==='premium'?((existing&&existing.premiumStart)||now):(existing&&existing.premiumStart),premiumEnd,firstSeen:(existing&&existing.firstSeen)||now,lastSeen:(existing&&existing.lastSeen)||0,products:initProds};
      const ok=await saveLics(lics);
      if(!ok){sendJSON(res,500,{ok:false,error:'Falha ao salvar no banco. Verifique MONGO_URI.'});return;}
      sendJSON(res,200,{ok:true,account:key,updated:!!existing});return;
    }

    if(reqPath==='/admin/license'&&method==='POST'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      if(!d.account){sendJSON(res,400,{error:'Conta obrigatória'});return;}
      const lics=await getLics();const now=Date.now();const key=String(d.account);const ex=lics[key]||{};
      let end,type='premium';
      if(d.lifetime){type='lifetime';end=null;}
      else if(d.endDate){
        // Suportar dd/mm/yyyy e yyyy-mm-dd
        let ed=d.endDate;
        const mBR=ed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if(mBR) ed=mBR[3]+'-'+mBR[2]+'-'+mBR[1];
        end=new Date(ed+' 23:59:59').getTime();
      }
      else{const base=(ex&&ex.premiumEnd&&ex.premiumEnd>now)?ex.premiumEnd:now;end=base+(parseInt(d.months)||1)*30*DAY_MS;}
      lics[key]={...(ex||{}),account:key,name:d.name||ex.name||'',type,trialStart:ex.trialStart||now,trialEnd:ex.trialEnd||(now+TRIAL_DAYS*DAY_MS),premiumStart:ex.premiumStart||now,premiumEnd:end,lastSeen:ex.lastSeen||now,firstSeen:ex.firstSeen||now};
      const ok=await saveLics(lics);
      sendJSON(res,ok?200:500,{ok,expiresStr:end?ptDate(end):'Vitalícia'});return;
    }

    if(reqPath==='/admin/license'&&method==='DELETE'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const lics=await getLics();const key=String(d.account);
      if(lics[key]){lics[key].type='revoked';lics[key].premiumEnd=0;lics[key].trialEnd=0;}
      sendJSON(res,await saveLics(lics)?200:500,{ok:true});return;
    }

    if(reqPath==='/admin/user'&&method==='DELETE'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const lics=await getLics();const key=String(d.account);
      delete lics[key];
      const ok1=await saveLics(lics);
      const ok2=await deleteLic(key);
      const db2=await getAuth();delete db2.users?.[key];await saveAuth(db2);
      sendJSON(res,(ok1||ok2)?200:500,{ok:true});return;
    }

    if(reqPath==='/admin/user'&&method==='PUT'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const lics=await getLics();const key=String(d.account);
      if(!lics[key]){sendJSON(res,404,{error:'Conta não encontrada'});return;}
      if(d.name)lics[key].name=d.name;if(d.email)lics[key].email=d.email;if(d.phone)lics[key].phone=d.phone;
      sendJSON(res,await saveLics(lics)?200:500,{ok:true});return;
    }

    if(reqPath==='/admin/user-product'&&method==='POST'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const lics=await getLics();const key=String(d.account);const now=Date.now();
      if(!lics[key]){lics[key]={account:key,type:'trial',trialStart:now,trialEnd:now+TRIAL_DAYS*DAY_MS,firstSeen:now,lastSeen:0,products:[]};}
      if(!lics[key].products)lics[key].products=[];
      // Chave única por linha: productId + accountType + conta (real ou demo)
      const contaKey=(d.accountType==='real'?d.accountReal:d.accountDemo)||'';
      const idx=lics[key].products.findIndex(p=>{
        const pConta=(p.accountType==='real'?p.accountReal:p.accountDemo)||'';
        return p.id===d.productId&&(p.accountType||'')===(d.accountType||'')&&pConta===contaKey;
      });
      const entry={id:d.productId,name:d.name||d.productId,assignedAt:now,accountType:d.accountType||'',accountReal:d.accountReal||'',accountDemo:d.accountDemo||'',minLots:parseFloat(d.minLots)||0,maxLots:parseFloat(d.maxLots)||0,instances:parseInt(d.instances)||1,expiry:d.expiry||''};
      if(idx>=0)lics[key].products[idx]=entry;else lics[key].products.push(entry);
      sendJSON(res,await saveLics(lics)?200:500,{ok:true});return;
    }

    // Substitui TODA a lista de produtos de uma vez (usado na edição)
    if(reqPath==='/admin/user-products'&&method==='POST'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const lics=await getLics();const key=String(d.account);const now=Date.now();
      if(!lics[key]){lics[key]={account:key,type:'trial',trialStart:now,trialEnd:now+TRIAL_DAYS*DAY_MS,firstSeen:now,lastSeen:0,products:[]};}
      lics[key].products=(d.products||[]).map(p=>({
        id:p.productId,name:p.name||p.productId,assignedAt:now,
        accountType:p.accountType||'',accountReal:p.accountReal||'',accountDemo:p.accountDemo||'',
        minLots:parseFloat(p.minLots)||0,maxLots:parseFloat(p.maxLots)||0,instances:parseInt(p.instances)||1,
        expiry:p.expiry||''
      }));
      sendJSON(res,await saveLics(lics)?200:500,{ok:true});return;
    }

    if(reqPath==='/admin/manual'&&method==='POST'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const lics=await getLics();const now=Date.now();const key=String(d.account);const ex=lics[key];
      const end=d.endDate?new Date(d.endDate).getTime():now+30*DAY_MS;
      lics[key]={...(ex||{}),account:key,name:d.name||ex?.name||'',type:'premium',trialStart:ex?.trialStart||now,trialEnd:ex?.trialEnd||(now+TRIAL_DAYS*DAY_MS),premiumStart:now,premiumEnd:end,firstSeen:ex?.firstSeen||now,lastSeen:ex?.lastSeen||0,products:ex?.products||[]};
      const ok=await saveLics(lics);
      sendJSON(res,ok?200:500,{ok,expiresStr:ptDate(end)});return;
    }

    if(reqPath==='/admin/reset-password'&&method==='POST'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const db2=await getAuth();if(db2.users&&db2.users[d.account])delete db2.users[d.account];
      sendJSON(res,await saveAuth(db2)?200:500,{ok:true});return;
    }

    if(reqPath==='/admin/products'){
      if(method==='GET'){const prods=await getProducts();sendJSON(res,200,{ok:true,products:prods});return;}
      if(method==='POST'){
        const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
        const ok=await saveProduct(d);sendJSON(res,ok?200:500,{ok});return;
      }
    }

    if(reqPath==='/admin/generate-key'&&method==='POST'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const{productId,account,accountType,expiry}=d;
      if(!productId||!account||!accountType||!expiry){sendJSON(res,400,{error:'Campos obrigatórios'});return;}
      const payload=productId+'|'+account+'|'+accountType+'|'+expiry;
      const sig=crypto.createHmac('sha256',OFFLINE_SECRET).update(payload).digest('hex').substring(0,16);
      const key=Buffer.from(payload+'|'+sig).toString('base64');
      sendJSON(res,200,{ok:true,key,payload,expiry});return;
    }

    if(reqPath==='/admin/wipe'&&method==='DELETE'){
      const lics=await getLics();
      const prods=lics._products||[];
      const empty={_products:prods};
      const removed=Object.keys(lics).filter(k=>!k.startsWith('_')).length;
      // Limpar MongoDB
      if(db){await db.collection('licenses').deleteMany({});await db.collection('auth').deleteMany({});}
      _licsCache={_products:prods};_licsTime=Date.now();_authCache={users:{},tokens:{}};
      sendJSON(res,200,{ok:true,message:'Banco limpo.',accountsRemoved:removed});return;
    }

    sendJSON(res,404,{error:'Rota admin não encontrada'});return;
  }

  sendJSON(res,404,{error:'Not found'});

}).listen(PORT,()=>{
  console.log('Dashbot Server v3 (MongoDB) iniciado na porta '+PORT);
  connectMongo();
});

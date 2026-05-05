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
const OFFLINE_SECRET = process.env.OFFLINE_SECRET  || 'dashbot_offline_secret_2024';

const TRIAL_DAYS = 14;
const DAY_MS     = 86400000;

// ── Produtos fixos do ecossistema Dashbot ─────────────────────────
const DEFAULT_PRODUCTS = [
  {id:'prod_1000000007',name:'Dashbot', type:'dashboard',description:'Painel de monitoramento',  minLots:0,maxLots:0,instances:1,active:true},
  {id:'prod_1000000001',name:'Hulk',    type:'ea',       description:'Expert Advisor Hulk',       minLots:0,maxLots:0,instances:1,active:true},
  {id:'prod_1000000002',name:'Tornado', type:'ea',       description:'Expert Advisor Tornado',    minLots:0,maxLots:0,instances:1,active:true},
  {id:'prod_1000000003',name:'Adam',    type:'ea',       description:'Expert Advisor Adam',       minLots:0,maxLots:0,instances:1,active:true},
  {id:'prod_1000000004',name:'Snake',   type:'ea',       description:'Expert Advisor Snake',      minLots:0,maxLots:0,instances:1,active:true},
  {id:'prod_1000000005',name:'Kryos',   type:'ea',       description:'Expert Advisor Kryos',      minLots:0,maxLots:0,instances:1,active:true},
  {id:'prod_1000000006',name:'Iron',    type:'ea',       description:'Expert Advisor Iron Robot', minLots:0,maxLots:0,instances:1,active:true},
];

// ── Helpers ───────────────────────────────────────────────────────
function hashPw(pw){return crypto.createHash('sha256').update(pw+'dashbot_salt_2024').digest('hex');}
function genToken(account){return crypto.createHash('sha256').update(account+'_'+Date.now()+'_'+Math.random()).digest('hex');}
function ptDate(ms){return new Date(ms).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'});}

// ── Cache ─────────────────────────────────────────────────────────
let licenseCache={}; let lastLicLoad=0;
let authCache={}; let lastAuthLoad=0;
const CACHE_TTL=20000;

// ── JSONBin ───────────────────────────────────────────────────────
function jbReq(method,binId,body,cb){
  if(!binId){cb(new Error('No binId'),-1,'');return;}
  const bodyStr=body?JSON.stringify(body):null;
  const opts={hostname:'api.jsonbin.io',port:443,
    path:'/v3/b/'+encodeURIComponent(binId).replace(/%2F/g,'/')+(method==='GET'?'/latest':''),
    method,headers:{'Content-Type':'application/json','X-Master-Key':MASTER_KEY,'X-Bin-Meta':'false'}};
  if(bodyStr) opts.headers['Content-Length']=Buffer.byteLength(bodyStr);
  const req=https.request(opts,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>cb(null,res.statusCode,d));});
  req.on('error',err=>cb(err,-1,''));
  if(bodyStr) req.write(bodyStr);
  req.end();
}
function readBody(req){return new Promise(r=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>r(b));});}

async function getLics(){
  return new Promise(resolve=>{
    if(!LICENSE_BIN){resolve({});return;}
    const now=Date.now();
    if(now-lastLicLoad<CACHE_TTL){resolve(licenseCache);return;}
    jbReq('GET',LICENSE_BIN,null,(err,code,data)=>{
      if(!err&&code===200)try{const p=JSON.parse(data);licenseCache=p.licenses||{};lastLicLoad=now;}catch(e){}
      // Garantir produtos padrão sempre presentes
      if(!licenseCache._products) licenseCache._products=[];
      DEFAULT_PRODUCTS.forEach(dp=>{
        if(!licenseCache._products.find(p=>p.id===dp.id))
          licenseCache._products.push({...dp,createdAt:Date.now()});
      });
      resolve(licenseCache);
    });
  });
}
async function saveLics(lics){
  return new Promise(resolve=>{
    jbReq('PUT',LICENSE_BIN,{licenses:lics},(err,code)=>{
      if(!err&&code===200){licenseCache=lics;lastLicLoad=Date.now();}
      resolve(!err&&code===200);
    });
  });
}
async function getAuth(){
  return new Promise(resolve=>{
    if(!AUTH_BIN){if(!authCache.users)authCache.users={};if(!authCache.tokens)authCache.tokens={};resolve(authCache);return;}
    const now=Date.now();
    if(now-lastAuthLoad<CACHE_TTL){resolve(authCache);return;}
    jbReq('GET',AUTH_BIN,null,(err,code,data)=>{
      if(!err&&code===200)try{const p=JSON.parse(data);authCache=p.auth||{};lastAuthLoad=now;}catch(e){}
      if(!authCache.users) authCache.users={};
      if(!authCache.tokens) authCache.tokens={};
      resolve(authCache);
    });
  });
}
async function saveAuth(db){
  return new Promise(resolve=>{
    if(!AUTH_BIN){authCache=db;resolve(true);return;}
    jbReq('PUT',AUTH_BIN,{auth:db},(err,code)=>{
      if(!err&&code===200){authCache=db;lastAuthLoad=Date.now();}
      resolve(!err&&code===200);
    });
  });
}

function checkLic(lic){
  const now=Date.now();
  if(!lic) return{valid:false,plan:'none',expired:true};
  if(lic.type==='lifetime') return{valid:true,plan:'lifetime',daysLeft:99999};
  if(lic.type==='premium'){
    if(lic.premiumEnd&&now<lic.premiumEnd)
      return{valid:true,plan:'premium',daysLeft:Math.ceil((lic.premiumEnd-now)/DAY_MS)};
    return{valid:false,plan:'expired',expired:true};
  }
  const trialEnd=lic.trialEnd||((lic.trialStart||now)+TRIAL_DAYS*DAY_MS);
  if(now<trialEnd) return{valid:true,plan:'trial',daysLeft:Math.ceil((trialEnd-now)/DAY_MS)};
  return{valid:false,plan:'expired',expired:true};
}

async function verifySession(token){
  if(!token) return null;
  const db=await getAuth();
  for(const k of Object.keys(db.tokens||{})){
    const t=db.tokens[k];
    if(t.token===token&&t.type==='session'&&t.expires>Date.now()) return t;
  }
  return null;
}

const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,X-Dashbot-Token,X-Auth-Token'};
function sendJSON(res,code,obj){const b=JSON.stringify(obj);res.writeHead(code,{...CORS,'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)});res.end(b);}
function sendHTML(res,html){res.writeHead(200,{...CORS,'Content-Type':'text/html;charset=utf-8'});res.end(html);}
function adminAuth(req){const a=req.headers['authorization']||'';if(!a.startsWith('Basic '))return false;const[u,p]=Buffer.from(a.slice(6),'base64').toString().split(':');return u===ADMIN_USER&&p===ADMIN_PASS;}

// ── HTTP Server ───────────────────────────────────────────────────
http.createServer(async(req,res)=>{
  const parsed=new URL(req.url,'http://localhost');
  const reqPath=parsed.pathname;
  const method=req.method.toUpperCase();
  const qs=parsed.searchParams;
  if(method==='OPTIONS'){res.writeHead(204,CORS);res.end();return;}

  if(reqPath==='/health'||reqPath==='/ping'){sendJSON(res,200,{status:'ok',service:'Dashbot Server v3',ts:Date.now()});return;}

  if(reqPath==='/'||reqPath==='/dashbot'||reqPath==='/dashbot/'){
    const htmlPath=path.join(__dirname,'dashbot_web.html');
    if(fs.existsSync(htmlPath)){
      res.writeHead(200,{...CORS,'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store'});
      res.end(fs.readFileSync(htmlPath));
    }else sendJSON(res,404,{error:'dashbot_web.html not found'});
    return;
  }

  // ════════════════════════════════════════════════════════════════
  //  /validate-product — Validação Web (EAs/Indicadores)
  // ════════════════════════════════════════════════════════════════
  if(reqPath==='/validate-product'){
    const account=qs.get('account')||'';
    const productId=qs.get('product')||'';
    const token=qs.get('token')||'';
    const accountType=qs.get('type')||''; // 'real' ou 'demo'

    if(token!==PROXY_TOKEN){sendJSON(res,401,{valid:false,error:'Token inválido'});return;}
    if(!account||!productId){sendJSON(res,400,{valid:false,error:'account e product obrigatórios'});return;}

    lastLicLoad=0;
    const lics=await getLics();
    const now=Date.now();

    const catalogProd=lics._products&&lics._products.find(p=>p.id===productId);
    if(!catalogProd){sendJSON(res,403,{valid:false,error:`Produto "${productId}" não encontrado no catálogo.`});return;}
    if(catalogProd.active===false){sendJSON(res,403,{valid:false,error:`Produto "${catalogProd.name}" está desativado.`});return;}

    const lic=lics[account];
    if(!lic){sendJSON(res,403,{valid:false,error:'Conta MT5 '+account+' não encontrada. Adquira uma licença em dashbot.investidorbot.com'});return;}

    const s=checkLic(lic);
    if(!s.valid){sendJSON(res,403,{valid:false,error:'Licença expirada. Renove em dashbot.investidorbot.com',plan:s.plan});return;}

    const userProds=lic.products||[];
    const userProd=userProds.find(p=>p.id===productId);
    if(!userProd){sendJSON(res,403,{valid:false,error:`Produto "${catalogProd.name}" não licenciado para esta conta.`});return;}

    // Verificar tipo de conta (real/demo)
    if(accountType&&userProd.accountType&&userProd.accountType!==accountType){
      const tipoEsperado=userProd.accountType==='real'?'Real':'Demo';
      const tipoInformado=accountType==='real'?'Real':'Demo';
      sendJSON(res,403,{valid:false,error:`Esta licença é para conta ${tipoEsperado}. Você está tentando usar em uma conta ${tipoInformado}. Contate o suporte.`});
      return;
    }

    lics[account].lastSeen=now;
    saveLics(lics).catch(()=>{});

    sendJSON(res,200,{
      valid:true,plan:s.plan,daysLeft:s.daysLeft,account,productId,
      productName:catalogProd.name,
      minLots:parseFloat(userProd.minLots)||parseFloat(catalogProd.minLots)||0,
      maxLots:parseFloat(userProd.maxLots)||parseFloat(catalogProd.maxLots)||0,
      instances:parseInt(userProd.instances)||parseInt(catalogProd.instances)||1,
      accountType:userProd.accountType||'',
      accountReal:userProd.accountReal||'',accountDemo:userProd.accountDemo||'',
      premiumEnd:lic.premiumEnd||null,
      message:`Licença ativa — ${catalogProd.name} — ${s.plan==='lifetime'?'Vitalícia':s.daysLeft+' dias restantes'}`
    });
    return;
  }

  // ════════════════════════════════════════════════════════════════
  //  /validate-key — Validação Offline por Chave Criptografada
  // ════════════════════════════════════════════════════════════════
  if(reqPath==='/validate-key'&&method==='POST'){
    // Apenas para verificação do servidor (o EA valida localmente)
    const body=await readBody(req);
    let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{valid:false,error:'JSON inválido'});return;}
    const{key}=d;
    if(!key){sendJSON(res,400,{valid:false,error:'key obrigatória'});return;}
    try{
      const decoded=Buffer.from(key,'base64').toString('utf8');
      const parts=decoded.split('|');
      if(parts.length<5){sendJSON(res,400,{valid:false,error:'Chave inválida'});return;}
      const[prodId,account,accountType,expiry,sig]=parts;
      const payload=`${prodId}|${account}|${accountType}|${expiry}`;
      const expected=crypto.createHmac('sha256',OFFLINE_SECRET).update(payload).digest('hex').substring(0,16);
      if(sig!==expected){sendJSON(res,403,{valid:false,error:'Assinatura inválida'});return;}
      const expiryDate=new Date(expiry);
      if(expiry!=='lifetime'&&expiryDate<new Date()){sendJSON(res,403,{valid:false,error:'Chave expirada em '+expiryDate.toLocaleDateString('pt-BR')});return;}
      sendJSON(res,200,{valid:true,productId:prodId,account,accountType,expiry,lifetime:expiry==='lifetime'});
    }catch(e){sendJSON(res,500,{valid:false,error:'Erro ao validar chave'});}
    return;
  }

  // ════════════════════════════════════════════════════════════════
  //  /generate-key — Gerar chave offline (admin only)
  // ════════════════════════════════════════════════════════════════
  if(reqPath==='/generate-key'&&method==='POST'){
    if(!adminAuth(req)){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Dashbot Admin"',...CORS});res.end('Não autorizado');return;}
    const body=await readBody(req);
    let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
    const{productId,account,accountType,expiry}=d;
    if(!productId||!account||!accountType||!expiry){sendJSON(res,400,{error:'Campos obrigatórios: productId, account, accountType, expiry (YYYY-MM-DD ou "lifetime")'});return;}
    const payload=`${productId}|${account}|${accountType}|${expiry}`;
    const sig=crypto.createHmac('sha256',OFFLINE_SECRET).update(payload).digest('hex').substring(0,16);
    const key=Buffer.from(`${payload}|${sig}`).toString('base64');
    sendJSON(res,200,{ok:true,key,productId,account,accountType,expiry});
    return;
  }

  // /validate — compatibilidade com Dashbot dashboard
  if(reqPath==='/validate'){
    const account=qs.get('account')||'';
    if(!account){sendJSON(res,400,{error:'account obrigatório'});return;}
    lastLicLoad=0;
    const lics=await getLics();
    const now=Date.now();let changed=false;
    let lic=lics[account];
    if(!lic){lic={account,type:'trial',trialStart:now,trialEnd:now+TRIAL_DAYS*DAY_MS,firstSeen:now,lastSeen:now,products:[]};lics[account]=lic;changed=true;}
    else{if(lics[account].lastSeen!==now){lics[account].lastSeen=now;changed=true;}}
    if(!lics[account].products){lics[account].products=[];changed=true;}
    const dashProd=lics._products&&lics._products.find(p=>p.id==='prod_1000000007');
    if(dashProd&&!lics[account].products.find(p=>p.id==='prod_1000000007')){lics[account].products.push({id:'prod_1000000007',name:'Dashbot',assignedAt:now});changed=true;}
    if(changed) await saveLics(lics);
    const s=checkLic(lics[account]);
    sendJSON(res,200,{...s,account,trialStart:lic.trialStart,trialEnd:lic.trialEnd||null,premiumEnd:lic.premiumEnd||null});
    return;
  }

  // Auth routes
  if(reqPath==='/auth/check'){
    const account=qs.get('account')||'';
    if(!account){sendJSON(res,400,{error:'account obrigatório'});return;}
    const lics=await getLics();const now=Date.now();
    if(!lics[account]){lics[account]={account,type:'trial',trialStart:now,trialEnd:now+TRIAL_DAYS*DAY_MS,firstSeen:now,lastSeen:now};await saveLics(lics);}
    const s=checkLic(lics[account]);
    if(!s.valid){sendJSON(res,403,{error:'Licença expirada'});return;}
    const db=await getAuth();
    const hasPassword=!!(db.users&&db.users[String(account)]&&db.users[String(account)].passwordHash);
    if(hasPassword){sendJSON(res,200,{hasPassword:true,plan:s.plan});}
    else{const setupToken=genToken(account);if(!db.tokens)db.tokens={};db.tokens['setup_'+account]={token:setupToken,account,expires:Date.now()+600000,type:'setup'};await saveAuth(db);sendJSON(res,200,{hasPassword:false,setupToken,account,plan:s.plan});}
    return;
  }
  if(reqPath==='/auth/mt5-link'&&method==='POST'){
    const token=qs.get('token')||'';if(token!==PROXY_TOKEN){sendJSON(res,401,{error:'Token inválido'});return;}
    const body=await readBody(req);let data;try{data=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
    const{account}=data;if(!account){sendJSON(res,400,{error:'account obrigatório'});return;}
    const lics=await getLics();const now=Date.now();
    if(!lics[account]){lics[account]={account,type:'trial',trialStart:now,trialEnd:now+TRIAL_DAYS*DAY_MS,firstSeen:now,lastSeen:now};await saveLics(lics);}
    const s=checkLic(lics[account]);if(!s.valid){sendJSON(res,403,{error:'Licença expirada',expired:true});return;}
    const db=await getAuth();const setupToken=genToken(account);if(!db.tokens)db.tokens={};
    db.tokens['setup_'+account]={token:setupToken,account,expires:Date.now()+600000,type:'setup'};await saveAuth(db);
    const hasPassword=!!db.users?.[String(account)];
    sendJSON(res,200,{ok:true,setupToken,account,plan:s.plan,hasPassword});return;
  }
  if(reqPath==='/auth/setup-password'&&method==='POST'){
    const body=await readBody(req);let data;try{data=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
    const{setupToken,password}=data;if(!setupToken||!password){sendJSON(res,400,{error:'Campos obrigatórios'});return;}
    if(password.length<6){sendJSON(res,400,{error:'Senha mínimo 6 caracteres'});return;}
    const db=await getAuth();let account=null;
    for(const k of Object.keys(db.tokens||{})){const t=db.tokens[k];if(t.token===setupToken&&t.type==='setup'&&t.expires>Date.now()){account=t.account;delete db.tokens[k];break;}}
    if(!account){sendJSON(res,401,{error:'Token inválido ou expirado'});return;}
    db.users[account]={account,passwordHash:hashPw(password),createdAt:Date.now()};
    const sessionToken=genToken(account);
    db.tokens['sess_'+account+'_'+Date.now()]={token:sessionToken,account,expires:Date.now()+30*DAY_MS,type:'session'};
    await saveAuth(db);const lics=await getLics();const s=checkLic(lics[account]);
    sendJSON(res,200,{ok:true,sessionToken,account,plan:s.plan,valid:s.valid});return;
  }
  if(reqPath==='/auth/login'&&method==='POST'){
    const body=await readBody(req);let data;try{data=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
    const{account,password}=data;if(!account||!password){sendJSON(res,400,{error:'Campos obrigatórios'});return;}
    const db=await getAuth();const user=db.users[String(account)];
    if(!user||user.passwordHash!==hashPw(password)){sendJSON(res,401,{error:'Conta ou senha incorretos'});return;}
    const lics=await getLics();const s=checkLic(lics[String(account)]);
    const sessionToken=genToken(account);if(!db.tokens)db.tokens={};
    db.tokens['sess_'+account+'_'+Date.now()]={token:sessionToken,account:String(account),expires:Date.now()+30*DAY_MS,type:'session'};
    await saveAuth(db);sendJSON(res,200,{ok:true,sessionToken,account:String(account),plan:s.plan,valid:s.valid,daysLeft:s.daysLeft});return;
  }
  if(reqPath==='/auth/verify'){
    const tok=qs.get('token')||req.headers['x-auth-token']||'';const sess=await verifySession(tok);
    if(!sess){sendJSON(res,401,{error:'Sessão inválida'});return;}
    const lics=await getLics();const s=checkLic(lics[sess.account]);
    sendJSON(res,200,{ok:true,account:sess.account,plan:s.plan,valid:s.valid,daysLeft:s.daysLeft});return;
  }
  if(reqPath==='/data'){
    const tok=qs.get('token')||req.headers['x-auth-token']||'';let sessionAccount=null;
    if(tok!==PROXY_TOKEN){const sess=await verifySession(tok);if(!sess){sendJSON(res,401,{error:'Não autorizado'});return;}sessionAccount=sess.account;}
    else sessionAccount=qs.get('account')||null;
    const serveData=(all)=>{
      if(!sessionAccount){sendJSON(res,200,all);return;}
      let acctData=null;
      if(all&&all[sessionAccount])acctData=all[sessionAccount];
      else if(all&&all.account===sessionAccount)acctData=all;
      if(acctData&&acctData.eas)sendJSON(res,200,acctData);
      else sendJSON(res,200,{eas:[],ts:Date.now(),offline:true,msg:'MT5 desconectado.'});
    };
    if(global.dataCache&&Object.keys(global.dataCache).length>0){serveData(global.dataCache);return;}
    return new Promise(resolve=>{jbReq('GET',DATA_BIN,null,(err,code,rawData)=>{
      if(err||code!==200){sendJSON(res,200,{eas:[],ts:Date.now(),offline:true,msg:'MT5 desconectado.'});resolve();return;}
      try{const all=JSON.parse(rawData);if(typeof all==='object'&&!all.eas)global.dataCache=all;serveData(all);}
      catch(e){sendJSON(res,500,{error:'Parse error'});}resolve();
    });});
  }
  if(reqPath==='/update'&&method==='POST'){
    const tok=qs.get('token')||'';if(tok!==PROXY_TOKEN){sendJSON(res,401,{error:'Não autorizado'});return;}
    const body=await readBody(req);let payload;try{payload=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
    const account=String(payload.account||qs.get('account')||'');
    if(!global.dataCache||typeof global.dataCache!=='object')global.dataCache={};
    if(account)global.dataCache[account]=payload;else global.dataCache=payload;
    sendJSON(res,200,{ok:true});
    jbReq('PUT',DATA_BIN,global.dataCache,(err,code)=>{if(err||code!==200)console.error('JSONBin save error:',err||code);});
    return;
  }
  if(reqPath==='/command'){
    const tok=qs.get('token')||req.headers['x-auth-token']||'';
    if(tok!==PROXY_TOKEN){const sess=await verifySession(tok);if(!sess){sendJSON(res,401,{error:'Não autorizado'});return;}}
    if(method==='GET')return new Promise(resolve=>{jbReq('GET',CMD_BIN,null,(err,code,data)=>{try{sendJSON(res,200,JSON.parse(data));}catch(e){sendJSON(res,200,{cmd:'none'});}resolve();});});
    if(method==='POST'){
      const body=await readBody(req);
      let payload; try{payload=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      // Normalizar comandos — aceita variações de nome, mapeia para padrão
      if(payload.cmd){
        const c=payload.cmd.toLowerCase().trim();
        if(['iniciar','play','start','resume'].includes(c))        payload.cmd='iniciar';
        else if(['pausar','pause','stop'].includes(c))             payload.cmd='pausar';
        else if(['zerar','fechar','close','closeall'].includes(c)) payload.cmd='zerar';
      }
      return new Promise(resolve=>{jbReq('PUT',CMD_BIN,payload,(err,code)=>{sendJSON(res,!err&&code===200?200:500,{ok:!err&&code===200,cmd:payload.cmd});resolve();});});
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  /admin — Painel Admin v3
  // ════════════════════════════════════════════════════════════════
  if(reqPath.startsWith('/admin')){
    if(!adminAuth(req)){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Dashbot Admin"',...CORS});res.end('Não autorizado');return;}

    if((reqPath==='/admin'||reqPath==='/admin/')&&method==='GET'){
      const lics=await getLics();const db=await getAuth();const now=Date.now();
      let rows='';let stats={total:0,premium:0,trial:0,expired:0,active:0};
      for(const[acct,lic]of Object.entries(lics)){
        if(acct.startsWith('_'))continue;
        const s=checkLic(lic);stats.total++;
        if(s.plan==='premium'||s.plan==='lifetime')stats.premium++;
        else if(s.plan==='trial')stats.trial++;
        else stats.expired++;
        if(lic.lastSeen&&now-lic.lastSeen<7*DAY_MS)stats.active++;
        const hasPw=!!db.users?.[acct];
        const bc=s.plan==='lifetime'?'#7c3aed':s.plan==='premium'?'#10b981':s.plan==='trial'?'#3b82f6':'#ef4444';
        const userProds=(lic.products||[]).map(p=>`<span style="background:#1e2438;padding:2px 6px;border-radius:4px;font-size:10px;margin:1px;display:inline-block">${p.name}${p.accountType?'('+p.accountType+')':''}</span>`).join('');
        const endDate=s.plan==='lifetime'?'Vitalícia':s.plan==='premium'?ptDate(lic.premiumEnd):s.plan==='trial'?ptDate(lic.trialEnd):'—';
        rows+=`<tr>
          <td><code>${acct}</code></td>
          <td>${lic.name||'—'}<br><small style="color:#64748b">${lic.email||''} ${lic.phone||''}</small></td>
          <td><span class="badge" style="background:${bc}">${s.plan}</span></td>
          <td>${endDate}</td>
          <td>${lic.lastSeen?new Date(lic.lastSeen).toLocaleDateString('pt-BR'):'—'}</td>
          <td>${hasPw?'✅':'❌'}</td>
          <td>${userProds||'—'}<br><button class="btn-sm" onclick="addUserProd('${acct}')">+ Produto</button></td>
          <td>
            <button class="btn-sm" onclick="editUser('${acct}','${(lic.name||'').replace(/'/g,"\\'")}','${lic.email||''}','${lic.phone||''}')">✏️</button>
            <button class="btn-sm" onclick="bonusModal('${acct}','${lic.name||''}')">📅 Licença</button>
            <button class="btn-sm btn-red" onclick="revogar('${acct}')">🚫</button>
            <button class="btn-sm" onclick="resetPw('${acct}')">↺</button>
            <button class="btn-sm btn-red" onclick="delUser('${acct}')">🗑</button>
          </td></tr>`;
      }
      const products=(lics._products||[]);
      const prodRows=products.filter(p=>p.id!=='prod_1000000007'||true).map(p=>`<tr>
        <td><code style="font-size:10px">${p.id}</code></td>
        <td><strong>${p.name}</strong></td><td>${p.type}</td>
        <td>${p.minLots||0}</td><td>${p.maxLots||0}</td><td>${p.instances||1}</td>
        <td style="color:#8b949e">${p.description||'—'}</td>
      </tr>`).join('')||'<tr><td colspan="7" style="color:#8b949e;text-align:center;padding:16px">Nenhum produto</td></tr>';
      sendHTML(res,buildAdminHTML(rows,stats,prodRows,JSON.stringify(products)));
      return;
    }

    if(reqPath==='/admin/register'&&method==='POST'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      if(!d.account){sendJSON(res,400,{error:'Conta MT5 obrigatória'});return;}
      const lics=await getLics();const now=Date.now();const key=String(d.account);
      const existing=lics[key]; // upsert: cria ou atualiza

      // Montar produtos (merge com existentes)
      const initProds=existing&&existing.products?[...existing.products]:[];
      if(d.products&&Array.isArray(d.products)){
        d.products.forEach(up=>{
          const catProd=(lics._products||[]).find(p=>p.id===up.productId);
          // Aceitar mesmo se produto não está no catálogo local (pode ser novo)
          const prodName=catProd?catProd.name:(up.name||up.productId);
          const idx=initProds.findIndex(p=>p.id===up.productId);
          const entry={id:up.productId,name:prodName,assignedAt:now,
            accountType:up.accountType||'',accountReal:up.accountReal||'',accountDemo:up.accountDemo||'',
            minLots:parseFloat(up.minLots)||0,maxLots:parseFloat(up.maxLots)||0,instances:parseInt(up.instances)||1};
          if(idx>=0) initProds[idx]=entry; else initProds.push(entry);
        });
      }

      // Tipo de licença
      let type='trial',premiumEnd=null;
      const trialEnd=(existing&&existing.trialEnd)||(now+TRIAL_DAYS*DAY_MS);
      if(d.lifetime){type='lifetime';}
      else if(d.endDate){type='premium';premiumEnd=new Date(d.endDate).getTime();}
      else if(existing&&(existing.type==='premium'||existing.type==='lifetime')){type=existing.type;premiumEnd=existing.premiumEnd||null;}

      lics[key]={...(existing||{}),account:key,
        name:d.name||(existing&&existing.name)||'',
        email:d.email||(existing&&existing.email)||'',
        phone:d.phone||(existing&&existing.phone)||'',
        type,trialStart:(existing&&existing.trialStart)||now,trialEnd,
        premiumStart:type==='premium'?((existing&&existing.premiumStart)||now):(existing&&existing.premiumStart),
        premiumEnd,firstSeen:(existing&&existing.firstSeen)||now,lastSeen:(existing&&existing.lastSeen)||0,
        products:initProds};
      const ok=await saveLics(lics);
      sendJSON(res,ok?200:500,{ok,account:key,updated:!!existing});return;
    }

    if(reqPath==='/admin/license'&&method==='POST'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      if(!d.account){sendJSON(res,400,{error:'Conta obrigatória'});return;}
      const lics=await getLics();const now=Date.now();const key=String(d.account);const ex=lics[key]||{};
      let end,type='premium';
      if(d.lifetime){type='lifetime';end=null;}
      else if(d.endDate){end=new Date(d.endDate).getTime();}
      else{const base=(ex?.premiumEnd&&ex.premiumEnd>now)?ex.premiumEnd:now;end=base+(parseInt(d.months)||1)*30*DAY_MS;}
      lics[key]={...(ex||{}),account:key,name:d.name||ex?.name||'',type,
        trialStart:ex?.trialStart||now,trialEnd:ex?.trialEnd||(now+TRIAL_DAYS*DAY_MS),
        premiumStart:ex?.premiumStart||now,premiumEnd:end,lastSeen:ex?.lastSeen||now,firstSeen:ex?.firstSeen||now};
      const ok=await saveLics(lics);
      sendJSON(res,ok?200:500,{ok,expiresStr:end?ptDate(end):'Vitalícia'});return;
    }
    if(reqPath==='/admin/license'&&method==='DELETE'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const lics=await getLics();if(lics[String(d.account)]){lics[String(d.account)].type='revoked';lics[String(d.account)].premiumEnd=0;lics[String(d.account)].trialEnd=0;}
      sendJSON(res,await saveLics(lics)?200:500,{ok:true});return;
    }
    if(reqPath==='/admin/user'&&method==='DELETE'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const lics=await getLics();const db=await getAuth();
      delete lics[String(d.account)];delete db.users?.[String(d.account)];
      for(const k of Object.keys(db.tokens||{}))if(db.tokens[k].account===String(d.account))delete db.tokens[k];
      const ok1=await saveLics(lics);const ok2=await saveAuth(db);
      sendJSON(res,ok1&&ok2?200:500,{ok:ok1&&ok2});return;
    }
    if(reqPath==='/admin/user'&&method==='PUT'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      if(!d.account){sendJSON(res,400,{error:'Conta obrigatória'});return;}
      const lics=await getLics();const key=String(d.account);
      if(!lics[key])lics[key]={account:key,type:'trial',trialStart:Date.now(),trialEnd:Date.now()+TRIAL_DAYS*DAY_MS,firstSeen:Date.now(),lastSeen:Date.now()};
      if(d.name!==undefined)lics[key].name=d.name;
      if(d.email!==undefined)lics[key].email=d.email;
      if(d.phone!==undefined)lics[key].phone=d.phone;
      sendJSON(res,await saveLics(lics)?200:500,{ok:true});return;
    }
    if(reqPath==='/admin/user'&&method==='GET'){
      const account=qs.get('account')||'';const lics=await getLics();const db=await getAuth();
      const lic=lics[account]||{};const hasPw=!!db.users?.[account];
      sendJSON(res,200,{account,name:lic.name||'',email:lic.email||'',phone:lic.phone||'',hasPw,products:lic.products||[]});return;
    }
    if(reqPath==='/admin/user-product'&&method==='POST'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const lics=await getLics();const key=String(d.account);
      if(!lics[key]){sendJSON(res,404,{error:'Usuário não encontrado'});return;}
      if(!lics[key].products)lics[key].products=[];
      const existing=lics[key].products.findIndex(p=>p.id===d.productId);
      const entry={id:d.productId,name:d.name||d.productId,assignedAt:Date.now(),
        accountType:d.accountType||'',accountReal:d.accountReal||'',accountDemo:d.accountDemo||'',
        minLots:parseFloat(d.minLots)||0,maxLots:parseFloat(d.maxLots)||0,instances:parseInt(d.instances)||1};
      if(existing>=0)lics[key].products[existing]=entry;else lics[key].products.push(entry);
      sendJSON(res,await saveLics(lics)?200:500,{ok:true});return;
    }
    if(reqPath==='/admin/user-product'&&method==='DELETE'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const lics=await getLics();const key=String(d.account);
      if(lics[key]&&lics[key].products)lics[key].products=lics[key].products.filter(p=>p.id!==d.productId);
      sendJSON(res,await saveLics(lics)?200:500,{ok:true});return;
    }
    if(reqPath==='/admin/manual'&&method==='POST'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      if(!d.account){sendJSON(res,400,{error:'Conta obrigatória'});return;}
      const lics=await getLics();const now=Date.now();const key=String(d.account);const ex=lics[key];
      let end,entry;
      if(d.lifetime){
        entry={...(ex||{}),account:key,name:d.name||ex?.name||'',type:'lifetime',
          trialStart:ex?.trialStart||now,trialEnd:ex?.trialEnd||(now+TRIAL_DAYS*DAY_MS),
          premiumEnd:null,lastSeen:ex?.lastSeen||now,firstSeen:ex?.firstSeen||now};
      } else {
        end=d.endDate?new Date(d.endDate).getTime():now+(parseInt(d.days||30)*DAY_MS);
        entry={...(ex||{}),account:key,name:d.name||ex?.name||'',type:'premium',
          trialStart:ex?.trialStart||now,trialEnd:ex?.trialEnd||(now+TRIAL_DAYS*DAY_MS),
          premiumStart:ex?.premiumStart||now,premiumEnd:end,
          lastSeen:ex?.lastSeen||now,firstSeen:ex?.firstSeen||now,note:'Manual'};
      }
      lics[key]=entry;const ok=await saveLics(lics);
      sendJSON(res,ok?200:500,{ok,expiresStr:end?ptDate(end):'Vitalícia'});return;
    }
    if(reqPath==='/admin/reset-password'&&method==='POST'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const db=await getAuth();delete db.users[String(d.account)];
      for(const k of Object.keys(db.tokens||{}))if(db.tokens[k].account===String(d.account))delete db.tokens[k];
      sendJSON(res,await saveAuth(db)?200:500,{ok:true});return;
    }
    if(reqPath==='/admin/products'){
      const lics=await getLics();
      if(method==='GET'){sendJSON(res,200,{products:lics._products||[]});return;}
      if(method==='POST'){
        const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
        if(!d.name||!d.type){sendJSON(res,400,{error:'name e type obrigatórios'});return;}
        if(!lics._products)lics._products=[];
        const prod={id:'prod_'+Date.now(),name:d.name,type:d.type,description:d.description||'',
          minLots:parseFloat(d.minLots)||0,maxLots:parseFloat(d.maxLots)||0,
          instances:parseInt(d.instances)||1,active:true,createdAt:Date.now()};
        lics._products.push(prod);const ok=await saveLics(lics);
        sendJSON(res,ok?200:500,{ok,product:prod});return;
      }
      if(method==='DELETE'){
        const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
        lics._products=(lics._products||[]).filter(p=>p.id!==d.id);
        sendJSON(res,await saveLics(lics)?200:500,{ok:true});return;
      }
    }
    // GET /admin/generate-key-ui — interface para gerar chaves offline
    if(reqPath==='/admin/generate-key'&&method==='POST'){
      const body=await readBody(req);let d;try{d=JSON.parse(body);}catch(e){sendJSON(res,400,{error:'JSON inválido'});return;}
      const{productId,account,accountType,expiry}=d;
      if(!productId||!account||!accountType||!expiry){sendJSON(res,400,{error:'Campos obrigatórios'});return;}
      const payload=`${productId}|${account}|${accountType}|${expiry}`;
      const sig=crypto.createHmac('sha256',OFFLINE_SECRET).update(payload).digest('hex').substring(0,16);
      const key=Buffer.from(`${payload}|${sig}`).toString('base64');
      sendJSON(res,200,{ok:true,key,productId,account,accountType,expiry});return;
    }
    // ── /admin/wipe — Limpar TODO o banco (apenas para testes) ───
    if(reqPath==='/admin/wipe'&&method==='DELETE'){
      const lics=await getLics();
      // Preservar apenas os produtos do catálogo (_products)
      const prods=lics._products||[];
      const empty={_products:prods};
      const ok=await saveLics(empty);
      // Limpar auth também
      const db=await getAuth();
      db.users={};db.tokens={};
      await saveAuth(db);
      sendJSON(res,ok?200:500,{ok,message:'Banco limpo. Produtos preservados.',accountsRemoved:Object.keys(lics).filter(k=>!k.startsWith('_')).length});
      return;
    }

    sendJSON(res,404,{error:'Rota admin não encontrada'});return;
  }

  sendJSON(res,404,{error:'Not found'});

}).listen(PORT,()=>{
  console.log('Dashbot Server v3 iniciado na porta '+PORT);
  setTimeout(()=>{https.request({hostname:'dashbot.investidorbot.com',path:'/ping',method:'GET'},()=>{}).on('error',()=>{}).end();},30000);
  setInterval(()=>{https.request({hostname:'dashbot.investidorbot.com',path:'/ping',method:'GET'},()=>{}).on('error',()=>{}).end();},10*60*1000);
});

// ════════════════════════════════════════════════════════════════
//  Admin HTML
// ════════════════════════════════════════════════════════════════
function buildAdminHTML(rows,stats,prodRows,productsJson){
  const bootstrapScript = `
<script id="serverBootstrap">
(function(){
  window.__SERVER_BOOTSTRAP__ = {
    rows: ${JSON.stringify(rows)},
    stats: ${JSON.stringify(stats)},
    productsJson: ${productsJson||'[]'}
  };
})();
<\/script>`;
  const adminHtml = '<!DOCTYPE html>\n<html lang="pt-BR">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>Dashbot Admin</title>\n<style>\n*{box-sizing:border-box;margin:0;padding:0}\nbody{font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;padding:20px}\nh1{color:#58a6ff;margin-bottom:4px;font-size:22px;display:flex;align-items:center;gap:12px} /* Ajustado para alinhar logo e texto */\n.sub{color:#8b949e;font-size:13px;margin-bottom:20px}\n.stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}\n.stat{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 20px;min-width:100px;text-align:center}\n.stat .n{font-size:26px;font-weight:700;color:#58a6ff}\n.stat .l{font-size:11px;color:#8b949e;text-transform:uppercase;margin-top:2px}\n.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:16px;margin-bottom:16px}\n.card-title{font-size:13px;font-weight:700;color:#58a6ff;margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em}\ntable{width:100%;border-collapse:collapse;font-size:12px}\nth{text-align:left;padding:6px 8px;border-bottom:1px solid #30363d;color:#8b949e;font-size:10px;text-transform:uppercase}\ntd{padding:6px 8px;border-bottom:1px solid #21262d;vertical-align:middle}\ntr:hover td{background:#1c2128}\n.badge{display:inline-block;padding:2px 6px;border-radius:10px;font-size:10px;font-weight:700;color:#fff}\n.btn{background:#1f6feb;color:#fff;border:none;padding:7px 14px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600}\n.btn:hover{background:#388bfd}\n.btn-sm{background:#21262d;color:#e6edf3;border:1px solid #30363d;padding:3px 7px;border-radius:4px;cursor:pointer;font-size:10px;margin:1px}\n.btn-sm:hover{background:#30363d}\n.btn-red{background:#f85149;color:white!important}\n.btn-green{background:#10b981;color:white!important}\n.btn-blue{background:#1f6feb;color:white!important}\n.form-row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}\n.fg{display:flex;flex-direction:column;gap:3px}\nlabel{font-size:10px;color:#8b949e;font-weight:600;text-transform:uppercase}\ninput,select{background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:5px 8px;border-radius:5px;font-size:12px}\ninput:focus,select:focus{outline:none;border-color:#388bfd}\n.msg{padding:7px 12px;border-radius:6px;font-size:12px;margin-bottom:10px;display:none}\n.msg.ok{background:#0d2e1f;border:1px solid #10b981;color:#10b981}\n.msg.err{background:#2d1117;border:1px solid #f85149;color:#f85149}\n\n/* Modal */\n.modal{display:none;position:fixed;z-index:1000;left:0;top:0;width:100%;height:100%;background-color:rgba(13,17,23,0.8)}\n.modal-content{background-color:#161b22;margin:3% auto;padding:20px;border:1px solid #30363d;border-radius:10px;width:96%;max-width:960px}\n.modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:15px}\n.modal-title{color:#58a6ff;font-weight:700}\n.close{color:#8b949e;font-size:24px;font-weight:700;cursor:pointer}\n.close:hover{color:#e6edf3}\n.modal-body{display:flex;flex-direction:column;gap:12px}\n.account-row{display:flex;gap:8px;align-items:flex-end}\n.remove-account{background:#f85149;color:white;border:none;padding:5px 10px;border-radius:4px;cursor:pointer}\n.loading{color:#8b949e;text-align:center;padding:10px}\n.product-account-row{display:flex;gap:6px;align-items:flex-end;margin-bottom:8px;flex-wrap:wrap;background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:8px}\n.remove-product{background:#f85149;color:white;border:none;padding:3px 7px;border-radius:4px;cursor:pointer;font-size:12px}\n</style>\n</head>\n<body>\n<!-- LOGO E TÍTULO ATUALIZADOS -->\n<h1>\n  <img src="data:image/png;base64,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" alt="iBot" style="height: 32px; width: auto; border-radius: 4px;"> \n  Dashbot Admin\n</h1>\n<p class="sub">Licenças · Usuários · Produtos</p>\n\n<div class="stats">\n  <div class="stat"><div class="n" id="total-users">0</div><div class="l">Total</div></div>\n  <div class="stat"><div class="n" style="color:#10b981" id="premium-users">0</div><div class="l">Teste</div></div>\n  <div class="stat"><div class="n" style="color:#3b82f6" id="trial-users">0</div><div class="l">Assinantes</div></div>\n  <div class="stat"><div class="n" style="color:#ef4444" id="expired-users">0</div><div class="l">Vitalícios</div></div>\n  <div class="stat"><div class="n" style="color:#f0c800" id="active-users">0</div><div class="l">Expirados</div></div>\n</div>\n\n<div class="card">\n  <div class="card-title">🎁 Inserir Manualmente (Bônus / Trial)</div>\n  <div id="msg2" class="msg"></div>\n  <div class="form-row">\n    <div class="fg">\n      <label>Nome</label>\n      <input type="text" id="mName" placeholder="Nome" style="width:150px">\n    </div>\n    <div class="fg">\n      <label>Produto</label>\n      <select id="mProduct" style="width:150px">\n        <option value="">Selecione...</option>\n      </select>\n    </div>\n    <div class="fg">\n      <label>Conta MT5</label>\n      <input type="number" id="mAcc" placeholder="12345678" style="width:130px">\n    </div>\n    <div class="fg">\n      <label>Tipo de Conta</label>\n      <select id="mAccountType" style="width:100px">\n        <option value="demo">Demo</option>\n        <option value="real">Real</option>\n      </select>\n    </div>\n    <div class="fg">\n      <label>Data Final</label>\n      <input type="date" id="mExpiry" style="width:140px">\n    </div>\n    <button class="btn" style="background:#10b981" onclick="inserirManual()">➕ Inserir</button>\n    <button class="btn btn-red" onclick="limparBanco()" style="margin-left:auto" title="Remove TODOS os usuários do banco para testes">🗑 Limpar Banco</button>\n  </div>\n</div>\n\n<div class="card">\n  <div class="card-title">📦 Produtos (EAs, Indicadores, etc.)</div>\n  <div id="msg3" class="msg"></div>\n  <div class="form-row" style="margin-bottom:12px">\n    <div class="fg">\n      <label>Nome</label>\n      <input type="text" id="pName" placeholder="Nome do produto" style="width:140px">\n    </div>\n    <div class="fg">\n      <label>Tipo</label>\n      <select id="pType" style="width:120px">\n        <option value="ea">Expert Advisor</option>\n        <option value="indicator">Indicador</option>\n        <option value="dashboard">Dashboard</option>\n        <option value="other">Outro</option>\n      </select>\n    </div>\n    <div class="fg">\n      <label>Descrição</label>\n      <input type="text" id="pDesc" placeholder="Opcional" style="width:180px">\n    </div>\n    <button class="btn" onclick="addProd()">+ Produto</button>\n  </div>\n  <table>\n    <thead>\n      <tr>\n        <th>ID</th>\n        <th>Nome</th>\n        <th>Tipo</th>\n        <th>Descrição</th>\n        <th>Ativo</th>\n        <th>Ações</th>\n      </tr>\n    </thead>\n    <tbody id="productsTable">\n      <tr><td colspan="6" class="loading">Carregando produtos...</td></tr>\n    </tbody>\n  </table>\n</div>\n\n<div class="card">\n  <div class="card-title">👥 Usuários Registrados</div>\n  <div class="form-row" style="margin-bottom:15px; justify-content: space-between;">\n    <button class="btn" onclick="openAddUserModal()">+ Adicionar Usuário</button>\n    <div class="fg">\n      <label>Buscar Usuário</label>\n      <input type="text" id="searchUser" placeholder="Nome, email ou telefone..." oninput="renderUsersTable()" style="width:200px">\n    </div>\n  </div>\n  <table>\n    <thead>\n      <tr>\n        <th>Nome</th>\n        <th>Email</th>\n        <th>Telefone</th>\n        <th>Produtos</th>\n        <th>Contas</th>\n        <th>Validades</th>\n        <th>Ações</th>\n      </tr>\n    </thead>\n    <tbody id="usersTable">\n      <tr><td colspan="7" class="loading">Carregando usuários...</td></tr>\n    </tbody>\n  </table>\n</div>\n\n<!-- Modal para Adicionar/Editar Usuário -->\n<div id="userModal" class="modal">\n  <div class="modal-content">\n    <div class="modal-header">\n      <h3 class="modal-title" id="userModalTitle">➕ Adicionar Usuário</h3>\n      <span class="close" onclick="closeUserModal()">&times;</span>\n    </div>\n    <div class="modal-body">\n      <div id="modalMsg" class="msg"></div>\n      <input type="hidden" id="uId" value="">\n      <div class="form-row">\n        <div class="fg" style="width:100%">\n          <label>Nome</label>\n          <input type="text" id="uName" placeholder="Nome completo" style="width:100%">\n        </div>\n      </div>\n      <div class="form-row">\n        <div class="fg" style="width:100%">\n          <label>Email</label>\n          <input type="email" id="uEmail" placeholder="email@exemplo.com" style="width:100%">\n        </div>\n      </div>\n      <div class="form-row">\n        <div class="fg" style="width:100%">\n          <label>Telefone</label>\n          <input type="tel" id="uPhone" placeholder="(11) 99999-9999" style="width:100%">\n        </div>\n      </div>\n      \n      <div class="card-title">Produtos e Contas</div>\n      <div id="productsContainer">\n        <div class="product-account-row">\n          <div class="fg" style="flex:2">\n            <label>Produto</label>\n            <select class="user-product" style="width:100%">\n              <option value="">Selecione...</option>\n            </select>\n          </div>\n          <div class="fg" style="flex:1">\n            <label>Conta MT5</label>\n            <input type="number" class="user-account" placeholder="12345678">\n          </div>\n          <div class="fg" style="width:100px">\n            <label>Tipo</label>\n            <select class="user-account-type">\n              <option value="demo">Demo</option>\n              <option value="real">Real</option>\n            </select>\n          </div>\n          <div class="fg" style="flex:1">\n            <label>Expiração</label>\n            <input type="date" class="product-expiry" style="width:100%">\n          </div>\n          <button class="remove-product" onclick="removeProduct(this)">×</button>\n        </div>\n      </div>\n      <button class="btn-sm" onclick="addProductField()" style="margin-top:8px">+ Adicionar Produto</button>\n      \n      <button class="btn" id="userModalButton" onclick="saveUser()" style="margin-top:15px">Adicionar Usuário</button>\n    </div>\n  </div>\n</div>\n\n<!-- ══ OVERLAY DE CONFIGURAÇÃO (aparece se não tiver credenciais) ══ -->\n<div id="configOverlay" style="display:none;position:fixed;inset:0;background:rgba(13,17,23,0.97);z-index:9999;align-items:center;justify-content:center;flex-direction:column">\n  <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:28px;width:90%;max-width:400px">\n    <h2 style="color:#58a6ff;margin-bottom:4px;font-size:18px">⚙️ Configurar Acesso Admin</h2>\n    <p style="color:#8b949e;font-size:12px;margin-bottom:20px">Insira as credenciais do seu servidor Dashbot</p>\n    <div id="cfgMsg" style="color:#f85149;font-size:12px;min-height:18px;margin-bottom:10px"></div>\n    <div style="display:flex;flex-direction:column;gap:10px">\n      <div style="display:flex;flex-direction:column;gap:3px">\n        <label style="font-size:10px;color:#8b949e;font-weight:600;text-transform:uppercase">URL do Servidor</label>\n        <input id="cfgUrl" style="background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:7px 10px;border-radius:5px;font-size:13px" value="https://dashbot.investidorbot.com">\n      </div>\n      <div style="display:flex;flex-direction:column;gap:3px">\n        <label style="font-size:10px;color:#8b949e;font-weight:600;text-transform:uppercase">Usuário Admin</label>\n        <input id="cfgUser" style="background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:7px 10px;border-radius:5px;font-size:13px" placeholder="admin">\n      </div>\n      <div style="display:flex;flex-direction:column;gap:3px">\n        <label style="font-size:10px;color:#8b949e;font-weight:600;text-transform:uppercase">Senha Admin</label>\n        <input id="cfgPass" type="password" style="background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:7px 10px;border-radius:5px;font-size:13px" placeholder="••••••••"\n          onkeydown="if(event.key===\'Enter\')saveConfig()">\n      </div>\n      <button onclick="saveConfig()" style="background:#1f6feb;color:#fff;border:none;padding:10px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;margin-top:6px">\n        🔗 Conectar\n      </button>\n    </div>\n  </div>\n</div>\n\n<!-- Botão discreto para reconfigurar (canto superior direito) -->\n<div style="position:fixed;top:12px;right:16px;z-index:1000">\n  <button onclick="clearConfig()" style="background:#21262d;color:#8b949e;border:1px solid #30363d;padding:4px 10px;border-radius:5px;cursor:pointer;font-size:10px">⚙️ Config</button>\n</div>\n\n<script>\n// ══════════════════════════════════════════════════════════════════\n//  DASHBOT ADMIN — Comunicação direta com o servidor\n// ══════════════════════════════════════════════════════════════════\n\n// ── Configuração do servidor (editável pelo usuário) ──────────────\nlet SERVER = localStorage.getItem(\'db_server\') || \'https://dashbot.investidorbot.com\';\nlet AUTH   = localStorage.getItem(\'db_auth\')   || \'\';\n\n// Mostrar tela de config se não tiver credenciais salvas\nfunction checkCredentials() {\n  if (!AUTH) {\n    document.getElementById(\'configOverlay\').style.display = \'flex\';\n  }\n}\n\nfunction saveConfig() {\n  const url  = document.getElementById(\'cfgUrl\').value.trim().replace(/\\/$/, \'\');\n  const user = document.getElementById(\'cfgUser\').value.trim();\n  const pass = document.getElementById(\'cfgPass\').value;\n  if (!url || !user || !pass) { document.getElementById(\'cfgMsg\').textContent = \'❌ Preencha todos os campos\'; return; }\n  SERVER = url;\n  AUTH   = \'Basic \' + btoa(user + \':\' + pass);\n  localStorage.setItem(\'db_server\', SERVER);\n  localStorage.setItem(\'db_auth\',   AUTH);\n  document.getElementById(\'configOverlay\').style.display = \'none\';\n  // Recarregar produtos do servidor\n  loadServerProducts();\n}\n\nfunction clearConfig() {\n  localStorage.removeItem(\'db_auth\');\n  localStorage.removeItem(\'db_server\');\n  AUTH = \'\'; SERVER = \'https://dashbot.investidorbot.com\';\n  document.getElementById(\'cfgUrl\').value  = SERVER;\n  document.getElementById(\'cfgUser\').value = \'\';\n  document.getElementById(\'cfgPass\').value = \'\';\n  document.getElementById(\'configOverlay\').style.display = \'flex\';\n}\n\n// Map: ID local do admin → ID real do servidor\n// O admin usa nomes simples; o servidor usa prod_1000000XXX\nconst PRODUCT_ID_MAP = {\n  \'HULK\':    \'prod_1000000001\',\n  \'TORNADO\': \'prod_1000000002\',\n  \'ADAM\':    \'prod_1000000003\',\n  \'SNAKE\':   \'prod_1000000004\',\n  \'KRYOS\':   \'prod_1000000005\',\n  \'IRON\':    \'prod_1000000006\',\n  \'DASHBOT\': \'prod_1000000007\',\n};\n\n// Cache local dos produtos do servidor\nlet _serverProducts = [];\n\n// ── API helper ────────────────────────────────────────────────────\nasync function apiCall(method, path, body) {\n  try {\n    const res = await fetch(SERVER + path, {\n      method,\n      headers: { \'Content-Type\': \'application/json\', \'Authorization\': AUTH },\n      body: body ? JSON.stringify(body) : undefined\n    });\n    if (res.status === 401) {\n      // Credenciais erradas — limpar e pedir novamente\n      localStorage.removeItem(\'db_auth\');\n      AUTH = \'\';\n      document.getElementById(\'cfgUrl\').value  = SERVER;\n      document.getElementById(\'cfgUser\').value = \'\';\n      document.getElementById(\'cfgPass\').value = \'\';\n      document.getElementById(\'cfgMsg\').textContent = \'❌ Credenciais inválidas. Tente novamente.\';\n      document.getElementById(\'configOverlay\').style.display = \'flex\';\n      return null;\n    }\n    return await res.json();\n  } catch (e) {\n    console.error(\'API error:\', e);\n    showMsg(\'msg2\', \'❌ Erro ao conectar: \' + e.message, false);\n    return null;\n  }\n}\n\n// Converte ID local (número ou nome) para ID do servidor\nfunction toServerId(localId) {\n  // Se já é um prod_ ID, retornar direto\n  if (String(localId).startsWith(\'prod_\')) return String(localId);\n  // Buscar o produto local pelo id\n  const localProds = getProducts();\n  const p = localProds.find(x => x.id == localId);\n  if (!p) return null;\n  const upperName = p.name.toUpperCase();\n  // 1. Tentar mapa direto (IRON, HULK, etc.)\n  if (PRODUCT_ID_MAP[upperName]) return PRODUCT_ID_MAP[upperName];\n  // 2. Tentar com trim e variações (Iron → IRON)\n  const trimmed = upperName.replace(/[^A-Z0-9]/g,\'\');\n  for (const [k,v] of Object.entries(PRODUCT_ID_MAP)) {\n    if (k.replace(/[^A-Z0-9]/g,\'\') === trimmed) return v;\n  }\n  // 3. Tentar encontrar nos produtos do servidor pelo nome\n  if (_serverProducts.length > 0) {\n    const sp = _serverProducts.find(x => x.name.toUpperCase().replace(/[^A-Z0-9]/g,\'\') === trimmed);\n    if (sp) return sp.id;\n  }\n  // 4. Se o produto foi sincronizado do servidor e tem id próprio, pode já ser prod_XXX\n  // Verificar se o nome bate com algum produto do servidor\n  return null;\n}\n\n// ── DB_KEYS — localStorage (mantido para compatibilidade visual) ──\nconst DB_KEYS = { PRODUCTS: \'dashbot_products\', USERS: \'dashbot_users\', LICENSES: \'dashbot_licenses\' };\nconst INITIAL_PRODUCTS = [\n  { id: 1, name: \'HULK\',    type: \'Expert Advisor\', description: \'Robô de trading para futuros\', active: true },\n  { id: 2, name: \'TORNADO\', type: \'Expert Advisor\', description: \'Robô de alta frequência\',      active: true },\n  { id: 3, name: \'ADAM\',    type: \'Expert Advisor\', description: \'Robô para scalp\',               active: true },\n  { id: 4, name: \'SNAKE\',   type: \'Indicador\',      description: \'Indicador de tendências\',       active: true },\n  { id: 5, name: \'KRYOS\',   type: \'Expert Advisor\', description: \'Robô multifuncional\',           active: true },\n  { id: 6, name: \'IRON\',    type: \'Expert Advisor\', description: \'Robô para forex\',               active: true },\n  { id: 7, name: \'OMEGABOT\',type: \'Expert Advisor\', description: \'Robô completo\',                 active: true },\n  { id: 8, name: \'DASHBOT\', type: \'Dashboard\',      description: \'Painel de controle\',            active: true }\n];\n\nfunction showMsg(id, msg, ok) {\n  const el = document.getElementById(id);\n  el.textContent = msg;\n  el.className = \'msg \' + (ok ? \'ok\' : \'err\');\n  el.style.display = \'block\';\n  setTimeout(() => el.style.display = \'none\', 4000);\n}\n\n// ── CRUD local (localStorage) ─────────────────────────────────────\nfunction initializeDatabase() {\n  if (!localStorage.getItem(DB_KEYS.PRODUCTS)) localStorage.setItem(DB_KEYS.PRODUCTS, JSON.stringify(INITIAL_PRODUCTS));\n  if (!localStorage.getItem(DB_KEYS.USERS))    localStorage.setItem(DB_KEYS.USERS,    JSON.stringify([]));\n  if (!localStorage.getItem(DB_KEYS.LICENSES)) localStorage.setItem(DB_KEYS.LICENSES, JSON.stringify([]));\n}\nfunction getProducts()   { return JSON.parse(localStorage.getItem(DB_KEYS.PRODUCTS) || \'[]\'); }\nfunction getUsers()      { return JSON.parse(localStorage.getItem(DB_KEYS.USERS)    || \'[]\'); }\nfunction getLicenses()   { return JSON.parse(localStorage.getItem(DB_KEYS.LICENSES) || \'[]\'); }\nfunction saveProducts(p) { localStorage.setItem(DB_KEYS.PRODUCTS, JSON.stringify(p)); }\nfunction saveUsers(u)    { localStorage.setItem(DB_KEYS.USERS,    JSON.stringify(u)); }\nfunction saveLicenses(l) { localStorage.setItem(DB_KEYS.LICENSES, JSON.stringify(l)); }\n\n// ── Dropdowns ─────────────────────────────────────────────────────\nfunction loadProductsDropdown(selector) {\n  const products = getProducts();\n  document.querySelectorAll(selector).forEach(dd => {\n    dd.innerHTML = \'<option value="">Selecione...</option>\';\n    products.filter(p => p.active).forEach(p => {\n      const o = document.createElement(\'option\');\n      o.value = p.id; o.textContent = p.name; dd.appendChild(o);\n    });\n  });\n}\nfunction loadProductsDropdownElement(dd, selectedValue = \'\') {\n  const products = getProducts();\n  dd.innerHTML = \'<option value="">Selecione...</option>\';\n  products.filter(p => p.active).forEach(p => {\n    const o = document.createElement(\'option\');\n    o.value = p.id; o.textContent = p.name; o.selected = (p.id == selectedValue); dd.appendChild(o);\n  });\n}\n\n// ── Tabela de Produtos ────────────────────────────────────────────\nfunction renderProductsTable() {\n  const table = document.getElementById(\'productsTable\');\n  const products = getProducts();\n  table.innerHTML = \'\';\n  if (products.length === 0) { table.innerHTML = \'<tr><td colspan="6" class="loading">Nenhum produto cadastrado</td></tr>\'; return; }\n  products.forEach(p => {\n    const row = document.createElement(\'tr\');\n    row.innerHTML = `<td>${p.id}</td><td>${p.name}</td><td>${p.type}</td><td>${p.description||\'-\'}</td><td>${p.active?\'✅\':\'❌\'}</td>\n      <td><button class="btn-sm btn-blue" onclick="editProduct(${p.id})">Editar</button>\n          <button class="btn-sm" onclick="toggleProduct(${p.id})">${p.active?\'Desativar\':\'Ativar\'}</button>\n          <button class="btn-sm btn-red" onclick="delProd(${p.id})">Excluir</button></td>`;\n    table.appendChild(row);\n  });\n}\n\n// ── Tabela de Usuários ────────────────────────────────────────────\nfunction renderUsersTable() {\n  const table = document.getElementById(\'usersTable\');\n  const searchTerm = document.getElementById(\'searchUser\').value.toLowerCase();\n  const users = getUsers();\n  const licenses = getLicenses();\n  const products = getProducts();\n  table.innerHTML = \'\';\n  const filtered = users.filter(u =>\n    u.name.toLowerCase().includes(searchTerm) ||\n    (u.email && u.email.toLowerCase().includes(searchTerm)) ||\n    (u.phone && u.phone.toLowerCase().includes(searchTerm))\n  );\n  if (filtered.length === 0) { table.innerHTML = \'<tr><td colspan="7" class="loading">Nenhum usuário encontrado</td></tr>\'; return; }\n  filtered.forEach(user => {\n    const userLics = licenses.filter(l => l.userId === user.id);\n    const prodsInfo = userLics.map(l => { const p = products.find(x => x.id === l.productId); return p ? p.name : \'N/A\'; }).join(\', \');\n    const acctsInfo = userLics.map(l => `${l.account} (${l.accountType})`).join(\', \');\n    const expInfo   = userLics.map(l => l.expiry || \'-\').join(\', \');\n    const row = document.createElement(\'tr\');\n    row.innerHTML = `<td>${user.name}</td><td>${user.email||\'-\'}</td><td>${user.phone||\'-\'}</td>\n      <td>${prodsInfo}</td><td>${acctsInfo}</td><td>${expInfo}</td>\n      <td><button class="btn-sm btn-blue" onclick="openEditUserModal(${user.id})">Editar</button>\n          <button class="btn-sm btn-red" onclick="deleteUser(${user.id})">Excluir</button></td>`;\n    table.appendChild(row);\n  });\n}\n\nfunction updateStats() {\n  const users = getUsers();\n  const licenses = getLicenses();\n  const now = new Date();\n  const expired = licenses.filter(l => l.expiry && new Date(l.expiry) < now).length;\n  document.getElementById(\'total-users\').textContent   = users.length;\n  document.getElementById(\'premium-users\').textContent = licenses.filter(l => l.accountType === \'real\').length;\n  document.getElementById(\'trial-users\').textContent   = licenses.filter(l => l.accountType === \'demo\').length;\n  document.getElementById(\'expired-users\').textContent = expired;\n  document.getElementById(\'active-users\').textContent  = Math.max(0, licenses.length - expired);\n}\n\n// ── Inserir Manual (Bônus/Trial) ──────────────────────────────────\nasync function inserirManual() {\n  const name        = document.getElementById(\'mName\').value.trim();\n  const localProdId = document.getElementById(\'mProduct\').value;\n  const account     = document.getElementById(\'mAcc\').value.trim();\n  const accountType = document.getElementById(\'mAccountType\').value;\n  const expiry      = document.getElementById(\'mExpiry\').value;\n\n  if (!name || !localProdId || !account || !expiry) {\n    showMsg(\'msg2\', \'❌ Preencha todos os campos obrigatórios\', false); return;\n  }\n\n  const serverProdId = toServerId(localProdId);\n  if (!serverProdId) { showMsg(\'msg2\', \'❌ Produto não mapeado para o servidor\', false); return; }\n\n  const prod = _serverProducts.find(p => p.id === serverProdId);\n  const prodName = prod ? prod.name : serverProdId;\n\n  // 1. Criar/atualizar licença no servidor\n  const r1 = await apiCall(\'POST\', \'/admin/manual\', { account, name, endDate: expiry });\n  if (!r1 || !r1.ok) { showMsg(\'msg2\', \'❌ Erro ao criar licença: \' + (r1?.error||\'Servidor indisponível\'), false); return; }\n\n  // 2. Atribuir produto COM todos os campos de restrição\n  const r2 = await apiCall(\'POST\', \'/admin/user-product\', {\n    account, productId: serverProdId, name: prodName,\n    accountType,\n    accountReal: accountType === \'real\' ? account : \'\',\n    accountDemo: accountType === \'demo\' ? account : \'\',\n    minLots: 0, maxLots: 0, instances: 1\n  });\n  if (!r2 || !r2.ok) { showMsg(\'msg2\', \'❌ Licença criada mas produto não atribuído: \' + (r2?.error||\'\'), false); return; }\n\n  // 3. Salvar localmente para exibição\n  try {\n    const users = getUsers();\n    const newUser = { id: Date.now(), name, created: new Date().toISOString() };\n    users.push(newUser); saveUsers(users);\n    const lics = getLicenses();\n    lics.push({ id: Date.now(), userId: newUser.id, productId: parseInt(localProdId), account, accountType, expiry, created: new Date().toISOString() });\n    saveLicenses(lics);\n  } catch(e) {}\n\n  showMsg(\'msg2\', `✅ Licença inserida! Expira: ${r1.expiresStr}`, true);\n  document.getElementById(\'mName\').value = \'\';\n  document.getElementById(\'mAcc\').value  = \'\';\n  document.getElementById(\'mExpiry\').value = \'\';\n  renderUsersTable(); updateStats();\n}\n\n// ── Modal de Usuário ──────────────────────────────────────────────\nfunction openAddUserModal() {\n  document.getElementById(\'userModalTitle\').textContent  = \'➕ Adicionar Usuário\';\n  document.getElementById(\'userModalButton\').textContent = \'Adicionar Usuário\';\n  document.getElementById(\'uId\').value    = \'\';\n  document.getElementById(\'uName\').value  = \'\';\n  document.getElementById(\'uEmail\').value = \'\';\n  document.getElementById(\'uPhone\').value = \'\';\n\n  const products = getProducts();\n  const opts = products.filter(p => p.active).map(p => `<option value="${p.id}">${p.name}</option>`).join(\'\');\n  const defDate = (() => { const d = new Date(); d.setDate(d.getDate()+30); return d.toISOString().split(\'T\')[0]; })();\n\n  document.getElementById(\'productsContainer\').innerHTML = `\n    <div class="product-account-row">\n      <div class="fg" style="min-width:120px;flex:2"><label>Produto</label>\n        <select class="user-product" style="width:100%"><option value="">Selecione...</option>${opts}</select>\n      </div>\n      <div class="fg" style="min-width:110px;flex:1"><label>Conta MT5</label>\n        <input type="number" class="user-account" placeholder="12345678">\n      </div>\n      <div class="fg" style="width:82px"><label>Tipo</label>\n        <select class="user-account-type"><option value="demo">Demo</option><option value="real">Real</option></select>\n      </div>\n      <div class="fg" style="width:72px"><label>Lote Mín</label>\n        <input type="number" class="user-minlots" placeholder="0.01" step="0.01" min="0">\n      </div>\n      <div class="fg" style="width:72px"><label>Lote Máx</label>\n        <input type="number" class="user-maxlots" placeholder="1.00" step="0.01" min="0">\n      </div>\n      <div class="fg" style="width:68px"><label>Instâncias</label>\n        <input type="number" class="user-instances" placeholder="1" min="1" value="1">\n      </div>\n      <div class="fg" style="min-width:130px;flex:1"><label>Expiração</label>\n        <input type="date" class="product-expiry" style="width:100%" value="${defDate}">\n      </div>\n      <button class="remove-product" onclick="removeProduct(this)" style="align-self:flex-end">×</button>\n    </div>`;\n\n  document.getElementById(\'userModal\').style.display = \'block\';\n}\n\nfunction openEditUserModal(userId) {\n  const users    = getUsers();\n  const licenses = getLicenses();\n  const user     = users.find(u => u.id === userId);\n  const userLics = licenses.filter(l => l.userId === userId);\n  if (!user) return;\n\n  document.getElementById(\'userModalTitle\').textContent  = \'✏️ Editar Usuário\';\n  document.getElementById(\'userModalButton\').textContent = \'Salvar Alterações\';\n  document.getElementById(\'uId\').value    = user.id;\n  document.getElementById(\'uName\').value  = user.name  || \'\';\n  document.getElementById(\'uEmail\').value = user.email || \'\';\n  document.getElementById(\'uPhone\').value = user.phone || \'\';\n\n  document.getElementById(\'productsContainer\').innerHTML = \'\';\n  if (userLics.length === 0) addProductField(); else userLics.forEach(l => addProductField(l));\n  document.getElementById(\'userModal\').style.display = \'block\';\n}\n\nfunction closeUserModal() { document.getElementById(\'userModal\').style.display = \'none\'; }\n\nfunction addProductField(data) {\n  data = data || {};\n  const container = document.getElementById(\'productsContainer\');\n  const div = document.createElement(\'div\');\n  div.className = \'product-account-row\';\n  const products = getProducts();\n  const opts = products.filter(p => p.active).map(p =>\n    `<option value="${p.id}" ${p.id == data.productId ? \'selected\' : \'\'}>${p.name}</option>`\n  ).join(\'\');\n  const d = new Date(); d.setDate(d.getDate()+30);\n  const defDate = d.toISOString().split(\'T\')[0];\n  div.innerHTML = `\n    <div class="fg" style="min-width:120px;flex:2"><label>Produto</label>\n      <select class="user-product" style="width:100%"><option value="">Selecione...</option>${opts}</select>\n    </div>\n    <div class="fg" style="min-width:110px;flex:1"><label>Conta MT5</label>\n      <input type="number" class="user-account" placeholder="12345678" value="${data.account||\'\'}">\n    </div>\n    <div class="fg" style="width:82px"><label>Tipo</label>\n      <select class="user-account-type">\n        <option value="demo" ${(data.accountType||\'demo\')===\'demo\'?\'selected\':\'\'}>Demo</option>\n        <option value="real" ${data.accountType===\'real\'?\'selected\':\'\'}>Real</option>\n      </select>\n    </div>\n    <div class="fg" style="width:72px"><label>Lote Mín</label>\n      <input type="number" class="user-minlots" placeholder="0.01" step="0.01" min="0" value="${data.minLots||\'\'}">\n    </div>\n    <div class="fg" style="width:72px"><label>Lote Máx</label>\n      <input type="number" class="user-maxlots" placeholder="1.00" step="0.01" min="0" value="${data.maxLots||\'\'}">\n    </div>\n    <div class="fg" style="width:68px"><label>Instâncias</label>\n      <input type="number" class="user-instances" placeholder="1" min="1" value="${data.instances||1}">\n    </div>\n    <div class="fg" style="min-width:130px;flex:1"><label>Expiração</label>\n      <input type="date" class="product-expiry" style="width:100%" value="${data.expiry||defDate}">\n    </div>\n    <button class="remove-product" onclick="removeProduct(this)" style="align-self:flex-end">×</button>`;\n  container.appendChild(div);\n}\n\nfunction removeProduct(button) {\n  if (document.querySelectorAll(\'.product-account-row\').length > 1) button.parentElement.remove();\n  else showMsg(\'modalMsg\', \'É necessário ter pelo menos um produto.\', false);\n}\n\n// ── Salvar Usuário (envia para o servidor) ────────────────────────\nasync function saveUser() {\n  const userId  = document.getElementById(\'uId\').value;\n  const name    = document.getElementById(\'uName\').value.trim();\n  const email   = document.getElementById(\'uEmail\').value.trim();\n  const phone   = document.getElementById(\'uPhone\').value.trim();\n  const modal   = document.getElementById(\'userModal\');\n\n  // Coletar produtos do modal\n  const userProducts = [];\n  modal.querySelectorAll(\'.product-account-row\').forEach(row => {\n    const localProdId = row.querySelector(\'.user-product\').value;\n    const account     = row.querySelector(\'.user-account\').value.trim();\n    const accountType = row.querySelector(\'.user-account-type\').value;\n    const minLots     = parseFloat(row.querySelector(\'.user-minlots\').value)   || 0;\n    const maxLots     = parseFloat(row.querySelector(\'.user-maxlots\').value)   || 0;\n    const instances   = parseInt(row.querySelector(\'.user-instances\').value)   || 1;\n    const expiry      = row.querySelector(\'.product-expiry\').value;\n    if (localProdId && account) {\n      userProducts.push({ localProdId, account, accountType, minLots, maxLots, instances, expiry });\n    }\n  });\n\n  if (!name || userProducts.length === 0) {\n    showMsg(\'modalMsg\', \'❌ Preencha nome e pelo menos um produto\', false); return;\n  }\n\n  // Verificar mapeamento de IDs antes de qualquer chamada\n  for (const up of userProducts) {\n    const sid = toServerId(up.localProdId);\n    if (!sid) { showMsg(\'modalMsg\', `❌ Produto ID ${up.localProdId} sem mapeamento no servidor`, false); return; }\n    up.serverProdId = sid;\n  }\n\n  showMsg(\'modalMsg\', \'⏳ Salvando no servidor...\', true);\n\n  try {\n    // Agrupar por conta MT5 (cada conta precisa de um registro separado no servidor)\n    const byAccount = {};\n    userProducts.forEach(up => {\n      if (!byAccount[up.account]) byAccount[up.account] = [];\n      byAccount[up.account].push(up);\n    });\n\n    for (const [account, prods] of Object.entries(byAccount)) {\n      const mainExpiry = prods[0].expiry;\n\n      if (userId) {\n        // Editar: atualizar dados do usuário\n        await apiCall(\'PUT\', \'/admin/user\', { account, name, email, phone });\n        // Atualizar período se necessário\n        await apiCall(\'POST\', \'/admin/license\', { account, name, endDate: mainExpiry });\n      } else {\n        // Novo usuário: registrar com todos os produtos da conta\n        const serverProds = prods.map(up => ({\n          productId:   up.serverProdId,\n          accountType: up.accountType,\n          accountReal: up.accountType === \'real\' ? account : \'\',\n          accountDemo: up.accountType === \'demo\' ? account : \'\',\n          minLots:     up.minLots,\n          maxLots:     up.maxLots,\n          instances:   up.instances\n        }));\n        const r = await apiCall(\'POST\', \'/admin/register\', {\n          account, name, email, phone,\n          products: serverProds,\n          endDate: mainExpiry\n        });\n        if (!r || !r.ok) {\n          const errDetail = r?.error || (r ? JSON.stringify(r) : \'Servidor não respondeu\');\n          showMsg(\'modalMsg\', \'❌ Erro ao registrar conta \' + account + \': \' + errDetail, false);\n          console.error(\'Register error:\', r);\n          return;\n        }\n      }\n\n      // Atribuir/atualizar cada produto com restrições completas\n      for (const up of prods) {\n        const prod = _serverProducts.find(p => p.id === up.serverProdId);\n        await apiCall(\'POST\', \'/admin/user-product\', {\n          account,\n          productId:   up.serverProdId,\n          name:        prod ? prod.name : up.serverProdId,\n          accountType: up.accountType,\n          accountReal: up.accountType === \'real\' ? account : \'\',\n          accountDemo: up.accountType === \'demo\' ? account : \'\',\n          minLots:     up.minLots,\n          maxLots:     up.maxLots,\n          instances:   up.instances\n        });\n      }\n    }\n\n    // Salvar localmente para exibição imediata\n    const users  = getUsers();\n    const lics   = getLicenses();\n    let localUser;\n    if (userId) {\n      localUser = users.find(u => u.id == userId);\n      if (localUser) { localUser.name = name; localUser.email = email; localUser.phone = phone; }\n      saveUsers(users);\n      const otherLics = lics.filter(l => l.userId != userId);\n      const newLics = userProducts.map(up => ({\n        id: Date.now() + Math.random(), userId: parseInt(userId),\n        productId: parseInt(up.localProdId), account: up.account,\n        accountType: up.accountType, minLots: up.minLots,\n        maxLots: up.maxLots, instances: up.instances, expiry: up.expiry,\n        created: new Date().toISOString()\n      }));\n      saveLicenses([...otherLics, ...newLics]);\n    } else {\n      localUser = { id: Date.now(), name, email, phone, created: new Date().toISOString() };\n      users.push(localUser); saveUsers(users);\n      const newLics = userProducts.map(up => ({\n        id: Date.now() + Math.random(), userId: localUser.id,\n        productId: parseInt(up.localProdId), account: up.account,\n        accountType: up.accountType, minLots: up.minLots,\n        maxLots: up.maxLots, instances: up.instances, expiry: up.expiry,\n        created: new Date().toISOString()\n      }));\n      saveLicenses([...lics, ...newLics]);\n    }\n\n    showMsg(\'modalMsg\', userId ? \'✅ Usuário atualizado no servidor!\' : \'✅ Usuário registrado no servidor!\', true);\n    setTimeout(() => { closeUserModal(); renderUsersTable(); updateStats(); }, 1000);\n\n  } catch(e) {\n    showMsg(\'modalMsg\', \'❌ Erro: \' + e.message, false);\n  }\n}\n\n// ── Produtos (local) ──────────────────────────────────────────────\nfunction addProd() {\n  const name = document.getElementById(\'pName\').value.trim();\n  const type = document.getElementById(\'pType\').value;\n  const desc = document.getElementById(\'pDesc\').value.trim();\n  if (!name || !type) { showMsg(\'msg3\', \'❌ Preencha nome e tipo\', false); return; }\n  const products = getProducts();\n  products.push({ id: Date.now(), name, type, description: desc, active: true });\n  saveProducts(products);\n  showMsg(\'msg3\', \'✅ Produto adicionado!\', true);\n  document.getElementById(\'pName\').value = \'\';\n  document.getElementById(\'pDesc\').value = \'\';\n  renderProductsTable();\n  loadProductsDropdown(\'#mProduct\');\n}\n\nfunction editProduct(id) {\n  const products = getProducts();\n  const product  = products.find(p => p.id === id);\n  if (!product) return;\n  let modal = document.getElementById(\'editProdModal\');\n  if (!modal) {\n    modal = document.createElement(\'div\');\n    modal.id = \'editProdModal\'; modal.className = \'modal\'; modal.style.display = \'none\';\n    modal.innerHTML = `\n      <div class="modal-content" style="max-width:480px">\n        <div class="modal-header">\n          <h3 class="modal-title">✏️ Editar Produto</h3>\n          <span class="close" onclick="document.getElementById(\'editProdModal\').style.display=\'none\'">&times;</span>\n        </div>\n        <div class="modal-body">\n          <div id="editProdMsg" class="msg"></div>\n          <div class="form-row" style="margin-bottom:10px">\n            <div class="fg" style="width:100%"><label>ID</label>\n              <input type="text" id="eProdId" style="width:100%;opacity:.6" readonly>\n            </div>\n          </div>\n          <div class="form-row" style="margin-bottom:10px">\n            <div class="fg" style="width:100%"><label>Nome *</label>\n              <input type="text" id="eProdName" style="width:100%">\n            </div>\n          </div>\n          <div class="form-row" style="margin-bottom:10px">\n            <div class="fg" style="width:100%"><label>Tipo</label>\n              <select id="eProdType" style="width:100%">\n                <option value="ea">Expert Advisor</option>\n                <option value="indicator">Indicador</option>\n                <option value="dashboard">Dashboard</option>\n                <option value="other">Outro</option>\n              </select>\n            </div>\n          </div>\n          <div class="form-row" style="margin-bottom:16px">\n            <div class="fg" style="width:100%"><label>Descrição</label>\n              <input type="text" id="eProdDesc" style="width:100%">\n            </div>\n          </div>\n          <div style="display:flex;gap:8px;justify-content:flex-end">\n            <button class="btn" style="background:#21262d;color:#e6edf3" onclick="document.getElementById(\'editProdModal\').style.display=\'none\'">Cancelar</button>\n            <button class="btn btn-green" onclick="saveEditProduct()">✓ Salvar</button>\n          </div>\n        </div>\n      </div>`;\n    document.body.appendChild(modal);\n  }\n  document.getElementById(\'eProdId\').value   = product.id;\n  document.getElementById(\'eProdName\').value = product.name;\n  document.getElementById(\'eProdType\').value = product.type.toLowerCase().replace(\' \',\'_\') || \'ea\';\n  document.getElementById(\'eProdDesc\').value = product.description || \'\';\n  modal.style.display = \'block\';\n}\n\nfunction saveEditProduct() {\n  const id   = document.getElementById(\'eProdId\').value;\n  const name = document.getElementById(\'eProdName\').value.trim();\n  const type = document.getElementById(\'eProdType\').value;\n  const desc = document.getElementById(\'eProdDesc\').value.trim();\n  if (!name) { showMsg(\'editProdMsg\', \'❌ Nome obrigatório\', false); return; }\n  const products = getProducts();\n  const idx = products.findIndex(p => p.id == id);\n  if (idx === -1) return;\n  products[idx].name = name; products[idx].type = type; products[idx].description = desc;\n  saveProducts(products);\n  renderProductsTable();\n  loadProductsDropdown(\'#mProduct\');\n  document.getElementById(\'editProdModal\').style.display = \'none\';\n  showMsg(\'msg3\', \'✅ Produto atualizado!\', true);\n}\n\nfunction toggleProduct(id) {\n  const products = getProducts();\n  const idx = products.findIndex(p => p.id === id);\n  if (idx !== -1) { products[idx].active = !products[idx].active; saveProducts(products); renderProductsTable(); loadProductsDropdown(\'#mProduct\'); }\n}\n\nfunction delProd(id) {\n  if (!confirm(\'Remover produto?\')) return;\n  saveProducts(getProducts().filter(p => p.id !== id));\n  renderProductsTable(); loadProductsDropdown(\'#mProduct\');\n}\n\n// ── Limpar banco completo ─────────────────────────────────────────\nasync function limparBanco() {\n  if (!confirm(\'⚠️ ATENÇÃO: Isso vai remover TODOS os usuários e licenças do servidor.\\n\\nOs produtos do catálogo serão preservados.\\n\\nConfirma?\')) return;\n  if (!confirm(\'Tem certeza? Esta ação não pode ser desfeita.\')) return;\n  const r = await apiCall(\'DELETE\', \'/admin/wipe\');\n  if (r && r.ok) {\n    // Limpar também o localStorage\n    saveUsers([]); saveLicenses([]);\n    showMsg(\'msg2\', `✅ Banco limpo! ${r.accountsRemoved} conta(s) removida(s).`, true);\n    renderUsersTable(); updateStats();\n  } else {\n    showMsg(\'msg2\', \'❌ Erro ao limpar banco: \' + (r?.error || \'Servidor indisponível\'), false);\n  }\n}\nasync function deleteUser(id) {\n  // Esta função só age sobre dados locais do localStorage\n  // Para usuários vindos do servidor, usar o botão 🗑 (delUser(acct))\n  const lics = getLicenses().filter(l => l.userId === id);\n  if (lics.length === 0) {\n    // Sem dados locais — não fazer nada (usuário vem do servidor)\n    showMsg(\'msg2\', \'⚠️ Use o botão 🗑 na linha do usuário para remover.\', false);\n    return;\n  }\n  if (!confirm(\'Remover usuário?\')) return;\n  for (const l of lics) {\n    await apiCall(\'DELETE\', \'/admin/user\', { account: String(l.account) });\n  }\n  saveUsers(getUsers().filter(u => u.id !== id));\n  saveLicenses(getLicenses().filter(l => l.userId !== id));\n  renderUsersTable(); updateStats();\n  showMsg(\'msg2\', \'✅ Usuário removido!\', true);\n}\n\n// ── Init ──────────────────────────────────────────────────────────\nasync function loadServerProducts() {\n  try {\n    const r = await apiCall(\'GET\', \'/admin/products\');\n    if (r && r.products) {\n      _serverProducts = r.products;\n      console.log(\'[Admin] Produtos carregados:\', _serverProducts.map(p => p.id+\':\'+p.name).join(\', \'));\n    }\n  } catch(e) { console.warn(\'[Admin] Produtos não carregados:\', e.message); }\n}\n\ndocument.addEventListener(\'DOMContentLoaded\', async function() {\n  initializeDatabase();\n\n  // Usar dados injetados pelo servidor (quando admin serve via /admin)\n  if (window.__SERVER_BOOTSTRAP__) {\n    const b = window.__SERVER_BOOTSTRAP__;\n    // Dados já estão no servidor — renderizar tabela de usuários direto do HTML injetado\n    if (b.rows) renderUsersFromServerRows(b.rows);\n    if (b.stats) renderStatsFromServer(b.stats);\n    if (b.productsJson) {\n      _serverProducts = Array.isArray(b.productsJson) ? b.productsJson : [];\n      // Sincronizar produtos locais com os do servidor\n      // IMPORTANTE: usar nomes MAIÚSCULOS para compatibilidade com PRODUCT_ID_MAP\n      if (_serverProducts.length > 0) {\n        const mapped = _serverProducts.map((p,i) => ({\n          id: i+1,\n          name: p.name.toUpperCase(), // garante compatibilidade com PRODUCT_ID_MAP\n          type: p.type||\'ea\',\n          description: p.description||\'\',\n          active: p.active!==false,\n          serverId: p.id // guardar o ID real do servidor\n        }));\n        saveProducts(mapped);\n      }\n    }\n    renderProductsTable();\n    loadProductsDropdown(\'#mProduct\');\n    // Auth não é necessário quando servido pelo servidor\n    AUTH = AUTH || \'server-injected\';\n  } else {\n    renderProductsTable();\n    renderUsersTable();\n    updateStats();\n    loadProductsDropdown(\'#mProduct\');\n    checkCredentials();\n    if (AUTH) await loadServerProducts();\n  }\n\n  const defaultDate = new Date();\n  defaultDate.setDate(defaultDate.getDate() + 30);\n  document.getElementById(\'mExpiry\').value = defaultDate.toISOString().split(\'T\')[0];\n});\n\nfunction renderUsersFromServerRows(rows) {\n  const table = document.getElementById(\'usersTable\');\n  if (!rows || rows.trim() === \'\') {\n    table.innerHTML = \'<tr><td colspan="7" class="loading">Nenhum usuário cadastrado</td></tr>\';\n    return;\n  }\n  table.innerHTML = rows;\n  // Sincronizar localStorage com dados do servidor\n  // (extrair contas das rows para exibição correta)\n}\n\nfunction renderStatsFromServer(stats) {\n  if (!stats) return;\n  document.getElementById(\'total-users\').textContent   = stats.total   || 0;\n  document.getElementById(\'premium-users\').textContent = stats.premium || 0;\n  document.getElementById(\'trial-users\').textContent   = stats.trial   || 0;\n  document.getElementById(\'expired-users\').textContent = stats.expired || 0;\n  document.getElementById(\'active-users\').textContent  = stats.active  || 0;\n}\n\nwindow.onclick = function(event) {\n  if (event.target.className === \'modal\') closeUserModal();\n};\n\n// ── Atualizar tabela de usuários sem recarregar a página ──────────\nasync function refreshUsersTable() {\n  try {\n    // Buscar dados atualizados do servidor\n    const r = await fetch(SERVER + \'/admin\', { headers: { \'Authorization\': AUTH } });\n    if (r.ok) {\n      const html = await r.text();\n      // Extrair tbody\n      const match = html.match(/<tbody>([\\s\\S]*?)<\\/tbody>/);\n      if (match && match[1]) {\n        document.getElementById(\'usersTable\').innerHTML = match[1];\n      }\n      // Extrair stats\n      const nums = html.match(/>(\\d+)<\\/div><div class="[ln]"/g);\n      const statsMatch = html.match(/id="(total|premium|trial|expired|active)-users">(\\d+)</g);\n      if (statsMatch) {\n        statsMatch.forEach(m => {\n          const id = m.match(/id="([^"]+)">(\\d+)/);\n          if (id) {\n            const el = document.getElementById(id[1]);\n            if (el) el.textContent = id[2];\n          }\n        });\n      }\n    }\n  } catch(e) {\n    console.warn(\'refreshUsersTable error:\', e);\n    // Fallback: atualizar só a tabela local\n    renderUsersTable(); updateStats();\n  }\n}\n\n// ══════════════════════════════════════════════════════════════════\n//  FUNÇÕES DOS BOTÕES DA TABELA DE USUÁRIOS\n//  (chamadas pelas rows geradas pelo servidor via __SERVER_BOOTSTRAP__)\n// ══════════════════════════════════════════════════════════════════\n\n// ── ✏️ Editar usuário ─────────────────────────────────────────────\nfunction editUser(acct, name, email, phone) {\n  let modal = document.getElementById(\'editUserModal\');\n  if (!modal) {\n    modal = document.createElement(\'div\');\n    modal.id = \'editUserModal\'; modal.className = \'modal\';\n    modal.innerHTML = `\n      <div class="modal-content" style="max-width:500px">\n        <div class="modal-header">\n          <h3 class="modal-title">✏️ Editar Usuário</h3>\n          <span class="close" onclick="document.getElementById(\'editUserModal\').style.display=\'none\'">&times;</span>\n        </div>\n        <div class="modal-body">\n          <div id="msgEdit" class="msg"></div>\n          <input type="hidden" id="eAcct">\n          <div class="form-row" style="margin-bottom:8px">\n            <div class="fg" style="width:100%"><label>Nome</label>\n              <input type="text" id="eName" style="width:100%">\n            </div>\n          </div>\n          <div class="form-row" style="margin-bottom:8px">\n            <div class="fg" style="width:100%"><label>E-mail</label>\n              <input type="email" id="eEmail" style="width:100%">\n            </div>\n          </div>\n          <div class="form-row" style="margin-bottom:14px">\n            <div class="fg" style="width:100%"><label>Telefone</label>\n              <input type="tel" id="ePhone" style="width:100%">\n            </div>\n          </div>\n          <div style="display:flex;gap:8px;justify-content:flex-end">\n            <button class="btn-sm" onclick="document.getElementById(\'editUserModal\').style.display=\'none\'">Cancelar</button>\n            <button class="btn btn-green" onclick="saveEdit()">✓ Salvar</button>\n          </div>\n        </div>\n      </div>`;\n    document.body.appendChild(modal);\n  }\n  document.getElementById(\'eAcct\').value  = acct;\n  document.getElementById(\'eName\').value  = name  || \'\';\n  document.getElementById(\'eEmail\').value = email || \'\';\n  document.getElementById(\'ePhone\').value = phone || \'\';\n  modal.style.display = \'block\';\n}\n\nasync function saveEdit() {\n  const acct  = document.getElementById(\'eAcct\').value;\n  const name  = document.getElementById(\'eName\').value.trim();\n  const email = document.getElementById(\'eEmail\').value.trim();\n  const phone = document.getElementById(\'ePhone\').value.trim();\n  const r = await apiCall(\'PUT\', \'/admin/user\', { account: acct, name, email, phone });\n  if (r && r.ok) {\n    showMsg(\'msgEdit\', \'✅ Salvo!\', true);\n    setTimeout(() => { document.getElementById(\'editUserModal\').style.display=\'none\'; refreshUsersTable(); }, 1000);\n  } else {\n    showMsg(\'msgEdit\', \'❌ Erro: \' + (r?.error||\'\'), false);\n  }\n}\n\n// ── 📅 Licença (bonus/extensão) ───────────────────────────────────\nlet _bonusAcct = \'\';\nfunction bonusModal(acct, name) {\n  _bonusAcct = acct;\n  let modal = document.getElementById(\'bonusUserModal\');\n  if (!modal) {\n    modal = document.createElement(\'div\');\n    modal.id = \'bonusUserModal\'; modal.className = \'modal\';\n    modal.innerHTML = `\n      <div class="modal-content" style="max-width:480px">\n        <div class="modal-header">\n          <h3 class="modal-title">📅 Gerenciar Licença</h3>\n          <span class="close" onclick="document.getElementById(\'bonusUserModal\').style.display=\'none\'">&times;</span>\n        </div>\n        <div class="modal-body">\n          <div id="msgBonus" class="msg"></div>\n          <div class="form-row" style="margin-bottom:8px">\n            <div class="fg" style="flex:1"><label>Nome</label><input type="text" id="bName" style="width:100%"></div>\n          </div>\n          <div class="form-row" style="margin-bottom:8px">\n            <div class="fg"><label>Atalhos</label>\n              <div style="display:flex;gap:4px">\n                <button class="btn-sm" onclick="bonusAddDays(7)">+7d</button>\n                <button class="btn-sm" onclick="bonusAddDays(15)">+15d</button>\n                <button class="btn-sm" onclick="bonusAddDays(30)">+30d</button>\n                <button class="btn-sm" onclick="bonusAddDays(90)">+3m</button>\n                <button class="btn-sm" onclick="bonusAddDays(180)">+6m</button>\n                <button class="btn-sm" onclick="bonusAddDays(365)">+1a</button>\n              </div>\n            </div>\n          </div>\n          <div class="form-row" style="margin-bottom:14px">\n            <div class="fg"><label>Data Final</label><input type="date" id="bDate" style="width:160px"></div>\n          </div>\n          <div style="display:flex;gap:8px;justify-content:flex-end">\n            <button class="btn-sm" onclick="document.getElementById(\'bonusUserModal\').style.display=\'none\'">Cancelar</button>\n            <button class="btn btn-green" style="background:#7c3aed" onclick="saveLicLifetime()">♾ Vitalícia</button>\n            <button class="btn btn-green" onclick="saveBonus()">✓ Salvar</button>\n          </div>\n        </div>\n      </div>`;\n    document.body.appendChild(modal);\n  }\n  document.getElementById(\'bName\').value = name || \'\';\n  const def = new Date(); def.setDate(def.getDate()+30);\n  document.getElementById(\'bDate\').value = def.toISOString().split(\'T\')[0];\n  modal.style.display = \'block\';\n}\n\nfunction bonusAddDays(n) {\n  const el = document.getElementById(\'bDate\');\n  const base = el.value ? new Date(el.value+\'T00:00:00\') : new Date();\n  base.setDate(base.getDate()+n);\n  el.value = base.toISOString().split(\'T\')[0];\n}\n\nasync function saveBonus() {\n  const endDate = document.getElementById(\'bDate\').value;\n  const name    = document.getElementById(\'bName\').value.trim();\n  if (!endDate) { showMsg(\'msgBonus\',\'❌ Selecione uma data\',false); return; }\n  const r = await apiCall(\'POST\',\'/admin/license\',{account:_bonusAcct,name,endDate});\n  if (r && r.ok) {\n    showMsg(\'msgBonus\',\'✅ Até \'+r.expiresStr,true);\n    setTimeout(()=>{document.getElementById(\'bonusUserModal\').style.display=\'none\';refreshUsersTable();},1200);\n  } else showMsg(\'msgBonus\',\'❌ \'+(r?.error||\'Erro\'),false);\n}\n\nasync function saveLicLifetime() {\n  const name = document.getElementById(\'bName\').value.trim();\n  const r = await apiCall(\'POST\',\'/admin/license\',{account:_bonusAcct,name,lifetime:true});\n  if (r && r.ok) {\n    showMsg(\'msgBonus\',\'✅ Licença Vitalícia aplicada!\',true);\n    setTimeout(()=>{document.getElementById(\'bonusUserModal\').style.display=\'none\';refreshUsersTable();},1200);\n  } else showMsg(\'msgBonus\',\'❌ \'+(r?.error||\'Erro\'),false);\n}\n\n// ── 🚫 Revogar licença ────────────────────────────────────────────\nasync function revogar(acct) {\n  if (!confirm(\'Revogar licença de \'+acct+\'?\')) return;\n  const r = await apiCall(\'DELETE\',\'/admin/license\',{account:acct});\n  if (r && r.ok) {\n    showMsg(\'msg2\',\'✅ Licença revogada!\',true);\n    setTimeout(()=>refreshUsersTable(),1000);\n  } else showMsg(\'msg2\',\'❌ Erro ao revogar\',false);\n}\n\n// ── ↺ Resetar senha ───────────────────────────────────────────────\nasync function resetPw(acct) {\n  if (!confirm(\'Resetar senha de \'+acct+\'?\')) return;\n  const r = await apiCall(\'POST\',\'/admin/reset-password\',{account:acct});\n  if (r && r.ok) alert(\'✅ Senha resetada!\');\n  else alert(\'❌ Erro ao resetar\');\n}\n\n// ── 🗑 Excluir usuário (por conta MT5) ───────────────────────────\nasync function delUser(acct) {\n  if (!confirm(\'⚠️ Remover COMPLETAMENTE o usuário \'+acct+\'?\\nEsta ação não pode ser desfeita.\')) return;\n  const r = await apiCall(\'DELETE\',\'/admin/user\',{account:String(acct)});\n  if (r && r.ok) {\n    showMsg(\'msg2\',\'✅ Usuário \'+acct+\' removido!\',true);\n    // Limpar localStorage local também\n    const lics = getLicenses().filter(l => String(l.account) !== String(acct));\n    saveLicenses(lics);\n    // Remover linha da tabela diretamente sem recarregar\n    const rows = document.querySelectorAll(\'#usersTable tr\');\n    rows.forEach(row => {\n      if (row.textContent.includes(String(acct))) {\n        row.style.transition = \'opacity 0.3s\';\n        row.style.opacity = \'0\';\n        setTimeout(() => row.remove(), 300);\n      }\n    });\n    // Atualizar contadores\n    setTimeout(() => refreshUsersTable(), 800);\n  } else {\n    showMsg(\'msg2\',\'❌ Erro ao remover: \'+(r?.error||\'Servidor indisponível\'),false);\n  }\n}\n\n// ── 📦 Atribuir produto ───────────────────────────────────────────\nlet _prodAcctServer = \'\';\nfunction addUserProd(acct) {\n  _prodAcctServer = acct;\n  let modal = document.getElementById(\'addProdModal\');\n  if (!modal) {\n    modal = document.createElement(\'div\');\n    modal.id = \'addProdModal\'; modal.className = \'modal\';\n    modal.innerHTML = `\n      <div class="modal-content" style="max-width:600px">\n        <div class="modal-header">\n          <h3 class="modal-title">📦 Atribuir Produto</h3>\n          <span class="close" onclick="document.getElementById(\'addProdModal\').style.display=\'none\'">&times;</span>\n        </div>\n        <div class="modal-body">\n          <div id="msgProd" class="msg"></div>\n          <div class="form-row" style="margin-bottom:8px">\n            <div class="fg" style="flex:2"><label>Conta MT5</label>\n              <input type="text" id="pAcctDisp" style="width:100%;opacity:.7" readonly>\n            </div>\n            <div class="fg" style="flex:3"><label>Produto *</label>\n              <select id="pProdSel" style="width:100%">\n                <option value="">Selecione...</option>\n              </select>\n            </div>\n          </div>\n          <div class="form-row" style="margin-bottom:8px">\n            <div class="fg" style="width:90px"><label>Tipo</label>\n              <select id="pAcctType">\n                <option value="demo">Demo</option>\n                <option value="real">Real</option>\n              </select>\n            </div>\n            <div class="fg" style="width:80px"><label>Lote Mín</label>\n              <input type="number" id="pMinL" value="0" step="0.01" min="0">\n            </div>\n            <div class="fg" style="width:80px"><label>Lote Máx</label>\n              <input type="number" id="pMaxL" value="0" step="0.01" min="0">\n            </div>\n            <div class="fg" style="width:75px"><label>Instâncias</label>\n              <input type="number" id="pInst" value="1" min="1">\n            </div>\n          </div>\n          <div class="form-row" style="margin-bottom:14px">\n            <div class="fg" style="flex:1"><label>Conta Real MT5</label>\n              <input type="text" id="pReal" placeholder="opcional">\n            </div>\n            <div class="fg" style="flex:1"><label>Conta Demo MT5</label>\n              <input type="text" id="pDemo" placeholder="opcional">\n            </div>\n          </div>\n          <div style="display:flex;gap:8px;justify-content:flex-end">\n            <button class="btn-sm" onclick="document.getElementById(\'addProdModal\').style.display=\'none\'">Cancelar</button>\n            <button class="btn btn-green" onclick="saveProd()">✓ Atribuir</button>\n          </div>\n        </div>\n      </div>`;\n    document.body.appendChild(modal);\n  }\n  // Preencher conta e popular dropdown de produtos do servidor\n  document.getElementById(\'pAcctDisp\').value = acct;\n  document.getElementById(\'pReal\').value = \'\';\n  document.getElementById(\'pDemo\').value = \'\';\n  const sel = document.getElementById(\'pProdSel\');\n  sel.innerHTML = \'<option value="">Selecione...</option>\';\n  // Usar produtos do servidor se disponíveis, senão usar locais\n  const prods = _serverProducts.length > 0 ? _serverProducts : getProducts().map(p=>({id:toServerId(p.id)||p.id, name:p.name}));\n  prods.forEach(p => {\n    const o = document.createElement(\'option\');\n    o.value = p.id; o.textContent = p.name;\n    sel.appendChild(o);\n  });\n  modal.style.display = \'block\';\n}\n\nasync function saveProd() {\n  const pid  = document.getElementById(\'pProdSel\').value;\n  const acct = _prodAcctServer;\n  const type = document.getElementById(\'pAcctType\').value;\n  if (!pid) { showMsg(\'msgProd\',\'❌ Selecione um produto\',false); return; }\n  const prod = _serverProducts.find(p=>p.id===pid);\n  const r = await apiCall(\'POST\',\'/admin/user-product\',{\n    account:acct, productId:pid,\n    name: prod?prod.name:pid,\n    accountType: type,\n    minLots:   parseFloat(document.getElementById(\'pMinL\').value)||0,\n    maxLots:   parseFloat(document.getElementById(\'pMaxL\').value)||0,\n    instances: parseInt(document.getElementById(\'pInst\').value)||1,\n    accountReal: document.getElementById(\'pReal\').value||\'\',\n    accountDemo: document.getElementById(\'pDemo\').value||\'\'\n  });\n  if (r && r.ok) {\n    showMsg(\'msgProd\',\'✅ Produto atribuído!\',true);\n    setTimeout(()=>{document.getElementById(\'addProdModal\').style.display=\'none\';refreshUsersTable();},1000);\n  } else showMsg(\'msgProd\',\'❌ \'+(r?.error||\'Erro\'),false);\n}\n</script>\n</body>\n</html>\n';
  return adminHtml.replace('</body>', bootstrapScript + '\n</body>');
}

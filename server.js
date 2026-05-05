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
// Admin HTML — lido do arquivo admin.html no mesmo diretório
function buildAdminHTML(rows, stats, prodRows, productsJson) {
  const adminFile = path.join(__dirname, 'admin.html');
  let html;
  try {
    html = fs.readFileSync(adminFile, 'utf-8');
  } catch(e) {
    return '<h1>admin.html não encontrado</h1><p>Coloque o arquivo admin.html no mesmo diretório que server.js</p>';
  }
  // Injetar dados do servidor via script bootstrap
  const bootstrap = `<script id="dashbot-bootstrap">
window.__DASHBOT_DATA__ = {
  rows: ${JSON.stringify(rows)},
  stats: ${JSON.stringify(stats)},
  products: ${productsJson||'[]'}
};
</script>`;
  return html.replace('</body>', bootstrap + '\n</body>');
}

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
      if(lics[key]){sendJSON(res,409,{error:'Conta já existe'});return;}

      // Montar produtos iniciais
      const initProds=[];
      if(d.products&&Array.isArray(d.products)){
        d.products.forEach(up=>{
          const catProd=(lics._products||[]).find(p=>p.id===up.productId);
          if(catProd) initProds.push({
            id:up.productId,name:catProd.name,assignedAt:now,
            accountType:up.accountType||'',
            accountReal:up.accountReal||'',accountDemo:up.accountDemo||'',
            minLots:parseFloat(up.minLots)||0,maxLots:parseFloat(up.maxLots)||0,
            instances:parseInt(up.instances)||1
          });
        });
      }

      // Tipo de licença
      let type='trial',premiumEnd=null,trialEnd=now+TRIAL_DAYS*DAY_MS;
      if(d.lifetime){type='lifetime';}
      else if(d.endDate){type='premium';premiumEnd=new Date(d.endDate).getTime();}

      lics[key]={account:key,name:d.name||'',email:d.email||'',phone:d.phone||'',
        type,trialStart:now,trialEnd,premiumStart:type==='premium'?now:undefined,
        premiumEnd,firstSeen:now,lastSeen:0,products:initProds};
      const ok=await saveLics(lics);
      sendJSON(res,ok?200:500,{ok,account:key});return;
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
const prodsJs=productsJson||'[]';
return `<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashbot Admin v3</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;padding:16px;font-size:13px}
h1{color:#58a6ff;margin-bottom:2px;font-size:20px}
.sub{color:#8b949e;font-size:12px;margin-bottom:14px}
.stats{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.stat{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:8px 14px;min-width:80px;text-align:center}
.stat .n{font-size:20px;font-weight:700;color:#58a6ff}.stat .l{font-size:10px;color:#8b949e;text-transform:uppercase}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px;margin-bottom:12px}
.card-title{font-size:11px;font-weight:700;color:#58a6ff;margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:8px}
.fg{display:flex;flex-direction:column;gap:3px}
label{font-size:10px;color:#8b949e;font-weight:600;text-transform:uppercase}
input,select{background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:5px 8px;border-radius:5px;font-size:12px}
input[type=date]{color-scheme:dark}
input:focus,select:focus{outline:none;border-color:#388bfd}
.btn{background:#1f6feb;color:#fff;border:none;padding:6px 12px;border-radius:5px;cursor:pointer;font-size:12px;font-weight:600}
.btn:hover{background:#388bfd}.btn-g{background:#10b981}.btn-g:hover{background:#059669}
.btn-v{background:#7c3aed}.btn-v:hover{background:#6d28d9}
.btn-sm{background:#21262d;color:#e6edf3;border:1px solid #30363d;padding:2px 7px;border-radius:4px;cursor:pointer;font-size:10px;margin:1px;white-space:nowrap}
.btn-sm:hover{background:#30363d}.btn-red{color:#f85149!important}
.badge{display:inline-block;padding:2px 6px;border-radius:10px;font-size:10px;font-weight:700;color:#fff}
.msg{padding:6px 10px;border-radius:5px;font-size:12px;margin-bottom:8px;display:none}
.msg.ok{background:#0d2e1f;border:1px solid #10b981;color:#10b981}
.msg.err{background:#2d1117;border:1px solid #f85149;color:#f85149}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:6px 8px;border-bottom:1px solid #30363d;color:#8b949e;font-size:10px;text-transform:uppercase;white-space:nowrap}
td{padding:5px 8px;border-bottom:1px solid #21262d;vertical-align:top}
tr:hover td{background:#1c2128}
.modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:100;align-items:center;justify-content:center;overflow-y:auto}
.modal-bg.open{display:flex}
.modal{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;width:90%;max-width:560px;max-height:90vh;overflow-y:auto;margin:auto}
.modal h3{color:#58a6ff;margin-bottom:14px;font-size:14px}
.mbtn{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
.sep{border-top:1px solid #30363d;margin:12px 0;padding-top:12px}
.acct-block{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px;margin-bottom:8px}
.key-box{background:#0d1117;border:1px solid #388bfd;border-radius:6px;padding:10px;font-family:monospace;font-size:11px;word-break:break-all;color:#58a6ff;margin-top:8px}
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

<!-- MODAL: Licença/Bônus -->
<div class="modal-bg" id="mBonus"><div class="modal">
  <h3>📅 Gerenciar Licença</h3><div id="msgBonus" class="msg"></div>
  <div class="row">
    <div class="fg"><label>Conta</label><input id="bAcct" readonly style="width:120px"></div>
    <div class="fg"><label>Nome</label><input id="bName" style="width:180px"></div>
  </div>
  <div class="row">
    <div class="fg"><label>Atalhos</label>
      <div style="display:flex;gap:4px">
        <button class="btn-sm" onclick="bAdd(7)">+7d</button>
        <button class="btn-sm" onclick="bAdd(15)">+15d</button>
        <button class="btn-sm" onclick="bAdd(30)">+30d</button>
        <button class="btn-sm" onclick="bAdd(90)">+3m</button>
        <button class="btn-sm" onclick="bAdd(180)">+6m</button>
        <button class="btn-sm" onclick="bAdd(365)">+1a</button>
      </div>
    </div>
  </div>
  <div class="row">
    <div class="fg"><label>Data final</label><input type="date" id="bDate" style="width:160px"></div>
  </div>
  <div class="mbtn">
    <button class="btn-sm" onclick="cm('mBonus')">Cancelar</button>
    <button class="btn btn-v" onclick="saveLicLifetime()">♾ Vitalícia</button>
    <button class="btn btn-g" onclick="saveBonus()">✓ Salvar</button>
  </div>
</div></div>

<!-- MODAL: Editar usuário -->
<div class="modal-bg" id="mEdit"><div class="modal">
  <h3>✏️ Editar Usuário</h3><div id="msgEdit" class="msg"></div>
  <div class="row"><div class="fg"><label>Conta MT5</label><input id="eAcct" readonly style="width:120px"></div></div>
  <div class="row"><div class="fg" style="flex:1"><label>Nome</label><input id="eName" style="width:100%"></div></div>
  <div class="row"><div class="fg" style="flex:1"><label>E-mail</label><input id="eEmail" type="email" style="width:100%"></div></div>
  <div class="row"><div class="fg" style="flex:1"><label>Telefone</label><input id="ePhone" style="width:100%"></div></div>
  <div class="mbtn"><button class="btn-sm" onclick="cm('mEdit')">Cancelar</button><button class="btn btn-g" onclick="saveEdit()">✓ Salvar</button></div>
</div></div>

<!-- MODAL: Atribuir produto -->
<div class="modal-bg" id="mProd"><div class="modal">
  <h3>📦 Atribuir Produto ao Usuário</h3><div id="msgProd" class="msg"></div>
  <div class="row">
    <div class="fg"><label>Conta MT5</label><input id="pAcct" readonly style="width:120px"></div>
    <div class="fg" style="flex:1"><label>Produto</label><select id="pProdSel" style="width:100%"><option value="">Selecione...</option></select></div>
  </div>
  <div class="sep">
    <div style="font-size:10px;color:#58a6ff;font-weight:700;text-transform:uppercase;margin-bottom:8px">Configurações deste usuário</div>
    <div class="row">
      <div class="fg"><label>Tipo de conta</label><select id="pAcctType" style="width:100px"><option value="">Ambas</option><option value="real">Real</option><option value="demo">Demo</option></select></div>
      <div class="fg"><label>Lote mín.</label><input type="number" id="pMinL" value="0" step="0.01" style="width:75px"></div>
      <div class="fg"><label>Lote máx.</label><input type="number" id="pMaxL" value="0" step="0.01" style="width:75px"></div>
      <div class="fg"><label>Instâncias</label><input type="number" id="pInst" value="1" min="1" style="width:65px"></div>
    </div>
    <div class="row">
      <div class="fg" style="flex:1"><label>Conta Real MT5</label><input id="pReal" style="width:100%"></div>
      <div class="fg" style="flex:1"><label>Conta Demo MT5</label><input id="pDemo" style="width:100%"></div>
    </div>
  </div>
  <div class="mbtn"><button class="btn-sm" onclick="cm('mProd')">Cancelar</button><button class="btn btn-g" onclick="saveProd()">✓ Atribuir</button></div>
</div></div>

<!-- MODAL: Adicionar usuário -->
<div class="modal-bg" id="mReg"><div class="modal">
  <h3>➕ Adicionar Usuário</h3><div id="msgReg" class="msg"></div>
  <div class="row">
    <div class="fg" style="flex:1"><label>Nome *</label><input id="rName" style="width:100%"></div>
  </div>
  <div class="row">
    <div class="fg" style="flex:1"><label>E-mail</label><input id="rEmail" type="email" style="width:100%"></div>
    <div class="fg" style="flex:1"><label>Telefone</label><input id="rPhone" style="width:100%"></div>
  </div>

  <div class="sep">
    <div style="font-size:10px;color:#58a6ff;font-weight:700;text-transform:uppercase;margin-bottom:8px">Produto e Contas MT5</div>
    <div class="row">
      <div class="fg" style="flex:1"><label>Produto *</label><select id="rProd" style="width:100%"><option value="">Selecione...</option></select></div>
    </div>
    <div id="rAcctsWrap"></div>
    <button class="btn-sm" style="margin-top:4px" onclick="addAcctRow()">+ Adicionar Conta MT5</button>
  </div>

  <div class="sep">
    <div style="font-size:10px;color:#58a6ff;font-weight:700;text-transform:uppercase;margin-bottom:8px">Período da Licença</div>
    <div class="row">
      <div class="fg"><label>Atalhos</label>
        <div style="display:flex;gap:4px">
          <button class="btn-sm" onclick="rAdd(30)">+30d</button>
          <button class="btn-sm" onclick="rAdd(90)">+3m</button>
          <button class="btn-sm" onclick="rAdd(180)">+6m</button>
          <button class="btn-sm" onclick="rAdd(365)">+1a</button>
        </div>
      </div>
    </div>
    <div class="row">
      <div class="fg"><label>Data final</label><input type="date" id="rDate" style="width:160px"></div>
    </div>
  </div>

  <div class="mbtn">
    <button class="btn-sm" onclick="cm('mReg')">Cancelar</button>
    <button class="btn btn-v" onclick="saveRegLifetime()">♾ Vitalícia</button>
    <button class="btn btn-g" onclick="saveReg(false)">✓ Registrar</button>
  </div>
</div></div>

<!-- MODAL: Inserir Bônus/Manual -->
<div class="modal-bg" id="mManual"><div class="modal">
  <h3>🎁 Inserir Manualmente (Bônus)</h3><div id="msgManual" class="msg"></div>
  <div class="row">
    <div class="fg" style="flex:1"><label>Nome</label><input id="mnName" style="width:100%"></div>
  </div>
  <div class="row">
    <div class="fg" style="flex:1"><label>Produto *</label><select id="mnProd" style="width:100%"><option value="">Selecione...</option></select></div>
  </div>
  <div class="row">
    <div class="fg"><label>Conta MT5 *</label><input type="number" id="mnAcct" placeholder="Número da conta" style="width:150px"></div>
    <div class="fg"><label>Tipo de conta</label><select id="mnAcctType" style="width:110px"><option value="real">Real</option><option value="demo">Demo</option></select></div>
  </div>
  <div class="sep">
    <div style="font-size:10px;color:#58a6ff;font-weight:700;text-transform:uppercase;margin-bottom:8px">Data Final</div>
    <div class="row">
      <div class="fg"><label>Atalhos</label>
        <div style="display:flex;gap:4px">
          <button class="btn-sm" onclick="mnAdd(7)">+7d</button>
          <button class="btn-sm" onclick="mnAdd(15)">+15d</button>
          <button class="btn-sm" onclick="mnAdd(30)">+30d</button>
        </div>
      </div>
    </div>
    <div class="row"><div class="fg"><label>Data final</label><input type="date" id="mnDate" style="width:160px"></div></div>
  </div>
  <div class="mbtn">
    <button class="btn-sm" onclick="cm('mManual')">Cancelar</button>
    <button class="btn btn-g" onclick="saveManual()">✓ Inserir</button>
  </div>
</div></div>

<!-- MODAL: Gerar Chave Offline -->
<div class="modal-bg" id="mKey"><div class="modal">
  <h3>🔑 Gerar Chave de Acesso Offline</h3><div id="msgKey" class="msg"></div>
  <div class="row">
    <div class="fg" style="flex:1"><label>Produto *</label><select id="kProd" style="width:100%"><option value="">Selecione...</option></select></div>
  </div>
  <div class="row">
    <div class="fg"><label>Conta MT5 *</label><input type="number" id="kAcct" placeholder="Número" style="width:150px"></div>
    <div class="fg"><label>Tipo</label><select id="kType" style="width:110px"><option value="real">Real</option><option value="demo">Demo</option></select></div>
  </div>
  <div class="row">
    <div class="fg"><label>Atalhos</label>
      <div style="display:flex;gap:4px">
        <button class="btn-sm" onclick="kAdd(30)">+30d</button>
        <button class="btn-sm" onclick="kAdd(90)">+3m</button>
        <button class="btn-sm" onclick="kAdd(180)">+6m</button>
        <button class="btn-sm" onclick="kAdd(365)">+1a</button>
      </div>
    </div>
  </div>
  <div class="row"><div class="fg"><label>Data final</label><input type="date" id="kDate" style="width:160px"></div></div>
  <button class="btn btn-v" style="width:100%;margin-top:4px" onclick="kSetLifetime()">♾ Vitalícia</button>
  <div id="kResult" style="display:none">
    <div style="font-size:10px;color:#8b949e;margin-top:12px;margin-bottom:4px">CHAVE GERADA (copie e entregue ao cliente):</div>
    <div class="key-box" id="kKeyBox"></div>
    <button class="btn-sm" style="margin-top:6px;width:100%" onclick="copyKey()">📋 Copiar Chave</button>
  </div>
  <div class="mbtn">
    <button class="btn-sm" onclick="cm('mKey')">Fechar</button>
    <button class="btn btn-g" onclick="generateKey()">🔑 Gerar Chave</button>
  </div>
</div></div>

<!-- SEÇÃO: Inserir Manualmente + Botões de ação -->
<div class="card">
  <div class="card-title">🎁 Inserir Manualmente (Bônus / Trial)</div>
  <div class="row">
    <button class="btn btn-g" onclick="om('mManual')">+ Inserir Bônus/Trial</button>
    <button class="btn btn-v" onclick="om('mKey')">🔑 Gerar Chave Offline</button>
  </div>
</div>

<!-- SEÇÃO: Produtos -->
<div class="card">
  <div class="card-title">📦 Catálogo de Produtos</div>
  <table><thead><tr><th>ID</th><th>Nome</th><th>Tipo</th><th>Min Lote</th><th>Max Lote</th><th>Instâncias</th><th>Descrição</th></tr></thead>
  <tbody>${prodRows}</tbody></table>
  <div style="font-size:10px;color:#8b949e;margin-top:8px">Os produtos são fixos e gerenciados pelo servidor. Contate o desenvolvedor para adicionar novos produtos.</div>
</div>

<!-- SEÇÃO: Usuários -->
<div class="card">
  <div class="card-title">👥 Usuários Registrados (${stats.total})</div>
  <div style="margin-bottom:10px">
    <button class="btn btn-g" onclick="om('mReg')">+ Adicionar Usuário</button>
  </div>
  <div style="overflow-x:auto">
  <table><thead><tr><th>Conta</th><th>Nome / Contato</th><th>Plano</th><th>Expira</th><th>Último acesso</th><th>Senha</th><th>Produtos</th><th>Ações</th></tr></thead>
  <tbody>${rows}</tbody></table></div>
</div>

<script>
const AUTH='Basic '+btoa('${ADMIN_USER}:${ADMIN_PASS}');
const PRODUCTS=${prodsJs};
let _ba='',_ea='',_pa='';
let _kLifetime=false;
let acctRowCount=0;

function sm(id,msg,ok){const el=document.getElementById(id);if(!el)return;el.textContent=msg;el.className='msg '+(ok?'ok':'err');el.style.display='block';setTimeout(()=>el.style.display='none',5000);}
async function api(method,path,body){const r=await fetch(path,{method,headers:{'Content-Type':'application/json','Authorization':AUTH},body:body?JSON.stringify(body):undefined});return r.json();}
function cm(id){document.getElementById(id).classList.remove('open');}
function om(id){
  // Popular dropdowns de produtos ao abrir modal
  const selIds=['pProdSel','rProd','mnProd','kProd'];
  selIds.forEach(sid=>{const el=document.getElementById(sid);if(!el)return;
    el.innerHTML='<option value="">Selecione...</option>';
    PRODUCTS.forEach(p=>{el.innerHTML+='<option value="'+p.id+'">'+p.name+'</option>';});
  });
  // Inicializar bloco de contas do modal de registro
  if(id==='mReg'){document.getElementById('rAcctsWrap').innerHTML='';acctRowCount=0;addAcctRow();}
  document.getElementById(id).classList.add('open');
}
document.addEventListener('click',e=>{if(e.target.classList.contains('modal-bg'))e.target.classList.remove('open');});

// ── Licença/Bônus ─────────────────────────────────────────────────
function bonusModal(a,n){_ba=a;document.getElementById('bAcct').value=a;document.getElementById('bName').value=n||'';const d=new Date();d.setDate(d.getDate()+30);document.getElementById('bDate').value=d.toISOString().split('T')[0];om('mBonus');}
function bAdd(n){const cur=document.getElementById('bDate').value;const d=cur?new Date(cur):new Date();d.setDate(d.getDate()+n);document.getElementById('bDate').value=d.toISOString().split('T')[0];}
async function saveBonus(){const endDate=document.getElementById('bDate').value;if(!endDate){sm('msgBonus','Selecione uma data',false);return;}const r=await api('POST','/admin/license',{account:_ba,name:document.getElementById('bName').value,endDate});if(r.ok){sm('msgBonus','✅ Até '+r.expiresStr,true);setTimeout(()=>location.reload(),1200);}else sm('msgBonus','❌ '+(r.error||'Erro'),false);}
async function saveLicLifetime(){const r=await api('POST','/admin/license',{account:_ba,name:document.getElementById('bName').value,lifetime:true});if(r.ok){sm('msgBonus','✅ Licença Vitalícia aplicada!',true);setTimeout(()=>location.reload(),1200);}else sm('msgBonus','❌ '+(r.error||'Erro'),false);}

// ── Editar usuário ────────────────────────────────────────────────
function editUser(a,n,e,p){_ea=a;document.getElementById('eAcct').value=a;document.getElementById('eName').value=n||'';document.getElementById('eEmail').value=e||'';document.getElementById('ePhone').value=p||'';om('mEdit');}
async function saveEdit(){const r=await api('PUT','/admin/user',{account:_ea,name:document.getElementById('eName').value,email:document.getElementById('eEmail').value,phone:document.getElementById('ePhone').value});if(r.ok){sm('msgEdit','✅ Salvo!',true);setTimeout(()=>location.reload(),1000);}else sm('msgEdit','❌ Erro',false);}

// ── Atribuir produto ──────────────────────────────────────────────
function addUserProd(a){_pa=a;document.getElementById('pAcct').value=a;document.getElementById('pMinL').value='0';document.getElementById('pMaxL').value='0';document.getElementById('pInst').value='1';document.getElementById('pReal').value='';document.getElementById('pDemo').value='';document.getElementById('pAcctType').value='';om('mProd');}
async function saveProd(){const pid=document.getElementById('pProdSel').value;if(!pid){sm('msgProd','Selecione um produto',false);return;}const prod=PRODUCTS.find(p=>p.id===pid);const r=await api('POST','/admin/user-product',{account:_pa,productId:pid,name:prod?prod.name:pid,accountType:document.getElementById('pAcctType').value,minLots:document.getElementById('pMinL').value,maxLots:document.getElementById('pMaxL').value,instances:document.getElementById('pInst').value,accountReal:document.getElementById('pReal').value,accountDemo:document.getElementById('pDemo').value});if(r.ok){sm('msgProd','✅ Atribuído!',true);setTimeout(()=>location.reload(),1000);}else sm('msgProd','❌ '+(r.error||'Erro'),false);}

// ── Adicionar usuário ─────────────────────────────────────────────
function addAcctRow(){
  const wrap=document.getElementById('rAcctsWrap');const idx=acctRowCount++;
  const div=document.createElement('div');div.className='acct-block';div.id='acct_'+idx;
  div.innerHTML='<div class="row"><div class="fg"><label>Conta MT5 *</label><input type="number" id="rAcct_'+idx+'" placeholder="Número" style="width:140px"></div><div class="fg"><label>Tipo</label><select id="rType_'+idx+'" style="width:110px"><option value="real">Real</option><option value="demo">Demo</option></select></div>'+(idx>0?'<button class="btn-sm btn-red" style="align-self:flex-end" onclick="removeAcctRow('+idx+')">✕</button>':'')+' </div>';
  wrap.appendChild(div);
}
function removeAcctRow(idx){const el=document.getElementById('acct_'+idx);if(el)el.remove();}
function rAdd(n){const cur=document.getElementById('rDate').value;const d=cur?new Date(cur):new Date();d.setDate(d.getDate()+n);document.getElementById('rDate').value=d.toISOString().split('T')[0];}
async function saveReg(lifetime){
  const name=document.getElementById('rName').value;
  if(!name){sm('msgReg','⚠️ Nome obrigatório',false);return;}
  const prodId=document.getElementById('rProd').value;
  if(!prodId){sm('msgReg','⚠️ Selecione um produto',false);return;}
  const endDate=document.getElementById('rDate').value;
  if(!lifetime&&!endDate){sm('msgReg','⚠️ Selecione a data final ou escolha Vitalícia',false);return;}
  // Coletar contas
  const products=[];
  const prod=PRODUCTS.find(p=>p.id===prodId);
  for(let i=0;i<acctRowCount;i++){
    const el=document.getElementById('acct_'+i);if(!el)continue;
    const acctEl=document.getElementById('rAcct_'+i);const typeEl=document.getElementById('rType_'+i);
    if(!acctEl||!acctEl.value)continue;
    const account=acctEl.value;const accountType=typeEl?typeEl.value:'real';
    // Criar usuário para cada conta
    products.push({productId:prodId,accountType,accountReal:accountType==='real'?account:'',accountDemo:accountType==='demo'?account:'',minLots:0,maxLots:0,instances:1});
    // Primeira conta vira a conta principal
    if(i===0){
      const r=await api('POST','/admin/register',{account,name,email:document.getElementById('rEmail').value,phone:document.getElementById('rPhone').value,products,endDate:lifetime?undefined:endDate,lifetime:lifetime||undefined});
      if(!r.ok){sm('msgReg','❌ '+(r.error||'Erro ao registrar conta '+account),false);return;}
    } else {
      // Contas adicionais: registrar separado com mesmo produto
      const r2=await api('POST','/admin/register',{account,name,email:document.getElementById('rEmail').value,products:[{productId:prodId,accountType,accountReal:accountType==='real'?account:'',accountDemo:accountType==='demo'?account:'',minLots:0,maxLots:0,instances:1}],endDate:lifetime?undefined:endDate,lifetime:lifetime||undefined});
      if(!r2.ok){sm('msgReg','⚠️ Conta '+account+' não pôde ser registrada: '+(r2.error||'Erro'),false);}
    }
  }
  sm('msgReg','✅ Usuário registrado com sucesso!',true);setTimeout(()=>location.reload(),1400);
}
async function saveRegLifetime(){await saveReg(true);}

// ── Inserir manual ────────────────────────────────────────────────
function mnAdd(n){const cur=document.getElementById('mnDate').value;const d=cur?new Date(cur):new Date();d.setDate(d.getDate()+n);document.getElementById('mnDate').value=d.toISOString().split('T')[0];}
async function saveManual(){
  const acct=document.getElementById('mnAcct').value;const prod=document.getElementById('mnProd').value;
  const name=document.getElementById('mnName').value;const endDate=document.getElementById('mnDate').value;
  const accountType=document.getElementById('mnAcctType').value;
  if(!acct){sm('msgManual','⚠️ Conta MT5 obrigatória',false);return;}
  if(!prod){sm('msgManual','⚠️ Selecione um produto',false);return;}
  if(!endDate){sm('msgManual','⚠️ Selecione a data final',false);return;}
  const prodObj=PRODUCTS.find(p=>p.id===prod);
  const r=await api('POST','/admin/manual',{account:acct,name,endDate,type:'bonus'});
  if(!r.ok){sm('msgManual','❌ '+(r.error||'Erro'),false);return;}
  // Atribuir produto
  const r2=await api('POST','/admin/user-product',{account:acct,productId:prod,name:prodObj?prodObj.name:prod,accountType,accountReal:accountType==='real'?acct:'',accountDemo:accountType==='demo'?acct:'',minLots:0,maxLots:0,instances:1});
  if(r2.ok){sm('msgManual','✅ Inserido até '+r.expiresStr,true);setTimeout(()=>location.reload(),1200);}
  else sm('msgManual','❌ Licença criada mas erro ao atribuir produto: '+(r2.error||'Erro'),false);
}

// ── Gerar chave offline ───────────────────────────────────────────
function kAdd(n){_kLifetime=false;const cur=document.getElementById('kDate').value;const d=cur?new Date(cur):new Date();d.setDate(d.getDate()+n);document.getElementById('kDate').value=d.toISOString().split('T')[0];}
function kSetLifetime(){_kLifetime=true;document.getElementById('kDate').value='';document.getElementById('kDate').disabled=true;sm('msgKey','♾ Modo vitalício selecionado',true);}
async function generateKey(){
  const prodId=document.getElementById('kProd').value;const acct=document.getElementById('kAcct').value;
  const type=document.getElementById('kType').value;const date=document.getElementById('kDate').value;
  if(!prodId){sm('msgKey','⚠️ Selecione um produto',false);return;}
  if(!acct){sm('msgKey','⚠️ Informe a conta MT5',false);return;}
  if(!_kLifetime&&!date){sm('msgKey','⚠️ Selecione a data ou clique em Vitalícia',false);return;}
  const expiry=_kLifetime?'lifetime':date;
  const r=await api('POST','/admin/generate-key',{productId:prodId,account:acct,accountType:type,expiry});
  if(r.ok){document.getElementById('kKeyBox').textContent=r.key;document.getElementById('kResult').style.display='block';sm('msgKey','✅ Chave gerada com sucesso!',true);}
  else sm('msgKey','❌ '+(r.error||'Erro'),false);
}
function copyKey(){const txt=document.getElementById('kKeyBox').textContent;navigator.clipboard.writeText(txt).then(()=>alert('✅ Chave copiada!')).catch(()=>{});}

// ── Ações de usuário ──────────────────────────────────────────────
async function revogar(a){if(!confirm('Revogar licença de '+a+'?'))return;const r=await api('DELETE','/admin/license',{account:a});if(r.ok)location.reload();}
async function resetPw(a){if(!confirm('Resetar senha de '+a+'?'))return;const r=await api('POST','/admin/reset-password',{account:a});if(r.ok)alert('✅ Senha resetada!');}
async function delUser(a){if(!confirm('⚠️ Remover COMPLETAMENTE o usuário '+a+'?'))return;const r=await api('DELETE','/admin/user',{account:a});if(r.ok)location.reload();else alert('❌ Erro ao remover');}
</script></body></html>`;
}

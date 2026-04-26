// ─────────────────────────────────────────────────────────────────
//  Dashbot Proxy Server
//  Deploy gratuito em: https://render.com
//  Node.js 18+
// ─────────────────────────────────────────────────────────────────
const https = require('https');
const http  = require('http');
const url   = require('url');

// ── Configuração ──────────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const MASTER_KEY = process.env.JSONBIN_MASTER_KEY || '';
const DATA_BIN   = process.env.JSONBIN_DATA_BIN   || '';
const CMD_BIN    = process.env.JSONBIN_CMD_BIN    || '';
const AUTH_TOKEN = process.env.DASHBOT_TOKEN      || 'dashbot2024'; // token simples de segurança
// ─────────────────────────────────────────────────────────────────

function jsonbinRequest(method, binId, body, callback) {
  const options = {
    hostname: 'api.jsonbin.io',
    port: 443,
    path: `/v3/b/${binId}${method === 'GET' ? '/latest' : ''}`,
    method: method,
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': MASTER_KEY,
      'X-Bin-Meta': 'false',
    }
  };
  if (body) options.headers['Content-Length'] = Buffer.byteLength(body);

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => callback(null, res.statusCode, data));
  });
  req.on('error', err => callback(err, -1, ''));
  if (body) req.write(body);
  req.end();
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Dashbot-Token',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const parsed  = url.parse(req.url, true);
  const path    = parsed.pathname;
  const method  = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Dashbot-Token',
    });
    res.end(); return;
  }

  // Health check
  if (path === '/' || path === '/health') {
    sendJSON(res, 200, { status: 'ok', service: 'Dashbot Proxy', ts: Date.now() });
    return;
  }

  // Valida token (MT5 passa como query param ou header)
  const token = parsed.query.token || req.headers['x-dashbot-token'] || '';
  if (AUTH_TOKEN && token !== AUTH_TOKEN) {
    sendJSON(res, 401, { error: 'Token invalido' }); return;
  }

  // ── POST /update — MT5 envia dados ──────────────────────────────
  if (path === '/update' && method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (!DATA_BIN) { sendJSON(res, 500, { error: 'DATA_BIN nao configurado' }); return; }
      jsonbinRequest('PUT', DATA_BIN, body, (err, code, data) => {
        if (err || code !== 200)
          sendJSON(res, 502, { error: 'JSONBin erro', code, detail: err?.message });
        else
          sendJSON(res, 200, { ok: true, ts: Date.now() });
      });
    });
    return;
  }

  // ── GET /data — Web busca dados dos EAs ─────────────────────────
  if (path === '/data' && method === 'GET') {
    if (!DATA_BIN) { sendJSON(res, 500, { error: 'DATA_BIN nao configurado' }); return; }
    jsonbinRequest('GET', DATA_BIN, null, (err, code, data) => {
      if (err || code !== 200)
        sendJSON(res, 502, { error: 'JSONBin erro', code });
      else {
        try { sendJSON(res, 200, JSON.parse(data)); }
        catch(e) { sendJSON(res, 502, { error: 'JSON invalido' }); }
      }
    });
    return;
  }

  // ── POST /command — Web envia comando (Premium) ─────────────────
  if (path === '/command' && method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (!CMD_BIN) { sendJSON(res, 500, { error: 'CMD_BIN nao configurado' }); return; }
      // Valida que é um comando válido
      let parsed_body;
      try { parsed_body = JSON.parse(body); } catch(e) {
        sendJSON(res, 400, { error: 'JSON invalido' }); return;
      }
      const validCmds = ['ligar','desligar','pausar','retomar','fechar',''];
      if (!validCmds.includes(parsed_body.cmd || '')) {
        sendJSON(res, 400, { error: 'Comando invalido' }); return;
      }
      jsonbinRequest('PUT', CMD_BIN, body, (err, code, data) => {
        if (err || code !== 200)
          sendJSON(res, 502, { error: 'JSONBin erro', code });
        else
          sendJSON(res, 200, { ok: true, cmd: parsed_body.cmd });
      });
    });
    return;
  }

  // ── GET /command — MT5 lê comandos pendentes ────────────────────
  if (path === '/command' && method === 'GET') {
    if (!CMD_BIN) { sendJSON(res, 500, { error: 'CMD_BIN nao configurado' }); return; }
    jsonbinRequest('GET', CMD_BIN, null, (err, code, data) => {
      if (err || code !== 200)
        sendJSON(res, 502, { error: 'JSONBin erro', code });
      else {
        try { sendJSON(res, 200, JSON.parse(data)); }
        catch(e) { sendJSON(res, 502, { error: 'JSON invalido' }); }
      }
    });
    return;
  }

  sendJSON(res, 404, { error: 'Rota nao encontrada' });
});

server.listen(PORT, () => {
  console.log(`Dashbot Proxy rodando na porta ${PORT}`);
  console.log(`DATA_BIN:  ${DATA_BIN  || '(nao configurado)'}`);
  console.log(`CMD_BIN:   ${CMD_BIN   || '(nao configurado)'}`);
  console.log(`AUTH_TOKEN: ${AUTH_TOKEN}`);
});

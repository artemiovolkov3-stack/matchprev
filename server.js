const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { Client } = require('pg');

const PORT = process.env.PORT || 8080;
const ST_HOST = 'backend.smart-tables.ru';
const ST_KEY = '6913aad8e54c3d1e4e4174f906c8eec2';
const ANT_KEY = process.env.ANTHROPIC_API_KEY || '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';

const LOGIN = process.env.LOGIN || 'admin';
const PASSWORD = process.env.PASSWORD || 'matchprev2024';

// PostgreSQL client
const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
db.connect().then(async () => {
  console.log('[DB] connected');
  await db.query(`CREATE TABLE IF NOT EXISTS storage (id INT PRIMARY KEY DEFAULT 1, data JSONB NOT NULL DEFAULT '{}'::jsonb)`);
  await db.query(`INSERT INTO storage (id, data) VALUES (1, '{}'::jsonb) ON CONFLICT DO NOTHING`);
  console.log('[DB] table ready');
}).catch(e => console.error('[DB] connect error:', e.message));

function stGet(endpointWithQuery) {
  return new Promise((resolve, reject) => {
    const fullPath = '/api/external/v1' + endpointWithQuery;
    console.log('[ST] GET ' + fullPath.slice(0, 120));
    const req = https.request({
      hostname: ST_HOST, path: fullPath, method: 'GET',
      timeout: 15000,
      headers: { 'x-bds-api-key': ST_KEY, 'Accept': 'application/json' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve({ error: 'parse', status: res.statusCode, raw: d.slice(0,200) }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('SmartTables timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function claudePost(body) {
  return new Promise((resolve, reject) => {
    const s = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      timeout: 180000,
      headers: {
        'x-api-key': ANT_KEY, 'anthropic-version': '2023-06-01',
        'content-type': 'application/json', 'content-length': Buffer.byteLength(s)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('Claude parse error')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Claude timeout')); });
    req.on('error', reject);
    req.write(s);
    req.end();
  });
}

function checkAuth(req) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Basic ')) return false;
  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  const [u, p] = decoded.split(':');
  return u === LOGIN && p === PASSWORD;
}

http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const sendJSON = (code, data) => {
    const body = JSON.stringify(data);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };

  const requireAuth = () => {
    if (!checkAuth(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="MatchPrev"', 'Content-Type': 'text/plain' });
      res.end('Требуется авторизация');
      return false;
    }
    return true;
  };

  if (p === '/' || p === '/index.html') {
    if (!requireAuth()) return;
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) { res.writeHead(404); res.end('index.html not found'); }
    return;
  }

  if (p.startsWith('/st/')) {
    if (!requireAuth()) return;
    const endpoint = p.replace('/st', '');
    const q = Object.assign({ sport_id: '1' }, parsed.query);
    const qs = Object.keys(q).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(q[k])).join('&');
    stGet(endpoint + '?' + qs)
      .then(d => sendJSON(200, d))
      .catch(e => sendJSON(500, { error: e.message }));
    return;
  }

  if (p === '/storage' && req.method === 'GET') {
    if (!requireAuth()) return;
    db.query('SELECT data FROM storage WHERE id=1')
      .then(r => sendJSON(200, r.rows[0]?.data || {}))
      .catch(e => sendJSON(500, { error: e.message }));
    return;
  }

  if (p === '/storage' && req.method === 'POST') {
    if (!requireAuth()) return;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        db.query('UPDATE storage SET data=$1 WHERE id=1', [data])
          .then(() => sendJSON(200, { ok: true }))
          .catch(e => sendJSON(500, { error: e.message }));
      } catch(e) { sendJSON(400, { error: 'bad json' }); }
    });
    return;
  }

  if (p === '/claude' && req.method === 'POST') {
    if (!requireAuth()) return;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        claudePost(JSON.parse(body))
          .then(d => sendJSON(200, d))
          .catch(e => sendJSON(500, { error: e.message }));
      } catch(e) { sendJSON(400, { error: 'bad json' }); }
    });
    return;
  }

  res.writeHead(404); res.end('not found');

}).listen(PORT, () => {
  console.log('\n  MatchPrev запущен на порту ' + PORT + '\n');
});

/* Worker do app Cifras — sincronização entre aparelhos + proxy CORS do CifraClub.
 *
 * Rotas:
 *   GET  /sync?since=<rev>  — devolve { rev, data } (204 se o cliente já tem a revisão)
 *   PUT  /sync              — corpo { baseRev, data }; grava se baseRev bater, senão 409 com o estado atual
 *   GET  /proxy?url=<url>   — proxy para páginas do cifraclub.com.br (mesmo do guia dos Ajustes)
 *
 * Identidade sem conta: a chave de sincronização vai em "Authorization: Bearer <chave>";
 * a entrada no KV é indexada por sha256(chave), então a chave nunca é armazenada.
 */

const KEY_MIN_LEN = 16;
const MAX_DOC_BYTES = 20 * 1024 * 1024; // margem sob o limite de 25 MB do KV

function corsHeaders(origin) {
  // Pages do app, desenvolvimento local e file:// (leitores de HTML mandam Origin: null)
  const okOrigin = /^https:\/\/gustavo-omiq\.github\.io$/.test(origin)
    || /^http:\/\/localhost(:\d+)?$/.test(origin)
    || origin === 'null';
  return {
    'Access-Control-Allow-Origin': okOrigin ? origin : 'https://gustavo-omiq.github.io',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const json = (obj, status, cors) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', ...cors },
});

async function kvKeyFor(req) {
  const auth = req.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.{16,128})$/.exec(auth);
  if (!m || m[1].trim().length < KEY_MIN_LEN) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m[1].trim()));
  return 'lib:' + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function handleSync(req, env, url, cors) {
  const kvKey = await kvKeyFor(req);
  if (!kvKey) return json({ error: 'chave de sincronização ausente ou curta demais' }, 401, cors);

  if (req.method === 'GET') {
    const cur = await env.SYNC_KV.get(kvKey, 'json');
    const since = parseInt(url.searchParams.get('since') || '-1', 10);
    if (!cur) return json({ rev: 0, data: null }, 200, cors);
    if (cur.rev === since) return new Response(null, { status: 204, headers: cors });
    return json(cur, 200, cors);
  }

  if (req.method === 'PUT') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400, cors); }
    if (typeof body.baseRev !== 'number' || body.data == null)
      return json({ error: 'esperado { baseRev, data }' }, 400, cors);
    const cur = await env.SYNC_KV.get(kvKey, 'json');
    const curRev = cur ? cur.rev : 0;
    if (body.baseRev !== curRev)
      return json(cur || { rev: 0, data: null }, 409, cors);
    const doc = { rev: curRev + 1, updatedAt: Date.now(), data: body.data };
    const raw = JSON.stringify(doc);
    if (raw.length > MAX_DOC_BYTES)
      return json({ error: 'biblioteca grande demais para sincronizar' }, 413, cors);
    await env.SYNC_KV.put(kvKey, raw);
    return json({ rev: doc.rev }, 200, cors);
  }

  return json({ error: 'método não suportado' }, 405, cors);
}

async function handleProxy(req, url, cors) {
  const target = url.searchParams.get('url');
  if (!target || !/^https:\/\/(www\.)?cifraclub\.com\.br\//.test(target))
    return new Response('URL inválida', { status: 400, headers: cors });
  const r = await fetch(target, {
    headers: { 'User-Agent': req.headers.get('User-Agent') || 'Mozilla/5.0' },
  });
  const h = new Headers(cors);
  h.set('Content-Type', r.headers.get('Content-Type') || 'text/html');
  h.set('Access-Control-Allow-Origin', '*'); // proxy é público-somente-leitura
  return new Response(r.body, { status: r.status, headers: h });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req.headers.get('Origin') || '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/sync') return handleSync(req, env, url, cors);
    if (url.pathname === '/proxy') return handleProxy(req, url, cors);
    return json({ app: 'cifras-sync', rotas: ['/sync', '/proxy'] }, 200, cors);
  },
};

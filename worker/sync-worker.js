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
const MAX_DOC_BYTES = 24 * 1024 * 1024; // pertinho do teto de 25 MB do KV (valor por chave) — aplicado DEPOIS da compressão

/* Compressão é só um detalhe de armazenamento do Worker — o cliente sempre manda/recebe
 * JSON puro, sem mudança de protocolo. Grava comprimido no KV, descomprime na leitura.
 * Detecta pelo cabeçalho gzip (1f 8b) pra continuar lendo entradas antigas (gravadas sem
 * compressão, antes desta mudança) sem quebrar nada que já está sincronizado. */
const GZIP_MAGIC_0 = 0x1f, GZIP_MAGIC_1 = 0x8b;
async function gzip(text) {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(new TextEncoder().encode(text));
  writer.close();
  return new Response(cs.readable).arrayBuffer();
}
async function gunzip(bytes) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const buf = await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(buf);
}
function looksGzipped(bytes) {
  const u8 = new Uint8Array(bytes);
  return u8.length >= 2 && u8[0] === GZIP_MAGIC_0 && u8[1] === GZIP_MAGIC_1;
}
async function readDoc(kvKey, env) {
  const raw = await env.SYNC_KV.get(kvKey, 'arrayBuffer');
  if (!raw) return null;
  const text = looksGzipped(raw) ? await gunzip(raw) : new TextDecoder().decode(raw);
  return JSON.parse(text);
}

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
    const cur = await readDoc(kvKey, env);
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
    const cur = await readDoc(kvKey, env);
    const curRev = cur ? cur.rev : 0;
    if (body.baseRev !== curRev)
      return json(cur || { rev: 0, data: null }, 409, cors);
    const doc = { rev: curRev + 1, updatedAt: Date.now(), data: body.data };
    const compressed = await gzip(JSON.stringify(doc));
    if (compressed.byteLength > MAX_DOC_BYTES)
      return json({ error: 'biblioteca grande demais para sincronizar (mesmo comprimida)' }, 413, cors);
    await env.SYNC_KV.put(kvKey, compressed);
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

/* Worker do app Cifras — sincronização entre aparelhos + proxy CORS do CifraClub.
 *
 * Rotas:
 *   GET  /sync?since=<rev>  — devolve os dados (204 se o cliente já tem a revisão)
 *   PUT  /sync              — cabeçalho X-Base-Rev + corpo com os dados; grava se a revisão
 *                             bater, senão 409 com o estado atual
 *   GET  /proxy?url=<url>   — proxy para páginas do cifraclub.com.br
 *
 * Identidade sem conta: a chave de sincronização vai em "Authorization: Bearer <chave>";
 * a entrada no KV é indexada por sha256(chave), então a chave nunca é armazenada.
 *
 * O Worker NUNCA interpreta o JSON da biblioteca: ele passa o corpo direto por um
 * gzip em streaming e grava em pedaços no KV. Isso é essencial — dar JSON.parse numa
 * biblioteca de dezenas de MB estourava o limite de memória do Worker (erro 1102 da
 * Cloudflare), e como essa resposta de erro não tem cabeçalho CORS, o navegador só
 * mostrava "failed to fetch". Em pedaços também deixa de valer o teto de 25 MB por
 * valor do KV.
 *
 * Formato no KV (v2):
 *   <chave>            valor vazio + metadata { v:2, rev, updatedAt, chunks, gen }
 *   <chave>:<gen>:<i>  pedaços do blob gzip (concatenados = o gzip original)
 * A geração (gen) muda a cada gravação, então o manifesto só passa a apontar para os
 * pedaços novos quando todos já estão no lugar; os antigos são apagados depois.
 */

const KEY_MIN_LEN = 16;
const CHUNK_BYTES = 10 * 1024 * 1024; // por pedaço, sob o limite de 25 MB por valor do KV
const MAX_CHUNKS = 40;                // teto de segurança (~400 MB comprimidos)

function corsHeaders(origin) {
  // Pages do app, desenvolvimento local e file:// (leitores de HTML mandam Origin: null)
  const okOrigin = /^https:\/\/gustavo-omiq\.github\.io$/.test(origin)
    || /^http:\/\/localhost(:\d+)?$/.test(origin)
    || origin === 'null';
  return {
    'Access-Control-Allow-Origin': okOrigin ? origin : 'https://gustavo-omiq.github.io',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Base-Rev',
    'Access-Control-Expose-Headers': 'X-Sync-Rev', // sem isso o navegador não deixa ler a revisão
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

const looksGzipped = buf => {
  const u8 = new Uint8Array(buf);
  return u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;
};
/* revisão de uma entrada no formato antigo ({rev,updatedAt,data} num valor só):
 * lê só o começo do JSON, sem inflar/parsear o documento inteiro */
async function legacyRev(buf) {
  let head = '';
  try {
    if (looksGzipped(buf)) {
      const ds = new DecompressionStream('gzip');
      const w = ds.writable.getWriter();
      w.write(buf).catch(() => {});
      w.close().catch(() => {});
      const rd = ds.readable.getReader();
      const { value } = await rd.read();
      rd.cancel().catch(() => {});
      head = new TextDecoder().decode((value || new Uint8Array()).subarray(0, 200));
    } else {
      head = new TextDecoder().decode(buf.slice(0, 200));
    }
  } catch { return 0; }
  const m = /"rev"\s*:\s*(\d+)/.exec(head);
  return m ? +m[1] : 0;
}
async function readMeta(kvKey, env) {
  const { value, metadata } = await env.SYNC_KV.getWithMetadata(kvKey, 'arrayBuffer');
  if (metadata && metadata.v === 2)
    return { v: 2, rev: metadata.rev || 0, gen: metadata.gen, chunks: metadata.chunks || 0 };
  if (!value || value.byteLength === 0) return null;
  return { v: 1, rev: await legacyRev(value), bytes: value, gz: looksGzipped(value) };
}

/* grava o stream comprimido em pedaços de CHUNK_BYTES; devolve quantos pedaços saíram */
async function writeChunks(kvKey, gen, stream, env) {
  const reader = stream.getReader();
  const buf = new Uint8Array(CHUNK_BYTES);
  let used = 0, idx = 0;
  const flush = async () => {
    await env.SYNC_KV.put(`${kvKey}:${gen}:${idx}`, buf.slice(0, used).buffer);
    idx++; used = 0;
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    let off = 0;
    while (off < value.byteLength) {
      const n = Math.min(CHUNK_BYTES - used, value.byteLength - off);
      buf.set(value.subarray(off, off + n), used);
      used += n; off += n;
      if (used === CHUNK_BYTES) {
        if (idx + 1 >= MAX_CHUNKS) { reader.cancel().catch(() => {}); throw new Error('TOO_BIG'); }
        await flush();
      }
    }
  }
  if (used > 0 || idx === 0) await flush();
  return idx;
}
async function deleteGen(kvKey, gen, chunks, env) {
  for (let i = 0; i < chunks; i++) {
    try { await env.SYNC_KV.delete(`${kvKey}:${gen}:${i}`); } catch {}
  }
}
/* devolve os pedaços em ordem, sem juntar tudo na memória */
function chunkStream(kvKey, gen, chunks, env) {
  let i = 0;
  return new ReadableStream({
    async pull(ctrl) {
      if (i >= chunks) { ctrl.close(); return; }
      const b = await env.SYNC_KV.get(`${kvKey}:${gen}:${i}`, 'arrayBuffer');
      i++;
      if (!b) { ctrl.error(new Error('pedaço ' + (i - 1) + ' não encontrado')); return; }
      ctrl.enqueue(new Uint8Array(b));
    },
  });
}
/* corpo com o estado atual — usado no GET e no 409.
 * v2: só os dados, com a revisão em X-Sync-Rev.
 * legado: o documento antigo inteiro ({rev,updatedAt,data}), como sempre foi.
 *
 * Descomprime aqui, em streaming (a memória continua baixa). Não dá para devolver o
 * gzip cru com Content-Encoding: gzip — testado em navegador, o cabeçalho não chega e
 * o fetch recebe os bytes comprimidos como se fossem o conteúdo. A compressão no
 * transporte fica por conta da Cloudflare, como em qualquer resposta. */
function stateResponse(meta, status, cors, kvKey, env) {
  if (!meta) return json({ rev: 0, data: null }, status, cors);
  const h = new Headers(cors);
  h.set('Content-Type', 'application/json');
  if (meta.v === 2) {
    h.set('X-Sync-Rev', String(meta.rev));
    const body = chunkStream(kvKey, meta.gen, meta.chunks, env)
      .pipeThrough(new DecompressionStream('gzip'));
    return new Response(body, { status, headers: h });
  }
  const body = meta.gz
    ? new Response(meta.bytes).body.pipeThrough(new DecompressionStream('gzip'))
    : meta.bytes;
  return new Response(body, { status, headers: h });
}

async function handleSync(req, env, url, cors) {
  const kvKey = await kvKeyFor(req);
  if (!kvKey) return json({ error: 'chave de sincronização ausente ou curta demais' }, 401, cors);

  if (req.method === 'GET') {
    const meta = await readMeta(kvKey, env);
    const since = parseInt(url.searchParams.get('since') || '-1', 10);
    if (!meta) return json({ rev: 0, data: null }, 200, cors);
    if (meta.rev === since) return new Response(null, { status: 204, headers: cors });
    return stateResponse(meta, 200, cors, kvKey, env);
  }

  if (req.method === 'PUT') {
    const hdr = req.headers.get('X-Base-Rev');
    if (hdr === null)
      return json({ error: 'versão antiga do app — atualize (feche e reabra duas vezes)' }, 400, cors);
    const baseRev = parseInt(hdr, 10);
    if (!Number.isFinite(baseRev)) return json({ error: 'X-Base-Rev inválido' }, 400, cors);
    if (!req.body) return json({ error: 'corpo vazio' }, 400, cors);

    const meta = await readMeta(kvKey, env);
    const curRev = meta ? meta.rev : 0;
    if (baseRev !== curRev) return stateResponse(meta, 409, cors, kvKey, env);

    const rev = curRev + 1;
    let chunks;
    try {
      chunks = await writeChunks(kvKey, rev, req.body.pipeThrough(new CompressionStream('gzip')), env);
    } catch (e) {
      if (e.message === 'TOO_BIG')
        return json({ error: 'biblioteca grande demais para sincronizar (mesmo comprimida)' }, 413, cors);
      return json({ error: 'falha ao gravar: ' + e.message }, 500, cors);
    }
    await env.SYNC_KV.put(kvKey, '', { metadata: { v: 2, rev, updatedAt: Date.now(), chunks, gen: rev } });
    if (meta && meta.v === 2) await deleteGen(kvKey, meta.gen, meta.chunks, env);
    return json({ rev }, 200, cors);
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

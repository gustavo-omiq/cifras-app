/* Service worker do app Cifras — deixa o app abrir 100% offline quando hospedado.
 * Estratégia: cache-first com atualização em segundo plano (stale-while-revalidate). */
const CACHE = 'cifras-app-v37';
const ASSETS = ['./', './index.html', './sw.js', './manifest.json', './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  // cache: 'reload' pula o cache HTTP do navegador — o Pages serve com max-age=600, e sem isso
  // um SW novo podia instalar o index.html velho e o app "atualizava" pra versão antiga
  const fresh = ASSETS.map(a => new Request(a, { cache: 'reload' }));
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Só intercepta os próprios arquivos do app; buscas/downloads de cifras vão direto à rede.
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  const MATCH = { ignoreSearch: true, ignoreVary: true }; // iOS: não falhar por ?query ou Vary
  e.respondWith(
    caches.match(e.request, MATCH).then(cached => {
      // no-cache: revalida no servidor em vez de aceitar a cópia do cache HTTP (max-age=600)
      const fresh = fetch(e.request, { cache: 'no-cache' })
        .then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        })
        // offline sem cache exato: navegação cai no index (app de página única)
        .catch(() => cached || (e.request.mode === 'navigate'
          ? caches.match('./index.html', MATCH)
          : Promise.reject(new Error('offline'))));
      return cached || fresh;
    })
  );
});

// Offline cache. Bump CACHE whenever any file below changes.
const CACHE='tanaoroshi-v1';
const ASSETS=['./','./index.html','./style.css','./app.js','./xlsx.js','./qr.js','./manifest.json','./icon.svg','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS.map(a=>new Request(a,{cache:'reload'})))).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('tanaoroshi-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('message',e=>{if(e.data==='skip-waiting')self.skipWaiting();});
// Network first (so updates appear immediately when online), cache when offline.
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET'||new URL(e.request.url).origin!==self.location.origin)return;
  e.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    try{const res=await fetch(e.request);if(res.ok&&ASSETS.some(a=>new URL(a,self.registration.scope).href===e.request.url.split('#')[0].split('?')[0]))cache.put(e.request,res.clone());return res;}
    catch{const hit=await cache.match(e.request,{ignoreSearch:true})||(e.request.mode==='navigate'?await cache.match('./index.html'):null);if(hit)return hit;throw new Error('offline');}
  })());
});

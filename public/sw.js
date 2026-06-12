/* Infinity Radio — Service Worker desativado.
   A versão atual usa faixas completas em Blob e não interceta áudio. */
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

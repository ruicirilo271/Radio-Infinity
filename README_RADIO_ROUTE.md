# Correção da rota /radio

Nesta versão:

- `/` abre a página visual da Infinity Radio.
- `/radio` devolve a playlist M3U do programa atual.
- `/radio.m3u` devolve exatamente a mesma playlist.
- `/api/health` mostra a versão `vercel-radio-route-2026.06.12.4`.

## Importante

No Vercel, `/radio` não pode ser uma ligação MP3 infinita como no localhost.
Ao abrir a rota no Chrome, o browser pode mostrar o texto da playlist ou
descarregar um ficheiro `.m3u`.

Para testar a playlist:

1. Abre `/radio`.
2. Guarda o ficheiro se o browser o descarregar.
3. Abre-o no VLC.

A página principal continua em `/`.

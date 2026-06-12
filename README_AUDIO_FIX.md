# Infinity Radio — correção de áudio no Vercel

## O que estava errado

A rota antiga `/stream/<id>` limitava cada resposta a cerca de 3,75 MB.
Quando o navegador não enviava `Range`, recebia apenas o primeiro bloco, mas
via nos cabeçalhos o tamanho completo do MP3. Alguns leitores interpretavam
isso como fim prematuro/corrupção do ficheiro e não reproduziam som.

## Como funciona agora

1. `/api/player/playlist` devolve, para cada faixa, um URL `chunk` assinado.
2. O navegador cria uma `MediaSource` para a faixa atual.
3. Pede blocos sucessivos a `/api/audio/chunk/<file_id>?offset=...`.
4. Cada resposta tem no máximo 3,75 MB e declara exatamente o tamanho enviado.
5. Os blocos são acrescentados ao mesmo `SourceBuffer`, formando um MP3 único.
6. O carregamento é limitado a aproximadamente dois minutos à frente para não
   ocupar memória excessiva em programas longos.

## Rotas de diagnóstico

- `/api/health` — configuração, credenciais e uso de `/tmp`.
- `/api/health/audio` — teste real: lista a pasta atual e descarrega 64 KB do
  primeiro MP3.
- `/api/player/playlist` — deve devolver `tracks` com os campos `chunk`,
  `stream`, `cover`, `size`, `artist` e `title`.

## Teste após publicar

1. Faz Redeploy sem reutilizar a cache de build.
2. Abre `/api/health` e confirma a versão:

   `vercel-mse-2026.06.12.1`

3. Abre `/api/health/audio` e confirma:

   - `ok: true`
   - `tracks_found` maior que zero
   - `sample_bytes: 65536` (ou menos se o ficheiro for muito pequeno)

4. Abre a página principal com `Ctrl + Shift + R`.
5. Clica em **LIGAR RÁDIO**.

## Sobre `/radio`

No Vercel, `/radio` e `/radio.m3u` são playlists externas por blocos. O player
web é o modo recomendado. Uma Vercel Function não consegue manter o mesmo
socket MP3 infinito usado no localhost.

## Variáveis obrigatórias

- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `STREAM_SIGNING_KEY`

Não incluas `service_account.json` no GitHub.

# Infinity Radio — versão Vercel estável por pré-carregamento

Esta versão não usa MediaSource nem Service Worker para montar áudio enquanto toca.

## Como funciona

1. O browser pede a playlist ao Flask.
2. A faixa atual é descarregada integralmente através de respostas de até 3,75 MB.
3. O browser cria um Blob local e só depois inicia a reprodução.
4. Durante a reprodução, a faixa seguinte é descarregada em segundo plano.
5. Na mudança de faixa, o player usa o Blob já pronto, evitando cortes na passagem entre blocos.

## Limitação importante

No Vercel não existe um socket MP3 infinito equivalente ao `/radio` do localhost.
A rota `/radio` abre o player web. A rota `/radio.m3u` é apenas experimental.

## Publicação

Substitui todos os ficheiros do repositório pelos desta pasta e faz um novo deployment.
Mantém as variáveis:

- `GOOGLE_SERVICE_ACCOUNT_JSON`
- `STREAM_SIGNING_KEY`

Depois confirma em `/api/health`:

- `version`: `vercel-prefetch-2026.06.12.3`
- `web_player_mode`: `HTMLAudio nativo + faixa completa em Blob + próxima faixa pré-carregada`

Na primeira música poderá existir uma espera enquanto aparece a percentagem de preparação.
Depois disso, a faixa seguinte é preparada durante a reprodução da atual.

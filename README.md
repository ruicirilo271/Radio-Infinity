# Infinity Radio — Vercel com reprodução estável

Versão: `vercel-sw-range-2026.06.12.2`

## O que mudou

A versão anterior usava `MediaSource` para acrescentar os blocos MP3. Em alguns
browsers, a música parava na passagem entre blocos.

Esta versão usa:

1. `<audio>` nativo do navegador;
2. um Service Worker em `/sw.js`;
3. pedidos HTTP Range virtuais;
4. blocos reais de até 3,75 MB servidos pelo Vercel;
5. cache LRU em `/tmp/infinity-radio`.

O Service Worker apresenta ao `<audio>` um único ficheiro MP3 contínuo e, por
baixo, descarrega os blocos pequenos. O título, capa e próxima música continuam
sincronizados faixa a faixa.

## Estrutura

```text
app.py
infinity_app.py
requirements.txt
vercel.json
.python-version
templates/
    index.html
public/
    script.js
    sw.js
    style.css
    infinity-cover.svg
```

Não deixes uma pasta `api/` antiga no repositório.

## Variáveis no Vercel

Obrigatórias:

```text
GOOGLE_SERVICE_ACCOUNT_JSON
STREAM_SIGNING_KEY
```

`GOOGLE_SERVICE_ACCOUNT_JSON` deve conter o JSON completo da conta de serviço
numa única linha. `STREAM_SIGNING_KEY` deve ser um segredo aleatório longo.

## Publicar

1. Substitui todos os ficheiros do repositório pelos desta pasta.
2. Confirma que `app.py` está na raiz escolhida pelo Vercel.
3. Faz `Redeploy` sem reutilizar a Build Cache.
4. Abre a aplicação.
5. Elimina o Service Worker antigo conforme indicado abaixo.
6. Atualiza com `Ctrl + Shift + R`.
7. Clica em **LIGAR RÁDIO**.

## Limpar o Service Worker antigo

No Chrome ou Edge:

1. Prime `F12`.
2. Abre **Application**.
3. Entra em **Service Workers**.
4. Clica em **Unregister** nos workers da Infinity Radio.
5. Em **Storage**, clica em **Clear site data**.
6. Fecha as ferramentas e atualiza com `Ctrl + Shift + R`.

Também podes testar numa janela anónima depois do novo deployment.

## Diagnósticos

```text
/api/health
/api/health/audio
/sw.js
```

O `/api/health` novo deve mostrar:

```json
{
  "version": "vercel-sw-range-2026.06.12.2",
  "web_player_mode": "HTMLAudio nativo + Service Worker Range + blocos /tmp"
}
```

## Sobre `/radio`

No Vercel, `/radio` e `/radio.m3u` são playlists M3U. Não são um socket MP3
infinito como a rota `/radio` da versão localhost. Uma Vercel Function não pode
manter uma emissão HTTP aberta indefinidamente e cada resposta tem limite de
tamanho.

O modo recomendado no Vercel é o player da página principal. Para um URL MP3
24/7 real, é necessário Icecast/Liquidsoap num servidor persistente.

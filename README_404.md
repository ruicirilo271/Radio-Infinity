# Correção do erro 404 em `/radio`

Esta versão usa a integração Flask atual do Vercel sem rewrites manuais.

## Estrutura obrigatória na raiz do repositório

```text
app.py
infinity_app.py
requirements.txt
vercel.json
.python-version
templates/
public/
```

Não coloques estes ficheiros dentro de outra subpasta sem configurar essa pasta como **Root Directory** no Vercel.

## Publicação

1. Substitui todos os ficheiros do repositório pelos desta versão.
2. Confirma que `app.py` e `vercel.json` aparecem na raiz do GitHub.
3. No Vercel, abre **Settings → Build and Deployment**.
4. Em **Root Directory**, deixa vazio se os ficheiros estiverem na raiz. Se estiverem dentro de uma pasta, seleciona exatamente essa pasta.
5. Mantém as variáveis `GOOGLE_SERVICE_ACCOUNT_JSON` e `STREAM_SIGNING_KEY`.
6. Faz um novo deploy sem usar o cache anterior.

## Testes após o deploy

```text
https://TEU-PROJETO.vercel.app/api/health
https://TEU-PROJETO.vercel.app/radio
https://TEU-PROJETO.vercel.app/radio.m3u
```

No Vercel, `/radio` devolve uma playlist M3U. O player da página continua a tocar faixa a faixa através de `/stream/<id>`.

# ATUALIZAÇÃO IMPORTANTE — ÁUDIO CORRIGIDO

Esta pasta usa MediaSource no navegador para juntar blocos inferiores ao limite do Vercel. Consulta `README_AUDIO_FIX.md`.

# Infinity Radio — versão preparada para Vercel

Esta pasta é independente da versão localhost. Não substituas a versão local que já está estável.

## O que foi adaptado

- Flask executa através de `api/index.py` como uma Vercel Function.
- Os ficheiros visuais estão em `public/`, para serem servidos pela CDN do Vercel.
- O `service_account.json` não é publicado.
- As credenciais Google são lidas de `GOOGLE_SERVICE_ACCOUNT_JSON`.
- As músicas são servidas através de pedidos HTTP `Range`.
- Cada resposta tem no máximo aproximadamente 3,75 MB, abaixo do limite de 4,5 MB das Functions.
- Cada bloco de áudio é guardado temporariamente em `/tmp/infinity-radio/audio`.
- O cache de áudio usa LRU e fica limitado a 430 MB, deixando margem dentro dos 500 MB de `/tmp`.
- O modo manual e o histórico são guardados no `localStorage` do navegador.
- As URLs de áudio e capas são assinadas e expiram.

## Limitação importante

O Vercel não consegue manter uma ligação MP3 infinita. A função tem duração máxima e armazenamento temporário.

Por isso:

- o player do site funciona faixa a faixa e pode tocar continuamente;
- `/radio` e `/radio.m3u` devolvem uma playlist M3U para VLC e leitores compatíveis;
- `/radio` não é um único socket MP3 24/7 como a versão localhost.

## Estrutura

```text
Infinity_Radio_Vercel/
├── api/
│   └── index.py
├── public/
│   ├── style.css
│   ├── script.js
│   └── infinity-cover.svg
├── templates/
│   └── index.html
├── app.py                 # arranque local
├── infinity_app.py        # aplicação Flask usada pelo Vercel
├── requirements.txt
├── vercel.json
├── .python-version
├── .gitignore
├── .vercelignore
└── .env.example
```

## 1. Revogar a chave antiga

A chave privada anteriormente partilhada ficou exposta. Antes de publicar:

1. Abre o Google Cloud Console.
2. Entra em **IAM e administração → Contas de serviço**.
3. Abre a conta utilizada pela Infinity Radio.
4. Elimina a chave antiga.
5. Cria uma nova chave JSON.
6. Confirma que as pastas do Google Drive continuam partilhadas com o email da conta de serviço.

Nunca coloques `service_account.json` no GitHub.

## 2. Transformar o JSON numa única linha

Na pasta onde tens a nova chave:

```powershell
python -c "import json; print(json.dumps(json.load(open('service_account.json', encoding='utf-8'))))"
```

Copia todo o resultado.

## 3. Criar o projeto no GitHub

Envia todos os ficheiros desta pasta, exceto:

```text
service_account.json
.env
.venv
__pycache__
```

## 4. Importar no Vercel

1. Entra no Vercel.
2. Seleciona **Add New → Project**.
3. Importa o repositório da Infinity Radio.
4. Não definas Build Command, Output Directory ou Install Command personalizados.
5. Mantém Fluid Compute ativado.

## 5. Variáveis de ambiente

Em **Project → Settings → Environment Variables**, adiciona:

### Obrigatória

```text
GOOGLE_SERVICE_ACCOUNT_JSON
```

Valor: o JSON completo numa única linha.

### Recomendada

```text
STREAM_SIGNING_KEY
```

Gera um segredo no PowerShell:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Adiciona as variáveis a Production, Preview e Development, conforme necessário.

## 6. Publicar

No Vercel, carrega em **Deploy**. Depois testa:

```text
https://TEU-PROJETO.vercel.app/
https://TEU-PROJETO.vercel.app/api/health
https://TEU-PROJETO.vercel.app/radio
```

Em `/api/health` deves ver:

```json
{
  "ok": true,
  "credentials_ready": true,
  "tmp": {
    "audio_limit_mb": 430,
    "range_response_mb": 3.75,
    "ephemeral": true
  }
}
```

## Como funciona o `/tmp`

O cache é apenas uma otimização:

- cada instância do Vercel tem o seu próprio `/tmp`;
- o conteúdo pode desaparecer quando a instância é encerrada;
- uma nova instância volta a descarregar os blocos necessários;
- a aplicação nunca depende do cache para funcionar;
- os blocos mais antigos são apagados automaticamente quando o limite é atingido.

## Teste local desta versão

Podes testar antes de publicar colocando temporariamente uma nova chave em `service_account.json`:

```powershell
py -m pip install -r requirements.txt
py app.py
```

Depois abre:

```text
http://127.0.0.1:5000
```

Também podes testar com a CLI do Vercel:

```powershell
npm install -g vercel
vercel dev
```

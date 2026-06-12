# Correção do erro `functions app.py`

O Vercel deteta automaticamente a aplicação Flask através do ficheiro `app.py` na raiz e da variável de topo `app`.

## Estrutura correta

```text
app.py
infinity_app.py
requirements.txt
vercel.json
.python-version
templates/
public/
```

Não uses no `vercel.json`:

```json
"functions": {
  "app.py": { ... }
}
```

Os padrões definidos em `functions` são destinados às Vercel Functions correspondentes, normalmente dentro de `api/`. Para esta aplicação Flask de entrada única, usa a deteção automática sem essa configuração.

## Publicação

1. Substitui o `vercel.json` antigo pelo novo.
2. Confirma que `app.py` está diretamente na Root Directory selecionada no Vercel.
3. Não definas Build Command, Output Directory nem Install Command personalizados.
4. Faz um novo deployment sem cache.
5. Testa `/api/health`, `/` e `/radio`.

O cache temporário em `/tmp` continua controlado pelo código Python; esta alteração apenas corrige a deteção/build da função.

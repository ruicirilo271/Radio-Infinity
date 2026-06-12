# -*- coding: utf-8 -*-
"""Entrada única da Infinity Radio no Vercel e arranque local."""

import os

# O Vercel procura obrigatoriamente uma aplicação WSGI de topo chamada `app`.
from infinity_app import TMP_ROOT, app

__all__ = ["app"]


if __name__ == "__main__":
    print("=" * 72)
    print("  INFINITY RADIO — VERSÃO VERCEL / TESTE LOCAL")
    print("  Site:      http://127.0.0.1:5000")
    print("  Playlist:  http://127.0.0.1:5000/radio")
    print("  Saúde:     http://127.0.0.1:5000/api/health")
    print(f"  Cache tmp: {TMP_ROOT}")
    print("=" * 72)

    app.run(
        host="0.0.0.0",
        port=int(os.getenv("PORT", "5000")),
        debug=False,
        threaded=True,
    )

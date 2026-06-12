# -*- coding: utf-8 -*-
"""Arranque local da versão Vercel da Infinity Radio."""

import os

from infinity_app import TMP_ROOT, app as application


if __name__ == "__main__":
    print("=" * 72)
    print("  INFINITY RADIO — VERSÃO VERCEL / TESTE LOCAL")
    print("  Site:      http://127.0.0.1:5000")
    print("  Playlist:  http://127.0.0.1:5000/radio")
    print("  Saúde:     http://127.0.0.1:5000/api/health")
    print(f"  Cache tmp: {TMP_ROOT}")
    print("=" * 72)

    application.run(
        host="0.0.0.0",
        port=int(os.getenv("PORT", "5000")),
        debug=False,
        threaded=True,
    )

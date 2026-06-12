# -*- coding: utf-8 -*-
"""
Infinity Radio — versão Vercel

Arquitetura serverless:
- Flask executado como uma única Vercel Function.
- Credenciais Google numa variável de ambiente.
- Playlists e blocos de áudio guardados temporariamente em /tmp.
- Cada resposta de áudio é limitada a menos de 4,5 MB e usa HTTP Range.
- O site toca faixa a faixa para manter título, capa e próxima música sincronizados.
- /radio e /radio.m3u devolvem uma playlist M3U; não são um stream infinito.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import os
import random
import re
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Generator

from flask import Flask, Response, jsonify, redirect, render_template, request, stream_with_context, url_for
from google.auth.transport.requests import AuthorizedSession
from google.oauth2 import service_account
from googleapiclient.discovery import build
from mutagen.id3 import ID3, ID3NoHeaderError

try:
    from zoneinfo import ZoneInfo
except ImportError as exc:  # pragma: no cover
    raise RuntimeError("Python 3.12 ou superior é necessário.") from exc


# ─────────────────────────────────────────────────────────────
# APLICAÇÃO E LIMITES
# ─────────────────────────────────────────────────────────────

ROOT_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT_DIR / "public"
TEMPLATE_DIR = ROOT_DIR / "templates"

app = Flask(
    __name__,
    template_folder=str(TEMPLATE_DIR),
    static_folder=str(PUBLIC_DIR),
    static_url_path="",
)

# Aceita /radio e /radio/ sem devolver 404 por causa da barra final.
app.url_map.strict_slashes = False

APP_NAME = "Infinity Radio"
APP_VERSION = "vercel-prefetch-2026.06.12.3"
TIMEZONE_NAME = "Europe/Lisbon"
LISBON_TZ = ZoneInfo(TIMEZONE_NAME)
SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

# A documentação atual do Vercel indica /tmp até 500 MB. Usamos 450 MB
# como teto global de segurança e 430 MB apenas para blocos de áudio.
TMP_ROOT = Path(os.getenv("INFINITY_TMP_DIR", "/tmp/infinity-radio"))
TMP_AUDIO_DIR = TMP_ROOT / "audio"
TMP_PLAYLIST_DIR = TMP_ROOT / "playlists"
TMP_COVER_DIR = TMP_ROOT / "covers"

VERCEL_TMP_MAX_BYTES = 500 * 1024 * 1024
TMP_SAFETY_MAX_BYTES = min(
    int(os.getenv("TMP_SAFETY_MAX_BYTES", str(450 * 1024 * 1024))),
    450 * 1024 * 1024,
)
TMP_AUDIO_MAX_BYTES = min(
    int(os.getenv("TMP_AUDIO_MAX_BYTES", str(430 * 1024 * 1024))),
    TMP_SAFETY_MAX_BYTES,
)

# O corpo de uma resposta de Vercel Function tem limite de 4,5 MB.
# 3,75 MB deixa margem de segurança.
MAX_RANGE_BYTES = min(
    int(os.getenv("MAX_RANGE_BYTES", "3750000")),
    4_000_000,
)
STREAM_READ_CHUNK = 64 * 1024
GOOGLE_READ_CHUNK = 128 * 1024
PLAYLIST_CACHE_SECONDS = int(os.getenv("PLAYLIST_CACHE_SECONDS", "300"))
SIGNED_URL_TTL_SECONDS = int(os.getenv("SIGNED_URL_TTL_SECONDS", "21600"))
M3U_SIGNED_URL_TTL_SECONDS = int(os.getenv("M3U_SIGNED_URL_TTL_SECONDS", "86400"))
MAX_COVER_SCAN_BYTES = int(os.getenv("MAX_COVER_SCAN_BYTES", str(2 * 1024 * 1024)))
MAX_COVER_RESPONSE_BYTES = 3_500_000

DEFAULT_COVER = "/infinity-cover.svg"
VALID_FILE_ID = re.compile(r"^[A-Za-z0-9_-]{10,200}$")

for directory in (TMP_ROOT, TMP_AUDIO_DIR, TMP_PLAYLIST_DIR, TMP_COVER_DIR):
    directory.mkdir(parents=True, exist_ok=True)


# ─────────────────────────────────────────────────────────────
# PROGRAMAÇÃO
# ─────────────────────────────────────────────────────────────

SCHEDULE = [
    ("00:00", "01:00", "Palavra Amiga", "11Uw_fpwciLyUp0OKO2vridtgsXXqeO8S"),
    ("01:00", "02:00", "Música Evangélica", "1GoJHXyAbbRFSVAC6kQ6583lEHvzWyKtn"),
    ("02:00", "04:00", "60 Minutes", "11N9zeNNtv9W0aN4HgxxYglMW040Y_AAA"),
    ("04:00", "08:00", "Música", "1XVx29N8M3QP9UIjiaQKZLj7JhszkLulm"),
    ("08:00", "09:00", "Heavy Metal", "1RgJRFNXxowYhXXgbe7be92hPPlOxvw9O"),
    ("09:00", "10:00", "Kizomba", "1V5MKvfX9wrlW67AHTgSgzz6DpoDrN9JL"),
    ("10:00", "11:00", "Música", "1XVx29N8M3QP9UIjiaQKZLj7JhszkLulm"),
    ("11:00", "12:00", "Billboard", "1S94JxRMHeYJj5IEF_zrBsFSZeObLTVpV"),
    ("12:00", "13:00", "Palavra Amiga", "11Uw_fpwciLyUp0OKO2vridtgsXXqeO8S"),
    ("13:00", "13:10", "Notícias", "1L4C-nyAEX8Rpxjq49ncu9gM60V3kOqOu"),
    ("13:10", "15:00", "Top Music", "1dScPnc-pXtwb1rV8ERsTVFH0KJcNLPqg"),
    ("15:00", "16:00", "Música", "1XVx29N8M3QP9UIjiaQKZLj7JhszkLulm"),
    ("16:00", "17:00", "Anos 80", "1dJiXzpLI96joKDiOMWfzvwH62xFpeAaN"),
    ("17:00", "18:00", "Música Evangélica", "1GoJHXyAbbRFSVAC6kQ6583lEHvzWyKtn"),
    ("18:00", "20:00", "Howard Stern Show", "1dpBJs0DNoPZyw2oC0d8JUkKxuMZTPHTL"),
    ("20:00", "21:00", "Soundtracks", "1TKQpGra7UTrHGOjYTWZwOfCNMH3gZ7Cz"),
    ("21:00", "22:00", "Billboard", "1S94JxRMHeYJj5IEF_zrBsFSZeObLTVpV"),
    ("22:00", "00:00", "ByNight", "1WiPwPaq4O193apSW4673F4sVm8k9apFG"),
]

ALLOWED_MANUAL_PROGRAMS = {(folder, name) for _, _, name, folder in SCHEDULE}


def lisbon_now() -> datetime:
    return datetime.now(LISBON_TZ)


def _time_parts(value: str) -> tuple[int, int]:
    hour, minute = value.split(":", 1)
    return int(hour), int(minute)


def _schedule_for_date(day: date) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []

    for start, end, name, folder in SCHEDULE:
        start_h, start_m = _time_parts(start)
        end_h, end_m = _time_parts(end)

        start_dt = datetime(day.year, day.month, day.day, start_h, start_m, tzinfo=LISBON_TZ)
        end_dt = datetime(day.year, day.month, day.day, end_h, end_m, tzinfo=LISBON_TZ)

        if end_dt <= start_dt:
            end_dt += timedelta(days=1)

        entries.append(
            {
                "name": name,
                "folder": folder,
                "start": start,
                "end": end,
                "start_dt": start_dt,
                "end_dt": end_dt,
                "mode": "auto",
            }
        )

    return entries


def current_auto_program(now: datetime | None = None) -> dict[str, Any]:
    now = now or lisbon_now()
    entries = _schedule_for_date(now.date() - timedelta(days=1))
    entries += _schedule_for_date(now.date())

    for entry in entries:
        if entry["start_dt"] <= now < entry["end_dt"]:
            return entry

    # Nunca deixar a aplicação sem um programa válido.
    start, end, name, folder = next(item for item in SCHEDULE if item[2] == "Música")
    return {
        "name": name,
        "folder": folder,
        "start": start,
        "end": end,
        "start_dt": now,
        "end_dt": now + timedelta(hours=1),
        "mode": "auto",
    }


def next_auto_program(now: datetime | None = None) -> dict[str, Any]:
    now = now or lisbon_now()
    entries = _schedule_for_date(now.date()) + _schedule_for_date(now.date() + timedelta(days=1))
    future = [entry for entry in entries if entry["start_dt"] > now]
    return min(future, key=lambda item: item["start_dt"])


def requested_program(now: datetime | None = None) -> dict[str, Any]:
    """Modo manual é mantido no browser e enviado por query string."""
    folder = str(request.args.get("folder", "")).strip()
    name = str(request.args.get("name", "")).strip()

    if folder and name and (folder, name) in ALLOWED_MANUAL_PROGRAMS:
        return {
            "name": name,
            "folder": folder,
            "start": None,
            "end": None,
            "start_dt": None,
            "end_dt": None,
            "mode": "manual",
        }

    return current_auto_program(now)


# ─────────────────────────────────────────────────────────────
# CREDENCIAIS GOOGLE E ASSINATURAS
# ─────────────────────────────────────────────────────────────

_CREDENTIALS_INFO: dict[str, Any] | None = None
_CREDENTIALS_SOURCE = "não configuradas"
_CREDENTIALS_LOCK = threading.RLock()


def _decode_service_account_env() -> dict[str, Any] | None:
    global _CREDENTIALS_SOURCE

    raw_json = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()
    if raw_json:
        try:
            info = json.loads(raw_json)
            _CREDENTIALS_SOURCE = "GOOGLE_SERVICE_ACCOUNT_JSON"
            return info
        except json.JSONDecodeError as exc:
            raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON não contém JSON válido.") from exc

    raw_b64 = os.getenv("GOOGLE_SERVICE_ACCOUNT_B64", "").strip()
    if raw_b64:
        try:
            decoded = base64.b64decode(raw_b64).decode("utf-8")
            info = json.loads(decoded)
            _CREDENTIALS_SOURCE = "GOOGLE_SERVICE_ACCOUNT_B64"
            return info
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_B64 é inválida.") from exc

    configured_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    candidates = [Path(configured_path)] if configured_path else []
    candidates.append(ROOT_DIR / "service_account.json")

    for path in candidates:
        if path and path.exists() and path.is_file():
            try:
                info = json.loads(path.read_text(encoding="utf-8"))
                _CREDENTIALS_SOURCE = str(path)
                return info
            except (OSError, json.JSONDecodeError) as exc:
                raise RuntimeError(f"Não foi possível ler as credenciais em {path}.") from exc

    return None


def credentials_info() -> dict[str, Any]:
    global _CREDENTIALS_INFO

    with _CREDENTIALS_LOCK:
        if _CREDENTIALS_INFO is None:
            _CREDENTIALS_INFO = _decode_service_account_env()

        if not _CREDENTIALS_INFO:
            raise RuntimeError(
                "Credenciais Google não configuradas. Define GOOGLE_SERVICE_ACCOUNT_JSON no Vercel."
            )

        required = {"client_email", "private_key", "token_uri"}
        missing = required.difference(_CREDENTIALS_INFO)
        if missing:
            raise RuntimeError(f"Credenciais Google incompletas: {', '.join(sorted(missing))}.")

        return _CREDENTIALS_INFO


def signing_secret() -> bytes:
    explicit = os.getenv("STREAM_SIGNING_KEY", "").strip()
    if explicit:
        return explicit.encode("utf-8")

    info = credentials_info()
    material = f"{info.get('project_id', '')}:{info['client_email']}:{info['private_key']}"
    return hashlib.sha256(material.encode("utf-8")).digest()


def make_signature(purpose: str, file_id: str, size: int, expires: int) -> str:
    message = f"{purpose}:{file_id}:{size}:{expires}".encode("utf-8")
    return hmac.new(signing_secret(), message, hashlib.sha256).hexdigest()


def signed_query(purpose: str, file_id: str, size: int, ttl_seconds: int) -> dict[str, str]:
    expires = int(time.time()) + max(60, ttl_seconds)
    return {
        "size": str(size),
        "exp": str(expires),
        "sig": make_signature(purpose, file_id, size, expires),
    }


def verify_signature(purpose: str, file_id: str, size: int, expires: int, signature: str) -> bool:
    if expires < int(time.time()) - 30:
        return False
    expected = make_signature(purpose, file_id, size, expires)
    return hmac.compare_digest(expected, signature)


# ─────────────────────────────────────────────────────────────
# GOOGLE DRIVE
# ─────────────────────────────────────────────────────────────

class DriveLibrary:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._credentials = None
        self._drive = None
        self._session = None
        self._memory_tracks: dict[str, tuple[float, list[dict[str, Any]]]] = {}

    def _ensure_ready(self) -> None:
        with self._lock:
            if self._drive is not None and self._session is not None:
                return

            self._credentials = service_account.Credentials.from_service_account_info(
                credentials_info(),
                scopes=SCOPES,
            )
            self._drive = build(
                "drive",
                "v3",
                credentials=self._credentials,
                cache_discovery=False,
            )
            self._session = AuthorizedSession(self._credentials)

    @property
    def drive(self):
        self._ensure_ready()
        return self._drive

    @property
    def session(self) -> AuthorizedSession:
        self._ensure_ready()
        return self._session

    @staticmethod
    def _playlist_cache_file(folder_id: str) -> Path:
        digest = hashlib.sha256(folder_id.encode("utf-8")).hexdigest()
        return TMP_PLAYLIST_DIR / f"{digest}.json"

    def list_tracks(self, folder_id: str, force_refresh: bool = False) -> list[dict[str, Any]]:
        now = time.time()
        memory = self._memory_tracks.get(folder_id)

        if not force_refresh and memory and now - memory[0] < PLAYLIST_CACHE_SECONDS:
            return [dict(item) for item in memory[1]]

        cache_file = self._playlist_cache_file(folder_id)
        if not force_refresh and cache_file.exists():
            try:
                if now - cache_file.stat().st_mtime < PLAYLIST_CACHE_SECONDS:
                    payload = json.loads(cache_file.read_text(encoding="utf-8"))
                    tracks = payload.get("tracks", [])
                    if isinstance(tracks, list):
                        self._memory_tracks[folder_id] = (now, tracks)
                        os.utime(cache_file, None)
                        return [dict(item) for item in tracks]
            except (OSError, json.JSONDecodeError, TypeError):
                cache_file.unlink(missing_ok=True)

        tracks: list[dict[str, Any]] = []
        page_token = None

        while True:
            result = (
                self.drive.files()
                .list(
                    q=(
                        f"'{folder_id}' in parents and trashed=false "
                        "and mimeType='audio/mpeg'"
                    ),
                    fields="nextPageToken,files(id,name,size,mimeType,modifiedTime)",
                    orderBy="name",
                    pageToken=page_token,
                    pageSize=1000,
                    supportsAllDrives=True,
                    includeItemsFromAllDrives=True,
                )
                .execute()
            )

            for item in result.get("files", []):
                raw = re.sub(r"\.mp3$", "", item["name"], flags=re.IGNORECASE).strip()
                if " - " in raw:
                    artist, title = raw.split(" - ", 1)
                else:
                    artist, title = "Infinity Radio", raw

                size = int(item.get("size", 0) or 0)
                if size <= 0:
                    continue

                tracks.append(
                    {
                        "id": item["id"],
                        "artist": artist.strip() or "Infinity Radio",
                        "title": title.strip() or raw,
                        "filename": item["name"],
                        "size": size,
                    }
                )

            page_token = result.get("nextPageToken")
            if not page_token:
                break

        self._memory_tracks[folder_id] = (now, tracks)

        try:
            temporary = cache_file.with_suffix(".tmp")
            temporary.write_text(
                json.dumps({"timestamp": now, "tracks": tracks}, ensure_ascii=False),
                encoding="utf-8",
            )
            temporary.replace(cache_file)
        except OSError:
            pass

        return [dict(item) for item in tracks]

    def media_response(
        self,
        file_id: str,
        *,
        start: int,
        end: int,
        timeout: tuple[int, int] = (15, 60),
    ):
        url = f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media"
        response = self.session.get(
            url,
            headers={"Range": f"bytes={start}-{end}"},
            stream=True,
            timeout=timeout,
        )
        response.raise_for_status()
        return response


LIBRARY = DriveLibrary()


# ─────────────────────────────────────────────────────────────
# CACHE /tmp COM LRU
# ─────────────────────────────────────────────────────────────

_CACHE_LOCK = threading.RLock()
_DOWNLOAD_LOCKS: dict[str, threading.Lock] = {}


def directory_size(directory: Path) -> int:
    total = 0
    try:
        for path in directory.rglob("*"):
            if path.is_file():
                try:
                    total += path.stat().st_size
                except OSError:
                    continue
    except OSError:
        return total
    return total


def _audio_cache_files() -> list[Path]:
    try:
        return [path for path in TMP_AUDIO_DIR.glob("*.bin") if path.is_file()]
    except OSError:
        return []


def evict_audio_cache(required_bytes: int = 0) -> None:
    with _CACHE_LOCK:
        files = _audio_cache_files()
        total = sum(path.stat().st_size for path in files if path.exists())
        files.sort(key=lambda path: path.stat().st_mtime if path.exists() else 0)

        while files and total + required_bytes > TMP_AUDIO_MAX_BYTES:
            oldest = files.pop(0)
            try:
                size = oldest.stat().st_size
                oldest.unlink(missing_ok=True)
                total -= size
            except OSError:
                continue


def audio_cache_path(file_id: str, start: int, end: int) -> Path:
    key = hashlib.sha256(f"{file_id}:{start}:{end}".encode("utf-8")).hexdigest()
    return TMP_AUDIO_DIR / f"{key}.bin"


def get_download_lock(cache_file: Path) -> threading.Lock:
    key = cache_file.name
    with _CACHE_LOCK:
        lock = _DOWNLOAD_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _DOWNLOAD_LOCKS[key] = lock
        return lock


def download_audio_range(file_id: str, start: int, end: int) -> Path:
    expected_size = end - start + 1
    cache_file = audio_cache_path(file_id, start, end)

    if cache_file.exists() and cache_file.stat().st_size == expected_size:
        os.utime(cache_file, None)
        return cache_file

    lock = get_download_lock(cache_file)
    with lock:
        if cache_file.exists() and cache_file.stat().st_size == expected_size:
            os.utime(cache_file, None)
            return cache_file

        evict_audio_cache(expected_size)
        temporary = cache_file.with_suffix(f".{os.getpid()}.{threading.get_ident()}.part")
        response = None

        try:
            response = LIBRARY.media_response(file_id, start=start, end=end, timeout=(15, 90))
            written = 0

            with temporary.open("wb") as output:
                for chunk in response.iter_content(chunk_size=GOOGLE_READ_CHUNK):
                    if not chunk:
                        continue

                    remaining = expected_size - written
                    if remaining <= 0:
                        break

                    piece = chunk[:remaining]
                    output.write(piece)
                    written += len(piece)

                    if written >= expected_size:
                        break

            if written != expected_size:
                raise IOError(
                    f"O Google Drive devolveu {written} bytes; eram esperados {expected_size}."
                )

            temporary.replace(cache_file)
            return cache_file
        finally:
            if response is not None:
                response.close()
            temporary.unlink(missing_ok=True)


def iter_file(path: Path) -> Generator[bytes, None, None]:
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(STREAM_READ_CHUNK)
            if not chunk:
                break
            yield chunk


# ─────────────────────────────────────────────────────────────
# HTTP RANGE
# ─────────────────────────────────────────────────────────────

_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


def parse_range_header(range_header: str | None, total_size: int) -> tuple[int, int]:
    if total_size <= 0:
        raise ValueError("Tamanho de ficheiro inválido.")

    if not range_header:
        start = 0
        end = min(total_size - 1, MAX_RANGE_BYTES - 1)
        return start, end

    match = _RANGE_RE.match(range_header.strip())
    if not match:
        raise ValueError("Cabeçalho Range inválido.")

    start_text, end_text = match.groups()
    if not start_text and not end_text:
        raise ValueError("Range vazio.")

    if not start_text:
        suffix = int(end_text)
        if suffix <= 0:
            raise ValueError("Range suffix inválido.")
        requested_start = max(0, total_size - suffix)
        requested_end = total_size - 1
    else:
        requested_start = int(start_text)
        requested_end = int(end_text) if end_text else total_size - 1

    if requested_start >= total_size or requested_end < requested_start:
        raise IndexError("Range fora do ficheiro.")

    requested_end = min(requested_end, total_size - 1)
    safe_end = min(requested_end, requested_start + MAX_RANGE_BYTES - 1)
    return requested_start, safe_end


# ─────────────────────────────────────────────────────────────
# CAPAS ID3 EM /tmp
# ─────────────────────────────────────────────────────────────

_COVER_MEMORY: dict[str, tuple[bytes, str]] = {}
_COVER_LOCK = threading.RLock()


def cover_cache_paths(file_id: str) -> tuple[Path, Path]:
    digest = hashlib.sha256(file_id.encode("utf-8")).hexdigest()
    return TMP_COVER_DIR / f"{digest}.bin", TMP_COVER_DIR / f"{digest}.json"


def extract_cover(file_id: str, total_size: int) -> tuple[bytes, str] | None:
    memory = _COVER_MEMORY.get(file_id)
    if memory:
        return memory

    binary_path, meta_path = cover_cache_paths(file_id)
    if binary_path.exists() and meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            data = binary_path.read_bytes()
            mime = str(meta.get("mime", "image/jpeg"))
            if data:
                os.utime(binary_path, None)
                os.utime(meta_path, None)
                _COVER_MEMORY[file_id] = (data, mime)
                return data, mime
        except (OSError, json.JSONDecodeError):
            binary_path.unlink(missing_ok=True)
            meta_path.unlink(missing_ok=True)

    with _COVER_LOCK:
        memory = _COVER_MEMORY.get(file_id)
        if memory:
            return memory

        scan_end = min(total_size - 1, MAX_COVER_SCAN_BYTES - 1)
        if scan_end < 0:
            return None

        response = LIBRARY.media_response(file_id, start=0, end=scan_end, timeout=(15, 45))
        try:
            data = b"".join(response.iter_content(chunk_size=GOOGLE_READ_CHUNK))
        finally:
            response.close()

        try:
            tags = ID3(fileobj=io.BytesIO(data))
        except (ID3NoHeaderError, Exception):
            return None

        for key in tags.keys():
            if not key.startswith("APIC"):
                continue

            frame = tags[key]
            cover = bytes(frame.data)
            if not cover or len(cover) > MAX_COVER_RESPONSE_BYTES:
                return None

            mime = str(getattr(frame, "mime", None) or "image/jpeg")
            _COVER_MEMORY[file_id] = (cover, mime)

            try:
                binary_path.write_bytes(cover)
                meta_path.write_text(json.dumps({"mime": mime}), encoding="utf-8")
            except OSError:
                pass

            return cover, mime

    return None


# ─────────────────────────────────────────────────────────────
# SERIALIZAÇÃO DE PLAYLISTS
# ─────────────────────────────────────────────────────────────


def public_track(track: dict[str, Any], ttl_seconds: int = SIGNED_URL_TTL_SECONDS) -> dict[str, Any]:
    file_id = track["id"]
    size = int(track["size"])
    audio_query = signed_query("audio", file_id, size, ttl_seconds)
    cover_query = signed_query("cover", file_id, size, ttl_seconds)

    return {
        "id": file_id,
        "artist": track["artist"],
        "title": track["title"],
        "size": size,
        # O browser descarrega a faixa completa através de blocos pequenos e
        # cria um Blob local antes de iniciar a reprodução.
        "chunk": url_for("audio_chunk", file_id=file_id, **audio_query),
        "stream": url_for("stream_single", file_id=file_id, **audio_query),
        "cover": url_for("api_cover", file_id=file_id, **cover_query),
    }


def program_payload(program: dict[str, Any], now: datetime) -> dict[str, Any]:
    remaining = None
    if program["mode"] == "auto" and program.get("end_dt"):
        remaining = max(0, int((program["end_dt"] - now).total_seconds()))

    return {
        "name": program["name"],
        "folder": program["folder"],
        "start": program.get("start"),
        "end": program.get("end"),
        "mode": program["mode"],
        "seconds_remaining": remaining,
    }


# ─────────────────────────────────────────────────────────────
# ROTAS
# ─────────────────────────────────────────────────────────────

@app.after_request
def common_headers(response: Response) -> Response:
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    return response


@app.route("/")
def index():
    response = Response(
        render_template(
            "index.html",
            app_name=APP_NAME,
            schedule=SCHEDULE,
            default_cover=DEFAULT_COVER,
        ),
        mimetype="text/html",
    )
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/status")
def api_status():
    now = lisbon_now()
    program = requested_program(now)
    next_program = next_auto_program(now)

    return jsonify(
        {
            "ok": True,
            "app": APP_NAME,
            "version": APP_VERSION,
            "platform": "vercel",
            "server_time": now.isoformat(),
            "mode": program["mode"],
            "program": program_payload(program, now),
            "next_program": {
                "name": next_program["name"],
                "start": next_program["start"],
                "end": next_program["end"],
            },
            "stream_url": "/radio",
            "audio_mode": "HTMLAudio nativo com pré-carregamento completo por blocos",
            "max_range_bytes": MAX_RANGE_BYTES,
        }
    )


@app.route("/api/player/playlist")
def api_player_playlist():
    now = lisbon_now()
    program = requested_program(now)

    try:
        tracks = LIBRARY.list_tracks(program["folder"])
    except Exception as exc:
        app.logger.exception("Erro ao listar a pasta do Google Drive: %s", exc)
        return jsonify({"ok": False, "error": str(exc)}), 502

    if not tracks:
        return jsonify({"ok": False, "error": "A pasta deste programa não contém MP3."}), 404

    # Uma ordem nova por sessão do browser. O player conserva-a até mudar de programa.
    random.SystemRandom().shuffle(tracks)

    return jsonify(
        {
            "ok": True,
            "program": program_payload(program, now),
            "tracks": [public_track(track) for track in tracks],
            "tmp": {
                "enabled": True,
                "audio_limit_mb": round(TMP_AUDIO_MAX_BYTES / 1024 / 1024),
                "range_mb": round(MAX_RANGE_BYTES / 1_000_000, 2),
                "range_bytes": MAX_RANGE_BYTES,
            },
        }
    )


@app.route("/api/schedule")
def api_schedule():
    return jsonify(
        [
            {"start": start, "end": end, "name": name, "folder": folder}
            for start, end, name, folder in SCHEDULE
        ]
    )


@app.route("/__infinity_audio__/<file_id>", methods=["GET", "HEAD"])
def virtual_audio_placeholder(file_id: str):
    """Esta rota só é usada se o Service Worker ainda não controlar a página."""
    return jsonify({
        "error": "O proxy de áudio do navegador ainda não está ativo.",
        "action": "Atualiza a página e volta a ligar a rádio.",
    }), 428


@app.route("/api/audio/chunk/<file_id>", methods=["GET", "HEAD"])
@app.route("/audio/chunk/<file_id>", methods=["GET", "HEAD"])
def audio_chunk(file_id: str):
    """Entrega um bloco independente de até MAX_RANGE_BYTES.

    O navegador junta estes blocos com MediaSource. Ao contrário da rota
    Range, cada resposta é um recurso completo e nunca anuncia um corpo
    maior do que aquele que realmente devolve.
    """
    if not VALID_FILE_ID.fullmatch(file_id):
        return jsonify({"error": "ID inválido."}), 400

    try:
        total_size = int(request.args.get("size", "0"))
        expires = int(request.args.get("exp", "0"))
        signature = request.args.get("sig", "")
        offset = int(request.args.get("offset", "0"))
    except ValueError:
        return jsonify({"error": "Parâmetros inválidos."}), 400

    if total_size <= 0 or not verify_signature("audio", file_id, total_size, expires, signature):
        return jsonify({"error": "URL de áudio expirada ou inválida."}), 403

    if offset < 0 or offset >= total_size:
        return jsonify({"error": "Offset fora do ficheiro."}), 416

    end = min(total_size - 1, offset + MAX_RANGE_BYTES - 1)
    length = end - offset + 1
    next_offset = end + 1 if end + 1 < total_size else -1

    headers = {
        "Content-Length": str(length),
        "Cache-Control": "private, max-age=3600",
        "Content-Encoding": "identity",
        "ETag": f'W/"{file_id}-{total_size}-{offset}-{end}"',
        "X-Infinity-Chunk-Start": str(offset),
        "X-Infinity-Chunk-End": str(end),
        "X-Infinity-File-Size": str(total_size),
        "X-Infinity-Next-Offset": str(next_offset),
        "X-Infinity-Cache": "tmp",
    }

    if request.method == "HEAD":
        return Response(status=200, headers=headers, mimetype="audio/mpeg")

    try:
        cache_file = download_audio_range(file_id, offset, end)
    except Exception as exc:
        app.logger.exception("Erro ao obter bloco de áudio MSE: %s", exc)
        return jsonify({"error": "Não foi possível carregar este bloco de áudio."}), 502

    response = Response(
        stream_with_context(iter_file(cache_file)),
        status=200,
        mimetype="audio/mpeg",
        direct_passthrough=True,
    )
    for key, value in headers.items():
        response.headers[key] = value
    return response


@app.route("/stream/<file_id>", methods=["GET", "HEAD"])
def stream_single(file_id: str):
    if not VALID_FILE_ID.fullmatch(file_id):
        return jsonify({"error": "ID inválido."}), 400

    try:
        total_size = int(request.args.get("size", "0"))
        expires = int(request.args.get("exp", "0"))
        signature = request.args.get("sig", "")
    except ValueError:
        return jsonify({"error": "Assinatura inválida."}), 403

    if total_size <= 0 or not verify_signature("audio", file_id, total_size, expires, signature):
        return jsonify({"error": "URL de áudio expirada ou inválida."}), 403

    try:
        start, end = parse_range_header(request.headers.get("Range"), total_size)
    except IndexError:
        response = Response(status=416)
        response.headers["Content-Range"] = f"bytes */{total_size}"
        return response
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    length = end - start + 1
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Range": f"bytes {start}-{end}/{total_size}",
        "Content-Length": str(length),
        "Cache-Control": "private, max-age=3600",
        "Vary": "Range",
        "Content-Encoding": "identity",
        "ETag": f'W/"{file_id}-{total_size}"',
        "X-Infinity-Cache": "tmp",
    }

    if request.method == "HEAD":
        return Response(status=206, headers=headers, mimetype="audio/mpeg")

    try:
        cache_file = download_audio_range(file_id, start, end)
    except Exception as exc:
        app.logger.exception("Erro ao obter bloco de áudio: %s", exc)
        return jsonify({"error": "Não foi possível carregar este bloco de áudio."}), 502

    response = Response(
        stream_with_context(iter_file(cache_file)),
        status=206,
        mimetype="audio/mpeg",
        direct_passthrough=True,
    )
    for key, value in headers.items():
        response.headers[key] = value
    return response


@app.route("/api/cover/<file_id>")
def api_cover(file_id: str):
    if not VALID_FILE_ID.fullmatch(file_id):
        return Response(status=400)

    try:
        total_size = int(request.args.get("size", "0"))
        expires = int(request.args.get("exp", "0"))
        signature = request.args.get("sig", "")
    except ValueError:
        return Response(status=403)

    if total_size <= 0 or not verify_signature("cover", file_id, total_size, expires, signature):
        return Response(status=403)

    try:
        result = extract_cover(file_id, total_size)
    except Exception as exc:
        app.logger.warning("Erro ao extrair capa %s: %s", file_id, exc)
        result = None

    if not result:
        return Response(status=404)

    cover, mime = result
    response = Response(cover, mimetype=mime)
    response.headers["Cache-Control"] = "private, max-age=3600"
    return response


@app.route("/radio")
def radio_web():
    """No Vercel, abre o player web; não existe socket MP3 infinito."""
    return redirect(url_for("index"), code=302)


@app.route("/radio.m3u")
def radio_playlist():
    """Playlist experimental; o player web é o modo suportado no Vercel."""
    now = lisbon_now()
    program = requested_program(now)

    try:
        tracks = LIBRARY.list_tracks(program["folder"])
    except Exception as exc:
        app.logger.exception("Erro ao criar M3U: %s", exc)
        return Response("#EXTM3U\n# Erro ao carregar a Infinity Radio\n", status=502, mimetype="audio/x-mpegurl")

    random.SystemRandom().shuffle(tracks)
    lines = ["#EXTM3U", f"#PLAYLIST:{APP_NAME} — {program['name']}"]

    # A playlist externa também usa blocos completos inferiores a 4,5 MB.
    # Alguns leitores, como o VLC, conseguem avançar por estas partes. Pode
    # existir uma pausa mínima entre blocos; o player web é o modo recomendado.
    item_count = 0
    for track in tracks[:250]:
        size = int(track["size"])
        query = signed_query("audio", track["id"], size, M3U_SIGNED_URL_TTL_SECONDS)
        part_total = max(1, (size + MAX_RANGE_BYTES - 1) // MAX_RANGE_BYTES)

        for part_index, offset in enumerate(range(0, size, MAX_RANGE_BYTES), start=1):
            chunk_url = url_for(
                "audio_chunk",
                file_id=track["id"],
                offset=offset,
                _external=True,
                **query,
            )
            suffix = "" if part_total == 1 else f" · parte {part_index}/{part_total}"
            lines.append(f"#EXTINF:-1,{track['artist']} - {track['title']}{suffix}")
            lines.append(chunk_url)
            item_count += 1
            if item_count >= 1000:
                break
        if item_count >= 1000:
            break

    response = Response("\n".join(lines) + "\n", mimetype="audio/x-mpegurl")
    response.headers["Content-Disposition"] = 'inline; filename="infinity-radio.m3u"'
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/health/audio")
def api_health_audio():
    """Diagnóstico real: lista a pasta e descarrega os primeiros 64 KB."""
    now = lisbon_now()
    program = requested_program(now)

    try:
        tracks = LIBRARY.list_tracks(program["folder"])
        if not tracks:
            return jsonify({"ok": False, "error": "A pasta atual não contém MP3."}), 404

        track = tracks[0]
        end = min(int(track["size"]) - 1, 65535)
        cache_file = download_audio_range(track["id"], 0, end)
        sample = cache_file.read_bytes()[:16]
        looks_like_mp3 = sample.startswith(b"ID3") or any(
            sample[index:index + 2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2")
            for index in range(max(0, len(sample) - 1))
        )

        return jsonify({
            "ok": True,
            "program": program["name"],
            "folder": program["folder"],
            "tracks_found": len(tracks),
            "test_track": {
                "id": track["id"],
                "artist": track["artist"],
                "title": track["title"],
                "size": int(track["size"]),
            },
            "sample_bytes": cache_file.stat().st_size,
            "sample_looks_like_mp3": looks_like_mp3,
        })
    except Exception as exc:
        app.logger.exception("Diagnóstico de áudio falhou: %s", exc)
        return jsonify({"ok": False, "error": str(exc)}), 502


@app.route("/api/health")
def api_health():
    credential_error = None
    credentials_ready = False

    try:
        info = credentials_info()
        credentials_ready = bool(info.get("client_email") and info.get("private_key"))
    except Exception as exc:
        credential_error = str(exc)

    tmp_used = directory_size(TMP_ROOT)
    audio_used = directory_size(TMP_AUDIO_DIR)

    payload = {
        "ok": credentials_ready,
        "app": APP_NAME,
        "version": APP_VERSION,
        "platform": "vercel" if os.getenv("VERCEL") else "local/vercel-dev",
        "credentials_ready": credentials_ready,
        "credentials_source": _CREDENTIALS_SOURCE if credentials_ready else None,
        "credentials_error": credential_error,
        "timezone": TIMEZONE_NAME,
        "server_time": lisbon_now().isoformat(),
        "tmp": {
            "path": str(TMP_ROOT),
            "documented_max_mb": round(VERCEL_TMP_MAX_BYTES / 1024 / 1024),
            "safety_limit_mb": round(TMP_SAFETY_MAX_BYTES / 1024 / 1024),
            "audio_limit_mb": round(TMP_AUDIO_MAX_BYTES / 1024 / 1024),
            "used_mb": round(tmp_used / 1024 / 1024, 2),
            "audio_used_mb": round(audio_used / 1024 / 1024, 2),
            "range_response_mb": round(MAX_RANGE_BYTES / 1_000_000, 2),
            "ephemeral": True,
        },
        "radio_route": "/radio abre o player web; /radio.m3u é experimental",
        "web_player_mode": "HTMLAudio nativo + faixa completa em Blob + próxima faixa pré-carregada",
        "audio_chunk_route": "/api/audio/chunk/<file_id>",
        "direct_continuous_stream_supported": False,
    }
    return jsonify(payload), (200 if credentials_ready else 503)


@app.errorhandler(404)
def not_found(_error):
    return jsonify({"error": "Rota não encontrada."}), 404


@app.errorhandler(500)
def internal_error(error):
    app.logger.exception("Erro interno: %s", error)
    return jsonify({"error": "Erro interno da Infinity Radio."}), 500


if __name__ == "__main__":
    print("=" * 72)
    print("  INFINITY RADIO — VERSÃO VERCEL / LOCAL TEST")
    print("  Site:      http://127.0.0.1:5000")
    print("  Playlist:  http://127.0.0.1:5000/radio")
    print("  Saúde:     http://127.0.0.1:5000/api/health")
    print(f"  Cache tmp: {TMP_ROOT}")
    print("=" * 72)
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=False, threaded=True)

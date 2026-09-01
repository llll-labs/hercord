"""Hercord dashboard/desktop backend — local channels + chat.

Mounted at /api/plugins/hercord/ by the Hermes plugin system.
Local-only: one machine, SQLite under plugin-data/hercord/. No Redis.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import (
    APIRouter,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

router = APIRouter()

SCHEMA_VERSION = 1
UPLOAD_MAX_BYTES = 8_000_000

# In-process WS subscribers for /events. Local single-process only.
_subscribers: set[WebSocket] = set()
_subs_lock = asyncio.Lock()


# ---------------------------------------------------------------------------
# Paths / DB
# ---------------------------------------------------------------------------

def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:
        return Path.home() / ".hermes"


def _data_dir() -> Path:
    d = _hermes_home() / "plugin-data" / "hercord"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _files_dir() -> Path:
    d = _data_dir() / "files"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _db_path() -> Path:
    return _data_dir() / "hercord.db"


def _new_id() -> str:
    return uuid.uuid4().hex


def _slugify(name: str) -> str:
    s = name.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "channel"


def _row_user(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "handle": r["handle"],
        "display_name": r["display_name"],
        "created_at": r["created_at"],
    }


def _row_channel(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "slug": r["slug"],
        "name": r["name"],
        "created_at": r["created_at"],
    }


def _row_message(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "channel_id": r["channel_id"],
        "user_id": r["user_id"],
        "body": r["body"],
        "created_at": r["created_at"],
        "handle": r["handle"] if "handle" in r.keys() else None,
        "display_name": r["display_name"] if "display_name" in r.keys() else None,
    }


def _row_file(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "message_id": r["message_id"],
        "uploader_id": r["uploader_id"],
        "filename": r["filename"],
        "mime": r["mime"],
        "size": r["size"],
        "path": r["path"],
        "created_at": r["created_at"],
    }


def migrate(conn: sqlite3.Connection) -> None:
    """Create/upgrade schema. Source of truth (schema.sql is documentation)."""
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS meta (
          k TEXT PRIMARY KEY,
          v TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          handle TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS channels (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL REFERENCES channels(id),
          user_id TEXT NOT NULL REFERENCES users(id),
          body TEXT NOT NULL DEFAULT '',
          created_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_channel_ts
          ON messages(channel_id, created_at);
        CREATE TABLE IF NOT EXISTS files (
          id TEXT PRIMARY KEY,
          message_id TEXT REFERENCES messages(id),
          uploader_id TEXT NOT NULL REFERENCES users(id),
          filename TEXT NOT NULL,
          mime TEXT,
          size INTEGER NOT NULL,
          path TEXT NOT NULL,
          created_at REAL NOT NULL
        );
        """
    )
    row = conn.execute(
        "SELECT v FROM meta WHERE k = 'schema_version'"
    ).fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO meta (k, v) VALUES ('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )
    else:
        # Future migrations would branch on int(row['v']).
        if int(row["v"]) < SCHEMA_VERSION:
            conn.execute(
                "UPDATE meta SET v = ? WHERE k = 'schema_version'",
                (str(SCHEMA_VERSION),),
            )

    # Seed #general
    existing = conn.execute(
        "SELECT id FROM channels WHERE slug = ?", ("general",)
    ).fetchone()
    if existing is None:
        now = time.time()
        conn.execute(
            "INSERT INTO channels (id, slug, name, created_at) VALUES (?, ?, ?, ?)",
            (_new_id(), "general", "general", now),
        )
    conn.commit()


_db_ready = False


def get_db() -> sqlite3.Connection:
    """Open SQLite with WAL + FKs; migrate lazily on first use."""
    global _db_ready
    path = _db_path()
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    if not _db_ready:
        migrate(conn)
        _db_ready = True
    return conn


def _livekit_configured() -> bool:
    return bool(
        os.environ.get("LIVEKIT_URL")
        and os.environ.get("LIVEKIT_API_KEY")
        and os.environ.get("LIVEKIT_API_SECRET")
    )


async def _broadcast(event_type: str, payload: Any) -> None:
    frame = {"type": event_type, "payload": payload}
    dead: list[WebSocket] = []
    async with _subs_lock:
        targets = list(_subscribers)
    for ws in targets:
        try:
            await ws.send_json(frame)
        except Exception:
            dead.append(ws)
    if dead:
        async with _subs_lock:
            for ws in dead:
                _subscribers.discard(ws)


def _ws_upgrade_authorized(ws: WebSocket) -> bool:
    """Delegate to hermes_cli.web_server._ws_auth_ok when present."""
    try:
        from hermes_cli import web_server as _ws

        return bool(_ws._ws_auth_ok(ws))
    except Exception:
        return True


# ---------------------------------------------------------------------------
# Health / identity
# ---------------------------------------------------------------------------

@router.get("/health")
def health():
    # Touch DB so migrate runs (lazy).
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT v FROM meta WHERE k = 'schema_version'"
        ).fetchone()
        schema = int(row["v"]) if row else SCHEMA_VERSION
    finally:
        conn.close()
    return {
        "ok": True,
        "schema": schema,
        "livekit": _livekit_configured(),
    }


class MeBody(BaseModel):
    handle: Optional[str] = None
    display_name: Optional[str] = None


@router.post("/me")
def post_me(body: MeBody = MeBody()):
    """Get-or-create the local single user (default handle ``local``)."""
    handle = (body.handle or "local").strip() or "local"
    display_name = (body.display_name or handle).strip() or handle
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT * FROM users WHERE handle = ?", (handle,)
        ).fetchone()
        if row is None:
            uid = _new_id()
            now = time.time()
            conn.execute(
                "INSERT INTO users (id, handle, display_name, created_at) "
                "VALUES (?, ?, ?, ?)",
                (uid, handle, display_name, now),
            )
            conn.commit()
            row = conn.execute(
                "SELECT * FROM users WHERE id = ?", (uid,)
            ).fetchone()
        elif body.display_name and body.display_name.strip():
            conn.execute(
                "UPDATE users SET display_name = ? WHERE id = ?",
                (display_name, row["id"]),
            )
            conn.commit()
            row = conn.execute(
                "SELECT * FROM users WHERE id = ?", (row["id"],)
            ).fetchone()
        return {"user": _row_user(row)}
    finally:
        conn.close()


@router.get("/me")
def get_me():
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT * FROM users WHERE handle = ? LIMIT 1", ("local",)
        ).fetchone()
        if row is None:
            # Fall back to any user (first created).
            row = conn.execute(
                "SELECT * FROM users ORDER BY created_at ASC LIMIT 1"
            ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="no local user; POST /me first")
        return {"user": _row_user(row)}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Channels / messages
# ---------------------------------------------------------------------------

@router.get("/channels")
def list_channels():
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM channels ORDER BY created_at ASC"
        ).fetchall()
        return {"channels": [_row_channel(r) for r in rows]}
    finally:
        conn.close()


class CreateChannelBody(BaseModel):
    name: str
    slug: Optional[str] = None


@router.post("/channels")
async def create_channel(body: CreateChannelBody):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    slug = _slugify(body.slug or name)
    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT * FROM channels WHERE slug = ?", (slug,)
        ).fetchone()
        if existing is not None:
            raise HTTPException(status_code=409, detail=f"slug {slug!r} already exists")
        cid = _new_id()
        now = time.time()
        conn.execute(
            "INSERT INTO channels (id, slug, name, created_at) VALUES (?, ?, ?, ?)",
            (cid, slug, name, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM channels WHERE id = ?", (cid,)).fetchone()
        channel = _row_channel(row)
    finally:
        conn.close()
    await _broadcast("channel", channel)
    return {"channel": channel}


@router.get("/channels/{channel_id}/messages")
def list_messages(
    channel_id: str,
    limit: int = Query(80, ge=1, le=500),
):
    conn = get_db()
    try:
        ch = conn.execute(
            "SELECT id FROM channels WHERE id = ?", (channel_id,)
        ).fetchone()
        if ch is None:
            raise HTTPException(status_code=404, detail="channel not found")
        rows = conn.execute(
            """
            SELECT m.*, u.handle, u.display_name
            FROM messages m
            JOIN users u ON u.id = m.user_id
            WHERE m.channel_id = ?
            ORDER BY m.created_at DESC
            LIMIT ?
            """,
            (channel_id, limit),
        ).fetchall()
        # Chronological for the UI
        msgs = [_row_message(r) for r in reversed(rows)]
        return {"messages": msgs}
    finally:
        conn.close()


class CreateMessageBody(BaseModel):
    body: str = ""
    user_id: str


@router.post("/channels/{channel_id}/messages")
async def create_message(channel_id: str, body: CreateMessageBody):
    text = body.body if body.body is not None else ""
    if not body.user_id:
        raise HTTPException(status_code=400, detail="user_id is required")
    conn = get_db()
    try:
        ch = conn.execute(
            "SELECT id FROM channels WHERE id = ?", (channel_id,)
        ).fetchone()
        if ch is None:
            raise HTTPException(status_code=404, detail="channel not found")
        user = conn.execute(
            "SELECT * FROM users WHERE id = ?", (body.user_id,)
        ).fetchone()
        if user is None:
            raise HTTPException(status_code=404, detail="user not found")
        mid = _new_id()
        now = time.time()
        conn.execute(
            "INSERT INTO messages (id, channel_id, user_id, body, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (mid, channel_id, body.user_id, text, now),
        )
        conn.commit()
        row = conn.execute(
            """
            SELECT m.*, u.handle, u.display_name
            FROM messages m
            JOIN users u ON u.id = m.user_id
            WHERE m.id = ?
            """,
            (mid,),
        ).fetchone()
        msg = _row_message(row)
    finally:
        conn.close()
    await _broadcast("message", msg)
    return {"message": msg}


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------

@router.post("/files")
async def upload_file(
    file: UploadFile = File(...),
    uploader_id: str = Form(...),
    message_id: Optional[str] = Form(None),
    channel_id: Optional[str] = Form(None),
):
    """Multipart upload. Cap UPLOAD_MAX_BYTES → 413.

    Optionally creates a message in ``channel_id`` linking the file.
    """
    if not uploader_id:
        raise HTTPException(status_code=400, detail="uploader_id is required")

    conn = get_db()
    try:
        user = conn.execute(
            "SELECT id FROM users WHERE id = ?", (uploader_id,)
        ).fetchone()
        if user is None:
            raise HTTPException(status_code=404, detail="uploader not found")

        linked_message_id = message_id
        if channel_id and not linked_message_id:
            ch = conn.execute(
                "SELECT id FROM channels WHERE id = ?", (channel_id,)
            ).fetchone()
            if ch is None:
                raise HTTPException(status_code=404, detail="channel not found")
            mid = _new_id()
            now = time.time()
            fname = file.filename or "file"
            conn.execute(
                "INSERT INTO messages (id, channel_id, user_id, body, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (mid, channel_id, uploader_id, f"[file: {fname}]", now),
            )
            linked_message_id = mid
            msg_row = {
                "id": mid,
                "channel_id": channel_id,
                "user_id": uploader_id,
                "body": f"[file: {fname}]",
                "created_at": now,
            }
        else:
            msg_row = None
            if linked_message_id:
                m = conn.execute(
                    "SELECT id FROM messages WHERE id = ?", (linked_message_id,)
                ).fetchone()
                if m is None:
                    raise HTTPException(status_code=404, detail="message not found")

        fid = _new_id()
        dest = _files_dir() / fid
        total = 0
        try:
            with open(dest, "wb") as out:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > UPLOAD_MAX_BYTES:
                        out.close()
                        dest.unlink(missing_ok=True)
                        raise HTTPException(
                            status_code=413,
                            detail=f"upload exceeds {UPLOAD_MAX_BYTES} byte limit",
                        )
                    out.write(chunk)
        except HTTPException:
            conn.rollback()
            raise
        except OSError as exc:
            conn.rollback()
            raise HTTPException(status_code=500, detail=f"failed to store file: {exc}")

        now = time.time()
        safe_name = (file.filename or "file").replace("/", "_").replace("\\", "_")
        rel_path = str(dest)
        conn.execute(
            "INSERT INTO files (id, message_id, uploader_id, filename, mime, size, path, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                fid,
                linked_message_id,
                uploader_id,
                safe_name,
                file.content_type,
                total,
                rel_path,
                now,
            ),
        )
        conn.commit()
        frow = conn.execute("SELECT * FROM files WHERE id = ?", (fid,)).fetchone()
        file_payload = _row_file(frow)
        if msg_row is not None:
            # Enrich for broadcast
            u = conn.execute(
                "SELECT handle, display_name FROM users WHERE id = ?",
                (uploader_id,),
            ).fetchone()
            msg_payload = {
                **msg_row,
                "handle": u["handle"] if u else None,
                "display_name": u["display_name"] if u else None,
                "file": file_payload,
            }
        else:
            msg_payload = None
    finally:
        conn.close()

    await _broadcast("file", file_payload)
    if msg_payload is not None:
        await _broadcast("message", msg_payload)
    return {"file": file_payload, "message": msg_payload}


@router.get("/files/{file_id}")
def download_file(file_id: str):
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT * FROM files WHERE id = ?", (file_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="file not found")
        stored = Path(row["path"]).resolve()
        root = _files_dir().resolve()
        try:
            stored.relative_to(root)
        except ValueError:
            raise HTTPException(status_code=404, detail="file unavailable")
        if not stored.is_file():
            raise HTTPException(status_code=404, detail="file missing on disk")
        return FileResponse(
            path=str(stored),
            filename=row["filename"],
            media_type=row["mime"] or "application/octet-stream",
        )
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# LiveKit (optional)
# ---------------------------------------------------------------------------

class LivekitTokenBody(BaseModel):
    room: str
    identity: str


@router.post("/livekit/token")
def livekit_token(body: LivekitTokenBody):
    if not _livekit_configured():
        raise HTTPException(
            status_code=501,
            detail={"error": "livekit_unconfigured"},
        )
    try:
        from livekit import api as livekit_api
    except ImportError:
        raise HTTPException(
            status_code=501,
            detail={"error": "livekit_unconfigured"},
        )
    room = (body.room or "").strip()
    identity = (body.identity or "").strip()
    if not room or not identity:
        raise HTTPException(status_code=400, detail="room and identity are required")
    try:
        token = (
            livekit_api.AccessToken(
                os.environ["LIVEKIT_API_KEY"],
                os.environ["LIVEKIT_API_SECRET"],
            )
            .with_identity(identity)
            .with_name(identity)
            .with_grants(
                livekit_api.VideoGrants(
                    room_join=True,
                    room=room,
                )
            )
            .to_jwt()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"token mint failed: {exc}")
    return {
        "token": token,
        "url": os.environ["LIVEKIT_URL"],
        "room": room,
        "identity": identity,
    }


# ---------------------------------------------------------------------------
# WebSocket /events
# ---------------------------------------------------------------------------

@router.websocket("/events")
async def events_ws(ws: WebSocket):
    if not _ws_upgrade_authorized(ws):
        await ws.close(code=1008)
        return
    await ws.accept()
    async with _subs_lock:
        _subscribers.add(ws)
    try:
        await ws.send_json({"type": "hello", "payload": {"ok": True}})
        while True:
            # Keep the socket open; clients may send pings or we just wait.
            try:
                await ws.receive_text()
            except WebSocketDisconnect:
                break
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.warning("hercord /events error: %s", exc)
    finally:
        async with _subs_lock:
            _subscribers.discard(ws)

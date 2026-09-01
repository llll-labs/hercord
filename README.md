# Hercord

Team chat inside [Hermes Desktop](https://hermes-agent.nousresearch.com/desktop). Channels, messages, files, live updates, and voice — one unified Hermes plugin.

Hercord docks as a third tab in the left zone — **SESSIONS | BOTS | HERCORD**. Pick a channel in the Hercord tab, read the thread in the main pane, send text, attach files, and join a voice room. History lives on the machine in SQLite, so a reload or a restart still has every message.

## What you get

- **Channels** — create named rooms (`#general`, `#random`, …) and switch between them from the Hercord tab
- **Chat** — send messages, scroll history, persist across restarts
- **Files** — attach images and documents to a channel
- **Live updates** — new messages and channels appear on the same machine without a refresh
- **Voice** — room join tokens via LiveKit (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`)
- **Identity** — a local user (`POST /me`) so every message has an author

## Install

```bash
git clone https://github.com/llll-labs/hercord.git ~/.hermes/plugins/hercord
hermes plugins enable hercord
```

Restart `hermes serve` / the gateway so the backend mounts, then in Hermes Desktop: command palette → **Reload desktop plugins** (or Settings → Plugins → Hercord on). Open the **Hercord** tab in the left zone (SESSIONS | BOTS | HERCORD), or command palette → **Hercord: Open**.

See [after-install.md](after-install.md) for the enable + reload sequence.

## Using it

Channels live in the **Hercord** left-zone tab; the main pane is the chat thread.

- `#general` is created on first run
- Click a channel to open the thread
- Enter sends, Shift+Enter inserts a newline
- Attach sits next to the composer
- Voice is on the channel header

## Data

Everything is under `$HERMES_HOME/plugin-data/hercord/`:

| Path | Contents |
| --- | --- |
| `hercord.db` | users, channels, messages, file metadata |
| `files/<id>` | uploaded blobs |

Reset the workspace with:

```bash
rm -rf "$HERMES_HOME/plugin-data/hercord"
```

`HERMES_HOME` is `hermes_constants.get_hermes_home()` when available, otherwise `~/.hermes`.

## Layout

Unified Hermes package (`plugin.yaml` + dashboard API + desktop UI):

```text
hercord/
├── plugin.yaml              # plugin id, label, env
├── dashboard/
│   ├── manifest.json        # { "name": "hercord", "api": "plugin_api.py" }
│   ├── plugin_api.py        # FastAPI router → /api/plugins/hercord/
│   └── schema.sql           # documented schema (runtime migrate() applies it)
└── desktop/
    └── plugin.js            # left-zone Hercord tab + /hercord chat page
```

The desktop half talks to the backend with `ctx.rest` and `ctx.socket`. Routes include `/health`, `/me`, `/channels`, `/channels/{id}/messages`, `/files`, `/livekit/token`, and WebSocket `/events`.

## Voice

Set these before starting serve:

```bash
LIVEKIT_URL=…
LIVEKIT_API_KEY=…
LIVEKIT_API_SECRET=…
```

`POST /livekit/token` mints a room join token for the current identity.

## License

See repository root. Built for Hermes Agent / Hermes Desktop (Nous Research).

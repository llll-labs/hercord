1. Enable the plugin: `hermes plugins enable hercord`
2. Restart the gateway / `hermes serve` so `dashboard/plugin_api.py` mounts under `/api/plugins/hercord/`.
3. In Hermes Desktop: command palette → **Reload desktop plugins** (or toggle Hercord in Settings → Plugins).
4. Open the **Hercord** sidebar item.

Voice rooms: set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`, then restart serve.

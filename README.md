# kuma-ploi-bridge

A minimal REST wrapper around Uptime Kuma's Socket.IO API. Exposes:

- `GET /health` — connection status
- `GET /monitors` — list monitors
- `POST /monitors` — create a monitor (`type: "http"` or `"ping"` or `"port"`)

All requests need `Authorization: Bearer <BRIDGE_API_KEY>`.

## Why this exists

Uptime Kuma doesn't have a REST API for creating monitors — only Socket.IO
(the same channel its own web UI uses). This service logs into Kuma once and
exposes two small HTTP endpoints on top of that connection.

## Request bodies

**POST /monitors** — HTTP monitor:
```json
{
  "type": "http",
  "name": "example.com",
  "url": "https://example.com",
  "interval": 60
}
```

**POST /monitors** — ping monitor:
```json
{
  "type": "ping",
  "name": "server-01",
  "hostname": "203.0.113.10",
  "interval": 60
}
```

## Deploy with Docker Compose (recommended)

1. Copy `.env.example` to `.env` and fill in `KUMA_URL`, `KUMA_USERNAME`,
   `KUMA_PASSWORD`, and a `BRIDGE_API_KEY` (generate one with
   `openssl rand -hex 32`).
2. `docker compose up -d --build`
3. Check `curl -H "Authorization: Bearer <key>" http://localhost:3000/health`
   — it should report `"loggedIn": true` within a few seconds.

A `docker-compose.yml` is included. If you'd rather run it as a Ploi daemon
(no Docker), it also runs fine as a plain `node server.js` process on any
server that has Node 18+ — Ploi's daemon feature will keep it alive and
restart it on failure.

## Testing a monitor creation by hand before wiring up n8n

```bash
curl -X POST http://localhost:3000/monitors \
  -H "Authorization: Bearer <your BRIDGE_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"type":"http","name":"test.example.com","url":"https://example.com"}'
```

If Kuma rejects the payload (e.g. a future Kuma version renamed a field),
the error message in the response body is Kuma's own — that's the thing to
read first, and the fix is a small edit to `buildMonitorBean()` in
`server.js`.

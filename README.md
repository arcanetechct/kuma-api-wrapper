# Uptime Kuma API Wrapper

A lightweight REST API wrapper for [Uptime Kuma](https://github.com/louislam/uptime-kuma).

Uptime Kuma primarily communicates through Socket.IO rather than exposing a traditional REST API for monitor management. This project maintains a connection to Uptime Kuma and provides a small HTTP API for interacting with monitors from scripts, automation platforms, or other applications.

## Features

Currently supported:

- Check wrapper and Uptime Kuma connection status
- List existing monitors
- Create HTTP monitors
- Create ping monitors
- Create port monitors
- Bearer token authentication
- Docker support

## Available Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Returns connection status: `{ ok, connected, loggedIn }` |
| `GET` | `/monitors` | Returns monitors including fields such as `id`, `name`, `type`, `url`, `hostname`, `port`, `parent`, and `tags`. |
| `POST` | `/monitors` | Create a monitor. See `buildMonitorBean()` for accepted fields, including `type: "group"` and `parent` for nested monitors. |
| `DELETE` | `/monitors/:id` | Delete a monitor. Optional `deleteChildren=true` query/body flag also deletes monitors nested under it. |
| `GET` | `/tags` | Returns tags as `{ id, name, color }`. |
| `POST` | `/tags` | Create a tag. Body: `{ name, color }`. `color` defaults to `#00A5C0` if omitted. |
| `POST` | `/monitors/:id/tags` | Attach an existing tag to a monitor. Body: `{ tagID, value }`. `value` is optional. |
| `DELETE` | `/monitors/:id/tags/:tagID` | Detach a tag from a monitor. Optional `value` query/body field narrows which tag/value pairing is removed. |


All API requests require an authorization header:

```http
Authorization: Bearer <BRIDGE_API_KEY>
```

## Why This Exists

Uptime Kuma does not currently provide a conventional REST API for creating monitors. Its web interface communicates with the backend using Socket.IO.

This wrapper connects to Uptime Kuma using that same interface and exposes a small REST API on top of it.

That makes it useful for things like:

- n8n workflows
- provisioning scripts
- deployment automation
- CI/CD pipelines
- server management tools
- custom dashboards
- other systems that are easier to integrate with HTTP APIs

## Configuration

Copy the included `.env.example` file:

```bash
cp .env.example .env
```

Then configure the following values:

```env
KUMA_URL=https://kuma.example.com
KUMA_USERNAME=your-username
KUMA_PASSWORD=your-password
BRIDGE_API_KEY=your-api-key
```

Generate a strong API key with:

```bash
openssl rand -hex 32
```

Do not commit your `.env` file or credentials to source control.

## Running with Docker Compose

Docker Compose is the recommended deployment method.

Build and start the service:

```bash
docker compose up -d --build
```

Then verify the connection:

```bash
curl \
  -H "Authorization: Bearer <your-api-key>" \
  http://localhost:3000/health
```

Once the wrapper has successfully authenticated with Uptime Kuma, the response should indicate:

```json
{
  "loggedIn": true
}
```

A `docker-compose.yml` file is included in the repository.

## Running Without Docker

Node.js 18 or newer is required.

Install dependencies:

```bash
npm install
```

Configure your environment variables, then start the server:

```bash
node server.js
```

For production deployments, you may want to run the process using a supervisor such as systemd, PM2, Supervisor, or your hosting platform's process manager.

## Creating Monitors

### HTTP Monitor

```bash
curl -X POST http://localhost:3000/monitors \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "http",
    "name": "example.com",
    "url": "https://example.com",
    "interval": 60
  }'
```

Example request body:

```json
{
  "type": "http",
  "name": "example.com",
  "url": "https://example.com",
  "interval": 60
}
```

### Ping Monitor

```json
{
  "type": "ping",
  "name": "server-01",
  "hostname": "203.0.113.10",
  "interval": 60
}
```

### Port Monitor

Port monitors are also supported using:

```json
{
  "type": "port",
  "name": "web-server-ssh",
  "hostname": "203.0.113.10",
  "port": 22,
  "interval": 60
}
```

## Using with n8n

This wrapper works well with n8n's HTTP Request node.

For example:

```text
Method: POST
URL: https://your-wrapper.example.com/monitors
Authentication: Header Auth
Header: Authorization
Value: Bearer <BRIDGE_API_KEY>
Content-Type: application/json
```

The request body can then be populated dynamically using values from your workflow.

## Compatibility

This project uses Uptime Kuma's Socket.IO interface, which is primarily intended for Uptime Kuma's own web UI.

Because this is not a formally versioned public API, future Uptime Kuma releases may change monitor fields, event names, or request formats.

If monitor creation begins failing after an Uptime Kuma upgrade, check the returned error first. Errors from Uptime Kuma are passed through where possible.

Monitor payloads are constructed in:

```text
buildMonitorBean()
```

inside `server.js`.

Compatibility fixes will usually involve updating that function to match the fields expected by the newer Uptime Kuma release.

## Security

This wrapper has the ability to create monitors in your Uptime Kuma instance, so it should be treated as an administrative service.

Recommended practices:

- Use a long, randomly generated `BRIDGE_API_KEY`
- Never expose the service publicly without authentication
- Run it behind HTTPS when accessed over a network
- Keep `.env` files out of source control
- Restrict access with a reverse proxy, firewall, VPN, or private network where possible
- Use dedicated Uptime Kuma credentials if your environment allows it

## Project Scope

The goal of this project is intentionally small.

It is not intended to replace Uptime Kuma's interface or expose every Socket.IO operation as REST.

The current focus is providing a simple API for common monitor automation tasks.

Additional endpoints may be added where they are useful without turning the project into a full reimplementation of Uptime Kuma's backend API.

## Disclaimer

This project is not affiliated with or maintained by the Uptime Kuma project.

It relies on internal behavior used by Uptime Kuma's web application, so compatibility cannot be guaranteed across all Uptime Kuma versions.

## License

See the repository's `LICENSE` file for license information.
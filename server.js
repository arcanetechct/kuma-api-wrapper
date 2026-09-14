/**
 * kuma-ploi-bridge
 * -----------------
 * A tiny, deliberately minimal REST wrapper around Uptime Kuma's Socket.IO API.
 *
 * WHY THIS EXISTS
 * Uptime Kuma has no official REST API for creating/listing monitors (as of the
 * versions current in 2026) -- monitor management only happens over Socket.IO,
 * the same channel the Kuma web UI uses. This service logs into Kuma once (like
 * a browser tab would), keeps that connection alive, and exposes two small,
 * well-defined HTTP endpoints on top of it so n8n (or curl, or anything else)
 * can talk to Kuma with plain HTTP instead of speaking Socket.IO itself.
 *
 * ENDPOINTS
 *   GET  /health              -> { ok, connected, loggedIn }
 *   GET  /monitors             -> [{ id, name, type, url, hostname, port, ... }, ...]
 *   POST /monitors             -> create a monitor. See buildMonitorBean() below
 *                                  for exactly what fields are accepted.
 *
 * AUTH
 * Every request must include:  Authorization: Bearer <BRIDGE_API_KEY>
 * (BRIDGE_API_KEY is a secret you set below -- it protects this bridge itself,
 * completely separate from your Kuma login.)
 *
 * KNOWN RISK / WHY THIS IS WORTH READING BEFORE YOU FORGET ABOUT IT
 * The monitor field names below (url, hostname, accepted_statuscodes, etc.) come
 * from Uptime Kuma's own internal monitor model, which is NOT a stable, versioned
 * public API -- Kuma could rename or add required fields in a future release and
 * this bridge would need a small update to match. If POST /monitors starts
 * failing after a Kuma upgrade, the error message returned in the response body
 * is Kuma's own validation/error message (we pass it straight through) -- start
 * there.
 */

const express = require('express');
const { io } = require('socket.io-client');

const PORT = process.env.PORT || 3000;
const KUMA_URL = process.env.KUMA_URL; // e.g. https://status.arcanetechct.com
const KUMA_USERNAME = process.env.KUMA_USERNAME;
const KUMA_PASSWORD = process.env.KUMA_PASSWORD;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
// Optional: a notification ID (the numeric id Kuma assigns a notification
// profile, visible in Settings > Notifications > edit > URL, or via GET
// /notifications on this bridge once it lists them) to auto-attach to every
// monitor this bridge creates. Leave unset to create monitors with no
// notifications attached (you'd then attach one by hand in the Kuma UI).
const DEFAULT_NOTIFICATION_ID = process.env.KUMA_DEFAULT_NOTIFICATION_ID
  ? String(process.env.KUMA_DEFAULT_NOTIFICATION_ID)
  : null;

if (!KUMA_URL || !KUMA_USERNAME || !KUMA_PASSWORD || !BRIDGE_API_KEY) {
  console.error(
    'Missing required env vars. Need KUMA_URL, KUMA_USERNAME, KUMA_PASSWORD, BRIDGE_API_KEY.'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Socket.IO connection to Kuma
// ---------------------------------------------------------------------------

let loggedIn = false;
let monitorListCache = {}; // Kuma pushes this whole object after login and on every change

const socket = io(KUMA_URL, {
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionDelay: 2000,
});

function login() {
  loggedIn = false;
  socket.emit('login', { username: KUMA_USERNAME, password: KUMA_PASSWORD, token: '' }, (res) => {
    if (res && res.ok) {
      loggedIn = true;
      console.log('[kuma-ploi-bridge] Logged in to Kuma as', KUMA_USERNAME);
    } else {
      console.error('[kuma-ploi-bridge] Kuma login failed:', res && res.msg);
    }
  });
}

socket.on('connect', () => {
  console.log('[kuma-ploi-bridge] Connected to Kuma socket, logging in...');
  login();
});

socket.on('disconnect', (reason) => {
  loggedIn = false;
  console.warn('[kuma-ploi-bridge] Disconnected from Kuma:', reason);
});

socket.on('connect_error', (err) => {
  console.error('[kuma-ploi-bridge] Socket connect error:', err.message);
});

// Kuma pushes the full monitor list (keyed by id) after login, and again
// whenever a monitor is added/edited/deleted elsewhere (e.g. in the Kuma UI).
socket.on('monitorList', (list) => {
  monitorListCache = list || {};
});

// ---------------------------------------------------------------------------
// Monitor bean builder
// ---------------------------------------------------------------------------
// This mirrors the fields Uptime Kuma's own "Add Monitor" form sends. Only
// `type` and `name` are always required; the rest depends on `type`.
//
// Supported `type` values for this bridge: "http" and "ping".
// (Kuma also supports many more types -- tcp port check, dns, docker, etc. --
// but http and ping cover what the Ploi sync workflow needs. Extending this
// is a matter of adding another branch below.)

function buildMonitorBean(input) {
  const type = input.type;
  const base = {
    name: input.name,
    type,
    interval: input.interval || 60,
    retryInterval: input.retryInterval || input.interval || 60,
    resendInterval: 0,
    maxretries: input.maxretries != null ? input.maxretries : 3,
    upsideDown: false,
    notificationIDList: DEFAULT_NOTIFICATION_ID ? { [DEFAULT_NOTIFICATION_ID]: true } : {},
    description: input.description || null,
    tags: [],
  };

  if (type === 'http') {
    return Object.assign(base, {
      url: input.url,
      method: 'GET',
      ignoreTls: false,
      upsideDown: false,
      maxredirects: 10,
      accepted_statuscodes: input.accepted_statuscodes || ['200-299'],
      httpBodyEncoding: 'json',
      timeout: 48,
    });
  }

  if (type === 'ping') {
    return Object.assign(base, {
      hostname: input.hostname,
      packetSize: input.packetSize || 56,
    });
  }

  if (type === 'port') {
    return Object.assign(base, {
      hostname: input.hostname,
      port: input.port,
    });
  }

  throw new Error(`Unsupported monitor type "${type}". Supported: http, ping, port.`);
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token !== BRIDGE_API_KEY) {
    return res.status(401).json({ ok: false, error: 'Missing or invalid Authorization bearer token.' });
  }
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true, connected: socket.connected, loggedIn });
});

app.get('/monitors', (req, res) => {
  if (!loggedIn) {
    return res.status(503).json({ ok: false, error: 'Not logged in to Kuma yet. Check /health and container logs.' });
  }
  const monitors = Object.values(monitorListCache).map((m) => ({
    id: m.id,
    name: m.name,
    type: m.type,
    url: m.url || null,
    hostname: m.hostname || null,
    port: m.port || null,
    active: m.active !== undefined ? m.active : true,
  }));
  res.json(monitors);
});

app.post('/monitors', (req, res) => {
  if (!loggedIn) {
    return res.status(503).json({ ok: false, error: 'Not logged in to Kuma yet. Check /health and container logs.' });
  }

  let bean;
  try {
    bean = buildMonitorBean(req.body || {});
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }

  if (!bean.name) {
    return res.status(400).json({ ok: false, error: '"name" is required.' });
  }
  if (bean.type === 'http' && !bean.url) {
    return res.status(400).json({ ok: false, error: '"url" is required for type "http".' });
  }
  if ((bean.type === 'ping' || bean.type === 'port') && !bean.hostname) {
    return res.status(400).json({ ok: false, error: '"hostname" is required for type "' + bean.type + '".' });
  }

  // Kuma's "add" socket event is ack-based: it calls the callback we pass with
  // { ok, msg, monitorID }. There's no separate HTTP timeout config here on
  // purpose -- if Kuma never acks, the request just hangs, which is a much
  // more honest failure mode than guessing a timeout value.
  socket.emit('add', bean, (result) => {
    if (result && result.ok) {
      res.json({ ok: true, monitorID: result.monitorID, msg: result.msg });
    } else {
      res.status(422).json({ ok: false, error: (result && result.msg) || 'Kuma rejected the monitor (no message given).' });
    }
  });
});

app.listen(PORT, () => {
  console.log(`[kuma-ploi-bridge] Listening on :${PORT}`);
});

/**
 * kuma-ploi-bridge
 * -----------------
 * A tiny, deliberately minimal REST wrapper around Uptime Kuma's Socket.IO API.
 *
 * WHY THIS EXISTS
 * Uptime Kuma has no official REST API for creating/listing monitors (as of the
 * versions current in 2026) -- monitor management only happens over Socket.IO,
 * the same channel the Kuma web UI uses. This service logs into Kuma once (like
 * a browser tab would), keeps that connection alive, and exposes small,
 * well-defined HTTP endpoints on top of it so n8n (or curl, or anything else)
 * can talk to Kuma with plain HTTP instead of speaking Socket.IO itself.
 *
 * ENDPOINTS
 *   GET    /health                       -> { ok, connected, loggedIn }
 *   GET    /monitors                      -> [{ id, name, type, url, hostname, port,
 *                                              parent, tags, ... }, ...]
 *   POST   /monitors                      -> create a monitor. See buildMonitorBean()
 *                                             below for exactly what fields are
 *                                             accepted, including "group" (a Kuma
 *                                             Monitor Group) and "parent" (the id of
 *                                             a group monitor to nest this one under).
 *   DELETE /monitors/:id                  -> delete a monitor. Optional query/body
 *                                             flag deleteChildren=true also deletes
 *                                             every monitor nested under it (only
 *                                             meaningful for a "group" monitor).
 *   PATCH  /monitors/:id                  -> update one or more fields on an
 *                                             EXISTING monitor (e.g. { "parent": 90 }
 *                                             to move it into a group, or
 *                                             { "parent": null } to un-nest it).
 *                                             Kuma's underlying "editMonitor" socket
 *                                             event does NOT merge -- it assigns
 *                                             every field it knows about straight
 *                                             onto the DB row, so a partial payload
 *                                             sent directly would silently null out
 *                                             everything you didn't include
 *                                             (retryInterval, notificationIDList,
 *                                             etc). This endpoint protects against
 *                                             that: it fetches the monitor's full
 *                                             current state via "getMonitor" first,
 *                                             layers your requested fields on top,
 *                                             then sends the complete object back
 *                                             through "editMonitor".
 *   GET    /tags                          -> [{ id, name, color }, ...]
 *   POST   /tags                          -> create a tag. Body: { name, color }.
 *                                             color is a hex string; defaults to
 *                                             Kuma's teal (#00A5C0) if omitted.
 *   POST   /monitors/:id/tags             -> attach an existing tag to a monitor.
 *                                             Body: { tagID, value }. value is
 *                                             optional free text Kuma stores
 *                                             alongside the tag on that monitor.
 *   DELETE /monitors/:id/tags/:tagID      -> detach a tag from a monitor. Optional
 *                                             query/body "value" narrows which
 *                                             tag+value pairing to remove.
 *
 * A NOTE ON THE MONITOR CACHE (read this before debugging "monitor already exists"
 * or "duplicate monitor" bugs)
 * Kuma pushes its monitor list over two different, unrelated socket events:
 *   - "monitorList": a full snapshot, sent ONLY once, right when a socket logs in.
 *   - "updateMonitorIntoList": a one-monitor delta, sent every time a monitor is
 *     added or edited afterward.
 * This bridge listens for both and merges deltas into the same in-memory cache.
 * Miss either listener and the cache silently goes stale the moment anything
 * changes after login -- which is exactly what caused duplicate monitors to keep
 * getting created before "updateMonitorIntoList" was added here.
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
let monitorListCache = {}; // populated by 'monitorList' at login, kept live by 'updateMonitorIntoList' after that

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

// Kuma pushes the full monitor list (keyed by id) once, right after login.
socket.on('monitorList', (list) => {
  monitorListCache = list || {};
});

// Every add/edit AFTER that initial login comes through as a one-monitor delta
// on this separate event instead -- merge it in, or the cache goes stale the
// moment anything changes (this was the root cause of the duplicate-monitor
// bug: dedup was silently comparing against a cache frozen at login time).
socket.on('updateMonitorIntoList', (list) => {
  Object.assign(monitorListCache, list || {});
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
    // Newer Kuma versions run validation/derivation logic that calls
    // `.every()` (and similar array methods) directly on `conditions` --
    // omitting the field entirely causes "Cannot read properties of
    // undefined (reading 'every')". Kuma expects the field to exist even
    // when there are no conditions configured.
    conditions: [],
    // Kuma's "add" handler unconditionally runs
    // `monitor.accepted_statuscodes.every(...)` regardless of monitor type
    // -- even for ping/port monitors where it's meaningless. Must be
    // present on every bean or this throws "Cannot read properties of
    // undefined (reading 'every')". The http branch below overrides this
    // with the real value.
    accepted_statuscodes: [],
  };

  // Nest this monitor under a Kuma Monitor Group (a monitor with type "group").
  // Optional -- omit entirely to leave a monitor at the top level. Kuma's own
  // "add" handler copies whatever fields are on the object straight onto the
  // bean (bean.import(monitor)), so unlike accepted_statuscodes/conditions
  // above, it's fine to leave this out rather than always setting it -- there's
  // no unconditional validation elsewhere that requires it to exist.
  if (input.parent !== undefined && input.parent !== null) {
    base.parent = input.parent;
  }

  if (type === 'group') {
    // A Monitor Group is just a name and a type -- it exists purely as a
    // container other monitors nest under via their own "parent" field. No
    // url/hostname/port of its own.
    return base;
  }

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

  throw new Error(`Unsupported monitor type "${type}". Supported: http, ping, port, group.`);
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
    parent: m.parent != null ? m.parent : null,
    tags: Array.isArray(m.tags) ? m.tags : [],
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

app.delete('/monitors/:id', (req, res) => {
  if (!loggedIn) {
    return res.status(503).json({ ok: false, error: 'Not logged in to Kuma yet. Check /health and container logs.' });
  }

  const monitorID = Number(req.params.id);
  if (!Number.isInteger(monitorID)) {
    return res.status(400).json({ ok: false, error: '"id" must be a numeric monitor ID.' });
  }

  const deleteChildren =
    req.query.deleteChildren === 'true' || (req.body && req.body.deleteChildren === true);

  socket.emit('deleteMonitor', monitorID, deleteChildren, (result) => {
    if (result && result.ok) {
      res.json({ ok: true, msg: result.msg });
    } else {
      res.status(422).json({ ok: false, error: (result && result.msg) || 'Kuma rejected the delete (no message given).' });
    }
  });
});

app.patch('/monitors/:id', (req, res) => {
  if (!loggedIn) {
    return res.status(503).json({ ok: false, error: 'Not logged in to Kuma yet. Check /health and container logs.' });
  }

  const monitorID = Number(req.params.id);
  if (!Number.isInteger(monitorID)) {
    return res.status(400).json({ ok: false, error: '"id" must be a numeric monitor ID.' });
  }

  const patch = req.body || {};

  // "editMonitor" requires a COMPLETE monitor object -- see the header comment
  // above for why. Fetch the current full state first via "getMonitor", then
  // layer only the requested field(s) on top before sending the whole thing
  // back through "editMonitor".
  socket.emit('getMonitor', monitorID, (getResult) => {
    if (!getResult || !getResult.ok) {
      return res.status(404).json({ ok: false, error: (getResult && getResult.msg) || 'Monitor not found.' });
    }

    const merged = Object.assign({}, getResult.monitor, patch, { id: monitorID });

    socket.emit('editMonitor', merged, (editResult) => {
      if (editResult && editResult.ok) {
        res.json({ ok: true, monitorID: editResult.monitorID, msg: editResult.msg });
      } else {
        res.status(422).json({ ok: false, error: (editResult && editResult.msg) || 'Kuma rejected the edit (no message given).' });
      }
    });
  });
});

app.get('/tags', (req, res) => {
  if (!loggedIn) {
    return res.status(503).json({ ok: false, error: 'Not logged in to Kuma yet. Check /health and container logs.' });
  }

  socket.emit('getTags', (result) => {
    if (result && result.ok) {
      res.json(result.tags);
    } else {
      res.status(500).json({ ok: false, error: (result && result.msg) || 'Failed to fetch tags (no message given).' });
    }
  });
});

app.post('/tags', (req, res) => {
  if (!loggedIn) {
    return res.status(503).json({ ok: false, error: 'Not logged in to Kuma yet. Check /health and container logs.' });
  }

  const { name, color } = req.body || {};
  if (!name) {
    return res.status(400).json({ ok: false, error: '"name" is required.' });
  }

  socket.emit('addTag', { name, color: color || '#00A5C0' }, (result) => {
    if (result && result.ok) {
      res.json({ ok: true, tag: result.tag });
    } else {
      res.status(422).json({ ok: false, error: (result && result.msg) || 'Kuma rejected the tag (no message given).' });
    }
  });
});

app.post('/monitors/:id/tags', (req, res) => {
  if (!loggedIn) {
    return res.status(503).json({ ok: false, error: 'Not logged in to Kuma yet. Check /health and container logs.' });
  }

  const monitorID = Number(req.params.id);
  if (!Number.isInteger(monitorID)) {
    return res.status(400).json({ ok: false, error: '"id" must be a numeric monitor ID.' });
  }

  const { tagID, value } = req.body || {};
  if (!tagID) {
    return res.status(400).json({ ok: false, error: '"tagID" is required.' });
  }

  socket.emit('addMonitorTag', tagID, monitorID, value != null ? value : '', (result) => {
    if (result && result.ok) {
      res.json({ ok: true, msg: result.msg });
    } else {
      res.status(422).json({ ok: false, error: (result && result.msg) || 'Kuma rejected attaching the tag (no message given).' });
    }
  });
});

app.delete('/monitors/:id/tags/:tagID', (req, res) => {
  if (!loggedIn) {
    return res.status(503).json({ ok: false, error: 'Not logged in to Kuma yet. Check /health and container logs.' });
  }

  const monitorID = Number(req.params.id);
  const tagID = Number(req.params.tagID);
  if (!Number.isInteger(monitorID) || !Number.isInteger(tagID)) {
    return res.status(400).json({ ok: false, error: '"id" and "tagID" must both be numeric.' });
  }

  const value = (req.body && req.body.value) || (req.query && req.query.value) || '';

  socket.emit('deleteMonitorTag', tagID, monitorID, value, (result) => {
    if (result && result.ok) {
      res.json({ ok: true, msg: result.msg });
    } else {
      res.status(422).json({ ok: false, error: (result && result.msg) || 'Kuma rejected removing the tag (no message given).' });
    }
  });
});

app.listen(PORT, () => {
  console.log(`[kuma-ploi-bridge] Listening on :${PORT}`);
});

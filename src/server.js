/**
 * Servidor del dashboard.
 *
 *   navegador  <--WebSocket-->  este servidor  <--MQTT TLS-->  Bambu Cloud
 *                                     ^
 *                                     |  POST /api/camera (opcional)
 *                               agente local en tu red
 *
 * Corre en un VPS. La impresora nunca tiene que ser accesible desde internet:
 * es ella la que publica en la nube de Bambu, y nosotros solo escuchamos.
 */

import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';

import { BambuCloud } from './bambu-cloud.js';
import { normalize } from './normalize.js';
import { Notifier } from './notifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const DASH_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';

// ---------------------------------------------------------------------------
// Estado global del proceso
// ---------------------------------------------------------------------------

const notifier = new Notifier({
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  discordWebhook: process.env.DISCORD_WEBHOOK,
  genericWebhook: process.env.GENERIC_WEBHOOK,
  progressStep: Number(process.env.NOTIFY_PROGRESS_STEP || 0),
});

const app_state = {
  cloud: null,
  printer: null, // { serial, name, model }
  status: { connected: false, detail: 'Sin iniciar' },
  normalized: null,
  currentTask: null, // portada + titulo desde /my/tasks
  camera: null, // { jpegBase64, at } enviado por el agente local
  loginPending: null, // 'emailCode' | 'tfa' | null
};

// ---------------------------------------------------------------------------
// Broadcast a los navegadores conectados
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function snapshot() {
  return {
    status: app_state.status,
    printer: app_state.printer,
    state: app_state.normalized,
    task: app_state.currentTask,
    camera: app_state.camera ? { at: app_state.camera.at } : null,
    notifications: notifier.history.slice(0, 20),
    loginPending: app_state.loginPending,
    connected: Boolean(app_state.cloud?.connected),
  };
}

// ---------------------------------------------------------------------------
// Arranque de la conexion con Bambu Cloud
// ---------------------------------------------------------------------------

function wireCloud(cloud) {
  cloud.on('status', (s) => {
    app_state.status = s;
    broadcast('status', s);
  });

  cloud.on('report', (_msg, state) => {
    if (!state.print) return;
    const norm = normalize(state);
    app_state.normalized = norm;
    notifier.update(norm, app_state.printer?.name || 'Bambu Lab A1');
    broadcast('state', norm);
  });

  cloud.on('error', (err) => {
    app_state.status = { connected: false, detail: `Error: ${err.message}` };
    broadcast('status', app_state.status);
    console.error('[cloud]', err.message);
  });

  cloud.on('auth-expired', async () => {
    console.warn('[cloud] token caducado, reintentando login');
    cloud.disconnect();
    const res = await cloud.login();
    if (res.ok) cloud.connect();
  });
}

notifier.on('notification', (event) => broadcast('notification', event));
notifier.on('error', (err) => console.error('[notify]', err.message));

async function startCloud() {
  const cloud = new BambuCloud({
    email: process.env.BAMBU_EMAIL,
    password: process.env.BAMBU_PASSWORD,
    region: process.env.BAMBU_REGION || 'global',
    accessToken: process.env.BAMBU_TOKEN || null,
    serial: process.env.PRINTER_SERIAL || null,
  });
  app_state.cloud = cloud;
  wireCloud(cloud);

  if (!cloud.accessToken) {
    const res = await cloud.login();
    if (!res.ok) {
      if (res.needs) {
        app_state.loginPending = res.needs;
        app_state.status = {
          connected: false,
          detail:
            res.needs === 'emailCode'
              ? 'Bambu envio un codigo a tu email. Introducelo en el dashboard.'
              : 'Introduce tu codigo 2FA en el dashboard.',
        };
        broadcast('status', app_state.status);
        return;
      }
      app_state.status = { connected: false, detail: res.error };
      console.error('[cloud] login fallido:', res.error);
      return;
    }
  } else {
    cloud._setToken(cloud.accessToken);
  }

  await finishStartup(cloud);
}

async function finishStartup(cloud) {
  app_state.loginPending = null;

  const devices = await cloud.listDevices();
  if (devices.length === 0) {
    app_state.status = { connected: false, detail: 'La cuenta no tiene impresoras vinculadas' };
    broadcast('status', app_state.status);
    return;
  }

  const chosen = cloud.serial
    ? devices.find((d) => d.serial === cloud.serial) || devices[0]
    : devices[0];
  cloud.serial = chosen.serial;
  app_state.printer = { serial: chosen.serial, name: chosen.name, model: chosen.model };
  broadcast('printer', app_state.printer);

  cloud.connect();
  refreshTask();
  setInterval(refreshTask, 60_000);
}

/** La portada del print vive en la API REST, no en MQTT. */
async function refreshTask() {
  const cloud = app_state.cloud;
  if (!cloud?.accessToken) return;
  try {
    const tasks = await cloud.listTasks();
    const mine = tasks.find((t) => t.deviceSerial === cloud.serial) || tasks[0] || null;
    if (mine && mine.id !== app_state.currentTask?.id) {
      app_state.currentTask = mine;
      broadcast('task', mine);
    } else if (mine) {
      app_state.currentTask = mine;
    }
  } catch (err) {
    console.error('[tasks]', err.message);
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production' && process.env.TRUST_HTTPS !== 'false',
    },
  }),
);

function requireAuth(req, res, next) {
  if (!DASH_PASSWORD) return next(); // sin password configurado = abierto
  if (req.session?.authed) return next();
  return res.status(401).json({ error: 'No autorizado' });
}

app.post('/api/login', (req, res) => {
  if (!DASH_PASSWORD) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  const given = String(req.body?.password || '');
  const a = Buffer.from(given.padEnd(64).slice(0, 64));
  const b = Buffer.from(DASH_PASSWORD.padEnd(64).slice(0, 64));
  if (crypto.timingSafeEqual(a, b) && given.length === DASH_PASSWORD.length) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Password incorrecta' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ authed: Boolean(!DASH_PASSWORD || req.session?.authed) });
});

app.get('/api/state', requireAuth, (req, res) => res.json(snapshot()));

app.get('/api/devices', requireAuth, async (req, res) => {
  try {
    res.json(await app_state.cloud.listDevices());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Cambia de impresora sin reiniciar el proceso. */
app.post('/api/printer', requireAuth, async (req, res) => {
  const serial = String(req.body?.serial || '');
  const cloud = app_state.cloud;
  if (!cloud) return res.status(400).json({ error: 'Cloud no iniciado' });
  const device = cloud.devices.find((d) => d.serial === serial);
  if (!device) return res.status(404).json({ error: 'Impresora no encontrada' });
  cloud.disconnect();
  cloud.serial = serial;
  cloud.state = {};
  app_state.printer = { serial, name: device.name, model: device.model };
  app_state.normalized = null;
  cloud.connect();
  broadcast('printer', app_state.printer);
  res.json({ ok: true });
});

/** Completa el login cuando Bambu pidio codigo de email o 2FA. */
app.post('/api/login-code', requireAuth, async (req, res) => {
  const cloud = app_state.cloud;
  const code = String(req.body?.code || '');
  if (!cloud || !app_state.loginPending) {
    return res.status(400).json({ error: 'No hay un login pendiente' });
  }
  const result =
    app_state.loginPending === 'tfa'
      ? await cloud.loginWithTfa(code)
      : await cloud.loginWithEmailCode(code);
  if (!result.ok) return res.status(401).json({ error: result.error });
  await finishStartup(cloud);
  res.json({ ok: true });
});

app.post('/api/resync', requireAuth, (req, res) => {
  app_state.cloud?.requestSync();
  refreshTask();
  res.json({ ok: true });
});

// --- Camara: el agente local sube snapshots aqui ---

app.post('/api/camera', (req, res) => {
  if (AGENT_TOKEN && req.get('x-agent-token') !== AGENT_TOKEN) {
    return res.status(401).json({ error: 'Token de agente invalido' });
  }
  const jpegBase64 = req.body?.image;
  if (typeof jpegBase64 !== 'string' || jpegBase64.length < 100) {
    return res.status(400).json({ error: 'Imagen ausente o invalida' });
  }
  app_state.camera = { jpegBase64, at: Date.now() };
  broadcast('camera', { at: app_state.camera.at });
  res.json({ ok: true });
});

app.get('/api/camera.jpg', requireAuth, (req, res) => {
  if (!app_state.camera) return res.status(404).end();
  const buf = Buffer.from(app_state.camera.jpegBase64, 'base64');
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  res.send(buf);
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    cloudConnected: Boolean(app_state.cloud?.connected),
    lastMessageAt: app_state.cloud?.lastMessageAt || null,
    cameraAgeMs: app_state.camera ? Date.now() - app_state.camera.at : null,
    uptimeSec: Math.round(process.uptime()),
  });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'snapshot', payload: snapshot() }));
  const ping = setInterval(() => ws.readyState === 1 && ws.ping(), 30_000);
  ws.on('close', () => clearInterval(ping));
});

server.listen(PORT, () => {
  console.log(`Dashboard escuchando en http://localhost:${PORT}`);
  startCloud().catch((err) => console.error('[startup]', err));
});

process.on('SIGTERM', () => {
  app_state.cloud?.disconnect();
  server.close(() => process.exit(0));
});

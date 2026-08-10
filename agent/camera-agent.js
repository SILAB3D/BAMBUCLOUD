/**
 * Agente local de camara.
 *
 * PARA QUE SIRVE
 * --------------
 * Bambu Cloud NO expone la camara. Lo unico visual que da la nube es la
 * imagen de portada del modelo. Para ver la camara real de la A1 hace falta
 * hablar con la impresora en tu propia red.
 *
 * Este script corre en cualquier cacharro de tu casa (PC, Raspberry Pi, NAS,
 * un contenedor en Docker), saca un snapshot JPEG de la A1 y lo sube al
 * dashboard del VPS. Asi ves la camara desde fuera sin abrir ni un puerto
 * de tu router.
 *
 * PROTOCOLO
 * ---------
 * La A1 / A1 Mini / P1P / P1S exponen un servidor TLS en el puerto 6000.
 * Tras el handshake se envia un paquete de auth de 80 bytes:
 *
 *   offset  0 : uint32 LE = 0x40
 *   offset  4 : uint32 LE = 0x3000
 *   offset  8 : uint32 LE = 0
 *   offset 12 : uint32 LE = 0
 *   offset 16 : usuario "bblp"       (32 bytes, resto a cero)
 *   offset 48 : access code          (32 bytes, resto a cero)
 *
 * Despues la impresora envia frames JPEG completos precedidos de una
 * cabecera de 16 bytes cuyo primer uint32 LE es el tamano del payload.
 *
 * Los modelos mas nuevos (P2S, H2, X1) solo dan RTSP; este agente no les sirve.
 */

import 'dotenv/config';
import tls from 'node:tls';

const PRINTER_IP = process.env.PRINTER_IP;
const ACCESS_CODE = process.env.PRINTER_ACCESS_CODE;
const CAMERA_USER = process.env.PRINTER_CAMERA_USER || 'bblp';
const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'http://localhost:3000').replace(/\/$/, '');
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const INTERVAL_MS = Number(process.env.CAMERA_INTERVAL_MS || 10_000);
const CAMERA_PORT = 6000;

if (!PRINTER_IP || !ACCESS_CODE) {
  console.error('Faltan PRINTER_IP o PRINTER_ACCESS_CODE en el .env');
  process.exit(1);
}

function buildAuthPacket() {
  const packet = Buffer.alloc(80);
  packet.writeUInt32LE(0x40, 0);
  packet.writeUInt32LE(0x3000, 4);
  packet.writeUInt32LE(0, 8);
  packet.writeUInt32LE(0, 12);
  packet.write(CAMERA_USER.slice(0, 32), 16, 'ascii');
  packet.write(ACCESS_CODE.slice(0, 32), 48, 'ascii');
  return packet;
}

/** Abre la conexion, espera un frame JPEG completo y cierra. */
function grabFrame(timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* ignorado */
      }
      err ? reject(err) : resolve(data);
    };

    const timer = setTimeout(() => finish(new Error('Timeout esperando frame')), timeoutMs);

    const socket = tls.connect(
      {
        host: PRINTER_IP,
        port: CAMERA_PORT,
        // La impresora usa un certificado autofirmado; no hay CA que validar
        // en la LAN. La conexion sigue cifrada.
        rejectUnauthorized: false,
      },
      () => socket.write(buildAuthPacket()),
    );

    let buffer = Buffer.alloc(0);
    let expected = null;

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Leer cabecera de 16 bytes
      if (expected === null) {
        if (buffer.length < 16) return;
        expected = buffer.readUInt32LE(0);
        if (expected <= 0 || expected > 8 * 1024 * 1024) {
          return finish(new Error(`Tamano de frame absurdo: ${expected}`));
        }
        buffer = buffer.subarray(16);
      }

      if (buffer.length >= expected) {
        const jpeg = buffer.subarray(0, expected);
        // Sanidad: todo JPEG empieza por FFD8 y acaba en FFD9
        if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
          return finish(new Error('El frame no parece un JPEG'));
        }
        finish(null, jpeg);
      }
    });

    socket.on('error', (err) => finish(err));
    socket.on('close', () => finish(new Error('Conexion cerrada sin frame completo')));
  });
}

async function upload(jpeg) {
  const res = await fetch(`${DASHBOARD_URL}/api/camera`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(AGENT_TOKEN ? { 'x-agent-token': AGENT_TOKEN } : {}),
    },
    body: JSON.stringify({ image: jpeg.toString('base64') }),
  });
  if (!res.ok) throw new Error(`Subida rechazada: HTTP ${res.status}`);
}

let consecutiveErrors = 0;

async function tick() {
  try {
    const jpeg = await grabFrame();
    await upload(jpeg);
    if (consecutiveErrors > 0) console.log('Camara recuperada');
    consecutiveErrors = 0;
    process.stdout.write(`\rSnapshot subido (${(jpeg.length / 1024).toFixed(0)} KB) ${new Date().toLocaleTimeString()}   `);
  } catch (err) {
    consecutiveErrors += 1;
    // Backoff silencioso: los errores repetidos no llenan el log
    if (consecutiveErrors <= 3 || consecutiveErrors % 10 === 0) {
      console.error(`\n[camara] ${err.message} (fallo #${consecutiveErrors})`);
    }
  }
}

console.log(`Agente de camara -> ${PRINTER_IP}:${CAMERA_PORT}, subiendo a ${DASHBOARD_URL}`);
console.log(`Intervalo: ${INTERVAL_MS} ms. Ctrl+C para parar.`);
tick();
setInterval(tick, INTERVAL_MS);

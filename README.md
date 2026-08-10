# Bambu A1 Cloud Dashboard

Dashboard web para monitorizar una Bambu Lab A1 desde cualquier lugar, a través de Bambu Cloud.

Corre en un servidor en la nube. **No hace falta abrir ningún puerto de tu router**: la impresora publica su estado en la nube de Bambu y este dashboard simplemente escucha.

Basado en el protocolo que implementa [PrintSphere](https://github.com/cptkirki/PrintSphere) en `bambu_cloud_client.cpp` y `printer_client.cpp`.

---

## Qué hace

- **Estado en vivo** vía MQTT: progreso, capa actual, temperaturas, tiempo restante, ETA, etapa, velocidad, filamento AMS/externo, errores HMS
- **Notificaciones**: fin de impresión, fallo, pausa, atención requerida, errores HMS nuevos e hitos de progreso — por Telegram, Discord, webhook genérico y notificaciones del navegador
- **Cámara**: snapshots reales de la A1 mediante un agente ligero que corre en tu red (ver más abajo)
- **Portada del modelo** desde la API de tareas de Bambu

---

## Arquitectura

```
  Bambu Lab A1 ──MQTT──► Bambu Cloud ──MQTT TLS──► servidor (VPS) ──WebSocket──► navegador
                                                        ▲
                                                        │ POST /api/camera
                                             agente local (opcional, tu red)
                                                        ▲
                                                        │ TCP 6000 + TLS
                                                  Bambu Lab A1
```

**La cámara nunca viaja por Bambu Cloud.** La nube solo expone datos de estado y la imagen de portada del modelo. Para ver la cámara real hay que hablar con la impresora en tu LAN — de ahí el agente. Es la misma limitación que documenta PrintSphere.

---

## Puesta en marcha

### 1. Servidor (VPS)

```bash
git clone <tu-repo> && cd BAMBUCLOUD
npm install
cp .env.example .env
```

Edita `.env` con tu email y contraseña de Bambu, una `DASHBOARD_PASSWORD` y un `SESSION_SECRET`:

```bash
openssl rand -hex 32   # para SESSION_SECRET
openssl rand -hex 24   # para AGENT_TOKEN
```

Arranca:

```bash
npm start          # o: docker compose up -d
```

Abre `http://tu-servidor:3000`.

**Primer arranque**: si tu cuenta tiene verificación por email o 2FA, el dashboard te pedirá el código en pantalla. Introdúcelo y sigue.

Pon un reverse proxy con HTTPS delante (Caddy es lo más corto):

```
tu-dominio.com {
    reverse_proxy localhost:3000
}
```

### 2. Agente de cámara (opcional, en tu red)

En la impresora: *Settings → Network* → apunta la **IP** y el **Access Code**.

En un PC, Raspberry Pi o NAS de tu red:

```bash
cd BAMBUCLOUD
cp .env.example .env    # rellena PRINTER_IP, PRINTER_ACCESS_CODE,
                        # DASHBOARD_URL y el mismo AGENT_TOKEN del VPS
npm run agent
```

Para que arranque solo, con systemd:

```ini
# /etc/systemd/system/bambu-camera.service
[Unit]
Description=Bambu camera agent
After=network-online.target

[Service]
WorkingDirectory=/opt/bambucloud
ExecStart=/usr/bin/node agent/camera-agent.js
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
```

---

## Notificaciones

Rellena en `.env` los canales que quieras — puedes usar varios a la vez.

| Canal | Qué necesitas |
|---|---|
| Telegram | `TELEGRAM_BOT_TOKEN` de [@BotFather](https://t.me/BotFather) y `TELEGRAM_CHAT_ID` de [@userinfobot](https://t.me/userinfobot) |
| Discord | `DISCORD_WEBHOOK` desde Ajustes del canal → Integraciones → Webhooks |
| Webhook | `GENERIC_WEBHOOK`: recibe un POST JSON con `{ text, type, level, ... }` |
| Navegador | Botón «Activar avisos» en el dashboard |

`NOTIFY_PROGRESS_STEP=25` añade avisos al 25 %, 50 % y 75 %. `0` los desactiva.

---

## Protocolo (referencia)

### Bambu Cloud

```
API      https://api.bambulab.com          (.cn para China)
login    POST /v1/user-service/user/login   → accessToken (JWT)
                                            → loginType "verifyCode" = código por email
2FA      POST https://bambulab.com/api/sign-in/tfa  → token en cookie
código   POST /v1/user-service/user/sendemail/code
equipos  GET  /v1/iot-service/api/user/bind
tareas   GET  /v1/user-service/my/tasks?limit=10    → portada del job

MQTT     mqtts://us.mqtt.bambulab.com:8883   (cn.mqtt… para China)
usuario  u_<uid>        ← sale del payload del JWT
password <accessToken>
sub      device/<SERIAL>/report
pub      device/<SERIAL>/request
```

### LAN (lo que usa el agente de cámara)

```
MQTT     mqtts://<IP>:8883, usuario "bblp", password <access code>
cámara   TCP 6000 + TLS, paquete de auth de 80 bytes, luego frames JPEG
         con cabecera de 16 bytes (primer uint32 LE = tamaño)
```

Comandos útiles publicados en `device/<SERIAL>/request`:

```json
{"pushing":{"sequence_id":"0","command":"pushall"}}
{"info":{"sequence_id":"0","command":"get_version"}}
{"print":{"sequence_id":"0","command":"pause"}}
{"print":{"sequence_id":"0","command":"resume"}}
{"print":{"sequence_id":"0","command":"stop"}}
{"system":{"sequence_id":"0","command":"ledctrl","led_node":"chamber_light","led_mode":"on"}}
```

> El control (pausar/reanudar/parar) no está expuesto en la UI a propósito: es fácil de añadir, pero un botón de «parar» accesible desde internet merece su propia confirmación. La capa MQTT ya lo soporta vía `cloud.publish(...)`.

---

## Estructura

```
src/bambu-cloud.js    login, listado de equipos, MQTT, reconexión, refresh de token
src/normalize.js      report crudo → objeto limpio (estados, etapas, AMS, HMS)
src/notifier.js       detección de transiciones + envío a Telegram/Discord/webhook
src/server.js         Express + WebSocket + endpoint de cámara
public/index.html     dashboard (sin build, un solo archivo)
agent/camera-agent.js agente de cámara para la LAN
```

---

## Endpoints

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/state` | Snapshot completo |
| GET | `/api/devices` | Impresoras de la cuenta |
| POST | `/api/printer` | Cambiar de impresora (`{ serial }`) |
| POST | `/api/login-code` | Código de email o 2FA (`{ code }`) |
| POST | `/api/resync` | Forzar `pushall` |
| POST | `/api/camera` | El agente sube un JPEG (`{ image: base64 }`) |
| GET | `/api/camera.jpg` | Último snapshot |
| GET | `/api/health` | Healthcheck |
| WS | `/ws` | Estado en vivo |

---

## Notas y limitaciones

- La API de Bambu Cloud **no es pública**. Funciona hoy; Bambu puede cambiarla sin aviso.
- El `accessToken` caduca. El servidor detecta el rechazo MQTT (`Not authorized`) y rehace el login solo.
- Tus credenciales viven en el `.env` del servidor. Si el VPS es compartido, considera usar `BAMBU_TOKEN` en lugar de la contraseña.
- Un `pushall` cada 60 s mantiene el estado fresco; abusar de esa frecuencia puede hacer que la nube te limite.
- La cámara por snapshots (puerto 6000) solo existe en **A1, A1 Mini, P1P y P1S**. Los modelos nuevos solo dan RTSP.
- Si prefieres no montar el agente: [Tailscale](https://tailscale.com) en tu red y en el VPS te deja llegar a la impresora directamente, y entonces puedes usar la ruta LAN completa (MQTT local incluido).

## Licencia

MIT

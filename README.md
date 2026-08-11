# Bambu A1 Cloud Dashboard

Dashboard web para monitorizar una Bambu Lab A1 desde cualquier lugar, a través de Bambu Cloud.

Corre en un servidor en la nube. **No hace falta abrir ningún puerto de tu router**: la impresora publica su estado en la nube de Bambu y este dashboard simplemente escucha.

Basado en el protocolo que implementa [PrintSphere](https://github.com/cptkirki/PrintSphere) en `bambu_cloud_client.cpp` y `printer_client.cpp`.

---

## Qué hace

- **Estado en vivo** vía MQTT: progreso, capa actual, temperaturas, tiempo restante, ETA, etapa, velocidad, filamento AMS/externo, errores HMS
- **Ciclo completo de la impresión**: no acaba en «terminada». El panel de estado pasa por
  tres fases —**impresión → enfriamiento (15 min) → lista para retirar**— y avisa en cada
  salto. La fase de retirada se cierra con un botón «Ya la he retirado».
- **Notificaciones push al móvil (Web Push)**: llegan con la PWA cerrada. Configurables desde
  el panel de administración. También por Telegram, Discord y webhook genérico.
- **Instalable como app (PWA)**: «Añadir a pantalla de inicio» en Android/iOS.
- **Actividad de 15 días** persistida en disco, con scroll y separadores por día
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

Edita `.env` con tu email y contraseña de Bambu y una `DASHBOARD_PASSWORD`:

```bash
openssl rand -hex 32   # para SESSION_SECRET (opcional)
openssl rand -hex 24   # para AGENT_TOKEN
```

`SESSION_SECRET` es opcional: si no lo pones, el servidor genera uno la primera
vez y lo guarda junto al resto del estado, así que las sesiones siguen valiendo
tras un reinicio igualmente.

Arranca:

```bash
npm start          # o: docker compose up -d
```

Abre `http://tu-servidor:3000`.

**Primer arranque**: si tu cuenta tiene verificación por email o 2FA, el dashboard te pedirá el código en pantalla. Introdúcelo y sigue.

Solo hace falta **una vez**: el `accessToken` se guarda en `.bambu-token.json` (gitignored, permisos 600) y los reinicios siguientes lo reutilizan. Si Bambu lo rechaza, el servidor lo borra y vuelve a pedirte código en el dashboard. Para forzar un login nuevo, borra ese fichero.

Pon un reverse proxy con HTTPS delante (Caddy es lo más corto):

```
tu-dominio.com {
    reverse_proxy localhost:3000
}
```

### 1b. Alternativa gratuita: Render

`render.yaml` despliega el dashboard en el plan gratuito de Render (sin tarjeta):
*New → Blueprint* → elige este repo. Render pedirá `BAMBU_EMAIL`, `BAMBU_TOKEN` y
`DASHBOARD_PASSWORD`.

El token sale de tu instalación local, tras haber hecho el login una vez:

```bash
node -e "console.log(require('./.bambu-token.json').token)"
```

Límites del plan gratuito que conviene tener presentes:

- **Se duerme tras 15 min sin visitas.** El primer acceso tarda ~1 min en despertar y,
  mientras duerme, no hay conexión MQTT: no se envían notificaciones. El keep-alive lo
  mantiene despierto mientras imprime y mientras enfría, que es cuando importa.
- **No hay disco persistente.** Por eso el token va en `BAMBU_TOKEN` en vez de en
  fichero. Si algún día Bambu lo rechaza, actualiza esa variable con uno nuevo.
  Esto afecta también al **historial de actividad, los ajustes de avisos y las
  suscripciones push**: cada reinicio los borra. El navegador se resuscribe solo cada vez
  que alguien abre el dashboard, así que en la práctica se recupera al primer acceso —
  pero si el servicio se reinicia mientras nadie mira, los avisos de esa impresión no
  llegarán.
- Las sesiones se guardan en ese mismo estado, así que sin disco también se pierden:
  cada vez que el servicio despierta hay que volver a introducir `DASHBOARD_PASSWORD`.
  Con disco, la sesión dura hasta que pulses *Salir del dashboard*.

**Si quieres que nada de esto se pierda**: plan `starter` (7 $/mes) y descomenta el bloque
`disk` de `render.yaml` (montado en `/data`). Con disco, historial, ajustes, suscripciones y
token sobreviven a cualquier reinicio, y el servicio deja de dormirse.

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

## El ciclo de la impresión

La impresora dice `FINISH` y ahí se calla. Pero para quien tiene que ir a recoger la pieza
quedan dos etapas más, y son las que representa el panel de estado:

| Fase | Cuándo | Qué muestra el panel |
|---|---|---|
| **Impresión** | `RUNNING` / `PREPARE` / `PAUSE` | % de impresión, restante, hora de fin, capas |
| **Enfriamiento** | 15 min desde `FINISH` | % de enfriamiento, cuenta atrás, hora a la que estará lista, temperatura de la cama |
| **Retirar** | al vencer el enfriamiento | anillo completo, horas de fin y enfriado, botón «Ya la he retirado» |

El salto a «lista para retirar» lo dispara un **temporizador del servidor**, no un mensaje
MQTT: la impresora no vuelve a hablar después de terminar. Por eso el keep-alive sigue
activo durante el enfriamiento (`COOLDOWN_KEEPALIVE_MS`, 15 min por defecto), con el último
ping justo al vencer el plazo — si el servicio se durmiera, el aviso no saldría.

La duración se cambia con `COOLDOWN_MS` (por defecto 900000 = 15 min). La fase se guarda en
disco, así que un reinicio a mitad del enfriamiento lo retoma donde estaba.

---

## Notificaciones

### Push al móvil (Web Push)

Es lo que hace que el aviso de «ya puedes retirarla» llegue **con la app cerrada**. Necesita
HTTPS y un par de claves VAPID, que se generan una sola vez:

```bash
npm run vapid
```

Pon el par en `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`. **No las cambies después**: si lo
haces, todos los móviles ya suscritos dejan de recibir avisos sin previo aviso.

Luego, en el dashboard: pulsa la **campana** para conceder el permiso en ese dispositivo. Se
hace una vez por móvil.

> **En iPhone/iPad**, Safari solo permite push si la web está **añadida a la pantalla de
> inicio**. Desde una pestaña normal el botón no hará nada. En Android funciona en ambos casos.

### Panel de administración

Botón del engranaje, arriba a la derecha → código **1510** (cambiable con `ADMIN_CODE`).
El desbloqueo dura una hora: la sesión del dashboard no caduca, pero el panel sí.

- **Enviar notificaciones**: interruptor general de los avisos de la app.
- **Un interruptor por tipo de aviso**: impresión iniciada, terminada, enfriándose, lista para
  retirar, en pausa, reanudada, fallida, atención requerida, errores HMS e hitos de progreso.
  El catálogo se define en `TRIGGERS` (`src/notifier.js`) y la interfaz se genera desde ahí:
  añadir un tipo allí basta para que aparezca su interruptor.
  De serie solo vienen encendidos **enfriándose** y **lista para retirar**, que son los dos
  que ocurren cuando ya nadie mira la pantalla; el resto se enciende aquí. Una vez tocas
  cualquier interruptor, tu elección manda sobre estos valores por defecto.
- **Enviar aviso de prueba**: suscribe este dispositivo si hacía falta y manda un push real.
  Si algo falla, dice exactamente qué (permiso, claves del servidor, Service Worker…).
- **Cerrar sesión** de Bambu Lab: corta el MQTT y borra el token guardado. Para reconectar
  hará falta el código que Bambu envía por email.

Los ajustes se guardan en disco y valen para todos los dispositivos. Un aviso desactivado
sigue registrándose en el panel de actividad; lo que se corta es el envío.

### Si no llegan las notificaciones

El panel de administración diagnostica las tres capas por separado:

1. **Servidor**: si dice «sin claves VAPID», faltan `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`
   en las variables de entorno. Sin ellas no hay push, solo avisos con la web abierta.
2. **Este dispositivo**: si no aparece «suscrito ✓», el texto explica por qué (permiso no
   concedido, bloqueado en el navegador, en iPhone sin instalar la app…).
3. Los envíos y las altas quedan en el log del servidor (`[push] alta de dispositivo…`,
   `[push] prueba enviada a N dispositivo(s)`).

### Ventana de bienvenida

La primera vez explica cómo instalar la app y cómo permitir los avisos. Aparece como mucho
**3 veces y nunca dos veces el mismo día**. El recuento vive en `localStorage`, así que es
por dispositivo.

Con la app ya instalada no vuelve a salir sola, salvo que aún falten los permisos de aviso:
en ese caso se abre solo con ese apartado, que es lo único que queda por hacer.

Se puede abrir cuando se quiera desde **Administración → Ver guía de instalación**, sin
importar cuántas veces se haya visto ni si se descartó.

### Otros canales

Rellena en `.env` los que quieras — puedes usar varios a la vez.

| Canal | Qué necesitas |
|---|---|
| Telegram | `TELEGRAM_BOT_TOKEN` de [@BotFather](https://t.me/BotFather) y `TELEGRAM_CHAT_ID` de [@userinfobot](https://t.me/userinfobot) |
| Discord | `DISCORD_WEBHOOK` desde Ajustes del canal → Integraciones → Webhooks |
| Webhook | `GENERIC_WEBHOOK`: recibe un POST JSON con `{ text, type, level, ... }` |

`NOTIFY_PROGRESS_STEP=25` añade avisos al 25 %, 50 % y 75 %. `0` los desactiva.

---

## Instalar como app en el móvil (PWA)

Con el dashboard servido por **HTTPS**:

- **Android (Chrome)**: menú ⋮ → *Añadir a pantalla de inicio* / *Instalar aplicación*.
- **iPhone (Safari)**: botón Compartir → *Añadir a pantalla de inicio*.

Se abre a pantalla completa, sin barra de navegador, con su propio icono. El Service Worker
cachea el armazón de la interfaz, así que abre al instante aunque la conexión sea mala; los
datos en vivo siguen viniendo siempre de la red, nunca de la caché.

Si tras un despliegue el móvil sigue viendo la versión antigua, ciérrala del multitarea y
vuelve a abrirla: `index.html` y `sw.js` se sirven con `Cache-Control: no-cache`, así que se
revalidan solos en la siguiente carga.

---

## Dominio propio: `status.silab3d.com`

Con el servicio ya desplegado en Render:

**1. En Render** — *Dashboard → tu servicio → Settings → Custom Domains → Add Custom Domain*
→ escribe `status.silab3d.com`. Render mostrará el destino CNAME, con la forma
`bambu-dashboard-xxxx.onrender.com`. Cópialo.

**2. En el DNS de silab3d.com** — añade un registro:

| Tipo | Nombre | Valor | TTL |
|---|---|---|---|
| `CNAME` | `status` | `bambu-dashboard-xxxx.onrender.com` | automático / 3600 |

El nombre es solo `status`, no `status.silab3d.com` (el panel añade el dominio). Si usas
Cloudflare, deja la nube **gris (DNS only)** durante la verificación; una vez emitido el
certificado puedes ponerla naranja si quieres su proxy.

**3. Vuelve a Render** y pulsa *Verify*. La propagación suele tardar de minutos a una hora.
Render emite el certificado Let's Encrypt solo, sin tocar nada más.

**4. Ajusta la variable de entorno** `KEEPALIVE_URL=https://status.silab3d.com` (o deja que
use `RENDER_EXTERNAL_URL`, que Render rellena solo).

**5. Reinstala la PWA** en el móvil desde la URL nueva: una PWA instalada desde
`*.onrender.com` es, para el navegador, una app distinta de la del dominio propio, y las
suscripciones push no se heredan.

> El dominio raíz `silab3d.com` no se toca. `status` es un subdominio independiente y puede
> convivir con la web que ya tengas ahí.

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

prefs    GET  /v1/design-user-service/my/preference → uid (para el usuario MQTT)

MQTT     mqtts://us.mqtt.bambulab.com:8883   (cn.mqtt… para China)
usuario  u_<uid>
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
src/bambu-cloud.js       login, listado de equipos, MQTT, reconexión, refresh de token
src/normalize.js         report crudo → objeto limpio (estados, etapas, AMS, HMS)
src/job-cycle.js         fases impresión → enfriamiento → retirada (con temporizador)
src/notifier.js          catálogo de avisos + transiciones + historial de 15 días + envío
src/push.js              Web Push (VAPID): alta, baja y purga de suscripciones muertas
src/store.js             persistencia JSON de historial, ajustes, suscripciones y fase
src/server.js            Express + WebSocket + endpoint de cámara + administración
public/index.html        dashboard (sin build, un solo archivo)
public/sw.js             Service Worker: caché del armazón + recepción de push
public/manifest.webmanifest   manifiesto de la PWA
agent/camera-agent.js    agente de cámara para la LAN
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
| GET | `/api/cycle` | Fase actual (impresión / enfriamiento / retirada) |
| POST | `/api/cycle/collected` | «Ya la he retirado»: cierra el ciclo |
| GET | `/api/settings` | Ajustes de avisos, canales activos y estado de push |
| PUT | `/api/settings` | Cambiar ajustes (requiere admin) |
| POST | `/api/admin/unlock` | Desbloquear con el código (`{ code }`) |
| POST | `/api/admin/bambu-logout` | Cerrar sesión de Bambu Cloud (requiere admin) |
| POST | `/api/admin/bambu-login` | Rehacer el login sin reiniciar (requiere admin) |
| GET | `/api/push/key` | Clave pública VAPID |
| POST | `/api/push/subscribe` | Alta de un dispositivo (`{ subscription }`) |
| POST | `/api/push/test` | Aviso de prueba (requiere admin) |
| POST | `/api/camera` | El agente sube un JPEG (`{ image: base64 }`) |
| GET | `/api/camera.jpg` | Último snapshot |
| GET | `/api/health` | Healthcheck (incluye fase y si está despierto a propósito) |
| WS | `/ws` | Estado en vivo |

---

## Notas y limitaciones

- La API de Bambu Cloud **no es pública**. Funciona hoy; Bambu puede cambiarla sin aviso.
- El `accessToken` que devuelve Bambu hoy es **opaco**, no un JWT: no se le pueden leer claims. El usuario MQTT (`u_<uid>`) se obtiene de `/v1/design-user-service/my/preference`.
- El `accessToken` caduca. El servidor detecta el rechazo MQTT (`Not authorized`), borra el token cacheado y rehace el login solo; si la cuenta usa código por email o 2FA, te lo pide en el dashboard.
- Tus credenciales viven en el `.env` del servidor. Si el VPS es compartido, considera usar `BAMBU_TOKEN` en lugar de la contraseña.
- Un `pushall` cada 60 s mantiene el estado fresco; abusar de esa frecuencia puede hacer que la nube te limite.
- La cámara por snapshots (puerto 6000) solo existe en **A1, A1 Mini, P1P y P1S**. Los modelos nuevos solo dan RTSP.
- **Web Push y la instalación como PWA exigen HTTPS.** Por IP de la LAN (`http://192.168.x.x`) el navegador ni siquiera expone la API de notificaciones, y el botón de la campana se oculta solo.
- El **código de administración** es una barrera de conveniencia sobre una sesión ya autenticada con `DASHBOARD_PASSWORD`, no un segundo factor: evita tocar los ajustes por accidente desde un móvil desbloqueado. Quien tenga la contraseña del dashboard puede probar códigos sin límite.
- Los **15 min de enfriamiento son un temporizador fijo**, no una lectura de la cama. La temperatura real se muestra en el panel, pero no adelanta ni retrasa el paso a «lista para retirar». Ajusta `COOLDOWN_MS` si tu caso pide otro margen.
- Si prefieres no montar el agente: [Tailscale](https://tailscale.com) en tu red y en el VPS te deja llegar a la impresora directamente, y entonces puedes usar la ruta LAN completa (MQTT local incluido).

## Licencia

MIT

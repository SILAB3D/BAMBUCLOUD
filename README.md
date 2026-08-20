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
- **Notificaciones push al móvil (Web Push)**: llegan con la PWA cerrada. Agrupadas en dos
  categorías —básicas y otras— que se encienden en conjunto o una a una desde el panel de
  administración. También por Telegram, Discord y webhook genérico.
- **Errores traducidos, no códigos**: el catálogo oficial de Bambu Lab en español
  (2.015 códigos HMS y 490 de impresión) va incluido, así que el aviso dice qué pasa y qué
  hacer en vez de soltar `0700_2000_0002_0001`.
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
tras un reinicio igualmente. En Render, donde no hay disco, ponlo (el blueprint
ya lo hace con `generateValue: true`): de él depende que la sesión de 30 días
sobreviva a los redespliegues.

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
  mientras duerme, no hay conexión MQTT: no se envían notificaciones. Ver
  *[Mantener el servicio despierto](#mantener-el-servicio-despierto)* justo debajo.
- **No hay disco persistente.** Por eso el token va en `BAMBU_TOKEN` en vez de en
  fichero. Si algún día Bambu lo rechaza, actualiza esa variable con uno nuevo.
  Esto afecta también al **historial de actividad, los ajustes de avisos y las
  suscripciones push**: cada reinicio los borra. El navegador se resuscribe solo cada vez
  que alguien abre el dashboard, así que en la práctica se recupera al primer acceso —
  pero si el servicio se reinicia mientras nadie mira, los avisos de esa impresión no
  llegarán.
- **La sesión sí sobrevive**, aunque no haya disco: además de la sesión normal, el
  login deja una cookie firmada de 30 días que no necesita nada guardado en el
  servidor. Cuando el servicio se reinicia y el almacén de sesiones desaparece, esa
  cookie la vuelve a levantar sola. Ver *Seguridad* más abajo.

**Si quieres que nada de esto se pierda**: plan `starter` (7 $/mes) y descomenta el bloque
`disk` de `render.yaml` (montado en `/data`). Con disco, historial, ajustes, suscripciones y
token sobreviven a cualquier reinicio, y el servicio deja de dormirse.

### Mantener el servicio despierto

En el plan gratuito de Render el servicio se duerme tras 15 min sin tráfico **entrante**, y
dormido **no corre nada**: ni MQTT, ni temporizadores, ni el auto-ping del propio servidor. De
ahí salen las dos reglas que mandan sobre todo lo demás:

> Un proceso dormido **no puede despertarse a sí mismo** ni enterarse de que ha empezado
> una impresión. El primer estímulo tiene que venir de fuera, siempre.

La vigilia se sostiene en cuatro capas, de dentro afuera:

| Capa | Quién la sostiene | Cuándo actúa |
| --- | --- | --- |
| **Impresión en curso** | el propio servidor, cada `KEEPALIVE_MS` (10 min) | mientras imprime, esté a la hora que esté |
| **Enfriamiento** | el servidor, con un ping justo al acabar la cuenta atrás | los 15 min de enfriado, para que salga el «ya puedes retirarla» |
| **Franja de vigilancia** | el servidor, mientras esté en pie | dentro de `WAKE_WINDOW` (9-23 por defecto), aunque no haya nada imprimiendo |
| **Primer ping del día** | **un cron externo** llamando a `GET /api/wake` | una vez por hora, como red de seguridad |

Lo que aporta la franja es lo único que faltaba: si una impresión **empieza** con el servicio
dormido, nadie se entera hasta que algo lo despierte. Despierto durante la franja, ese arranque
se detecta al momento y a partir de ahí la impresión se sostiene sola, aunque acabe a las 4 de
la mañana.

**El coste sigue siendo 0.** Render regala 750 h de instancia al mes; una franja de 9 a 23 son
14 h/día, **~420 h/mes**, con sitio de sobra para las impresiones que se salgan de la franja y
para los despliegues. Estar despierto 24/7 serían ~730 h: entra por los pelos y sin ningún
margen, de ahí que la franja no sea 0-24. `GET /api/health` devuelve la cuenta estimada para
poder mirarla en vez de suponerla.

```bash
WAKE_WINDOW=9-23           # "23-7" también vale (cruza la medianoche); "off" lo desactiva
WAKE_TZ=Europe/Madrid      # el contenedor de Render va en UTC: sin esto la franja se desplaza
```

#### El despertador externo

Dos opciones, las dos gratis. Con una basta; tener las dos tampoco molesta.

**GitHub Actions** — ya viene hecho en `.github/workflows/keepalive.yml`. Solo hay que crear la
variable del repositorio en *Settings → Secrets and variables → Actions → Variables*:

```
DASHBOARD_URL = https://tu-dominio.com
```

Corre cada hora entre las 07:00 y las 22:00 UTC, que cubre 9:00-23:00 de Madrid en verano y en
invierno sin tocar nada. Gratis (ilimitado en repos públicos, 2.000 min/mes en privados) y cada
ejecución son segundos.

> **Aviso**: GitHub desactiva los workflows programados de un repo sin actividad durante 60
> días (avisa por correo antes). Si esto va a quedarse solo, mejor la opción de abajo.

**cron-job.org** — gratis, sin límite de ejecuciones y sin la regla de los 60 días. Crea un job
que llame a `https://tu-dominio.com/api/wake` cada hora, con el tiempo de espera al máximo (un
servicio dormido tarda ~30-50 s en arrancar).

`/api/wake` no lleva autenticación a propósito: no expone nada que no exponga ya `/api/health`
y tiene que poder llamarla un cron gratuito sin secretos que rotar. Devuelve `wasAwake: false`
cuando el servicio estaba realmente dormido y el ping ha servido de algo.

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
| **Lista para imprimir** | tras pulsar «Ya la he retirado» | anillo vacío, sin porcentaje ni capas: la máquina está libre |

La última fase existe porque la impresora **se queda clavada en `FINISH` al 100 %** hasta que
empieza el siguiente trabajo. Sin ella, en cuanto se retiraba la pieza el panel volvía a
anunciar una impresión completada que ya no le importaba a nadie. La marca de recogida se
guarda en el ciclo (`collected`), se difunde por WebSocket —así todas las pantallas abiertas
pasan a «lista para imprimir» a la vez— y se borra sola al arrancar un trabajo nuevo.

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

### Códigos de error traducidos

Los avisos de error no dan el código, dan **lo que pasa y lo que hay que hacer**. En vez de

> 🔧 Error HMS 0700_2000_0002_0001 (severidad: grave)

llega

> 🔧 AMS A Se ha agotado el filamento de la ranura 1. Por favor, inserta un filamento nuevo.
> 👉 Carga una bobina nueva en esa ranura y reanuda desde la impresora.
> https://bambulab.com/es-es/support/hms/0700_2000_0002_0001

El texto descriptivo es **el oficial de Bambu Lab**, en español: sale de
`https://e.bambulab.com/query.php`, la misma fuente que alimenta el buscador de errores de la
web de soporte y la app Handy. El catálogo completo —**2.015 códigos HMS y 490 de error de
impresión**— vive versionado en `data/bambu-errors.json`, así que el servidor arranca con él
sin depender de la red, que es justo lo que no conviene cuando hay un error que traducir.

Para actualizarlo cuando Bambu añada códigos:

```bash
npm run errors     # reescribe data/bambu-errors.json; revisa el diff y confirma
```

La línea de **«qué hacer»** no viene de Bambu: el catálogo oficial publica la causa, no la
solución. Se deduce en `src/error-codes.js` con reglas sobre ese texto oficial (filamento
agotado → «carga una bobina», mal contacto en un conector → «revisa el conector»…). Cubre el
~83 % de los códigos con una acción concreta; el resto cae en un consejo según la gravedad. El
detalle completo está siempre a un clic, en el enlace a la ficha oficial.

Lo mismo se aplica a `print_error`: cuando una impresión falla, el aviso incluye **por qué**
falló, no solo que falló.

### Panel de administración

Botón del engranaje, arriba a la derecha → código **1510** (cambiable con `ADMIN_CODE`).
El desbloqueo dura una hora: la sesión del dashboard no caduca, pero el panel sí.

- **Enviar notificaciones**: interruptor general de los avisos de la app.
- **Dos categorías, cada una con su interruptor maestro**:
  - **Notificaciones básicas** — la impresión se está enfriando, la impresión puede retirarse,
    y los errores de la impresora (HMS).
  - **Otras notificaciones** — iniciada, terminada, en pausa, reanudada, fallida, atención
    requerida e hitos de progreso.
- **Un interruptor por tipo de aviso**, dentro de su categoría. Son tres llaves en serie: el
  maestro, el de la categoría y el del aviso; con que una esté cerrada, no sale nada. Apagar
  una categoría **no borra** lo que tenía cada aviso, así que volver a encenderla lo devuelve
  tal cual estaba.

  El catálogo se define en `CATEGORIES` y `TRIGGERS` (`src/notifier.js`) y la interfaz se
  genera desde ahí: añadir un tipo allí, con su `category`, basta para que aparezca su
  interruptor en el sitio correcto.

  **De serie las dos categorías vienen apagadas** (`DEFAULT_SETTINGS` en `src/notifier.js`):
  en el plan gratuito de Render no hay disco, así que cada reinicio devuelve los ajustes a
  estos valores y el punto de partida es el silencio. Los interruptores individuales, en
  cambio, arrancan encendidos, para que encender una categoría encienda de verdad lo que
  promete. Una vez tocas cualquier interruptor, tu elección manda mientras el estado
  sobreviva; con un disco persistente montado, para siempre.
- **Enviar aviso de prueba**: suscribe este dispositivo si hacía falta y manda un push real.
  Si algo falla, se abre la ventana de diagnóstico con las causas probables.
- **Cerrar sesión** de Bambu Lab: corta el MQTT y borra el token guardado. Para reconectar
  hará falta el código que Bambu envía por email.

Los cambios se aplican **en tiempo real y para todos los dispositivos**: el filtro vive en el
servidor, en el momento de enviar, así que apagar un aviso aquí lo apaga en todos los móviles
sin que ninguno tenga que abrir la app. Los paneles abiertos en otras pantallas se repintan
solos por WebSocket. Un aviso desactivado sigue registrándose en el panel de actividad; lo que
se corta es el envío —y también el aviso en pantalla de las pestañas abiertas.

### Dispositivos

La sección **Dispositivos** del panel lista cada navegador suscrito a Web Push, con un nombre
legible que el servidor deduce del user-agent (*Chrome · Android*, *Safari · iPhone (app
instalada)*) y cuándo se le vio por última vez. El que estás usando aparece marcado.

- **Interruptor por dispositivo**: silencia ese móvil concreto sin tocar los demás ni los
  tipos de aviso. Sigue suscrito, simplemente deja de recibir envíos.
- **Aspa**: lo saca del registro. Volverá a aparecer solo si abre la app con el permiso dado.

El interruptor **se conserva al renovar la suscripción**: un dispositivo silenciado no se
reactiva porque su dueño vuelva a abrir la app. Los identificadores son un hash del endpoint,
así que son estables entre reinicios y no exponen el token del push service.

### Si no llegan las notificaciones

El panel de administración diagnostica las tres capas por separado:

1. **Servidor**: si dice «sin claves VAPID», faltan `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`
   en las variables de entorno. Sin ellas no hay push, solo avisos con la web abierta.
2. **Este dispositivo**: si no aparece «suscrito ✓», el texto explica por qué (permiso no
   concedido, bloqueado en el navegador, en iPhone sin instalar la app…).
3. Los envíos y las altas quedan en el log del servidor (`[push] alta de Chrome · Android…`,
   `[push] prueba enviada a N dispositivo(s)`).

Además, **cuando pulsas cualquier botón de activar avisos y no se consigue**, se abre una
ventana con las causas posibles, la más probable marcada primero: permiso bloqueado para el
sitio (con los pasos para reabrirlo, distintos en iPhone y en escritorio), iPhone sin instalar
la app, ventana de incógnito —donde el navegador desactiva el Service Worker—, conexión sin
HTTPS, servidor sin claves VAPID, «No molestar» del sistema y extensiones que deniegan el
permiso sin preguntar. La navegación privada solo se **intuye** (cuota de disco recortada,
ausencia de Service Worker): sirve para ordenar la lista, nunca para bloquear nada.

### Cuando los avisos se activan pero no llegan con la app cerrada

Es un problema **distinto** del anterior y el más difícil de ver, porque desde el servidor todo
parece correcto: el permiso está dado, la suscripción es válida y el envío responde que sí.

> El push service (FCM) responde `201` en cuanto **acepta** el mensaje, no cuando el móvil lo
> muestra. Un teléfono que tira los avisos en segundo plano se veía exactamente igual que uno
> sano: «enviado a 2 dispositivos» mientras uno de los dos llevaba semanas mudo.

**Acuse de recibo.** El Service Worker avisa al servidor (`POST /api/push/ack`) en cuanto pinta
la notificación. Es el único dato honesto sobre si los avisos llegan, y con él la lista de
**Dispositivos** muestra una línea de estado por móvil:

- `Recibiendo avisos · último confirmado hace 3 min` — funciona.
- `Aviso enviado, esperando confirmación…` — normal durante unos segundos.
- `No confirma los avisos desde hace 2 h` **(en rojo)** — aquí pasa algo, con un botón
  **«¿Por qué?»** al lado.

El margen antes de dar un aviso por perdido es de 10 minutos (`ACK_GRACE_MS` en `src/push.js`):
FCM sí encola para un móvil sin cobertura y lo entrega al reconectar, y eso no es un fallo.

**El botón de prueba ahora concluye.** Manda el aviso, espera hasta 12 s a los acuses y dice
qué dispositivos lo han confirmado y cuáles no, en vez de quedarse en «enviado».

**La causa casi nunca es el navegador**, sino la capa de ahorro de batería del fabricante, que
mata el proceso que muestra el aviso. **Xiaomi / Redmi / POCO (MIUI y HyperOS) es el caso más
agresivo, y viene así de fábrica.** En un Redmi hay que tocar, en *Ajustes → Aplicaciones →
Administrar aplicaciones → la app*:

1. **Inicio automático** (*Autostart*): activado.
2. **Ahorro de batería** de esa app: «Sin restricciones».
3. **Notificaciones**: activadas, y dentro, «Mostrar en pantalla de bloqueo» y «Notificaciones
   flotantes».
4. Y en la vista de recientes, **bloquear la tarjeta con el candado** para que borrar recientes
   no se lleve por delante el proceso.

Ojo con un despiste que lo explica todo: si el dashboard está **añadido a la pantalla de
inicio**, Android lo registra como una app aparte (WebAPK) con sus propios permisos. Ajustar la
batería de Chrome no le afecta — hay que buscar el icono del dashboard en la lista de apps.

La ventana **«¿Por qué?»** da estos pasos ya adaptados a la marca del móvil concreto (Xiaomi,
Samsung, Huawei, Oppo/Realme/OnePlus, Vivo, iPhone o Android genérico). Para saber la marca no
basta el user-agent: Chrome lo recorta por privacidad y manda `Android 10; K` para todos los
teléfonos del mundo, así que el modelo se pide con `navigator.userAgentData` y se envía en el
alta. Es también lo que hace que la lista diga *Chrome · Redmi Note 12* en vez de tres
*Chrome · Android* idénticos.

### Ventana de bienvenida

Trata dos asuntos distintos y con distinto peso, y se nota en el diseño:

- **Avisos** (prioritario): bloque con el color de acento, su estado del permiso a la vista
  (*sin activar* / *activados* / *bloqueados*) y el único botón sólido de la ventana.
- **Instalación** (secundario): en gris. En iPhone sube a *obligatorio*, porque Safari solo
  permite avisos a las apps añadidas a la pantalla de inicio.

**Aparece en cada bienvenida mientras falte el permiso de avisos.** No hay tope de aperturas
ni espera entre ellas: lo que está limitado es cuántas veces se puede cerrar sin resolverlo.

**Tres cierres.** El botón *Ahora no* dice cuántos quedan; al agotarlos desaparecen tanto ese
botón como el aspa, y tocar fuera tampoco la cierra. La única salida es conceder el permiso.
El recuento vive en `localStorage`: es por dispositivo, igual que el permiso, y sobrevive a
los reinicios y redespliegues del servidor.

**Excepción, deliberada:** si el permiso es inalcanzable ahora mismo —bloqueado en los ajustes
del navegador, navegador sin soporte, o iPhone sin instalar— el botón de cerrar se mantiene
aunque no queden cierres. Sin esa salida la app quedaría inservible detrás de un modal que el
usuario no puede quitar de ninguna manera.

Se puede abrir cuando se quiera desde **Administración → Ver guía de instalación**. Abierta
así siempre se puede cerrar y no gasta cierres: la ha pedido el usuario, no se le está
insistiendo.

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
src/notifier.js          catálogo de avisos por categoría + transiciones + historial + envío
src/error-codes.js       códigos HMS y print_error → descripción oficial + qué hacer
src/progress.js          la décima del porcentaje, interpolada del tiempo restante
src/wake.js              franja horaria de vigilia (y la cuenta de horas que implica)
src/push.js              Web Push (VAPID): alta, baja, acuse de recibo y purga de suscripciones
src/store.js             persistencia JSON de historial, ajustes, suscripciones y fase
src/session-store.js     almacén de sesiones de express-session sobre el JSON
src/keep-cookie.js       cookie firmada de 30 días: la sesión sobrevive sin disco
src/rate-limit.js        freno por IP de los intentos de contraseña y de código
src/server.js            Express + WebSocket + endpoint de cámara + administración
public/index.html        dashboard (sin build, un solo archivo)
public/sw.js             Service Worker: caché del armazón + recepción de push
public/manifest.webmanifest   manifiesto de la PWA
agent/camera-agent.js    agente de cámara para la LAN
tools/make-icons.mjs     genera favicon e iconos (figura de la marca)
tools/fetch-error-codes.mjs   descarga el catálogo oficial de errores de Bambu Lab
data/bambu-errors.json   ese catálogo, versionado: 2.015 códigos HMS + 490 de impresión
.github/workflows/keepalive.yml   cron gratuito que da el primer ping del día
```

### Iconografía

Toda la imagen de la app es el mismo icosaedro: favicon, iconos de la PWA,
icono de notificación, pantalla de carga y el holograma que ocupa el hueco del
proyecto. Los PNG y el `favicon.svg` se regeneran con:

```bash
node tools/make-icons.mjs
```

El script no tiene dependencias (escribe el PNG a mano con `zlib`) y sale de
la misma pose que usa el holograma animado en su primer fotograma, para que
figura quieta y figura girando se reconozcan como la misma. Si tocas la pose o
los colores, regenera y súbelo: los PNG están versionados.

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
| POST | `/api/push/subscribe` | Alta de un dispositivo (`{ subscription, info }`) |
| POST | `/api/push/ack` | Acuse del Service Worker al mostrar un aviso (`{ d }`, sin auth) |
| POST | `/api/push/test` | Aviso de prueba (requiere admin; `{ id }` para uno solo) |
| GET | `/api/admin/devices` | Dispositivos suscritos (requiere admin) |
| PATCH | `/api/admin/devices/:id` | Activar o silenciar uno (`{ enabled }`, requiere admin) |
| DELETE | `/api/admin/devices/:id` | Quitarlo del registro (requiere admin) |
| POST | `/api/camera` | El agente sube un JPEG (`{ image: base64 }`) |
| GET | `/api/camera.jpg` | Último snapshot |
| GET | `/api/health` | Healthcheck (fase, motivo de la vigilia, horas/mes estimadas, catálogo de errores) |
| GET | `/api/wake` | Puerta del despertador externo: sin auth, responde si estaba dormido |
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
- El **código de administración** es una barrera de conveniencia sobre una sesión ya autenticada con `DASHBOARD_PASSWORD`, no un segundo factor: evita tocar los ajustes por accidente desde un móvil desbloqueado.
- **Intentos limitados por IP.** `/api/login` y `/api/admin/unlock` llevan un freno: 5 fallos gratis y a partir de ahí cada fallo duplica la espera (2 s, 4 s, 8 s…) hasta un tope de 15 min. Los contadores de las dos puertas son independientes, viven en memoria y se borran al acertar. No es un WAF: es para que probar contraseñas a ciegas cueste tiempo real.
- **Sesión persistente de 30 días.** Al entrar se emite `bambu.keep`, una cookie `httpOnly` firmada con HMAC-SHA256 —la misma primitiva que `express-session` ya usaba para el identificador de sesión— que permite recuperar la sesión sin nada guardado en el servidor. Consecuencias que conviene tener claras:
  - Quien robe la cookie entra, igual que con la cookie de sesión de siempre. Nada nuevo aquí.
  - **No hay revocación individual.** Sin registro en el servidor no hay nada que borrar: *Salir del dashboard* solo puede pedirle al navegador que la tire. Un testigo ya filtrado sigue valiendo hasta que caduque.
  - El botón de pánico es **cambiar `DASHBOARD_PASSWORD`**: la clave de firma se deriva de `SESSION_SECRET` *y* de la contraseña, así que al cambiarla caducan de golpe todos los dispositivos.
  - En producción la cookie va `Secure`, así que exige HTTPS. Sobre `http://` de la LAN no se emite (pon `TRUST_HTTPS=false` si de verdad lo necesitas).
- Los **15 min de enfriamiento son un temporizador fijo**, no una lectura de la cama. La temperatura real se muestra en el panel, pero no adelanta ni retrasa el paso a «lista para retirar». Ajusta `COOLDOWN_MS` si tu caso pide otro margen.
- Si prefieres no montar el agente: [Tailscale](https://tailscale.com) en tu red y en el VPS te deja llegar a la impresora directamente, y entonces puedes usar la ruta LAN completa (MQTT local incluido).

## Licencia

MIT

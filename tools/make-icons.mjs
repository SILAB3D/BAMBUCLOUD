/**
 * Generador de la iconografia de la app.
 *
 * Todos los iconos son el mismo icosaedro en la misma pose: visto de frente
 * contra una cara, que es la vista que da la silueta hexagonal simetrica del
 * dado de veinte. Es la pose "de retrato" de la marca; el holograma de la
 * interfaz gira, pero arranca justo aqui para que se reconozca que son la
 * misma figura.
 *
 *   node tools/make-icons.mjs
 *
 * Sin dependencias: el PNG se escribe a mano (zlib va en Node) porque la
 * alternativa era arrastrar canvas/sharp solo para regenerar seis ficheros
 * que casi nunca cambian.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/* ==========================================================================
   Geometria
   ========================================================================== */

/** Los 12 vertices normalizados y las 30 aristas del icosaedro. */
function icosahedron() {
  const PHI = (1 + Math.sqrt(5)) / 2;
  const raw = [];
  for (const a of [-1, 1]) {
    for (const b of [-1, 1]) {
      raw.push([0, a, b * PHI], [a, b * PHI, 0], [b * PHI, 0, a]);
    }
  }
  const r = Math.hypot(1, PHI);
  const verts = raw.map((v) => v.map((c) => c / r));

  // Aristas = los pares que estan a la distancia minima. Mas fiable que
  // teclear treinta parejas de indices a mano.
  const d2 = (i, j) =>
    (verts[i][0] - verts[j][0]) ** 2 +
    (verts[i][1] - verts[j][1]) ** 2 +
    (verts[i][2] - verts[j][2]) ** 2;
  let min = Infinity;
  for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) min = Math.min(min, d2(i, j));

  const edges = [];
  for (let i = 0; i < 12; i++) {
    for (let j = i + 1; j < 12; j++) if (d2(i, j) < min * 1.05) edges.push([i, j]);
  }
  return { verts, edges, adjacent: (i, j) => d2(i, j) < min * 1.05 };
}

const ICO = icosahedron();

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v) => {
  const m = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / m, v[1] / m, v[2] / m];
};
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * Pose canonica: el eje de la camara atraviesa el centro de una cara y la
 * figura se gira sobre ese eje hasta dejar un vertice arriba del todo, para
 * que el hexagono quede en punta y no tumbado.
 */
function canonicalPose() {
  // Una cara cualquiera: el primer trio de vertices mutuamente adyacentes.
  let face = null;
  outer: for (let i = 0; i < 12; i++) {
    for (let j = i + 1; j < 12; j++) {
      if (!ICO.adjacent(i, j)) continue;
      for (let k = j + 1; k < 12; k++) {
        if (ICO.adjacent(i, k) && ICO.adjacent(j, k)) { face = [i, j, k]; break outer; }
      }
    }
  }
  const axis = norm(face.reduce(
    (s, i) => [s[0] + ICO.verts[i][0], s[1] + ICO.verts[i][1], s[2] + ICO.verts[i][2]],
    [0, 0, 0],
  ));

  // Base ortonormal con `axis` como profundidad.
  const seed = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = norm(cross(seed, axis));
  let w = cross(axis, u);

  const flatPose = ICO.verts.map((v) => ({ x: dot(v, u), y: -dot(v, w), z: dot(v, axis) }));

  // Giro en el plano hasta dejar un vertice de la silueta justo arriba: el
  // hexagono en punta, como en la referencia. Se aplica en 2D y no sobre la
  // base porque asi el signo del angulo es el que se ve, sin sorpresas.
  const top = flatPose.reduce((a, b) => (b.y < a.y ? b : a));
  const theta = Math.atan2(top.x, -top.y);
  const c = Math.cos(-theta), s = Math.sin(-theta);
  return flatPose.map((p) => ({
    x: p.x * c - p.y * s,
    y: p.x * s + p.y * c,
    z: p.z,
  }));
}

const POSE = canonicalPose();

/**
 * Aristas visibles: las que tocan al menos una cara orientada hacia la camara.
 *
 * Es la ocultacion de lineas de toda la vida, que en un solido convexo se
 * resuelve solo mirando la normal de cada cara. Sin esto se dibujan las
 * treinta aristas, las de detras se cruzan con las de delante y lo que sale es
 * una maraña en estrella, no el dado de la referencia.
 */
const VISIBLE_EDGES = (() => {
  // Las 20 caras: cada trio de vertices mutuamente adyacentes.
  const faces = [];
  for (let i = 0; i < 12; i++) {
    for (let j = i + 1; j < 12; j++) {
      if (!ICO.adjacent(i, j)) continue;
      for (let k = j + 1; k < 12; k++) {
        if (ICO.adjacent(i, k) && ICO.adjacent(j, k)) faces.push([i, j, k]);
      }
    }
  }
  // En un poliedro regular centrado en el origen, la normal de una cara apunta
  // igual que su centro, asi que basta con la z del centroide.
  const towardCamera = faces.filter(
    (f) => (POSE[f[0]].z + POSE[f[1]].z + POSE[f[2]].z) / 3 > 1e-9,
  );

  const seen = new Set();
  for (const [a, b, c] of towardCamera) {
    for (const [p, q] of [[a, b], [b, c], [a, c]]) {
      seen.add(p < q ? `${p},${q}` : `${q},${p}`);
    }
  }
  return ICO.edges.filter(([a, b]) => seen.has(`${a},${b}`));
})();

/* ==========================================================================
   Rasterizado
   ==========================================================================
   Campo de distancias en vez de supermuestreo: para capsulas (aristas) y
   discos (vertices) la distancia exacta se calcula en cerrado, asi que el
   antialiasing sale de un solo `clamp` por pixel y ademas queda el mismo
   campo listo para el resplandor.
   ========================================================================== */

function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? (wx * vx + wy * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(wx - t * vx, wy - t * vy);
}

/**
 * Distancia con signo al conjunto de trazos de una capa.
 * Devuelve un Float32Array del tamano del lienzo.
 */
function distanceField(size, shapes) {
  const f = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const py = y + 0.5;
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      let d = Infinity;
      for (const s of shapes) {
        const dd = s.r2 === undefined
          ? segDist(px, py, s.x1, s.y1, s.x2, s.y2) - s.hw
          : Math.hypot(px - s.cx, py - s.cy) - s.r2;
        if (dd < d) d = dd;
      }
      f[y * size + x] = d;
    }
  }
  return f;
}

/** Lienzo RGBA con premultiplicado manual al componer. */
function canvas(size) {
  return { size, px: new Float32Array(size * size * 4) };
}

/** `src` sobre `dst`, alpha clasico. */
function composite(cv, i, r, g, b, a) {
  if (a <= 0) return;
  const p = cv.px;
  const da = p[i + 3];
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  p[i]     = (r * a + p[i]     * da * (1 - a)) / oa;
  p[i + 1] = (g * a + p[i + 1] * da * (1 - a)) / oa;
  p[i + 2] = (b * a + p[i + 2] * da * (1 - a)) / oa;
  p[i + 3] = oa;
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Dibuja una capa de la figura.
 * @param tint  funcion (yNorm) -> [r,g,b] en 0..1, el degradado vertical
 * @param glow  intensidad del halo (0 lo desactiva)
 */
function paintLayer(cv, shapes, { tint, opacity = 1, glow = 0, glowRadius = 1 }) {
  const { size, px } = cv;
  const field = distanceField(size, shapes);
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const [r, g, b] = tint(t);
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      const d = field[idx];
      const i = idx * 4;

      if (glow > 0) {
        const dd = d > 0 ? d : 0;
        const ga = glow * Math.exp(-(dd * dd) / (2 * glowRadius * glowRadius));
        composite(cv, i, r, g, b, ga * opacity);
      }
      const a = clamp01(0.5 - d) * opacity;
      if (a > 0) composite(cv, i, r, g, b, a);
    }
  }
  return px;
}

/* ==========================================================================
   Composicion de la figura
   ========================================================================== */

const HOLO_TOP = [0x7e / 255, 0xf0 / 255, 0xff / 255]; // cian claro
const HOLO_BOT = [0x00 / 255, 0xd4 / 255, 0x92 / 255]; // verde de marca
const gradient = (t) => [
  lerp(HOLO_TOP[0], HOLO_BOT[0], t),
  lerp(HOLO_TOP[1], HOLO_BOT[1], t),
  lerp(HOLO_TOP[2], HOLO_BOT[2], t),
];
const flat = (rgb) => () => rgb;

/**
 * Los trazos de la figura, todos iguales.
 *
 * Sin puntos en los vertices y sin halo: es un dibujo de lineas, como la
 * referencia. La version con profundidad y resplandor se probo antes y a 32 px
 * —que es donde de verdad vive un favicon— se emborronaba hasta parecer una
 * mancha; el trazo plano y uniforme aguanta el tamano pequeno.
 */
function figureShapes(size, radius, stroke) {
  const cx = size / 2, cy = size / 2;
  const P = POSE.map((v) => ({ x: cx + v.x * radius, y: cy + v.y * radius }));
  return VISIBLE_EDGES.map(([a, b]) => ({
    x1: P[a].x, y1: P[a].y, x2: P[b].x, y2: P[b].y, hw: stroke / 2,
  }));
}

/**
 * @param opts.scale   fraccion del lienzo que ocupa la figura (diametro)
 * @param opts.tint    degradado vertical o color plano
 * @param opts.strokeK grosor del trazo, en fraccion del lienzo
 */
function paintFigure(cv, opts = {}) {
  const { scale = 0.72, tint = gradient, strokeK = 0.026 } = opts;
  const size = cv.size;
  const radius = (size * scale) / 2;
  const stroke = Math.max(1.1, size * strokeK);

  paintLayer(cv, figureShapes(size, radius, stroke), { tint });
}

/**
 * Version maciza para el badge de la barra de estado.
 *
 * Ahi el icono acaba en 24 px reales: un alambre de treinta lineas se
 * convierte en una mancha gris. Se queda la silueta hexagonal rellena con el
 * hueco de la cara frontal, que a ese tamano todavia se distingue.
 */
function paintSilhouette(cv, { scale = 0.9 } = {}) {
  const { size } = cv;
  const c = size / 2;
  const radius = (size * scale) / 2;
  const P = POSE.map((v) => ({ x: c + v.x * radius, y: c + v.y * radius, z: v.z }));

  // La silueta son los 6 vertices mas alejados del centro; la cara frontal,
  // los 3 mas cercanos a la camara.
  const byR = [...P].sort((a, b) => Math.hypot(b.x - c, b.y - c) - Math.hypot(a.x - c, a.y - c));
  const hull = byR.slice(0, 6).sort((a, b) => Math.atan2(a.y - c, a.x - c) - Math.atan2(b.y - c, b.x - c));
  const face = [...P].sort((a, b) => b.z - a.z).slice(0, 3)
    .sort((a, b) => Math.atan2(a.y - c, a.x - c) - Math.atan2(b.y - c, b.x - c));

  const inside = (poly, px, py) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > py) !== (b.y > py) &&
          px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  };

  const SS = 4; // supermuestreo: el borde recto de un poligono no tiene SDF facil
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (inside(hull, px, py) && !inside(face, px, py)) hits++;
        }
      }
      if (hits) composite(cv, (y * size + x) * 4, 1, 1, 1, hits / (SS * SS));
    }
  }
}

/* ==========================================================================
   Fondos
   ========================================================================== */

/**
 * Cuadrado de esquinas redondeadas, oscuro y liso.
 *
 * Solo un degradado muy leve para que no parezca un recorte de cartulina. El
 * halo de color que habia antes competia con la figura justo al tamano en que
 * la figura ya se ve mal.
 */
function paintPlate(cv, { rounding = 0.22 } = {}) {
  const { size } = cv;
  const r = size * rounding;

  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const base = [
      lerp(0x14, 0x08, t) / 255, lerp(0x1c, 0x0b, t) / 255, lerp(0x27, 0x10, t) / 255,
    ];
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;

      // Distancia al rectangulo redondeado (SDF de caja).
      const qx = Math.abs(px - size / 2) - (size / 2 - r);
      const qy = Math.abs(py - size / 2) - (size / 2 - r);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      const a = clamp01(0.5 - d);
      if (a > 0) composite(cv, (y * size + x) * 4, base[0], base[1], base[2], a);
    }
  }
}

/* ==========================================================================
   PNG
   ========================================================================== */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(cv) {
  const { size, px } = cv;
  // Una fila = 1 byte de filtro (0, sin filtrar) + RGBA. Filtrar de verdad
  // ahorraria unos kB y complicaria el doble; estos iconos son diminutos.
  const raw = Buffer.alloc(size * (1 + size * 4));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const a = clamp01(px[i + 3]);
      raw[o++] = Math.round(clamp01(px[i])     * 255);
      raw[o++] = Math.round(clamp01(px[i + 1]) * 255);
      raw[o++] = Math.round(clamp01(px[i + 2]) * 255);
      raw[o++] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // 8 bits por canal
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function write(name, cv) {
  const buf = encodePng(cv);
  writeFileSync(join(OUT, name), buf);
  console.log(`  ${name.padEnd(26)} ${cv.size}px  ${(buf.length / 1024).toFixed(1)} kB`);
}

/* ==========================================================================
   SVG (favicon)
   ========================================================================== */

/**
 * @param plate false = fondo transparente (version de notificacion)
 */
function faviconSvg({ plate = true, scale = 0.72, stroke = 1.9 } = {}) {
  const S = 64, R = (S * scale) / 2, c = S / 2;
  const P = POSE.map((v) => ({ x: c + v.x * R, y: c + v.y * R }));
  const f = (n) => n.toFixed(2);

  const edges = VISIBLE_EDGES
    .map(([a, b]) => `<line x1="${f(P[a].x)}" y1="${f(P[a].y)}" x2="${f(P[b].x)}" y2="${f(P[b].y)}"/>`)
    .join('');

  const bg = plate
    ? `<rect width="${S}" height="${S}" rx="${S * 0.22}" fill="url(#p)"/>`
    : '';
  const plateDef = plate
    ? `<linearGradient id="p" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#141c27"/><stop offset="1" stop-color="#080b10"/>
  </linearGradient>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">
<!-- Generado por tools/make-icons.mjs. No editar a mano. -->
<defs>
  <linearGradient id="e" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#7ef0ff"/><stop offset="1" stop-color="#00d492"/>
  </linearGradient>
  ${plateDef}
</defs>
${bg}
<g fill="none" stroke="url(#e)" stroke-width="${stroke}" stroke-linecap="round"
   stroke-linejoin="round">${edges}</g>
</svg>
`;
}

/* ==========================================================================
   Salida
   ========================================================================== */

mkdirSync(OUT, { recursive: true });
console.log('Generando iconos en public/');

// --- Iconos de la app: figura sobre placa oscura ---------------------------
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512]]) {
  const cv = canvas(size);
  paintPlate(cv);
  paintFigure(cv, { scale: 0.68 });
  write(name, cv);
}

// Maskable: Android recorta hasta un circulo inscrito, asi que la figura se
// encoge al 60% y el fondo llega a los bordes sin esquinas redondeadas.
{
  const cv = canvas(512);
  paintPlate(cv, { rounding: 0 });
  paintFigure(cv, { scale: 0.52 });
  write('icon-maskable-512.png', cv);
}

// iOS redondea el apple-touch por su cuenta y no admite transparencia.
{
  const cv = canvas(180);
  paintPlate(cv, { rounding: 0 });
  paintFigure(cv, { scale: 0.66 });
  write('apple-touch-icon.png', cv);
}

// Respaldo del favicon para navegadores sin SVG. A 32 px el trazo tiene que
// engordar bastante o las lineas interiores se comen unas a otras.
{
  const cv = canvas(32);
  paintPlate(cv, { rounding: 0.22 });
  paintFigure(cv, { scale: 0.74, strokeK: 0.042 });
  write('favicon-32.png', cv);
}

// --- Notificacion: la misma figura, sin placa -----------------------------
// Android la pinta sobre la tarjeta del sistema, que puede ser blanca o negra
// segun el tema. Sin fondo y con trazo grueso se lee en las dos.
{
  const cv = canvas(192);
  paintFigure(cv, { scale: 0.88, strokeK: 0.036 });
  write('notify-icon.png', cv);
}

// El badge de la barra de estado es una mascara: el sistema ignora el color y
// pinta solo la silueta del canal alfa, asi que va en blanco liso y sin halo.
{
  const cv = canvas(96);
  paintSilhouette(cv, { scale: 0.9 });
  write('badge-96.png', cv);
}

writeFileSync(join(OUT, 'favicon.svg'), faviconSvg());
console.log('  favicon.svg');
console.log('Listo.');

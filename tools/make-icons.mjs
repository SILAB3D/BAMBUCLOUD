/**
 * Generador de la iconografia de Bambustatus.
 *
 * LA MARCA
 * --------
 * Un anillo de progreso abierto —270 grados, arranca arriba y gira como las
 * agujas del reloj— con su cabeza encendida en el extremo, y dentro el
 * icosaedro de siempre, ahora macizo: sus diez caras visibles, cada una con
 * una holgura que deja ver la talla.
 *
 * Las dos mitades dicen las dos cosas que hace la app. El anillo, que esto
 * vigila una impresion y sabe por donde va —es el mismo anillo con cabeza del
 * panel de estado, a otra escala—. El icosaedro, que lo que se imprime es una
 * pieza. Antes el icono era solo el icosaedro en alambre: bonito, pero decia
 * "3D" y no decia ni progreso ni aviso.
 *
 *   node tools/make-icons.mjs
 *
 * Sin dependencias: el PNG se escribe a mano (zlib va en Node) porque la
 * alternativa era arrastrar canvas/sharp solo para regenerar siete ficheros
 * que casi nunca cambian.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ==========================================================================
   El icosaedro
   ==========================================================================
   Los 12 vertices salen de la definicion con la razon aurea y las 20 caras de
   buscar los trios de vertices mutuamente adyacentes: mas fiable que teclear
   sesenta indices a mano, y ademas deja la figura lista para cualquier pose.
   ========================================================================== */

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (v) => {
  const m = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / m, v[1] / m, v[2] / m];
};

/**
 * Caras visibles del icosaedro en su pose canonica, proyectadas y
 * normalizadas al radio 1.
 *
 * POSE CANONICA: la camara atraviesa el centro de una cara y la figura se gira
 * sobre ese eje hasta dejar un vertice justo arriba. Es la vista que da la
 * silueta hexagonal en punta —la del dado de veinte en una foto de catalogo— y
 * la unica en la que la figura se reconoce de un vistazo.
 *
 * VISIBLES: en un solido convexo basta con la z del centro de cada cara, que
 * en un poliedro regular centrado en el origen apunta igual que su normal.
 * Son exactamente diez, la mitad de las veinte.
 *
 * Salen ordenadas de atras adelante para que, si algun dia se pintan con
 * distinta intensidad, el orden de dibujado ya sea el correcto.
 */
function icosahedronFaces() {
  const PHI = (1 + Math.sqrt(5)) / 2;
  const raw = [];
  for (const a of [-1, 1]) {
    for (const b of [-1, 1]) {
      raw.push([0, a, b * PHI], [a, b * PHI, 0], [b * PHI, 0, a]);
    }
  }
  const norm = Math.hypot(1, PHI);
  const verts = raw.map((v) => v.map((c) => c / norm));

  const d2 = (i, j) =>
    (verts[i][0] - verts[j][0]) ** 2 +
    (verts[i][1] - verts[j][1]) ** 2 +
    (verts[i][2] - verts[j][2]) ** 2;
  let min = Infinity;
  for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) min = Math.min(min, d2(i, j));
  const adjacent = (i, j) => d2(i, j) < min * 1.05;

  const faces = [];
  for (let i = 0; i < 12; i++) {
    for (let j = i + 1; j < 12; j++) {
      if (!adjacent(i, j)) continue;
      for (let k = j + 1; k < 12; k++) {
        if (adjacent(i, k) && adjacent(j, k)) faces.push([i, j, k]);
      }
    }
  }

  // Base ortonormal con el eje de una cara como profundidad.
  const axis = unit(
    faces[0].reduce(
      (s, i) => [s[0] + verts[i][0], s[1] + verts[i][1], s[2] + verts[i][2]],
      [0, 0, 0],
    ),
  );
  const seed = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = unit(cross(seed, axis));
  const w = cross(axis, u);
  const flat = verts.map((v) => [dot(v, u), -dot(v, w), dot(v, axis)]);

  // Giro en el plano hasta dejar un vertice de la silueta justo arriba. Se
  // aplica en 2D y no sobre la base porque asi el signo del angulo es el que
  // se ve, sin sorpresas.
  const top = flat.reduce((a, b) => (b[1] < a[1] ? b : a));
  const th = -Math.atan2(top[0], -top[1]);
  const ct = Math.cos(th);
  const st = Math.sin(th);
  const P = flat.map(([x, y, z]) => [x * ct - y * st, x * st + y * ct, z]);

  const visible = faces
    .map((f) => ({ f, z: (P[f[0]][2] + P[f[1]][2] + P[f[2]][2]) / 3 }))
    .filter((o) => o.z > 1e-9)
    .sort((a, b) => a.z - b.z);

  // Normalizado al radio de la silueta para que `r` en MARK signifique
  // siempre lo mismo: la mitad del ancho que ocupa la figura.
  const rMax = Math.max(...visible.flatMap((o) => o.f.map((i) => Math.hypot(P[i][0], P[i][1]))));
  return visible.map((o) => o.f.map((i) => [P[i][0] / rMax, P[i][1] / rMax]));
}

const ICO = icosahedronFaces();

/** Los seis vertices de la silueta, en orden angular. */
const ICO_HULL = (() => {
  const pts = [];
  for (const f of ICO) {
    for (const p of f) {
      if (!pts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-4)) pts.push(p);
    }
  }
  return pts
    .filter((p) => Math.hypot(p[0], p[1]) > 0.999)
    .sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
})();

/**
 * Encoge un poligono hacia su centro dejando una holgura uniforme.
 *
 * Se escala hacia el centroide, y el factor se calcula con la distancia del
 * centroide a su lado mas cercano: asi la holgura que queda es la pedida y no
 * una proporcion que se abre en las caras grandes y se cierra en las
 * pequenas. Los PNG y el SVG usan el mismo resultado, que es lo que garantiza
 * que sean el mismo dibujo y no dos parecidos.
 */
function shrink(pts, gap) {
  const c = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length], [0, 0]);
  let inradius = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const d = Math.abs((b[0] - a[0]) * (a[1] - c[1]) - (a[0] - c[0]) * (b[1] - a[1])) / len;
    inradius = Math.min(inradius, d);
  }
  const k = Math.max(0.05, 1 - gap / inradius);
  return pts.map((p) => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k]);
}

/* ==========================================================================
   La marca, en coordenadas normalizadas
   ==========================================================================
   Todo en fracciones del lienzo (0..1, centro en 0.5) para que la misma
   definicion sirva a 32 px y a 512 sin numeros magicos por tamano.

   Los angulos van en convencion de pantalla (y hacia abajo): -90 grados son
   las 12 en punto y crecer es girar en el sentido de las agujas del reloj.
   ========================================================================== */

const MARK = {
  ring: { r: 0.328, w: 0.082, a0: -Math.PI / 2, sweep: Math.PI * 1.5 },
  // La cabeza del arco, en el extremo: el mismo punto encendido que lleva el
  // anillo del panel de estado. Es lo que convierte un aro roto en "esto se
  // esta moviendo".
  head: 0.055,
  // Radio de la figura de dentro (mitad de su ancho).
  figure: 0.191,
  // La holgura entre caras, en fraccion del radio de la figura: asi la talla
  // se ve igual a 192 px que a 512 y que en el SVG, que no sabe a que tamano
  // acabara. Con un minimo en pixeles porque por debajo de un pixel y pico la
  // separacion deja de leerse como tal y lo unico que hace es ensuciar la masa
  // con medios tonos.
  gapK: 0.043,
  gapMinPx: 1.2,
  // Por debajo de este radio en pixeles, diez triangulos ya no caben: se pinta
  // la silueta hexagonal y se acabo. Es la simplificacion de toda la vida para
  // los tamanos de favicon, y no se pierde nada porque a 16 px de la pestana
  // las caras no se veian de todos modos.
  minFacetPx: 11,
};

/**
 * Los trazos de la marca a un tamano concreto.
 *
 * @param {number} size   lado del lienzo en px
 * @param {number} scale  fraccion del lienzo que ocupa el anillo (diametro)
 * @param {object} [opts]
 * @param {number} [opts.boost] engorda el trazo del anillo, para los tamanos
 *   diminutos donde uno fino se evapora
 * @param {boolean} [opts.figure] incluir la figura de dentro
 */
function markShapes(size, scale, { boost = 1, figure = true } = {}) {
  // `scale` es el diametro exterior deseado; la definicion mide 2*(r + w/2).
  const k = (size * scale) / (2 * (MARK.ring.r + MARK.ring.w / 2));
  const c = size / 2;
  const at = (v) => v * k;

  const ringHw = Math.max(0.55, at(MARK.ring.w) * boost) / 2;

  const shapes = [
    {
      kind: 'arc',
      cx: c, cy: c,
      r: at(MARK.ring.r),
      a0: MARK.ring.a0,
      sweep: MARK.ring.sweep,
      hw: ringHw,
    },
    {
      kind: 'disc',
      cx: c + at(MARK.ring.r) * Math.cos(MARK.ring.a0 + MARK.ring.sweep),
      cy: c + at(MARK.ring.r) * Math.sin(MARK.ring.a0 + MARK.ring.sweep),
      r: Math.max(ringHw * 1.35, at(MARK.head) * boost),
    },
  ];

  if (figure) {
    const R = at(MARK.figure);
    const place = (pts) => pts.map(([x, y]) => [c + x * R, c + y * R]);
    if (R >= MARK.minFacetPx) {
      const gap = Math.max(MARK.gapMinPx, R * MARK.gapK);
      for (const f of ICO) shapes.push({ kind: 'poly', pts: shrink(place(f), gap) });
    } else {
      // Un pelo de holgura contra el anillo, para que no se toquen.
      shapes.push({ kind: 'poly', pts: shrink(place(ICO_HULL), 0.4) });
    }
  }
  return shapes;
}

/* ==========================================================================
   Rasterizado
   ==========================================================================
   Campo de distancias en vez de supermuestreo: para discos, arcos de extremo
   redondeado y poligonos la distancia exacta se calcula en cerrado, asi que el
   antialiasing sale de un solo `clamp` por pixel.
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
 * Distancia a un arco de extremos redondeados.
 *
 * Dentro del barrido es la distancia a la circunferencia; fuera, la del
 * extremo mas cercano — que es justo lo que redondea las puntas sin tener que
 * dibujarlas aparte.
 */
function arcDist(px, py, s) {
  const dx = px - s.cx, dy = py - s.cy;
  let delta = (Math.atan2(dy, dx) - s.a0) % TAU;
  if (delta < 0) delta += TAU;
  if (delta <= s.sweep) return Math.abs(Math.hypot(dx, dy) - s.r) - s.hw;

  const ends = [s.a0, s.a0 + s.sweep].map((a) => [
    s.cx + s.r * Math.cos(a),
    s.cy + s.r * Math.sin(a),
  ]);
  return Math.min(...ends.map(([ex, ey]) => Math.hypot(px - ex, py - ey))) - s.hw;
}

/** Distancia con signo a un poligono: negativa dentro. */
function polyDist(px, py, s) {
  let d = Infinity;
  let inside = false;
  const P = s.pts;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const a = P[i], b = P[j];
    d = Math.min(d, segDist(px, py, a[0], a[1], b[0], b[1]));
    if (
      (a[1] > py) !== (b[1] > py) &&
      px < ((b[0] - a[0]) * (py - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      inside = !inside;
    }
  }
  return inside ? -d : d;
}

function shapeDist(px, py, s) {
  if (s.kind === 'arc') return arcDist(px, py, s);
  if (s.kind === 'disc') return Math.hypot(px - s.cx, py - s.cy) - s.r;
  return polyDist(px, py, s);
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

/**
 * Dibuja el conjunto de trazos en una sola pasada.
 * @param tint  funcion (yNorm) -> [r,g,b] en 0..1, el degradado vertical
 */
function paintShapes(cv, shapes, tint) {
  const { size } = cv;
  for (let y = 0; y < size; y++) {
    const py = y + 0.5;
    const [r, g, b] = tint(y / (size - 1));
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      let d = Infinity;
      for (const s of shapes) {
        const dd = shapeDist(px, py, s);
        if (dd < d) d = dd;
      }
      const a = clamp01(0.5 - d);
      if (a > 0) composite(cv, (y * size + x) * 4, r, g, b, a);
    }
  }
}

/* ==========================================================================
   Composicion
   ========================================================================== */

const HOLO_TOP = [0x7e / 255, 0xf0 / 255, 0xff / 255]; // cian claro
const HOLO_BOT = [0x00 / 255, 0xd4 / 255, 0x92 / 255]; // verde de marca
const gradient = (t) => [
  lerp(HOLO_TOP[0], HOLO_BOT[0], t),
  lerp(HOLO_TOP[1], HOLO_BOT[1], t),
  lerp(HOLO_TOP[2], HOLO_BOT[2], t),
];

function paintMark(cv, opts = {}) {
  const { scale = 0.74, tint = gradient, ...rest } = opts;
  paintShapes(cv, markShapes(cv.size, scale, rest), tint);
}

/**
 * Version para el badge de la barra de estado.
 *
 * Ahi el icono acaba en unos 24 px reales y el sistema lo trata como mascara:
 * ignora el color y pinta solo lo que marque el canal alfa. El icosaedro a ese
 * tamano es una mancha, asi que se queda el anillo con su cabeza —la silueta
 * que de verdad se reconoce— en blanco liso.
 */
function paintBadge(cv, { scale = 0.94 } = {}) {
  paintShapes(cv, markShapes(cv.size, scale, { boost: 1.45, figure: false }), () => [1, 1, 1]);
}

/* ==========================================================================
   Fondos
   ========================================================================== */

/**
 * Cuadrado de esquinas redondeadas, oscuro y liso.
 *
 * Solo un degradado muy leve para que no parezca un recorte de cartulina: el
 * color lo pone la figura.
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
      raw[o++] = Math.round(clamp01(px[i])     * 255);
      raw[o++] = Math.round(clamp01(px[i + 1]) * 255);
      raw[o++] = Math.round(clamp01(px[i + 2]) * 255);
      raw[o++] = Math.round(clamp01(px[i + 3]) * 255);
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
   SVG
   ========================================================================== */

const f2 = (n) => Number(n.toFixed(2));
const polyPoints = (pts) => pts.map(([x, y]) => `${f2(x)},${f2(y)}`).join(' ');

/**
 * La marca en vectorial, sobre un lienzo de 64.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.plate]  placa oscura de fondo
 * @param {boolean} [opts.facets] caras talladas, o silueta lisa
 * @param {boolean} [opts.animate] clases y grupos para la animacion de la app
 */
function markSvg({ plate = true, facets = false, animate = false, scale = 0.74 } = {}) {
  const S = 64;
  // Se pide el dibujo al mismo sitio que los PNG: un solo juego de numeros.
  const shapes = markShapes(S, scale, { figure: false });
  const arc = shapes.find((s) => s.kind === 'arc');
  const head = shapes.find((s) => s.kind === 'disc');

  // `markShapes` decide facetas o silueta por el tamano en pixeles; aqui manda
  // el destino, asi que la figura se rehace con la variante pedida.
  const R = ((S * scale) / (2 * (MARK.ring.r + MARK.ring.w / 2))) * MARK.figure;
  const place = (pts) => pts.map(([x, y]) => [S / 2 + x * R, S / 2 + y * R]);
  const figure = facets
    ? ICO.map(
        (fc, i) =>
          `<polygon class="face f${i + 1}" points="${polyPoints(shrink(place(fc), R * MARK.gapK))}"/>`,
      ).join('')
    : `<polygon class="face" points="${polyPoints(shrink(place(ICO_HULL), R * 0.033))}"/>`;

  const pt = (a) => [f2(arc.cx + arc.r * Math.cos(a)), f2(arc.cy + arc.r * Math.sin(a))];
  const [sx, sy] = pt(arc.a0);
  const [ex, ey] = pt(arc.a0 + arc.sweep);
  // El barrido es de 270 grados: arco mayor (1) y sentido horario (1).
  const ring =
    `<path class="ring" d="M ${sx} ${sy} A ${f2(arc.r)} ${f2(arc.r)} 0 1 1 ${ex} ${ey}"/>`;

  // En la app la cabeza nace arriba —donde arranca el anillo— y gira hasta su
  // sitio; en el favicon ya esta puesta.
  const headEl = animate
    ? `<g class="head-g"><circle class="head" cx="${f2(arc.cx)}" cy="${f2(arc.cy - arc.r)}" r="${f2(head.r)}"/></g>`
    : `<circle class="head" cx="${f2(head.cx)}" cy="${f2(head.cy)}" r="${f2(head.r)}"/>`;

  if (animate) {
    return `<svg class="mark draw" viewBox="0 0 ${S} ${S}" aria-hidden="true">
  ${ring}
  <g class="faces">${figure.replace(/></g, '>\n    <')}</g>
  ${headEl}
</svg>`;
  }

  const bg = plate ? `<rect width="${S}" height="${S}" rx="${S * 0.22}" fill="url(#p)"/>` : '';
  const plateDef = plate
    ? `
  <linearGradient id="p" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#141c27"/><stop offset="1" stop-color="#080b10"/>
  </linearGradient>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">
<!-- Bambustatus. Generado por tools/make-icons.mjs. No editar a mano. -->
<defs>
  <linearGradient id="e" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#7ef0ff"/><stop offset="1" stop-color="#00d492"/>
  </linearGradient>${plateDef}
</defs>
${bg}
<g fill="url(#e)">
  ${ring.replace('class="ring"', `fill="none" stroke="url(#e)" stroke-width="${f2(arc.hw * 2)}" stroke-linecap="round"`)}
  ${figure.replace(/class="face[^"]*"/g, '')}
  ${headEl.replace('class="head"', 'fill="#7ef0ff"')}
</g>
</svg>
`;
}

/* ==========================================================================
   Salida
   ========================================================================== */

mkdirSync(OUT, { recursive: true });
console.log('Generando iconos de Bambustatus en public/');

// --- Iconos de la app: figura sobre placa oscura ---------------------------
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512]]) {
  const cv = canvas(size);
  paintPlate(cv);
  paintMark(cv, { scale: 0.7 });
  write(name, cv);
}

// Maskable: Android recorta hasta un circulo inscrito, asi que la figura se
// encoge al 54% y el fondo llega a los bordes sin esquinas redondeadas.
{
  const cv = canvas(512);
  paintPlate(cv, { rounding: 0 });
  paintMark(cv, { scale: 0.54 });
  write('icon-maskable-512.png', cv);
}

// iOS redondea el apple-touch por su cuenta y no admite transparencia.
{
  const cv = canvas(180);
  paintPlate(cv, { rounding: 0 });
  paintMark(cv, { scale: 0.68 });
  write('apple-touch-icon.png', cv);
}

// Respaldo del favicon para navegadores sin SVG. A 32 px las caras no caben:
// `markShapes` cae solo a la silueta, y el trazo del anillo engorda un poco.
{
  const cv = canvas(32);
  paintPlate(cv, { rounding: 0.22 });
  paintMark(cv, { scale: 0.78, boost: 1.12 });
  write('favicon-32.png', cv);
}

// --- Notificacion: la misma figura, sin placa -----------------------------
// Android la pinta sobre la tarjeta del sistema, que puede ser clara u oscura
// segun el tema. Sin fondo y con el trazo algo mas grueso se lee en las dos.
{
  const cv = canvas(192);
  paintMark(cv, { scale: 0.88, boost: 1.1 });
  write('notify-icon.png', cv);
}

// El badge de la barra de estado es una mascara: el sistema ignora el color y
// pinta solo la silueta del canal alfa, asi que va en blanco liso.
{
  const cv = canvas(96);
  paintBadge(cv);
  write('badge-96.png', cv);
}

// El favicon vectorial vive en la pestana, o sea a 16-20 px: la silueta, igual
// que su respaldo en PNG.
writeFileSync(join(OUT, 'favicon.svg'), markSvg({ plate: true, facets: false }));
console.log('  favicon.svg');

// --- Fragmento para la pantalla de carga y la puerta -----------------------
// La app lo lleva incrustado en public/index.html: ahi la marca se pinta a
// 150-196 px y si tiene caras. Se imprime para poder copiarlo cuando la
// geometria cambie, en vez de mantener dos juegos de numeros a mano.
if (process.argv.includes('--fragment')) {
  console.log('\n--- fragmento SVG para public/index.html ---\n');
  console.log(markSvg({ animate: true, facets: true }));
}
console.log('Listo.');

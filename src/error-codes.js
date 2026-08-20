/**
 * Traduccion de codigos de error de Bambu Lab a lenguaje humano.
 *
 * De donde sale
 * -------------
 * `data/bambu-errors.json` lo genera `tools/fetch-error-codes.mjs` desde
 * https://e.bambulab.com/query.php, que es la misma fuente que alimenta el
 * buscador de errores de la web de soporte y la app Handy. Va versionado en
 * git para que el catalogo este disponible desde el primer arranque, sin red:
 * el momento en que hace falta traducir un error es justo el peor momento para
 * depender de que una peticion externa responda.
 *
 * Que devuelve
 * ------------
 * Para cada codigo, tres cosas:
 *
 *   description  el texto oficial de Bambu, tal cual (en espanol)
 *   remedy       una linea de "que hacer", deducida de ese texto
 *   url          la ficha oficial del codigo, por si hace falta el detalle
 *
 * Sobre `remedy`: Bambu no publica la solucion dentro de este catalogo, solo
 * la causa. La linea de accion se deduce aqui con reglas sobre el texto
 * oficial (filamento agotado -> "carga una bobina", conector con mal contacto
 * -> "revisa el conector"...). Es una guia breve para no tener que ponerse a
 * buscar; el detalle completo sigue estando en `url`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_FILE =
  process.env.ERROR_CODES_FILE || path.join(__dirname, '..', 'data', 'bambu-errors.json');

/** Idioma de las fichas de soporte enlazadas. */
const SUPPORT_LOCALE = process.env.BAMBU_SUPPORT_LOCALE || 'es-es';
const SUPPORT_BASE = `https://bambulab.com/${SUPPORT_LOCALE}/support`;

const SEVERITY = {
  1: { key: 'fatal', label: 'fatal' },
  2: { key: 'serious', label: 'grave' },
  3: { key: 'common', label: 'aviso' },
  4: { key: 'info', label: 'informativo' },
};

/**
 * Reglas de "que hacer", en orden: gana la primera que encaje.
 *
 * Se evaluan contra el texto oficial en minusculas y sin acentos, para que
 * "camara" o "senal" no dependan de como venga escrito. El orden importa: lo
 * especifico (filamento agotado) va antes que lo generico (hay un motor
 * implicado), porque casi todos los textos mencionan varias cosas a la vez.
 */
const RULES = [
  {
    test: /agotad|se ha acabado|sin filamento|no hay filamento/,
    remedy: 'Carga una bobina nueva en esa ranura y reanuda desde la impresora.',
  },
  {
    test: /(atasc|obstru)[^.]*(boquilla|extrusor|cabezal|hotend)|(boquilla|extrusor|cabezal)[^.]*(atasc|obstru)/,
    remedy: 'Descarga el filamento y limpia la boquilla con la aguja antes de reanudar.',
  },
  {
    test: /\brot[oa]\b|se ha partido|partido dentro/,
    remedy: 'Retira el trozo de filamento roto del tubo y del extrusor, y vuelve a cargarlo.',
  },
  {
    test: /atasc|obstru|enred|no puede avanzar|no se puede sacar|no se pudo sacar/,
    remedy: 'Revisa el recorrido del filamento y desenreda la bobina; luego reanuda.',
  },
  {
    test: /no coincide|distinto del|diferente al|no corresponde/,
    remedy: 'El filamento cargado no es el del corte: corrigelo en el AMS o en el trabajo.',
  },
  {
    test: /desliza|patina|rueda de extrusion/,
    remedy: 'Comprueba que el filamento entra sin forzar y limpia la rueda de extrusion.',
  },
  {
    // "humedad" a secas no vale: casi todos los sensores del AMS son de
    // temperatura Y humedad, y sus averias no se arreglan con desecante.
    test: /desecante|filamento (esta )?(humed|mojad)|secado del filamento|demasiada humedad/,
    remedy: 'Cambia el desecante del AMS y seca el filamento antes de seguir.',
  },
  {
    test: /bobina|carrete/,
    remedy: 'Revisa que la bobina gire libre y este bien asentada en la ranura.',
  },
  {
    test: /cuchilla|corte de filamento/,
    remedy: 'Revisa la cuchilla de corte y retira los restos de filamento.',
  },
  {
    test: /cortocircuito|circuito abierto|danad|quemad/,
    remedy: 'Apaga la impresora y no la uses hasta revisar esa pieza: puede ser un fallo electrico.',
  },
  {
    // Antes que la regla de temperatura: casi todo aviso de ventilador habla
    // tambien de "temperatura" (es lo que sube cuando el ventilador no tira).
    test: /ventilador/,
    remedy: 'Comprueba que el ventilador gira libre y sin polvo ni restos de filamento.',
  },
  {
    // Y antes tambien el sensor combinado del AMS: mide temperatura y humedad,
    // pero cuando falla no hay nada que enfriar ni que secar, solo el chip.
    test: /sensor de temperatura y humedad/,
    remedy: 'Limpia el sensor y revisa su conexion; si persiste, hara falta sustituirlo.',
  },
  {
    test: /temperatura|calentad|calefactor|calienta|termistor|sobrecalent/,
    remedy: 'Deja enfriar la maquina y revisa el termistor y el calentador antes de imprimir.',
  },
  {
    test: /conector|contacto deficiente|mal contacto|\bcable\b|cableado/,
    remedy: 'Apaga la impresora y comprueba que ese conector este bien encajado.',
  },
  {
    test: /odometro|no emite senal|sin senal|sensor/,
    remedy: 'Limpia el sensor y revisa su conexion; si persiste, hara falta sustituirlo.',
  },
  {
    test: /placa base|placa principal|placa ac|placa de control/,
    remedy: 'Es un fallo de la placa: anota el codigo y abre un ticket con el soporte de Bambu Lab.',
  },
  {
    test: /nivelaci|placa de impresion|placa de construccion|cama caliente|plataforma de impresion|primera capa/,
    remedy: 'Limpia la placa, comprueba que este bien colocada y repite la calibracion de la cama.',
  },
  {
    test: /correa|\beje\b|\bejes\b|carro|riel|guia lineal/,
    remedy: 'Apaga la impresora y comprueba la tension de las correas y que los ejes no rocen.',
  },
  {
    test: /\bmotor\b|paso perdido/,
    remedy: 'Apaga la impresora, comprueba que nada bloquee ese mecanismo y vuelve a encender.',
  },
  {
    test: /camara|lidar|laser|escane/,
    remedy: 'Limpia la lente con un pano seco y repite la calibracion.',
  },
  {
    test: /wi-?fi|\bred\b|conexion|desconect|tiempo de espera|comunicac|servidor|mqtt/,
    remedy: 'Comprueba la Wi-Fi de la impresora y del router, y reintenta.',
  },
  {
    test: /firmware|actualiza|version/,
    remedy: 'Actualiza el firmware de la impresora desde Bambu Studio o Handy.',
  },
  {
    test: /alimentacion|voltaje|fuente de|corriente/,
    remedy: 'Revisa el cable de corriente y que la impresora reciba alimentacion estable.',
  },
  {
    test: /tarjeta|micro ?sd|almacenamiento/,
    remedy: 'Saca la microSD, comprueba que no este protegida contra escritura y reinsertala.',
  },
  {
    test: /tapa|puerta|cubierta/,
    remedy: 'Cierra la tapa o la puerta y reintenta.',
  },
];

/** Cuando ninguna regla encaja, al menos se dice cuanta prisa corre. */
const FALLBACK = {
  fatal: 'Detén la impresión y revisa la ficha oficial antes de volver a usar la máquina.',
  serious: 'Revisa la impresora antes de reanudar; la ficha oficial detalla los pasos.',
  common: 'No requiere acción inmediata; la ficha oficial explica el detalle.',
  info: 'Solo informativo: no hay nada que hacer.',
};

// Marcas diacriticas sueltas tras normalizar: se escriben con escapes para
// que ningun editor las funda con la letra anterior al guardar el fichero.
const COMBINING = new RegExp('[\\u0300-\\u036f]', 'g');

function deaccent(text) {
  return text.normalize('NFD').replace(COMBINING, '');
}

// ---------------------------------------------------------------------------
// Carga del catalogo
// ---------------------------------------------------------------------------

function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return {
      hms: db.hms || {},
      print: db.print || {},
      version: db.version || null,
      lang: db.lang || 'es',
    };
  } catch (err) {
    // Sin catalogo la app sigue funcionando: se avisa con el codigo pelado,
    // que es exactamente lo que hacia antes de existir este modulo.
    console.error(`[errores] no se pudo leer ${DB_FILE}: ${err.message}`);
    return { hms: {}, print: {}, version: null, lang: 'es' };
  }
}

const db = loadDb();

export const ERROR_DB_INFO = {
  version: db.version,
  lang: db.lang,
  hmsCount: Object.keys(db.hms).length,
  printCount: Object.keys(db.print).length,
};

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

/** "1806_3500_0001_0001" en mayusculas, venga como venga. */
function normalizeHmsId(id) {
  const hex = String(id || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (hex.length !== 16) return null;
  return hex.match(/.{4}/g).join('_');
}

function remedyFor(description, severityKey) {
  const haystack = deaccent(String(description || '')).toLowerCase();
  if (haystack) {
    for (const rule of RULES) {
      if (rule.test.test(haystack)) return rule.remedy;
    }
  }
  return FALLBACK[severityKey] || FALLBACK.serious;
}

/**
 * Traduce un codigo HMS.
 *
 * @param {string} id  formato canonico "XXXX_XXXX_XXXX_XXXX"
 * @param {number} [severity] la que trae el report; si falta se saca del codigo
 */
export function lookupHms(id, severity) {
  const key = normalizeHmsId(id);
  const description = key ? db.hms[key] || null : null;

  // El tercer grupo del codigo ES la severidad: si el report no la trae, o
  // trae algo fuera de rango, se lee de ahi antes de dar por buena la 2.
  const fromCode = key ? parseInt(key.split('_')[2], 16) : NaN;
  const sev = SEVERITY[severity] ? severity : SEVERITY[fromCode] ? fromCode : 2;
  const meta = SEVERITY[sev];

  return {
    id: key || String(id || ''),
    description,
    remedy: remedyFor(description, meta.key),
    severity: sev,
    severityKey: meta.key,
    severityLabel: meta.label,
    known: Boolean(description),
    url: `${SUPPORT_BASE}/hms/${key || id}`,
  };
}

/**
 * Traduce un codigo de error de impresion (`print.print_error`).
 *
 * @param {number|string} code el numero crudo del report; 0 = sin error
 */
export function lookupPrintError(code) {
  const n = Number(code);
  if (!Number.isFinite(n) || n === 0) return null;
  const key = (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const description = db.print[key] || null;
  return {
    code: key,
    description,
    remedy: remedyFor(description, 'serious'),
    known: Boolean(description),
    url: `${SUPPORT_BASE}/print-error/${key}`,
  };
}

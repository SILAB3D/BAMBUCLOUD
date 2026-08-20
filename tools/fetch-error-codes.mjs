/**
 * Descarga el catalogo oficial de codigos de error de Bambu Lab y lo deja en
 * data/bambu-errors.json.
 *
 * Es la MISMA fuente que alimenta el buscador de errores de la web de soporte
 * (https://bambulab.com/en/support/hms) y la app Bambu Handy: un unico JSON
 * publico, sin clave ni cuenta, servido por e.bambulab.com.
 *
 *   node tools/fetch-error-codes.mjs [--lang es] [--out data/bambu-errors.json]
 *
 * El fichero resultante se versiona en git a proposito: asi el servidor
 * arranca con el catalogo completo sin depender de que la red responda, que es
 * justo el momento en que hay un error del que informar. Para actualizarlo
 * basta con volver a ejecutar esto y confirmar el cambio.
 *
 * Estructura de la respuesta original:
 *   data.device_hms.<lang>[]   -> { ecode: "1806350000010001", intro: "..." }
 *   data.device_error.<lang>[] -> { ecode: "18048003",         intro: "..." }
 *
 * `device_hms` son los codigos HMS (los que la impresora publica en print.hms);
 * `device_error` son los codigos de error de impresion (print.print_error).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const LANG = arg('lang', 'es');
const OUT = path.resolve(__dirname, '..', arg('out', 'data/bambu-errors.json'));
const URL_BASE = 'https://e.bambulab.com/query.php';

/** "1806350000010001" -> "1806_3500_0001_0001", que es como lo forma normalize(). */
function hmsKey(ecode) {
  const hex = String(ecode).trim().toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(hex)) return null;
  return hex.match(/.{4}/g).join('_');
}

/** Los codigos de impresion van en 8 hex, que es como se imprime print_error. */
function printKey(ecode) {
  const hex = String(ecode).trim().toUpperCase();
  return /^[0-9A-F]{8}$/.test(hex) ? hex : null;
}

/** Espacios dobles, saltos y comillas raras fuera: esto acaba en un push. */
function clean(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const url = `${URL_BASE}?lang=${encodeURIComponent(LANG)}`;
  process.stdout.write(`Descargando ${url}\n`);

  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.result !== 0) throw new Error(`la API devolvio result=${json.result}`);

  const hmsList = json.data?.device_hms?.[LANG] || [];
  const errList = json.data?.device_error?.[LANG] || [];
  if (!hmsList.length) throw new Error(`no hay codigos HMS para el idioma "${LANG}"`);

  const hms = {};
  let skipped = 0;
  for (const entry of hmsList) {
    const key = hmsKey(entry.ecode);
    if (!key) { skipped++; continue; }
    const intro = clean(entry.intro);
    if (intro) hms[key] = intro;
  }

  const print = {};
  for (const entry of errList) {
    const key = printKey(entry.ecode);
    if (!key) { skipped++; continue; }
    const intro = clean(entry.intro);
    if (intro) print[key] = intro;
  }

  // Claves ordenadas: sin esto el diff de cada actualizacion es el fichero
  // entero y no se ve que codigos ha tocado Bambu de verdad.
  const sorted = (obj) =>
    Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));

  const out = {
    source: URL_BASE,
    lang: LANG,
    version: json.data?.device_hms?.ver ?? json.ver ?? null,
    fetchedAt: new Date().toISOString(),
    hms: sorted(hms),
    print: sorted(print),
  };

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, `${JSON.stringify(out, null, 0)}\n`, 'utf8');

  const size = (await fs.stat(OUT)).size;
  process.stdout.write(
    `Escrito ${OUT}\n` +
      `  ${Object.keys(out.hms).length} codigos HMS\n` +
      `  ${Object.keys(out.print).length} codigos de error de impresion\n` +
      `  version ${out.version} · ${(size / 1024).toFixed(0)} KB` +
      (skipped ? ` · ${skipped} descartados por formato` : '') +
      '\n',
  );
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

/**
 * Descarga la tabla de codigos de error de la wiki de Bambu Lab y la deja en
 * data/bambu-wiki-errors.json.
 *
 *   node tools/fetch-wiki-error-codes.mjs [--lang es] [--out data/bambu-wiki-errors.json]
 *
 * Por que una segunda fuente
 * --------------------------
 * `fetch-error-codes.mjs` baja el catalogo de e.bambulab.com, que es completo
 * en HMS pero se deja fuera decenas de codigos de error de impresion: los que
 * la impresora enseña en su pantalla y llegan en `print.print_error`. Esos si
 * estan en https://wiki.bambulab.com/es/hms/error-code, en una tabla de dos
 * columnas (codigo y descripcion), y ademas su redaccion suele incluir ya el
 * "que hacer" ("...Por favor, limpie el filamento del conducto de residuos").
 *
 * El resultado se versiona en git igual que el otro catalogo: cuando hay un
 * error del que informar es el peor momento para depender de la red.
 *
 * Estructura de la pagina: HTML renderizado en servidor (Wiki.js), una fila
 * por codigo con la forma `0300-800A (0300800A)` en la primera celda. Se
 * descartan las filas cuya primera celda no sea un codigo — la tabla tiene
 * alguna erratas de edicion con la descripcion repetida en las dos columnas.
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
const OUT = path.resolve(__dirname, '..', arg('out', 'data/bambu-wiki-errors.json'));
const PAGE = `https://wiki.bambulab.com/${LANG}/hms/error-code`;

/** Entidades HTML que aparecen en la tabla; no hace falta un parser entero. */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ', hellip: '…',
};

function text(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (m, name) => ENTITIES[name] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** "0300-800A (0300800A)" -> "0300800A". */
function printKey(cell) {
  const m = /^([0-9A-F]{4})[-\s]?([0-9A-F]{4})\b/i.exec(cell.trim());
  return m ? (m[1] + m[2]).toUpperCase() : null;
}

async function main() {
  process.stdout.write(`Descargando ${PAGE}\n`);
  const res = await fetch(PAGE, {
    headers: { 'user-agent': 'bambucloud-error-codes/1.0' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const html = await res.text();

  const print = {};
  let skipped = 0;
  for (const [, row] of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1]));
    if (cells.length < 2) { skipped++; continue; }
    const key = printKey(cells[0]);
    if (!key || !cells[1]) { skipped++; continue; }
    print[key] = cells[1];
  }

  if (Object.keys(print).length < 50) {
    throw new Error(
      `solo se han extraido ${Object.keys(print).length} codigos: la pagina ha cambiado de formato`,
    );
  }

  const out = {
    source: PAGE,
    lang: LANG,
    fetchedAt: new Date().toISOString(),
    print: Object.fromEntries(Object.keys(print).sort().map((k) => [k, print[k]])),
  };

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, `${JSON.stringify(out, null, 0)}\n`, 'utf8');

  const size = (await fs.stat(OUT)).size;
  process.stdout.write(
    `Escrito ${OUT}\n` +
      `  ${Object.keys(out.print).length} codigos de error de impresion` +
      (skipped ? ` · ${skipped} filas descartadas` : '') +
      ` · ${(size / 1024).toFixed(0)} KB\n`,
  );
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

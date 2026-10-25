// Verifica las traducciones del panel (public/i18n/panel/*.json), igual que
// scripts/test-i18n.js hace con la landing:
//   1. Cada diccionario tiene exactamente las mismas claves en es / en / pt.
//   2. Las {variables} que usa una traducción en inglés/portugués existen también en la
//      versión en español (si no, tp() las dejaría sin reemplazar).
//   3. Toda clave que usa una pantalla (data-i18n*, tp(), tpn(), 'tablero.xxx' en el JS)
//      existe en los diccionarios que esa pantalla declara en data-paginas.
//
// Uso: node scripts/test-i18n-panel.js

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const DIR_DICT = path.join(PUBLIC, 'i18n', 'panel');
const IDIOMAS = ['es', 'en', 'pt'];

let errores = 0;
function fallo(mensaje) {
  errores++;
  console.error(`FALLÓ: ${mensaje}`);
}

// ---------- 1 y 2: paridad de claves y de variables ----------
const diccionarios = {}; // { pagina: { es: {...}, en: {...}, pt: {...} } }
for (const archivo of fs.readdirSync(DIR_DICT)) {
  const match = archivo.match(/^(.+)\.(es|en|pt)\.json$/);
  if (!match) continue;
  const [, pagina, idioma] = match;
  diccionarios[pagina] = diccionarios[pagina] || {};
  try {
    diccionarios[pagina][idioma] = JSON.parse(fs.readFileSync(path.join(DIR_DICT, archivo), 'utf8'));
  } catch (err) {
    fallo(`${archivo} no es un JSON válido (${err.message})`);
  }
}

const variablesDe = (texto) => new Set([...String(texto).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

for (const [pagina, porIdioma] of Object.entries(diccionarios)) {
  for (const idioma of IDIOMAS) {
    if (!porIdioma[idioma]) fallo(`falta ${pagina}.${idioma}.json`);
  }
  const base = porIdioma.es;
  if (!base) continue;
  for (const idioma of ['en', 'pt']) {
    const otro = porIdioma[idioma];
    if (!otro) continue;
    for (const clave of Object.keys(base)) {
      if (!(clave in otro)) fallo(`${pagina}.${idioma}.json no tiene la clave "${clave}"`);
    }
    for (const clave of Object.keys(otro)) {
      if (!(clave in base)) fallo(`${pagina}.${idioma}.json tiene la clave "${clave}" que no está en el español`);
    }
    for (const clave of Object.keys(base)) {
      if (!(clave in otro)) continue;
      const varsEs = variablesDe(base[clave]);
      for (const v of variablesDe(otro[clave])) {
        if (!varsEs.has(v)) fallo(`${pagina}.${idioma}.json "${clave}" usa {${v}} que no existe en el español`);
      }
    }
  }
}
console.log(`Diccionarios revisados: ${Object.keys(diccionarios).join(', ')}`);

// ---------- 3: claves usadas por cada pantalla ----------
const prefijos = new Set();
for (const porIdioma of Object.values(diccionarios)) {
  for (const clave of Object.keys(porIdioma.es || {})) prefijos.add(clave.split('.')[0]);
}
const RE_CLAVE = new RegExp(`['"\`]((?:${[...prefijos].join('|')})\\.[a-z0-9_]+)['"\`]`, 'g');

const paginasHtml = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
for (const html of paginasHtml) {
  const contenido = fs.readFileSync(path.join(PUBLIC, html), 'utf8');
  const declaracion = contenido.match(/panel-i18n\.js"[^>]*data-paginas="([^"]+)"/);
  if (!declaracion) continue; // pantalla que todavía no usa el panel i18n

  const paginas = declaracion[1].split(',').map((p) => p.trim());
  const clavesDisponibles = new Set();
  for (const p of paginas) {
    if (!diccionarios[p]) { fallo(`${html} declara la página "${p}" pero no hay public/i18n/panel/${p}.es.json`); continue; }
    for (const clave of Object.keys(diccionarios[p].es || {})) clavesDisponibles.add(clave);
  }

  // Los textos del propio HTML + los scripts propios de la pantalla (js/*.js que enlaza).
  const fuentes = [{ nombre: html, texto: contenido }];
  for (const [, src] of contenido.matchAll(/<script src="\/js\/([\w.-]+\.js)"/g)) {
    if (src === 'panel-i18n.js' || src === 'fronty.js') continue; // fronty.js trae su propio diccionario (se revisa abajo)
    const ruta = path.join(PUBLIC, 'js', src);
    if (fs.existsSync(ruta)) fuentes.push({ nombre: `js/${src}`, texto: fs.readFileSync(ruta, 'utf8') });
  }

  let usadas = 0;
  for (const { nombre, texto } of fuentes) {
    for (const [, clave] of texto.matchAll(RE_CLAVE)) {
      usadas++;
      const existe =
        clavesDisponibles.has(clave) ||
        (clavesDisponibles.has(`${clave}_uno`) && clavesDisponibles.has(`${clave}_otros`));
      if (!existe) fallo(`${nombre} usa la clave "${clave}" que no está en los diccionarios de ${html} (${paginas.join(', ')})`);
    }
  }
  console.log(`OK: ${html} - ${usadas} usos de claves revisados`);
}

// fronty.js carga solo fronty.<idioma>.json: sus claves tienen que estar en ese diccionario.
{
  const texto = fs.readFileSync(path.join(PUBLIC, 'js', 'fronty.js'), 'utf8');
  const disponibles = new Set(Object.keys(diccionarios.fronty?.es || {}));
  let usadas = 0;
  for (const [, clave] of texto.matchAll(/['"`](fronty\.[a-z0-9_]+)['"`]/g)) {
    usadas++;
    if (!disponibles.has(clave)) fallo(`js/fronty.js usa la clave "${clave}" que no está en fronty.es.json`);
  }
  console.log(`OK: js/fronty.js - ${usadas} usos de claves revisados`);
}

if (errores) {
  console.error(`\n${errores} problema(s).`);
  process.exit(1);
}
console.log('\nTodo OK.');

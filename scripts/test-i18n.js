// Verifica el sistema de idiomas de la landing sin necesitar un navegador:
// 1. Que los 3 diccionarios (public/i18n/*.json) tengan exactamente las mismas keys - si a
//    alguno le falta una traducción, el fallback de t() en public/js/planes.js la muestra
//    cruda en pantalla en vez de romper la página, pero mejor detectarlo acá antes.
// 2. Que la detección de idioma por país (server/routes/public.js,
//    idiomaSugeridoPorPais) responda bien para países de varios continentes - simula lo
//    que haría geoip-lite con una IP real de cada país, sin depender de tener una IP de
//    ejemplo real de cada lugar a mano.
//
// Uso: node scripts/test-i18n.js

require('dotenv').config(); // public.js arrastra db.js, que exige MONGODB_URI al cargarse
const fs = require('fs');
const path = require('path');
const { idiomaSugeridoPorPais } = require('../server/routes/public');

function assert(cond, mensaje) {
  if (!cond) throw new Error(`FALLÓ: ${mensaje}`);
  console.log(`OK: ${mensaje}`);
}

function todasLasKeys(obj, prefijo = '') {
  let keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefijo ? `${prefijo}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys = keys.concat(todasLasKeys(v, key));
    } else {
      keys.push(key);
    }
  }
  return keys;
}

function main() {
  console.log('--- 1. Los 3 diccionarios tienen las mismas keys ---');
  const idiomas = ['es', 'en', 'pt'];
  const dict = {};
  for (const idioma of idiomas) {
    dict[idioma] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n', `${idioma}.json`), 'utf-8'));
  }
  const keysEs = todasLasKeys(dict.es).sort();
  for (const idioma of ['en', 'pt']) {
    const keysOtro = todasLasKeys(dict[idioma]).sort();
    const faltantes = keysEs.filter((k) => !keysOtro.includes(k));
    const sobrantes = keysOtro.filter((k) => !keysEs.includes(k));
    assert(faltantes.length === 0, `${idioma}.json no le falta ninguna key de es.json (faltan: ${faltantes.join(', ') || 'ninguna'})`);
    assert(sobrantes.length === 0, `${idioma}.json no tiene keys de más (de más: ${sobrantes.join(', ') || 'ninguna'})`);
  }

  console.log('\n--- 2. Detección de idioma por país, varios continentes ---');
  const casos = [
    ['AR', 'es', 'Argentina'],
    ['MX', 'es', 'México'],
    ['ES', 'es', 'España'],
    ['BR', 'pt', 'Brasil'],
    ['US', 'en', 'Estados Unidos'],
    ['GB', 'en', 'Reino Unido'],
    ['DE', 'en', 'Alemania (sin traducción propia, cae a inglés)'],
    ['JP', 'en', 'Japón (sin traducción propia, cae a inglés)'],
    ['ZA', 'en', 'Sudáfrica (sin traducción propia, cae a inglés)'],
    [null, 'es', 'IP no identificable (local, VPN, etc.)']
  ];
  for (const [pais, esperado, etiqueta] of casos) {
    const resultado = idiomaSugeridoPorPais(pais);
    assert(resultado === esperado, `${etiqueta} (${pais || 'sin país'}) sugiere "${esperado}" (dio "${resultado}")`);
  }

  console.log('\nTodo OK.');
}

main();

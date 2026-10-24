// Arma un favicon.ico real (contenedor ICO con los PNG de 16/32/48 embebidos adentro,
// formato soportado desde Windows Vista / todos los navegadores actuales) a partir de los
// PNG que Hugo ya tiene diseñados - no hay forma de hacer esto con un simple "renombrar a
// .ico", el contenedor ICO tiene su propio header binario.
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const entradas = [
  { tam: 16, archivo: 'favicon-16x16.png' },
  { tam: 32, archivo: 'favicon-32x32.png' },
  { tam: 48, archivo: 'favicon-48x48-tmp.png' }
];

const imagenes = entradas.map((e) => ({ ...e, data: fs.readFileSync(path.join(PUBLIC, e.archivo)) }));

const headerSize = 6;
const dirEntrySize = 16;
let offset = headerSize + dirEntrySize * imagenes.length;

const header = Buffer.alloc(headerSize);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: 1 = ico
header.writeUInt16LE(imagenes.length, 4);

const dirEntries = [];
for (const img of imagenes) {
  const entry = Buffer.alloc(dirEntrySize);
  entry.writeUInt8(img.tam, 0); // width (256 se escribe como 0, no aplica acá)
  entry.writeUInt8(img.tam, 1); // height
  entry.writeUInt8(0, 2); // color palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(img.data.length, 8); // tamaño del PNG embebido
  entry.writeUInt32LE(offset, 12); // dónde empieza ese PNG en el archivo
  offset += img.data.length;
  dirEntries.push(entry);
}

const salida = Buffer.concat([header, ...dirEntries, ...imagenes.map((i) => i.data)]);
fs.writeFileSync(path.join(PUBLIC, 'favicon.ico'), salida);
console.log(`favicon.ico armado (${salida.length} bytes, ${imagenes.length} tamaños).`);

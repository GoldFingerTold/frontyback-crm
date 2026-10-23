// Interactividad puramente decorativa de la landing (no toca planes/alta/idioma, eso vive
// en planes.js): el botón "Ver planes". La demo del tablero Kanban era una animación
// CSS/JS a mano, ahora es un video generado con IA (public/video/kanban-demo.mp4, <video>
// directo en index.html), no necesita lógica acá.

document.getElementById('btn-ver-planes')?.addEventListener('click', () => {
  document.getElementById('planes').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Interactividad puramente decorativa de la landing (no toca planes/alta/idioma, eso vive
// en planes.js): el botón "Ver planes" y la demo animada del tablero Kanban.

document.getElementById('btn-ver-planes')?.addEventListener('click', () => {
  document.getElementById('planes').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

(function iniciarDemoKanban() {
  const card = document.getElementById('kanban-card');
  const track = document.querySelector('.pl-kanban-demo');
  const columnas = [...document.querySelectorAll('.pl-kanban-col')];
  if (!card || !track || columnas.length !== 3) return;

  // Posiciona la tarjeta centrada sobre la columna "indice", calculando el "left" en vivo
  // contra el layout real (no porcentajes fijos a mano) - así funciona igual de bien en
  // mobile apilado que en desktop, y se recalcula solo si cambia el tamaño de pantalla.
  function moverA(indice) {
    const trackRect = track.getBoundingClientRect();
    const colRect = columnas[indice].getBoundingClientRect();
    const left = colRect.left - trackRect.left + (colRect.width - card.offsetWidth) / 2;
    card.style.left = `${Math.max(8, left)}px`;
  }

  // Ráfaga de puntitos dorados que salen desde el centro de la tarjeta y se desvanecen -
  // nada de librerías externas, son <span> con una animación CSS (@keyframes
  // pl-destello-vuelo en el <style> de index.html) que se autoeliminan al terminar.
  function destellosDorados() {
    const trackRect = track.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const cx = cardRect.left - trackRect.left + cardRect.width / 2;
    const cy = cardRect.top - trackRect.top + cardRect.height / 2;
    const cantidad = 22;
    for (let i = 0; i < cantidad; i++) {
      const particula = document.createElement('span');
      particula.className = 'pl-destello';
      const angulo = (Math.PI * 2 * i) / cantidad + Math.random() * 0.25;
      const distancia = 55 + Math.random() * 55;
      particula.style.left = `${cx}px`;
      particula.style.top = `${cy}px`;
      particula.style.setProperty('--tx', `${Math.cos(angulo) * distancia}px`);
      particula.style.setProperty('--ty', `${Math.sin(angulo) * distancia}px`);
      track.appendChild(particula);
      setTimeout(() => particula.remove(), 900);
    }
  }

  // Ciclo: nuevo lead -> en seguimiento -> venta cerrada (+ destellos) -> pausa oculta ->
  // vuelve a arrancar como un lead "nuevo" (no desliza para atrás, sería confuso - una
  // venta cerrada no "vuelve" a ser un lead nuevo, mejor que aparezca de nuevo).
  const PASOS = [
    { col: 0, espera: 2300 },
    { col: 1, espera: 2300 },
    { col: 2, espera: 1800, celebrar: true },
    { oculto: true, espera: 900 }
  ];
  let paso = 0;
  let pasoVisible = 0; // último índice de PASOS que dejó la tarjeta visible en una columna - lo usa el resize

  function siguientePaso() {
    const actual = PASOS[paso];
    if (actual.oculto) {
      card.classList.add('oculta');
    } else {
      card.classList.remove('oculta');
      moverA(actual.col);
      pasoVisible = paso;
      if (actual.celebrar) setTimeout(destellosDorados, 550);
    }
    paso = (paso + 1) % PASOS.length;
    setTimeout(siguientePaso, actual.espera);
  }

  window.addEventListener('resize', () => {
    if (!card.classList.contains('oculta')) moverA(PASOS[pasoVisible].col);
  });

  // Se espera a que el layout esté asentado (fuentes/imágenes) antes de la primera
  // posición, si no el cálculo de ancho de columna puede salir mal la primerísima vez.
  requestAnimationFrame(() => requestAnimationFrame(siguientePaso));
})();

(function () {
  "use strict";
  const script = document.currentScript;
  const materia = script && script.dataset.materia ? script.dataset.materia : "General";

  function crearAsistente() {
    if (document.getElementById("botonAsistenteIM3CB")) return;
    const boton = document.createElement("button");
    boton.id = "botonAsistenteIM3CB";
    boton.className = "burbuja-ia-im3cb";
    boton.type = "button";
    boton.title = "Toca para abrir o arrastra para mover";
    boton.setAttribute("aria-label", "Abrir asistente IM3CB IA");
    boton.setAttribute("aria-expanded", "false");
    boton.innerHTML = '<img src="logo-im3cb.jpeg?v=20260705" alt="">';

    const ventana = document.createElement("section");
    ventana.id = "ventanaAsistenteIM3CB";
    ventana.className = "ventana-ia-im3cb";
    ventana.setAttribute("aria-label", "Asistente académico IM3CB IA");
    ventana.innerHTML = '<div class="cabecera-ia-im3cb"><div><strong>IM<span>3</span>CB IA</strong><small></small></div><button type="button" aria-label="Cerrar asistente">×</button></div><iframe title="Chat con IM3CB IA" allow="clipboard-write"></iframe>';
    ventana.querySelector("small").textContent = materia;
    const iframe = ventana.querySelector("iframe");
    const llavePosicion = "im3cb_burbuja_ia_posicion";
    let arrastre = null;
    let seMovio = false;

    function alternar() {
      const abrir = !ventana.classList.contains("activa");
      ventana.classList.toggle("activa", abrir);
      boton.setAttribute("aria-expanded", String(abrir));
      if (abrir && !iframe.src) iframe.src = "https://im3cb-asistente-im3cb.hf.space/?materia=" + encodeURIComponent(materia);
    }

    function colocar(x, y) {
      const margen = 8;
      const posicion = {
        x: Math.max(margen, Math.min(x, innerWidth - boton.offsetWidth - margen)),
        y: Math.max(margen, Math.min(y, innerHeight - boton.offsetHeight - margen))
      };
      boton.style.left = `${posicion.x}px`;
      boton.style.top = `${posicion.y}px`;
      boton.style.right = "auto";
      boton.style.bottom = "auto";
      return posicion;
    }

    function guardarPosicion() {
      const rectangulo = boton.getBoundingClientRect();
      sessionStorage.setItem(llavePosicion, JSON.stringify({ x: rectangulo.left, y: rectangulo.top }));
    }

    function restaurarPosicion() {
      try {
        const posicion = JSON.parse(sessionStorage.getItem(llavePosicion));
        if (Number.isFinite(posicion?.x) && Number.isFinite(posicion?.y)) colocar(posicion.x, posicion.y);
      } catch (_) {}
    }

    boton.addEventListener("pointerdown", (evento) => {
      if (evento.button !== undefined && evento.button !== 0) return;
      const rectangulo = boton.getBoundingClientRect();
      arrastre = { id: evento.pointerId, inicioX: evento.clientX, inicioY: evento.clientY, desplazamientoX: evento.clientX - rectangulo.left, desplazamientoY: evento.clientY - rectangulo.top };
      seMovio = false;
      boton.setPointerCapture(evento.pointerId);
      boton.classList.add("arrastrando");
    });

    boton.addEventListener("pointermove", (evento) => {
      if (!arrastre || evento.pointerId !== arrastre.id) return;
      if (Math.hypot(evento.clientX - arrastre.inicioX, evento.clientY - arrastre.inicioY) > 5) seMovio = true;
      if (!seMovio) return;
      colocar(evento.clientX - arrastre.desplazamientoX, evento.clientY - arrastre.desplazamientoY);
      evento.preventDefault();
    });

    function terminarArrastre(evento) {
      if (!arrastre || evento.pointerId !== arrastre.id) return;
      if (seMovio) guardarPosicion();
      boton.classList.remove("arrastrando");
      arrastre = null;
    }

    boton.addEventListener("pointerup", terminarArrastre);
    boton.addEventListener("pointercancel", terminarArrastre);
    boton.addEventListener("click", (evento) => {
      if (seMovio) {
        evento.preventDefault();
        seMovio = false;
        return;
      }
      alternar();
    });
    ventana.querySelector(".cabecera-ia-im3cb > button").addEventListener("click", alternar);
    addEventListener("resize", () => {
      if (!boton.style.left) return;
      const rectangulo = boton.getBoundingClientRect();
      colocar(rectangulo.left, rectangulo.top);
      guardarPosicion();
    });
    document.body.append(boton, ventana);
    requestAnimationFrame(restaurarPosicion);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", crearAsistente);
  else crearAsistente();
})();

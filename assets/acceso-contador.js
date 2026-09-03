(() => {
  "use strict";

  const API = "https://script.google.com/macros/s/AKfycbwBK5q5_be0am3KBBqP5ZCse2c6sjT0ovFVGS1jnQyMKcZPoPeKGRjym8AE8wK69WtgBg/exec";
  const DURACION = 5 * 60 * 60 * 1000;
  const CURSOS = {
    "dibujo-asistido.html": "CAD",
    "instrumentacion.html": "INSTRUMENTACION",
    "termodinamica-2026.html": "TERMODINAMICA",
    "diseno-2.html": "DISENO2",
    "probabilidad-estadistica.html": "PROBABILIDAD",
    "circuitos-hidraulicos-neumaticos.html": "HIDRAULICA"
  };

  const archivo = location.pathname.split("/").pop() || "";
  const cursoEsperado = CURSOS[archivo];
  if (!cursoEsperado) return;

  const widget = document.createElement("aside");
  widget.className = "contador-acceso inactivo";
  widget.setAttribute("role", "status");
  widget.setAttribute("aria-live", "polite");
  widget.innerHTML = `
    <div class="contador-acceso__cabecera">
      <span class="contador-acceso__pulso"></span>
      <span class="contador-acceso__titulo">Acceso al curso</span>
      <span class="contador-acceso__mover" aria-hidden="true">⠿</span>
    </div>
    <div class="contador-acceso__tiempo">--:--:--</div>
    <div class="contador-acceso__mensaje">Comprobando la vigencia de tu acceso…</div>
    <div class="contador-acceso__barra"><span></span></div>`;
  document.body.appendChild(widget);

  const tiempo = widget.querySelector(".contador-acceso__tiempo");
  const mensaje = widget.querySelector(".contador-acceso__mensaje");
  let venceEn = 0;
  let reloj = null;

  const cabecera = widget.querySelector(".contador-acceso__cabecera");
  const posicionGuardada = `im3cb_contador_posicion_${cursoEsperado}`;
  let arrastre = null;

  function limitarPosicion(x, y) {
    const margen = 8;
    return {
      x: Math.max(margen, Math.min(x, innerWidth - widget.offsetWidth - margen)),
      y: Math.max(margen, Math.min(y, innerHeight - widget.offsetHeight - margen))
    };
  }

  function colocar(x, y) {
    const posicion = limitarPosicion(x, y);
    widget.style.left = `${posicion.x}px`;
    widget.style.top = `${posicion.y}px`;
    widget.style.right = "auto";
    widget.style.bottom = "auto";
    return posicion;
  }

  function restaurarPosicion() {
    try {
      const posicion = JSON.parse(sessionStorage.getItem(posicionGuardada));
      if (Number.isFinite(posicion?.x) && Number.isFinite(posicion?.y)) {
        colocar(posicion.x, posicion.y);
      }
    } catch (_) {}
  }

  cabecera.title = "Arrastra para mover el contador";
  cabecera.addEventListener("pointerdown", (evento) => {
    if (evento.button !== undefined && evento.button !== 0) return;
    const rectangulo = widget.getBoundingClientRect();
    arrastre = {
      id: evento.pointerId,
      desplazamientoX: evento.clientX - rectangulo.left,
      desplazamientoY: evento.clientY - rectangulo.top
    };
    cabecera.setPointerCapture(evento.pointerId);
    widget.classList.add("arrastrando");
    evento.preventDefault();
  });

  cabecera.addEventListener("pointermove", (evento) => {
    if (!arrastre || evento.pointerId !== arrastre.id) return;
    colocar(
      evento.clientX - arrastre.desplazamientoX,
      evento.clientY - arrastre.desplazamientoY
    );
  });

  function terminarArrastre(evento) {
    if (!arrastre || evento.pointerId !== arrastre.id) return;
    const rectangulo = widget.getBoundingClientRect();
    sessionStorage.setItem(posicionGuardada, JSON.stringify({
      x: rectangulo.left,
      y: rectangulo.top
    }));
    widget.classList.remove("arrastrando");
    arrastre = null;
  }

  cabecera.addEventListener("pointerup", terminarArrastre);
  cabecera.addEventListener("pointercancel", terminarArrastre);
  addEventListener("resize", () => {
    if (widget.style.left) {
      const rectangulo = widget.getBoundingClientRect();
      const posicion = colocar(rectangulo.left, rectangulo.top);
      sessionStorage.setItem(posicionGuardada, JSON.stringify(posicion));
    }
  });
  requestAnimationFrame(restaurarPosicion);

  function llaveActual() {
    return new URLSearchParams(location.search).get("llave") ||
      localStorage.getItem("im3cb_llave") || "";
  }

  function formato(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = String(Math.floor(total / 3600)).padStart(2, "0");
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  function finalizar() {
    clearInterval(reloj);
    widget.className = "contador-acceso vencido";
    widget.style.setProperty("--contador-progreso", "0%");
    tiempo.textContent = "00:00:00";
    mensaje.textContent = "El acceso ha finalizado. Registra nuevamente tu asistencia.";
    localStorage.removeItem("im3cb_llave");
    localStorage.removeItem("im3cb_curso");
    setTimeout(() => { location.href = "index.html"; }, 4500);
  }

  function actualizar() {
    const restante = venceEn - Date.now();
    if (restante <= 0) return finalizar();

    const porcentaje = Math.max(0, Math.min(100, restante / DURACION * 100));
    widget.style.setProperty("--contador-progreso", `${porcentaje}%`);
    tiempo.textContent = formato(restante);
    widget.className = "contador-acceso";
    mensaje.textContent = "Tiempo disponible para revisar el curso.";

    if (restante <= 10 * 60 * 1000) {
      widget.classList.add("urgente");
      mensaje.textContent = "Tu acceso cerrará pronto. Guarda tu avance.";
    } else if (restante <= 30 * 60 * 1000) {
      widget.classList.add("advertencia");
      mensaje.textContent = "Quedan menos de 30 minutos de acceso.";
    }
  }

  async function validar() {
    const llave = llaveActual();
    if (!llave) {
      tiempo.textContent = "SIN ACCESO";
      mensaje.textContent = "Escanea el QR y registra tu asistencia para activar el curso.";
      return;
    }

    try {
      const respuesta = await fetch(API, {
        method: "POST",
        body: JSON.stringify({ accion: "validar_acceso", llave })
      });
      const resultado = await respuesta.json();

      if (!resultado.ok || !resultado.autorizado || resultado.curso !== cursoEsperado) {
        tiempo.textContent = "NO AUTORIZADO";
        mensaje.textContent = "La asistencia registrada no corresponde a este curso o ya venció.";
        return;
      }

      venceEn = Number(resultado.venceEn || 0);
      if (!venceEn) {
        tiempo.textContent = "SIN VIGENCIA";
        mensaje.textContent = "No fue posible obtener la hora de cierre. Actualiza la página.";
        return;
      }

      actualizar();
      reloj = setInterval(actualizar, 1000);
    } catch (error) {
      tiempo.textContent = "SIN CONEXIÓN";
      mensaje.textContent = "No se pudo comprobar el acceso. Revisa tu conexión.";
    }
  }

  validar();
})();

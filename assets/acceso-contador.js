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
    </div>
    <div class="contador-acceso__tiempo">--:--:--</div>
    <div class="contador-acceso__mensaje">Comprobando la vigencia de tu acceso…</div>
    <div class="contador-acceso__barra"><span></span></div>`;
  document.body.appendChild(widget);

  const tiempo = widget.querySelector(".contador-acceso__tiempo");
  const mensaje = widget.querySelector(".contador-acceso__mensaje");
  let venceEn = 0;
  let reloj = null;

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

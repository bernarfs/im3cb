(function () {
  "use strict";
  const script = document.currentScript;
  const api = script.dataset.api;
  const curso = script.dataset.curso;
  const evaluacion = script.dataset.evaluacion;
  const estado = document.getElementById(script.dataset.estado || "estadoDiagnostico");
  if (!api || !curso || !evaluacion || !estado) return;
  const zona = document.createElement("div");
  zona.className = "solicitud-oportunidad-im3cb";
  estado.insertAdjacentElement("afterend", zona);

  async function enviar() {
    const alumno = { nombre: localStorage.getItem("im3cb_nombre") || "", matricula: localStorage.getItem("im3cb_matricula") || "", curso, evaluacion };
    if (!alumno.nombre) { zona.textContent = "Registra primero tu asistencia para identificarte."; return; }
    const boton = zona.querySelector("button");
    if (boton) boton.disabled = true;
    try {
      const respuesta = await fetch(api, { method: "POST", body: JSON.stringify({ accion: "solicitar_nueva_oportunidad", ...alumno }) });
      const resultado = await respuesta.json();
      if (!resultado.ok) throw new Error(resultado.mensaje || "No se pudo enviar la solicitud.");
      zona.innerHTML = '<span class="solicitud-oportunidad__enviada">✓ Solicitud enviada al panel docente.</span>';
    } catch (error) {
      zona.innerHTML = `<button type="button">Solicitar nueva oportunidad</button><span class="solicitud-oportunidad__error"> ${error.message}</span>`;
      zona.querySelector("button").addEventListener("click", enviar);
    }
  }

  function actualizar() {
    const bloqueada = /oportunidad ya fue dada|diagnóstico terminado|evaluación no disponible/i.test(estado.textContent);
    if (!bloqueada || zona.dataset.mostrada) return;
    zona.dataset.mostrada = "true";
    zona.innerHTML = '<button type="button">Solicitar nueva oportunidad</button><p>El docente decidirá si autoriza otro intento.</p>';
    zona.querySelector("button").addEventListener("click", enviar);
  }
  new MutationObserver(actualizar).observe(estado, { childList: true, subtree: true, characterData: true });
  actualizar();
})();

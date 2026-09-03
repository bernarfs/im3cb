const ID_HOJA_CALIFICACIONES = "1racZuHsY5b_M27Huc0HuBx9rpDRfA6A_Bs-SXN2-dhs";
const ZONA_HORARIA = "America/Mexico_City";
const CODIGO_DOCENTE_CALIFICACIONES = "LISTA2026";

function doGet(e) {
  return respuestaJSON_({ ok: true, sistema: "IM3CB_CALIFICACIONES", estado: "activo" });
}

function doPost(e) {
  try {
    const data = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    let resultado;
    switch (data.accion) {
      case "iniciar_diagnostico": resultado = iniciarDiagnostico_(data); break;
      case "finalizar_diagnostico": resultado = finalizarDiagnostico_(data); break;
      case "abandonar_diagnostico": resultado = abandonarDiagnostico_(data); break;
      case "consultar_diagnostico": resultado = consultarDiagnostico_(data); break;
      case "solicitar_nueva_oportunidad": resultado = solicitarNuevaOportunidad_(data); break;
      case "listar_solicitudes_oportunidad": resultado = listarSolicitudesOportunidad_(data); break;
      case "resolver_solicitud_oportunidad": resultado = resolverSolicitudOportunidad_(data); break;
      default: throw new Error("Acción no reconocida.");
    }
    return respuestaJSON_(resultado);
  } catch (error) {
    return respuestaJSON_({ ok: false, mensaje: error.message || "Error en calificaciones." });
  }
}

function iniciarDiagnostico_(data) {
  const alumno = obtenerAlumno_(data);
  const clave = crearClaveDiagnostico_(alumno);
  const propiedades = PropertiesService.getScriptProperties();
  const existente = propiedades.getProperty(clave);
  if (existente) {
    const intentoExistente = JSON.parse(existente);
    if (intentoExistente.estado === "en_progreso") cerrarPorAbandono_(clave, intentoExistente, propiedades);
    return { ok: true, permitido: false, mensaje: "Esta oportunidad ya fue dada." };
  }
  let numero = 1;
  const autorizacion = propiedades.getProperty("AUTORIZACION|" + clave);
  if (autorizacion) {
    numero = Number(JSON.parse(autorizacion).numero) || 2;
    propiedades.deleteProperty("AUTORIZACION|" + clave);
  }
  const intento = { nombre: alumno.nombre, matricula: alumno.matricula, curso: alumno.curso, evaluacion: alumno.evaluacion, numero: numero, fecha: new Date().toISOString(), estado: "en_progreso" };
  propiedades.setProperty(clave, JSON.stringify(intento));
  return { ok: true, permitido: true, numeroIntento: numero, mensaje: "Evaluación iniciada." };
}

function finalizarDiagnostico_(data) {
  const alumno = obtenerAlumno_(data);
  const clave = crearClaveDiagnostico_(alumno);
  const propiedades = PropertiesService.getScriptProperties();
  const guardado = propiedades.getProperty(clave);
  if (!guardado) return { ok: false, mensaje: "No existe una evaluación iniciada." };
  const intento = JSON.parse(guardado);
  if (intento.estado === "finalizado") return { ok: true, permitido: false, mensaje: "Esta oportunidad ya fue dada." };
  intento.calificacion = Math.round(Math.max(0, Math.min(100, Number(data.calificacion) || 0)));
  intento.estado = "finalizado";
  intento.motivo = "completado";
  guardarCalificacion_(intento, intento.calificacion);
  propiedades.setProperty(clave, JSON.stringify(intento));
  return { ok: true, calificacion: intento.calificacion, numeroIntento: Number(intento.numero) || 1, mensaje: "Calificación guardada correctamente." };
}

function abandonarDiagnostico_(data) {
  const alumno = obtenerAlumno_(data);
  const clave = crearClaveDiagnostico_(alumno);
  const propiedades = PropertiesService.getScriptProperties();
  const guardado = propiedades.getProperty(clave);
  if (!guardado) return { ok: true, mensaje: "Sin evaluación activa." };
  const intento = JSON.parse(guardado);
  if (intento.estado === "finalizado") return { ok: true, mensaje: "La oportunidad ya estaba cerrada." };
  cerrarPorAbandono_(clave, intento, propiedades);
  return { ok: true, mensaje: "Abandono registrado con calificación 0." };
}

function cerrarPorAbandono_(clave, intento, propiedades) {
  intento.estado = "finalizado";
  intento.calificacion = 0;
  intento.motivo = "abandono";
  guardarCalificacion_(intento, 0);
  propiedades.setProperty(clave, JSON.stringify(intento));
}

function consultarDiagnostico_(data) {
  const alumno = obtenerAlumno_(data);
  const clave = crearClaveDiagnostico_(alumno);
  const propiedades = PropertiesService.getScriptProperties();
  const guardado = propiedades.getProperty(clave);
  if (!guardado) return { ok: true, disponible: true };
  const intento = JSON.parse(guardado);
  if (intento.estado === "en_progreso") cerrarPorAbandono_(clave, intento, propiedades);
  const solicitud = propiedades.getProperty("SOLICITUD|" + clave);
  return { ok: true, disponible: false, puedeSolicitar: true, solicitudPendiente: Boolean(solicitud), mensaje: solicitud ? "La solicitud está pendiente de autorización docente." : "Esta oportunidad ya fue dada." };
}

function solicitarNuevaOportunidad_(data) {
  return conBloqueo_(function () {
    const alumno = obtenerAlumno_(data);
    const clave = crearClaveDiagnostico_(alumno);
    const propiedades = PropertiesService.getScriptProperties();
    const intento = propiedades.getProperty(clave);
    if (!intento) return { ok: false, mensaje: "La evaluación todavía está disponible; no necesitas solicitar otra oportunidad." };
    const claveSolicitud = "SOLICITUD|" + clave;
    if (propiedades.getProperty(claveSolicitud)) return { ok: true, pendiente: true, mensaje: "La solicitud ya está pendiente." };
    const solicitud = { id: claveSolicitud, claveIntento: clave, nombre: alumno.nombre, matricula: alumno.matricula, curso: alumno.curso, evaluacion: alumno.evaluacion, fecha: new Date().toISOString() };
    propiedades.setProperty(claveSolicitud, JSON.stringify(solicitud));
    registrarSolicitud_(solicitud, "PENDIENTE");
    return { ok: true, pendiente: true, mensaje: "Solicitud enviada al panel docente." };
  });
}

function listarSolicitudesOportunidad_(data) {
  validarDocente_(data);
  const curso = String(data.curso || "").trim().toUpperCase();
  const todas = PropertiesService.getScriptProperties().getProperties();
  const solicitudes = Object.keys(todas).filter(function (clave) { return clave.indexOf("SOLICITUD|") === 0; }).map(function (clave) {
    const item = JSON.parse(todas[clave]);
    item.id = clave;
    item.fechaTexto = Utilities.formatDate(new Date(item.fecha), ZONA_HORARIA, "dd/MM/yyyy HH:mm");
    return item;
  }).filter(function (item) { return !curso || item.curso === curso; }).sort(function (a, b) { return a.fecha.localeCompare(b.fecha); });
  return { ok: true, solicitudes: solicitudes };
}

function resolverSolicitudOportunidad_(data) {
  validarDocente_(data);
  return conBloqueo_(function () {
    const propiedades = PropertiesService.getScriptProperties();
    const id = String(data.id || "");
    const guardada = propiedades.getProperty(id);
    if (!guardada || id.indexOf("SOLICITUD|") !== 0) return { ok: false, mensaje: "La solicitud ya no está pendiente." };
    const solicitud = JSON.parse(guardada);
    const decision = String(data.decision || "").toLowerCase();
    if (decision === "autorizar") {
      const anteriorTexto = propiedades.getProperty(solicitud.claveIntento);
      const anterior = anteriorTexto ? JSON.parse(anteriorTexto) : { numero: 1 };
      const numero = (Number(anterior.numero) || 1) + 1;
      if (anteriorTexto) propiedades.setProperty("HISTORIAL|" + solicitud.claveIntento + "|" + Date.now(), anteriorTexto);
      propiedades.deleteProperty(solicitud.claveIntento);
      propiedades.setProperty("AUTORIZACION|" + solicitud.claveIntento, JSON.stringify({ numero: numero, fecha: new Date().toISOString() }));
      propiedades.deleteProperty(id);
      registrarSolicitud_(solicitud, "AUTORIZADA · INTENTO " + numero);
      return { ok: true, mensaje: "✅ Nueva oportunidad autorizada para " + solicitud.nombre + "." };
    }
    if (decision === "rechazar") {
      propiedades.deleteProperty(id);
      registrarSolicitud_(solicitud, "RECHAZADA");
      return { ok: true, mensaje: "Solicitud rechazada." };
    }
    return { ok: false, mensaje: "Decisión no válida." };
  });
}

function validarDocente_(data) {
  if (String(data.codigoDocente || "").trim() !== CODIGO_DOCENTE_CALIFICACIONES) throw new Error("Código docente incorrecto.");
}

function conBloqueo_(funcion) {
  const bloqueo = LockService.getScriptLock();
  bloqueo.waitLock(10000);
  try { return funcion(); } finally { bloqueo.releaseLock(); }
}

function registrarSolicitud_(solicitud, estado) {
  const libro = SpreadsheetApp.openById(ID_HOJA_CALIFICACIONES);
  let hoja = libro.getSheetByName("SOLICITUDES_EVALUACION");
  if (!hoja) {
    hoja = libro.insertSheet("SOLICITUDES_EVALUACION");
    hoja.appendRow(["FECHA", "NOMBRE", "MATRICULA", "CURSO", "EVALUACION", "ESTADO"]);
  }
  hoja.appendRow([new Date(), solicitud.nombre, solicitud.matricula, solicitud.curso, solicitud.evaluacion, estado]);
}

function guardarCalificacion_(intento, calificacion) {
  const libro = SpreadsheetApp.openById(ID_HOJA_CALIFICACIONES);
  let hoja = libro.getSheetByName(intento.curso);
  if (!hoja) hoja = libro.insertSheet(intento.curso);
  if (hoja.getRange("A1").getValue() !== "NOMBRE") hoja.getRange("A1").setValue("NOMBRE");
  const fecha = Utilities.formatDate(new Date(), ZONA_HORARIA, "dd/MM");
  const etiqueta = String(intento.evaluacion || "ACTIVIDAD").trim().toUpperCase().replace(/_/g, " ");
  const numero = Number(intento.numero) || 1;
  const encabezado = fecha + " · " + etiqueta + (numero > 1 ? " · INTENTO " + numero : "");
  const ultimaColumna = Math.max(hoja.getLastColumn(), 1);
  const encabezados = hoja.getRange(1, 1, 1, ultimaColumna).getValues()[0];
  let columna = encabezados.indexOf(encabezado) + 1;
  if (!columna) { columna = ultimaColumna + 1; hoja.getRange(1, columna).setValue(encabezado); }
  const ultimaFila = hoja.getLastRow();
  let fila = 0;
  if (ultimaFila >= 2) {
    const nombres = hoja.getRange(2, 1, ultimaFila - 1, 1).getValues();
    const buscado = intento.nombre.toUpperCase();
    for (let i = 0; i < nombres.length; i++) if (String(nombres[i][0] || "").trim().toUpperCase() === buscado) { fila = i + 2; break; }
  }
  if (!fila) { fila = hoja.getLastRow() + 1; hoja.getRange(fila, 1).setValue(intento.nombre); }
  hoja.getRange(fila, columna).setValue(Math.round(calificacion));
}

function obtenerAlumno_(data) {
  const nombre = String(data.nombre || "").trim();
  const matricula = String(data.matricula || "").trim();
  const curso = String(data.curso || "").trim().toUpperCase();
  const evaluacion = String(data.evaluacion || "DIAGNOSTICA").trim().toUpperCase();
  if (!nombre || !curso) throw new Error("Faltan el nombre o la materia.");
  return { nombre: nombre, matricula: matricula, curso: curso, evaluacion: evaluacion };
}

function crearClaveDiagnostico_(alumno) {
  const identificador = alumno.matricula || alumno.nombre.toUpperCase();
  return ["DIAGNOSTICO", alumno.curso, alumno.evaluacion, identificador].join("|");
}

function respuestaJSON_(datos) {
  return ContentService.createTextOutput(JSON.stringify(datos)).setMimeType(ContentService.MimeType.JSON);
}

# Activar video con datos móviles

La pantalla simple y el PIN ya están preparados. Para activar la opción gratuita de retransmisión sin montar un servidor propio:

1. Crear una cuenta o iniciar sesión en [Metered](https://dashboard.metered.ca/signup).
2. Abrir **Realtime Messaging → Keys → Create key**.
3. Elegir el tipo **Publishable**. Habilitar **Send**, además de **Subscribe**, **Publish** y **Presence**. Si el panel permite limitar los orígenes, usar `https://bernarfs.github.io`.
4. Copiar únicamente la clave **publicable**, que empieza por `pk_live_`. Está diseñada para aparecer en una aplicación web. No usar ni compartir claves privadas, API keys del servidor, contraseñas o tokens de administrador.
5. En `camara-network.json`, colocar esa clave en `meteredPublishableKey`, manteniendo `iceServersUrl` en `null`. Ejemplo con marcador, no una clave real:

```json
{
  "meteredPublishableKey": "pk_live_REEMPLAZAR_CON_LA_CLAVE_PUBLICABLE",
  "iceServersUrl": null
}
```

6. Publicar el archivo actualizado. Tanto el celular como la computadora deben cargar esa misma configuración.
7. Probar con la computadora conectada a Internet y el celular con el Wi-Fi apagado, usando datos móviles. Confirmar que la imagen se mueve antes de activar los servos.

El módulo incluido usa Metered Realtime 1.2.1 y recibe sus credenciales TURN automáticamente. La configuración del servicio se hace una vez; quienes vean la demostración solo usarán la cámara y el PIN.

Según la [documentación del proveedor](https://www.metered.ca/tools/openrelay/webrtc-library/), el plan gratuito incluye señalización y 20 GB mensuales de retransmisión, sin tarjeta para comenzar. Los límites y condiciones dependen del proveedor y deben revisarse al crear la cuenta. No se ha creado una cuenta ni aceptado un plan en nombre del usuario.

**Estado de validación:** se probó video por PIN con el transporte directo de PeerJS y video sintético, y se verificaron la adaptación de eventos y la cancelación de Metered mediante pruebas automatizadas con un cliente simulado. Falta probar la cuenta real y el operador móvil. No se presenta la retransmisión como ya operativa.

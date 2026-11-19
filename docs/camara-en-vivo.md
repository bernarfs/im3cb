# IM3CB · Cámara en vivo (versión simplificada)

## Uso

- En la computadora, abrir `humanoides-camara.html`. Elegir **Cámara de la laptop** para ver video local, o **Cámara del celular** para mostrar un PIN.
- En el celular, abrir la misma página y elegir **Transmitir desde celular**, o abrir `humanoides-camara.html?modo=celular`. Ingresar el PIN y pulsar **Transmitir video**. Seleccionar cámara frontal o trasera antes de transmitir.
- El celular solicita solo cámara: no micrófono. Envía video por WebRTC. No ejecuta detección corporal ni órdenes a los servos. La computadora recibe el video y analiza el cuerpo.
- El enlace usa Internet y no exige la misma red Wi-Fi. PeerJS Cloud realiza la señalización. La conexión directa puede funcionar entre redes distintas, pero los operadores móviles con NAT o cortafuegos restrictivos requieren un servicio TURN. Los servidores públicos heredados de PeerJS no resolvieron DNS y la alternativa pública de Open Relay no estableció video en la prueba. No se incluyen como si estuvieran operativos.
- **Pendiente para asegurar datos móviles:** configurar un servicio TURN mediante el endpoint HTTPS `iceServersUrl` de `camara-network.json`. El endpoint debe devolver `{ "iceServers": [...] }` con credenciales de corta duración y permitir CORS desde `https://bernarfs.github.io`. Las claves privadas del proveedor permanecen en el servidor, nunca en el repositorio público. Falta la cuenta/servicio del usuario y la prueba con su operador real. Con `iceServersUrl: null`, la conexión es directa mediante STUN y no está garantizada en redes móviles restrictivas.
- No se graba el video en esta aplicación. Los medios WebRTC viajan cifrados. PeerJS procesa metadatos de conexión; cuando se configure TURN, ese servicio transportará los paquetes cifrados si la conexión directa no es posible.
- El PIN es temporal, de 8 dígitos, válido para un celular durante 10 minutos. Una transmisión ya conectada puede continuar. No se publica en la URL ni se guarda. El PIN se transforma en un identificador de enlace SHA-256. No sustituye autenticación de cuentas para usos privados o de alta seguridad.
- Cambiar de fuente o pulsar Detener cierra la cámara y el enlace. Si se interrumpe la conexión del celular, generar otro PIN. Al pasar el celular a segundo plano se detiene la transmisión.

## Robot (opcional)

El botón **Robot** contiene las conexiones USB y los controles de los servos. Sin pulsar Activar movimiento, el video y la detección funcionan sin moverlos.

El mismo `Nano_Camara/Nano_Camara.ino` sirve para Nano clásico ATmega328P y Uno R3. No cambia respecto a la primera versión. Elegir la placa y el procesador adecuados al cargarlo en Arduino IDE. No se controlan dos placas simultáneamente en esta versión: se puede usar una u otra.

| Extremidad del usuario | Pin | Reposo | Objetivo máximo de la prueba |
| --- | --- | --- | --- |
| Brazo derecho | D9 | 180° | 150° |
| Brazo izquierdo | D5 | 100° | 115° |
| Pierna derecha | D3 | 10° | 40° |
| Pierna izquierda | D11 | 90° | 105° |

Son canales para las articulaciones del robot, no una afirmación de que el montaje original tenga brazos. Comprobar los ángulos contra el montaje antes de activar. Alimentar los servos mediante una fuente externa adecuada a su modelo, con GND común con la placa. Nano/Uno por USB a la computadora. No alimentar cuatro servos desde el pin 5 V ni conectar 9 V directamente a ellos.

La detección usa los mismos ángulos 2D de elevación lateral que el prototipo anterior. No hace control de equilibrio ni reproducción 3D. Mantener hombros, codos, caderas y rodillas visibles. Ante pérdida de cuerpo, video congelado o pestaña de la computadora en segundo plano, se desactiva el movimiento y hay que reactivarlo. El firmware tiene además un watchdog de 600 ms. Detener mantiene la posición, no corta la corriente.

## Archivos del portal

- `humanoides-camara.html`, `humanoides-camara.css`, `humanoides-camara.mjs`
- `camera-session.mjs`, `arduino-camera.mjs`, `control-core.mjs`, `camara-network.json`
- `camara-vendor/peerjs.min.js` (PeerJS 1.5.5, MIT, distribución oficial de npm)
- `Nano_Camara/Nano_Camara.ino`

MediaPipe 0.10.18 y el modelo se cargan por Internet solamente en la computadora. PeerJS está incluido localmente. La página sigue enlazada desde `humanoides.html`; no modifica los controles de Marty y Asti ni sus NIP.

## Referencias

[PeerJS, llamada de video unidireccional](https://peerjs.com/client/getting-started), [configuración oficial STUN/TURN](https://github.com/peers/peerjs/blob/master/lib/util.ts), [Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js).

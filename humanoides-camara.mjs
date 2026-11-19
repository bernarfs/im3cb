import {targets,extractPose} from './control-core.mjs';
import {ArduinoCamera} from './arduino-camera.mjs';
import {openPeer,makePin,normalizePin,formatPin,peerId} from './camera-session.mjs';
const $=id=>document.getElementById(id);
const params=new URLSearchParams(location.search);
const relayOnly=params.get('relay')==='1'; // For developer network verification, not a user setup step.
let mode='receiver',source=null,sourceVersion=0,stream=null,peer=null,call=null;
let detector,detectorLoad,tracking=false,loopVersion=0,lastVideo=-1,lastDetection=0,filtered=null;
let sessionPin=null,pinDeadline=0,pinTimer,callTimer,phoneRevision=0;
let framesBefore=0,lastMovingFrame=performance.now();
const status=text=>$('status').textContent=text;
const robot=new ArduinoCamera(text=>{
  $('robotStatus').textContent=text;
  if(robot.ready)$('serialStatus').textContent='Arduino conectado';
  else $('serialStatus').textContent=text;
},ready=>{
  $('arm').disabled=!ready;
  $('robotOpen').textContent=robot.armed?'Robot activo':'Robot';
});
const stopRobot=text=>{if(robot.armed||robot.pending)robot.stop(text||'Movimiento desactivado');};
function errorText(error){
  if(error.name==='NotAllowedError')return 'Permite el acceso a la cámara en el navegador y vuelve a intentar.';
  if(error.name==='NotFoundError')return 'No se encontró una cámara disponible.';
  if(error.name==='NotReadableError')return 'La cámara está ocupada. Cierra otra aplicación que la esté usando.';
  return error.message||'No se pudo abrir la cámara.';
}
function showDialog(id){if(!$(id).open)$(id).showModal();}
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>$(button.dataset.close).close());
for(const id of ['pairDialog','robotDialog'])$(id).addEventListener('click',event=>{if(event.target===$(id)){
  const rect=$(id).getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)$(id).close();
}});
async function loadDetector(){
  if(detector)return detector;
  if(!detectorLoad)detectorLoad=(async()=>{
    const {FilesetResolver,PoseLandmarker}=await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs');
    const files=await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm');
    return PoseLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'},runningMode:'VIDEO',numPoses:1,minPoseDetectionConfidence:.65,minPosePresenceConfidence:.65,minTrackingConfidence:.65});
  })().catch(e=>{detectorLoad=null;throw e;});
  detector=await detectorLoad;return detector;
}
function clearSkeleton(){
  const canvas=$('overlay');canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
  for(let i=0;i<4;i++)$('limb'+i).style.setProperty('--amount','0%');
}
const links=[[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
function draw(points){
  const video=$('video'),canvas=$('overlay');
  if(canvas.width!==video.videoWidth||canvas.height!==video.videoHeight){canvas.width=video.videoWidth;canvas.height=video.videoHeight;}
  const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);if(!points)return;
  ctx.strokeStyle='#48e1b2';ctx.fillStyle='#48e1b2';ctx.lineWidth=Math.max(2,canvas.width/200);
  for(const [a,b] of links){if((points[a].visibility??0)<.65||(points[b].visibility??0)<.65)continue;
    ctx.beginPath();ctx.moveTo(points[a].x*canvas.width,points[a].y*canvas.height);ctx.lineTo(points[b].x*canvas.width,points[b].y*canvas.height);ctx.stroke();}
  for(const p of points){if((p.visibility??0)<.65)continue;ctx.beginPath();ctx.arc(p.x*canvas.width,p.y*canvas.height,Math.max(3,canvas.width/140),0,Math.PI*2);ctx.fill();}
}
function stopTracking(){tracking=false;loopVersion++;filtered=null;clearSkeleton();$('tracking').hidden=true;$('limbs').hidden=true;robot.lastPose=-Infinity;stopRobot('Movimiento detenido: cambió la cámara.');}
async function startTracking(version){
  $('tracking').hidden=false;$('tracking').textContent='Preparando detección…';
  try{await loadDetector();if(version!==sourceVersion||!source||mode!=='receiver')return;
    tracking=true;lastVideo=-1;lastDetection=0;filtered=null;lastMovingFrame=performance.now();framesBefore=0;const currentLoop=++loopVersion;
    const video=$('video');
    function tick(now){
      if(!tracking||currentLoop!==loopVersion||version!==sourceVersion)return;
      if(!document.hidden&&now-lastMovingFrame<=450&&video.readyState>=2&&video.currentTime!==lastVideo&&now-lastDetection>=80){
        lastVideo=video.currentTime;lastDetection=now;
        try{
          const result=detector.detectForVideo(video,now);const points=result.landmarks?.[0];draw(points);
          const values=extractPose(points,video.videoWidth,video.videoHeight);
          if(values){filtered=filtered?values.map((v,i)=>filtered[i]*.65+v*.35):values;
            $('tracking').textContent='Movimiento detectado';$('limbs').hidden=false;
            filtered.forEach((v,i)=>$('limb'+i).style.setProperty('--amount',Math.round(v*100)+'%'));robot.pose(targets(filtered));
          }else{filtered=null;$('tracking').textContent='Encuadra todo tu cuerpo';$('limbs').hidden=true;robot.lastPose=-Infinity;stopRobot('Movimiento detenido: cuerpo fuera de encuadre.');}
        }catch(e){stopTracking();status('Video conectado; la detección falló. Vuelve a elegir la cámara.');return;}
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }catch{if(version===sourceVersion){$('tracking').textContent='Detección no disponible';status('El video está conectado. No se pudo descargar el detector; revisa Internet.');}}
}
function disposePeer(){
  clearTimeout(pinTimer);clearTimeout(callTimer);sessionPin=null;pinDeadline=0;
  if(call){const old=call;call=null;old.close();}
  if(peer){const old=peer;peer=null;old.destroy();}
}
function cleanupReceiver(){
  sourceVersion++;stopTracking();source=null;disposePeer();
  if(stream){stream.getTracks().forEach(t=>{t.onended=null;t.stop();});stream=null;}
  $('video').srcObject=null;$('video').pause();$('empty').hidden=false;$('sourceBadge').hidden=true;
  $('stopVideo').hidden=true;$('changeSource').hidden=true;$('screen').classList.remove('mirror');
}
async function playReceiver(incoming,label,mirror,version){
  if(version!==sourceVersion){incoming.getTracks().forEach(t=>t.stop());return;}
  stream=incoming;$('video').srcObject=incoming;$('screen').classList.toggle('mirror',mirror);
  try{await $('video').play();}catch{status('Toca la pantalla de video para comenzar.');}
  if(version!==sourceVersion)return;
  clearTimeout(callTimer);
  $('empty').hidden=true;$('sourceBadge').hidden=false;$('sourceBadge').textContent=label;
  $('stopVideo').hidden=false;$('changeSource').hidden=false;status(label+' conectada');
  incoming.getVideoTracks().forEach(t=>t.onended=()=>{if(version===sourceVersion){cleanupReceiver();status('La cámara se desconectó.');}});
  framesBefore=0;lastMovingFrame=performance.now();void startTracking(version);
  if(videoFrameSupported()){
    const onFrame=now=>{if(version!==sourceVersion)return;lastMovingFrame=now;if(source==='phone'&&$('status').textContent==='Esperando video del celular…')status('Cámara del celular conectada');$('video').requestVideoFrameCallback(onFrame);};
    $('video').requestVideoFrameCallback(onFrame);
  }
}
function videoFrameSupported(){return typeof $('video').requestVideoFrameCallback==='function';}
$('video').onclick=()=>void $('video').play();
$('localStart').onclick=async()=>{
  $('localStart').disabled=true;cleanupReceiver();const version=sourceVersion;
  status('Abriendo cámara de la laptop…');
  try{
    const incoming=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},frameRate:{ideal:20,max:24}},audio:false});
    if(version!==sourceVersion){incoming.getTracks().forEach(t=>t.stop());return;}
    source='local';await playReceiver(incoming,'Cámara de la laptop',true,version);
  }catch(e){status(errorText(e));}finally{$('localStart').disabled=false;}
};
$('phoneStart').onclick=async()=>{
  cleanupReceiver();source='phone';const version=sourceVersion;showDialog('pairDialog');$('pin').textContent='···· ····';$('pairStatus').textContent='Creando PIN…';status('Preparando cámara del celular…');
  $('phoneStart').disabled=true;
  try{
    const pin=makePin();const newPeer=await openPeer(await peerId(pin),relayOnly);
    if(version!==sourceVersion){newPeer.destroy();return;}
    peer=newPeer;sessionPin=pin;pinDeadline=Date.now()+10*60*1000;$('pin').textContent=formatPin(pin);
    $('pairStatus').textContent='PIN listo · esperando tu celular';status('Esperando el celular · PIN '+formatPin(pin));
    $('stopVideo').hidden=false;$('changeSource').hidden=false;
    peer.on('connection',connection=>connection.close());
    peer.on('error',e=>{if(version!==sourceVersion)return;stopRobot();$('pairStatus').textContent='Se perdió el enlace. Cierra y vuelve a elegir Cámara del celular.';status('Se perdió el enlace del celular. Vuelve a conectar.');});
    peer.on('disconnected',()=>{if(version===sourceVersion&&!call){$('pairStatus').textContent='Sin enlace de Internet. Genera otro PIN.';}});
    peer.on('call',incoming=>{
      if(version!==sourceVersion||call||!sessionPin||Date.now()>pinDeadline||incoming.metadata?.version!==3){incoming.close();return;}
      call=incoming;sessionPin=null;clearTimeout(pinTimer);$('pairStatus').textContent='Celular encontrado · conectando video…';
      clearTimeout(callTimer);callTimer=setTimeout(()=>{if(version===sourceVersion){cleanupReceiver();$('pairStatus').textContent='No llegó el video. Intenta otra vez con un PIN nuevo.';status('No se pudo recibir video. Revisa Internet y genera un PIN nuevo.');}},25000);
      incoming.on('stream',remote=>{
        if(version!==sourceVersion)return;$('pairDialog').close();status('Recibiendo video del celular…');
        void playReceiver(remote,'Cámara del celular',incoming.metadata?.facing==='user',version);
      });
      const ended=()=>{if(version!==sourceVersion)return;cleanupReceiver();status('El celular dejó de transmitir.');};
      incoming.on('close',ended);incoming.on('error',ended);incoming.answer();
    });
    pinTimer=setTimeout(()=>{if(version===sourceVersion&&!call){cleanupReceiver();$('pin').textContent='VENCIDO';$('pairStatus').textContent='Vuelve a elegir Cámara del celular para obtener otro PIN.';status('El PIN venció. Genera uno nuevo.');}},10*60*1000);
  }catch(e){if(version===sourceVersion){$('pairStatus').textContent=errorText(e);status(errorText(e));}}
  finally{$('phoneStart').disabled=false;}
};
$('copyPhoneLink').onclick=async()=>{
  const url=new URL(location.href);url.search='?modo=celular';url.hash='';
  try{await navigator.clipboard.writeText(url.href);$('pairStatus').textContent='Enlace copiado. Ábrelo en el celular e ingresa el PIN.';}
  catch{$('pairStatus').textContent='En el celular abre '+url.href;}
};
$('changeSource').onclick=()=>{cleanupReceiver();status('Elige otra cámara.');};
$('stopVideo').onclick=()=>{cleanupReceiver();status('Video detenido · movimiento desactivado');};
$('fullscreen').onclick=async()=>{try{await $('screen').requestFullscreen();}catch{status('Tu navegador no permite pantalla completa.');}};
$('robotOpen').onclick=()=>showDialog('robotDialog');
$('connectSerial').onclick=async()=>{
  $('connectSerial').disabled=true;try{await robot.connect();}catch(e){$('serialStatus').textContent=errorText(e);}finally{$('connectSerial').disabled=false;}
};
$('arm').onclick=()=>{try{robot.activate();}catch(e){$('robotStatus').textContent=e.message;}};
$('stopRobot').onclick=()=>robot.stop();
// Incoming video may freeze while its MediaStream is still 'live'. Real decoded
// frame counters prevent a frozen image from keeping the robot armed.
setInterval(()=>{
  if(!source||!stream)return;
  const video=$('video');const frames=video.getVideoPlaybackQuality?.().totalVideoFrames;
  if(source==='phone'&&performance.now()-lastMovingFrame>4000){cleanupReceiver();status('El celular dejó de transmitir. Vuelve a conectar con un PIN nuevo.');return;}
  if(videoFrameSupported()){
    if(performance.now()-lastMovingFrame>450){robot.lastPose=-Infinity;stopRobot('Movimiento detenido: video en pausa.');$('tracking').textContent='Esperando video…';if(source==='phone')status('Esperando video del celular…');clearSkeleton();}
  }else if(typeof frames==='number'){
    if(frames!==framesBefore){framesBefore=frames;lastMovingFrame=performance.now();}
    else if(performance.now()-lastMovingFrame>450){robot.lastPose=-Infinity;stopRobot('Movimiento detenido: video en pausa.');$('tracking').textContent='Esperando video…';clearSkeleton();}
  }
},150);
function cleanupPhone(message){
  phoneRevision++;disposePeer();
  const video=$('phoneVideo');if(video.srcObject)video.srcObject.getTracks().forEach(t=>{t.onended=null;t.stop();});
  video.srcObject=null;$('phonePreview').hidden=true;$('phoneStop').hidden=true;$('sendForm').hidden=false;$('sendVideo').disabled=false;
  if(message)$('phoneStatus').textContent=message;
}
$('sendForm').onsubmit=async event=>{
  event.preventDefault();let pin;try{pin=normalizePin($('pinInput').value);}catch(e){$('phoneStatus').textContent=e.message;return;}
  cleanupPhone();const revision=phoneRevision;$('sendVideo').disabled=true;$('phoneStatus').textContent='Abriendo la cámara…';
  try{
    const facing=$('facing').value;
    const camera=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:facing},width:{ideal:640},height:{ideal:480},frameRate:{ideal:20,max:24}},audio:false});
    if(revision!==phoneRevision){camera.getTracks().forEach(t=>t.stop());return;}
    $('phoneVideo').srcObject=camera;$('phoneVideo').style.transform=facing==='user'?'scaleX(-1)':'';
    await $('phoneVideo').play();$('phonePreview').hidden=false;$('phoneStop').hidden=false;
    const newPeer=await openPeer(undefined,relayOnly);
    if(revision!==phoneRevision){newPeer.destroy();return;}
    peer=newPeer;$('phoneStatus').textContent='Conectando con la computadora…';
    newPeer.on('error',error=>{if(revision===phoneRevision)cleanupPhone(error.type==='peer-unavailable'?'El PIN no está disponible. Revisa el PIN o genera otro en la computadora.':'No se pudo conectar. Revisa Internet y vuelve a transmitir.');});
    const videoCall=newPeer.call(await peerId(pin),camera,{metadata:{version:3,facing}});call=videoCall;
    const close=()=>{if(revision===phoneRevision)cleanupPhone('La transmisión terminó.');};
    videoCall.on('close',close);videoCall.on('error',close);
    camera.getVideoTracks().forEach(t=>t.onended=close);
    const connection=videoCall.peerConnection;
    const stateChanged=()=>{
      if(revision!==phoneRevision)return;
      if(connection.connectionState==='connected'){clearTimeout(callTimer);$('sendForm').hidden=true;$('phoneStatus').textContent='Transmitiendo video · mantén esta pantalla abierta';}
      else if(['failed','disconnected','closed'].includes(connection.connectionState))cleanupPhone('Se interrumpió la transmisión. Vuelve a conectar con un PIN nuevo.');
    };
    connection.addEventListener('connectionstatechange',stateChanged);stateChanged();
    callTimer=setTimeout(()=>{if(revision===phoneRevision&&connection.connectionState!=='connected')cleanupPhone('No se pudo enlazar el video por esta red. Revisa Internet y pide un PIN nuevo.');},25000);
  }catch(e){if(revision===phoneRevision)cleanupPhone(errorText(e));}
  finally{if(revision===phoneRevision)$('sendVideo').disabled=false;}
};
$('phoneStop').onclick=()=>cleanupPhone('Transmisión detenida.');
function setMode(next){
  cleanupReceiver();cleanupPhone();mode=next;
  $('receiver').hidden=next!=='receiver';$('sender').hidden=next!=='sender';
  $('senderMode').hidden=next==='sender';$('receiverMode').hidden=next!=='sender';$('robotOpen').hidden=next==='sender';
  $('pairDialog').close();$('robotDialog').close();status('Sin cámara conectada');
  const url=new URL(location.href);if(next==='sender')url.searchParams.set('modo','celular');else url.searchParams.delete('modo');history.replaceState(null,'',url);
}
$('senderMode').onclick=()=>setMode('sender');$('receiverMode').onclick=()=>setMode('receiver');
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopRobot('Movimiento detenido: la pantalla está en segundo plano.');if(mode==='sender')cleanupPhone('Transmisión detenida al salir de esta pantalla.');}});
window.addEventListener('pagehide',()=>{cleanupReceiver();cleanupPhone();robot.stop();});
if(params.get('modo')==='celular')setMode('sender');

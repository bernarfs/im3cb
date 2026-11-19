import {CHANNELS,targets,validFrame,extractPose} from './control-core.mjs';
const $=id=>document.getElementById(id);
let role='pc',localMode=false,pc=null,channel=null,lastSeq=-1,seq=0;
let port=null,writer=null,reader=null,serialReady=false,armed=false,armPending=false,armTime=0;
let writeBusy=false,pendingStop=false,lastPose=0,lastSerialSend=0;
let detector=null,stream=null,cameraOn=false,lastVideo=-1,lastDetection=0,filter=null,loadPromise=null;
const encoder=new TextEncoder();
const status=text=>$('globalStatus').textContent=text;
CHANNELS.forEach((c,i)=>{
  const box=document.createElement('div');box.className='channel';
  const label=document.createElement('label');label.htmlFor='meter'+i;label.textContent=`${c.name} · D${c.pin}`;
  const meter=document.createElement('progress');meter.id='meter'+i;meter.max=1;meter.value=0;
  const out=document.createElement('output');out.id='angle'+i;out.textContent=`${c.neutral}°`;
  box.append(label,meter,out);$('channels').append(box);
});
function display(values){const angles=targets(values);values.forEach((v,i)=>{$('meter'+i).value=v;$('angle'+i).textContent=`${angles[i]}°`;});return angles;}
async function sendSerial(line){
  if(!writer)return;
  if(writeBusy){if(line==='S')pendingStop=true;return;}
  writeBusy=true;
  try{await writer.write(encoder.encode(line+'\n'));}
  catch(e){serialReady=false;armed=false;armPending=false;$('arm').disabled=true;$('serialStatus').textContent='USB desconectado: '+e.message;}
  finally{writeBusy=false;if(pendingStop){pendingStop=false;void sendSerial('S');}}
}
function stop(reason='Seguimiento detenido'){
  armed=false;armPending=false;void sendSerial('S');status(reason+' · pulsa Activar seguimiento para continuar');
}
function onSerial(line){
  if(line==='IM3CB_NANO_1'){serialReady=true;$('arm').disabled=false;$('serialStatus').textContent='Nano reconocido · USB listo';}
  if(line==='ARMED'){
    if(armPending){armed=true;armPending=false;status('Seguimiento activo · recorridos limitados');}
    else void sendSerial('S');
  }
  if(line==='TIMEOUT'||line==='INVALID')stop(line==='TIMEOUT'?'El Nano detuvo el control por pérdida de datos':'El Nano rechazó una orden');
}
async function readSerial(currentPort){
  const decoder=new TextDecoder();let buffer='';const currentReader=currentPort.readable.getReader();reader=currentReader;
  try{
    while(true){const {value,done}=await currentReader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});
      let index;while((index=buffer.indexOf('\n'))>=0){onSerial(buffer.slice(0,index).trim());buffer=buffer.slice(index+1);}if(buffer.length>2048)buffer='';}
  }catch(e){$('serialStatus').textContent='Lectura USB interrumpida: '+e.message;}
  finally{currentReader.releaseLock();reader=null;serialReady=false;$('arm').disabled=true;stop('USB desconectado');}
}
$('connectSerial').onclick=async()=>{
  if(!('serial' in navigator)){status('Abre esta página en Chrome o Edge de escritorio para conectar el Nano.');return;}
  $('connectSerial').disabled=true;
  try{
    if(port){stop();if(reader)await reader.cancel();if(writer){writer.releaseLock();writer=null;}await port.close();port=null;}
    port=await navigator.serial.requestPort();await port.open({baudRate:115200});writer=port.writable.getWriter();
    serialReady=false;void readSerial(port);$('serialStatus').textContent='Esperando identificación del Nano…';
    const start=performance.now();
    const timer=setInterval(()=>{if(serialReady||!writer||performance.now()-start>7000){clearInterval(timer);if(!serialReady)$('serialStatus').textContent='No se reconoció el programa. Carga Nano_Camara.ino y vuelve a conectar.';}else void sendSerial('P');},400);
  }catch(e){$('serialStatus').textContent='No se pudo conectar: '+e.message;}
  finally{$('connectSerial').disabled=false;}
};
$('arm').onclick=()=>{
  if(!serialReady)return;
  if(performance.now()-lastPose>350){status('Primero enciende la cámara y encuadra las cuatro extremidades.');return;}
  armPending=true;armTime=performance.now();void sendSerial('A');status('Activando Nano en la postura de reposo indicada…');
};
$('stop').onclick=()=>stop();
function consume(frame){
  if(!validFrame(frame)||frame.seq<=lastSeq)return;
  lastSeq=frame.seq;lastPose=performance.now();const angles=display(frame.values);
  if(armed&&lastPose-lastSerialSend>=60){lastSerialSend=lastPose;void sendSerial('M,'+angles.join(','));}
}
setInterval(()=>{
  if((armed||armPending)&&performance.now()-lastPose>450)stop('Se perdió el seguimiento del cuerpo');
  if(armPending&&performance.now()-armTime>1500)stop('El Nano no confirmó la activación');
},100);
function sendPeer(value){if(channel?.readyState==='open'&&channel.bufferedAmount<512)channel.send(JSON.stringify(value));}
function wireChannel(dc){
  channel=dc;lastSeq=-1;
  dc.onopen=()=>{$('peerPC').textContent=$('peerPhone').textContent='Celular vinculado · solo se envían datos de movimiento';status('Vínculo listo · enciende la cámara y después activa el Nano');};
  dc.onclose=()=>{stop('Enlace con el celular cerrado');$('peerPC').textContent=$('peerPhone').textContent='Sin conexión · genera códigos nuevos';};
  dc.onerror=()=>stop('Error en el enlace del celular');
  dc.onmessage=e=>{
    if(role!=='pc'||localMode||typeof e.data!=='string'||e.data.length>1000)return;
    try{const data=JSON.parse(e.data);if(data.type==='stop')stop('El celular pausó el seguimiento');else consume(data);}catch{stop('Datos del celular inválidos');}
  };
}
function newPeer(){
  stop('Preparando enlace');if(pc){pc.onconnectionstatechange=null;if(channel)channel.onclose=null;pc.close();}
  pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});channel=null;lastSeq=-1;
  const current=pc;pc.onconnectionstatechange=()=>{if(pc!==current)return;if(['failed','disconnected','closed'].includes(pc.connectionState)){stop('Enlace interrumpido');$('peerPC').textContent=$('peerPhone').textContent='Enlace interrumpido · vuelve a vincular';}};
  pc.ondatachannel=e=>wireChannel(e.channel);return pc;
}
async function waitIce(peer){
  if(peer.iceGatheringState==='complete')return;
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{peer.removeEventListener('icegatheringstatechange',check);reject(Error('La red no completó la conexión. Prueba el mismo Wi-Fi y genera otro código.'));},15000);
    function check(){if(peer.iceGatheringState==='complete'){clearTimeout(timer);peer.removeEventListener('icegatheringstatechange',check);resolve();}}
    peer.addEventListener('icegatheringstatechange',check);check();
  });
}
const encodeCode=desc=>btoa(JSON.stringify({type:desc.type,sdp:desc.sdp}));
function decodeCode(text,type){
  if(text.length>100000)throw Error('Código demasiado largo');const desc=JSON.parse(atob(text.trim()));
  if(desc.type!==type||typeof desc.sdp!=='string')throw Error('Código de conexión incorrecto');return desc;
}
async function busy(button,fn){button.disabled=true;try{await fn();}catch(e){status(e.message);}finally{button.disabled=false;}}
$('offer').onclick=()=>busy($('offer'),async()=>{
  localMode=false;await stopCamera();$('offerOut').value='';$('answerIn').value='';status('Generando código…');
  const peer=newPeer();wireChannel(peer.createDataChannel('pose',{ordered:false,maxRetransmits:0}));
  await peer.setLocalDescription(await peer.createOffer());await waitIce(peer);$('offerOut').value=encodeCode(peer.localDescription);status('Pasa el código al celular y pega aquí su respuesta.');
});
$('answer').onclick=()=>busy($('answer'),async()=>{
  const offer=decodeCode($('offerIn').value,'offer');$('answerOut').value='';status('Generando respuesta…');
  const peer=newPeer();await peer.setRemoteDescription(offer);await peer.setLocalDescription(await peer.createAnswer());await waitIce(peer);$('answerOut').value=encodeCode(peer.localDescription);status('Pasa esta respuesta a la computadora y completa la conexión allí.');
});
$('acceptAnswer').onclick=()=>busy($('acceptAnswer'),async()=>{
  if(!pc||pc.signalingState!=='have-local-offer')throw Error('Primero crea un código nuevo en la computadora.');
  await pc.setRemoteDescription(decodeCode($('answerIn').value,'answer'));status('Respuesta aceptada · esperando conexión entre dispositivos…');
});
document.querySelectorAll('[data-copy]').forEach(button=>button.onclick=async()=>{
  const field=$(button.dataset.copy);try{if(!field.value)throw Error('Primero genera el código');await navigator.clipboard.writeText(field.value);status('Código copiado');}catch{field.focus();field.select();status('Selecciona y copia el código manualmente.');}
});
async function selectRole(next){
  await stopCamera();stop();if(pc){pc.close();pc=null;}channel=null;role=next;localMode=false;
  $('pcPanel').hidden=role!=='pc';$('phonePanel').hidden=role!=='phone';
  $('pcRole').classList.toggle('selected',role==='pc');$('phoneRole').classList.toggle('selected',role==='phone');
  $('cameraStart').disabled=role==='pc';
  if(role==='pc')status('Conecta el Nano y vincula el celular.');else status('Vincula el celular con el código de la computadora.');
}
$('pcRole').onclick=()=>void selectRole('pc');$('phoneRole').onclick=()=>void selectRole('phone');
$('localCamera').onclick=()=>{stop();if(pc){pc.close();pc=null;}channel=null;lastSeq=-1;localMode=true;$('cameraStart').disabled=false;status('Cámara local seleccionada · pulsa Encender cámara');};
async function loadDetector(){
  if(detector)return detector;
  if(!loadPromise)loadPromise=(async()=>{
    const {FilesetResolver,PoseLandmarker}=await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs');
    const files=await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm');
    return PoseLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'},runningMode:'VIDEO',numPoses:1,minPoseDetectionConfidence:.65,minPosePresenceConfidence:.65,minTrackingConfidence:.65});
  })().catch(e=>{loadPromise=null;throw e;});
  detector=await loadPromise;return detector;
}
const links=[[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
function draw(points){
  const video=$('video'),canvas=$('overlay');if(canvas.width!==video.videoWidth||canvas.height!==video.videoHeight){canvas.width=video.videoWidth;canvas.height=video.videoHeight;}
  const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);if(!points)return;
  ctx.strokeStyle='#42dfb8';ctx.lineWidth=4;ctx.fillStyle='#24b8ff';
  links.forEach(([a,b])=>{if((points[a].visibility??0)<.65||(points[b].visibility??0)<.65)return;ctx.beginPath();ctx.moveTo(points[a].x*canvas.width,points[a].y*canvas.height);ctx.lineTo(points[b].x*canvas.width,points[b].y*canvas.height);ctx.stroke();});
}
function loop(now){
  if(!cameraOn)return;const video=$('video');
  try{
    if(video.readyState>=2&&video.currentTime!==lastVideo&&now-lastDetection>=80){
      lastVideo=video.currentTime;lastDetection=now;const result=detector.detectForVideo(video,now);const points=result.landmarks?.[0];draw(points);
      const values=extractPose(points,video.videoWidth,video.videoHeight);
      if(values){filter=filter?values.map((v,i)=>filter[i]*.65+v*.35):values;$('trackingStatus').textContent='Cuerpo detectado';display(filter);
        const frame={type:'pose',seq:seq++,values:filter};if(role==='pc'&&localMode)consume(frame);else sendPeer(frame);
      }else{filter=null;$('trackingStatus').textContent='Encuadra hombros, caderas, codos y rodillas';if(role==='pc')stop('Cuerpo fuera de encuadre');else sendPeer({type:'stop'});}
    }
  }catch(e){void stopCamera();status('Falló la detección: '+e.message);return;}
  requestAnimationFrame(loop);
}
$('cameraStart').onclick=()=>busy($('cameraStart'),async()=>{
  if(cameraOn)return;
  if(!navigator.mediaDevices?.getUserMedia)throw Error('La cámara requiere HTTPS y un navegador compatible.');
  $('trackingStatus').textContent='Cargando detector…';
  try{await loadDetector();stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:640},height:{ideal:480}},audio:false});
    $('video').srcObject=stream;await $('video').play();cameraOn=true;lastVideo=-1;lastDetection=0;filter=null;$('cameraPlaceholder').hidden=true;
    stream.getVideoTracks().forEach(track=>track.onended=()=>void stopCamera());requestAnimationFrame(loop);
  }catch(e){await stopCamera();throw Error('No se pudo iniciar la cámara: '+e.message);}
});
async function stopCamera(){
  cameraOn=false;if(stream){stream.getTracks().forEach(track=>{track.onended=null;track.stop();});stream=null;}
  $('video').srcObject=null;$('overlay').getContext('2d').clearRect(0,0,$('overlay').width,$('overlay').height);$('cameraPlaceholder').hidden=false;$('trackingStatus').textContent='Cámara apagada';filter=null;
  if(role==='pc')stop('Cámara detenida');else sendPeer({type:'stop'});
}
$('cameraStop').onclick=()=>void stopCamera();
document.addEventListener('visibilitychange',()=>{if(document.hidden){if(role==='pc')stop('La página pasó a segundo plano');else{sendPeer({type:'stop'});void stopCamera();}}});
window.addEventListener('pagehide',()=>{sendPeer({type:'stop'});void sendSerial('S');stream?.getTracks().forEach(t=>t.stop());});
$('cameraStart').disabled=true;

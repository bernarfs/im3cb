export function normalizePin(value){
  const pin=String(value).replace(/\s/g,'');
  if(!/^\d{8}$/.test(pin))throw Error('Escribe los 8 números del PIN.');
  return pin;
}
export function makePin(){
  const data=new Uint32Array(1);let value;
  do{crypto.getRandomValues(data);value=data[0];}while(value>=4200000000);
  return String(value%100000000).padStart(8,'0');
}
export async function peerId(pin){
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('im3cb-video-v3:'+normalizePin(pin)));
  return 'im3cb-video-'+Array.from(new Uint8Array(bytes)).slice(0,16).map(v=>v.toString(16).padStart(2,'0')).join('');
}
export const formatPin=pin=>pin.slice(0,4)+' '+pin.slice(4);
export function rtcConfig(relayOnly=false){return {
  iceTransportPolicy:relayOnly?'relay':'all',
  iceServers:[{urls:'stun:stun.l.google.com:19302'}]
};}
export async function networkSettings(){
  const response=await fetch(new URL('./camara-network.json',import.meta.url),{cache:'no-store',signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw Error('No se pudo leer la configuración de video. Actualiza la página.');
  const settings=await response.json();
  if(settings.meteredPublishableKey&&!/^pk_live_[A-Za-z0-9_-]+$/.test(settings.meteredPublishableKey))throw Error('Configura únicamente la clave publicable de video, no una clave privada.');
  return settings;
}
export async function relayConfig(relayOnly=false,settings){
  settings??=await networkSettings();
  const config=rtcConfig(relayOnly);
  // The endpoint returns short-lived browser ICE credentials. Private provider
  // API keys stay on that server and must never be placed in GitHub Pages.
  if(settings.iceServersUrl){
    const url=new URL(settings.iceServersUrl);
    if(url.protocol!=='https:')throw Error('La conexión de video necesita un servidor HTTPS.');
    const result=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(!result.ok)throw Error('La retransmisión de video no está disponible. Intenta más tarde.');
    const data=await result.json();const servers=data.iceServers??data;
    if(!Array.isArray(servers)||!servers.some(s=>JSON.stringify(s.urls).includes('turn:')||JSON.stringify(s.urls).includes('turns:')))throw Error('El servicio de video no devolvió la retransmisión necesaria.');
    config.iceServers.push(...servers);
  }else if(relayOnly)throw Error('Falta configurar el servicio de retransmisión de video.');
  return config;
}
let peerLoad;
export async function peerClass(){
  if(window.Peer)return window.Peer;
  if(!peerLoad)peerLoad=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=new URL('./camara-vendor/peerjs.min.js',import.meta.url).href;
    script.onload=()=>window.Peer?resolve(window.Peer):reject(Error('No se pudo iniciar el enlace de video.'));
    script.onerror=()=>{script.remove();reject(Error('No se pudo cargar el enlace de video. Actualiza la página.'));};document.head.append(script);
  }).catch(e=>{peerLoad=null;throw e;});
  return peerLoad;
}
export async function openPeer(id,relayOnly=false){
  const settings=await networkSettings();
  if(settings.meteredPublishableKey){
    const {createMeteredAdapter}=await import('./metered-camera.mjs');
    return createMeteredAdapter(id,settings.meteredPublishableKey,relayOnly);
  }
  const Peer=await peerClass();const peer=new Peer(id,{secure:true,debug:0,config:await relayConfig(relayOnly,settings)});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{peer.destroy();reject(Error('No se pudo conectar por Internet. Intenta otra vez.'));},14000);
    const onError=e=>{clearTimeout(timer);peer.destroy();reject(Error(e.type==='unavailable-id'?'Este PIN ya está en uso. Genera uno nuevo.':'No se pudo abrir el enlace por Internet.'));};
    peer.once('error',onError);peer.once('open',()=>{clearTimeout(timer);peer.off('error',onError);resolve();});
  });return peer;
}

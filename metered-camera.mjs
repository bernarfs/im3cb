// Adapts the documented MeteredPeer events to this page's one-way video session.
// Only a browser publishable pk_live_ key is accepted. TURN is supplied by SDK.
class Emitter {
  listeners=new Map();
  on(name,callback){if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(callback);return this;}
  emit(name,value){for(const callback of this.listeners.get(name)??[])callback(value);}
}
class VideoCall extends Emitter {
  constructor(close){super();this.finish=close;this.closed=false;this.answered=false;this.stream=null;
    this.peerConnection=new EventTarget();this.peerConnection.connectionState='connecting';
  }
  state(value){if(this.closed)return;this.peerConnection.connectionState=value;this.peerConnection.dispatchEvent(new Event('connectionstatechange'));}
  receive(stream,metadata){this.stream=stream;this.metadata=metadata;if(this.answered&&!this.closed)this.emit('stream',stream);}
  answer(){this.answered=true;if(this.stream)queueMicrotask(()=>{if(!this.closed)this.emit('stream',this.stream);});}
  close(){if(this.closed)return;this.closed=true;this.finish();this.emit('close');}
}
class MeteredAdapter extends Emitter {
  constructor(client,isReceiver){super();this.client=client;this.isReceiver=isReceiver;this.destroyed=false;this.calls=new Map();this.queued=[];
    client.on('error',()=>this.emit('error',{type:'network'}));
    client.on('state-change',({to})=>{if(to==='reconnecting')this.emit('disconnected');});
    client.on('peer-left',({peer})=>this.calls.get(peer.id)?.close());
    client.on('peer-joined',({peer})=>this.watch(peer));
  }
  on(name,callback){super.on(name,callback);if(name==='call'&&this.queued.length){const queue=this.queued.splice(0);queueMicrotask(()=>{if(!this.destroyed)for(const value of queue)this.emit('call',value);});}return this;}
  watch(remote){
    if(this.destroyed)return;
    if(this.isReceiver){
      remote.on('stream-added',({stream,metadata})=>{
        if(this.destroyed)return;
        let incoming=this.calls.get(remote.id);
        if(!incoming){incoming=new VideoCall(()=>{remote.pc.close();});this.calls.set(remote.id,incoming);
          incoming.receive(stream,metadata);
          if(this.listeners.get('call')?.length)this.emit('call',incoming);else this.queued.push(incoming);
        }else incoming.receive(stream,metadata);
      });
      remote.on('stream-removed',()=>this.calls.get(remote.id)?.close());
    }else if(this.outgoing){
      // The first peer in the secret PIN room is the receiving computer.
      if(this.outgoing.remoteId&&this.outgoing.remoteId!==remote.id){remote.pc.close();return;}
      this.outgoing.remoteId=remote.id;this.calls.set(remote.id,this.outgoing);
      const update=state=>this.outgoing.state(state==='reconnecting'?'disconnected':state==='idle'?'connecting':state);
      remote.on('state-change',({to})=>update(to));update(remote.state);
    }
  }
  call(id,stream,options){
    if(this.isReceiver||this.destroyed)throw Error('La sesión de video no está disponible.');
    const outgoing=new VideoCall(()=>this.destroy());this.outgoing=outgoing;
    // Joining is asynchronous; the page gets a state object immediately and can
    // cancel the camera while the network request is still in flight.
    void this.client.join(id).then(()=>{
      if(this.destroyed||outgoing.closed)return;
      for(const remote of this.client.remotePeers)this.watch(remote);
      this.client.addStream(stream,options.metadata);
    }).catch(()=>{if(!this.destroyed)outgoing.emit('error',{type:'network'});});
    return outgoing;
  }
  destroy(){
    if(this.destroyed)return;this.destroyed=true;
    for(const video of this.calls.values()){video.closed=true;video.emit('close');}
    this.queued=[];void this.client.close().catch(()=>{});
  }
}
export async function createMeteredAdapter(id,key,relayOnly=false,SDK){
  if(!/^pk_live_[A-Za-z0-9_-]+$/.test(key))throw Error('Se necesita una clave publicable pk_live_, no una clave privada.');
  const MeteredPeer=SDK??(await import('./camara-vendor/metered-realtime.mjs')).MeteredPeer;
  const options={apiKey:key};
  if(relayOnly)options.rtcPeerConnectionFactory=config=>new RTCPeerConnection({...config,iceTransportPolicy:'relay'});
  const client=new MeteredPeer(options);const adapter=new MeteredAdapter(client,!!id);
  if(id){
    let timer;
    try{await Promise.race([client.join(id),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('El servicio de video no respondió.')),14000);})]);}
    catch{adapter.destroy();throw Error('No se pudo abrir el servicio de video. Revisa la clave publicable y los permisos Send, Publish, Subscribe y Presence.');}
    finally{clearTimeout(timer);}
  }
  return adapter;
}

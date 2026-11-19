export class ArduinoCamera {
  constructor(onStatus,onState){
    this.onStatus=onStatus;this.onState=onState;this.ready=false;this.armed=false;
    this.pending=false;this.lastPose=-Infinity;this.lastSend=0;
    this.timer=setInterval(()=>{
      if((this.armed||this.pending)&&performance.now()-this.lastPose>450)this.stop('Movimiento detenido: se perdió el cuerpo o el video.');
      if(this.pending&&performance.now()-this.armTime>1500)this.stop('El Arduino no confirmó la activación.');
    },100);
  }
  async send(line){
    if(!this.writer)return;
    if(this.busy){if(line==='S')this.pendingStop=true;return;}
    this.busy=true;
    try{await this.writer.write(new TextEncoder().encode(line+'\n'));}
    catch{this.ready=false;this.armed=false;this.pending=false;this.onStatus('USB desconectado');this.onState(false);}
    finally{this.busy=false;if(this.pendingStop){this.pendingStop=false;void this.send('S');}}
  }
  stop(message='Movimiento desactivado'){
    this.armed=false;this.pending=false;void this.send('S');this.onState(this.ready);this.onStatus(message);
  }
  activate(){
    if(!this.ready)throw Error('Primero conecta el Arduino.');
    if(performance.now()-this.lastPose>350)throw Error('Primero encuadra todo el cuerpo en el video.');
    this.pending=true;this.armTime=performance.now();this.onStatus('Activando la postura de reposo…');void this.send('A');
  }
  pose(angles){
    this.lastPose=performance.now();
    if(this.armed&&this.lastPose-this.lastSend>=60){this.lastSend=this.lastPose;void this.send('M,'+angles.join(','));}
  }
  line(line){
    if(line==='IM3CB_NANO_1'){this.ready=true;this.onState(true);this.onStatus('Arduino conectado · movimiento desactivado');}
    if(line==='ARMED'){
      if(this.pending){this.pending=false;this.armed=true;this.onStatus('Movimiento activado');this.onState(this.ready);}else void this.send('S');
    }
    if(line==='TIMEOUT'||line==='INVALID')this.stop('El Arduino detuvo el movimiento. Actívalo otra vez para continuar.');
  }
  async read(currentPort){
    const reader=currentPort.readable.getReader();this.reader=reader;let buffer='';const decoder=new TextDecoder();
    try{while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});
      let index;while((index=buffer.indexOf('\n'))>=0){this.line(buffer.slice(0,index).trim());buffer=buffer.slice(index+1);}if(buffer.length>2048)buffer='';}
    }catch{this.onStatus('Lectura USB interrumpida');}
    finally{reader.releaseLock();if(this.reader===reader)this.reader=null;this.ready=false;this.stop('USB desconectado');}
  }
  async connect(){
    if(!navigator.serial)throw Error('Para conectar el Arduino usa Chrome o Edge en la computadora.');
    if(this.port){this.stop();if(this.reader)await this.reader.cancel();if(this.writer){this.writer.releaseLock();this.writer=null;}await this.port.close();this.port=null;}
    const port=await navigator.serial.requestPort();
    try{await port.open({baudRate:115200});}catch{throw Error('No se pudo abrir el puerto. Cierra el monitor serie de Arduino IDE e intenta de nuevo.');}
    this.port=port;this.writer=port.writable.getWriter();this.ready=false;void this.read(port);this.onStatus('Reconociendo el Arduino…');
    const started=performance.now();clearInterval(this.probe);
    this.probe=setInterval(()=>{
      if(this.ready||performance.now()-started>7000){clearInterval(this.probe);if(!this.ready)this.onStatus('Carga el programa de cámara en el Arduino y vuelve a conectar.');}
      else void this.send('P');
    },400);
  }
}

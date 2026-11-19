export const CHANNELS = [
  {name:'Brazo derecho', pin:9, neutral:180, end:150, min:150, max:180},
  {name:'Brazo izquierdo', pin:5, neutral:100, end:115, min:85, max:115},
  {name:'Pierna derecha', pin:3, neutral:10, end:40, min:10, max:40},
  {name:'Pierna izquierda', pin:11, neutral:90, end:105, min:75, max:105}
];
export function validFrame(frame) {
  return frame && frame.type === 'pose' && Number.isSafeInteger(frame.seq) && frame.seq >= 0 &&
    Array.isArray(frame.values) && frame.values.length === 4 &&
    frame.values.every(v => Number.isFinite(v) && v >= 0 && v <= 1);
}
export function targets(values) {
  if (!Array.isArray(values) || values.length !== 4 || !values.every(Number.isFinite)) throw Error('Datos inválidos');
  return values.map((v,i) => {
    const c=CHANNELS[i];
    return Math.round(Math.max(c.min,Math.min(c.max,c.neutral+(c.end-c.neutral)*Math.max(0,Math.min(1,v)))));
  });
}
export function extractPose(points, width, height) {
  const indices=[11,12,13,14,23,24,25,26];
  if (!points || !indices.every(i=>points[i] && (points[i].visibility??0) >= .65 &&
      Number.isFinite(points[i].x) && Number.isFinite(points[i].y))) return null;
  const p=i=>[points[i].x*width,points[i].y*height];
  const vector=(a,b)=>[b[0]-a[0],b[1]-a[1]];
  const angle=(a,b)=>{
    const length=Math.hypot(...a)*Math.hypot(...b);
    return length<1?null:Math.acos(Math.max(-1,Math.min(1,(a[0]*b[0]+a[1]*b[1])/length)))*180/Math.PI;
  };
  const limb=(s,h,j,leg=false)=>angle(vector(p(s),p(h)),vector(p(leg?h:s),p(j)));
  const raw=[limb(12,24,14),limb(11,23,13),limb(12,24,26,true),limb(11,23,25,true)];
  if(raw.some(v=>v===null))return null;
  return raw.map((v,i)=>Math.min(1,Math.max(0,v/(i<2?100:65))));
}

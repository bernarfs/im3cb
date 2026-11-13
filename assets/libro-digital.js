(function(){
  "use strict";
  const vistaDocente=new URLSearchParams(location.search).get("vista_docente")==="1"&&sessionStorage.getItem("im3cb_panel_docente")==="autorizado";
  document.querySelectorAll(".libro-digital").forEach(iniciarLibro);

  function iniciarLibro(libro){
    const datosNodo=libro.querySelector(".libro-datos");
    if(!datosNodo)return;
    let datos;
    try{datos=JSON.parse(datosNodo.textContent)}catch(error){console.error("Libro digital inválido",error);return}
    const paginas=(datos.paginas||[]).filter(p=>!p.docente||vistaDocente);
    const lector=libro.querySelector(".libro-lector");
    const indice=libro.querySelector(".libro-indice");
    const imagen=libro.querySelector(".libro-imagen");
    const titulo=libro.querySelector(".libro-titulo-pagina");
    const contador=libro.querySelector(".libro-contador");
    const abrir=libro.querySelector(".libro-abrir");
    const anterior=libro.querySelector('[data-accion="anterior"]');
    const siguiente=libro.querySelector('[data-accion="siguiente"]');
    const ampliar=libro.querySelector('[data-accion="abrir-imagen"]');
    const zoom=libro.querySelector(".libro-zoom input");
    const clave="im3cb_libro_"+(datos.id||"curso");
    let actual=Math.max(0,Math.min(Number(localStorage.getItem(clave))||0,paginas.length-1));

    if(!paginas.length){lector.innerHTML='<div class="libro-vacio">No hay páginas disponibles.</div>';return}
    indice.innerHTML='<h3>Índice de páginas</h3>';
    paginas.forEach((pagina,i)=>{
      const boton=document.createElement("button");
      boton.type="button";
      boton.className="libro-miniatura"+(pagina.docente?" docente":"");
      boton.innerHTML='<img loading="lazy" alt="" src="'+escaparAtributo(pagina.src)+'"><span>'+escaparTexto(pagina.titulo)+(pagina.docente?'<em class="libro-etiqueta-docente">DOCENTE</em>':'')+'<small>'+escaparTexto(pagina.seccion||"")+'</small></span>';
      boton.addEventListener("click",()=>mostrar(i));
      indice.appendChild(boton);
    });
    abrir.addEventListener("click",()=>{lector.hidden=!lector.hidden;abrir.textContent=lector.hidden?"📖 Abrir libro digital":"✕ Cerrar libro";if(!lector.hidden)mostrar(actual)});
    anterior.addEventListener("click",()=>mostrar((actual-1+paginas.length)%paginas.length));
    siguiente.addEventListener("click",()=>mostrar((actual+1)%paginas.length));
    ampliar.addEventListener("click",e=>{e.preventDefault();window.open(paginas[actual].src,"_blank","noopener")});
    libro.querySelector('[data-accion="pantalla-completa"]').addEventListener("click",()=>{if(!document.fullscreenElement)libro.requestFullscreen?.();else document.exitFullscreen?.()});
    libro.querySelector('[data-accion="imprimir"]').addEventListener("click",()=>{document.body.classList.add("libro-imprimiendo");window.print();setTimeout(()=>document.body.classList.remove("libro-imprimiendo"),400)});
    zoom.addEventListener("input",()=>imagen.style.width=zoom.value+"%");
    libro.addEventListener("keydown",e=>{if(lector.hidden)return;if(e.key==="ArrowLeft")anterior.click();if(e.key==="ArrowRight")siguiente.click()});

    function mostrar(i){
      actual=i;const pagina=paginas[i];
      imagen.src=pagina.src;imagen.alt=pagina.alt||pagina.titulo;
      titulo.textContent=pagina.titulo;contador.textContent=(i+1)+" / "+paginas.length;
      ampliar.href=pagina.src;localStorage.setItem(clave,String(i));
      indice.querySelectorAll(".libro-miniatura").forEach((b,n)=>b.classList.toggle("activa",n===i));
      anterior.disabled=paginas.length<2;siguiente.disabled=paginas.length<2;
      imagen.style.width=zoom.value+"%";
    }
    mostrar(actual);
  }
  function escaparTexto(valor){const d=document.createElement("div");d.textContent=String(valor||"");return d.innerHTML}
  function escaparAtributo(valor){return String(valor||"").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;")}
})();

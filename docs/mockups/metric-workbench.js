/* Design-only desktop split panes. Pointer Events + ResizeObserver; no packages. */
(() => {
  function create({ onResize }) {
    const modal=document.getElementById('modal'), workspace=document.getElementById('workspace');
    const minimum=[180,300,200,280], dividers=[...workspace.querySelectorAll('[data-divider]')];
    let widths=null, drag=null, frame=null;
    const maximum=()=>({width:Math.max(320,innerWidth-48),height:Math.max(240,innerHeight-48)});
    const available=()=>Math.max(minimum.reduce((a,b)=>a+b,0),workspace.clientWidth-18);
    function fit() {
      const total=available();
      if(!widths) widths=[240,390,250,Math.max(280,total-880)];
      if(Math.abs(widths.reduce((a,b)=>a+b,0)-total)<.5) return;
      const old=[...widths];let low=0,high=Math.max(2,total/old.reduce((a,b)=>a+b,0)*2);
      for(let i=0;i<40;i++){const scale=(low+high)/2,sum=old.reduce((sum,w,i)=>sum+Math.max(minimum[i],w*scale),0);if(sum>total)high=scale;else low=scale;}
      widths=old.map((w,i)=>Math.max(minimum[i],w*low));
    }
    function paint() {
      if(!widths)return;
      const dashboard=workspace.dataset.view==='dashboard';
      workspace.style.gridTemplateColumns=dashboard?`minmax(0,1fr)`:widths.map(w=>`${w}px`).join(' 6px ');
      dividers.forEach((el,i)=>{
        const pair=dashboard&&i===0?workspace.clientWidth-6:widths[i]+widths[i+1];
        el.setAttribute('aria-controls',['library-pane','definition-pane','reference-pane'][i]);
        el.setAttribute('aria-valuemin',String(minimum[i]));
        el.setAttribute('aria-valuemax',String(Math.round(Math.max(minimum[i],pair-(dashboard?300:minimum[i+1])))));
        el.setAttribute('aria-valuenow',String(Math.round(widths[i])));
        el.setAttribute('aria-valuetext',`${Math.round(widths[i])} pixels`);
      });
      dividers[0].setAttribute('aria-label',`Resize metric list and ${dashboard?'dashboard':'editor'} panes`);
      cancelAnimationFrame(frame);frame=requestAnimationFrame(onResize);
    }
    function syncMode() {if(!modal.getClientRects().length)return;fit();paint();}
    function adjust(i,delta,base=widths) {
      if(workspace.dataset.view==='dashboard'){
        widths[0]=Math.max(minimum[0],Math.min(workspace.clientWidth-306,base[0]+delta));
      } else {
        const sum=base[i]+base[i+1];
        widths[i]=Math.max(minimum[i],Math.min(sum-minimum[i+1],base[i]+delta));widths[i+1]=sum-widths[i];
      }
      paint();
    }
    function setModal(width,height) {
      const max=maximum();
      modal.style.width=Math.max(Math.min(1040,max.width),Math.min(max.width,width))+'px';
      modal.style.height=Math.max(Math.min(520,max.height),Math.min(max.height,height))+'px';
      fit();paint();
    }
    function resetPanes() {widths=null;fit();paint();}
    function reset() {modal.style.width='';modal.style.height='';resetPanes();}
    function begin(event,kind,index) {
      if(event.button!==0||drag)return;
      event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);
      drag={kind,index,id:event.pointerId,el:event.currentTarget,x:event.clientX,y:event.clientY,width:modal.offsetWidth,height:modal.offsetHeight,styleWidth:modal.style.width,styleHeight:modal.style.height,widths:[...widths]};
      document.body.classList.add('resizing-workbench');document.body.style.cursor=kind==='modal'?'nwse-resize':'col-resize';
    }
    function end(cancel=false) {
      if(!drag)return;
      if(cancel){modal.style.width=drag.styleWidth;modal.style.height=drag.styleHeight;widths=drag.widths;paint();}
      if(drag.el.hasPointerCapture(drag.id))drag.el.releasePointerCapture(drag.id);
      drag=null;document.body.classList.remove('resizing-workbench');document.body.style.cursor='';
    }
    dividers.forEach((el,i)=>{
      el.onpointerdown=e=>begin(e,'pane',i);
      el.ondblclick=resetPanes;
      el.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();adjust(i,(e.key==='ArrowRight'?1:-1)*(e.shiftKey?50:10));}if(e.key==='Home'){e.preventDefault();resetPanes();}};
    });
    const handle=document.getElementById('modal-resize');
    handle.onpointerdown=e=>begin(e,'modal');
    handle.onkeydown=e=>{
      const step=e.shiftKey?50:10;
      if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();setModal(modal.offsetWidth+(e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0),modal.offsetHeight+(e.key==='ArrowDown'?step:e.key==='ArrowUp'?-step:0));}
      if(e.key==='Home'){e.preventDefault();reset();}
    };
    document.addEventListener('pointermove',e=>{
      if(!drag||e.pointerId!==drag.id)return;
      if(drag.kind==='pane')adjust(drag.index,e.clientX-drag.x,drag.widths);
      // Dialog stays centered; double delta keeps its dragged corner under the pointer.
      else setModal(drag.width+2*(e.clientX-drag.x),drag.height+2*(e.clientY-drag.y));
    });
    document.addEventListener('pointerup',e=>{if(drag&&e.pointerId===drag.id)end();});
    document.addEventListener('pointercancel',e=>{if(drag&&e.pointerId===drag.id)end(true);});
    document.addEventListener('keydown',e=>{if(drag&&e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();end(true);}},true);
    document.getElementById('reset-workbench').onclick=reset;
    new ResizeObserver(()=>{if(modal.getClientRects().length){fit();paint();}}).observe(workspace);
    window.addEventListener('resize',()=>{if(modal.style.width||modal.style.height)setModal(modal.offsetWidth,modal.offsetHeight);syncMode();});
    return {syncMode,reset,cancel:()=>end(true)};
  }
  window.metricWorkbench={create};
})();

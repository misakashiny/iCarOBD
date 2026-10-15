'use strict';
(function(){
  const library=window.NEXT_LIBRARY;
  if(!library)throw new Error('New library manifest is missing');
  function assetId(style){
    const asset=library.assets.find(a=>a.name===style.id+'-panel');
    const d=window.CanvasState.design;
    const found=(d.assets||[]).find(a=>a.path===asset.path);
    if(found)return found.id;
    const id=window.newId('as');
    d.assets.push({id,name:asset.label,kind:asset.kind,path:asset.path,data:asset.data,w:asset.w,h:asset.h,builtin:true});
    return id;
  }
  function make(def,style){
    const info=window.BUILTIN_PIDS[def.pid];
    if(!info||window.resolvePid(def.alias)!==def.pid)throw new Error('PID mismatch: '+def.id);
    const canvas=window.CanvasState.design.canvas;
    const edge=120*(canvas.scaleMode===0?Math.min(1,canvas.designW/canvas.designH):1);
    const frame=window.createNode(window.NODE_IMAGE,{name:style.name+'底板',x:(120-edge)/2,y:(120-edge)/2,w:edge,h:edge,assetId:assetId(style),z:0});
    const gauge=window.createNode(window.NODE_GAUGE,{name:def.name,pid:def.alias,x:6,y:6,w:108,h:108,z:1,
      style:style.gaugeStyle,min:info.min,max:info.max,warnLow:info.warnLow,warnHigh:info.warnHigh,
      card:{show:false},cardStyle:3,labelFont:{size:10,color:'#E8EEF7',face:'sans',weight:500},
      ringStyle:style.id==='sport'?1:0,ringSegments:32,showLabel:true,showRange:false});
    const group=window.createNode(window.NODE_GROUP,{name:def.name+' · '+style.name,x:0,y:0,w:120,h:120});
    group.children=[frame,gauge];
    return group;
  }
  const controls=[];
  library.controls.forEach(def=>library.styles.forEach(style=>controls.push({
    key:'next_'+def.id+'_'+style.id,name:def.name+' · '+style.name,icon:'◉',cat:'新控件 · '+style.name,
    next:true,semanticId:def.id,variant:style.id,make:()=>make(def,style)
  })));
  window.NEXT_CONTROLS=controls;
  window.BUILTIN_CONTROLS.unshift(...controls);
  window.CTRL_CATS.unshift(...library.styles.map(s=>'新控件 · '+s.name));
})();

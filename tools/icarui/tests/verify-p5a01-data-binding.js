// ============================================================================
// verify-p5a01-data-binding.js —— P5A-M01 阶段 C：仪表与轨道动态联调
//
// 对象：docs/02_验证记录/android-theme/designdata-bind.json（v2 布局）
//   y  10..70   仪表 ×3（转速 / 车速 / 水温）
//   y  90..120  轨道 t_speed / t_rpm
//   y 140..170  轨道 t_load / t_throttle
//   y 190..250  垂直轨道 t_vspeed
//
// 判定：**不同场景截图的同区域像素差异**。
//   数值变了 → 指针/填充/文字必然变 → 区域必然不同。
//   注意：本套件证明「数据驱动了渲染」，**不证明**「数值显示得对」
//   （那需要 OCR，不可靠；数值正确性由 JVM 单测 + 日志 dump 证明）。
// ============================================================================
const fs=require("fs"),path=require("path"),zlib=require("zlib");

const SHOT=path.join(__dirname,"..","..","..","docs","02_验证记录","screenshots");

function decodePNG(p){
  const b=fs.readFileSync(p);
  let pos=8,w=0,h=0,idat=[];
  while(pos<b.length){
    const len=b.readUInt32BE(pos), ty=b.toString("ascii",pos+4,pos+8);
    if(ty==="IHDR"){w=b.readUInt32BE(pos+8);h=b.readUInt32BE(pos+12);}
    if(ty==="IDAT")idat.push(b.slice(pos+8,pos+8+len));
    if(ty==="IEND")break;
    pos+=12+len;
  }
  const raw=zlib.inflateSync(Buffer.concat(idat));
  const bpp=4, stride=w*bpp;
  const out=Buffer.alloc(w*h*4);
  let rp=0;
  for(let y=0;y<h;y++){
    const f=raw[rp++];
    for(let x=0;x<stride;x++){
      const cur=raw[rp+x];
      const a=x>=bpp?out[y*stride+x-bpp]:0;
      const bb=y>0?out[(y-1)*stride+x]:0;
      const c=(x>=bpp&&y>0)?out[(y-1)*stride+x-bpp]:0;
      let v;
      if(f===0)v=cur;else if(f===1)v=cur+a;else if(f===2)v=cur+bb;
      else if(f===3)v=cur+Math.floor((a+bb)/2);
      else{const p2=a+bb-c,pa=Math.abs(p2-a),pb=Math.abs(p2-bb),pc=Math.abs(p2-c);
           v=cur+((pa<=pb&&pa<=pc)?a:(pb<=pc?bb:c));}
      out[y*stride+x]=v&255;
    }
    rp+=stride;
  }
  return {w,h,px:out};
}

function diffRegion(A,B,x0,y0,x1,y1){
  let n=0,differ=0,sumd=0;
  const X0=Math.max(0,Math.ceil(x0)),X1=Math.min(A.w,Math.floor(x1));
  const Y0=Math.max(0,Math.ceil(y0)),Y1=Math.min(A.h,Math.floor(y1));
  for(let y=Y0;y<Y1;y+=2){
    for(let x=X0;x<X1;x+=2){
      const i=(y*A.w+x)*4;
      const d=Math.abs(A.px[i]-B.px[i])+Math.abs(A.px[i+1]-B.px[i+1])+Math.abs(A.px[i+2]-B.px[i+2]);
      n++; sumd+=d;
      if(d>18) differ++;
    }
  }
  return {n, differ, ratio: n?differ/n:0, avgDiff: n?sumd/n:0};
}

// 画布区：整屏宽、从 top 开始铺满剩余高度
function mapper(img){
  const top=128;
  return (dx,dy)=>[dx/360*img.w, top + dy/360*(img.h-top)];
}

const SCENES={
  normal:"p5a-c-normal.png",
  accel:"p5a-c-accel.png",
  alarm:"p5a-c-alarm.png",
  warmup:"p5a-c-warmup.png",
  disconnect:"p5a-c-disconnect.png",
  recover:"p5a-c-recover.png"
};

// 与 designdata-bind.json v2 完全一致
const ELEM=[
  {id:"g_rpm",     kind:"gauge", x:10, y:10,  w:100,h:60},
  {id:"g_speed",   kind:"gauge", x:130,y:10,  w:100,h:60},
  {id:"g_coolant", kind:"gauge", x:250,y:10,  w:100,h:60},
  {id:"t_speed",   kind:"track", x:10, y:90,  w:160,h:30},
  {id:"t_rpm",     kind:"track", x:190,y:90,  w:160,h:30},
  {id:"t_load",    kind:"track", x:10, y:140, w:160,h:30},
  {id:"t_throttle",kind:"track", x:190,y:140, w:160,h:30},
  {id:"t_vspeed",  kind:"track", x:320,y:190, w:30, h:60}
];

let pass=0,fail=0;
function ok(c,m){ c?(pass++,console.log("  ✅ "+m)):(fail++,console.log("  ❌ "+m)); }

console.log("=== P5A-M01 阶段 C：仪表与轨道动态联调 ===\n");

const imgs={};
Object.keys(SCENES).forEach(function(k){
  const p=path.join(SHOT,SCENES[k]);
  if(fs.existsSync(p)){
    imgs[k]=decodePNG(p);
    console.log("  载入 "+k.padEnd(11)+" "+imgs[k].w+"×"+imgs[k].h);
  }
});

const have=Object.keys(imgs);
if(have.length<2){ console.log("FATAL 截图不足"); process.exit(1); }

const base=imgs.normal||imgs[have[0]];
const mp=mapper(base);

function rd(k1,k2,e){
  const A=imgs[k1],B=imgs[k2];
  if(!A||!B) return null;
  const [x0,y0]=mp(e.x,e.y);
  const [x1,y1]=mp(e.x+e.w,e.y+e.h);
  return diffRegion(A,B,x0,y0,x1,y1);
}

// ============ C0. 元素都已渲染（静态检查）============
console.log("\n=== C0. 元素确实渲染出来了（非空白）===");
// 非背景像素（亮度 > 20）占比
function density(img,e){
  const [x0,y0]=mp(e.x,e.y);
  const [x1,y1]=mp(e.x+e.w,e.y+e.h);
  let n=0,lit=0;
  for(let y=Math.ceil(y0);y<Math.min(img.h,Math.floor(y1));y+=2){
    for(let x=Math.ceil(x0);x<Math.min(img.w,Math.floor(x1));x+=2){
      const i=(y*img.w+x)*4;
      const s=img.px[i]+img.px[i+1]+img.px[i+2];
      n++; if(s>60) lit++;
    }
  }
  return n?lit/n:0;
}
let rendered=0;
ELEM.forEach(function(e){
  const d=density(base,e);
  const good=d>0.01;
  if(good) rendered++;
  console.log("  "+(good?"✅":"❌")+" "+e.id.padEnd(12)+" 内容密度="+(d*100).toFixed(2)+"%");
});
ok(rendered===ELEM.length,"C0 "+rendered+"/"+ELEM.length+" 元素在画布上真实渲染");

// ============ C1. 数值实时变化 ============
console.log("\n=== C1. 仪表随数值变化（normal vs accel）===");
const gauges=ELEM.filter(e=>e.kind==="gauge");
let gC=0;
gauges.forEach(function(g){
  const d=rd("normal","accel",g);
  if(!d) return;
  const ch=d.ratio>0.005;
  if(ch) gC++;
  console.log("  "+(ch?"✅":"❌")+" "+g.id.padEnd(11)+" 差异="+(d.ratio*100).toFixed(2)+"% 色差="+d.avgDiff.toFixed(0));
});
ok(gC===gauges.length,"C1 "+gC+"/"+gauges.length+" 仪表随数据变化");

// ============ C2. 轨道随数值变化 ============
console.log("\n=== C2. 轨道随数值变化（normal vs accel）===");
const tracks=ELEM.filter(e=>e.kind==="track");
let tC=0;
tracks.forEach(function(t){
  const d=rd("normal","accel",t);
  if(!d) return;
  const ch=d.ratio>0.005;
  if(ch) tC++;
  console.log("  "+(ch?"✅":"❌")+" "+t.id.padEnd(12)+" 差异="+(d.ratio*100).toFixed(2)+"% 色差="+d.avgDiff.toFixed(0));
});
ok(tC===tracks.length,"C2 "+tC+"/"+tracks.length+" 轨道随数据变化");

// ============ C3. 报警阈值 ============
console.log("\n=== C3. warnLow/warnHigh（normal vs alarm）===");
let aC=0;
ELEM.forEach(function(e){
  const d=rd("normal","alarm",e);
  if(!d) return;
  if(d.ratio>0.005) aC++;
});
ok(aC>=ELEM.length-1,"C3 "+aC+"/"+ELEM.length+" 元素在报警场景下变化");

// ============ C4. 数据断开 ============
console.log("\n=== C4. 数据断开 UI 回落（accel vs disconnect）===");
if(imgs.disconnect){
  let dC=0;
  ELEM.forEach(function(e){
    const d=rd("accel","disconnect",e);
    if(!d) return;
    const ch=d.ratio>0.005;
    if(ch) dC++;
    console.log("  "+(ch?"✅":"❌")+" "+e.id.padEnd(12)+" 差异="+(d.ratio*100).toFixed(2)+"%");
  });
  ok(dC===ELEM.length,"C4 "+dC+"/"+ELEM.length+" 元素在断开后回落");
} else { ok(false,"C4 缺截图"); }

// ============ C5. 数据恢复 ============
console.log("\n=== C5. 数据恢复后 UI 回来（disconnect vs recover）===");
if(imgs.disconnect&&imgs.recover){
  let rC=0;
  ELEM.forEach(function(e){
    const d=rd("disconnect","recover",e);
    if(!d) return;
    if(d.ratio>0.005) rC++;
  });
  ok(rC===ELEM.length,"C5 "+rC+"/"+ELEM.length+" 元素在恢复后重新有值");
} else { ok(false,"C5 缺截图"); }

// ============ C6. 暖机 ============
console.log("\n=== C6. 温度升高（normal vs warmup）===");
if(imgs.warmup){
  const g=ELEM.filter(e=>e.id==="g_coolant")[0];
  const d=rd("normal","warmup",g);
  ok(d && d.ratio>0.005,"C6 水温仪表随暖机变化（"+(d?(d.ratio*100).toFixed(2):"?")+"%）");
} else { ok(false,"C6 缺截图"); }

// ============ C7. 场景互不相同 ============
console.log("\n=== C7. 六种场景截图互不相同 ===");
const hashes={};
have.forEach(function(k){
  const p=path.join(SHOT,SCENES[k]);
  const b=fs.readFileSync(p);
  hashes[k]=b.length+"";
});
const uniq=new Set(Object.values(hashes));
ok(uniq.size===have.length,"C7 "+have.length+" 个场景产生 "+uniq.size+" 种不同截图");

// ============ 汇总 ============
console.log("\n=== 汇总 ===");
console.log("  通过="+pass+" 失败="+fail);
console.log("\n  本套件证明：数据变化 → 画布像素变化（真实渲染链路连通）");
console.log("  本套件不证明：屏幕上的数字读数是否正确（需 OCR / 人工）");
console.log("  数值正确性另由：JVM 单测（SimScenarioTest）+ BUSD 日志 dump 证明");

process.exitCode=fail?1:0;

// ---- runner 需要的标准输出（run-browser-tests.ps1 解析这一行）----
console.log("PASS=" + pass + " FAIL=" + fail);

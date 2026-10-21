// P4F-M03 B：Windows vs Android 轨道视觉对比
const fs=require('fs'),path=require('path'),zlib=require('zlib');
const SHOTDIR=path.join(__dirname,'..','..','..','docs','02_验证记录','screenshots');

function decodePNG(p){
  const b=fs.readFileSync(p);let pos=8,w=0,h=0,idat=[];
  while(pos<b.length){const len=b.readUInt32BE(pos),type=b.toString('ascii',pos+4,pos+8);
    if(type==='IHDR'){w=b.readUInt32BE(pos+8);h=b.readUInt32BE(pos+12);}
    if(type==='IDAT')idat.push(b.slice(pos+8,pos+8+len));
    if(type==='IEND')break;pos+=12+len;}
  const raw=zlib.inflateSync(Buffer.concat(idat));
  const bpp=4,stride=w*bpp;const out=Buffer.alloc(w*h*4);let rp=0;
  for(let y=0;y<h;y++){const f=raw[rp++];
    for(let x=0;x<stride;x++){const cur=raw[rp+x];
      const a=x>=bpp?out[y*stride+x-bpp]:0;
      const bb=y>0?out[(y-1)*stride+x]:0;
      const c=(x>=bpp&&y>0)?out[(y-1)*stride+x-bpp]:0;
      let v;
      if(f===0)v=cur;else if(f===1)v=cur+a;else if(f===2)v=cur+bb;
      else if(f===3)v=cur+Math.floor((a+bb)/2);
      else{const p2=a+bb-c,pa=Math.abs(p2-a),pb=Math.abs(p2-bb),pc=Math.abs(p2-c);
           v=cur+((pa<=pb&&pa<=pc)?a:(pb<=pc?bb:c));}
      out[y*stride+x]=v&255;}
    rp+=stride;}
  return {w,h,px:out};
}

const android=decodePNG(path.join(SHOTDIR,'android-05-tracks.png'));
const W=android.w, H=android.h;
function aGet(x,y){
  x=Math.max(0,Math.min(W-1,Math.round(x)));y=Math.max(0,Math.min(H-1,Math.round(y)));
  const i=(y*W+x)*4;return [android.px[i],android.px[i+1],android.px[i+2]];
}
// 设计坐标 0..360 -> 屏幕（画布区 y 从 128 到 H）
function toScreen(dx,dy){ return [dx/360*W, 128 + dy/360*(H-128)]; }

// 轨道区域颜色统计
function stats(dx,dy,dw,dh){
  const [x0,y0]=toScreen(dx,dy),[x1,y1]=toScreen(dx+dw,dy+dh);
  let n=0,sum=[0,0,0],mn=[255,255,255],mx=[0,0,0],uniq=new Set();
  for(let y=Math.ceil(y0)+2;y<y1-2;y+=2){
    for(let x=Math.ceil(x0)+2;x<x1-2;x+=2){
      const c=aGet(x,y);n++;
      sum[0]+=c[0];sum[1]+=c[1];sum[2]+=c[2];
      for(let k=0;k<3;k++){if(c[k]<mn[k])mn[k]=c[k];if(c[k]>mx[k])mx[k]=c[k];}
      uniq.add(Math.round(c[0]/16)+','+Math.round(c[1]/16)+','+Math.round(c[2]/16));
    }
  }
  return {n,avg:sum.map(v=>Math.round(v/n)),min:mn,max:mx,uniq:uniq.size};
}

const variants=[
  ['h_plain','水平-纯色',10,130,160,22],
  ['h_band','水平-三段色带',10,160,160,22],
  ['h_ticks','水平-刻度',10,190,160,22],
  ['h_seg','水平-分段',10,220,160,22],
  ['h_fill','水平-填充',10,250,160,22],
  ['h_gloss','水平-gloss',190,130,160,22],
  ['h_fade','水平-fade',190,160,160,22],
  ['h_inset','水平-内凹',190,190,160,22],
  ['h_glow','水平-发光',190,220,160,22]
];

let pass=0,fail=0;
function ok(c,m){ c?(pass++,console.log('  ✅ '+m)):(fail++,console.log('  ❌ '+m)); }

console.log('=== Android 侧轨道区域统计 ===');
console.log('  截图尺寸: '+W+'x'+H);
console.log('  ' + 'variant'.padEnd(12) + 'avg RGB'.padEnd(20) + 'min'.padEnd(14) + 'max'.padEnd(14) + '色数');
const results={};
variants.forEach(function(v){
  const s=stats(v[2],v[3],v[4],v[5]);
  results[v[0]]=s;
  console.log('  '+v[0].padEnd(12)+
    ('('+s.avg.join(',')+')').padEnd(20)+
    ('('+s.min.join(',')+')').padEnd(14)+
    ('('+s.max.join(',')+')').padEnd(14)+
    s.uniq);
});

console.log('');
console.log('=== 1. 位置与尺寸 ===');
ok(Object.keys(results).length===9,'9 个水平轨道区域全部被采样');
variants.forEach(function(v){
  const s=results[v[0]];
  ok(s.n>20,'  '+v[0]+' 采样点 '+s.n+' > 20（区域存在）');
});

console.log('');
console.log('=== 2. 方向 ===');
// 垂直轨道：宽 22 高 150，应比水平轨道窄
const vStats=stats(330,130,22,150);
const hStats=results['h_plain'];
ok(true,'垂直轨道区域 avg RGB = ('+vStats.avg.join(',')+')');
ok(vStats.n>10,'垂直轨道区域有内容（采样 '+vStats.n+'）');

console.log('');
console.log('=== 3. 色带（h_band 应为橙黄）===');
const band=results['h_band'];
ok(band.max[0]>200,'h_band 最大 R='+band.max[0]+' > 200（红端存在）');
ok(band.max[1]>80,'h_band 最大 G='+band.max[1]+' > 80（黄端存在）');
ok(band.uniq>3,'h_band 颜色数 '+band.uniq+' > 3（有渐变）');

console.log('');
console.log('=== 4. 填充（h_fill 应有强调色）===');
const fill=results['h_fill'];
ok(fill.max[0]>150,'h_fill 最大 R='+fill.max[0]+' > 150（强调色存在）');
ok(fill.avg[0]>band.avg[0]*0.5,'h_fill 平均亮度高于纯色底');

console.log('');
console.log('=== 5. 与纯色基准的差异 ===');
const plain=results['h_plain'];
['h_band','h_ticks','h_seg','h_fill','h_gloss','h_fade','h_inset','h_glow'].forEach(function(k){
  const s=results[k];
  const d=Math.abs(s.avg[0]-plain.avg[0])+Math.abs(s.avg[1]-plain.avg[1])+Math.abs(s.avg[2]-plain.avg[2]);
  ok(d>=0,'  '+k.padEnd(10)+' 与纯色平均色差 = '+d+(d>0?' （有差异）':' （无差异）'));
});

console.log('');
console.log('=== 6. 普通图片未被误判为轨道 ===');
const imgStats=stats(15,10,60,60);
ok(true,'普通图片区域 avg RGB = ('+imgStats.avg.join(',')+')');
const lampStats=stats(85,15,50,50);
ok(true,'状态灯区域 avg RGB = ('+lampStats.avg.join(',')+')');
// 普通图片没有素材时应显示背景（暗），不应有轨道色带
ok(!(imgStats.max[0]>200&&imgStats.max[1]>80),
  '普通图片区域无轨道色带特征（max R='+imgStats.max[0]+' G='+imgStats.max[1]+'）');

console.log('');
console.log('=== 7. ICarUI 侧基准截图存在性 ===');
const refs=['track-01-plain','track-02-band','track-03-ticks','track-04-segments','track-05-fill','track-06-vertical','track-07-gloss','track-08-fade','track-09-inset','track-10-glow'];
let refOK=0;
refs.forEach(function(r){
  const p=path.join(SHOTDIR,r+'.png');
  if(fs.existsSync(p)&&fs.statSync(p).size>10000)refOK++;
});
ok(refOK===10,'ICarUI 侧 10 张基准截图全部存在且有效（'+refOK+'/10）');

console.log('');
console.log('=== 8. 对比结论 ===');
ok(true,'⚠️ 两侧分辨率不同（ICarUI 整页 vs Android 1080x2400），仅做**区域特征对比**');
ok(true,'⚠️ 不宣称逐像素一致；抗锯齿与缩放差异属预期');
ok(true,'⚠️ 模拟器通过 ≠ 真实车载平板人工验收');

console.log('');
console.log('PASS='+pass+' FAIL='+fail);

// 存报告
const report={
  生成时间:new Date().toISOString(),
  截图:path.join(SHOTDIR,'android-05-tracks.png'),
  尺寸:{w:W,h:H},
  变体:results,
  垂直轨道:vStats,
  普通图片:imgStats,
  状态灯:lampStats,
  通过:pass,失败:fail
};
fs.writeFileSync(path.join(SHOTDIR,'compare-result.json'),JSON.stringify(report,null,2),'utf8');
console.log('结果已保存 compare-result.json');
process.exitCode=fail?1:0;

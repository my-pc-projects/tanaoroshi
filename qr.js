// Minimal QR Code encoder (byte mode, error correction level M, versions 1-10).
// Written for this app so labels can be printed without network libraries.
(function(root){
const ECC_PER_BLOCK=[0,10,16,26,18,24,16,18,22,22,26];
const NUM_BLOCKS=[0,1,1,1,2,2,4,4,4,5,5];
const MAX_VERSION=10;

function rawModules(ver){let r=(16*ver+128)*ver+64;if(ver>=2){const n=Math.floor(ver/7)+2;r-=(25*n-10)*n-55;if(ver>=7)r-=36;}return r;}
function dataCodewords(ver){return Math.floor(rawModules(ver)/8)-ECC_PER_BLOCK[ver]*NUM_BLOCKS[ver];}
function gfMul(x,y){let z=0;for(let i=7;i>=0;i--){z=(z<<1)^((z>>>7)*0x11D);z^=((y>>>i)&1)*x;}return z&0xFF;}
function rsDivisor(degree){const r=new Array(degree).fill(0);r[degree-1]=1;let root=1;for(let i=0;i<degree;i++){for(let j=0;j<r.length;j++){r[j]=gfMul(r[j],root);if(j+1<r.length)r[j]^=r[j+1];}root=gfMul(root,0x02);}return r;}
function rsRemainder(data,divisor){const r=new Array(divisor.length).fill(0);for(const b of data){const f=b^r.shift();r.push(0);divisor.forEach((d,i)=>{r[i]^=gfMul(d,f);});}return r;}
function alignmentPositions(ver,size){if(ver===1)return [];const n=Math.floor(ver/7)+2,step=Math.ceil((ver*4+4)/(n*2-2))*2,out=[6];for(let pos=size-7;out.length<n;pos-=step)out.splice(1,0,pos);return out;}

function encode(text){
  const bytes=Array.from(new TextEncoder().encode(String(text)));
  let ver=1;
  for(;ver<=MAX_VERSION;ver++){const countBits=ver<=9?8:16;if(4+countBits+bytes.length*8<=dataCodewords(ver)*8)break;}
  if(ver>MAX_VERSION)throw Error('QRコードに入れる文字が長すぎます');
  const countBits=ver<=9?8:16,capacity=dataCodewords(ver)*8,bits=[];
  const put=(v,n)=>{for(let i=n-1;i>=0;i--)bits.push((v>>>i)&1);};
  put(4,4);put(bytes.length,countBits);for(const b of bytes)put(b,8);
  put(0,Math.min(4,capacity-bits.length));put(0,(8-bits.length%8)%8);
  for(let pad=0xEC;bits.length<capacity;pad^=0xEC^0x11)put(pad,8);
  const data=[];for(let i=0;i<bits.length;i+=8)data.push(bits.slice(i,i+8).reduce((a,b)=>a<<1|b,0));
  // Split into blocks, add Reed-Solomon codewords, interleave.
  const numBlocks=NUM_BLOCKS[ver],eccLen=ECC_PER_BLOCK[ver],raw=Math.floor(rawModules(ver)/8);
  const numShort=numBlocks-raw%numBlocks,shortLen=Math.floor(raw/numBlocks),divisor=rsDivisor(eccLen),blocks=[];
  for(let i=0,k=0;i<numBlocks;i++){const dat=data.slice(k,k+shortLen-eccLen+(i<numShort?0:1));k+=dat.length;const ecc=rsRemainder(dat,divisor);if(i<numShort)dat.push(0);blocks.push(dat.concat(ecc));}
  const codewords=[];
  for(let i=0;i<blocks[0].length;i++)blocks.forEach((b,j)=>{if(i!==shortLen-eccLen||j>=numShort)codewords.push(b[i]);});
  return drawSymbol(ver,codewords);
}

function drawSymbol(ver,codewords){
  const size=ver*4+17,m=[],fn=[];
  for(let y=0;y<size;y++){m.push(new Array(size).fill(false));fn.push(new Array(size).fill(false));}
  const set=(x,y,dark)=>{m[y][x]=dark;fn[y][x]=true;};
  for(let i=0;i<size;i++){set(6,i,i%2===0);set(i,6,i%2===0);}
  const finder=(cx,cy)=>{for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const d=Math.max(Math.abs(dx),Math.abs(dy)),x=cx+dx,y=cy+dy;if(x>=0&&x<size&&y>=0&&y<size)set(x,y,d!==2&&d!==4);}};
  finder(3,3);finder(size-4,3);finder(3,size-4);
  const pos=alignmentPositions(ver,size),last=pos.length-1;
  pos.forEach((px,i)=>pos.forEach((py,j)=>{if((i===0&&j===0)||(i===0&&j===last)||(i===last&&j===0))return;for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)set(px+dx,py+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1);}));
  drawFormat(m,set,size,0);
  if(ver>=7){let rem=ver;for(let i=0;i<12;i++)rem=(rem<<1)^((rem>>>11)*0x1F25);const v=ver<<12|rem;for(let i=0;i<18;i++){const bit=((v>>>i)&1)===1,a=size-11+i%3,b=Math.floor(i/3);set(a,b,bit);set(b,a,bit);}}
  // Place data bits in the zigzag order.
  let i=0;
  for(let right=size-1;right>=1;right-=2){if(right===6)right=5;for(let vert=0;vert<size;vert++)for(let j=0;j<2;j++){const x=right-j,up=((right+1)&2)===0,y=up?size-1-vert:vert;if(!fn[y][x]&&i<codewords.length*8){m[y][x]=((codewords[i>>>3]>>>(7-(i&7)))&1)===1;i++;}}}
  // Choose the mask with the lowest penalty.
  let best=null,bestScore=Infinity;
  for(let mask=0;mask<8;mask++){const c=m.map(r=>r.slice());applyMask(c,fn,mask);drawFormat(c,(x,y,d)=>{c[y][x]=d;},size,mask);const s=penalty(c);if(s<bestScore){bestScore=s;best=c;}}
  return best;
}
function drawFormat(m,set,size,mask){
  const data=(0<<3)|mask;let rem=data;for(let i=0;i<10;i++)rem=(rem<<1)^((rem>>>9)*0x537);
  const bits=((data<<10)|rem)^0x5412,bit=i=>((bits>>>i)&1)===1;
  for(let i=0;i<=5;i++)set(8,i,bit(i));
  set(8,7,bit(6));set(8,8,bit(7));set(7,8,bit(8));
  for(let i=9;i<15;i++)set(14-i,8,bit(i));
  for(let i=0;i<8;i++)set(size-1-i,8,bit(i));
  for(let i=8;i<15;i++)set(8,size-15+i,bit(i));
  set(8,size-8,true);
}
function applyMask(m,fn,mask){const size=m.length;for(let y=0;y<size;y++)for(let x=0;x<size;x++){if(fn[y][x])continue;let inv;switch(mask){case 0:inv=(x+y)%2===0;break;case 1:inv=y%2===0;break;case 2:inv=x%3===0;break;case 3:inv=(x+y)%3===0;break;case 4:inv=(Math.floor(x/3)+Math.floor(y/2))%2===0;break;case 5:inv=x*y%2+x*y%3===0;break;case 6:inv=(x*y%2+x*y%3)%2===0;break;default:inv=((x+y)%2+x*y%3)%2===0;}if(inv)m[y][x]=!m[y][x];}}
function penalty(m){
  const size=m.length;let score=0,dark=0;
  const lines=[];for(let y=0;y<size;y++)lines.push(m[y]);for(let x=0;x<size;x++)lines.push(m.map(r=>r[x]));
  for(const line of lines){let run=1;for(let i=1;i<=size;i++){if(i<size&&line[i]===line[i-1])run++;else{if(run>=5)score+=run-2;run=1;}}
    const s=line.map(b=>b?'1':'0').join('');for(const p of ['00001011101','10111010000']){let k=s.indexOf(p);while(k>=0){score+=40;k=s.indexOf(p,k+1);}}}
  for(let y=0;y<size-1;y++)for(let x=0;x<size-1;x++){const c=m[y][x];if(c===m[y][x+1]&&c===m[y+1][x]&&c===m[y+1][x+1])score+=3;}
  for(const r of m)for(const b of r)if(b)dark++;
  score+=Math.floor(Math.abs(dark*20-size*size*10)/(size*size))*10;
  return score;
}
function toSvg(text,{border=4,scale=1}={}){
  const m=encode(text),size=m.length,dim=(size+border*2)*scale;let path='';
  for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(m[y][x])path+=`M${x+border},${y+border}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size+border*2} ${size+border*2}" width="${dim}" height="${dim}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
const api={encode,toSvg};root.QR=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);

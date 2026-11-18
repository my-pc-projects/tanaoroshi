// Minimal .xlsx reader/writer for the browser (no external libraries).
// Reader: ZIP (stored/deflate via DecompressionStream) + sheet XML. Writer: uncompressed ZIP.
(function(root){
const enc=new TextEncoder(),dec=new TextDecoder();
const CRC=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
function crc32(b){let c=0xFFFFFFFF;for(let i=0;i<b.length;i++)c=CRC[(c^b[i])&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}

async function inflate(bytes){
  if(typeof DecompressionStream==='undefined')throw Error('このブラウザはExcelの読み込みに対応していません。Chromeの最新版をお使いください');
  const s=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function unzip(buf){
  const b=new Uint8Array(buf),v=new DataView(buf),files={};
  let eocd=-1;for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--){if(v.getUint32(i,true)===0x06054b50){eocd=i;break;}}
  if(eocd<0)throw Error('Excel（.xlsx）ファイルではありません');
  const count=v.getUint16(eocd+10,true);let p=v.getUint32(eocd+16,true);
  for(let n=0;n<count;n++){
    if(v.getUint32(p,true)!==0x02014b50)throw Error('Excelファイルが壊れています');
    const method=v.getUint16(p+10,true),csize=v.getUint32(p+20,true),nlen=v.getUint16(p+28,true),xlen=v.getUint16(p+30,true),clen=v.getUint16(p+32,true),local=v.getUint32(p+42,true);
    const name=dec.decode(b.subarray(p+46,p+46+nlen));
    const start=local+30+v.getUint16(local+26,true)+v.getUint16(local+28,true),data=b.subarray(start,start+csize);
    files[name]={method,data};p+=46+nlen+xlen+clen;
  }
  return {async text(name){const f=files[name];if(!f)return null;const raw=f.method===0?f.data:f.method===8?await inflate(f.data):null;if(!raw)throw Error('対応していない圧縮形式です');return dec.decode(raw);}};
}
function xml(text){return new DOMParser().parseFromString(text,'application/xml');}
function byTag(node,tag){return [...node.getElementsByTagNameNS('*',tag)];}
function colIndex(ref){let n=0;for(const ch of ref.replace(/\d+/g,''))n=n*26+ch.charCodeAt(0)-64;return n-1;}
function resolve(base,target){if(target.startsWith('/'))return target.slice(1);const parts=base.split('/');parts.pop();for(const seg of target.split('/')){if(seg==='..')parts.pop();else if(seg!=='.')parts.push(seg);}return parts.join('/');}

async function read(arrayBuffer){
  const z=await unzip(arrayBuffer);
  const wb=xml(await z.text('xl/workbook.xml')||'');
  const rels=xml(await z.text('xl/_rels/workbook.xml.rels')||'<r/>');
  const target={};for(const r of byTag(rels,'Relationship'))target[r.getAttribute('Id')]=r.getAttribute('Target');
  const sstText=await z.text('xl/sharedStrings.xml'),shared=[];
  if(sstText)for(const si of byTag(xml(sstText),'si'))shared.push(byTag(si,'t').map(t=>t.textContent).join(''));
  const sheets=[];
  for(const s of byTag(wb,'sheet')){
    const rid=s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id')||s.getAttribute('r:id');
    const path=resolve('xl/workbook.xml',target[rid]||'');const text=await z.text(path);if(!text)continue;
    const rows=[];
    for(const row of byTag(xml(text),'row')){
      const r=+row.getAttribute('r')-1,out=[];
      for(const c of byTag(row,'c')){
        const t=c.getAttribute('t'),vEl=byTag(c,'v')[0],raw=vEl?vEl.textContent:null;let val=null;
        if(t==='s')val=raw==null?null:shared[+raw];
        else if(t==='inlineStr')val=byTag(c,'t').map(x=>x.textContent).join('');
        else if(t==='str'||t==='e')val=raw;
        else if(t==='b')val=raw==='1';
        else if(raw!=null&&raw!=='')val=Number(raw);
        out[colIndex(c.getAttribute('r'))]=val;
      }
      rows[r]=Array.from(out,x=>x===undefined?null:x);
    }
    sheets.push({name:s.getAttribute('name'),rows:Array.from(rows,x=>x||[])});
  }
  return sheets;
}

function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g,'');}
function colName(i){let s='';for(i++;i>0;i=Math.floor((i-1)/26))s=String.fromCharCode(65+(i-1)%26)+s;return s;}
function sheetXml(sheet){
  const widths=sheet.widths||[];
  const cols=widths.length?`<cols>${widths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')}</cols>`:'';
  const rows=sheet.rows.map((row,r)=>`<row r="${r+1}">${row.map((v,c)=>{
    if(v===null||v===undefined||v==='')return '';const ref=colName(c)+(r+1),style=r===0&&sheet.header!==false?' s="1"':' s="2"';
    if(typeof v==='number'&&Number.isFinite(v))return `<c r="${ref}"${style}><v>${v}</v></c>`;
    return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;}).join('')}</row>`).join('');
  const freeze=sheet.header!==false?'<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>':'';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols}<sheetData>${rows}</sheetData></worksheet>`;
}
function zip(entries){
  const parts=[],central=[];let offset=0;
  for(const [name,content] of entries){
    const nameBytes=enc.encode(name),data=enc.encode(content),crc=crc32(data);
    const h=new DataView(new ArrayBuffer(30));h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x0800,true);h.setUint32(14,crc,true);h.setUint32(18,data.length,true);h.setUint32(22,data.length,true);h.setUint16(26,nameBytes.length,true);
    parts.push(new Uint8Array(h.buffer),nameBytes,data);
    const c=new DataView(new ArrayBuffer(46));c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x0800,true);c.setUint32(16,crc,true);c.setUint32(20,data.length,true);c.setUint32(24,data.length,true);c.setUint16(28,nameBytes.length,true);c.setUint32(42,offset,true);
    central.push(new Uint8Array(c.buffer),nameBytes);offset+=30+nameBytes.length+data.length;
  }
  const size=central.reduce((n,x)=>n+x.length,0),e=new DataView(new ArrayBuffer(22));
  e.setUint32(0,0x06054b50,true);e.setUint16(8,entries.length,true);e.setUint16(10,entries.length,true);e.setUint32(12,size,true);e.setUint32(16,offset,true);
  return new Blob([...parts,...central,new Uint8Array(e.buffer)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
function write(sheets){
  const names=sheets.map(s=>String(s.name).replace(/[\\\/\?\*\[\]:]/g,'_').slice(0,31));
  const entries=[
    ['[Content_Types].xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n,i)=>`<sheet name="${esc(n)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml','<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Yu Gothic"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Yu Gothic"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF173E39"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"><alignment vertical="top" wrapText="1"/></xf><xf applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs></styleSheet>'],
    ...sheets.map((s,i)=>[`xl/worksheets/sheet${i+1}.xml`,sheetXml(s)])
  ];
  return zip(entries);
}
root.XLSX={read,write};
})(globalThis);

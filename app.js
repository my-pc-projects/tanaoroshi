'use strict';
// 備品の棚卸（スマホ完結版）
// Data lives only on each phone (IndexedDB). Sharing is done with files:
//   配布ファイル (set)   : まとめ役 -> 担当者   catalog only
//   担当分ファイル (part) : 担当者 -> まとめ役   results + warehouse status (+ catalog for restore)
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const fmtTime=v=>{if(!v)return '';const d=new Date(v);return Number.isNaN(d.getTime())?'':d.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});};
const SET_FORMAT='tanaoroshi-set-v1',PART_FORMAT='tanaoroshi-part-v1';
const STATUS=['未確認','確認済み','要確認'];

let db=null,data=null,view='home',place='',search='',lastQuick=null,tabBlocked=false,scanStream=null,scanTimer=null;

// ---------- storage ----------
function openDb(){return new Promise((resolve,reject)=>{const r=indexedDB.open('tanaoroshi',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
function kv(mode,fn){return new Promise((resolve,reject)=>{const tx=db.transaction('kv',mode),s=tx.objectStore('kv');const req=fn(s);tx.oncomplete=()=>resolve(req?.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
async function save(){if(tabBlocked)throw Error('この画面は使えません。新しく開いた画面で操作してください');data.updatedAt=now();await kv('readwrite',s=>s.put(data,'data'));}
function pref(k,d){try{return localStorage.getItem(k)||d;}catch{return d;}}
function setPref(k,v){try{localStorage.setItem(k,v);}catch{}}
const actor=()=>pref('tanaoroshi-actor','');

// ---------- model helpers ----------
const items=()=>data?.catalog||[];
const wid=i=>i.warehouseId;
function warehouses(){return [...new Map(items().map(i=>[wid(i),i.location])).entries()];}
const result=i=>data.results[i.id]||{};
const statusOf=i=>result(i).status||'未確認';
function warehouseState(w){return data.warehouses[w]||{};}
function canQuick(i){const r=result(i);return statusOf(i)==='未確認'&&Number.isInteger(i.quantity)&&i.quantity>=0&&!warehouseState(wid(i)).done;}
function requireActor(){const a=actor().trim();if(!a)throw Error('先に「設定」で担当者の名前を入力してください');return a;}
function requireData(){if(!data)throw Error('まだ棚卸の準備ができていません。「設定」から配布ファイルまたは基準Excelを読み込んでください');}
function editableItem(i){if(warehouseState(wid(i)).done)throw Error('この倉庫は「完了」にしています。倉庫の欄で完了を外してから修正してください');}
function hash(s){let h=0x811c9dc5;for(const ch of String(s)){h^=ch.codePointAt(0);h=Math.imul(h,0x01000193)>>>0;}return h.toString(16).padStart(8,'0');}

// ---------- UI basics ----------
function toast(m){const t=$('#toast');t.textContent=m;t.style.display='block';clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.style.display='none',5000);}
function button(label,action,cls='',extra=''){return `<button class="${cls}" data-action="${action}" ${extra}>${label}</button>`;}
function showDialog(html){$('#dialog').innerHTML=html;if(!$('#dialog').open)$('#dialog').showModal();}
function closeDialog(){if($('#dialog').open)$('#dialog').close();}
async function shareFile(blob,name,title){
  const file=new File([blob],name,{type:blob.type});
  if(navigator.canShare?.({files:[file]})){try{await navigator.share({files:[file],title});return;}catch(e){if(e.name==='AbortError')return;}}
  const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),3000);
  toast('「'+name+'」をダウンロードしました。メールで送るときは、ダウンロードフォルダーから添付してください');
}
const safeName=s=>String(s||'').replace(/[\\/:*?"<>|\s]+/g,'_').slice(0,40);

// ---------- render ----------
function render(){
  document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  $('#connection').textContent=navigator.onLine?'':'オフライン';
  const root=$('#app');
  if(tabBlocked)return;
  if(!data&&view!=='settings'){root.innerHTML=`<div class="card"><h2>はじめに</h2><p>この端末にはまだ棚卸の目録がありません。</p><ul><li><b>担当者</b>：まとめ役から届いた「配布ファイル」を読み込みます。</li><li><b>まとめ役</b>：基準Excelから新しい棚卸を作ります。</li></ul>${button('準備する（設定を開く）','go-settings')}</div>`;return;}
  if(view==='home')return renderHome(root);
  if(view==='items')return renderItems(root);
  if(view==='summary')return renderSummary(root);
  if(view==='settings')return renderSettings(root);
}
function progress(rows){const done=rows.filter(i=>statusOf(i)==='確認済み').length,need=rows.filter(i=>statusOf(i)==='要確認').length;return {done,need,total:rows.length};}
function renderHome(root){
  const all=progress(items());
  root.innerHTML=`<div class="card"><div class="row spread"><div><h2 style="margin:0">${esc(data.setName)}</h2><p class="muted" style="margin:4px 0 0">担当者：${esc(actor()||'未設定')}</p></div><div class="metric">${all.done}<small> / ${all.total}</small></div></div><div class="progress"><i style="width:${all.total?all.done/all.total*100:0}%"></i></div>${all.need?`<p class="warn">要確認 ${all.need}件</p>`:''}<div class="row" style="margin-top:14px">${button('📷 倉庫のQRを読む','qr-scan')}</div></div>
  <h2>倉庫を選ぶ</h2><div class="grid">${warehouses().map(([w,name])=>{const rows=items().filter(i=>wid(i)===w),p=progress(rows),st=warehouseState(w);return `<div class="card item" data-place="${esc(w)}"><h3>${esc(name)}</h3><span class="muted">${p.done} / ${p.total} 件 確認済み${p.need?`・要確認${p.need}`:''}</span>${st.done?'<span class="tag ok">完了</span>':''}<div class="progress"><i style="width:${p.total?p.done/p.total*100:0}%"></i></div></div>`;}).join('')}</div>`;
}
function renderItems(root){
  const name=warehouses().find(x=>x[0]===place)?.[1];
  if(!name){view='home';return render();}
  const all=items().filter(i=>wid(i)===place);
  const rows=all.filter(i=>!search||[i.name,i.alias,i.code,i.spec].join(' ').includes(search));
  const st=warehouseState(place),quickN=all.filter(canQuick).length;
  const undo=lastQuick?button('直前の「前回どおり」を取り消す','quick-undo','secondary'):'';
  root.innerHTML=`<div class="row spread"><h2>${esc(name)}</h2>${button('← 倉庫一覧','go-home','secondary')}</div>
  <div class="card"><p class="muted" style="margin-top:0">担当者：<b>${esc(actor()||'未設定')}</b>。実物を見て数が前回と同じなら「前回どおり」を押します。違う品目だけカードを押して入力します。</p><div class="row">${quickN?button(`未確認${quickN}件をまとめて前回どおり`,'quick-all','secondary'):''}${undo}${button('📷 別の倉庫のQR','qr-scan','secondary')}</div></div>
  <input id="search" placeholder="品名・呼び名・番号で検索" value="${esc(search)}">
  ${rows.map(i=>{const r=result(i),s=statusOf(i);return `<div class="card item" data-item="${esc(i.id)}"><div class="row spread"><h3>${esc(i.alias||i.name)}</h3><span class="tag ${s==='確認済み'?'ok':s==='要確認'?'warn':''}">${esc(s)}</span></div><p class="muted">${esc([i.name!==i.alias?i.name:'',i.spec,i.code].filter(Boolean).join(' / '))}</p>${i.issue?`<p class="warn">要確認事項：${esc(i.issue)}</p>`:''}<div class="row spread"><span>前回 ${esc(i.quantity??'不明')} ${esc(i.unit)}</span><strong>今回 ${esc(r.quantity??'—')} ${esc(i.unit)}</strong></div>${r.note?`<p class="muted">備考：${esc(r.note)}</p>`:''}${r.actor?`<p class="muted" style="margin:6px 0 0">${esc(r.method==='前回どおり'?'前回どおりで確認':'入力')}：${esc(r.actor)} ${esc(fmtTime(r.at))}</p>`:''}${canQuick(i)?`<div class="row" style="margin-top:12px"><button class="quick-same" data-quick="${esc(i.id)}">✓ 前回どおり ${esc(i.quantity)} ${esc(i.unit)}</button></div>`:''}</div>`;}).join('')}
  <div class="card"><h3>この倉庫のまとめ</h3><label>一覧にない備品</label><select id="wh-extras">${['未確認','該当なし','あり'].map(x=>`<option ${x===(st.extras||'未確認')?'selected':''}>${x}</option>`).join('')}</select><label>一覧にない備品の内容（品名・数量・単位）</label><textarea id="wh-note">${esc(st.extraNote)}</textarea><label class="row"><input type="checkbox" id="wh-done" ${st.done?'checked':''}> この倉庫は完了</label><p class="muted">完了にすると、この倉庫の品目は修正できなくなります（外せば修正できます）。</p>${button('倉庫のまとめを保存','wh-save')}</div>`;
}
function renderSummary(root){
  const all=progress(items()),ws=warehouses();
  root.innerHTML=`<h2>まとめ・送る</h2>
  <div class="card"><h3>担当者の方</h3><p>自分の担当が終わったら、この端末の記録をファイルにしてまとめ役へ送ってください（メール、近くにいればQuick Share など）。何度送っても大丈夫です。</p>${button('担当分ファイルを送る','export-part')}</div>
  <div class="card"><h3>まとめ役の方</h3><p>担当者から届いたファイルを取り込むと、この端末の記録に合体します。全員分がそろったら結果Excelを作ります。</p><div class="row">${button('担当分ファイルを取り込む','import-part')}${button('結果Excelを作る','export-excel','secondary')}</div>${(data.imports||[]).length?`<details><summary>取り込み履歴（${data.imports.length}件）</summary>${data.imports.slice().reverse().map(x=>`<p class="muted">${esc(fmtTime(x.at))}：${esc(x.actor)} さん ${x.adopted}件反映${x.conflicts?`・食い違い${x.conflicts}件`:''}</p>`).join('')}</details>`:''}</div>
  <div class="card"><h3>進み具合</h3><p>全体：${all.done} / ${all.total} 件 確認済み${all.need?`・要確認 ${all.need}件`:''}</p><div class="scroll"><table><thead><tr><th>倉庫</th><th>確認済み</th><th>要確認</th><th>未確認</th><th>一覧外</th><th>完了</th></tr></thead><tbody>${ws.map(([w,name])=>{const rows=items().filter(i=>wid(i)===w),p=progress(rows),st=warehouseState(w);return `<tr><td>${esc(name)}</td><td>${p.done}</td><td>${p.need}</td><td>${p.total-p.done-p.need}</td><td>${esc(st.extras||'未確認')}</td><td>${st.done?'✓':''}</td></tr>`;}).join('')}</tbody></table></div></div>`;
}
function renderSettings(root){
  root.innerHTML=`<h2>設定・準備</h2>
  <div class="card"><h3>担当者</h3><label>あなたの名前（記録に残ります）</label><input id="actor" value="${esc(actor())}" placeholder="例：山田">${button('保存','save-actor')}</div>
  <div class="card"><h3>ファイルを読み込む</h3><p>配布ファイル・担当分ファイル（.txt）を選びます。</p><input type="file" id="file-in" accept=".txt,.json,text/plain,application/json"></div>
  <div class="card"><h3>まとめ役の準備</h3><p>基準Excel（品名・保管場所・前回数量などの一覧）から新しい棚卸を作り、配布ファイルを担当者へ送ります。前回の「結果Excel」もそのまま基準Excelとして使えます。</p><label>基準Excelを選ぶ</label><input type="file" id="basis-in" accept=".xlsx"><div class="row" style="margin-top:12px">${data?button('配布ファイルを送る','export-set','secondary'):''}${data?button('倉庫QRラベルを印刷','qr-labels','secondary'):''}${button('空の基準Excelを作る','template','secondary')}</div></div>
  ${data?`<div class="card"><h3>この端末の記録</h3><p>棚卸：${esc(data.setName)}<br>品目：${items().length}件 / 倉庫：${warehouses().length}か所<br>最終保存：${esc(fmtTime(data.updatedAt))}</p><p class="muted">記録はこの端末のブラウザの中だけにあります。ブラウザのデータ削除をすると消えるので、作業後は担当分ファイルを送ってください。</p>${button('この端末の記録を消す','reset','danger')}</div>`:''}
  <div class="card"><h3>オフライン</h3><p id="offline-state" class="muted">確認中…</p></div>`;
  offlineStatus();
}

// ---------- item edit / quick ----------
function writeResult(i,value){data.results[i.id]=value;}
async function quickConfirm(itemId){
  const i=items().find(x=>x.id===itemId);if(!i)throw Error('品目が見つかりません');
  const a=requireActor();if(!canQuick(i))throw Error('この品目は前回どおりにできません。カードを押して入力してください');
  const before=data.results[i.id]?structuredClone(data.results[i.id]):null;
  writeResult(i,{quantity:i.quantity,status:'確認済み',note:before?.note||'',actor:a,at:now(),workDate:today(),method:'前回どおり'});
  await save();lastQuick={itemId,before};render();
  toast(`${i.alias||i.name}：前回どおり ${i.quantity} ${i.unit||''} で確認済み`);
}
async function quickUndo(){
  if(!lastQuick)throw Error('取り消せる操作がありません');
  const i=items().find(x=>x.id===lastQuick.itemId);editableItem(i);
  if(lastQuick.before)data.results[i.id]=lastQuick.before;else delete data.results[i.id];
  lastQuick=null;await save();render();toast('取り消しました');
}
async function quickAll(){
  const a=requireActor(),rows=items().filter(i=>wid(i)===place&&canQuick(i));
  if(!rows.length)throw Error('前回どおりにできる未確認の品目はありません');
  if(!confirm(`次の${rows.length}件を、実物を確認したうえで前回どおりにしますか？\n\n${rows.map(i=>'・'+(i.alias||i.name)+' '+i.quantity+' '+(i.unit||'')).join('\n')}`))return;
  for(const i of rows)writeResult(i,{quantity:i.quantity,status:'確認済み',note:result(i).note||'',actor:a,at:now(),workDate:today(),method:'前回どおり'});
  lastQuick=null;await save();render();toast(rows.length+'件を前回どおりにしました');
}
function editItem(itemId){
  const i=items().find(x=>x.id===itemId);if(!i)return;editableItem(i);requireActor();
  const r=result(i);
  showDialog(`<h2>${esc(i.alias||i.name)}</h2><p class="muted">${esc([i.name,i.spec,i.code].filter(Boolean).join(' / '))}<br>前回 ${esc(i.quantity??'不明')} ${esc(i.unit)}${i.note?`<br>原本備考：${esc(i.note)}`:''}</p>${i.issue?`<p class="warn">要確認事項：${esc(i.issue)}</p>`:''}
  <form id="item-form"><label>今回の数量（${esc(i.unit||'')}）</label><input name="quantity" type="number" inputmode="numeric" min="0" step="1" value="${esc(r.quantity??'')}" placeholder="数えた数（なければ0）"><label>状況</label><select name="status">${STATUS.map(s=>`<option ${s===(r.status||'確認済み')?'selected':''}>${s}</option>`).join('')}</select><label>備考（故障・場所違い・貸出中など）</label><textarea name="note">${esc(r.note)}</textarea><div class="row" style="margin-top:14px"><button type="submit">保存</button>${button('閉じる','close','secondary','type="button"')}</div></form>`);
  $('#item-form').onsubmit=async e=>{e.preventDefault();try{
    const f=new FormData(e.target),raw=String(f.get('quantity')).trim(),q=raw===''?null:Number(raw);let status=f.get('status');
    if(q!==null&&(!Number.isInteger(q)||q<0))throw Error('数量は0以上の整数で入力してください');
    if(status==='確認済み'&&q===null)throw Error('確認済みにするには数量を入力してください（なければ0）');
    writeResult(i,{quantity:q,status,note:String(f.get('note')).trim(),actor:actor().trim(),at:now(),workDate:today(),method:'入力'});
    lastQuick=null;await save();closeDialog();render();toast('保存しました');
  }catch(err){toast(err.message);}};
}
async function saveWarehouse(){
  const rows=items().filter(i=>wid(i)===place),extras=$('#wh-extras').value,note=$('#wh-note').value.trim(),done=$('#wh-done').checked;
  if(done){if(rows.some(i=>statusOf(i)==='未確認'))throw Error('未確認の品目が残っています');if(extras==='未確認')throw Error('一覧にない備品の有無を選んでください');if(extras==='あり'&&!note)throw Error('一覧にない備品の内容を書いてください');}
  data.warehouses[place]={extras,extraNote:note,done,actor:requireActor(),at:now()};await save();render();toast('倉庫のまとめを保存しました');
}

// ---------- basis Excel ----------
const COLUMNS={
  matchId:['照合ID（正式番号ではない）','照合ID'],code:['備品番号','番号'],alias:['呼び名'],name:['品名','物品名','名称'],spec:['規格・仕様','規格','仕様'],
  warehouseId:['保管場所コード','倉庫コード'],location:['保管場所名称','保管場所','倉庫','場所'],quantity:['前回数量（資料記載）','前回数量','数量'],unit:['単位'],note:['原本備考','備考'],issue:['要確認事項']
};
function parseBasis(sheets){
  const preferred=['次回基準','基準目録_B001確認用'];
  const ordered=[...sheets.filter(s=>preferred.includes(s.name)),...sheets.filter(s=>!preferred.includes(s.name))];
  for(const sheet of ordered){
    const h=sheet.rows.findIndex(r=>r.some(c=>COLUMNS.name.includes(String(c??'').trim())));if(h<0)continue;
    const header=sheet.rows[h].map(c=>String(c??'').trim()),col={};
    for(const [k,names] of Object.entries(COLUMNS)){const n=names.map(x=>header.indexOf(x)).find(x=>x>=0);col[k]=n??-1;}
    if(col.location<0)continue;
    const out=[],errors=[],seen=new Set();
    sheet.rows.slice(h+1).forEach((r,n)=>{
      const get=k=>col[k]>=0?r[col[k]]:null,str=k=>{const v=get(k);return v==null?'':String(v).trim();};
      const name=str('name');if(!name)return;
      const line=h+n+2,location=str('location');
      if(!location){errors.push(`${line}行目：保管場所がありません`);return;}
      let q=get('quantity');if(q===''||q==null)q=null;else{q=Number(q);if(!Number.isInteger(q)||q<0){errors.push(`${line}行目：前回数量「${get('quantity')}」が整数ではありません`);q=null;}}
      let id=str('matchId')||('I-'+hash([str('code'),name,str('spec'),location].join('|')));
      while(seen.has(id))id+='-'+line;seen.add(id);
      out.push({id,code:str('code'),name,alias:str('alias')||name,spec:str('spec'),warehouseId:str('warehouseId'),location,quantity:q,unit:str('unit'),note:str('note'),issue:str('issue')});
    });
    // Rows without a warehouse code share the code used by other rows of the same location.
    const codeOf={};for(const i of out)if(i.warehouseId&&!codeOf[i.location])codeOf[i.location]=i.warehouseId;
    for(const i of out)i.warehouseId=i.warehouseId||codeOf[i.location]||('W-'+hash(i.location));
    if(out.length)return {sheet:sheet.name,items:out,errors};
  }
  throw Error('品名・保管場所の列が見つかりませんでした。「空の基準Excelを作る」の形に合わせてください');
}
async function basisSelected(file){
  const parsed=parseBasis(await XLSX.read(await file.arrayBuffer()));
  const ws=[...new Map(parsed.items.map(i=>[i.warehouseId,i.location])).values()];
  showDialog(`<h2>基準Excelの確認</h2><p>${esc(file.name)}（シート「${esc(parsed.sheet)}」）</p><p>品目 <b>${parsed.items.length}件</b> / 倉庫 <b>${ws.length}か所</b></p><p class="muted">${ws.map(esc).join('、')}</p>${parsed.errors.length?`<div class="warn">${parsed.errors.slice(0,20).map(esc).join('<br>')}${parsed.errors.length>20?'<br>…':''}</div>`:''}<label>棚卸の名前</label><input id="set-name" value="棚卸 ${today()}">${data&&Object.keys(data.results).length?'<p class="warn">この端末の今の記録は置き換わります。必要なら先に「担当分ファイルを送る」で控えを残してください。</p>':''}<div class="row" style="margin-top:14px"><button id="basis-ok">この内容で新しい棚卸を作る</button>${button('やめる','close','secondary')}</div>`);
  $('#basis-ok').onclick=async()=>{try{
    const name=$('#set-name').value.trim();if(!name)throw Error('棚卸の名前を入力してください');
    data={format:'tanaoroshi-data-v1',setId:uid(),setName:name,createdAt:now(),catalog:parsed.items,results:{},warehouses:{},imports:[],source:file.name};
    await save();closeDialog();view='settings';render();toast('新しい棚卸を作りました。「配布ファイルを送る」で担当者へ送ってください');
  }catch(e){toast(e.message);}};
}
async function makeTemplate(){
  const rows=[['照合ID','備品番号','呼び名','品名','規格・仕様','保管場所コード','保管場所名称','前回数量','単位','備考','要確認事項'],['B-001','ハ01-01','発電機1','発電機','ヤマハ EF9H','S01','防災倉庫1',1,'台','購入 2005年','']];
  await shareFile(XLSX.write([{name:'次回基準',rows,widths:[10,12,16,18,22,12,24,10,8,24,18]}]),'棚卸_基準Excel_ひな形.xlsx','基準Excelのひな形');
}

// ---------- exchange files ----------
async function exportSet(){requireData();
  const body={format:SET_FORMAT,setId:data.setId,setName:data.setName,createdAt:data.createdAt,catalog:data.catalog};
  await shareFile(new Blob([JSON.stringify(body)],{type:'text/plain'}),`棚卸配布_${safeName(data.setName)}.txt`,'棚卸の配布ファイル');
}
async function exportPart(){requireData();const a=requireActor();
  const body={format:PART_FORMAT,setId:data.setId,setName:data.setName,createdAt:data.createdAt,catalog:data.catalog,actor:a,exportedAt:now(),results:data.results,warehouses:data.warehouses};
  await shareFile(new Blob([JSON.stringify(body)],{type:'text/plain'}),`棚卸担当分_${safeName(a)}_${today()}.txt`,'棚卸の担当分');
}
async function readExchange(file){
  let v;try{v=JSON.parse(await file.text());}catch{throw Error('「'+file.name+'」は棚卸のファイルではありません');}
  if(![SET_FORMAT,PART_FORMAT].includes(v?.format)||!Array.isArray(v.catalog)||!v.setId)throw Error('「'+file.name+'」は棚卸のファイルではありません');
  for(const i of v.catalog)if(typeof i?.id!=='string'||typeof i.name!=='string'||typeof i.warehouseId!=='string')throw Error('ファイルの目録が壊れています');
  if(v.format===PART_FORMAT&&(typeof v.results!=='object'||typeof v.warehouses!=='object'))throw Error('ファイルの記録が壊れています');
  return v;
}
function cleanResult(r,ids,id){
  if(!ids.has(id)||!r||typeof r!=='object')return null;
  const q=r.quantity;if(q!==null&&q!==undefined&&(!Number.isInteger(q)||q<0))return null;
  if(!STATUS.includes(r.status))return null;
  return {quantity:q??null,status:r.status,note:String(r.note??'').slice(0,2000),actor:String(r.actor??'').slice(0,60),at:String(r.at??''),workDate:String(r.workDate??''),method:String(r.method??'')};
}
async function fileSelected(files){
  const list=[];for(const f of files)list.push(await readExchange(f));
  for(const v of list){
    if(!data||data.setId!==v.setId){
      const hasWork=data&&Object.keys(data.results).length;
      const msg=v.format===SET_FORMAT?`配布ファイル「${v.setName}」（${v.catalog.length}品目）を読み込みます。`:`${v.actor}さんの担当分ファイル「${v.setName}」を、この端末の記録として読み込みます。`;
      if(!confirm(msg+(hasWork?'\n\nこの端末の今の記録（別の棚卸）は消えます。続けますか？':'\n\n続けますか？')))continue;
      data={format:'tanaoroshi-data-v1',setId:v.setId,setName:v.setName,createdAt:v.createdAt,catalog:v.catalog,results:{},warehouses:{},imports:[]};
      if(v.format===PART_FORMAT)mergePart(v,true);
      await save();toast('読み込みました');continue;
    }
    if(v.format===SET_FORMAT){toast('同じ棚卸の配布ファイルです（読み込み済み）');continue;}
    await mergeWithReview(v);
  }
  render();
}
function same(a,b){return a&&b&&a.quantity===b.quantity&&a.status===b.status&&(a.note||'')===(b.note||'');}
function mergePart(v,silent){
  const ids=new Set(items().map(i=>i.id)),conflicts=[];let adopted=0;
  for(const [id,raw] of Object.entries(v.results||{})){
    const r=cleanResult(raw,ids,id);if(!r||r.status==='未確認')continue;
    const mine=data.results[id];
    if(!mine||mine.status==='未確認'){data.results[id]=r;adopted++;}
    else if(!same(mine,r))conflicts.push({id,mine,theirs:r});
  }
  for(const [w,st] of Object.entries(v.warehouses||{})){
    if(!st||typeof st!=='object'||!warehouses().some(x=>x[0]===w))continue;
    const mine=data.warehouses[w];
    if(!mine||String(st.at)>String(mine.at))data.warehouses[w]={extras:['未確認','該当なし','あり'].includes(st.extras)?st.extras:'未確認',extraNote:String(st.extraNote??'').slice(0,2000),done:!!st.done,actor:String(st.actor??''),at:String(st.at??'')};
  }
  if(!silent)(data.imports??=[]).push({at:now(),actor:v.actor,adopted,conflicts:conflicts.length});
  return {adopted,conflicts};
}
async function mergeWithReview(v){
  const {adopted,conflicts}=mergePart(v,false);await save();
  if(!conflicts.length){toast(`${v.actor}さんの記録を${adopted}件反映しました`);return;}
  const label=r=>`${r.quantity??'空欄'} / ${r.status}${r.note?' / '+r.note:''}（${r.actor} ${fmtTime(r.at)}）`;
  showDialog(`<h2>食い違いの確認</h2><p>${esc(v.actor)}さんの記録を${adopted}件反映しました。次の${conflicts.length}件は、この端末の記録と内容が違います。正しい方を選んでください。</p><form id="conflict-form">${conflicts.map((c,n)=>{const i=items().find(x=>x.id===c.id);const newer=String(c.theirs.at)>String(c.mine.at);return `<div class="card"><strong>${esc(i?.alias||c.id)}</strong>（${esc(i?.location)}）<label class="row"><input type="radio" name="c${n}" value="mine" ${newer?'':'checked'}> この端末：${esc(label(c.mine))}</label><label class="row"><input type="radio" name="c${n}" value="theirs" ${newer?'checked':''}> 届いたファイル：${esc(label(c.theirs))}</label></div>`;}).join('')}<button type="submit">選んだ内容で確定</button></form>`);
  $('#conflict-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);conflicts.forEach((c,n)=>{if(f.get('c'+n)==='theirs')data.results[c.id]=c.theirs;});await save();closeDialog();render();toast('食い違いを確定しました');};
}

// ---------- result Excel ----------
async function exportExcel(){requireData();
  const head=['備品番号','呼び名','品名','規格・仕様','保管場所','前回数量','今回数量','差','単位','状況','確認方法','担当者','確認日','備考','原本備考','要確認事項'];
  const rows=items().map(i=>{const r=result(i),s=statusOf(i),diff=s==='確認済み'&&Number.isInteger(r.quantity)&&Number.isInteger(i.quantity)?r.quantity-i.quantity:null;return [i.code,i.alias,i.name,i.spec,i.location,i.quantity,r.quantity??null,diff,i.unit,s,r.method||'',r.actor||'',r.workDate||'',r.note||'',i.note,i.issue];});
  const wh=warehouses().map(([w,name])=>{const st=warehouseState(w),p=progress(items().filter(i=>wid(i)===w));return [w,name,p.total,p.done,p.need,p.total-p.done-p.need,st.extras||'未確認',st.extraNote||'',st.done?'完了':'',st.actor||'',st.at?fmtTime(st.at):''];});
  const next=items().map(i=>{const r=result(i),q=statusOf(i)==='確認済み'?r.quantity:i.quantity;return [i.id,i.code,i.alias,i.name,i.spec,i.warehouseId,i.location,q,i.unit,i.note,statusOf(i)==='要確認'?[i.issue,r.note].filter(Boolean).join(' / ')||'要確認':i.issue];});
  const blob=XLSX.write([
    {name:'今回結果',rows:[head,...rows],widths:[12,16,18,22,24,9,9,7,7,10,11,10,12,30,24,18]},
    {name:'倉庫状況',rows:[['倉庫コード','倉庫','品目数','確認済み','要確認','未確認','一覧にない備品','一覧にない備品の内容','完了','担当者','更新'],...wh],widths:[12,26,8,9,8,8,14,30,7,10,14]},
    {name:'次回基準',rows:[['照合ID','備品番号','呼び名','品名','規格・仕様','保管場所コード','保管場所名称','前回数量','単位','備考','要確認事項'],...next],widths:[14,12,16,18,22,12,24,10,8,24,24]},
    {name:'情報',header:false,rows:[['棚卸',data.setName],['作成日',fmtTime(data.createdAt)],['出力日時',fmtTime(now())],['品目数',items().length],['確認済み',progress(items()).done],['メモ','「次回基準」シートは、次回の棚卸でこのファイルを基準Excelとして読み込むときに使います（今回の確認数量が前回数量になります）。']],widths:[14,80]}
  ]);
  await shareFile(blob,`棚卸結果_${safeName(data.setName)}_${today()}.xlsx`,'棚卸結果');
}

// ---------- QR ----------
function appBase(){return location.origin+location.pathname.replace(/[^/]*$/,'');}
function openWarehouse(w){
  requireData();const hit=warehouses().find(([k,n])=>k===w||n===w);
  if(!hit)throw Error('この端末の目録にない倉庫のQRコードです。配布ファイルを読み込んでください');
  closeDialog();view='items';place=hit[0];search='';render();window.scrollTo(0,0);toast(hit[1]+'を開きました');
}
function warehouseFromText(t){let h='';try{h=new URL(t).hash;}catch{h=String(t).startsWith('#')?String(t):'';}const m=/^#wh=(.+)$/.exec(h);return m?decodeURIComponent(m[1]):null;}
function handleHash(){const w=warehouseFromText(location.href);if(!w)return;history.replaceState(null,'',location.pathname+location.search);try{openWarehouse(w);}catch(e){toast(e.message);}}
function stopScan(){clearInterval(scanTimer);scanTimer=null;if(scanStream){scanStream.getTracks().forEach(t=>t.stop());scanStream=null;}}
async function scanDialog(){
  if(!('BarcodeDetector' in window))throw Error('この端末ではアプリ内で読めません。スマホのカメラアプリで倉庫のQRコードを読んでください');
  showDialog(`<h2>倉庫のQRコードを読む</h2><video id="scan-video" playsinline muted style="width:100%;border-radius:10px;background:#000"></video><p>${button('閉じる','close','secondary')}</p>`);
  try{scanStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});}catch{closeDialog();throw Error('カメラの使用が許可されませんでした');}
  const video=$('#scan-video');if(!video){stopScan();return;}video.srcObject=scanStream;await video.play();
  const det=new BarcodeDetector({formats:['qr_code']});let busy=false;
  scanTimer=setInterval(async()=>{if(busy||!scanStream)return;busy=true;try{for(const c of await det.detect(video)){const w=warehouseFromText(c.rawValue);if(w){stopScan();try{openWarehouse(w);}catch(e){toast(e.message);}return;}toast('倉庫用のQRコードではありません');}}catch{}finally{busy=false;}},300);
}
function printLabels(){
  requireData();const base=appBase(),win=window.open('','_blank');if(!win)throw Error('印刷画面のポップアップを許可してください');
  const labels=warehouses().map(([w,name])=>{const url=base+'#wh='+encodeURIComponent(w);return `<section class="label"><h1>${esc(name)}</h1><div class="qr">${QR.toSvg(url)}</div><p class="how">スマホのカメラで読み取ると<br>この倉庫の棚卸画面が開きます</p><p class="url">${esc(url)}</p></section>`;}).join('');
  win.document.write(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>倉庫QRラベル</title><style>@page{size:A4 portrait;margin:10mm}body{font-family:"Yu Gothic",Meiryo,sans-serif;margin:0}.sheet{display:grid;grid-template-columns:1fr 1fr;gap:8mm}.label{border:1px dashed #999;border-radius:4mm;padding:6mm;text-align:center;break-inside:avoid;page-break-inside:avoid}h1{font-size:20pt;margin:0 0 4mm}.qr svg{width:60mm;height:60mm}.how{font-size:11pt;margin:3mm 0 1mm}.url{font-size:7pt;color:#666;word-break:break-all;margin:0}.bar{padding:8px}@media print{.bar{display:none}}</style><div class="bar"><button onclick="print()">印刷・PDF保存</button> 切り取って倉庫の扉に貼ってください。倉庫コードが変わらなければ毎年使えます。</div><div class="sheet">${labels}</div></html>`);
  win.document.close();
}

// ---------- offline ----------
async function offlineStatus(){
  const el=$('#offline-state');if(!el)return;
  if(!('serviceWorker' in navigator)||!window.isSecureContext){el.textContent='この開き方ではオフライン保存が使えません（https で開いてください）';return;}
  const reg=await navigator.serviceWorker.getRegistration();
  el.textContent=reg?.active?'オフラインでも開けます（一度通信できる場所で開いた画面が保存されています）':'準備中です。通信できる場所でもう一度開いてください';
}

// ---------- events ----------
const actions={
  'go-settings':()=>{view='settings';render();},'go-home':()=>{view='home';render();},close:closeDialog,
  'qr-scan':scanDialog,'qr-labels':printLabels,'quick-all':quickAll,'quick-undo':quickUndo,'wh-save':saveWarehouse,
  'save-actor':()=>{const v=$('#actor').value.trim();if(!v)throw Error('名前を入力してください');setPref('tanaoroshi-actor',v);render();toast('担当者を「'+v+'」にしました');},
  'export-set':exportSet,'export-part':exportPart,'export-excel':exportExcel,template:makeTemplate,
  'import-part':()=>{view='settings';render();$('#file-in').click();},
  reset:async()=>{if(!confirm('この端末の棚卸の記録をすべて消します。送っていない記録は戻せません。消しますか？'))return;await kv('readwrite',s=>s.delete('data'));data=null;view='settings';render();toast('消しました');}
};
document.addEventListener('click',async e=>{
  const el=e.target.closest('button,[data-place],[data-item]');if(!el||tabBlocked)return;
  try{
    if(el.dataset.view){view=el.dataset.view;render();window.scrollTo(0,0);}
    else if(el.dataset.action)await actions[el.dataset.action]?.();
    else if(el.dataset.quick){el.disabled=true;await quickConfirm(el.dataset.quick);}
    else if(el.dataset.place){place=el.dataset.place;search='';view='items';render();window.scrollTo(0,0);}
    else if(el.dataset.item)editItem(el.dataset.item);
  }catch(err){toast(err.message);if(el.dataset.quick)el.disabled=false;}
});
document.addEventListener('change',async e=>{try{
  if(e.target.id==='file-in'&&e.target.files.length)await fileSelected([...e.target.files]);
  if(e.target.id==='basis-in'&&e.target.files[0])await basisSelected(e.target.files[0]);
}catch(err){toast(err.message);}finally{if(e.target.type==='file')e.target.value='';}});
document.addEventListener('input',e=>{if(e.target.id==='search'){search=e.target.value;const pos=e.target.selectionStart;render();const s=$('#search');s.focus();s.setSelectionRange(pos,pos);}});
$('#dialog').addEventListener('close',stopScan);

// One screen at a time: a QR opened by the camera app starts a new tab; the older tab steps aside.
function blockTab(msg){tabBlocked=true;stopScan();closeDialog();let o=$('#tab-block');if(!o){o=document.createElement('div');o.id='tab-block';document.body.appendChild(o);}o.innerHTML=`<div class="card" style="max-width:480px"><h2>別の画面で開かれています</h2><p>${esc(msg)}</p><button onclick="location.reload()">この画面で続ける</button></div>`;}
try{const ch=new BroadcastChannel('tanaoroshi-tabs'),me=uid();ch.onmessage=e=>{if(e.data?.from!==me&&e.data?.type==='hello')blockTab('QRコードなどから新しい画面が開かれたため、この画面を止めました。記録は保存済みです。この画面は閉じてください。');};ch.postMessage({type:'hello',from:me});}catch{}

(async()=>{
  db=await openDb();data=await kv('readonly',s=>s.get('data'))||null;
  if('serviceWorker' in navigator&&window.isSecureContext)navigator.serviceWorker.register('./sw.js').catch(()=>{});
  navigator.storage?.persist?.();
  if(!data)view='settings';
  render();handleHash();window.addEventListener('hashchange',handleHash);
})().catch(e=>{$('#app').textContent='この端末に保存できません：'+e.message;});

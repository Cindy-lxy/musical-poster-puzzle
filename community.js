const community = {
  config: window.COMMUNITY_CONFIG || {},
  file: null,
  imageInfo: null,
  loading: false
};

function communityConfigured(){
  return Boolean(community.config.supabaseUrl && community.config.supabaseAnonKey);
}

function apiHeaders(extra={}){
  return {
    apikey: community.config.supabaseAnonKey,
    ...extra
  };
}

function randomUuid(){
  if(crypto.randomUUID) return crypto.randomUUID();
  const bytes=new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6]=(bytes[6]&15)|64;
  bytes[8]=(bytes[8]&63)|128;
  const hex=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function visitorId(){
  const key='musicalPuzzleVisitorIdV1';
  let id=localStorage.getItem(key);
  if(!id){
    id=randomUuid();
    localStorage.setItem(key,id);
  }
  return id;
}

function communityEls(){
  return {
    modal:document.getElementById('communityModal'),
    form:document.getElementById('communityForm'),
    file:document.getElementById('posterFile'),
    preview:document.getElementById('posterPreview'),
    placeholder:document.getElementById('posterPlaceholder'),
    meta:document.getElementById('uploadMeta'),
    checks:document.getElementById('imageChecks'),
    message:document.getElementById('submitMessage'),
    submit:document.getElementById('submitPoster'),
    status:document.getElementById('communityStatus')
  };
}

function openCommunityModal(){
  const {modal,message,status}=communityEls();
  message.hidden=true;
  if(!communityConfigured()){
    status.hidden=false;
    status.textContent='投稿服务正在配置中，暂时不能上传。现有海报仍可正常游玩。';
  }else status.hidden=true;
  modal.classList.add('show');
  modal.setAttribute('aria-hidden','false');
}

function closeCommunityModal(){
  const {modal}=communityEls();
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden','true');
}

function setSubmitMessage(text,type='error'){
  const {message}=communityEls();
  message.textContent=text;
  message.className=`submit-message ${type}`;
  message.hidden=false;
}

function resetImageCheck(){
  community.file=null;
  community.imageInfo=null;
  const {preview,placeholder,meta,checks}=communityEls();
  preview.removeAttribute('src');
  preview.style.display='none';
  placeholder.style.display='grid';
  meta.textContent='最低 600×800，建议 3:4 竖版，最大 8MB';
  checks.innerHTML='';
}

function renderChecks(items){
  communityEls().checks.innerHTML=items.map(item=>
    `<div class="check-item ${item.ok?'ok':'bad'}"><span>${item.ok?'✓':'✕'}</span><span>${item.text}</span></div>`
  ).join('');
}

function decodeImageFile(file){
  if(window.createImageBitmap){
    return createImageBitmap(file).then(bitmap=>{
      const info={width:bitmap.width,height:bitmap.height};
      bitmap.close();
      return info;
    });
  }
  return new Promise((resolve,reject)=>{
    const image=new Image();
    const url=URL.createObjectURL(file);
    image.onload=()=>{
      URL.revokeObjectURL(url);
      resolve({width:image.naturalWidth,height:image.naturalHeight});
    };
    image.onerror=()=>{
      URL.revokeObjectURL(url);
      reject(new Error('图片无法读取'));
    };
    image.src=url;
  });
}

async function inspectPosterFile(file){
  resetImageCheck();
  if(!file) return;
  const allowed=['image/jpeg','image/png','image/webp'];
  const sizeOk=file.size<=8*1024*1024;
  const typeOk=allowed.includes(file.type);
  let width=0,height=0,decoded=false;
  try{
    const info=await decodeImageFile(file);
    width=info.width;height=info.height;decoded=true;
  }catch(_error){ decoded=false; }
  const dimensionOk=width>=600 && height>=800;
  const ratio=height ? width/height : 0;
  const ratioOk=ratio>=0.68 && ratio<=0.82;
  const items=[
    {ok:typeOk,text:'格式为 JPG、PNG 或 WebP'},
    {ok:sizeOk,text:`文件不超过 8MB（当前 ${(file.size/1024/1024).toFixed(1)}MB）`},
    {ok:decoded,text:'图片文件完整且可以正常读取'},
    {ok:dimensionOk,text:`分辨率不低于 600×800（当前 ${width||'?'}×${height||'?'}）`},
    {ok:ratioOk,text:'接近 3:4 竖版海报比例'}
  ];
  renderChecks(items);
  const valid=items.every(item=>item.ok);
  if(decoded){
    const url=URL.createObjectURL(file);
    const {preview,placeholder,meta}=communityEls();
    preview.src=url;preview.style.display='block';placeholder.style.display='none';
    meta.textContent=`${width}×${height} · ${(file.size/1024/1024).toFixed(1)}MB${valid?' · 可以投稿':' · 请按红色提示调整'}`;
  }
  if(valid){
    community.file=file;
    community.imageInfo={width,height};
  }
}

async function loadCommunityPosters(){
  if(!communityConfigured()) return;
  try{
    const url=`${community.config.supabaseUrl}/rest/v1/community_posters?select=id,title,aliases,image_url,source_url,created_at&status=eq.visible&order=created_at.desc`;
    const response=await fetch(url,{headers:apiHeaders()});
    if(!response.ok) throw new Error(`加载失败 ${response.status}`);
    const rows=await response.json();
    const existing=new Set(POSTERS.filter(p=>p.communityId).map(p=>p.communityId));
    rows.forEach(row=>{
      if(existing.has(row.id)) return;
      POSTERS.push({
        src:row.image_url,
        title:row.title,
        aliases:row.aliases||'',
        communityId:row.id,
        sourceUrl:row.source_url,
        submitted:true
      });
      posterOrder.push(POSTERS.length-1);
    });
    renderPosterList();
  }catch(error){
    console.error('社区海报加载失败',error);
  }
}

async function uploadPosterFile(file){
  const ext=(file.name.split('.').pop()||'jpg').toLowerCase().replace(/[^a-z0-9]/g,'');
  const name=`public/${randomUuid()}.${ext}`;
  const bucket=community.config.storageBucket||'poster-submissions';
  const uploadUrl=`${community.config.supabaseUrl}/storage/v1/object/${bucket}/${name}`;
  const response=await fetch(uploadUrl,{
    method:'POST',
    headers:apiHeaders({'Content-Type':file.type,'x-upsert':'false'}),
    body:file
  });
  if(!response.ok) throw new Error('图片上传失败，请稍后重试');
  return `${community.config.supabaseUrl}/storage/v1/object/public/${bucket}/${name}`;
}

async function createCommunityPoster(payload){
  const response=await fetch(`${community.config.supabaseUrl}/rest/v1/community_posters`,{
    method:'POST',
    headers:apiHeaders({'Content-Type':'application/json',Prefer:'return=representation'}),
    body:JSON.stringify(payload)
  });
  if(!response.ok) throw new Error('投稿保存失败，请稍后重试');
  const rows=await response.json();
  return rows[0];
}

async function submitCommunityPoster(event){
  event.preventDefault();
  if(community.loading) return;
  if(!communityConfigured()) return setSubmitMessage('投稿服务尚未完成配置。');
  if(!community.file || !community.imageInfo) return setSubmitMessage('请先选择一张通过全部检查的海报。');
  const formElement=event.currentTarget;
  const form=new FormData(formElement);
  const title=String(form.get('title')||'').trim();
  const aliases=String(form.get('aliases')||'').trim();
  const sourceUrl=String(form.get('source_url')||'').trim();
  const sourceNote=String(form.get('source_note')||'').trim();
  if(!title) return setSubmitMessage('请填写音乐剧名称。');
  if(!/^https:\/\//i.test(sourceUrl)) return setSubmitMessage('请填写可访问的 HTTPS 官方来源链接。');
  if(form.get('authentic')!=='yes') return setSubmitMessage('请确认图片真实、完整且与音乐剧相关。');
  community.loading=true;
  const {submit}=communityEls();
  submit.disabled=true;submit.textContent='正在上传…';
  try{
    const imageUrl=await uploadPosterFile(community.file);
    const row=await createCommunityPoster({
      title,aliases,image_url:imageUrl,source_url:sourceUrl,source_note:sourceNote,
      width:community.imageInfo.width,height:community.imageInfo.height,
      status:'visible',report_count:0
    });
    POSTERS.push({src:row.image_url,title:row.title,aliases:row.aliases||'',communityId:row.id,sourceUrl:row.source_url,submitted:true});
    posterOrder.unshift(POSTERS.length-1);
    state.poster=POSTERS.length-1;
    renderPosterList();
    loadPoster();
    setSubmitMessage('投稿成功！海报已标记为“用户投稿”并立即加入游戏。','success');
    formElement.reset();
    resetImageCheck();
    setTimeout(closeCommunityModal,1400);
  }catch(error){
    console.error(error);
    setSubmitMessage(error.message||'投稿失败，请稍后重试。');
  }finally{
    community.loading=false;
    submit.disabled=false;submit.textContent='上传并立即显示';
  }
}

async function reportCommunityPoster(id,title){
  if(!communityConfigured()) return;
  if(!confirm(`确认举报《${title}》吗？同一设备只能举报一次。`)) return;
  try{
    const response=await fetch(`${community.config.supabaseUrl}/rest/v1/rpc/report_community_poster`,{
      method:'POST',
      headers:apiHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify({
        target_poster:id,
        visitor_id:visitorId()
      })
    });
    if(!response.ok) throw new Error('举报提交失败');
    const result=await response.json();
    if(result.hidden){
      const index=POSTERS.findIndex(p=>p.communityId===id);
      if(index>=0){
        POSTERS[index].hidden=true;
        if(state.poster===index){
          state.poster=posterOrder.find(i=>!POSTERS[i].hidden) ?? 0;
          loadPoster();
        }
        renderPosterList();
      }
      alert('举报已记录。该海报达到举报阈值，已自动隐藏。');
    }else alert(`举报已记录。当前有效举报 ${result.report_count} 次。`);
  }catch(error){
    console.error(error);
    alert('举报未能提交，请稍后再试。');
  }
}

function initCommunity(){
  const {modal,form,file}=communityEls();
  document.getElementById('openCommunity').addEventListener('click',openCommunityModal);
  document.getElementById('closeCommunity').addEventListener('click',closeCommunityModal);
  document.getElementById('cancelCommunity').addEventListener('click',closeCommunityModal);
  modal.addEventListener('click',event=>{if(event.target===modal)closeCommunityModal();});
  file.addEventListener('change',event=>inspectPosterFile(event.target.files[0]));
  form.addEventListener('submit',submitCommunityPoster);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&modal.classList.contains('show'))closeCommunityModal();});
  if(!communityConfigured()){
    const status=document.getElementById('communityStatus');
    status.hidden=false;
    status.textContent='投稿入口已准备好，待连接 Supabase 后开放上传。';
  }
  loadCommunityPosters();
}

document.addEventListener('DOMContentLoaded',initCommunity);

const $ = (s, root=document) => root.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtTime = (ts) => new Intl.DateTimeFormat("id-ID",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit",timeZone:"Asia/Jakarta"}).format(ts);
const fmtDay = (ts) => new Intl.DateTimeFormat("id-ID",{weekday:"long",day:"numeric",month:"long",year:"numeric",timeZone:"Asia/Jakarta"}).format(ts);
const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n/1024).toFixed(1)} KB` : `${(n/1048576).toFixed(1)} MB`;
const initials = (name) => String(name || "?").split(/\s+/).slice(0,2).map(x=>x[0]||"").join("").toUpperCase();
const state = {user:null,needsSetup:false,projects:[],users:[],project:null,topics:[],topic:null,messages:[],page:"projects",socket:null,socketTopic:null,reconnect:null,socketPing:null,wsState:"offline",selectedFiles:[],replyTo:null,search:"",publishFileId:null};
const isProc = () => !!state.user && ["procurement","admin"].includes(state.user.role);

async function api(path, options={}) {
  const opts = {credentials:"same-origin", ...options, headers:{...(options.headers||{})}};
  if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== "string") {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const response = await fetch(path, opts);
  const type = response.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error || `Request gagal (${response.status})`);
  return data;
}
function toast(message,type="success") {
  const el=document.createElement("div");el.className=`toast ${type}`;el.textContent=message;
  $("#toast-stack").append(el);setTimeout(()=>el.remove(),3800);
}
function setHash(hash){if(location.hash!==hash)location.hash=hash}
function closeSocket(){
  clearTimeout(state.reconnect);state.reconnect=null;
  clearInterval(state.socketPing);state.socketPing=null;
  if(state.socket){state.socket.onclose=null;try{state.socket.close()}catch{}}
  state.socket=null;state.socketTopic=null;state.wsState="offline";
}
function go(page, hash=null){
  if(page!=="chat")closeSocket();
  state.page=page;
  if(hash)setHash(hash);
  render();
}
function header(){
  const u=state.user;
  $("#topbar").innerHTML=`
    <a class="brand" href="#/projects" data-action="home">
      <span class="brand-mark"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-6.5A2.5 2.5 0 0 1 4 11z"/><path d="M8 8h8M8 11.5h5"/></svg></span>
      <span>Vendor Discussion Portal<small>LIVE CHAT · PROCUREMENT</small></span>
    </a>
    <nav class="nav">
      <button data-action="home" class="${state.page==="projects"?"active":""}">Project</button>
      ${isProc()?`<button data-action="home">Workspace</button>`:""}
      ${state.user?.role==="admin"?`<button data-action="users" class="${state.page==="users"?"active":""}">Pengguna</button>`:""}
    </nav>
    <div class="top-actions">
      ${u?`<div class="user-pill"><span class="avatar ${u.role==="vendor"?"vendor":""}">${esc(initials(u.name))}</span><span><span class="user-name">${esc(u.name)}</span><span class="role-tag">${u.role==="admin"?"Super Admin":u.role==="procurement"?"Procurement":"Vendor"}</span></span></div><button class="btn btn-ghost btn-small" data-action="logout">Keluar</button>`:
      `<button class="btn btn-ghost btn-small" data-action="login">Masuk</button><button class="btn btn-primary btn-small" data-action="register">Daftar Vendor</button>`}
    </div>`;
}
function render(){
  header();
  const app=$("#app");
  if(state.needsSetup){app.innerHTML=setupView();return}
  if(state.page==="login"){app.innerHTML=authView("login");return}
  if(state.page==="register"){app.innerHTML=authView("register");return}
  if(state.page==="project"&&state.project){app.innerHTML=projectView();return}
  if(state.page==="chat"&&state.topic){app.innerHTML=chatView();connectSocket(state.topic.id);return}
  if(state.page==="users"&&state.user?.role==="admin"){app.innerHTML=usersView();return}
  app.innerHTML=projectsView();
}
function setupView(){return `<section class="auth-wrap card">
  <div class="eyebrow">First-time setup</div><h1>Aktifkan Procurement Admin</h1>
  <p>Buat akun Super Admin pertama. Setup hanya tersedia sekali dan memerlukan secret yang Anda simpan di Cloudflare Worker.</p>
  <form data-form="setup">
    <div class="field"><label>Setup Secret</label><input class="input" name="secret" type="password" required autocomplete="off"></div>
    <div class="field"><label>Nama Admin</label><input class="input" name="name" required minlength="3" placeholder="Nama lengkap"></div>
    <div class="field"><label>Username</label><input class="input" name="username" required minlength="3" autocomplete="username" placeholder="admin.procurement"></div>
    <div class="field"><label>Password (minimal 12 karakter)</label><input class="input" name="password" type="password" required minlength="12" autocomplete="new-password"></div>
    <div id="form-error"></div><button class="btn btn-primary" style="width:100%">Buat Super Admin</button>
  </form>
  <div class="alert info">Setelah akun admin pertama dibuat, secret tidak dapat digunakan kembali untuk membuat admin kedua.</div>
</section>`}
function authView(kind){
  const login=kind==="login";
  return `<section class="auth-wrap card">
    <div class="eyebrow">${login?"Welcome back":"Vendor onboarding"}</div>
    <h1>${login?"Masuk ke portal":"Registrasi Vendor"}</h1>
    <p>${login?"Gunakan akun Vendor atau Procurement untuk melanjutkan diskusi.":"Akun vendor langsung aktif setelah registrasi. Tidak perlu menunggu approval."}</p>
    <form data-form="${kind}">
      <div class="field"><label>Username</label><input class="input" name="username" required autocomplete="username" placeholder="username"></div>
      ${login?"":`<div class="field"><label>Nama Vendor / Perusahaan</label><input class="input" name="company" required minlength="3" placeholder="PT Nama Perusahaan"></div>`}
      <div class="field"><label>Password</label><input class="input" type="password" name="password" required ${login?"":"minlength=\"10\""} autocomplete="${login?"current-password":"new-password"}"></div>
      <div id="form-error"></div><button class="btn btn-primary" style="width:100%">${login?"Masuk":"Buat Akun Vendor"}</button>
    </form>
    <p style="margin:16px 0 0;text-align:center">${login?`Belum punya akun? <a href="#/register" data-action="register" style="color:var(--cyan)">Daftar vendor</a>`:`Sudah punya akun? <a href="#/login" data-action="login" style="color:var(--cyan)">Masuk</a>`}</p>
    <button class="btn btn-ghost" style="width:100%;margin-top:12px" data-action="home">Kembali ke daftar project</button>
  </section>`;
}
function projectsView(){
  const projects=state.projects;
  const filtered=projects.filter(p=>(p.name+" "+p.description+" "+p.category).toLowerCase().includes(state.search.toLowerCase()));
  return `
  <section class="hero">
    <div><div class="eyebrow">Portal Diskusi Pengadaan · Realtime</div>
      <h1>Klarifikasi <span class="gradient-text">terbuka.</span><br>Diskusi <span class="gradient-text">langsung.</span></h1>
      <p>Satu ruang live chat untuk seluruh vendor dalam project pengadaan. Pesan tampil realtime, jawaban Procurement dapat dibaca seluruh peserta, dan identitas vendor tetap anonim.</p>
      <div class="row wrap">
        ${state.user?`<span class="pill open">● ${state.user.role==="vendor"?"Vendor aktif":"Procurement online"}</span>`:`<button class="btn btn-primary" data-action="register">Daftar sebagai Vendor</button><button class="btn btn-ghost" data-action="login">Masuk</button>`}
        ${isProc()?`<button class="btn btn-ghost" data-action="create-project">＋ Buat Project</button>`:""}
      </div>
      <div class="row wrap" style="margin-top:18px;color:var(--muted);font-size:11px"><span>✓ WebSocket realtime</span><span>✓ Alias per project</span><span>✓ Riwayat tersimpan di server</span></div>
    </div>
    <div class="hero-card"><h3>Contoh percakapan realtime</h3>
      <div class="preview-msg"><span class="mini-avatar">V01</span><div><strong style="font-size:12px">Vendor 01 <small>· 10:21</small></strong><p>Apakah pengiriman boleh dilakukan bertahap?</p></div></div>
      <div class="preview-msg"><span class="mini-avatar" style="background:#173c69;color:#93c5fd">PR</span><div><strong style="font-size:12px">Procurement <small>· 10:23</small></strong><p>Diperbolehkan. Batch pertama minimal 100 unit dalam 14 hari setelah PO.</p></div></div>
      <div class="preview-msg"><span class="mini-avatar">V02</span><div><strong style="font-size:12px">Vendor 02 <small>· 10:25</small></strong><p>Terima kasih, klarifikasi ini membantu penawaran kami.</p></div></div>
    </div>
  </section>
  <div class="section-head"><div><h2>Project Pengadaan</h2><p>Daftar project dan topik diskusi yang tersedia untuk vendor.</p></div><div class="row wrap"><input class="input search" id="project-search" placeholder="Cari project…" value="${esc(state.search)}"></div></div>
  ${filtered.length?`<div class="grid">${filtered.map(projectCard).join("")}</div>`:`<div class="card empty"><strong>Belum ada project</strong>Project yang dibuat Procurement akan muncul di sini.</div>`}
  <footer class="footer"><span>Vendor Discussion Portal · Live Chat</span><span>Cloudflare Workers · D1 · Durable Objects · R2</span></footer>`;
}
function usersView(){
  return `<div class="section-head"><div><div class="eyebrow">Administration</div><h2>Kelola Pengguna</h2><p>Super Admin dapat membuat akun Procurement dan mengelola status akun vendor.</p></div><button class="btn btn-primary" data-action="create-procurement">＋ Tambah Procurement</button></div>
  ${state.users.length?`<div class="card" style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="color:var(--soft);text-align:left"><th style="padding:13px">Pengguna</th><th>Role</th><th>Status</th><th>Terdaftar</th><th>Aksi</th></tr></thead><tbody>${state.users.map(u=>`<tr style="border-top:1px solid var(--line)"><td style="padding:13px"><b>${esc(u.name)}</b><div class="soft">@${esc(u.username)}</div></td><td>${u.role==="procurement"?"Procurement":"Vendor"}</td><td><span class="pill ${u.status==="active"?"open":"closed"}">${esc(u.status)}</span></td><td class="soft">${fmtTime(u.created_at)}</td><td>${u.status==="active"?`<button class="btn btn-danger btn-small" data-user-status="${esc(u.id)}" data-status="blocked">Blokir</button>`:`<button class="btn btn-primary btn-small" data-user-status="${esc(u.id)}" data-status="active">Aktifkan</button>`}</td></tr>`).join("")}</tbody></table></div>`:`<div class="card empty"><strong>Belum ada pengguna</strong>Vendor yang registrasi dan Procurement yang dibuat akan muncul di sini.</div>`}
  <div class="row" style="margin-top:18px"><button class="btn btn-ghost" data-action="home">← Kembali</button></div>`;
}
async function loadUsers(){const data=await api("/api/admin/users");state.users=data.users||[]}
function procurementModal(){
  openModal("Tambah Akun Procurement","Akun Procurement dapat membuat project dan topik, membalas chat, serta memoderasi pesan.",`
    <form data-form="create-procurement">
      <div class="field"><label>Nama</label><input class="input" name="name" required minlength="3"></div>
      <div class="field"><label>Username</label><input class="input" name="username" required minlength="3"></div>
      <div class="field"><label>Password awal (minimal 10 karakter)</label><input class="input" name="password" type="password" required minlength="10"></div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Batal</button><button class="btn btn-primary">Buat Akun</button></div>
    </form>`);
}
function projectCard(p){
  return `<article class="card project-card" data-project="${esc(p.id)}">
    <div class="row between"><span class="pill ${p.status==="open"?"open":"closed"}">${p.status==="open"?"● Open":"Closed"}</span><span class="soft" style="font-size:10px">${esc(p.category||"")}</span></div>
    <h3>${esc(p.name)}</h3><p>${esc(p.description)}</p>
    <div class="project-meta"><span>▤ ${p.topic_count||0} topik</span><span>◌ ${p.message_count||0} pesan</span><span>${esc(p.period||"")}</span></div>
    <div class="row between"><span class="soft" style="font-size:10px">Aktivitas ${p.last_activity?fmtTime(p.last_activity):"—"}</span><span style="font-size:11px;color:var(--blue);font-weight:800">Lihat project →</span></div>
  </article>`;
}
function projectView(){
  const p=state.project, closedVendor=p.status==="closed"&&state.user?.role==="vendor";
  return `<div class="breadcrumb"><button data-action="home">Project</button><span>›</span><span>${esc(p.name)}</span></div>
  <section class="card project-head">
    <div class="row between wrap"><span class="pill ${p.status==="open"?"open":"closed"}">${p.status==="open"?"● Open":"Closed"}</span>
      ${isProc()?`<button class="btn ${p.status==="open"?"btn-danger":"btn-primary"} btn-small" data-action="toggle-project">${p.status==="open"?"Tutup Project":"Buka Kembali"}</button>`:""}
    </div>
    <h1>${esc(p.name)}</h1><p>${esc(p.description)}</p>
    <div class="project-meta"><span>${esc(p.category||"")}</span><span>Periode: ${esc(p.period||"")}</span><span>${p.participant_count||0} peserta</span><span>${p.message_count||0} pesan</span></div>
  </section>
  ${closedVendor?`<div class="alert">Project telah ditutup. Riwayat percakapan hanya dapat diakses oleh Procurement.</div>`:""}
  <div class="section-head"><div><h2>Topik Diskusi</h2><p>Pilih topik untuk membuka ruang live chat.</p></div>${isProc()?`<button class="btn btn-primary" data-action="create-topic">＋ Buat Topik</button>`:""}</div>
  ${state.topics.length?`<div class="topic-list">${state.topics.map(t=>`<article class="card topic-card" data-topic="${esc(t.id)}" ${closedVendor?'style="opacity:.5;cursor:not-allowed"':''}>
    <div class="topic-icon">▤</div><div class="grow"><div class="row wrap"><h3>${esc(t.title)}</h3><span class="pill ${t.status==="open"?"open":"closed"}">${t.status==="open"?"Open":"Topik Ditutup"}</span></div><p>${esc(t.description)}</p></div>
    <div class="topic-count">${t.message_count||0} pesan<br><span class="soft">${t.last_activity?fmtTime(t.last_activity):"—"}</span></div>
    ${isProc()?`<button class="btn btn-ghost btn-small" data-topic-status="${esc(t.id)}" data-status="${t.status}">${t.status==="open"?"Tutup":"Buka"}</button>`:""}
  </article>`).join("")}</div>`:`<div class="card empty"><strong>Belum ada topik</strong>Procurement akan menambahkan topik klarifikasi untuk project ini.</div>`}
  <div class="row" style="margin-top:20px"><button class="btn btn-ghost" data-action="home">← Kembali ke project</button></div>`;
}
function chatView(){
  const c=state.context||{},p=state.project,t=state.topic;
  const closedProject=p?.status==="closed",closedTopic=t?.status==="closed";
  const canSend=!!state.user&&!closedProject&&(isProc()||!closedTopic);
  return `<div class="breadcrumb"><button data-action="open-project" data-id="${esc(p?.id||"")}">${esc(p?.name||"Project")}</button><span>›</span><span>${esc(t.title)}</span></div>
  <section class="chat-shell">
    <div class="chat-head">
      <button class="btn btn-ghost btn-small" data-action="open-project" data-id="${esc(p?.id||"")}">←</button>
      <div class="grow"><h2>${esc(t.title)}</h2><small>${esc(p?.name||"")} · ${t.status==="open"?"TOPIK OPEN":"TOPIK DITUTUP"}</small></div>
      <span class="connection ${state.wsState==="online"?"online":state.wsState==="offline"?"offline":""}" id="connection">${state.wsState==="online"?"Realtime aktif":state.wsState==="offline"?"Menghubungkan…":"Menghubungkan…"}</span>
      ${isProc()?`<button class="btn btn-ghost btn-small" data-action="toggle-topic">${t.status==="open"?"Tutup Topik":"Buka Topik"}</button>`:""}
    </div>
    <div class="chat-info">${state.user?.role==="vendor"?`Anda tampil sebagai <b>${esc(state.alias||"Vendor")}</b>. Vendor lain tidak dapat melihat nama perusahaan atau username Anda.`:"Mode Procurement: identitas vendor dapat dilihat oleh Procurement, tetapi disamarkan bagi vendor lain."}</div>
    <div class="messages" id="messages">${messagesHTML()}</div>
    ${closedProject?`<div class="composer"><div class="alert">Project Closed — ruang chat bersifat arsip dan tidak menerima pesan baru.</div></div>`:!canSend?`<div class="composer"><div class="alert">Topik ditutup oleh Procurement. Anda masih dapat membaca riwayat diskusi.</div></div>`:
    `<form class="composer" data-form="message">
      <div class="composer-note">${isProc()?"Pesan dikirim sebagai Procurement dan langsung terlihat oleh seluruh vendor.":"Pesan langsung tayang untuk seluruh peserta dengan alias anonim."} · Chat teks realtime aktif; lampiran belum diaktifkan.</div>
      <div id="reply-bar"></div>
      <div class="composer-row">
        <textarea name="body" id="message-input" rows="1" maxlength="5000" placeholder="Tulis pertanyaan atau balasan… (Enter untuk kirim, Shift+Enter untuk baris baru)"></textarea>
        <button class="send" aria-label="Kirim pesan">➤</button>
      </div>
    </form>`}
  </section>`;
}
function messagesHTML(){
  if(!state.messages.length)return `<div class="empty"><strong>Belum ada pesan</strong>Jadilah yang pertama memulai diskusi di topik ini.</div>`;
  let out="",lastDay="";
  for(const m of state.messages){
    const day=fmtDay(m.createdAt);
    if(day!==lastDay){out+=`<div class="day-sep">${esc(day)}</div>`;lastDay=day}
    const parent=m.replyTo?state.messages.find(x=>x.id===m.replyTo):null;
    const hidden=m.visibility!=="visible";
    out+=`<div class="message ${m.senderRole==="procurement"?"official":""} ${m.isMine?"mine":""}" id="msg-${esc(m.id)}">
      <div class="message-avatar ${m.senderRole==="procurement"?"proc":""}">${m.senderRole==="procurement"?"PR":esc(initials(m.senderLabel))}</div>
      <div class="message-main">
        <div class="message-top"><strong>${esc(m.senderLabel)}</strong>${isProc()&&m.senderCompany?`<small class="soft">· ${esc(m.senderCompany)}</small>`:""}${m.senderRole==="procurement"?`<span class="pill" style="color:#8fc0ff;border-color:#4d8dff55">Procurement</span>`:""}
          ${hidden?`<span class="pill closed">${m.visibility==="hidden"?"Disembunyikan":"Dihapus"}</span>`:""}
          <time>${fmtTime(m.createdAt)}</time>
          <span class="message-tools">
            ${!hidden?`<button data-reply="${esc(m.id)}">Balas</button>`:""}
            ${isProc()?`<button data-moderate="${esc(m.id)}" data-visibility="${hidden?"visible":"hidden"}">${hidden?"Pulihkan":"Sembunyikan"}</button><button data-moderate="${esc(m.id)}" data-visibility="deleted">Hapus</button>`:""}
          </span>
        </div>
        ${parent?`<div class="reply-preview">Membalas ${esc(parent.senderLabel)}: ${esc(parent.body.slice(0,120))}</div>`:""}
        <div class="message-body" ${hidden?'style="opacity:.55"':""}>${esc(m.body)}</div>
        ${hidden&&m.modReason&&isProc()?`<div class="soft" style="font-size:10px;margin-top:5px">Alasan moderasi: ${esc(m.modReason)}</div>`:""}
        ${m.files?.length?`<div class="message-files">${m.files.map(f=>`<span class="row wrap"><a class="file-chip" href="/api/files/${encodeURIComponent(f.id)}" target="_blank" rel="noopener">▧ ${esc(f.name)} <small>${fmtSize(f.size)} · ${f.access==="private"?"Privat":"Shared"}</small></a>${isProc()&&f.access==="private"?`<button class="btn btn-ghost btn-small" data-publish-file="${esc(f.id)}">Publikasikan salinan sanitasi</button>`:""}</span>`).join("")}</div>`:""}
      </div></div>`;
  }
  return out;
}
function renderMessages(keepBottom=true){
  const box=$("#messages");if(!box)return;
  const bottom=box.scrollHeight-box.scrollTop-box.clientHeight<100;
  box.innerHTML=messagesHTML();
  if(keepBottom||bottom)box.scrollTop=box.scrollHeight;
}
async function loadMessages(){
  if(!state.topic)return;
  const data=await api(`/api/topics/${encodeURIComponent(state.topic.id)}/messages`);
  state.context=data.context;state.messages=data.messages;
  state.alias=data.context.myAlias||state.alias;
  if(state.project){state.project.status=data.context.projectStatus}
  if(state.topic){state.topic.status=data.context.topicStatus}
  renderMessages();
  updateConnection();
}
function updateConnection(){
  const el=$("#connection");if(!el)return;
  el.className=`connection ${state.wsState==="online"?"online":state.wsState==="offline"?"offline":""}`;
  el.textContent=state.wsState==="online"?"Realtime aktif":state.wsState==="offline"?"Terputus · mencoba ulang":"Menghubungkan…";
}
function connectSocket(topicId){
  if(state.socketTopic===topicId&&state.socket&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(state.socket.readyState))return;
  closeSocket();state.socketTopic=topicId;state.wsState="connecting";updateConnection();
  const scheme=location.protocol==="https:"?"wss":"ws";
  const ws=new WebSocket(`${scheme}://${location.host}/api/topics/${encodeURIComponent(topicId)}/ws`);
  state.socket=ws;
  ws.onopen=()=>{
    if(state.socket!==ws)return;
    state.wsState="online";updateConnection();
    clearInterval(state.socketPing);
    state.socketPing=setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.send("authping")},30000);
  };
  ws.onmessage=async(event)=>{
    if(event.data==="pong")return;
    try{const payload=JSON.parse(event.data);
      if(payload.type==="project_status"&&payload.status==="closed"&&state.user?.role==="vendor"){
        toast("Project ditutup Procurement. Akses vendor ke histori dihentikan.","error");
        closeSocket();await loadProjects();await openProject(state.project.id,false);return;
      }
      await loadMessages();
      if(["topic_status","project_status"].includes(payload.type)){render();return}
      if(["message","moderation","file_published"].includes(payload.type)) {
        const target=payload.messageId?document.getElementById(`msg-${payload.messageId}`):null;
        if(target)target.scrollIntoView({block:"nearest"});
      }
    }catch(err){console.error(err)}
  };
  ws.onclose=(event)=>{
    if(state.socket!==ws)return;
    clearInterval(state.socketPing);state.socketPing=null;
    state.wsState="offline";updateConnection();
    if(event.code===1008){
      closeSocket();state.user=null;toast("Akun Anda dinonaktifkan atau diblokir. Silakan hubungi Procurement.","error");
      go("login","#/login");return;
    }
    state.reconnect=setTimeout(()=>{if(state.page==="chat"&&state.topic?.id===topicId)connectSocket(topicId)},1800);
  };
  ws.onerror=()=>{try{ws.close()}catch{}};
}
async function loadProjects(){
  const data=await api("/api/projects");state.projects=data.projects||[];
}
async function openProject(id,changeHash=true){
  const data=await api(`/api/projects/${encodeURIComponent(id)}`);
  state.project=data.project;state.topics=data.topics||[];state.alias=data.myAlias||state.alias;state.page="project";state.topic=null;
  if(changeHash)setHash(`#/project/${encodeURIComponent(id)}`);
  closeSocket();render();
}
async function openChat(topicId,changeHash=true){
  const old=state.page;
  state.topic=state.topics.find(t=>t.id===topicId)||state.topic;
  if(!state.topic)throw new Error("Topik tidak ditemukan.");
  state.page="chat";state.selectedFiles=[];state.replyTo=null;
  if(changeHash)setHash(`#/chat/${encodeURIComponent(state.project.id)}/${encodeURIComponent(topicId)}`);
  const data=await api(`/api/topics/${encodeURIComponent(topicId)}/messages`);
  state.context=data.context;state.messages=data.messages;
  state.alias=data.context.myAlias||state.alias;
  state.project.status=data.context.projectStatus;state.topic.status=data.context.topicStatus;
  render();
}
async function sendMessage(form){
  const body=String(form.elements.namedItem("body")?.value||"").trim();
  if(!body&&!state.selectedFiles.length)return;
  const fd=new FormData();fd.append("body",body);
  if(state.replyTo)fd.append("replyTo",state.replyTo);
  state.selectedFiles.forEach(file=>fd.append("files",file,file.name));
  const send=form.querySelector("button.send");send.disabled=true;send.textContent="…";
  try{
    await api(`/api/topics/${encodeURIComponent(state.topic.id)}/messages`,{method:"POST",body:fd});
    state.selectedFiles=[];state.replyTo=null;form.reset();
    await loadMessages();$("#selected-files")?.replaceChildren();if($("#reply-bar"))$("#reply-bar").innerHTML="";
  }catch(err){toast(err.message,"error")}
  finally{if(send){send.disabled=false;send.textContent="➤"}}
}
function openModal(title,sub,body){
  $("#modal-root").innerHTML=`<div class="modal-backdrop"><section class="modal"><div class="row between"><h2>${esc(title)}</h2><button class="btn btn-ghost btn-small" data-action="close-modal">Tutup</button></div>${sub?`<p>${esc(sub)}</p>`:""}${body}</section></div>`;
}
function closeModal(){$("#modal-root").innerHTML=""}
function projectModal(){
  openModal("Buat Project","Project akan langsung tampil di homepage dengan status Open.",`
    <form data-form="create-project">
      <div class="field"><label>Nama project</label><input class="input" name="name" required minlength="5" maxlength="160"></div>
      <div class="field"><label>Deskripsi</label><textarea class="input" name="description" required maxlength="2000" rows="3"></textarea></div>
      <div class="field"><label>Kategori</label><select class="input" name="category"><option>Teknologi Informasi</option><option>Jasa Umum</option><option>Konstruksi & Interior</option><option>Kendaraan & Logistik</option><option>Peralatan & Fasilitas</option><option>Lainnya</option></select></div>
      <div class="field"><label>Periode</label><input class="input" name="period" required placeholder="Nov – Des 2026"></div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Batal</button><button class="btn btn-primary">Buat Project</button></div>
    </form>`);
}
function topicModal(){
  openModal("Buat Topik Diskusi","Hanya Procurement yang dapat membuat topik baru.",`
    <form data-form="create-topic">
      <div class="field"><label>Judul topik</label><input class="input" name="title" required minlength="4" maxlength="160"></div>
      <div class="field"><label>Deskripsi singkat</label><textarea class="input" name="description" rows="3" required maxlength="1200"></textarea></div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Batal</button><button class="btn btn-primary">Buat Topik</button></div>
    </form>`);
}
async function publishSanitized(fileId){
  state.publishFileId=fileId;$("#sanitize-picker").value="";$("#sanitize-picker").click();
}
async function handleForm(form){
  const kind=form.dataset.form;const values=Object.fromEntries(new FormData(form).entries());
  const err=$("#form-error",form);
  try{
    if(kind==="setup"){
      await api("/api/setup",{method:"POST",body:values});
      const session=await api("/api/session");state.user=session.user;state.needsSetup=session.needsSetup;
      await loadProjects();state.page="projects";toast("Super Admin berhasil dibuat.");render();return;
    }
    if(kind==="login"){
      const data=await api("/api/login",{method:"POST",body:values});state.user=data.user;
      await loadProjects();state.page="projects";state.search="";setHash("#/projects");toast(`Selamat datang, ${data.user.name}.`);render();return;
    }
    if(kind==="register"){
      const data=await api("/api/register",{method:"POST",body:values});state.user=data.user;
      await loadProjects();state.page="projects";setHash("#/projects");toast("Akun vendor aktif. Selamat bergabung.");render();return;
    }
    if(kind==="create-project"){
      await api("/api/projects",{method:"POST",body:values});closeModal();await loadProjects();state.page="projects";render();toast("Project berhasil dibuat.");return;
    }
    if(kind==="create-topic"){
      await api(`/api/projects/${encodeURIComponent(state.project.id)}/topics`,{method:"POST",body:values});closeModal();await openProject(state.project.id,false);toast("Topik berhasil dibuat.");return;
    }
    if(kind==="create-procurement"){
      await api("/api/admin/users",{method:"POST",body:values});closeModal();await loadUsers();render();toast("Akun Procurement berhasil dibuat.");return;
    }
    if(kind==="message"){await sendMessage(form);return}
  }catch(error){
    if(err){err.innerHTML=`<div class="alert error">${esc(error.message)}</div>`}else toast(error.message,"error");
  }
}
document.addEventListener("submit",event=>{
  const form=event.target.closest("form[data-form]");if(!form)return;
  event.preventDefault();handleForm(form);
});
document.addEventListener("click",async event=>{
  const action=event.target.closest("[data-action]")?.dataset.action;
  if(action){
    event.preventDefault();
    try{
      if(action==="home"){await loadProjects();go("projects","#/projects")}
      if(action==="login")go("login","#/login");
      if(action==="register")go("register","#/register");
      if(action==="logout"){await api("/api/logout",{method:"POST"});state.user=null;state.project=null;state.topic=null;state.page="projects";await loadProjects();setHash("#/projects");closeSocket();toast("Anda telah keluar.");render()}
      if(action==="create-project")projectModal();
      if(action==="create-topic")topicModal();
      if(action==="users"){await loadUsers();go("users","#/users")}
      if(action==="create-procurement")procurementModal();
      if(action==="close-modal")closeModal();
      if(action==="pick-files")$("#message-files")?.click();
      if(action==="open-project"){await openProject(event.target.closest("[data-id]")?.dataset.id||state.project.id)}
      if(action==="toggle-project"){
        const next=state.project.status==="open"?"closed":"open";
        if(!confirm(next==="closed"?"Tutup project? Vendor tidak dapat membaca histori setelah project ditutup.":"Buka kembali project?"))return;
        await api(`/api/projects/${encodeURIComponent(state.project.id)}/status`,{method:"PATCH",body:{status:next}});
        await loadProjects();await openProject(state.project.id,false);toast(`Project ${next==="closed"?"ditutup":"dibuka kembali"}.`);
      }
      if(action==="toggle-topic"){
        const next=state.topic.status==="open"?"closed":"open";
        await api(`/api/topics/${encodeURIComponent(state.topic.id)}/status`,{method:"PATCH",body:{status:next}});
        state.topic.status=next;await loadMessages();render();toast(`Topik ${next==="closed"?"ditutup":"dibuka kembali"}.`);
      }
    }catch(err){toast(err.message,"error")}
  }
  const project=event.target.closest("[data-project]");
  if(project){try{await openProject(project.dataset.project)}catch(err){toast(err.message,"error")}}
  const topic=event.target.closest("[data-topic]");
  if(topic&&!event.target.closest("[data-topic-status]")){
    if(!state.user){toast("Masuk terlebih dahulu untuk membaca isi diskusi.","error");go("login","#/login");return}
    if(state.project.status==="closed"&&state.user.role==="vendor"){toast("Project Closed — histori hanya dapat diakses Procurement.","error");return}
    try{await openChat(topic.dataset.topic)}catch(err){toast(err.message,"error")}
  }
  const topicStatus=event.target.closest("[data-topic-status]");
  if(topicStatus){
    event.stopPropagation();
    try{
      const next=topicStatus.dataset.status==="open"?"closed":"open";
      await api(`/api/topics/${encodeURIComponent(topicStatus.dataset.topicStatus)}/status`,{method:"PATCH",body:{status:next}});
      await openProject(state.project.id,false);toast(`Topik ${next==="closed"?"ditutup":"dibuka kembali"}.`);
    }catch(err){toast(err.message,"error")}
  }
  const userStatus=event.target.closest("[data-user-status]");
  if(userStatus){
    event.stopPropagation();
    const next=userStatus.dataset.status;
    if(!confirm(next==="blocked"?"Blokir akun ini? Sesi aktif akan dicabut.":"Aktifkan kembali akun ini?"))return;
    try{
      await api(`/api/admin/users/${encodeURIComponent(userStatus.dataset.userStatus)}/status`,{method:"PATCH",body:{status:next}});
      await loadUsers();render();toast(`Status akun diperbarui menjadi ${next}.`);
    }catch(err){toast(err.message,"error")}
  }
  const mod=event.target.closest("[data-moderate]");
  if(mod){
    event.stopPropagation();
    const visibility=mod.dataset.visibility;
    const reason=visibility==="visible"?"":prompt(visibility==="deleted"?"Alasan menghapus pesan:":"Alasan menyembunyikan pesan:");
    if(visibility!=="visible"&&!reason)return;
    try{await api(`/api/messages/${encodeURIComponent(mod.dataset.moderate)}/moderate`,{method:"POST",body:{visibility,reason}});await loadMessages();toast("Moderasi pesan tersimpan.")}catch(err){toast(err.message,"error")}
  }
  const reply=event.target.closest("[data-reply]");
  if(reply){
    state.replyTo=reply.dataset.reply;
    const m=state.messages.find(x=>x.id===state.replyTo);
    const bar=$("#reply-bar");if(bar&&m)bar.innerHTML=`<div class="reply-preview">Membalas <b>${esc(m.senderLabel)}</b>: ${esc(m.body.slice(0,100))} <button type="button" data-action="cancel-reply">Batal</button></div>`;
    $("#message-input")?.focus();
  }
  if(action==="cancel-reply"){state.replyTo=null;$("#reply-bar").innerHTML=""}
  const publish=event.target.closest("[data-publish-file]");
  if(publish){event.stopPropagation();publishSanitized(publish.dataset.publishFile)}
  const backdrop=event.target.closest(".modal-backdrop");
  if(backdrop&&event.target===backdrop)closeModal();
});
document.addEventListener("input",event=>{
  if(event.target.id==="project-search"){
    state.search=event.target.value;
    const app=$("#app");app.innerHTML=projectsView();
    const search=$("#project-search");if(search){search.focus();search.setSelectionRange(search.value.length,search.value.length)}
  }
});
document.addEventListener("change",event=>{
  if(event.target.id==="message-files"){
    state.selectedFiles=[...event.target.files].slice(0,3);
    if([...event.target.files].length>3)toast("Maksimal 3 file per pesan.","error");
    if(state.selectedFiles.some(f=>f.size>2*1024*1024)){toast("Setiap file maksimal 2 MB.","error");state.selectedFiles=state.selectedFiles.filter(f=>f.size<=2*1024*1024)}
    const box=$("#selected-files");if(box)box.innerHTML=state.selectedFiles.map(f=>`<span class="selected-file">${esc(f.name)} · ${fmtSize(f.size)}</span>`).join("");
  }
  if(event.target.id==="sanitize-picker"){
    const file=event.target.files?.[0],id=state.publishFileId;
    if(!file||!id)return;
    if(file.size>2*1024*1024){toast("File sanitasi maksimal 2 MB.","error");return}
    const fd=new FormData();fd.append("file",file,file.name);
    api(`/api/files/${encodeURIComponent(id)}/publish`,{method:"POST",body:fd})
      .then(async()=>{await loadMessages();toast("Salinan sanitasi dipublikasikan ke seluruh vendor.")})
      .catch(err=>toast(err.message,"error"))
      .finally(()=>{state.publishFileId=null;event.target.value=""});
  }
});
document.addEventListener("keydown",event=>{
  if(event.target.id==="message-input"&&event.key==="Enter"&&!event.shiftKey){
    event.preventDefault();event.target.closest("form")?.requestSubmit();
  }
});
window.addEventListener("hashchange",async()=>{
  const parts=location.hash.replace(/^#\//,"").split("/");
  try{
    if(parts[0]==="project"&&parts[1]){await openProject(decodeURIComponent(parts[1]),false);return}
    if(parts[0]==="chat"&&parts[1]&&parts[2]){
      await openProject(decodeURIComponent(parts[1]),false);
      await openChat(decodeURIComponent(parts[2]),false);return;
    }
    if(parts[0]==="login"){go("login");return}
    if(parts[0]==="register"){go("register");return}
    if(parts[0]==="users"&&state.user?.role==="admin"){await loadUsers();go("users");return}
    await loadProjects();go("projects");
  }catch(err){toast(err.message,"error");await loadProjects();go("projects","#/projects")}
});
async function init(){
  try{
    const session=await api("/api/session");state.user=session.user;state.needsSetup=session.needsSetup;
    await loadProjects();
    const parts=location.hash.replace(/^#\//,"").split("/");
    if(!state.needsSetup&&parts[0]==="project"&&parts[1])await openProject(decodeURIComponent(parts[1]),false);
    else if(!state.needsSetup&&parts[0]==="chat"&&parts[1]&&parts[2]){
      await openProject(decodeURIComponent(parts[1]),false);await openChat(decodeURIComponent(parts[2]),false);
    }else if(!state.needsSetup&&parts[0]==="login")state.page="login";
    else if(!state.needsSetup&&parts[0]==="register")state.page="register";
    else if(!state.needsSetup&&parts[0]==="users"&&state.user?.role==="admin"){await loadUsers();state.page="users"}
    render();
  }catch(err){$("#app").innerHTML=`<div class="card empty"><strong>Aplikasi belum terhubung ke backend</strong>${esc(err.message)}<p>Pastikan D1 migration, Durable Object, dan binding Cloudflare sudah dikonfigurasi.</p></div>`}
}
init();

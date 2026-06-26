const USER='s1r1us-a',KEY='b126713de975c43a7a8f046bcf954884',API='https://ws.audioscrobbler.com/2.0/';
const PINK='#ec4899',PINK2='#f472b6';
const COLORS=['#ec4899','#8b5cf6','#3b82f6','#f472b6','#a78bfa','#22d3ee','#34d399','#fbbf24'];
const CACHE_KEY='lfm_cache_s1r1us_v2';

// ── HELPERS ────────────────────────────────────────────────
function escapeHTML(str){
  if(!str&&str!==0) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
let _chartColors=null;
function chartColors(){
  if(_chartColors) return _chartColors;
  const s=getComputedStyle(document.body);
  const tick=s.getPropertyValue('--text3').trim()||'#4a4a4a';
  const grid='rgba(255,255,255,0.04)';
  const tooltip={backgroundColor:'rgba(20,16,46,0.95)',borderColor:'rgba(139,92,246,0.4)',borderWidth:1,titleColor:'#f4f1ff',bodyColor:'#b4adcf',titleFont:{family:'Space Mono'}};
  _chartColors={tick,grid,tooltip};
  return _chartColors;
}

// ── FIREBASE ───────────────────────────────────────────────
const FB_CONFIG={
  apiKey:"AIzaSyBqeSKTO1fL5arv15HokhvV-y5CBHVB4gk",
  authDomain:"lastfm-stats.firebaseapp.com",
  projectId:"lastfm-stats",
  databaseURL:"https://lastfm-stats-default-rtdb.europe-west1.firebasedatabase.app",
  appId:"1:756175226818:web:832c6f3d35a5273aac785b"
};
firebase.initializeApp(FB_CONFIG);
const db=firebase.database();

let cache={},chartPeriod='today',chartTab='artists',sortMode='plays',allItems=[],showCount=10;

// ── ARCHIVE DATA CACHE ────────────────────────────────────
// Zentraler Firebase-Fetch: läuft nur einmal, alle weiteren Aufrufe warten auf dasselbe Promise
let _archivePromise=null;
let _lastHeroData=null; // zuletzt gerenderte Hero-Meta für Re-Render nach Archiv-Load
async function getArchiveData(){
  if(_archiveData) return _archiveData;
  if(!_archivePromise){
    _archivePromise=db.ref('scrobbles').get().then(snap=>{
      if(snap.exists()){
        _archiveData=snap.val();
        // WICHTIG: Erst rendern, dann Stats befüllen — sonst überschreibt
        // renderOverview() das gerade aktualisierte mc-today-time Element.
        try{
          if(_lastHeroData){
            renderHero(_lastHeroData, isLfmDown());
            renderOverview({total:_lastHeroData.playcount||0,days:_lastHeroData._days||0,u:_lastHeroData});
          }
        }catch(e){console.warn('Re-render after archive load failed:',e);}
        // Jetzt ist das Grid aktuell — Stats befüllen
        updateTodayTime();
        loadStreak();
        _chartCountCache={};
        updateChartsTrackCount();
      }
      return _archiveData||null;
    }).catch(()=>null);
  }
  return _archivePromise;
}
let cmpA='1month',cmpB='3month',selectedYear=null;
let monthlyInst=null,pieInst=null,trendInst=null;
let monthlyMode='12'; // '12' or 'lifetime'
let monthlyLoadId=0; // cancel token for race condition prevention
let joinYear=null;

// ── NAV HAMBURGER ──────────────────────────────────────────
function openNav(){
  document.getElementById('nav-links').classList.add('open');
  document.body.style.overflow='hidden';
}
function closeNav(){
  document.getElementById('nav-links').classList.remove('open');
  document.body.style.overflow='';
}

// ── SCROLL REVEAL ──────────────────────────────────────────
const revealObs=new IntersectionObserver((entries)=>{
  entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');revealObs.unobserve(e.target);}});
},{threshold:0.08});
document.querySelectorAll('section').forEach(s=>{s.classList.add('reveal');revealObs.observe(s);});

// ── CACHE ──────────────────────────────────────────────────
function loadCache(){try{const d=localStorage.getItem(CACHE_KEY);if(d){const p=JSON.parse(d);const age=(Date.now()-p.ts)/60000;if(age<30){cache=p.data;// always drop today's chart cache – it changes throughout the day
Object.keys(cache).filter(k=>k.startsWith('top_')&&k.endsWith('_today')).forEach(k=>delete cache[k]);document.getElementById('cache-info').textContent='Cache: vor '+Math.round(age)+' Min';return;}}}catch(e){}}
function saveCache(){try{localStorage.setItem(CACHE_KEY,JSON.stringify({ts:Date.now(),data:cache}));}catch(e){}}

// Archiv-Caches nach einem Sync invalidieren, damit neue Scrobbles sichtbar werden.
// WICHTIG: Auch _archivePromise zurücksetzen — sonst returnt getArchiveData()
// weiterhin das alte resolved-Promise und der .then()-Callback (der _archiveData
// neu setzen würde) läuft nicht mehr. Der 'today'-Chart-Cache wird in loadCache()
// ohnehin verworfen, daher hier nur die historischen top_*-Einträge leeren.
function invalidateArchiveCaches(){
  _archiveData=null;
  _archivePromise=null;
  Object.keys(cache).filter(k=>k.startsWith('top_')&&!k.endsWith('_today')).forEach(k=>delete cache[k]);
}

// ── API ────────────────────────────────────────────────────
// ── LAST.FM OFFLINE-STATUS ────────────────────────────────
// Nach 2 aufeinanderfolgenden Fehlern gilt Last.fm als "down" — dann werden
// UI-Teile, die davon abhängen, dezent ausgeblendet oder zeigen Hinweise.
let _lfmFailCount=0;
let _lfmDown=false;
const _lfmListeners=new Set();
function setLfmDown(down){
  if(_lfmDown===down) return;
  _lfmDown=down;
  _lfmListeners.forEach(fn=>{try{fn(down);}catch(e){}});
}
function onLfmStatusChange(fn){_lfmListeners.add(fn);}
function isLfmDown(){return _lfmDown;}

async function lfm(method,params={}){
  const k=method+JSON.stringify(params);
  if(cache[k]) return cache[k];
  const url=new URL(API);
  url.searchParams.set('method',method);
  url.searchParams.set('user',USER);
  url.searchParams.set('api_key',KEY);
  url.searchParams.set('format','json');
  Object.entries(params).forEach(([a,b])=>url.searchParams.set(a,b));
  try{
    const r=await fetch(url);
    if(!r.ok) throw new Error('HTTP '+r.status);
    const d=await r.json();
    cache[k]=d;
    // Erfolgreicher Call → Offline-Counter resetten
    _lfmFailCount=0;
    if(_lfmDown) setLfmDown(false);
    return d;
  }catch(e){
    _lfmFailCount++;
    if(_lfmFailCount>=2 && !_lfmDown) setLfmDown(true);
    throw e;
  }
}

// Variante die bei Fehler nicht throwt, sondern null zurückgibt —
// für Call-Sites, die graceful degradation brauchen.
async function lfmSafe(method,params={}){
  try{return await lfm(method,params);}catch(e){return null;}
}

// ── FORMAT ─────────────────────────────────────────────────
const fmt=n=>Number(n).toLocaleString('de-DE');
function fmtTime(mins,verbose=false){
  if(mins<60) return Math.round(mins)+' Min';
  const h=Math.floor(mins/60);
  const d=Math.floor(h/24);
  if(h<24) return h.toLocaleString('de-DE')+' Std';
  if(d<365) return d.toLocaleString('de-DE')+' Tage'+(verbose?' ('+h.toLocaleString('de-DE')+' Std)':'');
  return (d/365).toFixed(1)+' Jahre'+(verbose?' ('+h.toLocaleString('de-DE')+' Std)':'');
}
function fmtHours(mins){
  if(mins<60) return Math.round(mins)+' Min';
  const h=Math.floor(mins/60);
  return h.toLocaleString('de-DE')+' Std';
}
// Kurzes Dauer-Format für Progress-Anzeigen (ms-basiert)
function fmtDur(ms){
  if(ms<1000) return '<1s';
  const s=Math.round(ms/1000);
  if(s<60) return s+'s';
  const m=Math.floor(s/60);
  const rs=s%60;
  return rs===0?m+':00 min':m+':'+String(rs).padStart(2,'0')+' min';
}
// ETA-Tracker für lang-laufende Operationen.
// Verwendung: const eta=makeETATracker(); ... eta.label(pct) → "8s / noch ~12s" oder "" wenn zu früh.
function makeETATracker(){
  const start=Date.now();
  return {
    elapsed:()=>Date.now()-start,
    fmtElapsed(){return fmtDur(Date.now()-start);},
    // Gibt Rest-ETA in ms zurück, oder null wenn zu früh / zu spät für sinnvolle Schätzung
    etaMs(pct){
      if(pct<5||pct>=100) return null;
      const el=Date.now()-start;
      // Mindestens 2 Sekunden gelaufen sein, sonst ist die Schätzung Unsinn
      if(el<2000) return null;
      return Math.round(el/pct*(100-pct));
    },
    // Fertiges Label: "8s · noch ~12s" oder nur "8s" wenn keine ETA möglich
    label(pct){
      const el=this.fmtElapsed();
      const etaMs=this.etaMs(pct);
      if(etaMs===null) return el;
      return el+' · noch ~'+fmtDur(etaMs);
    }
  };
}
function timeAgo(ts){
  const s=Math.floor((Date.now()-ts*1000)/1000);
  if(s<60) return 'gerade';
  if(s<3600) return Math.floor(s/60)+' Min';
  if(s<86400) return Math.floor(s/3600)+' Std';
  if(s<604800) return Math.floor(s/86400)+' Tage';
  return new Date(ts*1000).toLocaleDateString('de-DE',{day:'2-digit',month:'short'});
}
function rankCls(i){return i===0?'g':i===1?'s':i===2?'b':'';}
function imgEl(src,cls='ri-img'){return src?`<img src="${src}" class="${cls}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'">`:`<div class="${cls.replace('img','ph')}">♪</div>`;}

// Zentrierter, wiederverwendbarer Empty-State
function emptyState(msg,icon='🎵'){
  return `<div class="empty-state"><div class="empty-ico" aria-hidden="true">${icon}</div><div class="empty-msg">${escapeHTML(msg)}</div></div>`;
}

// ── TOAST mit einfacher Warteschlange (max. 1 sichtbar) ──────
let _toastTimer=null,_toastQueue=[],_toastBusy=false;
function showToast(msg,type='',duration=4000){
  _toastQueue.push({msg,type,duration});
  if(!_toastBusy) _drainToast();
}
function _drainToast(){
  const el=document.getElementById('db-toast');
  const msgEl=document.getElementById('db-toast-msg');
  if(!el||!msgEl){_toastQueue=[];_toastBusy=false;return;}
  const next=_toastQueue.shift();
  if(!next){_toastBusy=false;return;}
  _toastBusy=true;
  el.className='show'+(next.type?' '+next.type:'');
  msgEl.textContent=next.msg;
  clearTimeout(_toastTimer);
  const dur=next.duration>0?next.duration:4000;
  _toastTimer=setTimeout(()=>{
    el.classList.remove('show');
    setTimeout(()=>{el.className='';_drainToast();},320);
  },dur);
}

// ── COUNTER ANIMATION ──────────────────────────────────────
function animateCounter(el,target,dur=1200){
  const start=Date.now();
  const isFloat=String(target).includes('.');
  const rawCurrent=parseFloat((el.textContent||'0').replace(/\./g,'').replace(',','.'));
  const from=isNaN(rawCurrent)?0:rawCurrent;
  const tick=()=>{
    const p=Math.min((Date.now()-start)/dur,1);
    const ease=1-Math.pow(1-p,3);
    const val=from+(target-from)*ease;
    el.textContent=isFloat?val.toFixed(1):fmt(Math.round(val));
    if(p<1) requestAnimationFrame(tick);
  };
  tick();
}

// ── HERO ───────────────────────────────────────────────────
// Render-Helper — funktioniert mit Last.fm-Daten ODER gecachten user_meta.
// Alle Felder sind flexibel, damit derselbe Code beide Quellen abdeckt.
function renderHero(meta, offline=false){
  const img=meta.avatar_url||meta.image_ex||'';
  if(img){
    const avEl=document.getElementById('avatar-el');
    if(avEl) avEl.outerHTML=`<img src="${img}" width="84" height="84" style="border-radius:50%;border:2px solid var(--pink);display:block;" alt="Avatar" id="avatar-el">`;
    document.getElementById('hero-bg').style.backgroundImage=`url(${img})`;
    document.getElementById('hero-bg').style.opacity='0.08';
  }
  document.getElementById('hero-rn').textContent=meta.realname||'';
  const joined=meta.registered_uts?new Date(meta.registered_uts*1000):null;
  const days=joined?Math.floor((Date.now()-joined)/86400000):0;
  // Scrobble-Gesamtzahl: bevorzugt aus Firebase-Archiv (offline-fähig & konsistent)
  const archiveCount=_archiveData?Object.keys(_archiveData).length:null;
  const total=archiveCount!==null?archiveCount:(parseInt(meta.playcount)||0);
  const joinStr=joined?joined.toLocaleDateString('de-DE',{year:'numeric',month:'long',day:'numeric'}):'—';
  const country=meta.country&&meta.country!=='None'?escapeHTML(meta.country):null;
  // Discovery-Counts: aus Archiv falls vorhanden, sonst aus Meta
  const disc=getArchiveDiscoveryCounts();
  const artistC=disc?disc.artist_count:(parseInt(meta.artist_count)||0);
  const trackC=disc?disc.track_count:(parseInt(meta.track_count)||0);
  const albumC=disc?disc.album_count:(parseInt(meta.album_count)||0);
  const offlineBadge=offline?`<div class="hm-item" style="color:var(--text3);font-size:11px;" title="Last.fm nicht erreichbar — Daten aus Archiv">⚠ Offline</div>`:'';
  document.getElementById('hero-meta').innerHTML=`
    <div class="hm-item">🎵 <span>${fmt(total)}</span> Scrobbles</div>
    <div class="hm-item">📅 seit <span>${joinStr}</span></div>
    <div class="hm-item">🗓 <span>${fmt(days)}</span> Tage</div>
    ${country?`<div class="hm-item">📍 <span>${country}</span></div>`:''}
    ${offlineBadge}
    <div class="badge">${fmt(artistC)} Künstler</div>
    <div class="badge">${fmt(trackC)} Tracks</div>
    <div class="badge">${fmt(albumC)} Alben</div>
  `;
}

async function loadHero(npTrack){
  // 1) Cached Meta zuerst rendern (sofort, offline-fähig)
  const cached=await getCachedUserMeta();
  if(cached) renderHero(cached, isLfmDown());

  // 2) Last.fm versuchen — bei Erfolg Cache updaten & neu rendern
  let u=null, days=0, total=0, joined=null;
  const d=await lfmSafe('user.getInfo');
  if(d?.user){
    u=d.user;
    await cacheUserMeta(u);
    const img=u.image?.find(x=>x.size==='extralarge')?.['#text']||u.image?.[2]?.['#text'];
    renderHero({
      avatar_url:img,
      realname:u.realname,
      registered_uts:parseInt(u.registered?.unixtime)||0,
      country:u.country,
      playcount:parseInt(u.playcount),
      artist_count:parseInt(u.artist_count),
      track_count:parseInt(u.track_count),
      album_count:parseInt(u.album_count)
    }, false);
    joined=new Date(u.registered?.unixtime*1000);
    days=Math.floor((Date.now()-joined)/86400000);
    total=parseInt(u.playcount);
  } else if(cached){
    // Last.fm down — Werte aus Cache für den Rückgabewert
    joined=cached.registered_uts?new Date(cached.registered_uts*1000):new Date();
    days=Math.floor((Date.now()-joined)/86400000);
    total=_archiveData?Object.keys(_archiveData).length:(parseInt(cached.playcount)||0);
  } else {
    // Weder Cache noch Last.fm — minimal-Fallback
    joined=new Date();days=0;total=_archiveData?Object.keys(_archiveData).length:0;
  }
  // Now playing — track already loaded by loadNowPlayingCard
  try{
    const t=npTrack;
    const dotEl=document.getElementById('online-dot');
    if(t?.['@attr']?.nowplaying){
      document.getElementById('hero-np').innerHTML=`<div class="now-playing-hero"><div class="np-dot"></div><span class="np-text">Jetzt:</span> ${escapeHTML(t.name)} — ${escapeHTML(t.artist?.name||t.artist?.['#text']||'')}</div>`;
      document.querySelector('.hero-avatar')?.classList.add('is-playing');
      if(dotEl) dotEl.style.display='block';
      if(t.image?.[2]?.['#text']){
        document.getElementById('hero-bg').style.backgroundImage=`url(${t.image[2]['#text']})`;
        document.getElementById('hero-bg').style.opacity='0.1';
      }
    } else {
      if(dotEl) dotEl.style.display='none';
    }
  }catch(e){}
  // Daten für späteren Re-Render zwischenspeichern (wenn Archiv später nachlädt)
  const heroSnapshot={
    avatar_url:u?(u.image?.find(x=>x.size==='extralarge')?.['#text']||u.image?.[2]?.['#text']||''):cached?.avatar_url||'',
    realname:u?.realname||cached?.realname||'',
    registered_uts:u?(parseInt(u.registered?.unixtime)||0):cached?.registered_uts||0,
    country:u?.country||cached?.country||'',
    playcount:total,
    artist_count:u?(parseInt(u.artist_count)||0):cached?.artist_count||0,
    track_count:u?(parseInt(u.track_count)||0):cached?.track_count||0,
    album_count:u?(parseInt(u.album_count)||0):cached?.album_count||0,
    _days:days
  };
  _lastHeroData=heroSnapshot;
  return {total,days,joined,u:u||cached||{}};
}

// ── NOW PLAYING CARD ───────────────────────────────────────
let npRefreshTimer=null;

async function loadNowPlayingCard(){
  let t=null;
  try{
    const d=await fetch(`${API}?method=user.getRecentTracks&user=${USER}&api_key=${KEY}&format=json&limit=1&extended=1`).then(r=>r.json());
    t=d?.recenttracks?.track?.[0];
    if(!t){document.getElementById('np-card-wrap').innerHTML='';return null;}

    const isLive=!!t['@attr']?.nowplaying;
    const src=t.image?.find(x=>x.size==='extralarge')?.['#text']||t.image?.find(x=>x.size==='large')?.['#text']||t.image?.[2]?.['#text']||'';
    const track=escapeHTML(t.name||'');
    const artist=escapeHTML(t.artist?.name||t.artist?.['#text']||'');
    const album=escapeHTML(t.album?.['#text']||'');
    const loved=t.loved==='1';
    const timeAgoStr=isLive?'':timeAgo(t.date?.uts);

    const coverEl=src
      ?`<img src="${src}" class="np-cover" alt="Cover" onerror="this.outerHTML='<div class=np-cover-ph>♪</div>'">`
      :`<div class="np-cover-ph">♪</div>`;

    const badgeEl=isLive
      ?`<div class="np-live-badge"><div class="np-live-dot"></div>LIVE</div>`
      :`<div class="np-last-badge">zuletzt · ${timeAgoStr}</div>`;

    document.getElementById('np-card-wrap').innerHTML=`
      <div class="np-card">
        <div class="np-card-bg" ${src?`style="background-image:url(${src})"`:''}></div>
        <div class="np-card-inner">
          ${coverEl}
          <div class="np-info">
            <div class="np-status">
              ${badgeEl}
            </div>
            <div class="np-track">${track}${loved?`<span class="np-loved">♥</span>`:''}</div>
            <div class="np-artist">${artist}</div>
            ${album?`<div class="np-album">${album}</div>`:''}
          </div>
          <button class="np-refresh" onclick="loadNowPlayingCard()" title="Aktualisieren">↻</button>
        </div>
      </div>
    `;
  }catch(e){
    // Last.fm down — dezenten Hinweis statt leerer Card zeigen
    document.getElementById('np-card-wrap').innerHTML=isLfmDown()
      ?`<div class="np-card" style="opacity:.7;"><div class="np-card-inner"><div class="np-cover-ph">♪</div><div class="np-info"><div class="np-status"><div class="np-last-badge" style="background:rgba(120,120,120,.2);">Last.fm nicht erreichbar</div></div><div class="np-track" style="color:var(--text3);">Offline</div><div class="np-artist" style="color:var(--text3);font-size:12px;">Live-Daten nicht verfügbar</div></div><button class="np-refresh" onclick="loadNowPlayingCard()" title="Erneut versuchen">↻</button></div></div>`
      :'';
  }

  // Auto-refresh alle 30s
  clearTimeout(npRefreshTimer);
  npRefreshTimer=setTimeout(loadNowPlayingCard,30000);
  return t;
}

// ── OVERVIEW ───────────────────────────────────────────────
function renderOverview({total,days,u}){
  // Total: bevorzugt aus Firebase-Archiv (offline-fähig + konsistent mit Archiv-Badge/Heatmap)
  const archiveCount=_archiveData?Object.keys(_archiveData).length:null;
  const totalFinal=archiveCount!==null?archiveCount:(parseInt(total)||0);
  // Discovery-Counts: aus Archiv rechnen (konsistent & offline-fähig), Last.fm als Fallback
  const disc=getArchiveDiscoveryCounts();
  const artistC=disc?disc.artist_count:(parseInt(u?.artist_count)||0);
  const trackC=disc?disc.track_count:(parseInt(u?.track_count)||0);
  const albumC=disc?disc.album_count:(parseInt(u?.album_count)||0);
  const estMins=totalFinal*3;
  const safedays=days>0?days:1;
  const g=document.getElementById('overview-grid');
  g.innerHTML=`
    <div class="mc hi"><div class="mc-label">Gesamt Scrobbles</div><div class="mc-val pink counter" id="cnt-total">0</div></div>
    <div class="mc"><div class="mc-label">Gesch. Hörzeit</div><div class="mc-val">${fmtHours(estMins)}</div><div class="mc-sub">≈ ${fmtTime(estMins/safedays)} / Tag</div></div>
    <div class="mc"><div class="mc-label">Ø pro Tag</div><div class="mc-val counter" id="cnt-day">0</div><div class="mc-sub">Tracks täglich</div></div>
    <div class="mc"><div class="mc-label">Ø pro Woche</div><div class="mc-val counter" id="cnt-week">0</div></div>
    <div class="mc"><div class="mc-label">Ø pro Monat</div><div class="mc-val counter" id="cnt-month">0</div></div>
    <div class="mc"><div class="mc-label">Heute gehört</div><div class="mc-val" id="mc-today-time">—</div><div class="mc-sub" id="mc-today-sub">wird geladen…</div></div>
    <div class="mc"><div class="mc-label">Aktive Tage</div><div class="mc-val counter" id="cnt-days">0</div><div class="mc-sub">seit Registrierung</div></div>
    <div class="mc"><div class="mc-label">Entdeckte Künstler</div><div class="mc-val counter" id="cnt-artists">0</div></div>
    <div class="mc"><div class="mc-label">Entdeckte Tracks</div><div class="mc-val counter" id="cnt-tracks">0</div></div>
    <div class="mc"><div class="mc-label">Entdeckte Alben</div><div class="mc-val counter" id="cnt-albums">0</div></div>

  `;
  setTimeout(()=>{
    animateCounter(document.getElementById('cnt-total'),totalFinal);
    animateCounter(document.getElementById('cnt-day'),parseFloat((totalFinal/safedays).toFixed(1)));
    animateCounter(document.getElementById('cnt-week'),Math.round(totalFinal/(safedays/7)));
    animateCounter(document.getElementById('cnt-month'),Math.round(totalFinal/(safedays/30.44)));
    animateCounter(document.getElementById('cnt-days'),days);
    animateCounter(document.getElementById('cnt-artists'),artistC);
    animateCounter(document.getElementById('cnt-tracks'),trackC);
    animateCounter(document.getElementById('cnt-albums'),albumC);
    // "Heute gehört" direkt mit befüllen wenn Archiv schon verfügbar —
    // sonst würde es bis zum nächsten Archiv-Load-Callback "wird geladen…" bleiben.
    if(_archiveData) updateTodayTime();
  },100);
}

// ── HEUTE GEHÖRT ───────────────────────────────────────────
function animateTodayCounter(el,target,unit,dur=1200){
  const start=Date.now();
  const tick=()=>{
    const p=Math.min((Date.now()-start)/dur,1);
    const ease=1-Math.pow(1-p,3);
    const val=Math.round(target*ease);
    el.textContent=val.toLocaleString('de-DE')+unit;
    if(p<1) requestAnimationFrame(tick);
  };
  tick();
}

function updateTodayTime(){
  const el=document.getElementById('mc-today-time');
  const sub=document.getElementById('mc-today-sub');
  if(!el||!_archiveData) return;
  const now=new Date();
  const midnightTs=Math.floor(new Date(now.getFullYear(),now.getMonth(),now.getDate())/1000);
  let count=0;
  Object.keys(_archiveData).forEach(key=>{
    const ts=parseInt(key.split('_')[0]);
    if(ts>=midnightTs) count++;
  });
  const mins=count*3;
  if(mins<60){
    animateTodayCounter(el,Math.round(mins),' Min');
  } else {
    const h=Math.floor(mins/60);
    const m=Math.round(mins%60);
    animateTodayCounter(el,h,m>0?` Std ${m} Min`:' Std');
  }
  if(sub) sub.textContent=`${fmt(count)} Scrobbles heute`;
}

// ── DIVERSITY ──────────────────────────────────────────────
async function renderDiversity(){
  const [artistData, tagData] = await Promise.all([
    lfm('user.getTopArtists',{period:'overall',limit:50}),
    lfm('user.getTopTags',{limit:20})
  ]);
  const artists=artistData?.topartists?.artist||[];
  if(!artists.length){document.getElementById('diversity-content').innerHTML='<div class="err">Keine Daten</div>';return;}

  // HHI Score
  const total=artists.reduce((s,a)=>s+parseInt(a.playcount),0);
  const hhi=artists.reduce((s,a)=>{const sh=parseInt(a.playcount)/total;return s+sh*sh;},0);
  const score=Math.round((1-hhi)*100);
  const label=score>80?'Sehr vielseitig':score>60?'Vielseitig':score>40?'Ausgewogen':score>20?'Fokussiert':'Sehr fokussiert';

  // Tags/Genres — filter out noise tags
  const NOISE=['seen live','favorites','favourite','my favorites','love','loved','awesome','good','best','all','music','new'];
  const tags=(tagData?.toptags?.tag||[])
    .filter(t=>!NOISE.some(n=>t.name.toLowerCase().includes(n)))
    .slice(0,12);
  const maxTagCount=parseInt(tags[0]?.count)||1;

  // Summary sentence
  const top3Tags=tags.slice(0,3).map(t=>t.name);
  const mid3Tags=tags.slice(3,6).map(t=>t.name);
  let summary='';
  if(top3Tags.length){
    summary=`Du hörst hauptsächlich <strong>${top3Tags.join(', ')}</strong>`;
    if(mid3Tags.length) summary+=` — gelegentlich auch ${mid3Tags.join(', ')}`;
    summary+='.';
  }

  // Top-5 Karten bauen (erst mit Last.fm-Zahlen, dann Firebase nachladen)
  const top5=artists.slice(0,5);
  const maxPct=((parseInt(top5[0].playcount)/total)*100);

  function buildTop5Cards(firebaseCounts){
    const rankClass=['rank-1','rank-2','rank-3','',''];
    const rankNumClass=['r1','r2','r3','rn','rn'];
    return top5.map((a,i)=>{
      const pct=((parseInt(a.playcount)/total)*100).toFixed(1);
      const barW=((parseFloat(pct)/maxPct)*100).toFixed(1);
      const fbCount=firebaseCounts?firebaseCounts[a.name.toLowerCase()]:null;
      const playsStr=fbCount!=null
        ? `${Number(fbCount).toLocaleString('de-DE')} Titel gespielt`
        : `<span class="top5-loading"><span class="sp" style="width:9px;height:9px;border-width:1.5px;display:inline-block;vertical-align:middle;margin-right:4px;"></span>Lädt...</span>`;
      return `<div class="top5-card ${rankClass[i]}">
        <div class="top5-rank ${rankNumClass[i]}">${i+1}</div>
        <div class="top5-info">
          <div class="top5-name">${escapeHTML(a.name)}</div>
          <div class="top5-meta">${playsStr}</div>
        </div>
        <div class="top5-bar-wrap">
          <div class="top5-bar-c"><div class="top5-bar-f" style="width:${barW}%"></div></div>
          <div class="top5-pct">${pct}%</div>
        </div>
      </div>`;
    }).join('');
  }

  // Initial render mit Ladeindikator
  document.getElementById('diversity-content').innerHTML=`
    <div style="display:grid;grid-template-columns:auto 1fr;gap:20px;align-items:start;margin-bottom:20px;">
      <div class="mc hi" style="min-width:130px;">
        <div class="mc-label">Diversitäts-Score</div>
        <div class="mc-val pink">${score}/100</div>
        <div class="mc-sub">${label}</div>
      </div>
      <div style="padding-top:4px;">
        <div class="div-meter" style="margin-bottom:6px;"><div class="div-fill" style="width:${score}%"></div></div>
        <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:10px;">Herfindahl-Index · Top-50 Künstler</div>
        ${summary?`<div style="font-size:13px;color:var(--text2);line-height:1.6;">${summary}</div>`:''}
      </div>
    </div>
    ${tags.length?`
    <div style="margin-bottom:20px;">
      <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:8px;text-transform:uppercase;letter-spacing:.07em;">Genre-Verteilung</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        ${tags.map(t=>{
          const w=parseInt(t.count);
          const rel=Math.round((w/maxTagCount)*100);
          const size=rel>75?13:rel>40?12:11;
          const op=rel>75?1:rel>40?.8:.6;
          return `<span style="font-family:var(--mono);font-size:${size}px;padding:4px 10px;border-radius:20px;border:1px solid var(--border2);background:var(--bg3);color:var(--text);opacity:${op};transition:opacity .2s;" title="${w} Plays">${t.name}</span>`;
        }).join('')}
      </div>
    </div>`:''}
    <div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:10px;text-transform:uppercase;letter-spacing:.07em;">Top-5 Künstler-Anteil</div>
      <div class="top5-grid" id="top5-cards">${buildTop5Cards(null)}</div>
    </div>
  `;

  // Firebase-Daten nachladen und Plays aktualisieren
  try{
    const archiveSnap=await getArchiveData();
    if(archiveSnap){
      // Zähle Plays pro Künstler (case-insensitive)
      const firebaseCounts={};
      Object.values(archiveSnap).forEach(v=>{
        const a=(v.artist||'').trim().toLowerCase();
        if(!a) return;
        firebaseCounts[a]=(firebaseCounts[a]||0)+1;
      });
      // Cards mit echten Zahlen neu rendern
      const cardsEl=document.getElementById('top5-cards');
      if(cardsEl) cardsEl.innerHTML=buildTop5Cards(firebaseCounts);
    }
  }catch(e){console.warn('Firebase Top-5 Plays fetch failed:',e);}
}

// ── TOP CHARTS ─────────────────────────────────────────────
// Gibt den from-Timestamp (Unix Sekunden) für eine Periode zurück, oder null für "Gesamt"
function periodFromTs(period){
  const now=Date.now();
  if(period==='7day') return Math.floor((now-7*864e5)/1000);
  if(period==='1month'){const d=new Date();d.setMonth(d.getMonth()-1);return Math.floor(d/1000);}
  if(period==='3month'){const d=new Date();d.setMonth(d.getMonth()-3);return Math.floor(d/1000);}
  if(period==='6month'){const d=new Date();d.setMonth(d.getMonth()-6);return Math.floor(d/1000);}
  if(period==='12month'){const d=new Date();d.setFullYear(d.getFullYear()-1);return Math.floor(d/1000);}
  return null; // overall
}

// Berechnet Top-Charts aus Archive-Daten für eine gegebene Periode und Tab.
// data kann optional übergeben werden (z.B. frisch aus getArchiveData()) —
// dann ist die Funktion robust gegen State-Bugs wo _archiveData zwischenzeitlich
// auf null gesetzt wurde aber getArchiveData() trotzdem Daten liefern kann.
function calcChartsFromArchive(period,tab,data){
  const src=data||_archiveData;
  if(!src) return null;
  const fromTs=periodFromTs(period);
  const countMap={};
  Object.entries(src).forEach(([key,v])=>{
    const ts=parseInt(key.split('_')[0]);
    if(fromTs&&ts<fromTs) return;
    const artist=(v.artist||'').trim();
    const track=(v.track||'').trim();
    const album=(v.album||'').trim();
    let nameKey,displayName,artistName=artist;
    if(tab==='artists'){
      if(!artist) return;
      nameKey=artist.toLowerCase();
      displayName=artist;
    } else if(tab==='tracks'){
      if(!track) return;
      nameKey=artist.toLowerCase()+'|||'+track.toLowerCase();
      displayName=track;
    } else {
      if(!album) return;
      nameKey=artist.toLowerCase()+'|||'+album.toLowerCase();
      displayName=album;
    }
    if(!countMap[nameKey]){
      countMap[nameKey]={
        name:displayName,
        artist:{name:artistName},
        playcount:0,
        image:[{'#text':'',size:'medium'}],
        url:''
      };
    }
    countMap[nameKey].playcount++;
  });
  return Object.values(countMap).sort((a,b)=>b.playcount-a.playcount);
}

async function loadCharts(){
  const key=chartTab+'_'+chartPeriod;
  let items;
  // Cache-Hit nur bei NICHT-leerem Array akzeptieren —
  // ein leeres Array könnte ein altes Race-Condition-Artefakt aus localStorage sein
  const cached=cache['top_'+key];
  if(Array.isArray(cached)&&cached.length>0){items=cached;}
  else{
    document.getElementById('charts-list').innerHTML='<div class="ld"><div class="sp"></div> Lade...</div>';
    document.getElementById('show-more-btn').style.display='none';

    // Archiv-Daten AKTIV laden — statt passiv auf _archiveData zu pollen.
    // getArchiveData() ist idempotent (nutzt internes Promise), also egal wie oft es aufgerufen wird.
    const archData=await getArchiveData();

    if(chartPeriod==='yesterday'){
      // Gestern: Mitternacht gestern bis Mitternacht heute
      const now=new Date();
      const midnightToday=Math.floor(new Date(now.getFullYear(),now.getMonth(),now.getDate())/1000);
      const midnightYesterday=midnightToday-86400;
      const countMap={};
      if(_archiveData){
        Object.entries(_archiveData).forEach(([key,v])=>{
          const ts=parseInt(key.split('_')[0]);
          if(ts<midnightYesterday||ts>=midnightToday) return;
          const artist=(v.artist||'').trim();
          const track=(v.track||'').trim();
          const album=(v.album||'').trim();
          let nameKey,displayName,artistName=artist;
          if(chartTab==='artists'){if(!artist) return;nameKey=artist.toLowerCase();displayName=artist;}
          else if(chartTab==='tracks'){if(!track) return;nameKey=artist.toLowerCase()+'|||'+track.toLowerCase();displayName=track;}
          else{if(!album) return;nameKey=artist.toLowerCase()+'|||'+album.toLowerCase();displayName=album;}
          if(!countMap[nameKey]) countMap[nameKey]={name:displayName,artist:{name:artistName},playcount:0,image:[{'#text':'',size:'medium'}],url:''};
          countMap[nameKey].playcount++;
        });
      }
      items=Object.values(countMap).sort((a,b)=>b.playcount-a.playcount);

    } else if(chartPeriod==='today'){
      // Heute: aus Archiv berechnen + nur nowplaying-Track separat von API holen
      const now=new Date();
      const midnightTs=Math.floor(new Date(now.getFullYear(),now.getMonth(),now.getDate())/1000);

      // Archiv-Einträge von heute aggregieren
      const countMap={};
      if(_archiveData){
        Object.entries(_archiveData).forEach(([key,v])=>{
          const ts=parseInt(key.split('_')[0]);
          if(ts<midnightTs) return;
          const artist=(v.artist||'').trim();
          const track=(v.track||'').trim();
          const album=(v.album||'').trim();
          let nameKey,displayName,artistName=artist;
          if(chartTab==='artists'){
            if(!artist) return;
            nameKey=artist.toLowerCase(); displayName=artist;
          } else if(chartTab==='tracks'){
            if(!track) return;
            nameKey=artist.toLowerCase()+'|||'+track.toLowerCase(); displayName=track;
          } else {
            if(!album) return;
            nameKey=artist.toLowerCase()+'|||'+album.toLowerCase(); displayName=album;
          }
          if(!countMap[nameKey]) countMap[nameKey]={name:displayName,artist:{name:artistName},playcount:0,image:[{'#text':'',size:'medium'}],url:''};
          countMap[nameKey].playcount++;
        });
      }

      // Nur nowplaying-Track von API holen (1 einziger Call)
      try{
        const npD=await fetch(`${API}?method=user.getRecentTracks&user=${USER}&api_key=${KEY}&format=json&limit=1`).then(r=>r.json());
        const npT=npD?.recenttracks?.track?.[0];
        if(npT?.['@attr']?.nowplaying){
          const artist=(npT.artist?.['#text']||npT.artist?.name||'').trim();
          const track=(npT.name||'').trim();
          const album=(npT.album?.['#text']||'').trim();
          let nameKey,displayName,artistName=artist;
          if(chartTab==='artists'){nameKey=artist.toLowerCase();displayName=artist;}
          else if(chartTab==='tracks'){nameKey=artist.toLowerCase()+'|||'+track.toLowerCase();displayName=track;}
          else{nameKey=artist.toLowerCase()+'|||'+album.toLowerCase();displayName=album;}
          if(displayName){
            if(!countMap[nameKey]) countMap[nameKey]={name:displayName,artist:{name:artistName},playcount:0,image:[{'#text':'',size:'medium'}],url:''};
            countMap[nameKey].playcount++;
          }
        }
      }catch(e){}

      items=Object.values(countMap).sort((a,b)=>b.playcount-a.playcount);

    } else {
      // Alle anderen Perioden: aus Firebase-Archiv berechnen
      // archData direkt übergeben — robuster als über _archiveData global zu gehen
      items=calcChartsFromArchive(chartPeriod,chartTab,archData)||[];
    }
    // Cache nur setzen wenn Archiv-Daten wirklich verfügbar sind UND Ergebnis nicht leer —
    // sonst würde ein leeres Ergebnis aus einem Fehler permanent eingefroren.
    if(archData&&Array.isArray(items)&&items.length>0) cache['top_'+key]=items;
  }
  allItems=items;
  showCount=10;
  renderCharts();
}

function renderCharts(){
  const q=document.getElementById('chart-search').value.toLowerCase();
  let items=[...allItems].filter(i=>!q||i.name.toLowerCase().includes(q)||(i.artist?.name||'').toLowerCase().includes(q));
  if(sortMode==='alpha') items.sort((a,b)=>a.name.localeCompare(b.name));
  const max=parseInt(items[0]?.playcount)||1;
  const vis=items.slice(0,showCount);
  const html=vis.map((item,i)=>{
    const plays=parseInt(item.playcount)||0;
    const pct=Math.round((plays/max)*100);
    const name=escapeHTML(item.name);
    const sub=chartTab==='artists'?'':escapeHTML(item.artist?.name||'');
    const src=item.image?.find(x=>x.size==='medium')?.['#text']||item.image?.[1]?.['#text'];
    const href=item.url||`https://www.last.fm/user/${USER}`;
    const rc=rankCls(i);
    const rankCls2=i===0?'rank1':i===1?'rank2':i===2?'rank3 top3':i<5?'top3':'';
    if(chartTab==='artists'){
      return `<div class="ri ${rankCls2} fi" style="cursor:pointer;" data-artist="${name}">
        <span class="rn ${rc}">${i+1}</span>
        ${imgEl(src)}
        <div class="ri-info"><div class="ri-name">${name}</div></div>
        <div class="ri-right">
          <div class="bar-c"><div class="bar-f" style="width:0%" data-pct="${pct}"></div></div>
          <span class="plays">${fmt(plays)} ▶</span>
        </div>
      </div>`;
    }
    return `<a class="ri ${rankCls2} fi" href="${href}" target="_blank" rel="noopener">
      <span class="rn ${rc}">${i+1}</span>
      ${imgEl(src)}
      <div class="ri-info"><div class="ri-name">${name}</div>${sub?`<div class="ri-sub">${sub}</div>`:''}</div>
      <div class="ri-right">
        <div class="bar-c"><div class="bar-f" style="width:0%" data-pct="${pct}"></div></div>
        <span class="plays">${fmt(plays)} ▶</span>
      </div>
    </a>`;
  }).join('');
  document.getElementById('charts-list').innerHTML=html?`<div class="rlist">${html}</div>`:emptyState(q?'Keine Treffer für „'+escapeHTML(q)+'".':'Noch keine Daten für diesen Zeitraum.',q?'🔍':'🎵');
  document.getElementById('show-more-btn').style.display=items.length>showCount?'block':'none';
  // Event delegation for artist drill-down (replaces inline onclick with data attribute)
  document.getElementById('charts-list').querySelectorAll('[data-artist]').forEach(el=>{
    el.addEventListener('click',()=>openArtistDrillDown(el.dataset.artist));
  });
  // Animate bars from 0 to target
  requestAnimationFrame(()=>{
    document.querySelectorAll('#charts-list .bar-f[data-pct]').forEach(el=>{
      const pct=el.dataset.pct;
      setTimeout(()=>{el.style.width=pct+'%';},30);
    });
  });
}
function showMore(){
  const prev=showCount;showCount+=15;renderCharts();
  // Erste neu eingeblendete Zeile sanft in den Blick holen
  requestAnimationFrame(()=>{
    const rows=document.querySelectorAll('#charts-list .ri');
    if(rows[prev]) rows[prev].scrollIntoView({behavior:'smooth',block:'nearest'});
  });
}
// Entprellte Sucheingabe (vermeidet Re-Render bei jedem Tastendruck)
let _searchT=null;
function onSearchInput(){clearTimeout(_searchT);_searchT=setTimeout(renderCharts,180);}
function setSort(m){sortMode=m;document.getElementById('sb-plays').classList.toggle('active',m==='plays');document.getElementById('sb-alpha').classList.toggle('active',m==='alpha');renderCharts();}

// ── LIFETIME DATA (Firebase) ────────────────────────────────
function monthKey(y,m){return `${y}-${String(m+1).padStart(2,'0')}`;}

async function fbRead(){
  try{
    const snap=await db.ref('monthly').get();
    return snap.exists()?snap.val():{};
  }catch(e){console.warn('Firebase read error',e);return {};}
}

async function fbWrite(data){
  try{await db.ref('monthly').update(data);}
  catch(e){console.warn('Firebase write error',e);}
}

async function loadLifetimeData(startYear,silent=false){
  const progressEl=document.getElementById('lifetime-progress');
  const show=(msg)=>{if(!silent&&progressEl){progressEl.style.display='block';progressEl.textContent=msg;}};

  if(!silent) show('Firebase wird gelesen...');
  else showToast('🔄 DB wird geprüft...','',0);

  const existing=await fbRead();

  const now=new Date();
  const currentKey=monthKey(now.getFullYear(),now.getMonth());

  const allMonths=[];
  for(let y=startYear;y<=now.getFullYear();y++){
    const maxM=y===now.getFullYear()?now.getMonth():11;
    for(let m=0;m<=maxM;m++) allMonths.push({y,m,key:monthKey(y,m)});
  }

  const toFetch=allMonths.filter(({key})=>existing[key]===undefined||key===currentKey);

  if(toFetch.length===0){
    show('✓ Alle Daten aus Firebase geladen');
    if(!silent) setTimeout(()=>{progressEl.style.display='none';},2000);
    else showToast('✓ DB ist aktuell','ok');
    return allMonths.map(({key})=>({key,count:existing[key]||0}));
  }

  const isOnlyCurrentMonth=toFetch.length===1&&toFetch[0].key===currentKey;
  if(silent){
    showToast(isOnlyCurrentMonth?'🔄 Aktuellen Monat aktualisieren...':'🔄 '+toFetch.length+' Monate werden geladen...','',0);
  } else {
    show(`Lade ${toFetch.length} fehlende Monate von Last.fm...`);
  }

  const newData={};
  for(let i=0;i<toFetch.length;i++){
    const {y,m,key}=toFetch[i];
    const from=new Date(y,m,1);
    const to=new Date(y,m+1,0,23,59,59);
    try{
      const d=await lfm('user.getRecentTracks',{from:Math.floor(from/1000),to:Math.floor(to/1000),limit:1});
      newData[key]=parseInt(d?.recenttracks?.['@attr']?.total||0);
    }catch(e){newData[key]=0;}
    if(!silent) show(`Lade... ${i+1}/${toFetch.length} Monate`);
  }

  const merged={...existing,...newData};
  await fbWrite(newData);

  show('✓ Gespeichert in Firebase');
  if(!silent) setTimeout(()=>{progressEl.style.display='none';},2000);
  else showToast(isOnlyCurrentMonth?'✓ Aktueller Monat aktualisiert':'✓ '+toFetch.length+' Monate aktualisiert','ok');

  return allMonths.map(({key})=>({key,count:merged[key]||0}));
}

function renderLifetimeChart(monthData){
  const labels=monthData.map(({key})=>{
    const [y,m]=key.split('-');
    const d=new Date(parseInt(y),parseInt(m)-1,1);
    return d.toLocaleDateString('de-DE',{month:'short',year:'2-digit'});
  });
  const data=monthData.map(({count})=>count);
  const now=new Date();
  const currentKey=monthKey(now.getFullYear(),now.getMonth());

  if(monthlyInst) monthlyInst.destroy();
  const ctx=document.getElementById('monthlyChart');

  // Color: current month = pink, rest = dimmed. Group by year for subtle bands
  const bgColors=monthData.map(({key})=>{
    if(key===currentKey) return PINK;
    return 'rgba(214,24,122,0.3)';
  });

  const cc=chartColors();
  monthlyInst=new Chart(ctx,{
    type:'bar',
    data:{labels,datasets:[{
      label:'Scrobbles',data,
      backgroundColor:bgColors,
      borderRadius:2,borderWidth:0
    }]},
    options:{
      responsive:true,maintainAspectRatio:false,
      plugins:{
        legend:{display:false},
        tooltip:{...cc.tooltip,callbacks:{label:c=>' '+fmt(c.parsed.y)+' Scrobbles'}}
      },
      scales:{
        x:{
          ticks:{color:cc.tick,font:{family:'Space Mono',size:8},maxRotation:90,
            callback:(val,i)=>i%3===0?labels[i]:''},
          grid:{display:false},border:{display:false}
        },
        y:{
          ticks:{color:cc.tick,font:{family:'Space Mono',size:9},callback:v=>fmt(v)},
          grid:{color:cc.grid},border:{display:false}
        }
      }
    }
  });

  // Stats under chart
  const total=data.reduce((s,v)=>s+v,0);
  const best=Math.max(...data);
  const bestLabel=labels[data.indexOf(best)];
  const avg=Math.round(total/data.length);
  const statsEl=document.getElementById('lifetime-stats');
  if(statsEl){
    statsEl.innerHTML=`
      <div class="mc"><div class="mc-label">Lifetime Scrobbles</div><div class="mc-val">${fmt(total)}</div></div>
      <div class="mc"><div class="mc-label">Bester Monat</div><div class="mc-val" style="font-size:16px;">${bestLabel}</div><div class="mc-sub">${fmt(best)} Scrobbles</div></div>
      <div class="mc"><div class="mc-label">Ø pro Monat</div><div class="mc-val">${fmt(avg)}</div></div>
    `;
  }
}

// ── MONTHLY CHART ──────────────────────────────────────────
async function loadMonthly(loadId){
  const labels=[],ranges=[];
  for(let i=11;i>=0;i--){
    const d=new Date();d.setMonth(d.getMonth()-i);
    labels.push(d.toLocaleDateString('de-DE',{month:'short',year:'2-digit'}));
    const from=new Date(d.getFullYear(),d.getMonth(),1);
    const to=new Date(d.getFullYear(),d.getMonth()+1,0,23,59,59);
    ranges.push({from:Math.floor(from/1000),to:Math.floor(to/1000)});
  }
  const results=await Promise.all(ranges.map(r=>
    lfm('user.getRecentTracks',{from:r.from,to:r.to,limit:1})
      .then(d=>parseInt(d?.recenttracks?.['@attr']?.total||0)).catch(()=>0)
  ));
  if(loadId!==undefined&&loadId!==monthlyLoadId) return results;
  if(monthlyInst) monthlyInst.destroy();
  const ctx=document.getElementById('monthlyChart');
  const cc=chartColors();
  monthlyInst=new Chart(ctx,{
    type:'bar',data:{labels,datasets:[{label:'Scrobbles',data:results,
      backgroundColor:results.map((_,i)=>i===results.length-1?PINK:'rgba(214,24,122,0.35)'),
      borderRadius:3,borderWidth:0}]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{...cc.tooltip,callbacks:{label:c=>' '+fmt(c.parsed.y)+' Scrobbles'}}},
      scales:{x:{ticks:{color:cc.tick,font:{family:'Space Mono',size:9},maxRotation:45},grid:{display:false},border:{display:false}},
               y:{ticks:{color:cc.tick,font:{family:'Space Mono',size:9},callback:v=>fmt(v)},grid:{color:cc.grid},border:{display:false}}}}
  });
  return results;
}

// ── PIE CHART ──────────────────────────────────────────────
async function loadPie(){
  const d=await lfm('user.getTopArtists',{period:'overall',limit:8});
  const top=(d?.topartists?.artist||[]).slice(0,7);
  const total=top.reduce((s,a)=>s+parseInt(a.playcount),0);
  if(pieInst) pieInst.destroy();
  const cc=chartColors();
  pieInst=new Chart(document.getElementById('pieChart'),{
    type:'doughnut',
    data:{labels:top.map(a=>a.name),datasets:[{data:top.map(a=>parseInt(a.playcount)),backgroundColor:COLORS,borderColor:'#14102e',borderWidth:3,hoverOffset:6}]},
    options:{responsive:true,maintainAspectRatio:false,cutout:'62%',
      plugins:{legend:{display:false},tooltip:{...cc.tooltip,
        callbacks:{label:c=>{const pct=((c.parsed/total)*100).toFixed(1);return ` ${fmt(c.parsed)} Plays (${pct}%)`;}}}}}
  });
  document.getElementById('pie-legend').innerHTML=top.map((a,i)=>{
    const pct=((parseInt(a.playcount)/total)*100).toFixed(1);
    return `<span style="display:flex;align-items:center;gap:4px;font-family:var(--mono);font-size:10px;color:var(--text2);"><span style="width:9px;height:9px;border-radius:2px;background:${COLORS[i]};display:inline-block;flex-shrink:0;"></span>${a.name} ${pct}%</span>`;
  }).join('');
}

// ── ACTIVITY DATA (Weekday + Clock) ────────────────────────
// Lädt Aktivitäts-Daten für Wochentag und Tageszeit-Chart.
// Primär aus Firebase-Archiv (letzte 30 Tage) für repräsentative Verteilung,
// Fallback auf recent tracks falls Archiv nicht verfügbar.
async function loadActivityData(fallbackTracks){
  const now=Date.now();
  const days=30;
  const fromTs=Math.floor((now-days*86400*1000)/1000);
  const counts=new Array(7).fill(0); // Mo..So
  const hours=new Array(24).fill(0);
  let total=0;

  try{
    const snap=await db.ref('scrobbles').orderByKey()
      .startAt(String(fromTs))
      .get();
    if(snap.exists()){
      snap.forEach(child=>{
        const ts=parseInt(child.key.split('_')[0]);
        if(!ts||ts<fromTs) return;
        const d=new Date(ts*1000);
        const idx=(d.getDay()+6)%7; // Mo=0..So=6
        counts[idx]++;
        hours[d.getHours()]++;
        total++;
      });
      if(total>0){
        return {
          counts, hours, total,
          label:`Letzte ${days} Tage · ${fmt(total)} gesamt`
        };
      }
    }
  }catch(e){console.warn('Activity Firebase fallback:',e);}

  // Fallback: aus den übergebenen recent tracks aggregieren
  const tracks=fallbackTracks||[];
  tracks.forEach(t=>{
    if(t['@attr']?.nowplaying) return;
    const ts=parseInt(t.date?.uts);
    if(!ts) return;
    const d=new Date(ts*1000);
    counts[(d.getDay()+6)%7]++;
    hours[d.getHours()]++;
    total++;
  });
  return {
    counts, hours, total,
    label:`Letzte ${tracks.length} Scrobbles · ${fmt(total)} gesamt`
  };
}

// ── WEEKDAY ────────────────────────────────────────────────
// Accepts either an array of Last.fm tracks OR a pre-aggregated activity object
// {counts:[7], total, label} where counts is Mo-So order.
function renderWeekday(data){
  const days=['Mo','Di','Mi','Do','Fr','Sa','So'];
  let counts, total, subLabel;
  if(Array.isArray(data)){
    // Legacy path: array of tracks
    counts=new Array(7).fill(0);
    data.forEach(t=>{if(t['@attr']?.nowplaying)return;const ts=parseInt(t.date?.uts);if(ts){
      // getDay(): 0=So, 1=Mo, ..., 6=Sa → transform to Mo=0, ..., So=6
      const idx=(new Date(ts*1000).getDay()+6)%7;
      counts[idx]++;
    }});
    total=counts.reduce((s,v)=>s+v,0);
    subLabel=`letzte ${data.length} Scrobbles`;
  } else {
    counts=data.counts;
    total=data.total;
    const m=(data.label||'').match(/Letzte\s+[^·]+/i);
    subLabel=m?m[0].trim().toLowerCase():'Aktivität';
  }
  const subEl=document.getElementById('wd-sub');
  if(subEl) subEl.textContent=subLabel;
  const max=Math.max(...counts)||1;
  const topDay=days[counts.indexOf(max)];
  document.getElementById('wd-chart').innerHTML=`
    <div class="wd-bars" style="height:140px;align-items:flex-end;padding-bottom:0;gap:10px;">${counts.map((c,i)=>{
      const pct=total>0?Math.round((c/total)*100):0;
      const isMx=c===max&&c>0;
      const barH=c>0?Math.max(8,Math.round((c/max)*110)):3;
      return `<div class="wd-bw" style="gap:4px;">
        <div class="wd-c" style="opacity:${c>0?1:0.3};color:${isMx?'var(--pink2)':'var(--text2)'};">${c>0?pct+'%':'—'}</div>
        <div class="wd-b ${isMx?'mx':''}" style="height:${barH}px;opacity:${c===0?0.18:isMx?1:0.55};${isMx?'box-shadow:0 0 10px rgba(214,24,122,0.5);':''}border-radius:3px 3px 0 0;" title="${days[i]}: ${fmt(c)} Plays${c>0?' ('+pct+'%)':''}"></div>
        <div class="wd-l" style="opacity:${c===0?0.35:1};color:${isMx?'var(--pink2)':'var(--text3)'};">${days[i]}</div>
      </div>`;
    }).join('')}</div>
    <div style="display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:12px;">
      <span>${fmt(total)} Plays gesamt</span>
      ${max>0?`<span style="color:var(--pink2);">Peak: ${topDay} · ${fmt(max)} Plays</span>`:''}
    </div>
  `;
}

// ── HOUR BARS (Tageszeit-Verteilung) ──────────────────────
// Accepts either an array of Last.fm tracks OR a pre-aggregated activity object
// {hours:[24], total}
function renderClock(data){
  let hours, subLabel;
  if(Array.isArray(data)){
    hours=new Array(24).fill(0);
    data.forEach(t=>{if(t['@attr']?.nowplaying)return;const ts=parseInt(t.date?.uts);if(ts)hours[new Date(ts*1000).getHours()]++;});
    subLabel=`letzte ${data.length} Scrobbles`;
  } else {
    hours=data.hours;
    const m=(data.label||'').match(/Letzte\s+[^·]+/i);
    subLabel=m?m[0].trim().toLowerCase():'Aktivität';
  }
  const subEl=document.getElementById('clock-sub');
  if(subEl) subEl.textContent=subLabel;

  const total=hours.reduce((s,v)=>s+v,0);
  const max=Math.max(...hours)||1;
  const peakHour=hours.indexOf(max);

  // Welche Labels sichtbar? Immer 0,3,6,9,12,15,18,21 - das ist lesbar & informativ
  const labelVisible=new Set([0,3,6,9,12,15,18,21]);

  const bars=hours.map((c,i)=>{
    const pct=total>0?(c/total)*100:0;
    const pctDisp=Math.round(pct*10)/10;
    const isMx=c===max&&c>0;
    const barH=c>0?Math.max(6,Math.round((c/max)*110)):3;
    const showPct=isMx||(c>0&&pct>=5); // nur relevante Prozente zeigen
    const showLabel=labelVisible.has(i);
    return `<div class="wd-bw" data-hour="${i}" data-count="${c}" data-pct="${pctDisp}" style="gap:4px;cursor:pointer;">
      <div class="wd-c" style="opacity:${showPct?(isMx?1:0.85):0};color:${isMx?'var(--pink2)':'var(--text2)'};min-height:14px;">${showPct?Math.round(pct)+'%':''}</div>
      <div class="wd-b ${isMx?'mx':''}" style="height:${barH}px;opacity:${c===0?0.18:isMx?1:0.55};${isMx?'box-shadow:0 0 10px rgba(214,24,122,0.5);':''}border-radius:3px 3px 0 0;transition:opacity .15s;"></div>
      <div class="wd-l" style="opacity:${showLabel?(isMx?1:0.75):0.35};color:${isMx?'var(--pink2)':'var(--text3)'};">${showLabel?String(i).padStart(2,'0'):'·'}</div>
    </div>`;
  }).join('');

  document.getElementById('hour-chart').innerHTML=`
    <div class="wd-bars" id="hour-bars" style="height:140px;align-items:flex-end;padding-bottom:0;gap:4px;">${bars}</div>
    <div style="display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:12px;">
      <span>${fmt(total)} Plays gesamt</span>
      ${max>0?`<span style="color:var(--pink2);">Peak: ${String(peakHour).padStart(2,'0')}:00 · ${fmt(max)} Plays</span>`:''}
    </div>
  `;

  attachHourHover();
}

let _hourHoverAttached=false;
function attachHourHover(){
  if(_hourHoverAttached) return;
  _hourHoverAttached=true;
  const container=document.getElementById('hour-chart');
  const tooltip=document.getElementById('hour-tooltip');
  const glass=container.closest('.chart-glass');
  if(!container||!tooltip||!glass) return;

  container.addEventListener('mousemove',e=>{
    const bw=e.target.closest('.wd-bw');
    if(!bw){tooltip.style.opacity='0';return;}
    const hour=parseInt(bw.dataset.hour);
    const count=parseInt(bw.dataset.count);
    const pct=bw.dataset.pct;
    tooltip.innerHTML=`<span style="color:#f4c0d1;">${String(hour).padStart(2,'0')}:00 – ${String((hour+1)%24).padStart(2,'0')}:00</span><br>${fmt(count)} Plays · ${pct}%`;
    const glassRect=glass.getBoundingClientRect();
    const bwRect=bw.getBoundingClientRect();
    tooltip.style.left=(bwRect.left-glassRect.left+bwRect.width/2)+'px';
    tooltip.style.top=(bwRect.top-glassRect.top-8)+'px';
    tooltip.style.opacity='1';
    // Hover-Highlight
    bw.querySelector('.wd-b').style.opacity='1';
  });
  container.addEventListener('mouseleave',()=>{
    tooltip.style.opacity='0';
    // Alle Balken zurücksetzen auf Ursprungs-Opacity (via Re-Render durch inline style)
    container.querySelectorAll('.wd-bw').forEach(bw=>{
      const bar=bw.querySelector('.wd-b');
      const isMx=bar.classList.contains('mx');
      const count=parseInt(bw.dataset.count);
      bar.style.opacity=count===0?0.18:isMx?1:0.55;
    });
  });
  container.addEventListener('mouseout',e=>{
    const bw=e.target.closest('.wd-bw');
    if(!bw) return;
    // Beim Verlassen eines Balkens: zurücksetzen
    const bar=bw.querySelector('.wd-b');
    const isMx=bar.classList.contains('mx');
    const count=parseInt(bw.dataset.count);
    bar.style.opacity=count===0?0.18:isMx?1:0.55;
  });
}

// ── TAG×STUNDE-HEATMAP (7×24, aus Archiv) ──────────────────
// Additiv: nutzt getArchiveData(), berührt keine bestehende Render-Logik.
async function renderDayHourHeatmap(){
  const cont=document.getElementById('dayhour-chart');
  if(!cont) return;
  try{
    const data=await getArchiveData();
    if(!data){cont.innerHTML=emptyState('Noch kein Archiv geladen.','🗓'); return;}
    const days=['Mo','Di','Mi','Do','Fr','Sa','So'];
    const matrix=Array.from({length:7},()=>new Array(24).fill(0));
    let total=0,max=0,peakDay=0,peakHr=0;
    Object.keys(data).forEach(k=>{
      const ts=parseInt(k.split('_')[0]); if(!ts) return;
      const d=new Date(ts*1000);
      const day=(d.getDay()+6)%7, hr=d.getHours();
      const v=++matrix[day][hr]; total++;
      if(v>max){max=v;peakDay=day;peakHr=hr;}
    });
    if(!total){cont.innerHTML=emptyState('Noch keine Daten im Archiv.','🗓'); return;}
    const cell=(c)=>{
      if(!c) return 'rgba(255,255,255,0.04)';
      const p=c/max;
      if(p<0.25) return 'rgba(139,92,246,0.35)';
      if(p<0.5) return 'rgba(167,139,250,0.55)';
      if(p<0.75) return 'rgba(236,72,153,0.7)';
      return 'var(--pink)';
    };
    const hourLabels=[0,6,12,18];
    let grid='';
    for(let dd=0;dd<7;dd++){
      grid+=`<div class="dh-row"><div class="dh-day">${days[dd]}</div>`+
        matrix[dd].map((c,hh)=>`<div class="dh-cell" style="background:${cell(c)}" title="${days[dd]} ${String(hh).padStart(2,'0')}:00 · ${fmt(c)} Plays"></div>`).join('')+
        `</div>`;
    }
    grid+=`<div class="dh-row dh-axis"><div class="dh-day"></div>`+
      Array.from({length:24},(_,hh)=>`<div class="dh-cell dh-axis-lbl">${hourLabels.includes(hh)?String(hh).padStart(2,'0'):''}</div>`).join('')+`</div>`;
    cont.innerHTML=`<div class="dh-scroll"><div class="dh-grid">${grid}</div></div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:12px;">
        <span>${fmt(total)} Plays gesamt</span>
        <span style="color:var(--pink2);">Peak: ${days[peakDay]} ${String(peakHr).padStart(2,'0')}:00</span>
      </div>`;
  }catch(e){console.warn('DayHour-Heatmap fehlgeschlagen:',e); cont.innerHTML=emptyState('Heatmap konnte nicht geladen werden.','🗓');}
}

// ── YEAR-OVER-YEAR + Hochrechnung (aus Archiv) ─────────────
async function renderYoY(){
  const cont=document.getElementById('yoy-content');
  if(!cont) return;
  try{
    const data=await getArchiveData();
    if(!data){cont.innerHTML=emptyState('Noch kein Archiv geladen.','📅'); return;}
    const months=['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
    const byYear={};
    Object.keys(data).forEach(k=>{
      const ts=parseInt(k.split('_')[0]); if(!ts) return;
      const d=new Date(ts*1000), y=d.getFullYear();
      if(!byYear[y]) byYear[y]={total:0,months:new Array(12).fill(0)};
      byYear[y].total++; byYear[y].months[d.getMonth()]++;
    });
    const years=Object.keys(byYear).map(Number).sort((a,b)=>b-a);
    if(!years.length){cont.innerHTML=emptyState('Noch keine Daten im Archiv.','📅'); return;}
    const maxTotal=Math.max(...years.map(y=>byYear[y].total))||1;
    const nowY=new Date().getFullYear();
    let projHtml='';
    if(byYear[nowY]){
      const dayOfYear=Math.floor((Date.now()-new Date(nowY,0,1).getTime())/86400000)+1;
      const proj=Math.round(byYear[nowY].total/Math.max(dayOfYear,1)*365);
      const prev=byYear[nowY-1]?.total;
      const diff=prev?Math.round((proj-prev)/prev*100):null;
      projHtml=`<div class="yoy-proj">📈 Hochrechnung ${nowY}: <b>${fmt(proj)}</b> Scrobbles${diff!==null?` <span style="color:${diff>=0?'var(--ok)':'var(--bad)'};">(${diff>=0?'+':''}${diff}% vs ${nowY-1})</span>`:''}</div>`;
    }
    const rows=years.map(y=>{
      const info=byYear[y];
      const peakM=months[info.months.indexOf(Math.max(...info.months))];
      const prev=byYear[y-1]?.total;
      const diff=prev?Math.round((info.total-prev)/prev*100):null;
      const w=Math.round(info.total/maxTotal*100);
      return `<div class="yoy-row">
        <div class="yoy-year">${y}</div>
        <div class="yoy-bar-c"><div class="yoy-bar-f" style="width:${w}%"></div></div>
        <div class="yoy-val">${fmt(info.total)}</div>
        <div class="yoy-meta">${diff!==null?`<span style="color:${diff>=0?'var(--ok)':'var(--bad)'};">${diff>=0?'▲':'▼'} ${Math.abs(diff)}%</span> · `:''}Peak ${peakM}</div>
      </div>`;
    }).join('');
    cont.innerHTML=`${projHtml}<div class="yoy-list">${rows}</div>`;
  }catch(e){console.warn('YoY fehlgeschlagen:',e); cont.innerHTML=emptyState('Konnte Jahresvergleich nicht laden.','📅');}
}

// ── TREND CHART ────────────────────────────────────────────
async function loadTrend(){
  const topD=await lfm('user.getTopArtists',{period:'overall',limit:3});
  const top3=(topD?.topartists?.artist||[]).slice(0,3);
  if(!top3.length) return;

  const labels=[],ranges=[];
  for(let i=11;i>=0;i--){
    const d=new Date();d.setMonth(d.getMonth()-i);
    labels.push(d.toLocaleDateString('de-DE',{month:'short',year:'2-digit'}));
    const from=new Date(d.getFullYear(),d.getMonth(),1);
    const to=new Date(d.getFullYear(),d.getMonth()+1,0,23,59,59);
    ranges.push({from:Math.floor(from/1000),to:Math.floor(to/1000)});
  }

  const datasets=top3.map((artist,ai)=>({
    label:artist.name,data:new Array(12).fill(0),
    borderColor:COLORS[ai],backgroundColor:'transparent',
    borderWidth:2,tension:0.3,pointRadius:3,pointBackgroundColor:COLORS[ai]
  }));

  // Try Firebase archive first
  let usedArchive=false;
  try{
    const snap=await db.ref('scrobbles').orderByKey()
      .startAt(String(ranges[0].from))
      .get();
    if(snap.exists()){
      snap.forEach(child=>{
        const ts=parseInt(child.key.split('_')[0]);
        if(!ts)return;
        const mi=ranges.findIndex(r=>ts>=r.from&&ts<=r.to);
        if(mi<0)return;
        const artist=child.val()?.artist||'';
        top3.forEach((a,ai)=>{
          if(artist.toLowerCase()===a.name.toLowerCase()) datasets[ai].data[mi]++;
        });
      });
      usedArchive=true;
    }
  }catch(e){console.warn('Trend Firebase fallback:',e);}

  // Fallback: API calls in parallel
  if(!usedArchive){
    const monthResults=await Promise.all(ranges.map(r=>
      lfm('user.getRecentTracks',{from:r.from,to:r.to,limit:1000})
        .then(d=>d?.recenttracks?.track||[]).catch(()=>[])
    ));
    monthResults.forEach((tracks,mi)=>{
      const counts={};
      tracks.forEach(t=>{
        if(t['@attr']?.nowplaying)return;
        const n=t.artist?.['#text']||t.artist?.name;
        if(n){
          const key=n.toLowerCase();
          counts[key]=(counts[key]||0)+1;
        }
      });
      top3.forEach((a,ai)=>datasets[ai].data[mi]=counts[a.name.toLowerCase()]||0);
    });
  }

  if(trendInst) trendInst.destroy();
  const cc=chartColors();
  trendInst=new Chart(document.getElementById('trendChart'),{
    type:'line',data:{labels,datasets},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{...cc.tooltip,callbacks:{label:c=>` ${c.dataset.label}: ${fmt(c.parsed.y)}`}}},
      scales:{x:{ticks:{color:cc.tick,font:{family:'Space Mono',size:9},maxRotation:45},grid:{color:cc.grid},border:{display:false}},
               y:{ticks:{color:cc.tick,font:{family:'Space Mono',size:9}},grid:{color:cc.grid},border:{display:false}}}}
  });
  const leg=document.createElement('div');
  leg.style.cssText='display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;';
  leg.innerHTML=top3.map((a,i)=>`<span style="display:flex;align-items:center;gap:5px;font-family:var(--mono);font-size:10px;color:${COLORS[i]};"><span style="width:20px;height:2px;background:${COLORS[i]};display:inline-block;"></span>${escapeHTML(a.name)}</span>`).join('');
  document.getElementById('trendChart').parentElement.after(leg);
}

// ── CALENDAR HEATMAP ───────────────────────────────────────
async function loadCalendar(){
  const now=new Date();
  const yearAgo=new Date(now);yearAgo.setFullYear(now.getFullYear()-1);yearAgo.setDate(yearAgo.getDate()+1);
  const yearAgoTs=Math.floor(yearAgo/1000);
  const dayMap={};

  // Try Firebase archive first – only fetch keys (no value read needed)
  // Key format: {timestamp}_{artist}_{track}
  try{
    const calLoading=document.getElementById('cal-loading');
    calLoading.textContent='Lade aus Archiv...';
    const snap=await db.ref('scrobbles').orderByKey()
      .startAt(String(yearAgoTs))
      .get();
    if(snap.exists()){
      snap.forEach(child=>{
        const ts=parseInt(child.key.split('_')[0]);
        if(!ts||ts<yearAgoTs) return;
        const dd=new Date(ts*1000);
        const key=`${dd.getFullYear()}-${String(dd.getMonth()+1).padStart(2,'0')}-${String(dd.getDate()).padStart(2,'0')}`;
        dayMap[key]=(dayMap[key]||0)+1;
      });
      calLoading.textContent=`Archiv · ${Object.keys(dayMap).length} Tage`;
      setTimeout(()=>{calLoading.textContent='';},2000);
      renderCalendar(dayMap,yearAgo,now);
      return;
    }
  }catch(e){console.warn('Firebase calendar fallback:',e);}

  // Fallback: Last.fm API – fetch recent tracks in parallel batches
  document.getElementById('cal-loading').textContent='Lade via API...';
  try{
    const pages=5;
    const results=await Promise.all(
      Array.from({length:pages},(_,i)=>
        lfm('user.getRecentTracks',{limit:200,page:i+1}).catch(()=>null)
      )
    );
    results.forEach(d=>{
      (d?.recenttracks?.track||[]).forEach(t=>{
        if(t['@attr']?.nowplaying)return;
        const ts=parseInt(t.date?.uts);if(!ts||ts<yearAgoTs)return;
        const dd=new Date(ts*1000);
        const key=`${dd.getFullYear()}-${String(dd.getMonth()+1).padStart(2,'0')}-${String(dd.getDate()).padStart(2,'0')}`;
        dayMap[key]=(dayMap[key]||0)+1;
      });
    });
  }catch(e){console.warn('Calendar API fallback failed:',e);}
  document.getElementById('cal-loading').textContent='';
  renderCalendar(dayMap,yearAgo,now);
}

function renderCalendar(dayMap,start,end){
  const vals=Object.values(dayMap).filter(v=>v>0);
  const maxVal=vals.length?Math.max(...vals):1;
  // Build weeks
  let cur=new Date(start);
  // align to Sunday
  cur.setDate(cur.getDate()-cur.getDay());
  const weeks=[];let week=[];
  while(cur<=end||week.length>0){
    if(week.length===7){weeks.push(week);week=[];}
    const key=`${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`;
    const inRange=cur>=start&&cur<=end;
    const count=dayMap[key]||0;
    week.push({date:new Date(cur),count,inRange,key});
    cur.setDate(cur.getDate()+1);
    if(cur>end&&week.length===7){weeks.push(week);week=[];break;}
    if(cur>end&&week.length>0){while(week.length<7)week.push(null);weeks.push(week);break;}
  }
  // Month labels
  const monthLabels=[];
  let lastMonth=-1;
  weeks.forEach((w,wi)=>{
    const firstValid=w.find(d=>d&&d.inRange);
    if(firstValid&&firstValid.date.getMonth()!==lastMonth){
      lastMonth=firstValid.date.getMonth();
      monthLabels.push({wi,label:firstValid.date.toLocaleDateString('de-DE',{month:'short'})});
    }
  });
  const wdLabels=['So','Mo','Di','Mi','Do','Fr','Sa'];
  function getColor(count){
    if(!count) return 'var(--bg3)';
    const p=count/maxVal;
    if(p<0.25) return 'rgba(139,92,246,0.35)';
    if(p<0.5) return 'rgba(167,139,250,0.55)';
    if(p<0.75) return 'rgba(236,72,153,0.7)';
    return 'var(--pink)';
  }
  // Total active days
  const activeDays=vals.filter(v=>v>0).length;
  const totalScr=vals.reduce((s,v)=>s+v,0);
  document.getElementById('cal-container').innerHTML=`
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:4px;">
        <div class="mc" style="flex:1;min-width:120px;"><div class="mc-label">Aktive Tage</div><div class="mc-val">${fmt(activeDays)}</div></div>
        <div class="mc" style="flex:1;min-width:120px;"><div class="mc-label">Längster Tag</div><div class="mc-val">${fmt(maxVal)}</div><div class="mc-sub">Scrobbles</div></div>
        <div class="mc" style="flex:1;min-width:120px;"><div class="mc-label">Jahres-Total</div><div class="mc-val">${fmt(totalScr)}</div></div>
      </div>
      <div class="cal-wrap">
        <div style="display:flex;gap:3px;">
          <div style="display:flex;flex-direction:column;gap:3px;margin-right:4px;padding-top:16px;">${wdLabels.map((l,i)=>i%2===0?`<div class="cal-wday-label">${l}</div>`:'<div class="cal-wday-label"></div>').join('')}</div>
          <div style="display:flex;flex-direction:column;gap:0;">
            <div style="display:flex;gap:3px;height:14px;min-width:700px;">${weeks.map((w,wi)=>{const ml=monthLabels.find(m=>m.wi===wi);return `<div style="width:12px;font-family:var(--mono);font-size:8px;color:var(--text3);">${ml?ml.label:''}</div>`;}).join('')}</div>
            <div style="display:flex;gap:3px;min-width:700px;">${weeks.map(w=>`<div style="display:flex;flex-direction:column;gap:3px;">${w.map(d=>{if(!d)return '<div style="width:12px;height:12px;"></div>';const tip=d.key+': '+d.count+' Scrobbles';return `<div class="cal-day" style="background:${d.inRange?getColor(d.count):'transparent'}" data-tip="${tip}"></div>`;}).join('')}</div>`).join('')}</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ── STREAK ────────────────────────────────────────────────
async function loadStreak(){
  let daySet=new Set();
  let dataSource='API';

  // Firebase-Archiv bevorzugen wenn vorhanden — viel akkurater als nur 200 Tracks
  if(_archiveData){
    dataSource='Archiv';
    Object.keys(_archiveData).forEach(key=>{
      const ts=parseInt(key.split('_')[0]);if(!ts)return;
      const dd=new Date(ts*1000);
      daySet.add(`${dd.getFullYear()}-${String(dd.getMonth()+1).padStart(2,'0')}-${String(dd.getDate()).padStart(2,'0')}`);
    });
  } else {
    // Fallback: letzte 200 Scrobbles von Last.fm API
    try{
      const d=await lfm('user.getRecentTracks',{limit:200});
      const tracks=d?.recenttracks?.track||[];
      tracks.forEach(t=>{
        if(t['@attr']?.nowplaying)return;
        const ts=parseInt(t.date?.uts);if(!ts)return;
        const dd=new Date(ts*1000);
        daySet.add(`${dd.getFullYear()}-${String(dd.getMonth()+1).padStart(2,'0')}-${String(dd.getDate()).padStart(2,'0')}`);
      });
    }catch(e){}
  }

  // Streak: von heute rückwärts zählen
  let streak=0,d=new Date();
  // Wenn heute noch kein Scrobble: gestern als Startpunkt erlauben (häufiger Usecase)
  const todayKey=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  if(!daySet.has(todayKey)) d.setDate(d.getDate()-1); // gestern starten
  for(let i=0;i<3650;i++){
    const key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if(daySet.has(key)){streak++;d.setDate(d.getDate()-1);}
    else break;
  }

  const activeDays=daySet.size;
  const lastDay=[...daySet].sort().pop()||'—';
  const sourceNote=dataSource==='Archiv'
    ?`Streak & aktive Tage basieren auf dem vollständigen Archiv (${Number(Object.keys(_archiveData).length).toLocaleString('de-DE')} Scrobbles)`
    :`Streak basiert auf letzten 200 Scrobbles — für genaue Daten Archiv befüllen`;

  document.getElementById('streak-content').innerHTML=`
    <div class="metric-grid">
      <div class="mc hi"><div class="mc-label">Aktueller Streak</div><div class="mc-val pink">${streak}</div><div class="mc-sub">Tage in Folge</div></div>
      <div class="mc"><div class="mc-label">Aktive Tage ${dataSource==='Archiv'?'(Gesamt)':'(letzte 200)'}</div><div class="mc-val">${activeDays}</div><div class="mc-sub">Tage mit Scrobbles</div></div>
      <div class="mc"><div class="mc-label">Letzter Scrobble</div><div class="mc-val" style="font-size:14px;">${lastDay}</div></div>
    </div>
    <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:10px;">${sourceNote}</div>
  `;
}

// ── JAHRESRÜCKBLICK ────────────────────────────────────────
function buildYearSel(joinYear){
  const currentYear=new Date().getFullYear();
  const years=[];for(let y=currentYear;y>=joinYear;y--)years.push(y);
  selectedYear=currentYear;
  const sel=document.getElementById('year-sel');
  sel.innerHTML=years.map(y=>`<button class="pb ${y===currentYear?'active':''}" data-y="${y}">${y}</button>`).join('');
  sel.querySelectorAll('.pb').forEach(b=>b.addEventListener('click',()=>{
    sel.querySelectorAll('.pb').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    selectedYear=parseInt(b.dataset.y);
    loadYearReview(selectedYear);
  }));
}

async function loadYearReview(year){
  document.getElementById('year-content').innerHTML='<div class="ld"><div class="sp"></div> Lade Jahresrückblick...</div>';

  // Sicherstellen dass Archiv geladen ist
  if(!_archiveData) await getArchiveData();

  const artistMap={},trackMap={},albumMap={};
  let totalD=0;

  if(_archiveData){
    // Aus Firebase-Archiv rechnen — offline-fähig, schnell, konsistent mit allen anderen Sektionen
    Object.entries(_archiveData).forEach(([key,v])=>{
      const ts=parseInt(key.split('_')[0]);
      if(!ts) return;
      const d=new Date(ts*1000);
      if(d.getFullYear()!==year) return;
      totalD++;
      const artist=(v.artist||'').trim();
      const track=(v.track||'').trim();
      const album=(v.album||'').trim();
      if(artist){
        if(!artistMap[artist]) artistMap[artist]={name:artist,playcount:0,image:[{['#text']:''}],url:''};
        artistMap[artist].playcount++;
      }
      if(track&&artist){
        const k=artist+'|||'+track;
        if(!trackMap[k]) trackMap[k]={name:track,artist:{name:artist},playcount:0,image:[{['#text']:''}],url:''};
        trackMap[k].playcount++;
      }
      if(album&&artist){
        const k=artist+'|||'+album;
        if(!albumMap[k]) albumMap[k]={name:album,artist:{name:artist},playcount:0,image:[{['#text']:''}],url:''};
        albumMap[k].playcount++;
      }
    });
  } else {
    // Kein Archiv vorhanden — Fallback auf Last.fm API (wie bisher)
    const from=new Date(year,0,1),to=new Date(year,11,31,23,59,59);
    const fromTs=Math.floor(from/1000),toTs=Math.floor(to/1000);
    const totD=await lfmSafe('user.getRecentTracks',{from:fromTs,to:toTs,limit:1});
    totalD=parseInt(totD?.recenttracks?.['@attr']?.total||0);
    if(!totD){
      document.getElementById('year-content').innerHTML=`<div style="padding:20px;color:var(--text3);">Kein Archiv vorhanden und Last.fm nicht erreichbar. Bitte vollständigen Import starten.</div>`;
      return;
    }
    const totalPages=Math.min(Math.ceil(totalD/200),25);
    document.getElementById('year-content').innerHTML=`<div class="ld"><div class="sp"></div> Lade Tracks ${year} (0/${totalPages} Seiten)...</div>`;
    for(let page=1;page<=totalPages;page++){
      const d=await lfmSafe('user.getRecentTracks',{from:fromTs,to:toTs,limit:200,page});
      if(!d) break;
      const tracks=d?.recenttracks?.track||[];
      tracks.forEach(t=>{
        if(t['@attr']?.nowplaying)return;
        const artist=t.artist?.['#text']||t.artist?.name||'';
        const track=t.name||'';
        const album=t.album?.['#text']||'';
        const img=t.image?.find(x=>x.size==='medium')?.['#text']||t.image?.[1]?.['#text']||'';
        const url=t.url||'';
        if(artist){
          if(!artistMap[artist]) artistMap[artist]={name:artist,playcount:0,image:[{['#text']:img}],url};
          artistMap[artist].playcount++;
        }
        if(track&&artist){
          const k=artist+'|||'+track;
          if(!trackMap[k]) trackMap[k]={name:track,artist:{name:artist},playcount:0,image:[{['#text']:img}],url};
          trackMap[k].playcount++;
        }
        if(album&&artist){
          const k=artist+'|||'+album;
          if(!albumMap[k]) albumMap[k]={name:album,artist:{name:artist},playcount:0,image:[{['#text']:img}],url};
          albumMap[k].playcount++;
        }
      });
      document.getElementById('year-content').innerHTML=`<div class="ld"><div class="sp"></div> Lade Tracks ${year} (${page}/${totalPages} Seiten)...</div>`;
    }
  }

  const sortTop=(map)=>Object.values(map).sort((a,b)=>b.playcount-a.playcount).slice(0,5);
  const artists=sortTop(artistMap),tracks=sortTop(trackMap),albums=sortTop(albumMap);
  function miniList(items,tab){
    if(!items.length) return '<div style="color:var(--text3);font-size:12px;">Keine Daten</div>';
    return items.map((item,i)=>{
      const src=item.image?.find(x=>x.size==='medium')?.['#text']||item.image?.[1]?.['#text'];
      const sub=tab==='tracks'?escapeHTML(item.artist?.name||''):'';
      return `<div class="ri" style="padding:7px 10px;">
        <span class="rn ${rankCls(i)}">${i+1}</span>
        ${imgEl(src)}
        <div class="ri-info"><div class="ri-name">${escapeHTML(item.name)}</div>${sub?`<div class="ri-sub">${sub}</div>`:''}</div>
        <span class="plays">${fmt(parseInt(item.playcount||0))}</span>
      </div>`;
    }).join('');
  }
  document.getElementById('year-content').innerHTML=`
    <div class="mc hi" style="margin-bottom:20px;display:inline-block;min-width:200px;">
      <div class="mc-label">Gesamt ${year}</div>
      <div class="mc-val pink">${fmt(totalD)}</div>
      <div class="mc-sub">Scrobbles · ~${fmtTime(totalD*3)}</div>
    </div>
    <div class="g3">
      <div><div style="font-family:var(--mono);font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;">Top Künstler</div><div class="rlist">${miniList(artists,'artists')}</div></div>
      <div><div style="font-family:var(--mono);font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;">Top Tracks</div><div class="rlist">${miniList(tracks,'tracks')}</div></div>
      <div><div style="font-family:var(--mono);font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;">Top Alben</div><div class="rlist">${miniList(albums,'albums')}</div></div>
    </div>
  `;
}

// ── VERGLEICH ──────────────────────────────────────────────
async function loadCompare(){
  document.getElementById('compare-content').innerHTML='<div class="ld"><div class="sp"></div></div>';
  async function getSide(period){
    const [a,t,al]=await Promise.all([
      lfm('user.getTopArtists',{period,limit:5}).then(d=>d?.topartists?.artist||[]).catch(()=>[]),
      lfm('user.getTopTracks',{period,limit:5}).then(d=>d?.toptracks?.track||[]).catch(()=>[]),
      lfm('user.getTopAlbums',{period,limit:5}).then(d=>d?.topalbums?.album||[]).catch(()=>[])
    ]);
    return {artists:a,tracks:t,albums:al};
  }
  const [sideA,sideB]=await Promise.all([getSide(cmpA),getSide(cmpB)]);
  const periodLabel={'overall':'Gesamt','12month':'12 Monate','6month':'6 Monate','3month':'3 Monate','1month':'1 Monat','7day':'7 Tage'};
  const dupWarning=cmpA===cmpB?`<div style="font-family:var(--mono);font-size:11px;color:#f59e0b;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:8px;padding:8px 12px;margin-bottom:14px;">⚠ Beide Zeiträume sind identisch (${periodLabel[cmpA]}) — der Vergleich zeigt dieselben Daten.</div>`:'';
  function renderSide(side,label){
    return `<div class="cmp-side">
      <div class="cmp-title">${label}</div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Top Künstler</div>
      <div class="rlist" style="margin-bottom:14px;">${side.artists.slice(0,5).map((a,i)=>`<div class="ri" style="padding:6px 10px;"><span class="rn ${rankCls(i)}">${i+1}</span>${imgEl(a.image?.find(x=>x.size==='medium')?.['#text']||a.image?.[1]?.['#text'])}<div class="ri-info"><div class="ri-name">${escapeHTML(a.name)}</div></div><span class="plays">${fmt(parseInt(a.playcount||0))}</span></div>`).join('')}</div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Top Tracks</div>
      <div class="rlist">${side.tracks.slice(0,5).map((t,i)=>`<div class="ri" style="padding:6px 10px;"><span class="rn ${rankCls(i)}">${i+1}</span>${imgEl(t.image?.find(x=>x.size==='medium')?.['#text']||t.image?.[1]?.['#text'])}<div class="ri-info"><div class="ri-name">${escapeHTML(t.name)}</div><div class="ri-sub">${escapeHTML(t.artist?.name||'')}</div></div><span class="plays">${fmt(parseInt(t.playcount||0))}</span></div>`).join('')}</div>
    </div>`;
  }
  document.getElementById('compare-content').innerHTML=`${dupWarning}<div class="cmp-grid">${renderSide(sideA,periodLabel[cmpA])}${renderSide(sideB,periodLabel[cmpB])}</div>`;
}

// ── RECENT ─────────────────────────────────────────────────
async function loadRecent(){
  const RECENT_LIMIT=200;
  const d=await lfm('user.getRecentTracks',{limit:RECENT_LIMIT,extended:1});
  const tracks=d?.recenttracks?.track||[];
  const total=d?.recenttracks?.['@attr']?.total;
  if(total) document.getElementById('recent-total').textContent=fmt(total)+' gesamt';
  // Nur die ersten 30 in der UI anzeigen, alle 200 für Wochentag/Uhrzeit-Analyse nutzen
  const displayTracks=tracks.slice(0,30);
  const html=displayTracks.map(t=>{
    const isNow=t['@attr']?.nowplaying;
    const src=t.image?.find(x=>x.size==='medium')?.['#text']||t.image?.[1]?.['#text'];
    const imgE=src?`<img src="${src}" class="rec-img" alt="" loading="lazy" decoding="async">`:`<div class="rec-img" style="display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:12px;">♪</div>`;
    const timeE=isNow?`<span class="np-badge">live</span>`:`<span class="rec-time">${timeAgo(t.date?.uts)}</span>`;
    const loved=t.loved==='1'?`<span style="color:var(--pink);font-size:11px;margin-left:3px;">♥</span>`:'';
    const href=t.url||`https://www.last.fm/music/${encodeURIComponent(t.artist?.name||t.artist?.['#text']||'')}/_/${encodeURIComponent(t.name||'')}`;
    return `<a class="rec-item" href="${href}" target="_blank" rel="noopener">${imgE}<div class="rec-info"><div class="rec-name">${escapeHTML(t.name)}${loved}</div><div class="rec-art">${escapeHTML(t.artist?.name||t.artist?.['#text']||'')}${t.album?.['#text']?' · '+escapeHTML(t.album['#text']):''}</div></div>${timeE}</a>`;
  }).join('');
  document.getElementById('recent-list').innerHTML=`<div class="rec-list">${html}</div>`;
  return tracks;
}

// ── LOVED ──────────────────────────────────────────────────
async function loadLoved(){
  const d=await lfm('user.getLovedTracks',{limit:10});
  const tracks=d?.lovedtracks?.track||[];
  const total=d?.lovedtracks?.['@attr']?.total;
  if(total) document.getElementById('loved-total').textContent=fmt(total)+' gesamt';
  if(!tracks.length){document.getElementById('loved-list').innerHTML='<div style="color:var(--text3);font-size:13px;">Keine Loved Tracks.</div>';return;}
  const html=tracks.map((t,i)=>{
    const src=t.image?.find(x=>x.size==='medium')?.['#text']||t.image?.[1]?.['#text'];
    const href=t.url||'#';
    return `<a class="ri" href="${href}" target="_blank" rel="noopener"><span class="rn ${rankCls(i)}">${i+1}</span>${imgEl(src)}<div class="ri-info"><div class="ri-name">${escapeHTML(t.name)}</div><div class="ri-sub">${escapeHTML(t.artist?.name||'')}</div></div><span style="color:var(--pink);">♥</span></a>`;
  }).join('');
  document.getElementById('loved-list').innerHTML=`<div class="rlist">${html}</div>`;
}

// ── TAGS ───────────────────────────────────────────────────
async function loadTags(){
  const d=await lfm('user.getTopTags',{limit:40});
  const tags=d?.toptags?.tag||[];
  if(!tags.length){document.getElementById('tags-content').innerHTML='<div style="color:var(--text3);">Keine Tags.</div>';return;}
  document.getElementById('tags-content').innerHTML=`<div class="tags-wrap">${tags.map((t,i)=>`<span class="tag ${i<6?'lg':''}" title="${fmt(t.count)} Gewichtung">${escapeHTML(t.name)}</span>`).join('')}</div>`;
}

// ── EXPORT PNG ─────────────────────────────────────────────
async function exportPNG(){
  const btn=document.querySelector('.export-btn');
  btn.textContent='Wird erstellt...';btn.disabled=true;
  try{
    const canvas=await html2canvas(document.getElementById('hero-section'),{backgroundColor:'#090909',scale:2});
    const a=document.createElement('a');
    a.href=canvas.toDataURL('image/png');
    a.download='s1r1us-a-stats.png';
    a.click();
  }catch(e){alert('Export fehlgeschlagen');}
  btn.textContent='↓ Export PNG';btn.disabled=false;
}

// ── CHARTS TRACK COUNT (Firebase) ─────────────────────────
let _chartCountCache={};

async function updateChartsTrackCount(){
  const el=document.getElementById('charts-track-count');
  if(!el) return;

  const now=new Date();
  let fromTsSec=0,label='';
  if(chartPeriod==='yesterday'){
    const midnightToday=new Date(now.getFullYear(),now.getMonth(),now.getDate());
    const midnightYesterday=new Date(midnightToday);midnightYesterday.setDate(midnightYesterday.getDate()-1);
    fromTsSec=Math.floor(midnightYesterday.getTime()/1000);
    const toTsSec=Math.floor(midnightToday.getTime()/1000);
    label='Gestern';
    delete _chartCountCache['yesterday'];
    // Für gestern brauchen wir einen separaten Zähler mit To-Ts
    const src=_archiveData;
    if(!src){el.style.display='none';return;}
    let count=0;
    Object.keys(src).forEach(k=>{const ts=parseInt(k.split('_')[0]);if(ts>=fromTsSec&&ts<toTsSec)count++;});
    el.textContent=`${count.toLocaleString('de-DE')} Scrobbles ${label}`;
    el.style.display='';
    return;
  } else if(chartPeriod==='today'){
    const midnight=new Date(now.getFullYear(),now.getMonth(),now.getDate());
    fromTsSec=Math.floor(midnight.getTime()/1000);
    label='Heute';
    delete _chartCountCache['today']; // immer frisch
  } else if(chartPeriod==='7day'){
    fromTsSec=Math.floor((Date.now()-7*864e5)/1000);
    label='7 Tage';
  } else if(chartPeriod==='1month'){
    const d=new Date(now);d.setMonth(d.getMonth()-1);fromTsSec=Math.floor(d.getTime()/1000);
    label='1 Monat';
  } else if(chartPeriod==='3month'){
    const d=new Date(now);d.setMonth(d.getMonth()-3);fromTsSec=Math.floor(d.getTime()/1000);
    label='3 Monate';
  } else if(chartPeriod==='6month'){
    const d=new Date(now);d.setMonth(d.getMonth()-6);fromTsSec=Math.floor(d.getTime()/1000);
    label='6 Monate';
  } else if(chartPeriod==='12month'){
    const d=new Date(now);d.setMonth(d.getMonth()-12);fromTsSec=Math.floor(d.getTime()/1000);
    label='12 Monate';
  } else if(chartPeriod==='overall'){
    fromTsSec=0;
    label='Gesamt';
  } else {
    el.style.display='none';
    return;
  }

  if(_chartCountCache[chartPeriod]!=null){
    el.textContent=`${Number(_chartCountCache[chartPeriod]).toLocaleString('de-DE')} Scrobbles · ${label}`;
    el.style.display='block';
    return;
  }

  el.textContent='…';
  el.style.display='block';

  try{
    let count=0;
    // Gecachte Archiv-Daten nutzen wenn bereits geladen – spart Firebase-Read
    const archData=await getArchiveData();
    if(!archData){el.style.display='none';return;}
    Object.keys(archData).forEach(key=>{
      const tsSec=parseInt(key.split('_')[0]);
      if(tsSec>=fromTsSec) count++;
    });
    _chartCountCache[chartPeriod]=count;
    el.textContent=`${Number(count).toLocaleString('de-DE')} Scrobbles · ${label}`;
    el.style.display='block';
  }catch(e){
    el.style.display='none';
  }
}

// ── EVENT LISTENERS ────────────────────────────────────────
document.getElementById('monthly-mode-tabs').querySelectorAll('.pb').forEach(b=>b.addEventListener('click',async()=>{
  document.getElementById('monthly-mode-tabs').querySelectorAll('.pb').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  monthlyMode=b.dataset.m;
  const myId=++monthlyLoadId;
  const statsEl=document.getElementById('lifetime-stats');
  if(monthlyMode==='lifetime'){
    document.getElementById('monthly-chart-label').textContent='Scrobbles Lifetime';
    statsEl.style.display='grid';
    if(joinYear){
      const data=await loadLifetimeData(joinYear);
      if(myId!==monthlyLoadId) return;
      renderLifetimeChart(data);
    }
  } else {
    document.getElementById('monthly-chart-label').textContent='Scrobbles pro Monat (12 Monate)';
    statsEl.style.display='none';
    document.getElementById('lifetime-progress').style.display='none';
    await loadMonthly(myId);
  }
}));

document.getElementById('chart-periods').querySelectorAll('.pb').forEach(b=>b.addEventListener('click',()=>{
  document.getElementById('chart-periods').querySelectorAll('.pb').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  const prev=chartPeriod;
  chartPeriod=b.dataset.p;
  // Cache für neue Periode löschen falls _archiveData zwischenzeitlich aktualisiert wurde
  if(prev!==chartPeriod) delete _chartCountCache[chartPeriod];
  showCount=10;
  // updateChartsTrackCount zuerst — triggert getArchiveData() und zeigt Badge-Count sofort an
  updateChartsTrackCount();
  loadCharts();
}));
document.querySelectorAll('.ctab').forEach(t=>t.addEventListener('click',()=>{
  document.querySelectorAll('.ctab').forEach(x=>x.classList.remove('active'));
  t.classList.add('active');chartTab=t.dataset.t;showCount=10;loadCharts();
}));
document.getElementById('cmp-a-tabs').querySelectorAll('.pb').forEach(b=>b.addEventListener('click',()=>{
  document.getElementById('cmp-a-tabs').querySelectorAll('.pb').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');cmpA=b.dataset.p;loadCompare();
}));
document.getElementById('cmp-b-tabs').querySelectorAll('.pb').forEach(b=>b.addEventListener('click',()=>{
  document.getElementById('cmp-b-tabs').querySelectorAll('.pb').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');cmpB=b.dataset.p;loadCompare();
}));

// ── SCROBBLE ARCHIVE ───────────────────────────────────────
let _importAborted=false;
const IMPORT_DELAY=100;    // ms zwischen API-Seiten (bei ~200ms Fetch-Zeit + 100ms Pause = ~3 req/s, safe unter Last.fms 5 req/s Limit)
const RETRY_MAX=3;         // max Wiederholungen pro Seite
const RETRY_DELAY=4000;    // ms Pause vor einem Retry

function openArchiveModal(){
  const m=document.getElementById('archive-modal');
  m.style.opacity='1';m.style.pointerEvents='all';m.classList.add('open');
  loadArchiveStatus();
}
function closeArchiveModal(){
  const m=document.getElementById('archive-modal');
  m.style.opacity='0';m.style.pointerEvents='none';m.classList.remove('open');
}
document.getElementById('archive-modal').addEventListener('click',function(e){
  if(e.target===this) closeArchiveModal();
});

async function getLatestArchivedTs(){
  try{
    const snap=await db.ref('scrobbles').orderByKey().limitToLast(1).get();
    if(!snap.exists()) return null;
    const key=Object.keys(snap.val())[0];
    // Key format: <timestamp>_<artistslug>_<trackslug> — extract timestamp part
    return parseInt(key.split('_')[0]);
  }catch(e){return null;}
}

async function getArchiveCount(){
  try{
    const snap=await db.ref('scrobble_meta/count').get();
    return snap.exists()?snap.val():null;
  }catch(e){return null;}
}

// Zählt die echten Keys in Firebase (langsamer, nur nach Import nutzen)
async function getRealArchiveCount(){
  try{
    const snap=await db.ref('scrobbles').get();
    return snap.exists()?Object.keys(snap.val()).length:0;
  }catch(e){return 0;}
}

// ── USER META CACHE (Hero-Daten) ──────────────────────────
// Cached user.getInfo → in Firebase damit Avatar/Country/Registrierung auch
// bei Last.fm-Ausfall verfügbar sind.
async function getCachedUserMeta(){
  try{
    const snap=await db.ref('user_meta').get();
    return snap.exists()?snap.val():null;
  }catch(e){return null;}
}

async function cacheUserMeta(u){
  try{
    const img=u.image?.find(x=>x.size==='extralarge')?.['#text']||u.image?.[2]?.['#text']||'';
    await db.ref('user_meta').set({
      realname:u.realname||'',
      country:u.country&&u.country!=='None'?u.country:'',
      registered_uts:parseInt(u.registered?.unixtime)||0,
      avatar_url:img,
      playcount:parseInt(u.playcount)||0,
      artist_count:parseInt(u.artist_count)||0,
      track_count:parseInt(u.track_count)||0,
      album_count:parseInt(u.album_count)||0,
      last_fetched:Date.now()
    });
  }catch(e){console.warn('cacheUserMeta failed:',e);}
}

// ── ARCHIV-AGGREGATIONEN (Offline-fähig) ──────────────────
// Unique Artists/Tracks/Albums aus _archiveData zählen.
function getArchiveDiscoveryCounts(){
  if(!_archiveData) return null;
  const artists=new Set(),tracks=new Set(),albums=new Set();
  Object.values(_archiveData).forEach(v=>{
    const a=(v.artist||'').trim().toLowerCase();
    const t=(v.track||'').trim().toLowerCase();
    const al=(v.album||'').trim().toLowerCase();
    if(a) artists.add(a);
    if(a&&t) tracks.add(a+'|||'+t);
    if(a&&al) albums.add(a+'|||'+al);
  });
  return {
    artist_count:artists.size,
    track_count:tracks.size,
    album_count:albums.size
  };
}

async function loadArchiveStatus(){
  const statusEl=document.getElementById('archive-status');
  statusEl.textContent='Prüfe Firebase-Archiv...';
  const [latestTs,count]=await Promise.all([getLatestArchivedTs(),getArchiveCount()]);
  if(!latestTs){
    statusEl.innerHTML=`<span style="color:var(--text3);">Noch kein Archiv vorhanden.</span><br>Starte den vollständigen Import um alle Scrobbles zu sichern.`;
  } else {
    const date=new Date(latestTs*1000).toLocaleString('de-DE',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
    const countStr=count!==null?`<br><span style="color:var(--pink2);font-size:13px;font-weight:700;">${Number(count).toLocaleString('de-DE')}</span> <span style="color:var(--text2);">Scrobbles gespeichert</span>`:'';
    statusEl.innerHTML=`Letzter Eintrag: <span style="color:var(--pink);">${date}</span>${countStr}`;
  }
}

// Fetch mit Retry
async function fetchScrobblePage(from,to,page,limit=200){
  const url=new URL(API);
  const params={method:'user.getRecentTracks',user:USER,api_key:KEY,format:'json',limit,page,extended:0};
  if(from) params.from=from;
  if(to) params.to=to;
  Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,v));

  let lastErr;
  for(let attempt=1;attempt<=RETRY_MAX;attempt++){
    let retryAfterMs=null; // bei 429 vom Server vorgegebene Wartezeit
    try{
      const r=await fetch(url);
      if(!r.ok){
        // 429 = Rate-Limit: deutlich länger warten als bei einem 5xx, möglichst
        // exakt so lange wie der Server via Retry-After-Header vorgibt.
        if(r.status===429){
          const ra=parseInt(r.headers.get('Retry-After'));
          // Ohne Header exponentiell hochgehen: 4s, 8s, 16s ...
          retryAfterMs=Number.isFinite(ra)?ra*1000:RETRY_DELAY*Math.pow(2,attempt-1);
        }
        throw new Error('HTTP '+r.status);
      }
      const d=await r.json();
      if(d?.error) throw new Error('Last.fm: '+d.message);
      return d;
    }catch(e){
      lastErr=e;
      if(_importAborted) throw e;
      if(attempt<RETRY_MAX){
        const waitMs=retryAfterMs||RETRY_DELAY;
        const note=retryAfterMs?' (Rate-Limit)':'';
        updateProgressTxt(`⚠ Fehler${note} (Versuch ${attempt}/${RETRY_MAX}): ${e.message} — warte ${Math.round(waitMs/1000)}s...`);
        await new Promise(r=>setTimeout(r,waitMs));
      }
    }
  }
  throw lastErr;
}

function setArchiveBusy(busy){
  document.getElementById('archive-import-btn').style.display=busy?'none':'inline-block';
  document.getElementById('archive-delta-btn').style.display=busy?'none':'inline-block';
  const gapBtn=document.getElementById('archive-gapfill-btn');
  if(gapBtn) gapBtn.style.display=busy?'none':'inline-block';
  document.getElementById('archive-abort-btn').style.display=busy?'inline-block':'none';
  document.getElementById('archive-progress-wrap').style.display=busy?'block':'none';
  if(!busy){
    document.getElementById('archive-progress-bar').style.width='0%';
    document.getElementById('archive-progress-txt').textContent='';
  }
}

function updateProgressTxt(txt){
  document.getElementById('archive-progress-txt').textContent=txt;
}
function updateProgressBar(pct){
  document.getElementById('archive-progress-bar').style.width=pct+'%';
}

// Kanonischer Fingerprint eines Scrobbles — identisch zu makeScrobbleKey
// aber OHNE den seq-Teil. Dient zum Vergleich "ist dieser Scrobble schon da?"
// unabhängig davon, an welcher Pagination-Position er ursprünglich importiert wurde.
function canonicalScrobbleId(ts,artist,track){
  const slug=s=>s.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,20)||'x';
  const hashStr=s=>{let h=0;for(let i=0;i<s.length;i++){h=(Math.imul(31,h)+s.charCodeAt(i))|0;}return Math.abs(h).toString(36);};
  const combined=artist.toLowerCase()+'|'+track.toLowerCase();
  return `${ts}_${slug(artist)}_${slug(track)}_${hashStr(combined)}`;
}

// Extrahiert den kanonischen Teil aus einem bestehenden Scrobble-Key (strippt seq-Suffix).
function keyToCanonical(key){
  const idx=key.lastIndexOf('_');
  return idx>0?key.substring(0,idx):key;
}

function makeScrobbleKey(ts,artist,track,seq){
  // Timestamp + gekürzte Slugs + Hash + Sequenznummer → garantiert kollisionsfrei
  const seqPart=String(seq||0).padStart(4,'0');
  return `${canonicalScrobbleId(ts,artist,track)}_${seqPart}`;
}

// Firebase multi-path update mit Retry-Logik.
// Schützt gegen transiente Netzwerkfehler die sonst stumm Pagen beim Import fressen würden.
async function fbUpdateWithRetry(updates,maxAttempts=3){
  let lastErr;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{
      await db.ref('/').update(updates);
      return;
    }catch(e){
      lastErr=e;
      if(attempt<maxAttempts){
        const wait=1000*attempt; // 1s, 2s, 3s linear Backoff
        console.warn(`Firebase write failed (Versuch ${attempt}/${maxAttempts}): ${e.message} — retry in ${wait/1000}s`);
        await new Promise(r=>setTimeout(r,wait));
      }
    }
  }
  throw lastErr;
}

async function writeBatch(tracks,pageOffset=0){
  if(!tracks.length) return 0;
  const updates={};
  let count=0;
  tracks.forEach((t,idx)=>{
    if(t['@attr']?.nowplaying) return;
    const ts=parseInt(t.date?.uts);
    if(!ts) return;
    const artist=t.artist?.['#text']||t.artist?.name||'';
    const track=t.name||'';
    const key=makeScrobbleKey(ts,artist,track,pageOffset+idx);
    updates[`scrobbles/${key}`]={artist,track,album:t.album?.['#text']||''};
    count++;
  });
  if(Object.keys(updates).length) await fbUpdateWithRetry(updates);
  return count;
}

async function startFullImport(){
  // Bestätigung wenn bereits ein Archiv vorhanden
  const existingTs=await getLatestArchivedTs();
  if(existingTs){
    const count=await getArchiveCount();
    const countStr=count?` (${Number(count).toLocaleString('de-DE')} Scrobbles)`:'';
    const confirmed=confirm(
      `⚠ Es existiert bereits ein Archiv${countStr}.\n\nEin vollständiger Import löscht alle gespeicherten Daten und beginnt von vorne.\n\nFür neue Tracks nutze stattdessen "Delta-Sync".\n\nWirklich neu importieren?`
    );
    if(!confirmed) return;
  }

  _importAborted=false;
  setArchiveBusy(true);
  const statusEl=document.getElementById('archive-status');

  try{
    // Alte scrobbles löschen für sauberen Neustart
    statusEl.innerHTML='🗑 Lösche altes Archiv...';
    updateProgressTxt('Altes Archiv wird entfernt...');
    await db.ref('scrobbles').remove();
    await db.ref('scrobble_meta').remove();

    statusEl.textContent='Ermittle Gesamtanzahl von Last.fm...';
    const first=await fetchScrobblePage(null,null,1,1);
    const totalPages=parseInt(first?.recenttracks?.['@attr']?.totalPages||1);
    const totalTracks=parseInt(first?.recenttracks?.['@attr']?.total||0);

    let done=0,savedCount=0,failedPages=0;
    statusEl.innerHTML=`Importiere <span style="color:var(--pink);">${Number(totalTracks).toLocaleString('de-DE')}</span> Scrobbles über ${totalPages} Seiten...`;

    const eta=makeETATracker();
    const writePromises=[];
    for(let page=1;page<=totalPages;page++){
      if(_importAborted) break;

      const d=await fetchScrobblePage(null,null,page,200);
      const tracks=d?.recenttracks?.track||[];
      // Write im Hintergrund starten — nicht awaiten. Fetch der nächsten Seite
      // läuft damit parallel zum Firebase-Write der aktuellen.
      // .catch() macht endgültig fehlgeschlagene Writes sichtbar statt sie zu verschlucken.
      writePromises.push(
        writeBatch(tracks,(page-1)*200).then(n=>{savedCount+=n;return n;}).catch(()=>{failedPages++;})
      );
      done++;

      // Progress 0-90% für Fetches, 90-100% reserviert für finale Write-Phase
      const pct=Math.round((done/totalPages)*90);
      updateProgressBar(pct);
      updateProgressTxt(
        `${pct}% — Seite ${done}/${totalPages} geladen — `+
        `${Number(savedCount).toLocaleString('de-DE')}/${Number(totalTracks).toLocaleString('de-DE')} — ${eta.label(pct)}`
      );

      await new Promise(r=>setTimeout(r,IMPORT_DELAY));
    }

    // Auf alle noch laufenden Firebase-Writes warten
    if(!_importAborted){
      updateProgressTxt(`Finalisiere ${writePromises.length} Firebase-Writes... · ${eta.fmtElapsed()} gesamt`);
      await Promise.all(writePromises);
    }

    if(!_importAborted){
      const realCount=await getRealArchiveCount();
      await db.ref('scrobble_meta/count').set(realCount);
      await db.ref('scrobble_meta/last_import').set(Date.now());
      updateProgressBar(100);
      updateProgressTxt(`✓ Fertig — ${Number(realCount).toLocaleString('de-DE')} Tracks importiert`);
      statusEl.innerHTML=
        `✓ Import abgeschlossen<br>`+
        `<span style="color:var(--pink2);font-size:13px;font-weight:700;">${Number(realCount).toLocaleString('de-DE')}</span>`+
        ` <span style="color:var(--text2);">von</span> `+
        `<span style="color:var(--text);">${Number(totalTracks).toLocaleString('de-DE')}</span>`+
        ` <span style="color:var(--text2);">Scrobbles archiviert</span>`+
        (realCount<totalTracks?`<br><span style="color:var(--text3);font-size:11px;">(${totalTracks-realCount} nowplaying/Duplikate übersprungen)</span>`:'')+
        (failedPages>0?`<br><span style="color:#f59e0b;font-size:11px;">⚠ ${failedPages} Seite(n) konnten nicht gespeichert werden — „Lücken füllen" ausführen</span>`:'');
      if(failedPages>0) showToast(`⚠ ${failedPages} Seite(n) nicht gespeichert`,'err');
      else showToast('✓ Import abgeschlossen','ok');
    } else {
      statusEl.innerHTML=
        `Import abgebrochen bei Seite ${done}/${totalPages}<br>`+
        `<span style="color:var(--text2);">${Number(savedCount).toLocaleString('de-DE')} Tracks bisher gespeichert</span>`;
      showToast('Import abgebrochen','err');
    }
  }catch(e){
    statusEl.innerHTML=`<span style="color:#ef4444;">Fehler: ${e.message}</span>`;
    showToast('Import fehlgeschlagen','err');
  }
  setArchiveBusy(false);
  loadArchiveStatus();
}

async function startDeltaSync(){
  _importAborted=false;
  setArchiveBusy(true);
  const statusEl=document.getElementById('archive-status');

  try{
    statusEl.textContent='Prüfe letzten archivierten Eintrag...';
    const latestTs=await getLatestArchivedTs();

    if(!latestTs){
      statusEl.innerHTML='Kein Archiv gefunden. Bitte zuerst den vollständigen Import durchführen.';
      setArchiveBusy(false);
      return;
    }

    const fromTs=latestTs+1;
    // fromTs exklusiv (+1): sonst liefert Last.fm den bereits archivierten
    // Scrobble immer mit und das erzeugt bei jedem Sync einen Phantom-"+1"-Eintrag
    // (der `seq`-Teil im Scrobble-Key macht den Key nicht deterministisch über Syncs).
    // Trade-off: Scrobbles mit exakt gleichem uts wie der letzte archivierte werden
    // nicht per Delta-Sync abgeholt — das passiert praktisch nur bei Bulk-Imports
    // aus Spotify/YouTube und wird bei Bedarf durch Full-Import gefangen.
    const date=new Date(latestTs*1000).toLocaleString('de-DE',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
    statusEl.innerHTML=`Hole neue Tracks seit <span style="color:var(--pink);">${date}</span>...`;

    const first=await fetchScrobblePage(fromTs,null,1,1);
    const totalPages=parseInt(first?.recenttracks?.['@attr']?.totalPages||1);
    const totalNew=parseInt(first?.recenttracks?.['@attr']?.total||0);

    if(totalNew===0){
      statusEl.innerHTML=
        `✓ Archiv ist aktuell<br>`+
        `<span style="color:var(--text3);">Kein neuer Track seit <span style="color:var(--pink);">${date}</span></span>`;
      setArchiveBusy(false);
      return;
    }

    statusEl.innerHTML=
      `<span style="color:var(--pink);">${Number(totalNew).toLocaleString('de-DE')}</span> neue Tracks gefunden — wird importiert...`;

    let savedCount=0,failedPages=0;
    const eta=makeETATracker();
    const writePromises=[];
    for(let page=1;page<=totalPages;page++){
      if(_importAborted) break;

      const d=await fetchScrobblePage(fromTs,null,page,200);
      const tracks=d?.recenttracks?.track||[];
      // Fire-and-forget Write — blockiert nächsten Fetch nicht.
      // .catch() fängt endgültig fehlgeschlagene Writes ab, damit sie nicht
      // als unhandled rejection verschluckt werden und der Nutzer einen Hinweis bekommt.
      writePromises.push(
        writeBatch(tracks,(page-1)*200).then(n=>{savedCount+=n;return n;}).catch(()=>{failedPages++;})
      );

      const pct=Math.round((page/totalPages)*90);
      updateProgressBar(pct);
      updateProgressTxt(
        `${pct}% — Seite ${page}/${totalPages} geladen — `+
        `${Number(savedCount).toLocaleString('de-DE')}/${Number(totalNew).toLocaleString('de-DE')} — ${eta.label(pct)}`
      );

      await new Promise(r=>setTimeout(r,IMPORT_DELAY));
    }

    // Auf alle noch laufenden Writes warten
    if(!_importAborted){
      updateProgressTxt(`Finalisiere ${writePromises.length} Firebase-Writes... · ${eta.fmtElapsed()} gesamt`);
      await Promise.all(writePromises);
    }

    if(!_importAborted){
      // Counter aus echter Key-Anzahl ermitteln statt inkrementell —
      // damit driftet der Counter nicht mehr bei fehlgeschlagenen Writes oder Duplikaten.
      const newTotal=await getRealArchiveCount();
      await db.ref('scrobble_meta/count').set(newTotal);
      await db.ref('scrobble_meta/last_sync').set(Date.now());
      updateProgressBar(100);
      updateProgressTxt(`✓ Fertig — ${Number(savedCount).toLocaleString('de-DE')} neue Tracks gespeichert`);
      statusEl.innerHTML=
        `✓ Delta-Sync abgeschlossen<br>`+
        `<span style="color:var(--pink2);font-size:13px;font-weight:700;">+${Number(savedCount).toLocaleString('de-DE')}</span>`+
        ` <span style="color:var(--text2);">neue Tracks — Gesamt:</span> `+
        `<span style="color:var(--text);">${Number(newTotal).toLocaleString('de-DE')}</span>`+
        (failedPages>0?`<br><span style="color:#f59e0b;font-size:11px;">⚠ ${failedPages} Seite(n) konnten nicht gespeichert werden — Sync erneut ausführen</span>`:'');
      if(failedPages>0) showToast(`⚠ ${failedPages} Seite(n) nicht gespeichert`,'err');
      else showToast('✓ Delta-Sync abgeschlossen','ok');
      // Archiv-Cache invalidieren + komplette UI ohne Reload aktualisieren
      // (zuvor blieb die Seite nach manuellem Delta-Sync veraltet — anders als
      // beim automatischen Hintergrund-Sync).
      invalidateArchiveCaches();
      await refreshAfterSync();
      updateSyncStatusLabel();
    } else {
      statusEl.innerHTML=
        `Sync abgebrochen<br>`+
        `<span style="color:var(--text2);">${Number(savedCount).toLocaleString('de-DE')} neue Tracks gespeichert</span>`;
    }
  }catch(e){
    statusEl.innerHTML=`<span style="color:#ef4444;">Fehler: ${e.message}</span>`;
    showToast('Delta-Sync fehlgeschlagen','err');
  }
  setArchiveBusy(false);
  loadArchiveStatus();
}

function abortImport(){
  _importAborted=true;
  updateProgressTxt('Wird abgebrochen...');
}

// ── GAP-FILL: Findet & schließt Lücken ohne Full Import ────
// Szenario: Das Archiv ist hinter Last.fm, aber Delta-Sync bringt nichts
// (weil die fehlenden Scrobbles nicht nach dem letzten uts liegen, sondern
// mittendrin — verloren durch Race-Conditions, Write-Fehler oder Pagination-
// Shifts bei früheren Imports). Diese Funktion holt alle Last.fm-Scrobbles,
// vergleicht kanonische Fingerprints und schreibt nur die fehlenden.
// Strikt additiv — es wird nichts gelöscht.
async function startGapFill(){
  _importAborted=false;
  setArchiveBusy(true);
  const statusEl=document.getElementById('archive-status');

  try{
    // ─── Phase 1: Firebase-Archiv einlesen & kanonische Counts bauen ─────────
    statusEl.textContent='Lese aktuelles Archiv...';
    const existingSnap=await db.ref('scrobbles').get();
    const existingKeys=existingSnap.exists()?Object.keys(existingSnap.val()):[];
    const archiveCount=existingKeys.length;

    if(archiveCount===0){
      statusEl.innerHTML='Kein Archiv vorhanden — bitte zuerst vollständigen Import durchführen.';
      setArchiveBusy(false);
      return;
    }

    // Map<canonicalID, count> — wie oft existiert dieser Scrobble in Firebase?
    const fbCanonCounts=new Map();
    // Map<canonicalID, maxSeqValue> — höchster seq-Wert pro Canonical, um Kollisionen beim Nachschreiben zu vermeiden
    const fbMaxSeq=new Map();
    for(const key of existingKeys){
      const canon=keyToCanonical(key);
      fbCanonCounts.set(canon,(fbCanonCounts.get(canon)||0)+1);
      const seq=parseInt(key.substring(key.lastIndexOf('_')+1))||0;
      fbMaxSeq.set(canon,Math.max(fbMaxSeq.get(canon)||0,seq));
    }

    // ─── Phase 2: Last.fm-Übersicht holen ───────────────────────────────────
    statusEl.textContent='Hole Last.fm Übersicht...';
    const first=await fetchScrobblePage(1,null,1,1);
    const totalPages=parseInt(first?.recenttracks?.['@attr']?.totalPages||1);
    const totalLfm=parseInt(first?.recenttracks?.['@attr']?.total||0);

    if(totalLfm===0){
      statusEl.innerHTML='Last.fm meldet keine Scrobbles (API-Fehler?).';
      setArchiveBusy(false);
      return;
    }

    statusEl.innerHTML=
      `Firebase: <span style="color:var(--pink);">${Number(archiveCount).toLocaleString('de-DE')}</span> · `+
      `Last.fm: <span style="color:var(--pink);">${Number(totalLfm).toLocaleString('de-DE')}</span><br>`+
      `<span style="color:var(--text3);font-size:12px;">Lese ${totalPages} Seiten zum Abgleich...</span>`;

    // ─── Phase 3: Alle Last.fm-Scrobbles holen & kanonisch zählen ───────────
    const lfmTracks=[]; // Vollständige Track-Objekte für späteres Schreiben
    const lfmCanonCounts=new Map();
    const etaFetch=makeETATracker();

    for(let page=1;page<=totalPages;page++){
      if(_importAborted) break;

      const d=await fetchScrobblePage(1,null,page,200);
      const tracks=d?.recenttracks?.track||[];
      for(const t of tracks){
        if(t['@attr']?.nowplaying) continue;
        const ts=parseInt(t.date?.uts);
        if(!ts) continue;
        const artist=t.artist?.['#text']||t.artist?.name||'';
        const track=t.name||'';
        const canon=canonicalScrobbleId(ts,artist,track);
        lfmCanonCounts.set(canon,(lfmCanonCounts.get(canon)||0)+1);
        lfmTracks.push({t,canon});
      }

      // Phase 3 belegt 0–60% der Progress-Bar — ETA rechnet auf lokalen Phase-Fortschritt
      const phasePct=Math.round((page/totalPages)*100);
      const barPct=Math.round((page/totalPages)*60);
      updateProgressBar(barPct);
      updateProgressTxt(`Lese Seite ${page}/${totalPages} — ${lfmTracks.length} Scrobbles analysiert · ${etaFetch.label(phasePct)}`);
      await new Promise(r=>setTimeout(r,IMPORT_DELAY));
    }

    if(_importAborted){
      statusEl.innerHTML='Gap-Fill abgebrochen vor Schreibphase';
      setArchiveBusy(false);
      return;
    }

    // ─── Phase 4: Diff berechnen ────────────────────────────────────────────
    // needCount: Wie viele Kopien pro Canonical müssen NOCH geschrieben werden
    const needCount=new Map();
    for(const [canon,lfmN] of lfmCanonCounts.entries()){
      const fbN=fbCanonCounts.get(canon)||0;
      if(lfmN>fbN) needCount.set(canon,lfmN-fbN);
    }

    // Umgekehrt: Firebase-Einträge, für die Last.fm weniger Kopien meldet (alte Duplikate,
    // bei Last.fm gelöschte Scrobbles). Nur loggen, nichts anfassen.
    let fbOnlyTotal=0;
    for(const [canon,fbN] of fbCanonCounts.entries()){
      const lfmN=lfmCanonCounts.get(canon)||0;
      if(fbN>lfmN) fbOnlyTotal+=(fbN-lfmN);
    }
    if(fbOnlyTotal>0){
      console.info(`Gap-Fill: Firebase hat ${fbOnlyTotal} Scrobble(s) mehr als Last.fm (alte Duplikate o. bei Last.fm gelöschte Tracks) — NICHT entfernt.`);
    }

    const totalMissing=Array.from(needCount.values()).reduce((a,b)=>a+b,0);

    if(totalMissing===0){
      updateProgressBar(100);
      updateProgressTxt('✓ Archiv ist vollständig');
      await db.ref('scrobble_meta/count').set(archiveCount);
      await db.ref('scrobble_meta/last_sync').set(Date.now());
      statusEl.innerHTML=
        `✓ Keine Lücken gefunden<br>`+
        `<span style="color:var(--text3);font-size:13px;">`+
        `Alle ${Number(archiveCount).toLocaleString('de-DE')} abrufbaren Last.fm-Scrobbles sind archiviert`+
        (fbOnlyTotal>0?` <span style="color:var(--text3);">(+${fbOnlyTotal} Firebase-Extras — siehe Konsole)</span>`:'')+
        `</span>`;
      showToast('✓ Archiv vollständig','ok');
      setArchiveBusy(false);
      loadArchiveStatus();
      return;
    }

    // ─── Phase 5: Fehlende Scrobbles in Batches schreiben ───────────────────
    statusEl.innerHTML=
      `<span style="color:var(--pink);">${Number(totalMissing).toLocaleString('de-DE')}</span> Lücken gefunden — werden geschlossen...`;

    const BATCH_SIZE=200;
    let written=0,queued=0;
    let batch={};
    const addedPerCanon=new Map(); // bereits hinzugefügte Kopien in diesem Run
    const writePromises=[];
    const etaWrite=makeETATracker();

    for(const {t,canon} of lfmTracks){
      if(_importAborted) break;

      const need=needCount.get(canon)||0;
      const already=addedPerCanon.get(canon)||0;
      if(already>=need) continue; // diesen Canonical haben wir schon ausreichend nachgeholt

      const ts=parseInt(t.date?.uts);
      const artist=t.artist?.['#text']||t.artist?.name||'';
      const track=t.name||'';
      // Neuen seq-Wert wählen der mit existierenden nicht kollidiert
      const newSeq=(fbMaxSeq.get(canon)||0)+1+already;
      const key=makeScrobbleKey(ts,artist,track,newSeq);
      batch[`scrobbles/${key}`]={artist,track,album:t.album?.['#text']||''};
      addedPerCanon.set(canon,already+1);

      if(Object.keys(batch).length>=BATCH_SIZE){
        const currentBatch=batch;
        const batchSize=Object.keys(currentBatch).length;
        batch={};
        queued+=batchSize;
        // Fire-and-forget — nächster Batch kann parallel aufgebaut werden
        writePromises.push(
          fbUpdateWithRetry(currentBatch).then(()=>{written+=batchSize;})
        );
        // Progress: 60-90% während Queueing, 90-100% für finale Write-Bestätigung
        const phasePct=Math.round((queued/totalMissing)*100);
        const barPct=60+Math.round((queued/totalMissing)*30);
        updateProgressBar(barPct);
        updateProgressTxt(`${queued}/${totalMissing} Lücken geschrieben · ${etaWrite.label(phasePct)}`);
      }
    }

    // Rest-Batch queuen
    if(Object.keys(batch).length&&!_importAborted){
      const currentBatch=batch;
      const batchSize=Object.keys(currentBatch).length;
      queued+=batchSize;
      writePromises.push(
        fbUpdateWithRetry(currentBatch).then(()=>{written+=batchSize;})
      );
    }

    // Auf alle Writes warten
    if(!_importAborted&&writePromises.length>0){
      updateProgressTxt(`Finalisiere ${writePromises.length} Firebase-Batches... · ${etaWrite.fmtElapsed()} gesamt`);
      await Promise.all(writePromises);
    }

    // ─── Phase 6: Counter & Cache aktualisieren ─────────────────────────────
    const newTotal=await getRealArchiveCount();
    await db.ref('scrobble_meta/count').set(newTotal);
    await db.ref('scrobble_meta/last_sync').set(Date.now());

    updateProgressBar(100);

    if(_importAborted){
      statusEl.innerHTML=
        `Gap-Fill abgebrochen<br>`+
        `<span style="color:var(--text2);">${Number(written).toLocaleString('de-DE')} von ${Number(totalMissing).toLocaleString('de-DE')} Lücken geschlossen</span>`;
    }else{
      updateProgressTxt(`✓ Fertig — ${written} Lücken geschlossen`);
      statusEl.innerHTML=
        `✓ Gap-Fill abgeschlossen<br>`+
        `<span style="color:var(--pink2);font-size:13px;font-weight:700;">+${Number(written).toLocaleString('de-DE')}</span>`+
        ` <span style="color:var(--text2);">fehlende Scrobbles — Gesamt:</span> `+
        `<span style="color:var(--text);">${Number(newTotal).toLocaleString('de-DE')}</span>`+
        (fbOnlyTotal>0?`<br><span style="color:var(--text3);font-size:11px;">Hinweis: ${fbOnlyTotal} Firebase-Extras (siehe Konsole)</span>`:'');
      showToast(`✓ ${written} Lücken geschlossen`,'ok');
    }

    // Archiv-Cache invalidieren damit neue Daten sichtbar werden
    invalidateArchiveCaches();

  }catch(e){
    statusEl.innerHTML=`<span style="color:#ef4444;">Fehler: ${e.message}</span>`;
    showToast('Gap-Fill fehlgeschlagen','err');
    console.error('Gap-Fill error:',e);
  }
  setArchiveBusy(false);
  loadArchiveStatus();
}

// ── SYNC BANNER HELPERS ────────────────────────────────────
function syncBanner(state,msg,barPct=null,html=false){
  const banner=document.getElementById('sync-banner');
  const inner=document.getElementById('sync-banner-inner');
  const msgEl=document.getElementById('sync-banner-msg');
  const spinner=document.getElementById('sync-spinner');
  const barWrap=document.getElementById('sync-bar-wrap');
  const barFill=document.getElementById('sync-bar-fill');
  if(!banner) return;
  banner.classList.add('visible');
  inner.className='sync-banner-inner '+state;
  // HTML-Modus nur bei kontrolliert konstruierten Nachrichten verwenden (z.B. Health-Check)
  if(html) msgEl.innerHTML=msg; else msgEl.textContent=msg;
  spinner.style.display=(state==='syncing')?'block':'none';
  if(barPct!==null&&barWrap){
    barWrap.style.display='block';
    barFill.style.width=barPct+'%';
  } else if(barWrap){
    barWrap.style.display='none';
  }
  if(state!=='syncing'){
    setTimeout(()=>banner.classList.remove('visible'), state==='done-new'?5000:3000);
  }
}

// ── AUTO DELTA-SYNC ────────────────────────────────────────
function updateSyncBadge(msg,color){
  const b=document.getElementById('archive-sync-badge');
  if(!b) return;
  b.style.display='block';
  b.textContent=msg;
  b.style.color=color||'var(--text3)';
}

// Permanentes Sync-Status-Label im Übersichts-Header.
// Zeigt "Archiv aktuell · vor X Min" basierend auf scrobble_meta/last_sync.
// Wird beim initialen Load und nach jedem erfolgreichen Sync aktualisiert.
async function updateSyncStatusLabel(){
  const el=document.getElementById('sync-status');
  if(!el) return;
  try{
    const snap=await db.ref('scrobble_meta/last_sync').get();
    if(!snap.exists()){el.style.display='none';return;}
    const lastSync=snap.val();
    const ageMin=Math.round((Date.now()-lastSync)/60000);
    let label;
    if(ageMin<1) label='Archiv aktuell · gerade eben';
    else if(ageMin<60) label=`Archiv aktuell · vor ${ageMin} Min`;
    else if(ageMin<1440){const h=Math.floor(ageMin/60);label=`Archiv aktuell · vor ${h} Std`;}
    else {const d=Math.floor(ageMin/1440);label=`Archiv aktuell · vor ${d} Tag${d===1?'':'en'}`;}
    el.textContent=label;
    el.title=`Letzter Sync: ${new Date(lastSync).toLocaleString('de-DE')}`;
    el.style.display='block';
  }catch(e){el.style.display='none';}
}

// ── POST-SYNC REFRESH ─────────────────────────────────────
// Aktualisiert alle UI-Komponenten, die von Scrobble-Daten abhängen —
// ohne Full Page Reload. Wird nach jedem erfolgreichen Sync aufgerufen.
async function refreshAfterSync(){
  try{
    // Last.fm-Cache leeren für Calls, die sich bei neuen Scrobbles ändern
    // (user.getRecentTracks, user.getInfo, Top-Listen)
    Object.keys(cache).forEach(k=>{
      if(k.startsWith('user.getRecentTracks')||
         k.startsWith('user.getInfo')||
         k.startsWith('user.getTopArtists')||
         k.startsWith('user.getTopTracks')||
         k.startsWith('user.getTopAlbums')||
         k.startsWith('user.getTopTags')){
        delete cache[k];
      }
    });

    // 1) Archiv neu laden — triggert intern updateTodayTime, loadStreak,
    //    updateChartsTrackCount und das Re-Rendering von Hero/Overview
    await getArchiveData();

    // 2) Charts neu rendern (Cache wurde bereits oben geleert)
    try{ loadCharts(); }catch(e){}

    // 3) Recent-Sektion neu laden
    try{
      const recent = await loadRecent();
      window._lastRecentTracks = recent;
    }catch(e){}

    // 4) Now-Playing-Card sofort aktualisieren
    try{ loadNowPlayingCard(); }catch(e){}

    // 5) Heatmap neu laden
    try{ loadCalendar(); }catch(e){}

    // 6) Jahresrückblick (aktuelles Jahr) neu laden
    try{
      const curYear = new Date().getFullYear();
      if(selectedYear === null || selectedYear === curYear){
        loadYearReview(curYear);
      }
    }catch(e){}

    // 7) Archiv-Section aktualisieren (Badge, und Liste falls geöffnet)
    try{
      await loadArchiveSection();
      if(_archiveLoaded) renderArchiveList();
    }catch(e){}

    // 8) Diversity & Compare (nutzen Last.fm-Top-Listen, aber die könnten
    //    sich nach einem Sync auch minimal verschoben haben)
    try{ renderDiversity(); }catch(e){}
  }catch(e){console.warn('refreshAfterSync failed:',e);}
}


// Lock gegen parallele Auto-Syncs (periodischer + visibilitychange + manuell)
let _autoSyncRunning=false;

async function autoBackgroundSync(silent=false){
  if(_autoSyncRunning) return; // bereits aktiv — nicht überlappen
  // Wenn manueller Import/Delta-Sync läuft, ebenfalls nicht stören
  if(document.getElementById('archive-modal')?.classList.contains('busy')) return;
  _autoSyncRunning=true;
  try{
    const hasArchive=await getLatestArchivedTs();
    if(!hasArchive) return; // kein Archiv vorhanden, nichts zu syncen

    // Im stillen Modus (periodischer Sync / Tab-Rückkehr) kein Banner zeigen,
    // außer es werden tatsächlich neue Scrobbles gefunden.
    if(!silent){
      syncBanner('syncing','Prüfe auf neue Scrobbles...');
      updateSyncBadge('🔄 synchronisiert...','var(--pink)');
    }

    const latestTs=await getLatestArchivedTs();
    if(!latestTs){if(!silent)syncBanner('done-ok','Kein Archiv vorhanden');return;}

    const fromTs=latestTs+1;
    // fromTs exklusiv (+1), siehe Kommentar in startDeltaSync.
    const first=await fetchScrobblePage(fromTs,null,1,1);
    const totalPages=parseInt(first?.recenttracks?.['@attr']?.totalPages||1);
    const totalNew=parseInt(first?.recenttracks?.['@attr']?.total||0);

    if(totalNew===0){
      await db.ref('scrobble_meta/last_sync').set(Date.now());
      // Kein aufpoppendes Banner mehr — stattdessen dezentes Label im Header.
      // Falls das Banner vorher im "syncing"-Zustand war (non-silent-Modus), ausblenden.
      if(!silent){
        const banner=document.getElementById('sync-banner');
        if(banner) banner.classList.remove('visible');
        updateSyncBadge('aktuell ✓','#22c55e');
      }
      updateSyncStatusLabel();
      return;
    }

    // Neue Scrobbles gefunden — jetzt auch im stillen Modus Banner zeigen
    syncBanner('syncing',`${Number(totalNew).toLocaleString('de-DE')} neue Scrobbles werden gespeichert...`,0);
    updateSyncBadge('🔄 synchronisiert...','var(--pink)');

    let saved=0,failedPages=0;
    const eta=makeETATracker();
    const writePromises=[];
    for(let page=1;page<=totalPages;page++){
      const d=await fetchScrobblePage(fromTs,null,page,200);
      const tracks=d?.recenttracks?.track||[];
      // Fire-and-forget Write — .catch() verhindert verschluckte Schreibfehler
      writePromises.push(
        writeBatch(tracks,(page-1)*200).then(n=>{saved+=n;return n;}).catch(()=>{failedPages++;})
      );
      const pct=Math.round((page/totalPages)*90);
      syncBanner('syncing', `Scrobbles werden geladen... ${page}/${totalPages} · ${eta.label(pct)}`, pct);
      updateSyncBadge(`${pct}%`,'var(--pink)');
      await new Promise(r=>setTimeout(r,0)); // DOM rendern lassen
      await new Promise(r=>setTimeout(r,IMPORT_DELAY));
    }

    // Auf alle Writes warten bevor Counter/Cache aktualisiert werden
    syncBanner('syncing', `Finalisiere Firebase-Writes... · ${eta.fmtElapsed()} gesamt`, 95);
    await Promise.all(writePromises);

    // Counter aus echter Key-Anzahl ermitteln statt inkrementell —
    // damit driftet der Counter nicht mehr bei fehlgeschlagenen Writes oder Duplikaten.
    const realTotal=await getRealArchiveCount();
    await db.ref('scrobble_meta/count').set(realTotal);
    await db.ref('scrobble_meta/last_sync').set(Date.now());
    if(failedPages>0){
      updateSyncBadge(`+${saved} · ⚠ ${failedPages} Fehler`,'#f59e0b');
      syncBanner('err',`⚠ +${Number(saved).toLocaleString('de-DE')} gespeichert, ${failedPages} Seite(n) fehlgeschlagen — „Lücken füllen" hilft`);
      if(!silent) showToast(`⚠ ${failedPages} Seite(n) nicht gespeichert`,'err');
    } else {
      updateSyncBadge(`+${saved} neue Tracks ✓`,'#22c55e');
      syncBanner('done-new',`✓ +${Number(saved).toLocaleString('de-DE')} neue Scrobbles synchronisiert`,100);
      if(!silent) showToast(`✓ +${Number(saved).toLocaleString('de-DE')} neue Scrobbles`,'ok');
    }
    updateSyncStatusLabel();

    // Archiv-Cache invalidieren damit neue Daten sichtbar werden.
    invalidateArchiveCaches();
    // Alle UI-Komponenten neu laden — ohne full page reload
    await refreshAfterSync();

  }catch(e){
    // Bei stillem Periodic-Sync nicht mit Banner nerven — könnte nur Netzwerkfehler sein
    if(!silent){
      syncBanner('err','Sync fehlgeschlagen: '+e.message);
      updateSyncBadge('Sync fehlgeschlagen','#ef4444');
    } else {
      console.warn('Silent sync failed:',e.message);
    }
  } finally {
    _autoSyncRunning=false;
  }
}

// ── HEALTH-CHECK: Firebase vs. Last.fm Drift-Erkennung ────
// Vergleicht die tatsächliche Key-Anzahl in Firebase mit der Anzahl, die
// Last.fm via `getRecentTracks` als abrufbar meldet.
// WICHTIG: NICHT gegen `user.getInfo.playcount` vergleichen — der Counter
// enthält strukturell immer mehr (Now-Playing, gelöschte/bearbeitete Scrobbles,
// interne Counter-Lags zwischen den Endpoints). Er driftet permanent von dem
// ab, was via `getRecentTracks` überhaupt holbar ist. Da Delta-Sync aus
// `getRecentTracks` liest, muss der Health-Check dieselbe Quelle nutzen —
// sonst zeigt er Drift an, die durch keinen Sync jemals geschlossen werden
// kann ("Archiv ist X hinter Last.fm" trotz leerem Delta-Sync).
async function checkArchiveHealth(){
  if(isLfmDown()) return; // Ohne Last.fm kein Vergleich möglich
  try{
    // `from=1` setzen, damit Last.fm wirklich die Gesamtzahl aller je
    // abrufbaren Scrobbles zurückgibt (ohne from/to kann es im Einzelfall
    // einen Window-begrenzten Total liefern).
    const [firstPage, archiveCount] = await Promise.all([
      fetchScrobblePage(1,null,1,1),
      getRealArchiveCount()
    ]);
    const lfmCount = parseInt(firstPage?.recenttracks?.['@attr']?.total)||0;
    if(!lfmCount) return; // Last.fm nicht erreichbar oder leer
    const drift = lfmCount - archiveCount;
    // Counter in Firebase auch gleich auf Realwert syncen (für Archiv-Badge)
    const metaCount = await getArchiveCount();
    if(metaCount !== archiveCount){
      try{ await db.ref('scrobble_meta/count').set(archiveCount); }catch(e){}
    }
    // Drift-Threshold: Da wir jetzt gegen `getRecentTracks.total` vergleichen
    // (dieselbe Quelle wie Delta-Sync) sollte die Drift im Idealfall 0 sein.
    // Kleine Toleranz für Race-Conditions (Sync läuft parallel zu neuem Scrobble).
    const driftThreshold = Math.max(5, Math.floor(lfmCount * 0.0005));
    if(drift > driftThreshold && archiveCount > 0){
      const pct = Math.round((archiveCount/lfmCount)*100);
      const driftPct = drift / lfmCount;
      // Drift besteht obwohl wir gegen getRecentTracks.total vergleichen (dieselbe
      // Quelle wie Delta-Sync). Das heißt: Delta-Sync bringt definitionsgemäß nichts —
      // die Lücken liegen nicht am Ende sondern mittendrin. Gap-Fill ist das richtige
      // Werkzeug. Full Import nur bei sehr großer Drift anbieten.
      const action = driftPct < 0.05
        ? `<a href="#" onclick="startGapFill();openArchiveModal();return false;" style="color:var(--pink);text-decoration:underline;">Lücken füllen</a>`
        : `<a href="#" onclick="openArchiveModal();return false;" style="color:var(--pink);text-decoration:underline;">Vollständigen Import starten</a>`;
      syncBanner('err',
        `⚠ Archiv ist ${drift} Scrobbles hinter Last.fm (${pct}% synchronisiert). `+action,
        null, true  // html=true — Link wird gerendert statt als Text angezeigt
      );
      console.warn(`Archive health: ${archiveCount}/${lfmCount} (drift ${drift}, threshold ${driftThreshold})`);
    } else if(drift > 0){
      // Kleine Drift ignorieren — normales API-Rauschen / Race-Condition
      console.info(`Archive health: ${archiveCount}/${lfmCount} (drift ${drift} innerhalb Toleranz ${driftThreshold})`);
    } else if(drift < 0){
      // Archiv > Last.fm — kann durch gelöschte Scrobbles bei Last.fm passieren
      console.info(`Archive health: ${archiveCount}/${lfmCount} (archive ahead by ${-drift})`);
    }
  }catch(e){console.warn('checkArchiveHealth failed:',e);}
}


let _archiveData=null; // cache der geladenen Daten
let archivePeriod='all',archiveTab='tracks';

let _archiveLoaded=false;

async function loadArchiveSection(){
  const sec=document.getElementById('archive-sec');
  const badgeEl=document.getElementById('archive-sec-badge');

  const count=await getArchiveCount();
  if(!count){sec.style.display='none';return;}

  sec.style.display='block';
  const navLink=document.getElementById('nav-archive-link');
  if(navLink) navLink.style.display='';
  badgeEl.textContent=`(${Number(count).toLocaleString('de-DE')} Tracks)`;

  // Archiv-Daten vorladen damit Streak und Track-Count-Badge davon profitieren
  try{
    if(!_archiveData){
      await getArchiveData();
    }
  }catch(e){}
  // Data loads lazily on first expand
}

async function toggleArchive(){
  const body=document.getElementById('archive-body');
  const icon=document.getElementById('archive-toggle-icon');
  const isOpen=body.style.display!=='none';
  body.style.display=isOpen?'none':'block';
  icon.style.transform=isOpen?'':'rotate(180deg)';

  if(!isOpen&&!_archiveLoaded){
    _archiveLoaded=true;
    const listEl=document.getElementById('archive-list');
    listEl.innerHTML='<div class="ld"><div class="sp"></div> Lade Archiv-Daten...</div>';
    try{
      const archToggleData=await getArchiveData();
      if(!archToggleData){listEl.innerHTML='<div style="color:var(--text3);">Kein Archiv.</div>';return;}
    }catch(e){
      listEl.innerHTML='<div class="err">Fehler beim Laden des Archivs.</div>';return;
    }
    renderArchiveList();
  }
}

function archiveFilteredEntries(){
  const now=new Date();
  const entries=Object.entries(_archiveData||{});
  if(archivePeriod==='all') return entries;
  return entries.filter(([key])=>{
    const ts=parseInt(key.split('_')[0])*1000;
    const d=new Date(ts);
    if(archivePeriod==='year') return d.getFullYear()===now.getFullYear();
    if(archivePeriod==='month') return d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth();
    return true;
  });
}

let _archiveShowCount=50;

function renderArchiveList(){
  const listEl=document.getElementById('archive-list');
  const entries=archiveFilteredEntries();
  const countMap={};

  entries.forEach(([key,v])=>{
    let mapKey,display,sub;
    if(archiveTab==='tracks'){
      mapKey=v.artist+'||||'+v.track;
      display=escapeHTML(v.track);sub=escapeHTML(v.artist);
    } else if(archiveTab==='artists'){
      mapKey=v.artist;display=escapeHTML(v.artist);sub='';
    } else {
      if(!v.album) return;
      mapKey=v.artist+'||||'+v.album;
      display=escapeHTML(v.album);sub=escapeHTML(v.artist);
    }
    if(!display) return;
    if(!countMap[mapKey]) countMap[mapKey]={display,sub,count:0};
    countMap[mapKey].count++;
  });

  const sorted=Object.values(countMap).sort((a,b)=>b.count-a.count);
  if(!sorted.length){listEl.innerHTML='<div style="color:var(--text3);font-size:13px;padding:12px;">Keine Einträge für diesen Zeitraum.</div>';return;}
  const visible=sorted.slice(0,_archiveShowCount);
  const max=sorted[0].count;
  const html=visible.map((item,i)=>{
    const pct=Math.round((item.count/max)*100);
    const rc=i===0?'g':i===1?'s':i===2?'b':'';
    return `<div class="ri ${i===0?'rank1':i<3?'top3':''}" style="cursor:default;">
      <span class="rn ${rc}">${i+1}</span>
      <div class="ri-ph">♪</div>
      <div class="ri-info"><div class="ri-name">${item.display}</div>${item.sub?`<div class="ri-sub">${item.sub}</div>`:''}</div>
      <div class="ri-right">
        <div class="bar-c"><div class="bar-f" style="width:${pct}%"></div></div>
        <span class="plays">${Number(item.count).toLocaleString('de-DE')} ▶</span>
      </div>
    </div>`;
  }).join('');

  const moreBtn=sorted.length>_archiveShowCount
    ?`<button class="show-more" onclick="_archiveShowCount+=50;renderArchiveList()">+ Mehr anzeigen (${sorted.length-_archiveShowCount} weitere)</button>`
    :'';

  listEl.innerHTML=`<div class="rlist">${html}</div>${moreBtn}`;
}

// Period + Tab listeners für Archiv-Sektion
document.getElementById('archive-period-tabs').querySelectorAll('.pb').forEach(b=>b.addEventListener('click',()=>{
  document.getElementById('archive-period-tabs').querySelectorAll('.pb').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  archivePeriod=b.dataset.ap;
  _archiveShowCount=50;
  renderArchiveList();
}));
document.getElementById('archive-ctabs').querySelectorAll('.ctab').forEach(t=>t.addEventListener('click',()=>{
  document.getElementById('archive-ctabs').querySelectorAll('.ctab').forEach(x=>x.classList.remove('active'));
  t.classList.add('active');
  archiveTab=t.dataset.at;
  _archiveShowCount=50;
  renderArchiveList();
}));

// ── RUNDE 4: CSV EXPORT ───────────────────────────────────
async function exportArchiveCSV(btn){
  const origText=btn.textContent;
  btn.textContent='Wird erstellt...';btn.disabled=true;
  try{
    const data=await getArchiveData();
    if(!data) throw new Error('Kein Archiv gefunden');
    const rows=[['Datum','Uhrzeit','Künstler','Track','Album']];
    Object.entries(data)
      .sort(([a],[b])=>parseInt(a)-parseInt(b))
      .forEach(([key,v])=>{
        const ts=parseInt(key.split('_')[0])*1000;
        const d=new Date(ts);
        const date=d.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'});
        const time=d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
        const esc=s=>'"'+String(s||'').replace(/"/g,'""')+'"';
        rows.push([date,time,esc(v.artist),esc(v.track),esc(v.album)]);
      });
    const csv=rows.map(r=>r.join(',')).join('\n');
    const blob=new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download='scrobbles_export.csv';a.click();
    URL.revokeObjectURL(url);
    showToast('✓ CSV exportiert','ok');
  }catch(e){
    showToast('Export fehlgeschlagen: '+e.message,'err');
  }
  btn.textContent=origText;btn.disabled=false;
}

// ── ARTIST DRILL-DOWN ──────────────────────────────────────
function getArchivePeriodFilter(){
  const now=new Date();
  if(chartPeriod==='today'){
    const midnight=new Date(now.getFullYear(),now.getMonth(),now.getDate());
    return ts=>ts>=midnight.getTime();
  }
  if(chartPeriod==='7day'){const d=new Date(now-7*864e5);return ts=>ts>=d.getTime();}
  if(chartPeriod==='1month'){const d=new Date(now);d.setMonth(d.getMonth()-1);return ts=>ts>=d.getTime();}
  if(chartPeriod==='3month'){const d=new Date(now);d.setMonth(d.getMonth()-3);return ts=>ts>=d.getTime();}
  if(chartPeriod==='6month'){const d=new Date(now);d.setMonth(d.getMonth()-6);return ts=>ts>=d.getTime();}
  if(chartPeriod==='12month'){const d=new Date(now);d.setMonth(d.getMonth()-12);return ts=>ts>=d.getTime();}
  return ()=>true; // overall
}

const PERIOD_LABEL={'overall':'Gesamt','12month':'12 Monate','6month':'6 Monate','3month':'3 Monate','1month':'1 Monat','7day':'7 Tage','yesterday':'Gestern','today':'Heute'};

async function openArtistDrillDown(artistName){
  const overlay=document.getElementById('adm-overlay');
  const titleEl=document.getElementById('adm-title');
  const subEl=document.getElementById('adm-sub');
  const bodyEl=document.getElementById('adm-body');

  titleEl.textContent=artistName;
  subEl.textContent='Lädt...';
  bodyEl.innerHTML='<div class="ld"><div class="sp"></div> Lade Archiv-Daten...</div>';
  overlay.classList.add('open');
  document.body.style.overflow='hidden';

  // Archiv laden falls noch nicht gecacht
  if(!_archiveData){
    try{
      const admData=await getArchiveData();
      if(!admData){bodyEl.innerHTML='<div class="err">Kein Archiv gefunden.</div>';return;}
    }catch(e){bodyEl.innerHTML='<div class="err">Fehler: '+e.message+'</div>';return;}
  }

  const periodFilter=getArchivePeriodFilter();
  const trackMap={};
  Object.entries(_archiveData).forEach(([key,v])=>{
    const ts=parseInt(key.split('_')[0])*1000;
    if(!periodFilter(ts)) return;
    const a=(v.artist||'').trim();
    if(a.toLowerCase()!==artistName.toLowerCase()) return;
    const t=(v.track||'').trim();
    if(!t) return;
    trackMap[t]=(trackMap[t]||0)+1;
  });

  const sorted=Object.entries(trackMap).sort((a,b)=>b[1]-a[1]);
  const total=sorted.reduce((s,[,c])=>s+c,0);
  subEl.textContent=`${PERIOD_LABEL[chartPeriod]||chartPeriod} · ${Number(total).toLocaleString('de-DE')} Plays · ${sorted.length} Tracks`;

  if(!sorted.length){
    bodyEl.innerHTML='<div style="color:var(--text3);font-size:13px;padding:12px;">Keine Tracks für diesen Zeitraum gefunden.</div>';
    return;
  }

  const max=sorted[0][1];
  const html=sorted.map(([track,count],i)=>{
    const pct=Math.round((count/max)*100);
    const rc=i===0?'g':i===1?'s':i===2?'b':'';
    const rankCls2=i===0?'rank1':i<3?'top3':'';
    return `<div class="ri ${rankCls2}" style="cursor:default;">
      <span class="rn ${rc}">${i+1}</span>
      <div class="ri-ph">♪</div>
      <div class="ri-info"><div class="ri-name">${escapeHTML(track)}</div></div>
      <div class="ri-right">
        <div class="bar-c"><div class="bar-f" style="width:${pct}%"></div></div>
        <span class="plays">${Number(count).toLocaleString('de-DE')} ▶</span>
      </div>
    </div>`;
  }).join('');
  bodyEl.innerHTML=`<div class="rlist">${html}</div>`;
}

function closeArtistDrillDown(e){
  if(e&&e.target!==document.getElementById('adm-overlay')) return;
  document.getElementById('adm-overlay').classList.remove('open');
  document.body.style.overflow='';
}

// ── ESCAPE KEY ─────────────────────────────────────────────
document.addEventListener('keydown',(e)=>{
  if(e.key!=='Escape') return;
  const adm=document.getElementById('adm-overlay');
  if(adm?.classList.contains('open')){closeArtistDrillDown(null);return;}
  const archiveMod=document.getElementById('archive-modal');
  if(archiveMod?.classList.contains('open')){closeArchiveModal();return;}
});

// ── INIT ───────────────────────────────────────────────────
(async()=>{
  loadCache();
  try{
    // Archiv parallel starten — braucht keine Last.fm
    const archivePromise=getArchiveData();

    const npTrack=await loadNowPlayingCard();
    const ud=await loadHero(npTrack);
    // Wenn Last.fm down + kein Cache: ud.joined ist heute — dann Jahr aus Archiv ableiten
    let heroJoinYear=ud.joined.getFullYear();
    if(isLfmDown() && _archiveData){
      const tsList=Object.keys(_archiveData).map(k=>parseInt(k.split('_')[0])).filter(x=>x);
      if(tsList.length){
        const earliest=Math.min(...tsList);
        heroJoinYear=new Date(earliest*1000).getFullYear();
      }
    }
    joinYear=heroJoinYear;
    renderOverview(ud);
    renderDiversity();
    loadCharts();
    updateChartsTrackCount();
    loadCompare();
    buildYearSel(heroJoinYear);
    loadYearReview(new Date().getFullYear());
    loadStreak();
    renderDayHourHeatmap();
    renderYoY();

    const [recent,_monthly]=await Promise.all([loadRecent(),loadMonthly(++monthlyLoadId)]);
    window._lastRecentTracks=recent;
    loadActivityData(recent).then(act=>{
      renderWeekday(act);
      renderClock(act);
    });
    loadPie();
    loadTrend();
    loadCalendar();

    saveCache();

    // Sync-Status-Label sofort aus DB befüllen (zeigt "vor X Min" auch bevor autoBackgroundSync läuft)
    updateSyncStatusLabel();

    // Background DB sync – always check if Firebase is up to date
    if(joinYear) loadLifetimeData(joinYear,true).catch(()=>showToast('⚠ Firebase-Sync fehlgeschlagen','err'));

    // Auto Delta-Sync im Hintergrund, danach Health-Check
    autoBackgroundSync()
      .then(()=>checkArchiveHealth())
      .catch(()=>{});

    // ── KONTINUIERLICHE SYNC-MECHANISMEN ──────────────────
    // Damit Firebase auch bei offenem Tab aktuell bleibt (ohne Reload nötig)

    // 1) Periodischer Sync alle 5 Minuten — still, kein Banner-Spam
    setInterval(()=>{
      if(document.hidden) return; // Tab im Hintergrund → nicht syncen (schont API)
      if(isLfmDown()) return;     // Last.fm weg → warten bis wieder da
      autoBackgroundSync(true).catch(()=>{});
    }, 5*60*1000);

    // 2) Sync bei Tab-Rückkehr — mit kleinem Debounce
    // (Wenn man schnell zwischen Tabs hin- und herspringt, nicht jedes Mal syncen)
    let _lastVisSync=0;
    document.addEventListener('visibilitychange', ()=>{
      if(document.hidden) return;
      if(isLfmDown()) return;
      const now=Date.now();
      if(now-_lastVisSync < 60*1000) return; // min. 1 Min zwischen Tab-Visibility-Syncs
      _lastVisSync=now;
      autoBackgroundSync(true).catch(()=>{});
    });

    // Archiv-Sektion laden
    loadArchiveSection().catch(()=>{});
  }catch(e){
    console.error(e);
    document.body.insertAdjacentHTML('afterbegin',`<div class="wrap"><div class="err" style="margin:16px 0;">Fehler: ${e.message}</div></div>`);
  }
})();

// ── EVENT-DELEGATION (ersetzt Inline-onclick) ──────────────
// Zentrale Verdrahtung: Buttons/Links tragen data-action (+ optional data-arg),
// statt onclick="…". Hält das HTML frei von Inline-Handlern (CSP-freundlich).
document.addEventListener('click',(e)=>{
  const el=e.target.closest('[data-action]');
  if(!el) return;
  const action=el.dataset.action;
  switch(action){
    case 'setSort': setSort(el.dataset.arg); break;
    case 'exportArchiveCSV': exportArchiveCSV(el); break;
    case 'closeArtistDrillDown':
      // Schließen-Button immer schließen; Backdrop nur bei direktem Klick auf das Overlay
      closeArtistDrillDown(el.classList.contains('adm-close') ? null : e);
      break;
    default: {
      const fn=window[action];
      if(typeof fn==='function') fn();
    }
  }
});

// Suche (ersetzt oninput="onSearchInput()")
(()=>{ const s=document.getElementById('chart-search'); if(s) s.addEventListener('input',onSearchInput); })();

// ── TABLIST-ARIA + TASTATURNAVIGATION ──────────────────────
// Ergänzt role/aria-selected und Pfeiltasten-Navigation für bestehende Tabs.
// Die Klick-Logik bleibt unverändert; hier nur ARIA-Sync + Roving-Tabindex.
function enhanceTablist(list){
  const tabs=[...list.children].filter(c=>c.matches('button,div'));
  if(!tabs.length) return;
  const sync=()=>tabs.forEach(t=>{
    const on=t.classList.contains('active');
    t.setAttribute('role','tab');
    t.setAttribute('aria-selected',on?'true':'false');
    t.tabIndex=on?0:-1;
  });
  sync();
  // Nach jedem Klick ARIA aktualisieren (läuft nach den bestehenden Handlern)
  list.addEventListener('click',()=>requestAnimationFrame(sync));
  list.addEventListener('keydown',(e)=>{
    const i=tabs.indexOf(document.activeElement);
    if(i<0) return;
    let n=-1;
    if(e.key==='ArrowRight'||e.key==='ArrowDown') n=(i+1)%tabs.length;
    else if(e.key==='ArrowLeft'||e.key==='ArrowUp') n=(i-1+tabs.length)%tabs.length;
    else if(e.key==='Home') n=0;
    else if(e.key==='End') n=tabs.length-1;
    else if((e.key==='Enter'||e.key===' ')){ e.preventDefault(); tabs[i].click(); return; }
    else return;
    e.preventDefault();
    tabs[n].focus();
    tabs[n].click();
  });
}
document.querySelectorAll('.period-tabs,.ctabs').forEach(enhanceTablist);

// ── MODAL-FOCUS-TRAP ───────────────────────────────────────
// Hält Tab-Fokus innerhalb offener Modals und stellt den Fokus beim
// Schließen wieder her. Greift auf Archiv-Modal und Artist-Drilldown.
(()=>{
  let lastFocused=null;
  const SEL='a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])';
  const isOpen=m=>m&&m.classList.contains('open');
  const openModal=()=>document.getElementById('adm-overlay')?.classList.contains('open')
      ? document.getElementById('adm-overlay')
      : (document.getElementById('archive-modal')?.classList.contains('open')
          ? document.getElementById('archive-modal') : null);

  // Beim Öffnen Fokus merken + in die Box setzen (per MutationObserver auf class)
  ['archive-modal','adm-overlay'].forEach(id=>{
    const m=document.getElementById(id);
    if(!m) return;
    let wasOpen=isOpen(m);
    new MutationObserver(()=>{
      const now=isOpen(m);
      if(now&&!wasOpen){
        lastFocused=document.activeElement;
        const first=m.querySelector(SEL);
        if(first) requestAnimationFrame(()=>first.focus());
      }else if(!now&&wasOpen){
        if(lastFocused&&typeof lastFocused.focus==='function') lastFocused.focus();
      }
      wasOpen=now;
    }).observe(m,{attributes:true,attributeFilter:['class']});
  });

  // Tab innerhalb des offenen Modals einfangen
  document.addEventListener('keydown',(e)=>{
    if(e.key!=='Tab') return;
    const m=openModal();
    if(!m) return;
    const f=[...m.querySelectorAll(SEL)].filter(el=>el.offsetParent!==null);
    if(!f.length) return;
    const first=f[0],last=f[f.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  });
})();

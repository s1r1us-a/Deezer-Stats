const USER='s1r1us-a',KEY='b126713de975c43a7a8f046bcf954884',API='https://ws.audioscrobbler.com/2.0/';
const CACHE_KEY='lfm_cache_s1r1us_v3';
const C=ScrobbleCore;

// ── HELPERS ────────────────────────────────────────────────
function escapeHTML(str){
  if(!str&&str!==0) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── VAULT-FARBEN ───────────────────────────────────────────
// Alle Farben kommen aus den Tokens in css/vault-tokens.css (Apple Glass
// Light + Layer8). Canvas kann keine CSS-Variablen auflösen, deshalb werden
// sie hier einmal gelesen und bei jedem Theme-Wechsel neu geholt.
let _chartColors=null;
function hexA(hex,a){
  const h=String(hex).trim().replace('#','');
  if(!/^[0-9a-f]{6}$/i.test(h)) return hex;
  const n=parseInt(h,16);
  return `rgba(${n>>16&255},${n>>8&255},${n&255},${a})`;
}
function chartColors(){
  if(_chartColors) return _chartColors;
  const s=getComputedStyle(document.documentElement);
  const v=(name,fb)=>s.getPropertyValue(name).trim()||fb;
  const fontFam=v('--font','-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif');
  const accent=v('--ag-display-blue','#0a84ff');
  const series=[
    v('--ag-display-blue','#0a84ff'),v('--ag-display-indigo','#5e5ce6'),v('--ag-display-purple','#bf5af2'),
    v('--ag-display-pink','#ff375f'),v('--ag-display-teal','#64d2ff'),v('--ag-display-orange','#ff9f0a'),
    v('--ag-display-green','#30d158'),v('--ag-display-yellow','#ffd60a')
  ];
  const tick=v('--text-faint','#86868b');
  const grid=v('--chart-grid','rgba(32,38,49,.08)');
  const surface=v('--ag-surface','#ffffff');
  const tooltip={backgroundColor:surface,borderColor:v('--ag-line-strong','rgba(32,38,49,.15)'),borderWidth:1,
    titleColor:v('--text','#1d1d1f'),bodyColor:v('--text-dim','#6e6e73'),
    titleFont:{family:fontFam,weight:'700'},bodyFont:{family:fontFam},cornerRadius:10,padding:10};
  _chartColors={accent,indigo:series[1],series,other:v('--text-faint','#86868b'),tick,grid,surface,tooltip,fontFam};
  return _chartColors;
}

// Beim Theme-Wechsel: Farben neu lesen und alle Chart-Instanzen neu zeichnen
window.applyChartTheme=function(){
  _chartColors=null;
  let insts;
  try{insts=[monthlyInst,pieInst,trendInst];}catch(e){return;}
  if(insts.some(Boolean)){
    try{renderMonthlyChart();}catch(e){}
    try{loadPie();}catch(e){}
    try{loadTrend();}catch(e){}
  }
};

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

// Chart.js global auf System-Font umstellen (Apple-Look)
if(window.Chart){Chart.defaults.font.family='-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif';}

let cache={},chartPeriod='today',chartTab='artists',sortMode='plays',allItems=[],showCount=10;

// ── ARCHIV (Firebase) ─────────────────────────────────────
// Das Archiv ist die gemeinsame Quelle fast aller Stats. Es wird einmal
// geladen; Syncs ändern es danach lokal (siehe sync.js), statt es neu
// herunterzuladen. archiveChanged() invalidiert alle abgeleiteten Caches.
let _archiveData=null;
let _archiveVersion=0;
let _archivePromise=null;
let _lastHeroData=null; // zuletzt gerenderte Hero-Meta für Re-Render nach Archiv-Load
function archiveList(){return C.toList(_archiveData,_archiveVersion);}
function archiveChanged(){
  _archiveVersion++;
  _chartCountCache={};
  Object.keys(cache).filter(k=>k.startsWith('top_')).forEach(k=>delete cache[k]);
}
async function getArchiveData(){
  if(_archiveData) return _archiveData;
  if(!_archivePromise){
    _archivePromise=db.ref('scrobbles').get().then(snap=>{
      if(!_archiveData) _archiveData=snap.exists()?snap.val():{};
      archiveChanged();
      C.Durations.recompute(archiveList());
      return _archiveData;
    }).catch(e=>{console.warn('Archiv-Load fehlgeschlagen:',e);_archivePromise=null;return null;});
  }
  return _archivePromise;
}
function hasArchive(){return archiveList().length>0;}
let cmpA='1month',cmpB='3month',selectedYear=null;
let monthlyInst=null,pieInst=null,trendInst=null;
let monthlyMode='12'; // '12' or 'lifetime'
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
// Nur langsam veränderliche Last.fm-Antworten (user.getInfo, Top-Listen, Tags)
// werden 30 Min in localStorage gehalten. user.getRecentTracks nie — sonst
// sind "Zuletzt gehört" & Co. nach einem Reload bis zu 30 Min alt.
const NO_PERSIST=['user.getRecentTracks','track.getInfo'];
function loadCache(){try{const d=localStorage.getItem(CACHE_KEY);if(d){const p=JSON.parse(d);const age=(Date.now()-p.ts)/60000;if(age<30){cache=p.data||{};document.getElementById('cache-info').textContent='Cache: vor '+Math.round(age)+' Min';}}}catch(e){}}
function saveCache(){try{const keep={};Object.keys(cache).forEach(k=>{if(!k.startsWith('top_')&&!NO_PERSIST.some(p=>k.startsWith(p))) keep[k]=cache[k];});localStorage.setItem(CACHE_KEY,JSON.stringify({ts:Date.now(),data:keep}));}catch(e){}}


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

// Zentrierter, wiederverwendbarer Empty-State mit Luna-Motiv (Sichel,
// Sternbild). Fehler bekommen bewusst kein Schmuckbild.
function emptyState(msg,kind='moon'){
  return `<div class="empty-state is-${kind}"><div class="empty-ico" aria-hidden="true"></div><div class="empty-msg">${escapeHTML(msg)}</div></div>`;
}
const noArchiveState=()=>emptyState('Noch kein Archiv — im Archiv-Dialog den vollständigen Import starten.','stars');

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
    el.textContent=isFloat?val.toLocaleString('de-DE',{minimumFractionDigits:1,maximumFractionDigits:1}):fmt(Math.round(val));
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
    if(avEl) avEl.outerHTML=`<img src="${img}" width="84" height="84" class="hero-avatar-img" alt="Avatar" id="avatar-el">`;
    document.getElementById('hero-bg').style.backgroundImage=`url(${img})`;
    document.getElementById('hero-bg').style.opacity='0.08';
  }
  document.getElementById('hero-rn').textContent=meta.realname||'';
  const joined=meta.registered_uts?new Date(meta.registered_uts*1000):null;
  const days=joined?Math.floor((Date.now()-joined)/86400000):0;
  // Scrobble-Gesamtzahl: bevorzugt aus Firebase-Archiv (offline-fähig & konsistent)
  const archiveCount=hasArchive()?archiveList().length:null;
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
    total=hasArchive()?archiveList().length:(parseInt(cached.playcount)||0);
  } else {
    // Weder Cache noch Last.fm — minimal-Fallback
    joined=new Date();days=0;total=hasArchive()?archiveList().length:0;
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
// Alle Werte aus dem Archiv (Last.fm nur als Fallback ohne Archiv).
function listeningInfo(list){
  if(!list.length) return {mins:0,coverage:0};
  return {mins:C.Durations.total(list)/60,coverage:C.Durations.coverage(list)};
}
function coverageNote(cov){
  if(!hasArchive()) return 'geschätzt';
  const p=Math.round(cov*100);
  return p>=99?'echte Track-Längen':p>0?`${p} % echte Längen`:'geschätzt (Längen laden…)';
}
const fmtLen=sec=>{const s=Math.round(sec);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')+' Min';};
function renderOverview({total,days,u}){
  const list=archiveList();
  const arch=list.length>0;
  const totalFinal=arch?list.length:(parseInt(total)||0);
  const disc=getArchiveDiscoveryCounts();
  const artistC=disc?disc.artist_count:(parseInt(u?.artist_count)||0);
  const trackC=disc?disc.track_count:(parseInt(u?.track_count)||0);
  const albumC=disc?disc.album_count:(parseInt(u?.album_count)||0);
  const li=arch?listeningInfo(list):{mins:totalFinal*3.5,coverage:0};
  const safedays=days>0?days:1;
  const activeDays=arch?new Set(list.map(e=>C.dayKey(new Date(e.ts*1000)))).size:null;
  const g=document.getElementById('overview-grid');
  g.innerHTML=`
    <div class="mc hi" style="--cc:var(--ag-display-blue)"><div class="mc-label">Gesamt Scrobbles</div><div class="mc-val pink counter" id="cnt-total">0</div><div class="mc-sub">${arch?'aus dem Archiv':'laut Last.fm'}</div></div>
    <div class="mc" style="--cc:var(--ag-display-indigo)"><div class="mc-label">Hörzeit</div><div class="mc-val" id="mc-time-val">${fmtHours(li.mins)}</div><div class="mc-sub" id="mc-time-sub">≈ ${fmtTime(li.mins/safedays)} / Tag · ${coverageNote(li.coverage)}</div></div>
    <div class="mc" style="--cc:var(--ag-display-purple)"><div class="mc-label">Ø pro Tag</div><div class="mc-val counter" id="cnt-day">0</div><div class="mc-sub">seit Registrierung</div></div>
    <div class="mc" style="--cc:var(--ag-display-pink)"><div class="mc-label">Ø pro Woche</div><div class="mc-val counter" id="cnt-week">0</div></div>
    <div class="mc" style="--cc:var(--ag-display-teal)"><div class="mc-label">Ø pro Monat</div><div class="mc-val counter" id="cnt-month">0</div></div>
    <div class="mc" style="--cc:var(--ag-display-orange)"><div class="mc-label">Heute gehört</div><div class="mc-val" id="mc-today-time">—</div><div class="mc-sub" id="mc-today-sub">wird geladen…</div></div>
    <div class="mc" style="--cc:var(--ag-display-green)"><div class="mc-label">Aktive Tage</div><div class="mc-val counter" id="cnt-days">0</div><div class="mc-sub">${activeDays!==null?`von ${fmt(days)} Tagen seit Registrierung`:'Archiv fehlt'}</div></div>
    <div class="mc" style="--cc:var(--ag-display-blue)"><div class="mc-label">Entdeckte Künstler</div><div class="mc-val counter" id="cnt-artists">0</div></div>
    <div class="mc" style="--cc:var(--ag-display-indigo)"><div class="mc-label">Entdeckte Tracks</div><div class="mc-val counter" id="cnt-tracks">0</div></div>
    <div class="mc" style="--cc:var(--ag-display-purple)"><div class="mc-label">Entdeckte Alben</div><div class="mc-val counter" id="cnt-albums">0</div></div>
    <div class="mc" style="--cc:var(--ag-display-pink)"><div class="mc-label">Ø Tracklänge</div><div class="mc-val" id="mc-avglen">${fmtLen(totalFinal?li.mins*60/totalFinal:210)}</div><div class="mc-sub">pro Scrobble</div></div>
  `;
  setTimeout(()=>{
    animateCounter(document.getElementById('cnt-total'),totalFinal);
    animateCounter(document.getElementById('cnt-day'),parseFloat((totalFinal/safedays).toFixed(1)));
    animateCounter(document.getElementById('cnt-week'),Math.round(totalFinal/(safedays/7)));
    animateCounter(document.getElementById('cnt-month'),Math.round(totalFinal/(safedays/30.44)));
    animateCounter(document.getElementById('cnt-days'),activeDays||0);
    animateCounter(document.getElementById('cnt-artists'),artistC);
    animateCounter(document.getElementById('cnt-tracks'),trackC);
    animateCounter(document.getElementById('cnt-albums'),albumC);
    updateTodayTime();
  },100);
}

// Nur die zeitabhängigen Kacheln aktualisieren (nach dem Laden neuer Track-Längen)
let _durUiT=0;
function onDurationsUpdated(force=false){
  if(!force&&Date.now()-_durUiT<20000) return;
  _durUiT=Date.now();
  const list=archiveList();
  if(!list.length) return;
  const li=listeningInfo(list);
  const days=_lastHeroData?._days||1;
  const v=document.getElementById('mc-time-val'),s=document.getElementById('mc-time-sub');
  if(v) v.textContent=fmtHours(li.mins);
  if(s) s.textContent=`≈ ${fmtTime(li.mins/Math.max(days,1))} / Tag · ${coverageNote(li.coverage)}`;
  const al=document.getElementById('mc-avglen');
  if(al) al.textContent=fmtLen(li.mins*60/list.length);
  updateTodayTime();
  const yr=document.getElementById('yr-total-sub');
  if(yr&&selectedYear){
    const sl=C.slice(list,C.sec(new Date(selectedYear,0,1)),C.sec(new Date(selectedYear+1,0,1)));
    yr.textContent=`Scrobbles · ≈ ${fmtHours(C.Durations.total(sl)/60)} Hörzeit`;
  }
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
  const today=C.slice(archiveList(),C.sec(C.midnight()));
  const mins=C.Durations.total(today)/60;
  if(mins<60){
    animateTodayCounter(el,Math.round(mins),' Min');
  } else {
    const h=Math.floor(mins/60);
    const m=Math.round(mins%60);
    animateTodayCounter(el,h,m>0?` Std ${m} Min`:' Std');
  }
  if(sub) sub.textContent=`${fmt(today.length)} Scrobbles heute`;
}

// ── DIVERSITY ──────────────────────────────────────────────
async function renderDiversity(){
  const el=document.getElementById('diversity-content');
  await getArchiveData();
  const list=archiveList();
  const tagData=await lfmSafe('user.getTopTags',{limit:20});
  if(!list.length){el.innerHTML=noArchiveState();return;}
  const artists=C.aggregate(list,'artists');
  const total=artists.reduce((s,a)=>s+a.playcount,0)||1;

  // Herfindahl-Index über ALLE Künstler (vorher nur Top-50 → zu optimistisch)
  const hhi=artists.reduce((s,a)=>{const sh=a.playcount/total;return s+sh*sh;},0);
  const score=Math.round((1-hhi)*100);
  const effective=Math.round(1/hhi);
  const label=score>95?'Sehr vielseitig':score>85?'Vielseitig':score>70?'Ausgewogen':score>50?'Fokussiert':'Sehr fokussiert';

  const NOISE=['seen live','favorites','favourite','my favorites','love','loved','awesome','good','best','all','music','new'];
  const tags=(tagData?.toptags?.tag||[])
    .filter(t=>!NOISE.some(n=>t.name.toLowerCase().includes(n)))
    .slice(0,12);
  const maxTagCount=parseInt(tags[0]?.count)||1;
  const top3Tags=tags.slice(0,3).map(t=>escapeHTML(t.name));
  const mid3Tags=tags.slice(3,6).map(t=>escapeHTML(t.name));
  let summary='';
  if(top3Tags.length){
    summary=`Du hörst hauptsächlich <strong>${top3Tags.join(', ')}</strong>`;
    if(mid3Tags.length) summary+=` — gelegentlich auch <em>${mid3Tags.join(', ')}</em>`;
    summary+='.';
  }

  const top5=artists.slice(0,5);
  const maxPct=top5[0].playcount/total*100;
  const cards=top5.map((a,i)=>{
    const pct=a.playcount/total*100;
    const barW=(pct/maxPct*100).toFixed(1);
    return `<div class="top5-card ${i<3?'rank-'+(i+1):''}" data-artist="${escapeHTML(a.name)}" tabindex="0" role="button">
      <div class="top5-rank r${i+1}">${i+1}</div>
      <div class="top5-info">
        <div class="top5-name">${escapeHTML(a.name)}</div>
        <div class="top5-meta">${fmt(a.playcount)} Plays</div>
      </div>
      <div class="top5-bar-wrap">
        <div class="top5-bar-c"><div class="top5-bar-f" style="width:${barW}%"></div></div>
        <div class="top5-pct">${pct.toFixed(1)} %</div>
      </div>
    </div>`;
  }).join('');

  el.innerHTML=`
    <div class="div-head">
      <div class="mc hi" style="--cc:var(--ag-display-purple)">
        <div class="mc-label">Diversitäts-Score</div>
        <div class="mc-val pink">${score}/100</div>
        <div class="mc-sub">${label} · ≈ ${fmt(effective)} „effektive“ Künstler</div>
      </div>
      <div>
        <div class="div-meter"><div class="div-fill" style="width:${score}%"></div></div>
        <div class="kicker-note">Herfindahl-Index · alle ${fmt(artists.length)} Künstler aus dem Archiv</div>
        ${summary?`<p class="div-summary">${summary}</p>`:''}
      </div>
    </div>
    ${tags.length?`
    <div class="div-block">
      <div class="kicker">Genre-Verteilung <span class="kicker-src">laut Last.fm-Tags</span></div>
      <div class="tags-wrap">
        ${tags.map(t=>{
          const rel=Math.round(parseInt(t.count)/maxTagCount*100);
          return `<span class="tag ${rel>75?'lg':rel>40?'':'sm'}" title="${fmt(t.count)} Gewichtung">${escapeHTML(t.name)}</span>`;
        }).join('')}
      </div>
    </div>`:''}
    <div class="div-block">
      <div class="kicker">Top-5 Künstler · Anteil an allen ${fmt(total)} Scrobbles</div>
      <div class="top5-grid" id="top5-cards">${cards}</div>
    </div>
  `;
  el.querySelectorAll('.top5-card[data-artist]').forEach(c=>{
    const open=()=>openArtistDrillDown(c.dataset.artist,'overall');
    c.addEventListener('click',open);
    c.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});
  });
}

// ── TOP CHARTS ─────────────────────────────────────────────
function chartItems(period,tab){
  const {from,to}=C.periodRange(period);
  return C.aggregate(C.slice(archiveList(),from,to),tab);
}

async function loadCharts(){
  const key=chartTab+'_'+chartPeriod;
  const volatile=chartPeriod==='today'||chartPeriod==='yesterday';
  let items=volatile?null:cache['top_'+key];
  if(!Array.isArray(items)){
    if(!_archiveData){
      document.getElementById('charts-list').innerHTML='<div class="ld"><div class="sp"></div> Lade...</div>';
      document.getElementById('show-more-btn').style.display='none';
    }
    await getArchiveData();
    if(!hasArchive()){
      allItems=[];
      document.getElementById('charts-list').innerHTML=noArchiveState();
      document.getElementById('show-more-btn').style.display='none';
      return;
    }
    items=chartItems(chartPeriod,chartTab);
    if(!volatile) cache['top_'+key]=items;
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
  document.getElementById('charts-list').innerHTML=html?`<div class="rlist">${html}</div>`:emptyState(q?'Keine Treffer für „'+q+'“.':'Noch keine Daten für diesen Zeitraum.',q?'search':'moon');
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

// ── MONATS-CHART (12 Monate / Lifetime) ────────────────────
// Beide Modi zählen direkt im Archiv — die frühere Firebase-Tabelle
// `monthly` konnte Monate bei einem API-Fehler dauerhaft auf 0 setzen.
function monthlyRange(){
  const now=new Date();
  if(monthlyMode!=='lifetime'){
    const s=new Date(now.getFullYear(),now.getMonth()-11,1);
    return C.monthsBetween(s.getFullYear(),s.getMonth());
  }
  const list=archiveList();
  let start=list.length?new Date(list[0].ts*1000):now;
  const reg=_lastHeroData?.registered_uts?new Date(_lastHeroData.registered_uts*1000):null;
  if(reg&&reg<start) start=reg;
  return C.monthsBetween(start.getFullYear(),start.getMonth());
}

function renderMonthlyChart(counts){
  const months=monthlyRange();
  const list=archiveList();
  const data=counts||months.map(m=>C.slice(list,m.from,m.to).length);
  const labels=months.map(m=>new Date(m.y,m.m,1).toLocaleDateString('de-DE',{month:'short',year:'2-digit'}));
  const cc=chartColors();
  const lifetime=monthlyMode==='lifetime';
  if(monthlyInst) monthlyInst.destroy();
  monthlyInst=new Chart(document.getElementById('monthlyChart'),{
    type:'bar',
    data:{labels,datasets:[{label:'Scrobbles',data,
      backgroundColor:data.map((_,i)=>i===data.length-1?cc.accent:hexA(cc.accent,.34)),
      hoverBackgroundColor:cc.indigo,
      borderRadius:lifetime?2:5,borderWidth:0}]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{...cc.tooltip,callbacks:{label:c=>' '+fmt(c.parsed.y)+' Scrobbles'}}},
      scales:{
        x:{ticks:Object.assign({color:cc.tick,font:{size:lifetime?8:9},maxRotation:lifetime?90:45},lifetime?{callback:(v,i)=>i%3===0?labels[i]:''}:{}),grid:{display:false},border:{display:false}},
        y:{ticks:{color:cc.tick,font:{size:9},callback:v=>fmt(v)},grid:{color:cc.grid},border:{display:false}}}}
  });
  const statsEl=document.getElementById('lifetime-stats');
  if(statsEl&&lifetime&&data.length){
    const total=data.reduce((s,v)=>s+v,0);
    const best=Math.max(...data);
    statsEl.innerHTML=`
      <div class="mc" style="--cc:var(--ag-display-blue)"><div class="mc-label">Lifetime Scrobbles</div><div class="mc-val">${fmt(total)}</div></div>
      <div class="mc" style="--cc:var(--ag-display-purple)"><div class="mc-label">Bester Monat</div><div class="mc-val" style="font-size:18px;">${labels[data.indexOf(best)]}</div><div class="mc-sub">${fmt(best)} Scrobbles</div></div>
      <div class="mc" style="--cc:var(--ag-display-pink)"><div class="mc-label">Ø pro Monat</div><div class="mc-val">${fmt(Math.round(total/data.length))}</div></div>`;
  }
}

async function loadMonthly(){
  await getArchiveData();
  const statsEl=document.getElementById('lifetime-stats');
  if(statsEl) statsEl.style.display=monthlyMode==='lifetime'?'grid':'none';
  if(hasArchive()) return renderMonthlyChart();
  // Ohne Archiv: 12 Monate über Last.fm-Totals (1 Call pro Monat)
  const months=monthlyRange();
  const counts=await Promise.all(months.map(m=>
    lfm('user.getRecentTracks',{from:m.from,to:m.to-1,limit:1})
      .then(d=>parseInt(d?.recenttracks?.['@attr']?.total||0)).catch(()=>0)));
  renderMonthlyChart(counts);
}

// ── PIE CHART ──────────────────────────────────────────────
// Anteil an ALLEN Scrobbles (vorher: nur relativ zu den Top 7).
async function loadPie(){
  await getArchiveData();
  const legend=document.getElementById('pie-legend');
  if(!hasArchive()){legend.innerHTML=noArchiveState();return;}
  const artists=C.aggregate(archiveList(),'artists');
  const total=artists.reduce((s,a)=>s+a.playcount,0)||1;
  const top=artists.slice(0,7);
  const rest=total-top.reduce((s,a)=>s+a.playcount,0);
  const cc=chartColors();
  const labels=top.map(a=>a.name),values=top.map(a=>a.playcount),colors=cc.series.slice(0,top.length);
  if(rest>0){labels.push('Andere');values.push(rest);colors.push(hexA(cc.other,.35));}
  if(pieInst) pieInst.destroy();
  pieInst=new Chart(document.getElementById('pieChart'),{
    type:'doughnut',
    data:{labels,datasets:[{data:values,backgroundColor:colors,borderColor:cc.surface,borderWidth:3,hoverOffset:6}]},
    options:{responsive:true,maintainAspectRatio:false,cutout:'62%',
      plugins:{legend:{display:false},tooltip:{...cc.tooltip,
        callbacks:{label:c=>` ${fmt(c.parsed)} Plays (${(c.parsed/total*100).toFixed(1)} %)`}}}}
  });
  legend.innerHTML=labels.map((n,i)=>
    `<span class="legend-item"><span class="legend-dot" style="background:${colors[i]}"></span>${escapeHTML(n)} <b>${(values[i]/total*100).toFixed(1)} %</b></span>`).join('');
}

// ── ACTIVITY DATA (Weekday + Clock) ────────────────────────
// Letzte 30 Tage aus dem Archiv; ohne Archiv aus den letzten 200 Scrobbles.
async function loadActivityData(fallbackTracks){
  await getArchiveData();
  const days=30;
  const fromTs=Math.floor(Date.now()/1000)-days*86400;
  const counts=new Array(7).fill(0);
  const hours=new Array(24).fill(0);
  let total=0;
  for(const e of C.slice(archiveList(),fromTs)){
    const d=new Date(e.ts*1000);
    counts[(d.getDay()+6)%7]++;
    hours[d.getHours()]++;
    total++;
  }
  if(total>0) return {counts,hours,total,label:`Letzte ${days} Tage · ${fmt(total)} gesamt`};

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
  return {counts,hours,total,label:`Letzte ${tracks.length} Scrobbles · ${fmt(total)} gesamt`};
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
    subLabel=m?m[0].trim():'Aktivität';
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
        <div class="wd-c" style="opacity:${c>0?1:0.3};color:${isMx?'var(--peak)':'var(--text2)'};">${c>0?pct+'%':'—'}</div>
        <div class="wd-b ${isMx?'mx':''}" style="height:${barH}px;opacity:${c===0?0.18:isMx?1:0.55};border-radius:3px 3px 0 0;" title="${days[i]}: ${fmt(c)} Plays${c>0?' ('+pct+'%)':''}"></div>
        <div class="wd-l" style="opacity:${c===0?0.35:1};color:${isMx?'var(--peak)':'var(--text3)'};">${days[i]}</div>
      </div>`;
    }).join('')}</div>
    <div class="chart-foot">
      <span>${fmt(total)} Plays gesamt</span>
      ${max>0?`<span class="peak">Peak: ${topDay} · ${fmt(max)} Plays</span>`:''}
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
    subLabel=m?m[0].trim():'Aktivität';
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
      <div class="wd-c" style="opacity:${showPct?(isMx?1:0.85):0};color:${isMx?'var(--peak)':'var(--text2)'};min-height:14px;">${showPct?Math.round(pct)+'%':''}</div>
      <div class="wd-b ${isMx?'mx':''}" style="height:${barH}px;opacity:${c===0?0.18:isMx?1:0.55};border-radius:3px 3px 0 0;transition:opacity .15s;"></div>
      <div class="wd-l" style="opacity:${showLabel?(isMx?1:0.75):0.35};color:${isMx?'var(--peak)':'var(--text3)'};">${showLabel?String(i).padStart(2,'0'):'·'}</div>
    </div>`;
  }).join('');

  document.getElementById('hour-chart').innerHTML=`
    <div class="wd-bars" id="hour-bars" style="height:140px;align-items:flex-end;padding-bottom:0;gap:4px;">${bars}</div>
    <div class="chart-foot">
      <span>${fmt(total)} Plays gesamt</span>
      ${max>0?`<span class="peak">Peak: ${String(peakHour).padStart(2,'0')}:00 · ${fmt(max)} Plays</span>`:''}
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
    tooltip.innerHTML=`<span class="tt-head">${String(hour).padStart(2,'0')}:00 – ${String((hour+1)%24).padStart(2,'0')}:00</span><br>${fmt(count)} Plays · ${pct}%`;
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

// Heatmap-Stufe 0–4 relativ zum Maximum (Farben: CSS .lv1–.lv4)
function heatLevel(c,max){
  if(!c) return 0;
  const p=c/max;
  return p<.25?1:p<.5?2:p<.75?3:4;
}

// ── TAG×STUNDE-HEATMAP (7×24, aus Archiv) ──────────────────
async function renderDayHourHeatmap(){
  const cont=document.getElementById('dayhour-chart');
  if(!cont) return;
  try{
    await getArchiveData();
    const list=archiveList();
    if(!list.length){cont.innerHTML=noArchiveState(); return;}
    const days=['Mo','Di','Mi','Do','Fr','Sa','So'];
    const matrix=Array.from({length:7},()=>new Array(24).fill(0));
    let max=0,peakDay=0,peakHr=0;
    for(const e of list){
      const d=new Date(e.ts*1000);
      const day=(d.getDay()+6)%7, hr=d.getHours();
      const v=++matrix[day][hr];
      if(v>max){max=v;peakDay=day;peakHr=hr;}
    }
    const hourLabels=[0,6,12,18];
    let grid='';
    for(let dd=0;dd<7;dd++){
      grid+=`<div class="dh-row"><div class="dh-day">${days[dd]}</div>`+
        matrix[dd].map((c,hh)=>`<div class="dh-cell lv${heatLevel(c,max)}" title="${days[dd]} ${String(hh).padStart(2,'0')}:00 · ${fmt(c)} Plays"></div>`).join('')+
        `</div>`;
    }
    grid+=`<div class="dh-row dh-axis"><div class="dh-day"></div>`+
      Array.from({length:24},(_,hh)=>`<div class="dh-cell dh-axis-lbl">${hourLabels.includes(hh)?String(hh).padStart(2,'0'):''}</div>`).join('')+`</div>`;
    cont.innerHTML=`<div class="dh-scroll"><div class="dh-grid">${grid}</div></div>
      <div class="chart-foot"><span>${fmt(list.length)} Plays gesamt</span><span class="peak">Peak: ${days[peakDay]} ${String(peakHr).padStart(2,'0')}:00</span></div>`;
  }catch(e){console.warn('DayHour-Heatmap fehlgeschlagen:',e); cont.innerHTML=emptyState('Heatmap konnte nicht geladen werden.','error');}
}

// ── YEAR-OVER-YEAR + Hochrechnung (aus Archiv) ─────────────
// Teiljahre (Start des Archivs, laufendes Jahr) werden gekennzeichnet und
// nicht prozentual verglichen — sonst entstehen Schein-Sprünge.
async function renderYoY(){
  const cont=document.getElementById('yoy-content');
  if(!cont) return;
  try{
    await getArchiveData();
    const list=archiveList();
    if(!list.length){cont.innerHTML=noArchiveState(); return;}
    const months=['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
    const byYear={};
    for(const e of list){
      const d=new Date(e.ts*1000), y=d.getFullYear();
      if(!byYear[y]) byYear[y]={total:0,months:new Array(12).fill(0)};
      byYear[y].total++; byYear[y].months[d.getMonth()]++;
    }
    const first=new Date(list[0].ts*1000);
    const firstPartial=first>new Date(first.getFullYear(),0,15);
    const nowY=new Date().getFullYear();
    const isPartial=y=>y===nowY||(y===first.getFullYear()&&firstPartial);
    const years=Object.keys(byYear).map(Number).sort((a,b)=>b-a);
    const maxTotal=Math.max(...years.map(y=>byYear[y].total))||1;
    const diffHtml=(a,b)=>{
      const diff=Math.round((a-b)/b*100);
      return `<span class="${diff>=0?'up':'down'}">${diff>=0?'▲':'▼'} ${Math.abs(diff)} %</span>`;
    };
    let projHtml='';
    if(byYear[nowY]){
      const start=new Date(nowY,0,1);
      const daysInYear=(new Date(nowY+1,0,1)-start)/864e5;
      const dayOfYear=(Date.now()-start.getTime())/864e5;
      const proj=Math.round(byYear[nowY].total/Math.max(dayOfYear,1)*daysInYear);
      const prev=byYear[nowY-1];
      const cmp=prev&&!isPartial(nowY-1)?` ${diffHtml(proj,prev.total)} vs ${nowY-1}`:'';
      projHtml=`<div class="yoy-proj">📈 Hochrechnung ${nowY}: <b>${fmt(proj)}</b> Scrobbles${cmp}</div>`;
    }
    const rows=years.map(y=>{
      const info=byYear[y];
      const peakM=months[info.months.indexOf(Math.max(...info.months))];
      const prev=byYear[y-1];
      let meta='';
      if(y===nowY) meta='<span class="yoy-tag">läuft</span> · ';
      else if(isPartial(y)) meta='<span class="yoy-tag">Teiljahr</span> · ';
      else if(prev&&!isPartial(y-1)) meta=diffHtml(info.total,prev.total)+' · ';
      const w=Math.round(info.total/maxTotal*100);
      return `<div class="yoy-row">
        <div class="yoy-year">${y}</div>
        <div class="yoy-bar-c"><div class="yoy-bar-f" style="width:${w}%"></div></div>
        <div class="yoy-val">${fmt(info.total)}</div>
        <div class="yoy-meta">${meta}Peak ${peakM}</div>
      </div>`;
    }).join('');
    cont.innerHTML=`${projHtml}<div class="yoy-list">${rows}</div>`;
  }catch(e){console.warn('YoY fehlgeschlagen:',e); cont.innerHTML=emptyState('Konnte Jahresvergleich nicht laden.','error');}
}

// ── TREND CHART ────────────────────────────────────────────
// Top-3 der letzten 12 Monate (vorher Last.fm-Gesamt-Top-3), Verlauf aus dem Archiv.
async function loadTrend(){
  await getArchiveData();
  const canvas=document.getElementById('trendChart');
  const now=new Date();
  const s=new Date(now.getFullYear(),now.getMonth()-11,1);
  const months=C.monthsBetween(s.getFullYear(),s.getMonth());
  const window12=C.slice(archiveList(),months[0].from);
  const top3=C.aggregate(window12,'artists').slice(0,3);
  document.getElementById('trend-legend')?.remove();
  if(!top3.length){ if(trendInst){trendInst.destroy();trendInst=null;} return; }
  const labels=months.map(m=>new Date(m.y,m.m,1).toLocaleDateString('de-DE',{month:'short',year:'2-digit'}));
  const cc=chartColors();
  const colors=[cc.series[0],cc.series[2],cc.series[3]];
  const idx=new Map(top3.map((a,i)=>[a.key,i]));
  const datasets=top3.map((a,i)=>({label:a.name,data:new Array(months.length).fill(0),
    borderColor:colors[i],backgroundColor:hexA(colors[i],.12),fill:false,
    borderWidth:2.5,tension:0.35,pointRadius:3,pointBackgroundColor:colors[i]}));
  for(const e of window12){
    const ai=idx.get(e.artist.toLowerCase());
    if(ai===undefined) continue;
    const mi=months.findIndex(m=>e.ts>=m.from&&e.ts<m.to);
    if(mi>=0) datasets[ai].data[mi]++;
  }
  if(trendInst) trendInst.destroy();
  trendInst=new Chart(canvas,{
    type:'line',data:{labels,datasets},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{...cc.tooltip,callbacks:{label:c=>` ${c.dataset.label}: ${fmt(c.parsed.y)}`}}},
      scales:{x:{ticks:{color:cc.tick,font:{size:9},maxRotation:45},grid:{color:cc.grid},border:{display:false}},
               y:{ticks:{color:cc.tick,font:{size:9}},grid:{color:cc.grid},border:{display:false}}}}
  });
  const leg=document.createElement('div');
  leg.id='trend-legend';
  leg.className='chart-legend';
  leg.innerHTML=top3.map((a,i)=>`<span class="legend-item"><span class="legend-line" style="background:${colors[i]}"></span>${escapeHTML(a.name)}</span>`).join('');
  canvas.parentElement.after(leg);
}

// ── CALENDAR HEATMAP ───────────────────────────────────────
async function loadCalendar(){
  const now=new Date();
  const yearAgo=C.midnight(now);yearAgo.setFullYear(yearAgo.getFullYear()-1);yearAgo.setDate(yearAgo.getDate()+1);
  const dayMap={};
  await getArchiveData();
  if(!hasArchive()){document.getElementById('cal-container').innerHTML=noArchiveState();return;}
  for(const e of C.slice(archiveList(),C.sec(yearAgo))){
    const k=C.dayKey(new Date(e.ts*1000));
    dayMap[k]=(dayMap[k]||0)+1;
  }
  renderCalendar(dayMap,yearAgo,now);
}

function renderCalendar(dayMap,start,end){
  const vals=Object.values(dayMap).filter(v=>v>0);
  const maxVal=vals.length?Math.max(...vals):1;
  let cur=new Date(start);
  cur.setDate(cur.getDate()-cur.getDay()); // auf Sonntag ausrichten
  const weeks=[];let week=[];
  while(cur<=end||week.length>0){
    if(week.length===7){weeks.push(week);week=[];}
    const key=C.dayKey(cur);
    week.push({date:new Date(cur),count:dayMap[key]||0,inRange:cur>=start&&cur<=end,key});
    cur.setDate(cur.getDate()+1);
    if(cur>end&&week.length===7){weeks.push(week);week=[];break;}
    if(cur>end&&week.length>0){while(week.length<7)week.push(null);weeks.push(week);break;}
  }
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
  const bestKey=Object.keys(dayMap).find(k=>dayMap[k]===maxVal);
  const bestLabel=bestKey?new Date(bestKey+'T12:00').toLocaleDateString('de-DE',{day:'2-digit',month:'short',year:'numeric'}):'—';
  document.getElementById('cal-container').innerHTML=`
    <div class="cal-stats">
      <div class="mc" style="--cc:var(--ag-display-green)"><div class="mc-label">Aktive Tage</div><div class="mc-val">${fmt(vals.length)}</div><div class="mc-sub">in den letzten 12 Monaten</div></div>
      <div class="mc" style="--cc:var(--ag-display-pink)"><div class="mc-label">Stärkster Tag</div><div class="mc-val">${fmt(vals.length?maxVal:0)}</div><div class="mc-sub">Scrobbles · ${bestLabel}</div></div>
      <div class="mc" style="--cc:var(--ag-display-blue)"><div class="mc-label">12-Monats-Total</div><div class="mc-val">${fmt(vals.reduce((s,v)=>s+v,0))}</div></div>
    </div>
    <div class="cal-wrap">
      <div class="cal-frame">
        <div class="cal-wday-labels">${wdLabels.map((l,i)=>`<div class="cal-wday-label">${i%2===1?l:''}</div>`).join('')}</div>
        <div>
          <div class="cal-month-labels">${weeks.map((w,wi)=>{const ml=monthLabels.find(m=>m.wi===wi);return `<div class="cal-month-label">${ml?ml.label:''}</div>`;}).join('')}</div>
          <div class="cal-grid">${weeks.map(w=>`<div class="cal-week">${w.map(d=>{
            if(!d||!d.inRange) return '<div class="cal-day is-out"></div>';
            const tip=d.date.toLocaleDateString('de-DE',{weekday:'short',day:'2-digit',month:'short'})+': '+fmt(d.count)+' Scrobbles';
            return `<div class="cal-day lv${heatLevel(d.count,maxVal)}" data-tip="${tip}"></div>`;
          }).join('')}</div>`).join('')}</div>
        </div>
      </div>
    </div>`;
}

// ── STREAK ────────────────────────────────────────────────
async function loadStreak(){
  await getArchiveData();
  const list=archiveList();
  const daySet=new Set();
  let source='Archiv';
  if(list.length){
    for(const e of list) daySet.add(C.dayKey(new Date(e.ts*1000)));
  } else {
    source='API';
    const d=await lfmSafe('user.getRecentTracks',{limit:200});
    (d?.recenttracks?.track||[]).forEach(t=>{
      if(t['@attr']?.nowplaying) return;
      const ts=parseInt(t.date?.uts); if(ts) daySet.add(C.dayKey(new Date(ts*1000)));
    });
  }
  // Aktueller Streak: heute oder (falls heute noch nichts) ab gestern rückwärts
  let streak=0;const d=new Date();
  if(!daySet.has(C.dayKey(d))) d.setDate(d.getDate()-1);
  while(daySet.has(C.dayKey(d))){streak++;d.setDate(d.getDate()-1);}
  // Längster Streak
  const sorted=[...daySet].sort();
  let longest=0,run=0,prev=null;
  for(const k of sorted){
    const t=new Date(k+'T12:00');
    run=prev&&Math.round((t-prev)/864e5)===1?run+1:1;
    longest=Math.max(longest,run);prev=t;
  }
  const lastTs=list.length?list[list.length-1].ts:null;
  const lastStr=lastTs?new Date(lastTs*1000).toLocaleString('de-DE',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):(sorted.pop()||'—');
  document.getElementById('streak-content').innerHTML=`
    <div class="metric-grid">
      <div class="mc hi" style="--cc:var(--ag-display-pink)"><div class="mc-label">Aktueller Streak</div><div class="mc-val pink">${fmt(streak)}</div><div class="mc-sub">Tage in Folge</div></div>
      <div class="mc" style="--cc:var(--ag-display-purple)"><div class="mc-label">Längster Streak</div><div class="mc-val">${fmt(longest)}</div><div class="mc-sub">Tage in Folge</div></div>
      <div class="mc" style="--cc:var(--ag-display-green)"><div class="mc-label">Aktive Tage ${source==='Archiv'?'(gesamt)':'(letzte 200)'}</div><div class="mc-val">${fmt(daySet.size)}</div><div class="mc-sub">Tage mit Scrobbles</div></div>
      <div class="mc" style="--cc:var(--ag-display-blue)"><div class="mc-label">Letzter Scrobble</div><div class="mc-val" style="font-size:15px;">${lastStr}</div></div>
    </div>
    <div class="kicker-note" style="margin-top:12px;">${source==='Archiv'?`Basis: vollständiges Archiv (${fmt(list.length)} Scrobbles)`:'Basis: letzte 200 Scrobbles — für genaue Werte Archiv importieren'}</div>
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
  const el=document.getElementById('year-content');
  await getArchiveData();
  const list=archiveList();
  if(!list.length){el.innerHTML=noArchiveState();return;}
  const sl=C.slice(list,C.sec(new Date(year,0,1)),C.sec(new Date(year+1,0,1)));
  const artists=C.aggregate(sl,'artists').slice(0,5);
  const tracks=C.aggregate(sl,'tracks').slice(0,5);
  const albums=C.aggregate(sl,'albums').slice(0,5);
  function miniList(items,tab){
    if(!items.length) return emptyState('Keine Daten für '+year+'.');
    return items.map((item,i)=>{
      const sub=tab!=='artists'?escapeHTML(item.artist?.name||''):'';
      return `<div class="ri ri-compact">
        <span class="rn ${rankCls(i)}">${i+1}</span>
        <div class="ri-info"><div class="ri-name">${escapeHTML(item.name)}</div>${sub?`<div class="ri-sub">${sub}</div>`:''}</div>
        <span class="plays">${fmt(item.playcount)}</span>
      </div>`;
    }).join('');
  }
  el.innerHTML=`
    <div class="mc hi year-total" style="--cc:var(--ag-display-indigo)">
      <div class="mc-label">Gesamt ${year}</div>
      <div class="mc-val pink">${fmt(sl.length)}</div>
      <div class="mc-sub" id="yr-total-sub">Scrobbles · ≈ ${fmtHours(C.Durations.total(sl)/60)} Hörzeit</div>
    </div>
    <div class="g3">
      <div><div class="kicker">Top Künstler</div><div class="rlist">${miniList(artists,'artists')}</div></div>
      <div><div class="kicker">Top Tracks</div><div class="rlist">${miniList(tracks,'tracks')}</div></div>
      <div><div class="kicker">Top Alben</div><div class="rlist">${miniList(albums,'albums')}</div></div>
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
  const dupWarning=cmpA===cmpB?`<div class="callout is-warning">⚠ Beide Zeiträume sind identisch (${periodLabel[cmpA]}) — der Vergleich zeigt dieselben Daten.</div>`:'';
  function renderSide(side,label){
    return `<div class="cmp-side">
      <div class="cmp-title">${label}</div>
      <div class="kicker">Top Künstler</div>
      <div class="rlist" style="margin-bottom:14px;">${side.artists.slice(0,5).map((a,i)=>`<div class="ri" style="padding:6px 10px;"><span class="rn ${rankCls(i)}">${i+1}</span>${imgEl(a.image?.find(x=>x.size==='medium')?.['#text']||a.image?.[1]?.['#text'])}<div class="ri-info"><div class="ri-name">${escapeHTML(a.name)}</div></div><span class="plays">${fmt(parseInt(a.playcount||0))}</span></div>`).join('')}</div>
      <div class="kicker">Top Tracks</div>
      <div class="rlist">${side.tracks.slice(0,5).map((t,i)=>`<div class="ri" style="padding:6px 10px;"><span class="rn ${rankCls(i)}">${i+1}</span>${imgEl(t.image?.find(x=>x.size==='medium')?.['#text']||t.image?.[1]?.['#text'])}<div class="ri-info"><div class="ri-name">${escapeHTML(t.name)}</div><div class="ri-sub">${escapeHTML(t.artist?.name||'')}</div></div><span class="plays">${fmt(parseInt(t.playcount||0))}</span></div>`).join('')}</div>
    </div>`;
  }
  document.getElementById('compare-content').innerHTML=`${dupWarning}<div class="kicker-note" style="margin-bottom:12px;">Top-Listen laut Last.fm (mit Namens-Autokorrektur) — kann minimal von den Archiv-Charts abweichen.</div><div class="cmp-grid">${renderSide(sideA,periodLabel[cmpA])}${renderSide(sideB,periodLabel[cmpB])}</div>`;
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

// ── EXPORT PNG ─────────────────────────────────────────────
// modern-screenshot rendert per SVG/foreignObject mit echtem Browser-CSS —
// html2canvas (nicht mehr gepflegt) scheitert an color-mix() der Vault-Tokens.
async function exportPNG(){
  const btn=document.querySelector('.export-btn');
  btn.textContent='Wird erstellt...';btn.disabled=true;
  try{
    const bg=getComputedStyle(document.body).getPropertyValue('--bg').trim()||'#f7f8fb';
    const url=await modernScreenshot.domToPng(document.getElementById('hero-section'),{scale:2,backgroundColor:bg});
    const a=document.createElement('a');
    a.href=url;
    a.download='s1r1us-a-stats.png';
    a.click();
  }catch(e){console.error(e);showToast('Export fehlgeschlagen','err');}
  btn.textContent='↓ Export PNG';btn.disabled=false;
}

// ── CHARTS TRACK COUNT ────────────────────────────────────
let _chartCountCache={};
async function updateChartsTrackCount(){
  const el=document.getElementById('charts-track-count');
  if(!el) return;
  await getArchiveData();
  if(!hasArchive()){el.style.display='none';return;}
  const {from,to}=C.periodRange(chartPeriod);
  const n=C.slice(archiveList(),from,to).length;
  el.textContent=`${fmt(n)} Scrobbles · ${PERIOD_LABEL[chartPeriod]||chartPeriod}`;
  el.style.display='block';
}

// ── EVENT LISTENERS ────────────────────────────────────────
document.getElementById('monthly-mode-tabs').querySelectorAll('.pb').forEach(b=>b.addEventListener('click',()=>{
  document.getElementById('monthly-mode-tabs').querySelectorAll('.pb').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  monthlyMode=b.dataset.m;
  document.getElementById('monthly-chart-label').textContent=monthlyMode==='lifetime'?'Scrobbles Lifetime':'Scrobbles pro Monat (12 Monate)';
  loadMonthly();
}));

document.getElementById('chart-periods').querySelectorAll('.pb').forEach(b=>b.addEventListener('click',()=>{
  document.getElementById('chart-periods').querySelectorAll('.pb').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  chartPeriod=b.dataset.p;
  showCount=10;
  updateChartsTrackCount();
  loadCharts();
}));
document.querySelectorAll('#charts-sec .ctab').forEach(t=>t.addEventListener('click',()=>{
  document.querySelectorAll('#charts-sec .ctab').forEach(x=>x.classList.remove('active'));
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
function getArchiveDiscoveryCounts(){
  return hasArchive()?C.uniqueCounts(archiveList()):null;
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
// Aktualisiert alle vom Archiv abhängigen Ansichten ohne Page-Reload.
// Mehrere gleichzeitige Aufrufe werden zu einem zusammengefasst.
let _refreshRunning=null;
async function refreshAfterSync(){
  if(_refreshRunning) return _refreshRunning;
  _refreshRunning=(async()=>{
    try{
      Object.keys(cache).forEach(k=>{if(/^user\.(getRecentTracks|getInfo|getTop)/.test(k)) delete cache[k];});
      archiveChanged();
      C.Durations.recompute(archiveList());
      if(_lastHeroData){
        renderHero(_lastHeroData,isLfmDown());
        renderOverview({total:_lastHeroData.playcount||0,days:_lastHeroData._days||0,u:_lastHeroData});
      }
      try{window._lastRecentTracks=await loadRecent();}catch(e){}
      renderArchiveViews();
      loadNowPlayingCard();
    }catch(e){console.warn('refreshAfterSync failed:',e);}
    finally{_refreshRunning=null;}
  })();
  return _refreshRunning;
}

// Alle Sektionen, die aus dem Archiv rechnen
function renderArchiveViews(){
  const safe=(fn)=>{try{const r=fn();if(r&&r.catch)r.catch(e=>console.warn(e));}catch(e){console.warn(e);}};
  safe(updateTodayTime);
  safe(loadStreak);
  safe(loadCharts);
  safe(updateChartsTrackCount);
  safe(renderDiversity);
  safe(loadMonthly);
  safe(loadPie);
  safe(loadTrend);
  safe(loadCalendar);
  safe(renderDayHourHeatmap);
  safe(renderYoY);
  safe(()=>loadActivityData(window._lastRecentTracks).then(a=>{renderWeekday(a);renderClock(a);}));
  safe(()=>loadYearReview(selectedYear||new Date().getFullYear()));
  safe(()=>loadArchiveSection().then(()=>{if(_archiveLoaded) renderArchiveList();}));
}

let archivePeriod='all',archiveTab='tracks';
let _archiveLoaded=false;

async function loadArchiveSection(){
  const sec=document.getElementById('archive-sec');
  await getArchiveData();
  if(!hasArchive()){sec.style.display='none';return;}
  sec.style.display='block';
  const navLink=document.getElementById('nav-archive-link');
  if(navLink) navLink.style.display='';
  document.getElementById('archive-sec-badge').textContent=`(${fmt(archiveList().length)} Scrobbles)`;
}

async function toggleArchive(){
  const body=document.getElementById('archive-body');
  const icon=document.getElementById('archive-toggle-icon');
  const isOpen=body.style.display!=='none';
  body.style.display=isOpen?'none':'block';
  icon.style.transform=isOpen?'':'rotate(180deg)';
  if(!isOpen&&!_archiveLoaded){
    _archiveLoaded=true;
    await getArchiveData();
    renderArchiveList();
  }
}

function archiveFilteredList(){
  const now=new Date();
  if(archivePeriod==='year') return C.slice(archiveList(),C.sec(new Date(now.getFullYear(),0,1)));
  if(archivePeriod==='month') return C.slice(archiveList(),C.sec(new Date(now.getFullYear(),now.getMonth(),1)));
  return archiveList();
}

let _archiveShowCount=50;

function renderArchiveList(){
  const listEl=document.getElementById('archive-list');
  const sorted=C.aggregate(archiveFilteredList(),archiveTab);
  if(!sorted.length){listEl.innerHTML=emptyState('Keine Einträge für diesen Zeitraum.');return;}
  const visible=sorted.slice(0,_archiveShowCount);
  const max=sorted[0].playcount;
  const html=visible.map((item,i)=>{
    const pct=Math.round(item.playcount/max*100);
    const sub=archiveTab==='artists'?'':escapeHTML(item.artist.name);
    return `<div class="ri ${i===0?'rank1':i<3?'top3':''}" style="cursor:default;">
      <span class="rn ${rankCls(i)}">${i+1}</span>
      <div class="ri-ph">♪</div>
      <div class="ri-info"><div class="ri-name">${escapeHTML(item.name)}</div>${sub?`<div class="ri-sub">${sub}</div>`:''}</div>
      <div class="ri-right">
        <div class="bar-c"><div class="bar-f" style="width:${pct}%"></div></div>
        <span class="plays">${fmt(item.playcount)} ▶</span>
      </div>
    </div>`;
  }).join('');
  const moreBtn=sorted.length>_archiveShowCount
    ?`<button class="show-more" onclick="_archiveShowCount+=50;renderArchiveList()">+ Mehr anzeigen (${fmt(sorted.length-_archiveShowCount)} weitere)</button>`
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
const PERIOD_LABEL={'overall':'Gesamt','12month':'12 Monate','6month':'6 Monate','3month':'3 Monate','1month':'1 Monat','7day':'7 Tage','yesterday':'Gestern','today':'Heute'};

async function openArtistDrillDown(artistName,period=chartPeriod){
  const overlay=document.getElementById('adm-overlay');
  const titleEl=document.getElementById('adm-title');
  const subEl=document.getElementById('adm-sub');
  const bodyEl=document.getElementById('adm-body');

  titleEl.textContent=artistName;
  subEl.textContent='Lädt...';
  bodyEl.innerHTML='<div class="ld"><div class="sp"></div> Lade Archiv-Daten...</div>';
  overlay.classList.add('open');
  document.body.style.overflow='hidden';

  await getArchiveData();
  if(!hasArchive()){bodyEl.innerHTML=noArchiveState();return;}
  const {from,to}=C.periodRange(period);
  const a=artistName.toLowerCase();
  const sl=C.slice(archiveList(),from,to).filter(e=>e.artist.toLowerCase()===a);
  const sorted=C.aggregate(sl,'tracks');
  subEl.textContent=`${PERIOD_LABEL[period]||period} · ${fmt(sl.length)} Plays · ${fmt(sorted.length)} Tracks · ≈ ${fmtHours(C.Durations.total(sl)/60)}`;
  if(!sorted.length){bodyEl.innerHTML=emptyState('Keine Tracks für diesen Zeitraum gefunden.');return;}
  const max=sorted[0].playcount;
  bodyEl.innerHTML=`<div class="rlist">${sorted.map((t,i)=>{
    const pct=Math.round(t.playcount/max*100);
    return `<div class="ri ${i===0?'rank1':i<3?'top3':''}" style="cursor:default;">
      <span class="rn ${rankCls(i)}">${i+1}</span>
      <div class="ri-ph">♪</div>
      <div class="ri-info"><div class="ri-name">${escapeHTML(t.name)}</div></div>
      <div class="ri-right">
        <div class="bar-c"><div class="bar-f" style="width:${pct}%"></div></div>
        <span class="plays">${fmt(t.playcount)} ▶</span>
      </div>
    </div>`;
  }).join('')}</div>`;
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
// Läuft nach DOMContentLoaded, also erst wenn auch sync.js geladen ist.
async function init(){
  loadCache();
  try{
    const archivePromise=getArchiveData(); // parallel, braucht kein Last.fm
    const npTrack=await loadNowPlayingCard();
    const ud=await loadHero(npTrack);
    await archivePromise;
    let heroJoinYear=ud.joined.getFullYear();
    if(hasArchive()) heroJoinYear=Math.min(heroJoinYear,new Date(archiveList()[0].ts*1000).getFullYear());
    joinYear=heroJoinYear;
    if(_lastHeroData) renderHero(_lastHeroData,isLfmDown());
    renderOverview(ud);
    document.body.classList.add('booted');
    buildYearSel(heroJoinYear);
    loadCompare();
    try{window._lastRecentTracks=await loadRecent();}catch(e){window._lastRecentTracks=[];}
    renderArchiveViews();
    saveCache();
    updateSyncStatusLabel();
    loadDurations().then(()=>onDurationsUpdated(true)).catch(()=>{});

    // Sync-Kette: Delta → letzte Monate abgleichen → Health-Check → Track-Längen
    autoBackgroundSync()
      .then(()=>autoReconcileRecent())
      .then(()=>checkArchiveHealth())
      .then(()=>enrichDurations())
      .catch(e=>console.warn(e));

    // Periodisch alle 5 Min (nur sichtbarer Tab) und bei Tab-Rückkehr
    setInterval(()=>{
      if(document.hidden||isLfmDown()) return;
      autoBackgroundSync(true).catch(()=>{});
    },5*60*1000);
    let _lastVisSync=0;
    document.addEventListener('visibilitychange',()=>{
      if(document.hidden||isLfmDown()) return;
      if(Date.now()-_lastVisSync<60*1000) return;
      _lastVisSync=Date.now();
      autoBackgroundSync(true).catch(()=>{});
    });
  }catch(e){
    console.error(e);
    document.body.classList.add('booted');
    document.body.insertAdjacentHTML('afterbegin',`<div class="wrap"><div class="err" style="margin:16px 0;">Fehler: ${escapeHTML(e.message)}</div></div>`);
  }
}
document.addEventListener('DOMContentLoaded',init);

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

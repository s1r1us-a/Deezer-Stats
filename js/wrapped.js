// ═════════════════════════════════════════════════════════════════
// CONFIG + FIREBASE
// ═════════════════════════════════════════════════════════════════
const FB_CONFIG={
  apiKey:"AIzaSyBqeSKTO1fL5arv15HokhvV-y5CBHVB4gk",
  authDomain:"lastfm-stats.firebaseapp.com",
  projectId:"lastfm-stats",
  databaseURL:"https://lastfm-stats-default-rtdb.europe-west1.firebasedatabase.app",
  appId:"1:756175226818:web:832c6f3d35a5273aac785b"
};
firebase.initializeApp(FB_CONFIG);
const db=firebase.database();

const AVG_TRACK_SEC=180; // 3:00 average
const SLIDE_DURATION_MS=5800;
const SLIDE_DURATION_LONG=7200; // for intro / outro

// ═════════════════════════════════════════════════════════════════
// STATE
// ═════════════════════════════════════════════════════════════════
const state={
  allScrobbles:null,      // whole archive once loaded
  scrobbles:[],           // filtered for current period
  prev:[],                // previous comparable period (for "new discoveries")
  period:null,            // {kind:'30d'|'year', year?:n, from:ms, to:ms, label:string, prevFrom:ms, prevTo:ms}
  stats:null,
  slides:[],              // array of slide definitions
  idx:0,
  timer:null,
  rafId:null,
  slideStart:0,
  slideDur:SLIDE_DURATION_MS,
  paused:false,
  pauseAt:0,
  pausedElapsed:0,
  holdTimer:null
};

// ═════════════════════════════════════════════════════════════════
// UTIL
// ═════════════════════════════════════════════════════════════════
const $ = (sel,root=document) => root.querySelector(sel);
const $$ = (sel,root=document) => [...root.querySelectorAll(sel)];
const fmt = n => n.toLocaleString('de-DE');
const esc = s => String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const initials = s => (s||'').split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]||'').join('').toUpperCase() || '?';
const hap = ms => { try{ navigator.vibrate && navigator.vibrate(ms); }catch(e){} };
const toast = (msg,dur=2200) => {
  const el=$('#toast');
  el.textContent=msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t=setTimeout(()=>el.classList.remove('show'),dur);
};

function setStatus(s){ const el=$('#loader-status'); if(el) el.innerHTML=s; }
function setProgress(p){ const el=$('#loader-bar'); if(el) el.style.width=Math.max(0,Math.min(100,p))+'%'; }

// Dynamic viewport height fix for iOS Safari URL bar
function setVH(){ document.documentElement.style.setProperty('--vh', (window.innerHeight*0.01)+'px'); }
setVH();
window.addEventListener('resize',setVH);
window.addEventListener('orientationchange',()=>setTimeout(setVH,200));

// ═════════════════════════════════════════════════════════════════
// DATA LOAD
// ═════════════════════════════════════════════════════════════════

// Shared preload — dedupes concurrent fetches, caches result.
// Returns Promise<Array> (empty array if no archive).
function preloadArchive(){
  if(state._preloadPromise) return state._preloadPromise;
  state._preloadPromise = (async()=>{
    const snap = await db.ref('scrobbles').once('value');
    if(!snap.exists()) return [];
    const data = snap.val();
    const arr = Object.entries(data).map(([key, v]) => ({
      ts: parseInt(key.split('_')[0]) * 1000,
      artist: (v && v.artist ? String(v.artist) : '').trim(),
      track: (v && v.track ? String(v.track) : '').trim(),
      album: (v && v.album ? String(v.album) : '').trim()
    })).filter(s => s.artist && s.ts > 0).sort((a,b) => a.ts - b.ts);
    state.allScrobbles = arr;
    return arr;
  })();
  return state._preloadPromise;
}

async function loadArchive(){
  if(state.allScrobbles) return state.allScrobbles;
  setStatus('Verbinde mit Archiv…');
  setProgress(20);
  try{
    const arr = await preloadArchive();
    setProgress(85);
    if(arr.length === 0){
      throw new Error('Kein Archiv gefunden. Öffne zuerst die Hauptseite und importiere das Archiv.');
    }
    setStatus('Fertig: <b>' + fmt(arr.length) + '</b> Scrobbles');
    await new Promise(r=>setTimeout(r,200));
    setProgress(100);
    return arr;
  }catch(e){
    console.error(e);
    throw e;
  }
}

// ═════════════════════════════════════════════════════════════════
// STATISTIC COMPUTATION
// ═════════════════════════════════════════════════════════════════
function slicePeriod(period){
  const all = state.allScrobbles;
  state.scrobbles = all.filter(s => s.ts >= period.from && s.ts < period.to);
  state.prev = all.filter(s => s.ts >= period.prevFrom && s.ts < period.prevTo);
}

// Lightweight stats for the "previous period" — only what we need for the compare slide
function computeCompareStats(scrobbles){
  if(!scrobbles || scrobbles.length === 0) return null;
  const artistMap = new Map();
  scrobbles.forEach(s => {
    artistMap.set(s.artist, (artistMap.get(s.artist)||0)+1);
  });
  const sorted = [...artistMap.entries()].sort((a,b)=>b[1]-a[1]);
  const total = scrobbles.length;
  const totalSec = total * AVG_TRACK_SEC;
  return {
    total,
    totalHours: Math.floor(totalSec/3600),
    uniqueArtists: artistMap.size,
    topArtist: sorted[0] ? {name: sorted[0][0], count: sorted[0][1]} : null
  };
}

function computeStats(){
  const scr = state.scrobbles;
  const prev = state.prev;

  if(scr.length === 0){
    return null;
  }

  // Top artists
  const artistMap = new Map();
  const trackMap = new Map();
  const albumMap = new Map();
  const artistFirst = new Map();
  const prevArtistSet = new Set(prev.map(s=>s.artist.toLowerCase()));
  const allPrevSet = new Set(state.allScrobbles.filter(s=>s.ts < state.period.from).map(s=>s.artist.toLowerCase()));

  const hourCounts = new Array(24).fill(0);
  const wdCounts = new Array(7).fill(0); // 0=Sun
  const dayCounts = new Map(); // YYYY-MM-DD → count

  scr.forEach(s => {
    const a = s.artist;
    artistMap.set(a, (artistMap.get(a)||0)+1);

    if(!artistFirst.has(a)) artistFirst.set(a, s.ts);

    const tk = a + ' — ' + s.track;
    if(s.track){
      const t = trackMap.get(tk) || {count:0, artist:a, track:s.track};
      t.count++;
      trackMap.set(tk, t);
    }
    const ak = a + ' — ' + s.album;
    if(s.album){
      const ab = albumMap.get(ak) || {count:0, artist:a, album:s.album};
      ab.count++;
      albumMap.set(ak, ab);
    }
    const d = new Date(s.ts);
    hourCounts[d.getHours()]++;
    wdCounts[d.getDay()]++;
    const dayKey = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    dayCounts.set(dayKey, (dayCounts.get(dayKey)||0)+1);
  });

  const sortedArtists = [...artistMap.entries()].sort((a,b)=>b[1]-a[1]);
  const sortedTracks = [...trackMap.values()].sort((a,b)=>b.count-a.count);
  const sortedAlbums = [...albumMap.values()].sort((a,b)=>b.count-a.count);

  // Peak day
  let peakDay = null;
  let peakCount = 0;
  dayCounts.forEach((v,k)=>{ if(v>peakCount){ peakCount=v; peakDay=k; } });

  // Longest streak (consecutive days with at least 1 scrobble within period)
  const sortedDays = [...dayCounts.keys()].sort();
  let longest=1, current=1;
  for(let i=1;i<sortedDays.length;i++){
    const prevD = new Date(sortedDays[i-1]);
    const curD = new Date(sortedDays[i]);
    const diffDays = Math.round((curD - prevD) / 86400000);
    if(diffDays === 1){ current++; if(current>longest) longest=current; }
    else current = 1;
  }
  if(sortedDays.length === 0) longest = 0;
  else if(sortedDays.length === 1) longest = 1;

  // New discoveries: artists played in period but never in prev period AND not in earlier archive at all
  // We define strict: "never heard before in archive before this period"
  const newArtists = [];
  artistMap.forEach((cnt, name) => {
    if(!allPrevSet.has(name.toLowerCase())){
      newArtists.push({name, count:cnt, firstTs:artistFirst.get(name)});
    }
  });
  newArtists.sort((a,b)=>b.count-a.count);

  // Personality
  const total = scr.length;
  const uniqueArtists = artistMap.size;
  const diversity = uniqueArtists/total; // higher = more varied
  const top10Share = sortedArtists.slice(0,10).reduce((s,[_,c])=>s+c,0)/total;
  const nightShare = (hourCounts.slice(22).reduce((a,b)=>a+b,0)+hourCounts.slice(0,5).reduce((a,b)=>a+b,0))/total;
  const morningShare = hourCounts.slice(5,11).reduce((a,b)=>a+b,0)/total;
  const newShare = newArtists.length/uniqueArtists;

  let persona;
  if(nightShare > 0.4){
    persona = { icon:'🌙', type:'Die Nachteule', desc:'Wenn die anderen schlafen, läuft bei dir die beste Musik.' };
  } else if(morningShare > 0.35){
    persona = { icon:'🌅', type:'Die Morgenperson', desc:'Frische Beats gehören für dich zum Start in den Tag.' };
  } else if(diversity > 0.45){
    persona = { icon:'🧭', type:'Entdecker*in', desc:'Immer auf der Suche — dein Geschmack ist so breit wie das Meer.' };
  } else if(top10Share > 0.7){
    persona = { icon:'💎', type:'Die Loyale', desc:'Wenige Acts, aber ganz tief. Stammhörer*in durch und durch.' };
  } else if(newShare > 0.5){
    persona = { icon:'🚀', type:'Pionier*in', desc:'Die Hälfte deiner Künstler*innen sind frisch entdeckt. Wild.' };
  } else if(diversity < 0.2){
    persona = { icon:'🎯', type:'Fokus-Mensch', desc:'Du weißt was du willst — und das läuft dann auch in Schleife.' };
  } else {
    persona = { icon:'🎧', type:'Die Ausgewogene', desc:'Mix aus Vertrautem und Neuem. Balance statt Chaos.' };
  }

  // Peak hour (top hour)
  let peakHour = 0, peakHourCount = 0;
  hourCounts.forEach((c,h)=>{ if(c>peakHourCount){ peakHourCount=c; peakHour=h; } });

  // Peak weekday
  let peakWd = 0, peakWdCount = 0;
  wdCounts.forEach((c,w)=>{ if(c>peakWdCount){ peakWdCount=c; peakWd=w; } });

  // Hours listened
  const totalSec = total*AVG_TRACK_SEC;
  const h = Math.floor(totalSec/3600);
  const m = Math.floor((totalSec%3600)/60);
  const daysEquiv = (totalSec/86400).toFixed(1);

  return {
    total, uniqueArtists, uniqueTracks:trackMap.size, uniqueAlbums:albumMap.size,
    topArtists: sortedArtists.slice(0,5).map(([name,count])=>({name,count})),
    topTracks: sortedTracks.slice(0,5),
    topAlbum: sortedAlbums[0] || null,
    peakDay, peakCount,
    longestStreak: longest,
    newArtists: newArtists.slice(0,14),
    newArtistsCount: newArtists.length,
    persona,
    peakHour, peakHourCount,
    peakWd, peakWdCount,
    hourCounts, wdCounts,
    totalHours:h, totalMinutes:m, daysEquiv,
    activeDays: sortedDays.length,
    avgPerDay: sortedDays.length ? Math.round(total/sortedDays.length) : 0,
    prevStats: computeCompareStats(prev)
  };
}

// ═════════════════════════════════════════════════════════════════
// PERIOD BUILDERS
// ═════════════════════════════════════════════════════════════════
function buildPeriod30d(){
  const now = Date.now();
  const from = now - 30*86400000;
  const prevFrom = from - 30*86400000;
  return {
    kind:'30d',
    from, to:now,
    prevFrom, prevTo:from,
    label:'Letzte 30 Tage',
    shortLabel:'30 Tage'
  };
}
function buildPeriodYear(year){
  const from = new Date(year,0,1).getTime();
  const to = new Date(year+1,0,1).getTime();
  const prevFrom = new Date(year-1,0,1).getTime();
  const prevTo = from;
  return {
    kind:'year', year,
    from, to, prevFrom, prevTo,
    label:String(year),
    shortLabel:String(year)
  };
}

// ═════════════════════════════════════════════════════════════════
// SLIDE DEFINITIONS (15 slides)
// ═════════════════════════════════════════════════════════════════
function buildSlides(s, p){
  const slides = [];

  // 1. INTRO
  slides.push({
    dur: SLIDE_DURATION_LONG,
    bg:'bg-v1',
    deco:['orbs','stars'],
    anim: 'fade',
    html:`
      <div class="slide-inner">
        <div class="vinyl"></div>
        <div class="intro-mark">Wrapped ✨</div>
        <div class="intro-period">${esc(p.label)}</div>
        <div class="intro-tagline">Ein Rückblick auf deine Musik, Slide für Slide.</div>
      </div>`
  });

  // 2. TOTAL SCROBBLES
  slides.push({
    dur: SLIDE_DURATION_MS,
    bg:'bg-v2',
    deco:['orbs'],
    confetti: true,
    anim: 'zoom',
    html:`
      <div class="slide-inner">
        <div class="eyebrow">Du hast gehört</div>
        <div class="bignum" data-count="${s.total}">0</div>
        <div class="bignum-suffix">Scrobbles</div>
        <div class="subtext">Das sind ${fmt(s.avgPerDay)} pro aktivem Tag — an ${fmt(s.activeDays)} Tagen warst du dabei.</div>
      </div>`,
    onEnter: (el)=>animateCounter(el.querySelector('.bignum'), s.total, 1600)
  });

  // 3. HOURS
  slides.push({
    dur: SLIDE_DURATION_MS,
    bg:'bg-v3',
    deco:['orbs'],
    html:`
      <div class="slide-inner">
        <div class="eyebrow">So viel Zeit</div>
        <div class="headline">${s.totalHours > 24 ? Math.round(s.totalHours) : s.totalHours}<br><span style="font-size:.5em;font-weight:300;">Stunden Musik</span></div>
        <div class="time-breakdown">
          <div class="time-chunk" data-stagger="1"><div class="time-chunk-n">${fmt(s.totalHours)}</div><div class="time-chunk-l">Stunden</div></div>
          <div class="time-chunk" data-stagger="2"><div class="time-chunk-n">${s.daysEquiv}</div><div class="time-chunk-l">Tage am Stück</div></div>
          <div class="time-chunk" data-stagger="3"><div class="time-chunk-n">${fmt(Math.round(s.totalHours/(s.activeDays||1)*10)/10)}</div><div class="time-chunk-l">h pro Tag</div></div>
        </div>
        <div class="metalabel">Bei durchschnittlich 3:00 min pro Track</div>
      </div>`
  });

  // 4. TOP ARTIST
  const a1 = s.topArtists[0];
  if(a1){
    slides.push({
      dur: SLIDE_DURATION_MS,
      bg:'bg-v4',
      deco:['orbs','stars'],
      confetti: true,
      anim: 'zoom',
      html:`
        <div class="slide-inner">
          <div class="crown">👑</div>
          <div class="eyebrow">Dein Top-Act</div>
          <div class="artist-huge">${esc(a1.name)}</div>
          <div class="artist-count"><b>${fmt(a1.count)}</b> Plays</div>
          <div class="metalabel">Das sind ${Math.round(a1.count/s.total*100)}% all deiner Scrobbles</div>
        </div>`
    });
  }

  // 5. TOP 5 ARTISTS
  if(s.topArtists.length >= 2){
    const maxCount = s.topArtists[0].count;
    slides.push({
      dur: SLIDE_DURATION_LONG,
      bg:'bg-v5',
      deco:['orbs'],
      html:`
        <div class="slide-inner">
          <div class="eyebrow">Die Top 5</div>
          <div class="headline" style="font-size:clamp(34px,9vw,64px);">Deine Hall of Fame</div>
          <div class="rank-list">
            ${s.topArtists.map((a,i)=>`
              <div class="rank-item ${i===0?'hero':''}">
                <div class="rank-n">${i+1}</div>
                <div class="rank-info">
                  <div class="rank-name">${esc(a.name)}</div>
                  <div class="rank-meta">${fmt(a.count)} Plays · ${Math.round(a.count/s.total*100)}%</div>
                  <div class="rank-bar"><div class="rank-bar-fill" style="--w:${Math.round(a.count/maxCount*100)}%;"></div></div>
                </div>
              </div>`).join('')}
          </div>
        </div>`
    });
  }

  // 6. TOP TRACK
  const t1 = s.topTracks[0];
  if(t1){
    slides.push({
      dur: SLIDE_DURATION_MS,
      bg:'bg-v6',
      deco:['stars'],
      html:`
        <div class="slide-inner">
          <div class="track-card">
            <div class="track-disc"></div>
          </div>
          <div class="eyebrow">Dein Lieblings-Track</div>
          <div class="track-title">${esc(t1.track)}</div>
          <div class="track-artist">von ${esc(t1.artist)}</div>
          <div class="artist-count"><b>${fmt(t1.count)}</b> × auf Repeat</div>
        </div>`
    });
  }

  // 7. TOP 5 TRACKS
  if(s.topTracks.length >= 2){
    const maxTC = s.topTracks[0].count;
    slides.push({
      dur: SLIDE_DURATION_LONG,
      bg:'bg-v7',
      deco:['orbs'],
      html:`
        <div class="slide-inner">
          <div class="eyebrow">Tracks, die nicht mehr rausgingen</div>
          <div class="headline" style="font-size:clamp(30px,8vw,54px);">Endlos-Loop</div>
          <div class="rank-list">
            ${s.topTracks.map((t,i)=>`
              <div class="rank-item ${i===0?'hero':''}">
                <div class="rank-n">${i+1}</div>
                <div class="rank-info">
                  <div class="rank-name">${esc(t.track)}</div>
                  <div class="rank-meta">${esc(t.artist)} · ${fmt(t.count)}×</div>
                  <div class="rank-bar"><div class="rank-bar-fill" style="--w:${Math.round(t.count/maxTC*100)}%;"></div></div>
                </div>
              </div>`).join('')}
          </div>
        </div>`
    });
  }

  // 8. TOP ALBUM
  if(s.topAlbum){
    slides.push({
      dur: SLIDE_DURATION_MS,
      bg:'bg-v8',
      deco:['stars'],
      html:`
        <div class="slide-inner">
          <div class="album-cover"><div class="album-cover-initials">${esc(initials(s.topAlbum.album))}</div></div>
          <div class="eyebrow">Dein Top-Album</div>
          <div class="track-title">${esc(s.topAlbum.album)}</div>
          <div class="track-artist">von ${esc(s.topAlbum.artist)}</div>
          <div class="artist-count"><b>${fmt(s.topAlbum.count)}</b> Plays</div>
        </div>`
    });
  }

  // 9. FAVORITE HOUR
  slides.push({
    dur: SLIDE_DURATION_MS,
    bg:'bg-v4',
    deco:['orbs','stars'],
    html:`
      <div class="slide-inner">
        <div class="eyebrow">Deine Prime-Time</div>
        <div class="clock-wrap">
          <div class="clock-face"></div>
          ${Array.from({length:24},(_,i)=>`<div class="clock-tick ${i===s.peakHour?'active':''}" style="--a:${i*15}deg;"></div>`).join('')}
          <div class="clock-center">
            <div class="clock-hour">${String(s.peakHour).padStart(2,'0')}:00</div>
            <div class="clock-ampm">${s.peakHour<12?'AM':'PM'} · ${fmt(s.peakHourCount)} Plays</div>
          </div>
        </div>
        <div class="subtext">${s.peakHour>=22||s.peakHour<5?'Deep in the night':s.peakHour<11?'Morgenmusik':s.peakHour<17?'Mittagsvibe':'Feierabend-Zeit'} — da läuft bei dir die Musik am meisten.</div>
      </div>`
  });

  // 10. WEEKDAY
  const wdNames = ['So','Mo','Di','Mi','Do','Fr','Sa'];
  const wdLong = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  const maxWd = Math.max(...s.wdCounts);
  slides.push({
    dur: SLIDE_DURATION_MS,
    bg:'bg-v9',
    deco:['orbs'],
    html:`
      <div class="slide-inner">
        <div class="eyebrow">Dein Soundtrack-Tag</div>
        <div class="headline" style="font-size:clamp(42px,11vw,78px);">${wdLong[s.peakWd]}</div>
        <div class="subtext">An diesem Wochentag bist du am meisten mit Musik unterwegs.</div>
        <div class="wd-grid">
          ${s.wdCounts.map((c,i)=>`
            <div class="wd-col ${i===s.peakWd?'peak':''}">
              <div class="wd-bar-wrap"><div class="wd-bar" style="height:${maxWd?Math.round(c/maxWd*100):0}%;"></div></div>
              <div class="wd-lbl">${wdNames[i]}</div>
            </div>`).join('')}
        </div>
      </div>`,
    onEnter:(el)=>{
      // heights are set inline, but trigger transition
      requestAnimationFrame(()=>{
        $$('.wd-bar',el).forEach((bar,i)=>{
          const c = s.wdCounts[i];
          const h = maxWd?Math.round(c/maxWd*100):0;
          bar.style.height = '0%';
          setTimeout(()=>{ bar.style.height = h+'%'; }, 400+i*60);
        });
      });
    }
  });

  // 11. PEAK DAY
  if(s.peakDay){
    const d = new Date(s.peakDay+'T12:00:00');
    const niceDate = d.toLocaleDateString('de-DE',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
    slides.push({
      dur: SLIDE_DURATION_MS,
      bg:'bg-v6',
      deco:['orbs','stars'],
      confetti: true,
      anim: 'zoom',
      html:`
        <div class="slide-inner">
          <div class="peak-card">
            <div class="peak-day">${d.toLocaleDateString('de-DE',{weekday:'long'})}</div>
            <div class="peak-date">${niceDate}</div>
          </div>
          <div class="eyebrow">An diesem Tag ging's ab</div>
          <div class="peak-scrobs" data-count="${s.peakCount}">0</div>
          <div class="bignum-suffix">Scrobbles an einem Tag</div>
        </div>`,
      onEnter:(el)=>animateCounter(el.querySelector('.peak-scrobs'), s.peakCount, 1400)
    });
  }

  // 12. STREAK
  if(s.longestStreak >= 2){
    slides.push({
      dur: SLIDE_DURATION_MS,
      bg:'bg-v6',
      deco:['orbs'],
      html:`
        <div class="slide-inner">
          <div class="flame">🔥</div>
          <div class="eyebrow">Längste Streak</div>
          <div class="streak-days" data-count="${s.longestStreak}">0</div>
          <div class="bignum-suffix">Tage am Stück Musik</div>
          <div class="subtext">Kein Tag ausgelassen — echte Daily-Dose.</div>
        </div>`,
      onEnter:(el)=>animateCounter(el.querySelector('.streak-days'), s.longestStreak, 1100)
    });
  }

  // 13. NEW DISCOVERIES
  if(s.newArtists.length > 0){
    slides.push({
      dur: SLIDE_DURATION_LONG,
      bg:'bg-v5',
      deco:['orbs','stars'],
      html:`
        <div class="slide-inner">
          <div class="eyebrow">Frisch entdeckt</div>
          <div class="headline" style="font-size:clamp(40px,10vw,72px);">${fmt(s.newArtistsCount)}<br><span style="font-size:.4em;font-weight:300;">neue Künstler*innen</span></div>
          <div class="subtext">Das sind Acts, die du in diesem Zeitraum zum ersten Mal im Archiv hattest. Ein paar davon:</div>
          <div class="discovery-grid">
            ${s.newArtists.slice(0,12).map((a,i)=>`<div class="disc-chip" style="animation-delay:${.4+i*.05}s;">${esc(a.name)}</div>`).join('')}
          </div>
        </div>`
    });
  }

  // 14. YEAR-OVER-YEAR / PREVIOUS-PERIOD COMPARE
  //     only shown when there's meaningful prev data (>50 scrobbles)
  if(s.prevStats && s.prevStats.total > 50){
    const ps = s.prevStats;
    const dTotal = s.total - ps.total;
    const dTotalPct = ps.total ? Math.round(dTotal/ps.total*100) : 0;
    const dHours = s.totalHours - ps.totalHours;
    const dUnique = s.uniqueArtists - ps.uniqueArtists;
    const dUniquePct = ps.uniqueArtists ? Math.round(dUnique/ps.uniqueArtists*100) : 0;

    const sameTop = s.topArtists[0] && ps.topArtist &&
                    s.topArtists[0].name.toLowerCase() === ps.topArtist.name.toLowerCase();

    const prevLabel = p.kind === 'year' ? String(p.year - 1) : 'die 30 Tage davor';
    const prevLabelShort = p.kind === 'year' ? String(p.year - 1) : '30d davor';

    const arrow = d => d > 0 ? '↑' : d < 0 ? '↓' : '—';
    const cls   = d => d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
    const signed = d => (d>0?'+':'') + fmt(d);
    const signedPct = d => (d>0?'+':'') + d + '%';

    slides.push({
      dur: SLIDE_DURATION_LONG,
      bg:'bg-v3',
      deco:['orbs'],
      anim: 'fade',
      html:`
        <div class="slide-inner">
          <div class="eyebrow">Im Vergleich zu ${esc(prevLabelShort)}</div>
          <div class="headline" style="font-size:clamp(32px,8.5vw,56px);">vs. ${esc(prevLabel)}</div>
          <div class="cmp-grid">
            <div class="cmp-cell ${cls(dTotal)}" data-stagger="1">
              <div class="cmp-arrow">${arrow(dTotal)}</div>
              <div class="cmp-val">${signed(dTotal)}</div>
              <div class="cmp-lbl">Scrobbles</div>
              <div class="cmp-sub">${dTotal===0?'gleich wie davor':signedPct(dTotalPct)+' · von '+fmt(ps.total)}</div>
            </div>
            <div class="cmp-cell ${cls(dHours)}" data-stagger="2">
              <div class="cmp-arrow">${arrow(dHours)}</div>
              <div class="cmp-val">${signed(dHours)}</div>
              <div class="cmp-lbl">Stunden</div>
              <div class="cmp-sub">von ${fmt(ps.totalHours)}h</div>
            </div>
            <div class="cmp-cell ${cls(dUnique)}" data-stagger="3">
              <div class="cmp-arrow">${arrow(dUnique)}</div>
              <div class="cmp-val">${signed(dUnique)}</div>
              <div class="cmp-lbl">Künstler*innen</div>
              <div class="cmp-sub">${dUnique===0?'gleiche Breite':signedPct(dUniquePct)+' · von '+fmt(ps.uniqueArtists)}</div>
            </div>
            <div class="cmp-cell cmp-crown" data-stagger="4">
              <div class="cmp-crown-icon">${sameTop?'👑':'✨'}</div>
              <div class="cmp-top-name">${esc(s.topArtists[0]?.name || '—')}</div>
              <div class="cmp-lbl">${sameTop?'hält die Krone':'neuer Top-Act'}</div>
              ${!sameTop && ps.topArtist ? `<div class="cmp-sub">zuvor: ${esc(ps.topArtist.name)}</div>` : ''}
            </div>
          </div>
        </div>`
    });
  }

  // 15. PERSONALITY
  slides.push({
    dur: SLIDE_DURATION_LONG,
    bg:'bg-v4',
    deco:['orbs','stars'],
    anim: 'fade',
    html:`
      <div class="slide-inner">
        <div class="eyebrow">Dein Musik-Typ</div>
        <div class="perso-badge">
          <span class="perso-icon">${s.persona.icon}</span>
          <div class="perso-type">${esc(s.persona.type)}</div>
        </div>
        <div class="perso-desc">${esc(s.persona.desc)}</div>
        <div class="metalabel">${fmt(s.uniqueArtists)} Künstler*innen · ${fmt(s.uniqueTracks)} Tracks · Diversität ${Math.round(s.uniqueArtists/s.total*100)}%</div>
      </div>`
  });

  // 16. OUTRO
  slides.push({
    dur: 20000, // long — user can share/close when ready
    bg:'bg-v1',
    deco:['orbs','stars'],
    confetti: true,
    autoAdvance: false,
    anim: 'blur',
    html:`
      <div class="slide-inner">
        <div class="eyebrow">That's it ✨</div>
        <div class="outro-card">
          <div class="outro-title">Dein ${esc(p.shortLabel)}</div>
          <div class="metalabel" style="margin-top:4px;">s1r1us-a · Wrapped</div>
          <div class="outro-sum">
            <div class="outro-sum-item"><div class="outro-sum-lbl">Scrobbles</div><div class="outro-sum-val">${fmt(s.total)}</div></div>
            <div class="outro-sum-item"><div class="outro-sum-lbl">Stunden</div><div class="outro-sum-val">${fmt(s.totalHours)}</div></div>
            <div class="outro-sum-item"><div class="outro-sum-lbl">Top Artist</div><div class="outro-sum-val">${esc(s.topArtists[0]?.name||'—')}</div></div>
            <div class="outro-sum-item"><div class="outro-sum-lbl">Top Track</div><div class="outro-sum-val">${esc(s.topTracks[0]?.track||'—')}</div></div>
          </div>
          <div class="outro-btns">
            <button class="out-btn out-btn-primary" onclick="shareCard()">📸 Als Bild speichern</button>
            <button class="out-btn out-btn-secondary" onclick="restart()">↻ Nochmal</button>
          </div>
        </div>
      </div>`
  });

  return slides;
}

// ═════════════════════════════════════════════════════════════════
// ANIMATION HELPERS
// ═════════════════════════════════════════════════════════════════
const prefersReducedMotion = () => window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function animateCounter(el, target, dur=1500){
  if(!el) return;
  if(prefersReducedMotion()){ el.textContent = fmt(target); return; }
  const start = performance.now();
  const startVal = 0;
  const ease = t => 1 - Math.pow(1-t, 3);
  function step(now){
    const t = Math.min((now-start)/dur, 1);
    const v = Math.round(startVal + (target-startVal)*ease(t));
    el.textContent = fmt(v);
    if(t<1) requestAnimationFrame(step);
    else el.textContent = fmt(target);
  }
  requestAnimationFrame(step);
}

function spawnConfetti(container, count=40){
  if(prefersReducedMotion()) return;
  const colors = ['#ff49b8','#ff7ac9','#a855f7','#c084fc','#ffc371','#7af0c9'];
  const layer = document.createElement('div');
  layer.className = 'confetti';
  for(let i=0;i<count;i++){
    const bit = document.createElement('div');
    bit.className = 'confetti-bit';
    bit.style.left = Math.random()*100+'%';
    bit.style.top = '-20px';
    bit.style.background = colors[i%colors.length];
    bit.style.borderRadius = i%3===0?'50%':'2px';
    bit.style.setProperty('--dx', (Math.random()*300-150)+'px');
    bit.style.setProperty('--rot', (Math.random()*1080-540)+'deg');
    bit.style.animationDelay = Math.random()*.7+'s';
    bit.style.animationDuration = (2.4+Math.random()*1.6)+'s';
    layer.appendChild(bit);
  }
  container.appendChild(layer);
  setTimeout(()=>layer.remove(), 4500);
}

function spawnStars(container, count=24){
  if(prefersReducedMotion()) return;
  const layer = document.createElement('div');
  layer.className = 'stars';
  for(let i=0;i<count;i++){
    const s = document.createElement('div');
    s.className = 'star';
    s.style.left = Math.random()*100+'%';
    s.style.top = Math.random()*100+'%';
    s.style.animationDelay = Math.random()*3+'s';
    s.style.animationDuration = (2+Math.random()*2)+'s';
    if(Math.random()<.2){ s.style.width='3px'; s.style.height='3px'; }
    layer.appendChild(s);
  }
  container.appendChild(layer);
}

function spawnOrbs(container){
  if(prefersReducedMotion()) return;
  const layer = document.createElement('div');
  layer.style.cssText='position:absolute;inset:0;pointer-events:none;overflow:hidden;';
  const a = document.createElement('div'); a.className = 'orb orb-a';
  const b = document.createElement('div'); b.className = 'orb orb-b';
  layer.appendChild(a); layer.appendChild(b);
  container.appendChild(layer);
}

// ═════════════════════════════════════════════════════════════════
// STORY ENGINE
// ═════════════════════════════════════════════════════════════════
function buildProgressBars(count){
  const wrap = $('#prog-wrap');
  wrap.innerHTML = '';
  for(let i=0;i<count;i++){
    const p = document.createElement('div');
    p.className='prog';
    p.innerHTML = '<div class="prog-fill"></div>';
    wrap.appendChild(p);
  }
}

function renderSlide(idx){
  const def = state.slides[idx];
  if(!def) return;

  const stage = $('#stage');
  // remove old slides (keep transition smooth)
  const old = $$('.slide',stage);

  const slide = document.createElement('div');
  slide.className = 'slide';
  slide.innerHTML = `
    <div class="slide-bg ${def.bg||'bg-v1'}"></div>
    ${def.html}
  `;
  stage.appendChild(slide);

  const bg = slide.querySelector('.slide-bg');
  if(def.deco && def.deco.includes('orbs')) spawnOrbs(bg);
  if(def.deco && def.deco.includes('stars')) spawnStars(bg);

  // Apply variant entrance animation to children (default = 'rise' via slide-reveal)
  const inner = slide.querySelector('.slide-inner');
  if(inner && def.anim) inner.classList.add('anim-' + def.anim);

  // Trigger reflow then activate
  requestAnimationFrame(()=>{
    slide.classList.add('active');
    old.forEach(o => { o.classList.remove('active'); setTimeout(()=>o.remove(),400); });
    if(def.onEnter) def.onEnter(slide);
    if(def.confetti) setTimeout(()=>spawnConfetti(bg, 50), 400);
  });

  // Progress
  $$('.prog').forEach((p,i)=>{
    if(i<idx) p.classList.add('done');
    else p.classList.remove('done');
    const fill = p.querySelector('.prog-fill');
    fill.style.transition = 'none';
    fill.style.width = i<idx ? '100%' : '0%';
  });

  // Flash swap effect
  const fl = $('#flash');
  fl.classList.remove('fire'); void fl.offsetWidth; fl.classList.add('fire');

  // Haptic
  hap(10);
}

function startSlideTimer(){
  const def = state.slides[state.idx];
  if(!def) return;

  state.slideStart = performance.now();
  state.slideDur = def.dur || SLIDE_DURATION_MS;
  state.pausedElapsed = 0;

  const fill = $$('.prog')[state.idx]?.querySelector('.prog-fill');
  if(fill){
    fill.style.transition = 'none';
    fill.style.width = '0%';
    if(def.autoAdvance === false){
      requestAnimationFrame(()=>{
        fill.style.transition = 'width .8s var(--ease-out)';
        fill.style.width = '100%';
      });
    } else {
      requestAnimationFrame(()=>{
        fill.style.transition = `width ${state.slideDur}ms linear`;
        fill.style.width = '100%';
      });
    }
  }

  if(def.autoAdvance === false) return;

  clearTimeout(state.timer);
  state.timer = setTimeout(next, state.slideDur);
}

function next(){
  clearTimeout(state.timer);
  if(state.idx >= state.slides.length-1){ return; }
  state.idx++;
  renderSlide(state.idx);
  startSlideTimer();
}
function prev(){
  clearTimeout(state.timer);
  if(state.idx <= 0){ restartSlide(); return; }
  state.idx--;
  renderSlide(state.idx);
  startSlideTimer();
}
function restartSlide(){
  renderSlide(state.idx);
  startSlideTimer();
}

function pause(){
  if(state.paused) return;
  state.paused = true;
  state.pauseAt = performance.now();
  clearTimeout(state.timer);
  const fill = $$('.prog')[state.idx]?.querySelector('.prog-fill');
  if(fill){
    const elapsed = state.pauseAt - state.slideStart;
    const pct = Math.min(elapsed/state.slideDur*100, 100);
    fill.style.transition = 'none';
    fill.style.width = pct+'%';
  }
  $('#story').classList.add('paused');
  $('#btn-pause').textContent = '▶';
}
function resume(){
  if(!state.paused) return;
  state.paused = false;
  const pauseDur = performance.now() - state.pauseAt;
  state.slideStart += pauseDur;
  const remaining = state.slideDur - (performance.now() - state.slideStart);
  const def = state.slides[state.idx];
  const fill = $$('.prog')[state.idx]?.querySelector('.prog-fill');
  if(fill && remaining > 0){
    fill.style.transition = `width ${remaining}ms linear`;
    fill.style.width = '100%';
  }
  if(def?.autoAdvance !== false && remaining > 0){
    state.timer = setTimeout(next, remaining);
  }
  $('#story').classList.remove('paused');
  $('#btn-pause').textContent = '❚❚';
}

function closeStory(){
  clearTimeout(state.timer);
  $('#story').classList.remove('show');
  $('#entry').style.display = 'flex';
  $('#entry').style.animation = 'entry-fade .6s var(--ease-out)';
}

function restart(){
  state.idx = 0;
  renderSlide(0);
  startSlideTimer();
}

// ═════════════════════════════════════════════════════════════════
// INTERACTION
// ═════════════════════════════════════════════════════════════════
function bindInteractions(){
  // Tap zones (tap + long-press)
  const tzl = $('#tz-l'); const tzr = $('#tz-r');
  const HOLD_MS = 220;

  let pressStart=0, pressTimer=null, held=false;

  function down(e){
    pressStart = Date.now();
    held = false;
    pressTimer = setTimeout(()=>{ held=true; pause(); }, HOLD_MS);
  }
  function upLeft(e){
    clearTimeout(pressTimer);
    if(held){ resume(); held=false; return; }
    if(Date.now()-pressStart < HOLD_MS) prev();
  }
  function upRight(e){
    clearTimeout(pressTimer);
    if(held){ resume(); held=false; return; }
    if(Date.now()-pressStart < HOLD_MS) next();
  }
  function cancel(){ clearTimeout(pressTimer); if(held){ resume(); held=false; } }

  // Use both pointer and touch for max compat
  tzl.addEventListener('pointerdown', down, {passive:true});
  tzl.addEventListener('pointerup', upLeft, {passive:true});
  tzl.addEventListener('pointercancel', cancel, {passive:true});
  tzl.addEventListener('pointerleave', cancel, {passive:true});

  tzr.addEventListener('pointerdown', down, {passive:true});
  tzr.addEventListener('pointerup', upRight, {passive:true});
  tzr.addEventListener('pointercancel', cancel, {passive:true});
  tzr.addEventListener('pointerleave', cancel, {passive:true});

  // Swipe: horizontal + vertical (down to close)
  let sx=0, sy=0, st=0;
  const story = $('#story');
  story.addEventListener('touchstart', e=>{
    if(!e.touches[0]) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
  }, {passive:true});
  story.addEventListener('touchend', e=>{
    if(!e.changedTouches[0]) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    const dt = Date.now() - st;
    if(dt > 500) return;
    if(Math.abs(dy) > 90 && dy > Math.abs(dx)){ closeStory(); return; }
    if(Math.abs(dx) < 50) return;
    if(dx > 0) prev(); else next();
  }, {passive:true});

  // Keyboard
  document.addEventListener('keydown', e=>{
    if(!$('#story').classList.contains('show')) return;
    if(e.key==='ArrowRight' || e.key===' ') { e.preventDefault(); next(); }
    else if(e.key==='ArrowLeft') { e.preventDefault(); prev(); }
    else if(e.key==='Escape') closeStory();
    else if(e.key==='p' || e.key==='P'){ state.paused?resume():pause(); }
  });

  $('#btn-close').addEventListener('click', closeStory);
  $('#btn-pause').addEventListener('click', ()=>state.paused?resume():pause());

  // Page visibility — auto pause when hidden
  document.addEventListener('visibilitychange', ()=>{
    if(document.hidden) pause();
  });
}

// ═════════════════════════════════════════════════════════════════
// SHARE CARD (html2canvas)
// ═════════════════════════════════════════════════════════════════
async function shareCard(){
  if(typeof html2canvas === 'undefined'){ toast('Screenshot-Modul nicht geladen'); return; }
  const s = state.stats; const p = state.period;
  if(!s || !p){ return; }

  const card = $('#share-card');
  card.innerHTML = `
    <div>
      <div class="sc-head">s1r1us-a · Wrapped ✨</div>
      <div class="sc-title">${esc(p.shortLabel)}</div>
      <div class="sc-period">${esc(p.kind==='30d'?'Letzte 30 Tage':'Jahresrückblick')}</div>
    </div>
    <div class="sc-body">
      <div class="sc-row"><div class="sc-row-l">Scrobbles</div><div class="sc-row-v">${fmt(s.total)}</div></div>
      <div class="sc-row"><div class="sc-row-l">Stunden</div><div class="sc-row-v">${fmt(s.totalHours)} h</div></div>
      <div class="sc-row"><div class="sc-row-l">Top Artist</div><div class="sc-row-v">${esc(s.topArtists[0]?.name||'—')}</div></div>
      <div class="sc-row"><div class="sc-row-l">Top Track</div><div class="sc-row-v">${esc(s.topTracks[0]?.track||'—')}</div></div>
      <div class="sc-row"><div class="sc-row-l">Typ</div><div class="sc-row-v">${esc(s.persona.icon+' '+s.persona.type)}</div></div>
      <div class="sc-row"><div class="sc-row-l">Entdeckt</div><div class="sc-row-v">${fmt(s.newArtistsCount)} neu</div></div>
    </div>
    <div class="sc-foot">made with <b>♥</b> — s1r1us-a wrapped</div>
  `;

  toast('Erstelle Bild…');
  try{
    const canvas = await html2canvas(card,{
      backgroundColor:null, scale:2, useCORS:true, allowTaint:true, logging:false,
      width:540, height:960
    });
    canvas.toBlob(async blob=>{
      if(!blob){ toast('Fehler beim Erstellen'); return; }
      const filename = `s1r1us-a-wrapped-${p.kind==='30d'?'30d':p.year}.png`;
      // Try native share first (mobile)
      if(navigator.canShare && navigator.canShare({files:[new File([blob], filename, {type:'image/png'})]})){
        try{
          await navigator.share({files:[new File([blob], filename,{type:'image/png'})], title:'Mein Wrapped ✨'});
          toast('Geteilt ✨');
          return;
        }catch(e){ /* fall through to download */ }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 1000);
      toast('Gespeichert ✨');
    }, 'image/png', 0.95);
  }catch(e){
    console.error(e);
    toast('Fehler: '+e.message);
  }
}

// ═════════════════════════════════════════════════════════════════
// FLOW
// ═════════════════════════════════════════════════════════════════
async function start(period){
  $('#entry').style.display = 'none';
  $('#loader').classList.add('show');
  setProgress(5);

  try{
    await loadArchive();
    state.period = period;
    slicePeriod(period);
    setProgress(95);

    if(state.scrobbles.length < 10){
      throw new Error('Nur ' + state.scrobbles.length + ' Scrobbles in diesem Zeitraum. Wähle einen anderen.');
    }

    state.stats = computeStats();
    state.slides = buildSlides(state.stats, period);
    state.idx = 0;

    $('#topbar-period').textContent = period.label;
    buildProgressBars(state.slides.length);

    await new Promise(r=>setTimeout(r,450));
    $('#loader').classList.remove('show');
    $('#story').classList.add('show');
    renderSlide(0);
    startSlideTimer();
  }catch(e){
    console.error(e);
    $('#loader').classList.remove('show');
    $('#entry').style.display = 'flex';
    $('#entry').scrollIntoView();
    const inner = $('.entry-inner');
    const oldErr = inner.querySelector('.err-box');
    if(oldErr) oldErr.remove();
    const err = document.createElement('div');
    err.className = 'err-box';
    err.style.marginTop = '16px';
    err.innerHTML = `<b>Hoppla</b>${esc(e.message||'Unbekannter Fehler')}`;
    err.querySelector('b').insertAdjacentHTML('afterend', '<br>');
    inner.appendChild(err);
  }
}

// ═════════════════════════════════════════════════════════════════
// ENTRY UI
// ═════════════════════════════════════════════════════════════════
async function buildYearChips(){
  const wrap = $('#year-chips');
  // Skeleton while preload runs
  wrap.innerHTML = '<div class="year-chip-skel"></div><div class="year-chip-skel"></div><div class="year-chip-skel"></div>';

  let years = [];
  try{
    const arr = await preloadArchive();
    if(arr && arr.length > 0){
      const ySet = new Set(arr.map(s => new Date(s.ts).getFullYear()));
      years = [...ySet].sort((a,b) => b-a);
    }
  }catch(e){
    console.warn('Year preload failed:', e);
  }

  if(years.length === 0){
    wrap.innerHTML = '<div class="year-empty">Noch keine Scrobbles im Archiv</div>';
    return;
  }

  wrap.innerHTML = years.map(y=>`<button class="year-chip" data-y="${y}" type="button">${y}</button>`).join('');
  $$('.year-chip', wrap).forEach(btn=>{
    btn.addEventListener('click', ()=>{
      $$('.year-chip',wrap).forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const y = parseInt(btn.dataset.y);
      setTimeout(()=>start(buildPeriodYear(y)), 200);
    });
  });
}

function bindEntry(){
  $('#opt-30d').addEventListener('click', ()=>start(buildPeriod30d()));
  const openYear = ()=>{
    const yp = $('#year-picker');
    yp.style.display = yp.style.display==='none'?'block':'none';
    if(yp.style.display==='block'){
      yp.animate([{opacity:0,transform:'translateY(-4px)'},{opacity:1,transform:'translateY(0)'}],{duration:260,easing:'cubic-bezier(.16,1,.3,1)'});
    }
  };
  $('#opt-year').addEventListener('click', openYear);
}

// ═════════════════════════════════════════════════════════════════
// BOOT
// ═════════════════════════════════════════════════════════════════
(async function boot(){
  bindEntry();
  bindInteractions();
  // buildYearChips triggers preloadArchive() under the hood,
  // so the archive is warmed as soon as the entry screen renders.
  buildYearChips();
})();

// Expose a couple of globals for inline onclick
window.shareCard = shareCard;
window.restart = restart;

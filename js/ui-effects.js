(function(){
  'use strict';

  // ── Bewegungs-Präferenz ────────────────────────────────────
  // Diese JS-getriebenen Effekte werden vom CSS-@media(prefers-reduced-motion)
  // nicht erfasst, daher hier explizit prüfen. `reduceMotion()` wird live
  // ausgewertet, damit ein Umschalten ohne Reload greift.
  const reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointerMQ = window.matchMedia('(hover: hover) and (pointer: fine)');
  const reduceMotion = () => reduceMQ.matches;
  const scrollBehavior = () => reduceMotion() ? 'auto' : 'smooth';

  // ── Spotlight: folgt der Maus ──────────────────────────────
  // Nur bei feinem Zeiger (Maus) und ohne Reduced-Motion — auf Touch bringt
  // der Effekt nichts und kostet nur Pointer-Events.
  const spot = document.getElementById('spotlight');
  if(spot && finePointerMQ.matches && !reduceMotion()){
    let raf = null, tx = 50, ty = 50;
    window.addEventListener('pointermove', (e) => {
      if(reduceMotion()) return;
      tx = (e.clientX / window.innerWidth) * 100;
      ty = (e.clientY / window.innerHeight) * 100;
      if(raf) return;
      raf = requestAnimationFrame(() => {
        document.documentElement.style.setProperty('--mx', tx + '%');
        document.documentElement.style.setProperty('--my', ty + '%');
        raf = null;
      });
    }, { passive: true });
  }

  // ── Scroll-Progress-Bar ────────────────────────────────────
  const progress = document.getElementById('scrollProgress');
  const backTop = document.getElementById('backTop');
  if(progress || backTop){
    let scrollRaf = null;
    const updateScroll = () => {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      const pct = max > 0 ? (h.scrollTop / max) * 100 : 0;
      if(progress) progress.style.width = pct + '%';
      if(backTop) backTop.classList.toggle('visible', h.scrollTop > 600);
      scrollRaf = null;
    };
    window.addEventListener('scroll', () => {
      if(scrollRaf) return;
      scrollRaf = requestAnimationFrame(updateScroll);
    }, { passive: true });
    updateScroll();
  }

  // ── Back-to-top Click ──────────────────────────────────────
  if(backTop){
    backTop.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: scrollBehavior() });
    });
  }

  // ── Side-Nav: Click-to-scroll + Scrollspy ──────────────────
  const dots = document.querySelectorAll('.side-nav-dot');
  if(dots.length){
    dots.forEach(dot => {
      dot.addEventListener('click', () => {
        const id = dot.dataset.target;
        const el = document.getElementById(id);
        if(el){
          const y = el.getBoundingClientRect().top + window.scrollY - 80;
          window.scrollTo({ top: y, behavior: scrollBehavior() });
        }
      });
    });

    // Scrollspy via IntersectionObserver
    const sectionMap = new Map();
    dots.forEach(dot => {
      const el = document.getElementById(dot.dataset.target);
      if(el) sectionMap.set(el, dot);
    });
    if('IntersectionObserver' in window && sectionMap.size){
      const io = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          const dot = sectionMap.get(entry.target);
          if(!dot) return;
          if(entry.isIntersecting){
            dots.forEach(d => d.classList.remove('active'));
            dot.classList.add('active');
          }
        });
      }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });
      sectionMap.forEach((_, section) => io.observe(section));
    }
  }

  // ── Parallax-Orbs ──────────────────────────────────────────
  const parallaxEls = document.querySelectorAll('[data-parallax]');
  if(parallaxEls.length){
    let parallaxRaf = null;
    const resetParallax = () => parallaxEls.forEach(el => { el.style.transform = 'none'; });
    const updateParallax = () => {
      parallaxRaf = null;
      // Bei Reduced-Motion keine Scroll-Verschiebung — Orbs bleiben statisch.
      if(reduceMotion()){ resetParallax(); return; }
      const y = window.scrollY;
      parallaxEls.forEach(el => {
        const factor = parseFloat(el.dataset.parallax) || 0;
        el.style.transform = `translate3d(0, ${-y * factor}px, 0)`;
      });
    };
    window.addEventListener('scroll', () => {
      if(parallaxRaf) return;
      parallaxRaf = requestAnimationFrame(updateParallax);
    }, { passive: true });
    // Live auf Umschalten der Präferenz reagieren.
    reduceMQ.addEventListener('change', () => { reduceMotion() ? resetParallax() : updateParallax(); });
    updateParallax();
  }

  // ── Number-Counter: MutationObserver auf .mc-val ──────────
  function parseNumDE(str){
    if(!str) return null;
    const trimmed = str.trim();
    if(!trimmed || trimmed.length > 25) return null;
    // Muss am Anfang mit Zahl beginnen
    if(!/^[0-9]/.test(trimmed)) return null;
    // Nur der numerische Teil am Anfang (kann optional Einheit danach haben)
    const match = trimmed.match(/^([0-9.]+(?:,[0-9]+)?)/);
    if(!match) return null;
    const numericPart = match[1];
    const suffix = trimmed.substring(numericPart.length);
    // DE format: 1.234,56 → 1234.56
    const cleaned = numericPart.replace(/\./g, '').replace(',', '.');
    const num = parseFloat(cleaned);
    if(isNaN(num) || num > 9999999) return null;
    return { value: num, suffix, hasDecimal: numericPart.includes(',') };
  }

  function formatDE(num, hasDecimal, suffix){
    if(hasDecimal){
      return num.toFixed(1).replace('.', ',') + suffix;
    }
    return Math.round(num).toLocaleString('de-DE') + suffix;
  }

  function animateCount(el){
    if(el.dataset.counted === '1') return;
    const original = el.textContent;
    const parsed = parseNumDE(original);
    if(!parsed){
      el.dataset.counted = '1';
      return;
    }
    el.dataset.counted = '1';
    el.setAttribute('data-counting', '1');
    const duration = 900;
    const startT = performance.now();
    const easeOutExpo = t => t === 1 ? 1 : 1 - Math.pow(2, -10 * t);

    const step = (now) => {
      const elapsed = now - startT;
      const p = Math.min(elapsed / duration, 1);
      const eased = easeOutExpo(p);
      const current = parsed.value * eased;
      el.textContent = formatDE(current, parsed.hasDecimal, parsed.suffix);
      if(p < 1){
        requestAnimationFrame(step);
      } else {
        el.textContent = original;
        el.removeAttribute('data-counting');
      }
    };
    requestAnimationFrame(step);
  }

  function setupCounter(gridId){
    const grid = document.getElementById(gridId);
    if(!grid) return;
    const checkVals = () => {
      grid.querySelectorAll('.mc-val').forEach(el => {
        if(el.dataset.counted === '1') return;
        const txt = el.textContent;
        if(txt && txt.length > 0 && !txt.includes('...') && !txt.includes('─')){
          animateCount(el);
        }
      });
    };
    let debounceT = null;
    const mo = new MutationObserver(() => {
      clearTimeout(debounceT);
      debounceT = setTimeout(checkVals, 80);
    });
    mo.observe(grid, { childList: true, subtree: true, characterData: true });
    setTimeout(checkVals, 200);
  }
  ['overview-grid', 'streak-content', 'lifetime-stats', 'diversity-content'].forEach(setupCounter);
})();

/* ── Album-Art-Akzent ───────────────────────────────────────────────
   Die Now-Playing-Aura (.hero) nimmt die Dominantfarbe des aktuellen
   Covers an. Voll gekapselt: CORS-getaintete Bilder werfen in
   getImageData() — der catch fällt still auf die statische Pink/Purple-
   Aura zurück. Berührt keine bestehende Logik. */
(function(){
  'use strict';
  const root = document.documentElement;
  let lastUrl = '', rafT = null;

  function apply(r, g, b){ root.style.setProperty('--np-accent', r + ', ' + g + ', ' + b); }

  function sample(url){
    if(!url || url === lastUrl) return;
    lastUrl = url;
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = function(){
      try{
        const c = document.createElement('canvas');
        c.width = c.height = 16;
        const ctx = c.getContext('2d');
        ctx.drawImage(im, 0, 0, 16, 16);
        const d = ctx.getImageData(0, 0, 16, 16).data;
        let r = 0, g = 0, b = 0, n = 0;
        for(let i = 0; i < d.length; i += 4){
          const rr = d[i], gg = d[i+1], bb = d[i+2];
          const mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb);
          if(mx < 28 || mn > 230) continue;        // Schwarz/Weiß überspringen → lebendiger
          r += rr; g += gg; b += bb; n++;
        }
        if(n){ apply(Math.round(r/n), Math.round(g/n), Math.round(b/n)); }
      }catch(e){ /* CORS-tainted → statische Aura bleibt */ }
    };
    im.onerror = function(){ lastUrl = ''; };
    im.src = url;
  }

  function bgUrl(el){
    if(!el) return '';
    const m = /url\(["']?(.*?)["']?\)/.exec(el.style.backgroundImage || '');
    return m ? m[1] : '';
  }

  function update(){
    const cover = document.querySelector('.np-cover');
    if(cover && cover.src){ sample(cover.src); return; }
    sample(bgUrl(document.getElementById('hero-bg')));
  }

  const mo = new MutationObserver(function(){
    if(rafT) return;
    rafT = requestAnimationFrame(function(){ rafT = null; update(); });
  });
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'style'] });

  if(document.readyState !== 'loading') update();
  else document.addEventListener('DOMContentLoaded', update);
})();

/* ── Theme-Toggle (analog gptstats initTheme) ──────────────────────
   Standard: Light — Dark nur, wenn der Nutzer es per Toggle gewählt hat.
   Das data-theme-Attribut wird bereits vor dem ersten Paint durch das
   Inline-Script im <head> gesetzt; hier nur Toggle + Persistenz. */
(function(){
  'use strict';
  const btn = document.getElementById('themeToggle');
  if(!btn) return;
  const metaTheme = document.querySelector('meta[name="theme-color"]');

  function applyThemeMeta(){
    if(!metaTheme) return;
    const bg = getComputedStyle(document.body).getPropertyValue('--bg').trim();
    if(bg) metaTheme.setAttribute('content', bg);
  }

  btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try{ localStorage.setItem('dzs-theme', next); }catch(e){}
    applyThemeMeta();
    if(typeof window.applyChartTheme === 'function') window.applyChartTheme();
  });

  applyThemeMeta();
})();

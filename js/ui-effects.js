(function(){
  'use strict';

  // ── Spotlight: folgt der Maus ──────────────────────────────
  const spot = document.getElementById('spotlight');
  if(spot){
    let raf = null, tx = 50, ty = 50;
    window.addEventListener('pointermove', (e) => {
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
      window.scrollTo({ top: 0, behavior: 'smooth' });
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
          window.scrollTo({ top: y, behavior: 'smooth' });
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
    const updateParallax = () => {
      const y = window.scrollY;
      parallaxEls.forEach(el => {
        const factor = parseFloat(el.dataset.parallax) || 0;
        el.style.transform = `translate3d(0, ${-y * factor}px, 0)`;
      });
      parallaxRaf = null;
    };
    window.addEventListener('scroll', () => {
      if(parallaxRaf) return;
      parallaxRaf = requestAnimationFrame(updateParallax);
    }, { passive: true });
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

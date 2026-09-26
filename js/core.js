/* ═══════════════════════════════════════════════════════════
   core.js — gemeinsame Archiv-Logik für Dashboard und Wrapped
   ───────────────────────────────────────────────────────────
   Eine Quelle für: Scrobble-Keys, Archiv-Liste, Aggregation,
   Zeiträume und Hörzeit. app.js, sync.js und wrapped.js greifen
   ausschließlich hierüber auf die Rohdaten zu — damit rechnen alle
   Sektionen mit denselben Regeln (z. B. Groß/Kleinschreibung).
   ═══════════════════════════════════════════════════════════ */
(function (g) {
  'use strict';

  // ── KEYS ────────────────────────────────────────────────────
  // Format (v2, deterministisch): <ts>_<artistSlug>_<trackSlug>_<hash>
  // Echte Doppel-Scrobbles (gleiche Sekunde, gleicher Track) bekommen
  // _d2, _d3 … angehängt. Legacy (v1): zusätzlich _<seq> mit ≥4 Ziffern,
  // wobei seq die Position im Abfragefenster war — dadurch entstanden bei
  // unterschiedlich großen Fenstern Duplikate.
  const slug = s =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 20) || 'x';
  const hashStr = s => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36);
  };

  // Byte-identisch zur bisherigen canonicalScrobbleId — Legacy-Keys lassen
  // sich dadurch 1:1 auf das neue Format abbilden.
  function canonicalScrobbleId(ts, artist, track) {
    const combined = String(artist).toLowerCase() + '|' + String(track).toLowerCase();
    return `${ts}_${slug(artist)}_${slug(track)}_${hashStr(combined)}`;
  }
  function scrobbleKey(canon, occurrence) {
    return occurrence > 1 ? `${canon}_d${occurrence}` : canon;
  }
  const keyTs = key => parseInt(key, 10) || 0;
  function isLegacyKey(key) {
    const p = key.split('_');
    return p.length === 5 && /^\d{4,}$/.test(p[4]);
  }
  const keyCanonical = key => key.split('_').slice(0, 4).join('_');

  // Stabile ID pro Track (ohne Zeitstempel) — für track_meta/{id}
  function trackId(artist, track) {
    const a = String(artist || '').trim();
    const t = String(track || '').trim();
    return `${slug(a)}_${slug(t)}_${hashStr(a.toLowerCase() + '|' + t.toLowerCase())}`;
  }

  // Last.fm-Track → Archiv-Eintrag
  function trackFields(t) {
    return {
      artist: t.artist?.['#text'] || t.artist?.name || '',
      track: t.name || '',
      album: t.album?.['#text'] || '',
    };
  }

  // ── ARCHIV-LISTE ────────────────────────────────────────────
  // Rohdaten {key:{artist,track,album}} → nach Zeit sortiertes Array.
  // Memoisiert über (Objekt, Version): app.js zählt die Version bei jeder
  // lokalen Änderung hoch.
  let _memo = {data: null, version: -1, list: []};
  function toList(data, version = 0) {
    if (!data) return [];
    if (_memo.data === data && _memo.version === version) return _memo.list;
    const list = [];
    for (const key in data) {
      const v = data[key] || {};
      const ts = keyTs(key);
      if (!ts) continue;
      const artist = String(v.artist || '').trim();
      const track = String(v.track || '').trim();
      list.push({
        key,
        ts,
        artist,
        track,
        album: String(v.album || '').trim(),
        tid: trackId(artist, track),
      });
    }
    list.sort((a, b) => a.ts - b.ts);
    _memo = {data, version, list};
    return list;
  }

  // Binärsuche: erster Index mit ts >= from
  function lowerBound(list, from) {
    let lo = 0,
      hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].ts < from) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  // Ausschnitt [from, to) in Sekunden; null = offen
  function slice(list, from = null, to = null) {
    const a = from ? lowerBound(list, from) : 0;
    const b = to ? lowerBound(list, to) : list.length;
    return list.slice(a, b);
  }

  // ── AGGREGATION ─────────────────────────────────────────────
  // Einheitlich case-insensitive. Anzeigename = häufigste Schreibweise.
  function groupKey(e, tab) {
    const a = e.artist.toLowerCase();
    if (tab === 'artists') return e.artist ? a : null;
    if (tab === 'tracks') return e.track && e.artist ? a + '|||' + e.track.toLowerCase() : null;
    return e.album && e.artist ? a + '|||' + e.album.toLowerCase() : null;
  }
  function aggregate(list, tab = 'artists') {
    const map = new Map();
    for (const e of list) {
      const k = groupKey(e, tab);
      if (!k) continue;
      let it = map.get(k);
      if (!it) {
        it = {key: k, playcount: 0, _names: new Map(), _artists: new Map()};
        map.set(k, it);
      }
      it.playcount++;
      const nm = tab === 'artists' ? e.artist : tab === 'tracks' ? e.track : e.album;
      it._names.set(nm, (it._names.get(nm) || 0) + 1);
      it._artists.set(e.artist, (it._artists.get(e.artist) || 0) + 1);
    }
    const top = m => {
      let best = '',
        n = -1;
      for (const [k, c] of m) if (c > n) ((best = k), (n = c));
      return best;
    };
    const out = [];
    for (const it of map.values()) {
      out.push({
        key: it.key,
        name: top(it._names),
        artist: {name: top(it._artists)},
        playcount: it.playcount,
        image: [{'#text': '', size: 'medium'}],
        url: '',
      });
    }
    return out.sort((a, b) => b.playcount - a.playcount || a.name.localeCompare(b.name));
  }

  function uniqueCounts(list) {
    const a = new Set(),
      t = new Set(),
      al = new Set();
    for (const e of list) {
      if (!e.artist) continue;
      const la = e.artist.toLowerCase();
      a.add(la);
      if (e.track) t.add(la + '|||' + e.track.toLowerCase());
      if (e.album) al.add(la + '|||' + e.album.toLowerCase());
    }
    return {artist_count: a.size, track_count: t.size, album_count: al.size};
  }

  // ── ZEIT ────────────────────────────────────────────────────
  const pad2 = n => String(n).padStart(2, '0');
  const dayKey = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const monthKey = (y, m) => `${y}-${pad2(m + 1)}`;
  const sec = d => Math.floor(d.getTime() / 1000);
  function midnight(d = new Date()) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // Zeitraum → [from, to) in Sekunden (to=null: bis jetzt)
  function periodRange(period, now = new Date()) {
    const m0 = midnight(now);
    const back = months => {
      const d = new Date(now);
      d.setMonth(d.getMonth() - months);
      return sec(d);
    };
    switch (period) {
      case 'today':
        return {from: sec(m0), to: null};
      case 'yesterday': {
        const y = new Date(m0);
        y.setDate(y.getDate() - 1);
        return {from: sec(y), to: sec(m0)};
      }
      case '7day':
        return {from: Math.floor((now.getTime() - 7 * 864e5) / 1000), to: null};
      case '1month':
        return {from: back(1), to: null};
      case '3month':
        return {from: back(3), to: null};
      case '6month':
        return {from: back(6), to: null};
      case '12month':
        return {from: back(12), to: null};
      default:
        return {from: null, to: null};
    }
  }

  // Kalendermonate als {key,y,m,from,to} (to exklusiv)
  function monthsBetween(startY, startM, now = new Date()) {
    const out = [];
    let y = startY,
      m = startM;
    while (y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth())) {
      out.push({
        key: monthKey(y, m),
        y,
        m,
        from: sec(new Date(y, m, 1)),
        to: sec(new Date(y, m + 1, 1)),
      });
      if (++m > 11) ((m = 0), y++);
    }
    return out;
  }

  // ── HÖRZEIT ─────────────────────────────────────────────────
  // track_meta/{trackId} = {d: Sekunden (0 = unbekannt), s: Quelle, t: Zeit}
  // Unbekannte Längen werden durch den play-gewichteten Durchschnitt der
  // bekannten ersetzt; ohne Daten 3:30 (realistischer als die alten 3:00).
  const DEFAULT_SEC = 210;
  const MAX_SEC = 30 * 60; // Ausreißer (Mixe, Hörbücher) kappen
  const Durations = {
    meta: {},
    fallback: DEFAULT_SEC,
    setMeta(meta) {
      this.meta = meta || {};
      this.recompute();
    },
    known(tid) {
      const d = this.meta[tid]?.d;
      return d > 0 ? Math.min(d, MAX_SEC) : 0;
    },
    recompute(list) {
      if (!list) return;
      let sum = 0,
        n = 0;
      for (const e of list) {
        const d = this.known(e.tid);
        if (d) ((sum += d), n++);
      }
      this.fallback = n >= 20 ? sum / n : DEFAULT_SEC;
    },
    seconds(e) {
      return this.known(e.tid) || this.fallback;
    },
    total(list) {
      let s = 0;
      for (const e of list) s += this.seconds(e);
      return s;
    },
    coverage(list) {
      if (!list.length) return 0;
      let k = 0;
      for (const e of list) if (this.known(e.tid)) k++;
      return k / list.length;
    },
  };

  g.ScrobbleCore = {
    slug,
    hashStr,
    canonicalScrobbleId,
    scrobbleKey,
    keyTs,
    isLegacyKey,
    keyCanonical,
    trackId,
    trackFields,
    toList,
    slice,
    lowerBound,
    aggregate,
    uniqueCounts,
    dayKey,
    monthKey,
    midnight,
    sec,
    periodRange,
    monthsBetween,
    Durations,
  };
})(window);

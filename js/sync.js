/* ═══════════════════════════════════════════════════════════
   sync.js — Last.fm → Firebase-Archiv
   ───────────────────────────────────────────────────────────
   Grundsätze:
   • Deterministische Keys (core.js): derselbe Scrobble landet immer unter
     demselben Key. Writes sind idempotent — parallele Syncs (zwei Tabs,
     Handy + Desktop) können keine Duplikate mehr erzeugen.
   • Fenster-Abgleich: Ein Sync lädt ein Zeitfenster komplett von Last.fm,
     schreibt Fehlendes (älteste Seite zuerst → Resume-Garantie) und
     entfernt am Ende Archiv-Einträge, die Last.fm in diesem Fenster nicht
     mehr kennt (Duplikate, gelöschte Scrobbles). Gelöscht wird nur, wenn
     das Fenster vollständig geladen wurde (Anzahl == Last.fm-total).
   • Delta-Sync überlappt 72 h: Deezer reicht Offline-/Handy-Plays oft mit
     ihrem ursprünglichen (älteren) Zeitstempel nach.
   • Monats-Abgleich: pro Monat ein Zähl-Call; nur abweichende Monate werden
     neu geladen. Migriert nebenbei Legacy-Keys (v1) auf v2.
   • Eine Sperre für alle Vorgänge (Auto, Delta, Import, Abgleich).
   Nutzt Globals aus app.js (db, API, USER, KEY, UI-Helfer, _archiveData).
   ═══════════════════════════════════════════════════════════ */

const IMPORT_DELAY = 100; // ms zwischen API-Calls (~3 req/s, unter Last.fms Limit)
const RETRY_MAX = 3;
const RETRY_DELAY = 4000;
const DELTA_OVERLAP = 72 * 3600; // s
const FB_CHUNK = 400; // Pfade pro Multi-Path-Update
const AUTO_RECENT_MONTHS = 3;

let _importAborted = false;
let _syncRunning = null; // Name des laufenden Vorgangs oder null
const sleep = ms => new Promise(r => setTimeout(r, ms));
const asArray = x => (Array.isArray(x) ? x : x ? [x] : []);

// ── SPERRE ─────────────────────────────────────────────────
async function withSyncLock(name, fn, {silent = false} = {}) {
  if (_syncRunning) {
    if (!silent) showToast(`Läuft bereits: ${_syncRunning}`, 'err');
    return null;
  }
  _syncRunning = name;
  document.getElementById('archive-modal')?.classList.add('busy');
  try {
    return await fn();
  } finally {
    _syncRunning = null;
    document.getElementById('archive-modal')?.classList.remove('busy');
  }
}

// ── MODAL ──────────────────────────────────────────────────
function openArchiveModal() {
  const m = document.getElementById('archive-modal');
  m.style.opacity = '1';
  m.style.pointerEvents = 'all';
  m.classList.add('open');
  loadArchiveStatus();
}
function closeArchiveModal() {
  const m = document.getElementById('archive-modal');
  m.style.opacity = '0';
  m.style.pointerEvents = 'none';
  m.classList.remove('open');
}
document.getElementById('archive-modal').addEventListener('click', function (e) {
  if (e.target === this) closeArchiveModal();
});

function setArchiveBusy(busy) {
  const show = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.style.display = on ? 'inline-block' : 'none';
  };
  show('archive-import-btn', !busy);
  show('archive-delta-btn', !busy);
  show('archive-check-btn', !busy);
  show('archive-abort-btn', busy);
  if (busy) show('archive-repair-btn', false);
  document.getElementById('archive-progress-wrap').style.display = busy ? 'block' : 'none';
  if (!busy) {
    updateProgressBar(0);
    updateProgressTxt('');
  }
}
function updateProgressTxt(txt) {
  document.getElementById('archive-progress-txt').textContent = txt;
}
function updateProgressBar(pct) {
  document.getElementById('archive-progress-bar').style.width = pct + '%';
}
function abortImport() {
  _importAborted = true;
  updateProgressTxt('Wird pausiert — Fortschritt bleibt gespeichert…');
}

// ── ARCHIV-META ────────────────────────────────────────────
async function getLatestArchivedTs() {
  if (_archiveData) {
    const list = archiveList();
    return list.length ? list[list.length - 1].ts : null;
  }
  try {
    const snap = await db.ref('scrobbles').orderByKey().limitToLast(1).get();
    if (!snap.exists()) return null;
    return ScrobbleCore.keyTs(Object.keys(snap.val())[0]);
  } catch (e) {
    return null;
  }
}
async function getArchiveCount() {
  if (_archiveData) return Object.keys(_archiveData).length;
  try {
    const snap = await db.ref('scrobble_meta/count').get();
    return snap.exists() ? snap.val() : null;
  } catch (e) {
    return null;
  }
}
async function saveArchiveMeta(extra = {}) {
  try {
    await db
      .ref('scrobble_meta')
      .update({count: Object.keys(_archiveData || {}).length, last_sync: Date.now(), ...extra});
  } catch (e) {
    console.warn('scrobble_meta update failed:', e);
  }
}

async function loadArchiveStatus() {
  const statusEl = document.getElementById('archive-status');
  statusEl.textContent = 'Prüfe Archiv…';
  await getArchiveData();
  const [latestTs, count] = await Promise.all([getLatestArchivedTs(), getArchiveCount()]);
  if (!latestTs) {
    statusEl.innerHTML = `<span style="color:var(--text3);">Noch kein Archiv vorhanden.</span><br>Starte den vollständigen Import, um alle Scrobbles zu sichern.`;
  } else {
    const date = new Date(latestTs * 1000).toLocaleString('de-DE', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const legacy = countLegacyKeys();
    const legacyNote = legacy
      ? `<br><span class="modal-note warn">${fmt(legacy)} Einträge im alten Key-Format — „Archiv prüfen“ migriert sie und entfernt Duplikate.</span>`
      : '';
    statusEl.innerHTML =
      `Letzter Eintrag: <b>${date}</b><br><b class="modal-count">${fmt(count || 0)}</b> Scrobbles gespeichert` +
      legacyNote +
      `<br><span class="modal-note">${durationStatusText()}</span>`;
  }
}

function countLegacyKeys(from = null, to = null) {
  let n = 0;
  for (const e of ScrobbleCore.slice(archiveList(), from, to))
    if (ScrobbleCore.isLegacyKey(e.key)) n++;
  return n;
}

// ── LAST.FM ────────────────────────────────────────────────
async function fetchScrobblePage(from, to, page, limit = 200) {
  const url = new URL(API);
  const params = {
    method: 'user.getRecentTracks',
    user: USER,
    api_key: KEY,
    format: 'json',
    limit,
    page,
    extended: 0,
  };
  if (from) params.from = from;
  if (to) params.to = to;
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  let lastErr;
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    let retryAfterMs = null;
    try {
      const r = await fetch(url);
      if (!r.ok) {
        if (r.status === 429) {
          const ra = parseInt(r.headers.get('Retry-After'));
          retryAfterMs = Number.isFinite(ra) ? ra * 1000 : RETRY_DELAY * Math.pow(2, attempt - 1);
        }
        throw new Error('HTTP ' + r.status);
      }
      const d = await r.json();
      if (d?.error) throw new Error('Last.fm: ' + d.message);
      return d;
    } catch (e) {
      lastErr = e;
      if (_importAborted) throw e;
      if (attempt < RETRY_MAX) {
        const waitMs = retryAfterMs || RETRY_DELAY;
        updateProgressTxt(
          `⚠ Fehler${retryAfterMs ? ' (Rate-Limit)' : ''} (Versuch ${attempt}/${RETRY_MAX}): ${e.message} — warte ${Math.round(waitMs / 1000)}s…`
        );
        await sleep(waitMs);
      }
    }
  }
  throw lastErr;
}

// Gesamtzahl + Seitenzahl (bei 200er-Seiten) für ein Fenster.
async function getSyncTotals(fromTs, toTs) {
  const first = await fetchScrobblePage(fromTs, toTs, 1, 1);
  const total = parseInt(first?.recenttracks?.['@attr']?.total || 0);
  return {total, pages: Math.max(1, Math.ceil(total / 200))};
}

// ── FIREBASE ───────────────────────────────────────────────
async function fbUpdateWithRetry(updates, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await db.ref('/').update(updates);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        console.warn(`Firebase write failed (Versuch ${attempt}/${maxAttempts}): ${e.message}`);
        await sleep(1000 * attempt);
      }
    }
  }
  throw lastErr;
}
async function fbUpdateChunked(updates) {
  const entries = Object.entries(updates);
  for (let i = 0; i < entries.length; i += FB_CHUNK) {
    await fbUpdateWithRetry(Object.fromEntries(entries.slice(i, i + FB_CHUNK)));
  }
}

// ── FENSTER-ABGLEICH ───────────────────────────────────────
// Lädt [fromTs, toTs] komplett von Last.fm (älteste Seite zuerst), schreibt
// jede Seite sofort und gleicht am Ende ab.
// opts.deletes: 'none' | 'auto' (mit Sicherheitsgrenze) | 'full'
// Rückgabe: {total, fetched, added, migrated, removed, complete, aborted}
async function syncWindow(fromTs, toTs, {deletes = 'auto', onPage} = {}) {
  const C = ScrobbleCore;
  if (!_archiveData) _archiveData = {};
  const data = _archiveData;

  // Bestand im Fenster. Für Löschentscheidungen gilt [from, to) — die
  // Grenzsekunde bleibt außen vor, weil Last.fm `to` evtl. exklusiv behandelt.
  const existing = C.slice(archiveList(), fromTs || null, toTs || null).map(e => e.key);
  const legacyByCanon = new Map();
  for (const k of existing) {
    if (!C.isLegacyKey(k)) continue;
    const c = C.keyCanonical(k);
    if (!legacyByCanon.has(c)) legacyByCanon.set(c, []);
    legacyByCanon.get(c).push(k);
  }

  const {total, pages} = await getSyncTotals(fromTs, toTs);
  const res = {
    total,
    fetched: 0,
    added: 0,
    migrated: 0,
    removed: 0,
    complete: false,
    aborted: false,
  };
  if (total === 0 && existing.length === 0) {
    res.complete = true;
    return res;
  }

  const occ = new Map();
  const desired = new Set();
  let done = 0;
  for (let page = pages; page >= 1 && total > 0; page--) {
    if (_importAborted) {
      res.aborted = true;
      break;
    }
    const d = await fetchScrobblePage(fromTs, toTs, page, 200);
    // Innerhalb der Seite älteste zuerst → stabile Reihenfolge für _d2-Suffixe
    const tracks = asArray(d?.recenttracks?.track).slice().reverse();
    const updates = {};
    const put = {},
      drop = [];
    for (const t of tracks) {
      if (t['@attr']?.nowplaying) continue;
      const ts = parseInt(t.date?.uts);
      if (!ts || (fromTs && ts < fromTs) || (toTs && ts > toTs)) continue;
      const f = C.trackFields(t);
      const canon = C.canonicalScrobbleId(ts, f.artist, f.track);
      const n = (occ.get(canon) || 0) + 1;
      occ.set(canon, n);
      const key = C.scrobbleKey(canon, n);
      desired.add(key);
      res.fetched++;
      if (data[key]) continue;
      updates[`scrobbles/${key}`] = f;
      put[key] = f;
      // Legacy-Eintrag desselben Scrobbles im selben Update ersetzen
      const leg = legacyByCanon.get(canon);
      if (leg && leg.length) {
        const lk = leg.shift();
        updates[`scrobbles/${lk}`] = null;
        drop.push(lk);
        res.migrated++;
      } else res.added++;
    }
    if (Object.keys(updates).length) {
      await fbUpdateWithRetry(updates);
      Object.assign(data, put);
      drop.forEach(k => delete data[k]);
      archiveChanged();
    }
    done++;
    if (onPage) onPage(done, pages, res);
    await sleep(IMPORT_DELAY);
  }

  res.complete = !res.aborted && res.fetched === total;
  if (res.complete && deletes !== 'none') {
    const stale = existing.filter(k => data[k] && !desired.has(k) && (!toTs || C.keyTs(k) < toTs));
    const limit = deletes === 'full' ? Infinity : 25 + Math.ceil(existing.length * 0.1);
    if (stale.length > limit) {
      console.warn(
        `syncWindow: ${stale.length} veraltete Einträge — über der Sicherheitsgrenze (${limit}), nichts gelöscht.`
      );
    } else if (stale.length) {
      const upd = {};
      stale.forEach(k => (upd[`scrobbles/${k}`] = null));
      await fbUpdateChunked(upd);
      stale.forEach(k => delete data[k]);
      res.removed = stale.length;
      archiveChanged();
    }
  }
  return res;
}

function syncResultText(r) {
  const parts = [];
  if (r.added) parts.push(`+${fmt(r.added)} neu`);
  if (r.migrated) parts.push(`${fmt(r.migrated)} migriert`);
  if (r.removed) parts.push(`${fmt(r.removed)} entfernt`);
  return parts.join(' · ') || 'keine Änderung';
}

// ── VOLLSTÄNDIGER IMPORT ───────────────────────────────────
async function startFullImport() {
  const existingCount = await getArchiveCount();
  if (existingCount) {
    const ok = confirm(
      `⚠ Es existiert bereits ein Archiv (${fmt(existingCount)} Scrobbles).\n\n` +
        `Ein vollständiger Import löscht alle gespeicherten Daten und beginnt von vorne.\n\n` +
        `Für neue Tracks nutze „Delta-Sync“, für Abweichungen „Archiv prüfen“.\n\nWirklich neu importieren?`
    );
    if (!ok) return;
  }
  await withSyncLock('Vollständiger Import', async () => {
    _importAborted = false;
    setArchiveBusy(true);
    const statusEl = document.getElementById('archive-status');
    try {
      statusEl.textContent = 'Lösche altes Archiv…';
      await db.ref('scrobbles').remove();
      await db.ref('scrobble_meta').remove();
      _archiveData = {};
      archiveChanged();

      const toTs = Math.floor(Date.now() / 1000);
      const eta = makeETATracker();
      statusEl.textContent = 'Importiere alle Scrobbles…';
      const r = await syncWindow(null, toTs, {
        deletes: 'none',
        onPage: (done, pages, res) => {
          const pct = Math.round((done / pages) * 95);
          updateProgressBar(pct);
          updateProgressTxt(
            `${pct}% — Seite ${done}/${pages} — ${fmt(res.fetched)}/${fmt(res.total)} — ${eta.label(pct)}`
          );
        },
      });
      await saveArchiveMeta({last_import: Date.now(), key_version: 2});
      if (r.aborted) {
        statusEl.innerHTML = `Import pausiert — ${fmt(Object.keys(_archiveData).length)} Scrobbles lückenlos gespeichert.<br><span class="modal-note">„Delta-Sync“ setzt genau hier fort.</span>`;
        showToast('Import pausiert — Delta-Sync setzt fort', 'ok');
      } else {
        updateProgressBar(100);
        statusEl.innerHTML = `✓ Import abgeschlossen — <b>${fmt(Object.keys(_archiveData).length)}</b> von ${fmt(r.total)} Scrobbles archiviert.`;
        showToast('✓ Import abgeschlossen', 'ok');
      }
    } catch (e) {
      statusEl.innerHTML = `<span class="modal-note bad">Fehler: ${escapeHTML(e.message)}</span><br><span class="modal-note">Der Fortschritt bleibt erhalten — „Delta-Sync“ setzt fort.</span>`;
      showToast('Import unterbrochen', 'err');
    }
    setArchiveBusy(false);
    await refreshAfterSync();
    loadArchiveStatus();
  });
}

// ── DELTA-SYNC ─────────────────────────────────────────────
// Kern für manuellen und automatischen Sync.
async function runDeltaSync(onPage) {
  await getArchiveData();
  const latestTs = await getLatestArchivedTs();
  if (!latestTs) return null;
  const fromTs = Math.max(1, latestTs - DELTA_OVERLAP);
  const toTs = Math.floor(Date.now() / 1000);
  return syncWindow(fromTs, toTs, {deletes: 'auto', onPage});
}

async function startDeltaSync() {
  await withSyncLock('Delta-Sync', async () => {
    _importAborted = false;
    setArchiveBusy(true);
    const statusEl = document.getElementById('archive-status');
    try {
      statusEl.textContent = 'Hole neue Scrobbles (inkl. 72 h Überlappung)…';
      const eta = makeETATracker();
      const r = await runDeltaSync((done, pages) => {
        const pct = Math.round((done / pages) * 95);
        updateProgressBar(pct);
        updateProgressTxt(`${pct}% — Seite ${done}/${pages} — ${eta.label(pct)}`);
      });
      if (!r)
        statusEl.textContent =
          'Kein Archiv gefunden. Bitte zuerst den vollständigen Import durchführen.';
      else {
        await saveArchiveMeta();
        statusEl.innerHTML = `✓ Delta-Sync: ${syncResultText(r)} — Gesamt <b>${fmt(Object.keys(_archiveData).length)}</b>`;
        showToast('✓ Delta-Sync abgeschlossen', 'ok');
      }
    } catch (e) {
      statusEl.innerHTML = `<span class="modal-note bad">Fehler: ${escapeHTML(e.message)}</span>`;
      showToast('Delta-Sync fehlgeschlagen', 'err');
    }
    setArchiveBusy(false);
    await refreshAfterSync();
    updateSyncStatusLabel();
  });
}

// Automatisch beim Laden, alle 5 Min und bei Tab-Rückkehr.
async function autoBackgroundSync(silent = false) {
  return withSyncLock(
    'Auto-Sync',
    async () => {
      try {
        await getArchiveData();
        if (!(await getLatestArchivedTs())) return;
        if (!silent) updateSyncBadge('🔄 synchronisiert…', 'var(--accent)');
        const eta = makeETATracker();
        let bannerShown = false;
        const r = await runDeltaSync((done, pages) => {
          if (pages < 2) return;
          bannerShown = true;
          const pct = Math.round((done / pages) * 95);
          syncBanner(
            'syncing',
            `Scrobbles werden geladen… ${done}/${pages} · ${eta.label(pct)}`,
            pct
          );
        });
        await saveArchiveMeta();
        updateSyncStatusLabel();
        const changed = r && (r.added || r.migrated || r.removed);
        if (changed) {
          updateSyncBadge(syncResultText(r) + ' ✓', 'var(--ok)');
          syncBanner('done-new', `✓ Archiv aktualisiert: ${syncResultText(r)}`, 100);
          await refreshAfterSync();
        } else {
          if (bannerShown) document.getElementById('sync-banner')?.classList.remove('visible');
          if (!silent) updateSyncBadge('aktuell ✓', 'var(--ok)');
        }
      } catch (e) {
        if (!silent) {
          syncBanner('err', 'Sync fehlgeschlagen: ' + e.message);
          updateSyncBadge('Sync fehlgeschlagen', 'var(--bad)');
        } else console.warn('Silent sync failed:', e.message);
      }
    },
    {silent: true}
  );
}

// ── MONATS-ABGLEICH ────────────────────────────────────────
let _checkRows = null;

function archiveMonths() {
  const list = archiveList();
  const first = list.length ? new Date(list[0].ts * 1000) : new Date();
  const start = joinYear && joinYear < first.getFullYear() ? new Date(joinYear, 0, 1) : first;
  return ScrobbleCore.monthsBetween(start.getFullYear(), start.getMonth());
}

// Vergleicht Monate (Archiv vs. Last.fm). Nur lesend.
async function checkMonths(months, onStep) {
  const rows = [];
  for (let i = 0; i < months.length; i++) {
    if (_importAborted) break;
    const m = months[i];
    const d = await fetchScrobblePage(m.from, m.to - 1, 1, 1);
    const lfmN = parseInt(d?.recenttracks?.['@attr']?.total || 0);
    const archN = ScrobbleCore.slice(archiveList(), m.from, m.to).length;
    const legacy = countLegacyKeys(m.from, m.to);
    rows.push({...m, lfm: lfmN, arch: archN, legacy, diff: archN - lfmN});
    if (onStep) onStep(i + 1, months.length);
    await sleep(IMPORT_DELAY);
  }
  return rows;
}
const rowNeedsRepair = r => r.diff !== 0 || r.legacy > 0;

async function repairMonths(rows, {deletes = 'full', onStep} = {}) {
  const total = {added: 0, migrated: 0, removed: 0, incomplete: 0};
  const todo = rows.filter(rowNeedsRepair);
  for (let i = 0; i < todo.length; i++) {
    if (_importAborted) break;
    const r = await syncWindow(todo[i].from, todo[i].to - 1, {deletes});
    total.added += r.added;
    total.migrated += r.migrated;
    total.removed += r.removed;
    if (!r.complete) total.incomplete++;
    todo[i].result = r;
    if (onStep) onStep(i + 1, todo.length, todo[i]);
  }
  return total;
}

function renderCheckTable(rows) {
  const el = document.getElementById('archive-check');
  if (!el) return;
  const bad = rows.filter(rowNeedsRepair);
  const label = r =>
    new Date(r.y, r.m, 1).toLocaleDateString('de-DE', {month: 'short', year: 'numeric'});
  const shown = bad.length ? bad : rows.slice(-6);
  const cell = r => {
    if (r.result) return `<td class="ok">${escapeHTML(syncResultText(r.result))}</td>`;
    const d = r.diff;
    return `<td class="${d === 0 ? 'ok' : 'bad'}">${d > 0 ? '+' : ''}${fmt(d)}${r.legacy ? ` <span class="modal-note">(${fmt(r.legacy)} alt)</span>` : ''}</td>`;
  };
  el.innerHTML = `
    <div class="modal-note">${bad.length ? `${bad.length} von ${rows.length} Monaten weichen ab oder brauchen Migration:` : `✓ Alle ${rows.length} Monate stimmen mit Last.fm überein.`}</div>
    <div class="table-scroll"><table class="vault-table">
      <thead><tr><th>Monat</th><th>Archiv</th><th>Last.fm</th><th>Differenz</th></tr></thead>
      <tbody>${shown.map(r => `<tr><td>${label(r)}</td><td>${fmt(r.arch)}</td><td>${fmt(r.lfm)}</td>${cell(r)}</tr>`).join('')}</tbody>
    </table></div>`;
  el.style.display = 'block';
  const btn = document.getElementById('archive-repair-btn');
  if (btn) {
    btn.style.display = bad.length ? 'inline-block' : 'none';
    btn.textContent = `🩹 ${bad.length} ${bad.length === 1 ? 'Monat' : 'Monate'} reparieren`;
  }
}

async function startArchiveCheck() {
  await withSyncLock('Archiv-Prüfung', async () => {
    _importAborted = false;
    setArchiveBusy(true);
    const statusEl = document.getElementById('archive-status');
    try {
      await getArchiveData();
      const months = archiveMonths();
      statusEl.textContent = `Vergleiche ${months.length} Monate mit Last.fm…`;
      const eta = makeETATracker();
      _checkRows = await checkMonths(months, (i, n) => {
        const pct = Math.round((i / n) * 100);
        updateProgressBar(pct);
        updateProgressTxt(`Monat ${i}/${n} — ${eta.label(pct)}`);
      });
      renderCheckTable(_checkRows);
      const bad = _checkRows.filter(rowNeedsRepair);
      const net = bad.reduce((s, r) => s + r.diff, 0);
      const legacy = bad.reduce((s, r) => s + r.legacy, 0);
      statusEl.innerHTML = bad.length
        ? `Abweichung gesamt: <b>${net > 0 ? '+' : ''}${fmt(net)}</b> Scrobbles${legacy ? ` · ${fmt(legacy)} Einträge im alten Format` : ''}.<br><span class="modal-note">„Reparieren“ lädt nur diese Monate neu, ergänzt Fehlendes und entfernt Duplikate bzw. bei Last.fm gelöschte Scrobbles.</span>`
        : '✓ Archiv ist vollständig und frei von Duplikaten.';
      if (!bad.length && !countLegacyKeys())
        await saveArchiveMeta({key_version: 2, last_check: Date.now()});
    } catch (e) {
      statusEl.innerHTML = `<span class="modal-note bad">Fehler: ${escapeHTML(e.message)}</span>`;
    }
    setArchiveBusy(false);
    if (_checkRows?.some(rowNeedsRepair))
      document.getElementById('archive-repair-btn').style.display = 'inline-block';
  });
}

async function startArchiveRepair() {
  if (!_checkRows) return startArchiveCheck();
  await withSyncLock('Archiv-Reparatur', async () => {
    _importAborted = false;
    setArchiveBusy(true);
    const statusEl = document.getElementById('archive-status');
    try {
      const eta = makeETATracker();
      const t = await repairMonths(_checkRows, {
        deletes: 'full',
        onStep: (i, n) => {
          const pct = Math.round((i / n) * 100);
          updateProgressBar(pct);
          updateProgressTxt(`Monat ${i}/${n} repariert — ${eta.label(pct)}`);
          renderCheckTable(_checkRows);
        },
      });
      const done = !_importAborted && !t.incomplete && !countLegacyKeys();
      await saveArchiveMeta(done ? {key_version: 2, last_check: Date.now()} : {});
      statusEl.innerHTML =
        `✓ Reparatur: ${syncResultText(t)} — Gesamt <b>${fmt(Object.keys(_archiveData).length)}</b>` +
        (t.incomplete
          ? `<br><span class="modal-note warn">${t.incomplete} Monat(e) lieferte Last.fm unvollständig — dort wurde nichts gelöscht. Später erneut prüfen.</span>`
          : '');
      showToast('✓ Archiv repariert', 'ok');
      _checkRows = null;
    } catch (e) {
      statusEl.innerHTML = `<span class="modal-note bad">Fehler: ${escapeHTML(e.message)}</span><br><span class="modal-note">Bereits reparierte Monate bleiben erhalten.</span>`;
    }
    setArchiveBusy(false);
    await refreshAfterSync();
  });
}

// Beim Start: die letzten Monate still abgleichen (nachgereichte oder
// gelöschte Scrobbles, Duplikate aus parallelen Syncs).
async function autoReconcileRecent() {
  if (isLfmDown()) return;
  return withSyncLock(
    'Monats-Abgleich',
    async () => {
      try {
        await getArchiveData();
        if (!archiveList().length) return;
        const months = archiveMonths().slice(-AUTO_RECENT_MONTHS);
        const rows = await checkMonths(months);
        if (!rows.some(rowNeedsRepair)) return;
        const t = await repairMonths(rows, {deletes: 'auto'});
        if (t.added || t.migrated || t.removed) {
          await saveArchiveMeta();
          syncBanner('done-new', `✓ Letzte Monate abgeglichen: ${syncResultText(t)}`);
          await refreshAfterSync();
        }
      } catch (e) {
        console.warn('autoReconcileRecent failed:', e.message);
      }
    },
    {silent: true}
  );
}

// ── HEALTH-CHECK ───────────────────────────────────────────
// Vergleicht Archiv-Anzahl mit dem getRecentTracks-total (dieselbe Quelle
// wie der Sync — user.getInfo.playcount driftet strukturell).
async function checkArchiveHealth() {
  if (isLfmDown() || !_archiveData) return;
  try {
    const first = await fetchScrobblePage(1, null, 1, 1);
    const lfmCount = parseInt(first?.recenttracks?.['@attr']?.total) || 0;
    if (!lfmCount) return;
    const archiveCount = Object.keys(_archiveData).length;
    const drift = lfmCount - archiveCount;
    const threshold = Math.max(5, Math.floor(lfmCount * 0.0005));
    const legacy = countLegacyKeys();
    if (Math.abs(drift) > threshold || legacy) {
      const what = legacy
        ? `${fmt(legacy)} Einträge im alten Format (mögliche Duplikate)`
        : drift > 0
          ? `${fmt(drift)} Scrobbles weniger als Last.fm`
          : `${fmt(-drift)} Scrobbles mehr als Last.fm (Duplikate?)`;
      syncBanner(
        'err',
        `⚠ Archiv: ${what}. <a href="#" data-action="openArchiveModal">Archiv prüfen</a>`,
        null,
        true
      );
    }
    console.info(`Archive health: ${archiveCount}/${lfmCount} (drift ${drift}, legacy ${legacy})`);
  } catch (e) {
    console.warn('checkArchiveHealth failed:', e);
  }
}

// ── TRACK-LÄNGEN (echte Hörzeit) ───────────────────────────
// Holt fehlende Längen im Hintergrund, nach Plays priorisiert, und speichert
// sie in track_meta. Quelle 1: Last.fm track.getInfo; Quelle 2: Deezer-API
// per JSONP (kein CORS). Fortsetzbar — jede Sitzung macht weiter.
const DURATION_DELAY = 350; // ms zwischen Tracks
let _durationsLoaded = false;
let _enrichRunning = false;

async function loadDurations() {
  if (_durationsLoaded) return;
  try {
    const snap = await db.ref('track_meta').get();
    ScrobbleCore.Durations.setMeta(snap.exists() ? snap.val() : {});
  } catch (e) {
    console.warn('track_meta read failed:', e);
  }
  _durationsLoaded = true;
  ScrobbleCore.Durations.recompute(archiveList());
}

function durationStatusText() {
  const list = archiveList();
  if (!list.length) return '';
  const tracks = new Set(list.map(e => e.tid));
  let known = 0;
  for (const t of tracks) if (ScrobbleCore.Durations.meta[t]) known++;
  const cov = Math.round(ScrobbleCore.Durations.coverage(list) * 100);
  return `Track-Längen: ${fmt(known)}/${fmt(tracks.size)} Tracks geprüft · ${cov} % der Plays mit echter Länge`;
}

function deezerJsonp(url, timeoutMs = 8000) {
  return new Promise(resolve => {
    const cb = '__dz' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    const done = v => {
      clearTimeout(timer);
      delete window[cb];
      s.remove();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    window[cb] = d => done(d);
    s.onerror = () => done(null);
    s.src = url + (url.includes('?') ? '&' : '?') + 'output=jsonp&callback=' + cb;
    document.head.appendChild(s);
  });
}

async function lookupDuration(artist, track) {
  try {
    const url = new URL(API);
    Object.entries({
      method: 'track.getInfo',
      artist,
      track,
      autocorrect: 1,
      api_key: KEY,
      format: 'json',
    }).forEach(([k, v]) => url.searchParams.set(k, v));
    const r = await fetch(url);
    if (r.ok) {
      const d = await r.json();
      const ms = parseInt(d?.track?.duration) || 0;
      if (ms > 0) return {d: Math.round(ms / 1000), s: 'lfm'};
    }
  } catch (e) {
    /* Deezer versuchen */
  }
  const q = `artist:"${artist.replace(/"/g, '')}" track:"${track.replace(/"/g, '')}"`;
  const dz = await deezerJsonp('https://api.deezer.com/search?limit=1&q=' + encodeURIComponent(q));
  const sec = parseInt(dz?.data?.[0]?.duration) || 0;
  if (sec > 0) return {d: sec, s: 'dz'};
  return {d: 0, s: 'none'};
}

async function enrichDurations() {
  if (_enrichRunning) return;
  _enrichRunning = true;
  try {
    await loadDurations();
    const meta = ScrobbleCore.Durations.meta;
    const plays = new Map();
    const names = new Map();
    for (const e of archiveList()) {
      if (!e.artist || !e.track || meta[e.tid]) continue;
      plays.set(e.tid, (plays.get(e.tid) || 0) + 1);
      if (!names.has(e.tid)) names.set(e.tid, e);
    }
    const queue = [...plays.entries()].sort((a, b) => b[1] - a[1]).map(([tid]) => tid);
    let batch = {},
      n = 0;
    const flush = async () => {
      if (!Object.keys(batch).length) return;
      try {
        await db.ref('track_meta').update(batch);
      } catch (e) {
        console.warn('track_meta write failed:', e);
      }
      batch = {};
      ScrobbleCore.Durations.recompute(archiveList());
      onDurationsUpdated();
    };
    for (const tid of queue) {
      // Pausieren, solange der Tab verborgen ist, ein Sync läuft oder Last.fm weg ist
      while (document.hidden || _syncRunning || isLfmDown()) await sleep(5000);
      const e = names.get(tid);
      const v = {...(await lookupDuration(e.artist, e.track)), t: Date.now()};
      meta[tid] = v;
      batch[tid] = v;
      if (++n % 25 === 0) await flush();
      await sleep(DURATION_DELAY);
    }
    await flush();
  } finally {
    _enrichRunning = false;
  }
}

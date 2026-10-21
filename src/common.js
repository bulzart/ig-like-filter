// Like Filter: shared page-world helpers (MAIN world, document_start). Loaded before the site
// script (instagram.js or tiktok.js), which registers an adapter with register().
// Holds the settings mirror, the status bar with the Download button, the MP4 saver and the
// stats sent to the popup.
(() => {
  'use strict';
  if (window.__likeFilter) return;

  const LS_KEY = 'iglf:settings';
  const DEFAULTS = {
    enabled: true,              // master switch for both sites
    // Instagram. These keys predate TikTok support and stay top-level so saved settings carry over.
    minLikes: 1000,
    maxLikes: null,
    scope: 'all',               // 'all' | 'videos' (photos always shown)
    surfaces: { feed: true, reels: true },
    include: { following: true, suggested: true, ads: true },
    hiddenLikes: 'count',       // 'count' | 'keep' | 'remove'
    tiktok: {
      enabled: true,
      minLikes: 10000,
      maxLikes: null,
      scope: 'all',
      surfaces: { forYou: true, following: true, explore: true },
      // 'instant' (the copy the player loaded, usually 720p) | 'best' (highest resolution, often
      // HEVC) | 'h264' (plays everywhere); the last two download again at about playback speed
      quality: 'instant',
    },
    // Both sites.
    aheadTarget: 5,             // in-range videos to have ready past the one playing; fetching stops there
    emptyPageCap: 10,           // batches in a row with nothing in range before one is shown anyway; 0 = never
    showPill: true,
    showDownload: true,         // "Download" button for the video on screen
  };

  const nativeParse = JSON.parse;

  function merge(over) {
    const o = over && typeof over === 'object' ? over : {};
    const t = o.tiktok && typeof o.tiktok === 'object' ? o.tiktok : {};
    return {
      ...DEFAULTS,
      ...o,
      surfaces: { ...DEFAULTS.surfaces, ...(o.surfaces || {}) },
      include: { ...DEFAULTS.include, ...(o.include || {}) },
      tiktok: { ...DEFAULTS.tiktok, ...t, surfaces: { ...DEFAULTS.tiktok.surfaces, ...(t.surfaces || {}) } },
    };
  }

  let settings = merge(null);
  try { settings = merge(nativeParse(localStorage.getItem(LS_KEY) || 'null')); } catch (_) { /* defaults */ }

  const fmt = (n) => (n === null || n === undefined ? '?'
    : n >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? +(n / 1e3).toFixed(1) + 'K' : String(n));
  const hasMax = (max) => max !== null && max !== undefined && max !== '';
  const rangeText = (min, max) => (hasMax(max) ? `${fmt(Number(min) || 0)}–${fmt(Number(max))}` : `≥ ${fmt(Number(min) || 0)}`);
  // Unknown counts (null) are always in range.
  const inRange = (likes, min, max) => likes === null || likes === undefined
    || (likes >= (Number(min) || 0) && !(hasMax(max) && likes > Number(max)));

  let site = null;                  // adapter from the site script
  const settingsListeners = [];

  // ---- download ----------------------------------------------------------------------------
  let dlStatus = '';
  let dlBusy = false;
  let dlTimer = null;
  function setDl(text, clearAfter) {
    dlStatus = text;
    clearTimeout(dlTimer);
    if (clearAfter) dlTimer = setTimeout(() => { dlStatus = ''; changed(); }, clearAfter);
    changed();
  }

  const progressText = (verb, got, total) => (total
    ? `${verb} ${Math.round((got / total) * 100)}%` : `${verb} ${(got / 1e6).toFixed(1)} MB`);

  // Fetch with progress. CDN links are tried in order; `init` comes from the site.
  async function fetchBlob(urls, init) {
    let res = null;
    let error = null;
    for (const url of urls) {
      try {
        const r = await fetch(url, init);
        if (r.ok) { res = r; break; }
        error = new Error(`HTTP ${r.status}`);
      } catch (e) { error = e; }
    }
    if (!res) throw error || new Error('no link');
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      setDl(progressText('Downloading', got, total));
    }
    return new Blob(parts, { type: 'video/mp4' });
  }

  // `info` from the site: { name, load(onProgress) -> Blob } for bytes it already has,
  // or { name, urls, init } to fetch.
  async function save(info) {
    const blob = info.load
      ? await info.load((got, total) => setDl(progressText('Loading', got, total)))
      : await fetchBlob(info.urls, info.init);
    const name = info.name;
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60000);
    setDl(`Saved ${name}`, 3000);
  }

  async function download() {
    if (dlBusy || !site) return;
    const cur = site.currentVideo();
    if (!cur) { setDl('No video on screen', 2500); return; }
    dlBusy = true;
    setDl('Preparing…');
    try {
      const info = await site.resolveVideo(cur.id, false);
      if (!info) throw new Error('video link not loaded yet');
      try {
        await save(info);
      } catch (e) {
        // Signed links expire or the player's copy is incomplete: ask the site for another way once.
        const fresh = await site.resolveVideo(cur.id, true);
        if (!fresh) throw e;
        await save(fresh);
      }
    } catch (e) {
      setDl(`Download failed: ${e.message}`, 4000);
    } finally {
      dlBusy = false;
    }
  }

  // ---- status bar (pill + download button) + stats -----------------------------------------
  let bar = null;
  let pillEl = null;
  let dlEl = null;
  let pillHidden = false;
  function renderBar() {
    if (!document.body || !site) return;
    const pillText = settings.showPill && !pillHidden ? site.pillText() : null;
    const cur = settings.showDownload ? site.currentVideo() : null;
    const showDl = settings.showDownload && (!!cur || dlBusy || !!dlStatus);
    if (!pillText && !showDl) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'lf-bar';
      dlEl = document.createElement('button');
      dlEl.id = 'lf-dl';
      dlEl.type = 'button';
      dlEl.addEventListener('click', (e) => { e.stopPropagation(); download(); });
      pillEl = document.createElement('div');
      pillEl.id = 'lf-pill';
      pillEl.title = 'Like Filter: click to hide for this page';
      pillEl.addEventListener('click', () => { pillHidden = true; renderBar(); });
      bar.append(dlEl, pillEl);
    }
    if (!bar.isConnected) document.body.appendChild(bar);
    // Only touch the DOM on a real change: our own mutations wake the site script's observer again.
    const dlText = dlStatus || (cur ? cur.label : '');
    if (dlEl.textContent !== dlText) dlEl.textContent = dlText;
    const dlTitle = `Save this video as MP4 (Alt+Shift+D) · ${cur ? cur.id : ''}`;
    if (dlEl.title !== dlTitle) dlEl.title = dlTitle;
    if (dlEl.hidden === showDl) dlEl.hidden = !showDl;
    if (pillText && pillEl.textContent !== pillText) pillEl.textContent = pillText;
    if (pillEl.hidden === !!pillText) pillEl.hidden = !pillText;
  }

  let pending = false;
  function changed() {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      renderBar();
      if (!site) return;
      const cur = site.currentVideo();
      const stats = { ...site.stats(), current: cur ? cur.id : null, download: dlStatus };
      window.postMessage({ __iglf: 'stats', stats }, location.origin);
    }, 250);
  }

  // ---- wiring ------------------------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    #lf-bar {
      position: fixed; right: 24px; bottom: 84px; z-index: 2147483000; max-width: calc(100vw - 32px);
      display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
      font: 12px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; user-select: none;
    }
    #lf-bar [hidden] { display: none !important; }
    #lf-pill, #lf-dl {
      max-width: 100%; padding: 6px 12px; border-radius: 999px; cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #lf-pill { background: rgba(0,0,0,.72); color: #fff; }
    #lf-dl {
      border: 0; background: #0095f6; color: #fff; font: 600 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
      padding: 8px 14px; box-shadow: 0 2px 8px rgba(0,0,0,.25);
    }
    #lf-dl:hover { background: #1877f2; }
    @media (max-width: 767px) {
      #lf-bar { right: auto; left: 50%; transform: translateX(-50%); bottom: 64px; align-items: center; }
    }`;
  (document.head || document.documentElement).appendChild(style);

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyD') {
      e.preventDefault();
      e.stopPropagation();
      download();
    }
  }, true);
  // Capture phase: the feeds scroll inside their own containers, not the window.
  document.addEventListener('scroll', changed, { passive: true, capture: true });

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__iglf === 'download') { download(); return; }
    if (e.data.__iglf !== 'settings') return;
    settings = merge(e.data.settings);
    settingsListeners.forEach((fn) => fn(settings));
    changed();
  });

  window.__likeFilter = {
    get settings() { return settings; },
    nativeParse,
    fmt,
    rangeText,
    inRange,
    changed,
    onSettings(fn) { settingsListeners.push(fn); },
    // adapter: { currentVideo() -> {id, label} | null,
    //            resolveVideo(id, fresh) -> Promise<{name, load} | {name, urls, init} | null>,
    //            pillText() -> string | null, stats() -> object }
    register(adapter) { site = adapter; changed(); },
  };
})();

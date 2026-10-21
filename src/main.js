// IG Like Filter: page-world script (MAIN world, document_start).
//
// How Instagram delivers posts (observed 2026-10-21):
//   - First page: server-rendered into <script type="application/json" data-sjs> tags
//     (ScheduledServerJS -> RelayPrefetchedStreamCache -> ...RelayPreloader).
//   - Next pages: XHR POST /graphql/query (persisted doc_id, variables = cursor + page size
//     + view telemetry). There is no like-count argument, so the server cannot filter for us.
//   - Every payload, inline or XHR, is turned into objects with JSON.parse
//     (ghlParseRelayResponse -> parsePayload) before Relay/React see it.
//
// So the filter sits on JSON.parse: posts outside the range are removed from the parsed
// payload and Instagram never renders them. Nothing changes in the request Instagram sends.
// A DOM pass handles posts that were already on screen (settings changed mid-session).
(() => {
  'use strict';
  if (window.__iglfLoaded) return;
  window.__iglfLoaded = true;

  const LS_KEY = 'iglf:settings';
  const FEED_CONN = 'xdt_api__v1__feed__timeline__connection';
  const REELS_CONN = 'xdt_api__v1__clips__home__connection_v2';
  const REELS_ADS = 'xdt_injected_reels_units';

  const DEFAULTS = {
    enabled: true,
    minLikes: 1000,
    maxLikes: null,
    scope: 'all',               // 'all' | 'videos' (photos always shown)
    surfaces: { feed: true, reels: true },
    include: { following: true, suggested: true, ads: true },
    hiddenLikes: 'count',       // 'count' | 'keep' | 'remove'
    emptyPageCap: 10,           // fully-filtered pages in a row before one is shown anyway; 0 = never
    showPill: true,
  };

  const nativeParse = JSON.parse;

  function merge(over) {
    const o = over && typeof over === 'object' ? over : {};
    return {
      ...DEFAULTS,
      ...o,
      surfaces: { ...DEFAULTS.surfaces, ...(o.surfaces || {}) },
      include: { ...DEFAULTS.include, ...(o.include || {}) },
    };
  }

  let settings = merge(null);
  try { settings = merge(nativeParse(localStorage.getItem(LS_KEY) || 'null')); } catch (_) { /* defaults */ }

  // ---- state -------------------------------------------------------------------------------
  const media = new Map();          // code -> record (likes, kind, surface...) for every post seen
  const allowed = new Set();        // codes let through by the empty-page cap
  const revealed = new Set();       // codes the user tapped open
  const skipped = new Set();        // reels auto-skipped once
  const hiddenCodes = new Set();
  const seenPages = new Set();
  const emptyRun = { feed: 0, reels: 0 };
  let passedByCap = 0;

  const CODE_RE = /\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/;
  const codeFromPath = (path) => { const m = CODE_RE.exec(path); return m ? m[1] : null; };
  const pinnedCode = codeFromPath(location.pathname);   // a post/reel opened by link is never filtered

  // ---- verdict -----------------------------------------------------------------------------
  function isVideo(m) {
    if (m.media_type === 2 || m.product_type === 'clips' || m.product_type === 'igtv') return true;
    return m.media_type === 8 && Array.isArray(m.carousel_media)
      && m.carousel_media.some((c) => c && c.media_type === 2);
  }

  function remember(m, kind, surface) {
    if (!m || typeof m !== 'object' || !m.code) return null;
    const rec = {
      code: m.code,
      likes: typeof m.like_count === 'number' ? m.like_count : null,
      hidden: m.like_and_view_counts_disabled === true,
      video: isVideo(m),
      kind,       // 'following' | 'suggested' | 'ads' | 'reel'
      surface,    // 'feed' | 'reels'
    };
    media.set(rec.code, rec);
    return rec;
  }

  function keep(rec) {
    const s = settings;
    if (!s.enabled || !s.surfaces[rec.surface]) return true;
    if (rec.kind !== 'reel' && s.include[rec.kind] === false) return true;
    if (rec.code === pinnedCode || rec.code === codeFromPath(location.pathname)) return true;
    if (allowed.has(rec.code) || revealed.has(rec.code)) return true;
    if (s.scope === 'videos' && !rec.video) return true;
    if (rec.hidden && s.hiddenLikes === 'keep') return true;
    if (rec.hidden && s.hiddenLikes === 'remove') return false;
    if (rec.likes === null) return true;
    if (rec.likes < (Number(s.minLikes) || 0)) return false;
    if (s.maxLikes !== null && s.maxLikes !== '' && rec.likes > Number(s.maxLikes)) return false;
    return true;
  }

  // ---- payload filtering -------------------------------------------------------------------
  function pickMedia(node, surface) {
    if (!node || typeof node !== 'object') return null;
    if (node.media && node.media.code) return { m: node.media, kind: surface === 'reels' ? 'reel' : 'following' };
    if (node.explore_story && node.explore_story.media) return { m: node.explore_story.media, kind: 'suggested' };
    if (node.ad) {
      const m = (Array.isArray(node.ad.items) && node.ad.items[0]) || node.ad.media;
      if (m && m.code) return { m, kind: 'ads' };
    }
    return null;
  }

  function filterConnection(conn, surface) {
    const kept = [];
    const dropped = [];
    let keptMedia = 0;
    for (const edge of conn.edges) {
      const found = pickMedia(edge && edge.node, surface);
      const rec = found && remember(found.m, found.kind, surface);
      if (!rec) { kept.push(edge); continue; }
      if (keep(rec)) { kept.push(edge); keptMedia++; } else dropped.push(rec);
    }
    if (!dropped.length) {
      if (keptMedia) emptyRun[surface] = 0;
      return;
    }
    // Instagram may parse the same payload more than once; count each page only once.
    const key = surface + ':' + conn.edges.map((e) => { const f = pickMedia(e && e.node, surface); return f ? f.m.code : '-'; }).join(',');
    const fresh = !seenPages.has(key);
    seenPages.add(key);

    if (keptMedia === 0) {
      if (fresh) emptyRun[surface]++;
      // A page with nothing in range leaves the loader on screen, and Instagram re-requests
      // about every 3 s. After `emptyPageCap` such pages, show one so the feed settles.
      const cap = Number(settings.emptyPageCap) || 0;
      if (cap > 0 && emptyRun[surface] >= cap) {
        dropped.forEach((r) => allowed.add(r.code));
        passedByCap += dropped.length;
        emptyRun[surface] = 0;
        changed();
        return;
      }
    } else if (fresh) {
      emptyRun[surface] = 0;
    }
    dropped.forEach((r) => hiddenCodes.add(r.code));
    conn.edges = kept;
    changed();
  }

  function filterReelAds(unit) {
    unit.ad_media_items = unit.ad_media_items.filter((ad) => {
      const m = ad && Array.isArray(ad.items) && ad.items[0];
      const rec = m && remember(m, 'ads', 'reels');
      if (!rec || keep(rec)) return true;
      hiddenCodes.add(rec.code);
      return false;
    });
    changed();
  }

  // Record-only pass: learn like counts without changing the payload.
  function recordConnection(conn, surface) {
    for (const edge of conn.edges) {
      const found = pickMedia(edge && edge.node, surface);
      if (found) remember(found.m, found.kind, surface);
    }
  }

  function filterTree(root, recordOnly) {
    const stack = [root];
    let guard = 0;
    while (stack.length && guard++ < 500000) {
      const o = stack.pop();
      if (Array.isArray(o)) {
        for (let i = 0; i < o.length; i++) if (o[i] && typeof o[i] === 'object') stack.push(o[i]);
        continue;
      }
      for (const k in o) {
        const v = o[k];
        if (!v || typeof v !== 'object') continue;
        if ((k === FEED_CONN || k === REELS_CONN) && Array.isArray(v.edges)) {
          const surface = k === FEED_CONN ? 'feed' : 'reels';
          if (recordOnly) recordConnection(v, surface); else filterConnection(v, surface);
        } else if (k === REELS_ADS && Array.isArray(v.ad_media_items)) {
          if (!recordOnly) filterReelAds(v);
        } else {
          stack.push(v);
        }
      }
    }
  }

  const hasKey = (text) => text.includes(FEED_CONN) || text.includes(REELS_CONN) || text.includes(REELS_ADS);

  function parse(text, reviver) {
    const out = nativeParse.apply(this, arguments);
    if (typeof text === 'string' && text.length > 512 && out && typeof out === 'object' && hasKey(text)) {
      try { filterTree(out, false); } catch (e) { console.warn('[IG Like Filter]', e); }
    }
    return out;
  }
  Object.defineProperty(parse, 'toString', { value: () => 'function parse() { [native code] }' });
  JSON.parse = parse;

  // ---- DOM fallback: posts already on screen -----------------------------------------------
  const fmt = (n) => (n === null ? '?' : n >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? +(n / 1e3).toFixed(1) + 'K' : String(n));
  const rangeText = () => (settings.maxLikes !== null && settings.maxLikes !== ''
    ? `${fmt(Number(settings.minLikes) || 0)}–${fmt(Number(settings.maxLikes))}`
    : `≥ ${fmt(Number(settings.minLikes) || 0)}`);

  function articleCode(article) {
    for (const a of article.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
      const code = codeFromPath(a.getAttribute('href') || '');
      if (code) return code;
    }
    return null;
  }

  function scanFeed() {
    if (location.pathname !== '/') return;
    for (const article of document.querySelectorAll('article')) {
      const code = articleCode(article);
      const rec = code && media.get(code);
      if (rec && !keep(rec)) {
        if (article.dataset.iglf !== 'hidden') {
          article.dataset.iglf = 'hidden';
          article.dataset.iglfCode = code;
          article.dataset.iglfLabel = `Hidden by IG Like Filter · ${fmt(rec.likes)} likes (range ${rangeText()}) · tap to show`;
          hiddenCodes.add(code);
        }
      } else if (article.dataset.iglf === 'hidden') {
        delete article.dataset.iglf;
      }
    }
  }

  let lastReel = null;
  function scanReels() {
    const m = /^\/reels?\/([A-Za-z0-9_-]+)/.exec(location.pathname);
    if (!m || m[1] === lastReel) return;
    const code = (lastReel = m[1]);
    const rec = media.get(code);
    if (!rec || skipped.has(code) || code === pinnedCode) return;
    // keep() always keeps the code in the URL, so judge this reel without that exemption.
    const s = settings;
    const out = s.enabled && s.surfaces.reels && !allowed.has(code) && !revealed.has(code)
      && !(s.scope === 'videos' && !rec.video) && rec.likes !== null
      && (rec.likes < (Number(s.minLikes) || 0) || (s.maxLikes !== null && s.maxLikes !== '' && rec.likes > Number(s.maxLikes)));
    if (!out) return;
    skipped.add(code);
    setTimeout(() => {
      if (codeFromPath(location.pathname) !== code) return;
      const next = [...document.querySelectorAll('[aria-label]')].find((b) => /next reel/i.test(b.getAttribute('aria-label')));
      if (next) next.click();
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }));
    }, 200);
  }

  // ---- status pill + stats -----------------------------------------------------------------
  let pill = null;
  function renderPill() {
    if (!document.body) return;
    if (!settings.enabled || !settings.showPill) { if (pill) pill.remove(); pill = null; return; }
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'iglf-pill';
      pill.title = 'IG Like Filter: click to hide for this page';
      pill.addEventListener('click', () => { settings.showPill = false; renderPill(); });
    }
    if (!pill.isConnected) document.body.appendChild(pill);
    const searching = Math.max(emptyRun.feed, emptyRun.reels);
    const text = `Likes ${rangeText()} · hidden ${hiddenCodes.size} of ${media.size}`
      + (searching ? ` · searching (${searching} empty page${searching > 1 ? 's' : ''})` : '');
    // Only touch the DOM on a real change: our own mutation would wake the observer again.
    if (pill.textContent !== text) pill.textContent = text;
  }

  function stats() {
    return {
      checked: media.size, hidden: hiddenCodes.size, passedByCap,
      searching: Math.max(emptyRun.feed, emptyRun.reels), path: location.pathname,
    };
  }

  let pending = false;
  function changed() {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      renderPill();
      window.postMessage({ __iglf: 'stats', stats: stats() }, location.origin);
    }, 250);
  }

  let scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scanFeed();
      scanReels();
      changed();
    });
  }

  // ---- wiring ------------------------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    article[data-iglf="hidden"] > * { display: none !important; }
    article[data-iglf="hidden"] { cursor: pointer; }
    article[data-iglf="hidden"]::before {
      content: attr(data-iglf-label); display: block; margin: 6px 0; padding: 10px 14px;
      border: 1px dashed rgba(128,128,128,.5); border-radius: 8px;
      font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: rgb(142,142,142);
    }
    #iglf-pill {
      position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 2147483000;
      max-width: calc(100vw - 32px); padding: 6px 12px; border-radius: 999px;
      background: rgba(0,0,0,.72); color: #fff; font: 12px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
      cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; user-select: none;
    }
    @media (max-width: 767px) { #iglf-pill { bottom: 64px; } }`;
  (document.head || document.documentElement).appendChild(style);

  document.addEventListener('click', (e) => {
    const article = e.target instanceof Element && e.target.closest('article[data-iglf="hidden"]');
    if (!article) return;
    e.preventDefault();
    e.stopPropagation();
    revealed.add(article.dataset.iglfCode);
    delete article.dataset.iglf;
  }, true);

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__iglf !== 'settings') return;
    settings = merge(e.data.settings);
    lastReel = null;
    queueScan();
  });

  // Server-rendered first page arrives as <script type="application/json" data-sjs>. If
  // Instagram reads it without JSON.parse, the hook above misses it, so record its like
  // counts here and let the DOM pass collapse what is out of range.
  const harvested = new WeakSet();
  function harvest(script) {
    if (harvested.has(script)) return;
    const text = script.textContent;
    if (!text || text.length < 512 || !hasKey(text)) return;
    try {
      filterTree(nativeParse(text), true);
      harvested.add(script);
    } catch (_) { /* still streaming in: retried when more text arrives */ }
  }
  const harvestAll = () => document.querySelectorAll('script[type="application/json"]').forEach(harvest);
  harvestAll();
  document.addEventListener('DOMContentLoaded', () => { harvestAll(); queueScan(); });

  new MutationObserver((records) => {
    for (const r of records) {
      // The HTML parser can add a script's text in chunks, so watch its text nodes too.
      if (r.target.nodeName === 'SCRIPT' && r.target.type === 'application/json') harvest(r.target);
      for (const n of r.addedNodes) {
        if (n.nodeName === 'SCRIPT' && n.type === 'application/json') harvest(n);
      }
    }
    queueScan();
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', queueScan);
})();

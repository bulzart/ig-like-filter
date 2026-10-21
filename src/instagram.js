// Like Filter: Instagram page-world script (MAIN world, document_start), after common.js.
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
// On Reels a reserve keeps a few in-range reels ready past the one playing (see releaseReels()).
//
// The same payloads carry each video's MP4 links (`video_versions`), which the "Download"
// button uses to save the reel or video on screen.
(() => {
  'use strict';
  const LF = window.__likeFilter;
  if (!LF || window.__iglfLoaded) return;
  window.__iglfLoaded = true;

  const FEED_CONN = 'xdt_api__v1__feed__timeline__connection';
  const REELS_CONN = 'xdt_api__v1__clips__home__connection_v2';
  const REELS_ADS = 'xdt_injected_reels_units';
  const nativeParse = LF.nativeParse;

  // ---- state -------------------------------------------------------------------------------
  const media = new Map();          // code -> record (likes, kind, surface...) for every post seen
  const videos = new Map();         // code -> { url, width, height, user } best MP4 with audio
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
    const s = LF.settings;
    if (!s.enabled || !s.surfaces[rec.surface]) return true;
    if (rec.kind !== 'reel' && s.include[rec.kind] === false) return true;
    if (rec.code === pinnedCode || rec.code === codeFromPath(location.pathname)) return true;
    if (allowed.has(rec.code) || revealed.has(rec.code)) return true;
    if (s.scope === 'videos' && !rec.video) return true;
    if (rec.hidden && s.hiddenLikes === 'keep') return true;
    if (rec.hidden && s.hiddenLikes === 'remove') return false;
    return LF.inRange(rec.likes, s.minLikes, s.maxLikes);
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

  const codeOfEdge = (edge, surface) => { const f = pickMedia(edge && edge.node, surface); return f ? f.m.code : null; };

  // Home feed: out-of-range posts are dropped. A page with nothing in range leaves the loader on
  // screen and Instagram re-requests about every 3 s; after `emptyPageCap` such pages one is shown.
  function filterConnection(conn, surface) {
    if (surface === 'reels') { conn.edges = releaseReels(conn.edges); return; }
    const kept = [];
    const dropped = [];
    let keptMedia = 0;
    for (const edge of conn.edges) {
      const found = pickMedia(edge && edge.node, surface);
      const rec = found && remember(found.m, found.kind, surface);
      if (!rec) { kept.push(edge); continue; }
      if (keep(rec)) { kept.push(edge); keptMedia++; } else dropped.push({ rec, edge });
    }
    if (!dropped.length) {
      if (keptMedia) emptyRun[surface] = 0;
      return;
    }
    // Instagram may parse the same payload more than once; count each page only once.
    const key = surface + ':' + conn.edges.map((e) => codeOfEdge(e, surface) || '-').join(',');
    const fresh = !seenPages.has(key);
    seenPages.add(key);

    if (keptMedia === 0) {
      if (fresh) emptyRun[surface]++;
      const cap = Number(LF.settings.emptyPageCap) || 0;
      if (cap > 0 && emptyRun[surface] >= cap) {
        dropped.forEach((d) => allowed.add(d.rec.code));
        passedByCap += dropped.length;
        emptyRun[surface] = 0;
        LF.changed();
        return;
      }
    } else if (fresh) {
      emptyRun[surface] = 0;
    }
    for (const d of dropped) hiddenCodes.add(d.rec.code);
    conn.edges = kept;
    LF.changed();
  }

  // ---- reels: keep some in-range reels ready ahead ----------------------------------------
  const reelReserve = [];           // in-range reel edges held back, oldest first
  const reelList = [];              // codes in the order Instagram got them: its list
  const anchorCodes = new Set();    // out-of-range reels handed over only to keep the player moving
  const decidedReels = new Map();   // batch -> edges handed over (a payload can be parsed twice)

  // In-range reels in Instagram's list past the one on screen (/reels/CODE).
  function reelsReady() {
    const code = codeFromPath(location.pathname);
    const rest = reelList.slice((code ? reelList.lastIndexOf(code) : -1) + 1);
    return rest.filter((c) => !anchorCodes.has(c)).length;
  }

  // The Reels player asks for more only near the end of its list, and an empty batch leaves a
  // blank page that never loads again. So:
  //   - in-range reels go to a reserve. While fewer than `aheadTarget` are ready past the one on
  //     screen, one per batch is handed over, which keeps Instagram at the end of its list and
  //     fetching in the background;
  //   - once enough are ready, the whole reserve is handed over and Instagram stops by itself, so
  //     nothing more is fetched (memory and network stay bounded);
  //   - a batch with nothing in range still hands over one reel (from the reserve, else the
  //     most-liked out-of-range one as an anchor that scanReels() skips), so the page never goes blank;
  //   - after `emptyPageCap` batches in a row with nothing in range, a batch is shown as it is.
  function releaseReels(edges) {
    const key = edges.map((e) => codeOfEdge(e, 'reels') || '-').join(',');
    if (decidedReels.has(key)) return decidedReels.get(key).slice();
    const inRange = [];
    const dropped = [];
    const other = [];               // edges that are not reels: passed through
    for (const edge of edges) {
      const found = pickMedia(edge && edge.node, 'reels');
      const rec = found && remember(found.m, found.kind, 'reels');
      if (!rec) other.push(edge);
      else if (keep(rec)) inRange.push(edge);
      else dropped.push({ rec, edge });
    }
    let give;
    if (!LF.settings.enabled || !LF.settings.surfaces.reels) {
      give = [...reelReserve.splice(0), ...inRange];   // filter off: hand over anything held back too
    } else {
      for (const edge of inRange) {
        const code = codeOfEdge(edge, 'reels');
        if (!reelReserve.some((e) => codeOfEdge(e, 'reels') === code)) reelReserve.push(edge);
      }
      const target = Math.min(20, Math.max(1, Number(LF.settings.aheadTarget) || 5));
      give = reelsReady() + reelReserve.length >= target ? reelReserve.splice(0) : reelReserve.splice(0, 1);
      if (inRange.length) emptyRun.reels = 0;
      else if (dropped.length) emptyRun.reels++;
      if (!give.length && dropped.length) {
        const cap = Number(LF.settings.emptyPageCap) || 0;
        if (cap > 0 && emptyRun.reels >= cap) {
          dropped.forEach((d) => allowed.add(d.rec.code));
          passedByCap += dropped.length;
          emptyRun.reels = 0;
          give.push(...dropped.map((d) => d.edge));
        } else {
          const anchor = dropped.reduce((a, d) => ((d.rec.likes || 0) > (a.rec.likes || 0) ? d : a));
          anchorCodes.add(anchor.rec.code);
          give.push(anchor.edge);
        }
      }
    }
    for (const d of dropped) if (!give.includes(d.edge)) hiddenCodes.add(d.rec.code);
    reelList.push(...give.map((e) => codeOfEdge(e, 'reels')));
    const out = [...give, ...other];
    decidedReels.set(key, out);
    if (decidedReels.size > 40) decidedReels.delete(decidedReels.keys().next().value);
    LF.changed();
    return out.slice();
  }

  function filterReelAds(unit) {
    unit.ad_media_items = unit.ad_media_items.filter((ad) => {
      const m = ad && Array.isArray(ad.items) && ad.items[0];
      const rec = m && remember(m, 'ads', 'reels');
      if (!rec || keep(rec)) return true;
      hiddenCodes.add(rec.code);
      return false;
    });
    LF.changed();
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

  // ---- video links (for the download button) ----------------------------------------------
  // `video_versions` holds progressive MP4s with audio (720p on reels). Higher resolutions only
  // exist in `video_dash_manifest` as separate video and audio tracks, so they are not used.
  function bestVersion(list) {
    let best = null;
    for (const v of list) {
      if (v && v.url && (!best || (v.width || 0) * (v.height || 0) > (best.width || 0) * (best.height || 0))) best = v;
    }
    return best;
  }

  function collectVideos(root) {
    const stack = [root];
    let guard = 0;
    while (stack.length && guard++ < 500000) {
      const o = stack.pop();
      if (Array.isArray(o)) {
        for (let i = 0; i < o.length; i++) if (o[i] && typeof o[i] === 'object') stack.push(o[i]);
        continue;
      }
      if (typeof o.code === 'string') {
        let src = Array.isArray(o.video_versions) && o.video_versions.length ? o : null;
        if (!src && Array.isArray(o.carousel_media)) {
          src = o.carousel_media.find((c) => c && Array.isArray(c.video_versions) && c.video_versions.length) || null;
        }
        const best = src && bestVersion(src.video_versions);
        if (best) {
          videos.set(o.code, {
            url: best.url, width: best.width, height: best.height,
            user: (o.user && o.user.username) || (o.owner && o.owner.username) || null,
          });
        }
      }
      for (const k in o) if (o[k] && typeof o[k] === 'object') stack.push(o[k]);
    }
  }

  const hasKey = (text) => text.includes(FEED_CONN) || text.includes(REELS_CONN) || text.includes(REELS_ADS);
  const hasVideo = (text) => text.includes('"video_versions"');

  function parse(text, reviver) {
    const out = nativeParse.apply(this, arguments);
    if (typeof text === 'string' && text.length > 512 && out && typeof out === 'object') {
      try {
        if (hasVideo(text)) collectVideos(out);
        if (hasKey(text)) filterTree(out, false);
      } catch (e) { console.warn('[Like Filter]', e); }
    }
    return out;
  }
  Object.defineProperty(parse, 'toString', { value: () => 'function parse() { [native code] }' });
  JSON.parse = parse;

  // ---- DOM fallback: posts already on screen -----------------------------------------------
  const rangeText = () => LF.rangeText(LF.settings.minLikes, LF.settings.maxLikes);

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
          article.dataset.iglfLabel = `Hidden by Like Filter · ${LF.fmt(rec.likes)} likes (range ${rangeText()}) · tap to show`;
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
    const s = LF.settings;
    const out = s.enabled && s.surfaces.reels && !allowed.has(code) && !revealed.has(code)
      && !(s.scope === 'videos' && !rec.video) && rec.likes !== null
      && !LF.inRange(rec.likes, s.minLikes, s.maxLikes);
    if (!out) return;
    skipped.add(code);
    hiddenCodes.add(code);
    setTimeout(() => {
      if (codeFromPath(location.pathname) !== code) return;
      const next = [...document.querySelectorAll('[aria-label]')].find((b) => /next reel/i.test(b.getAttribute('aria-label')));
      if (next) next.click();
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }));
    }, 200);
  }

  // ---- download the video on screen --------------------------------------------------------
  // Current video: the code in the address bar (/reels/CODE, /reel/CODE, /p/CODE), otherwise
  // the most visible <video> (playing ones count double) and the post link around it.
  function currentVideoCode() {
    const fromUrl = codeFromPath(location.pathname);
    if (fromUrl) return fromUrl;
    let best = null;
    let bestScore = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      if (w <= 0 || h <= 0) continue;
      const score = w * h * (v.paused ? 1 : 2);
      if (score > bestScore) { bestScore = score; best = v; }
    }
    if (!best) return null;
    const article = best.closest('article');
    if (article) return articleCode(article);
    let el = best.parentElement;
    for (let i = 0; el && i < 15; i++, el = el.parentElement) {
      const a = el.querySelector('a[href*="/p/"], a[href*="/reel/"]');
      if (a) return codeFromPath(a.getAttribute('href') || '');
    }
    return null;
  }

  const SHORTCODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function codeToPk(code) {
    let n = 0n;
    for (const ch of code.slice(0, 11)) n = n * 64n + BigInt(SHORTCODE.indexOf(ch));
    return n.toString();
  }

  let appId = null;
  function igAppId() {
    if (appId) return appId;
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      const m = /"X-IG-App-ID":"(\d+)"/.exec(s.textContent);
      if (m) return (appId = m[1]);
    }
    return '936619743392459';   // Instagram web's public app id, used if the page does not list it
  }

  // Fallback when the video was never in a payload we saw: the same media-info call the web app makes.
  async function fetchVideoInfo(code) {
    const res = await fetch(`/api/v1/media/${codeToPk(code)}/info/`, {
      headers: { 'X-IG-App-ID': igAppId() }, credentials: 'include',
    });
    if (!res.ok) return null;
    collectVideos(await res.json());
    return videos.get(code) || null;
  }

  const fileName = (v, code) => `${v.user || 'instagram'}_${code}.mp4`.replace(/[^\w.-]+/g, '_');

  LF.register({
    currentVideo() {
      const code = currentVideoCode();
      const rec = code && media.get(code);
      if (!code || (rec && !rec.video && !videos.has(code))) return null;
      const reel = /^\/reels?\//.test(location.pathname) || (rec && rec.surface === 'reels');
      return { id: code, label: reel ? 'Download reel' : 'Download video' };
    },
    async resolveVideo(code, fresh) {
      const v = (!fresh && videos.get(code)) || await fetchVideoInfo(code);
      return v ? { urls: [v.url], init: {}, name: fileName(v, code) } : null;
    },
    pillText() {
      if (!LF.settings.enabled) return null;
      const searching = Math.max(emptyRun.feed, emptyRun.reels);
      const ready = /^\/reels?\//.test(location.pathname) ? ` · ${reelsReady() + reelReserve.length} ready` : '';
      return `Likes ${rangeText()}${ready} · hidden ${hiddenCodes.size} of ${media.size}`
        + (searching ? ` · searching (${searching} empty page${searching > 1 ? 's' : ''})` : '');
    },
    stats() {
      return {
        site: 'instagram', checked: media.size, hidden: hiddenCodes.size, passedByCap,
        ready: /^\/reels?\//.test(location.pathname) ? reelsReady() + reelReserve.length : null,
        searching: Math.max(emptyRun.feed, emptyRun.reels),
      };
    },
  });

  let scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scanFeed();
      scanReels();
      LF.changed();
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
    }`;
  (document.head || document.documentElement).appendChild(style);

  document.addEventListener('click', (e) => {
    const article = e.target instanceof Element && e.target.closest('article[data-iglf="hidden"]');
    if (!article) return;
    e.preventDefault();
    e.stopPropagation();
    revealed.add(article.dataset.iglfCode);
    delete article.dataset.iglf;
  }, true);

  LF.onSettings(() => { lastReel = null; queueScan(); });

  // Server-rendered first page arrives as <script type="application/json" data-sjs>. If
  // Instagram reads it without JSON.parse, the hook above misses it, so record its like
  // counts here and let the DOM pass collapse what is out of range.
  const harvested = new WeakSet();
  function harvest(script) {
    if (harvested.has(script)) return;
    const text = script.textContent;
    if (!text || text.length < 512 || !(hasKey(text) || hasVideo(text))) return;
    try {
      const data = nativeParse(text);
      if (hasVideo(text)) collectVideos(data);
      if (hasKey(text)) filterTree(data, true);
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

// Like Filter: TikTok page-world script (MAIN world, document_start), after common.js.
//
// How TikTok delivers videos (observed 2026-10-21):
//   - First 3 For You videos: server-rendered into <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">
//     (__DEFAULT_SCOPE__["webapp.updated-items"]); a video page carries its video in
//     __DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct.
//   - More: fetch GET /api/recommend/item_list/ and /api/preload/item_list/ (For You: asks for 14,
//     often fewer come back), /api/following/item_list/, /api/explore/item_list/ and
//     /api/prefetch/explore/item_list/. Every query is signed once (msToken, X-Bogus, X-Gnarly):
//     replaying one returns nothing, so only TikTok's own player can fetch, and there is no
//     like-count parameter anyway.
//   - Responses are read with Response.prototype.json(), three times per response:
//     { itemList: [{ id, stats: { diggCount }, video: { playAddr, bitrateInfo[] }, author }], hasMore }.
//   - The feed is a scroll-snap list of <article data-scroll-index>; only the 1-2 around the screen
//     hold a player (<div id="xgwrapper-0-VIDEOID"><video src="blob:...">).
//   - The player asks for more while at most one video is left past the one playing, again after
//     each answer while that is still true, and gives up (loader up, "next" disabled) after an
//     answer that adds nothing.
//   - The player loads each video through window.fetch: a plain GET that preloads the start of the
//     next video, then `Range: bytes=N-` for the rest. The CDN answers new requests at about
//     playback speed and refuses them without the site's cookies (403).
//
// The filter wraps Response.prototype.json (and JSON.parse for the inline data) and drops videos
// outside the like range before the player sees them. In the player feeds it keeps a reserve so a
// few in-range videos are always ready ahead (see release()). A window.fetch wrapper keeps a copy of
// the player's video bytes so "Download" is instant.
(() => {
  'use strict';
  const LF = window.__likeFilter;
  if (!LF || window.__ttlfLoaded) return;
  window.__ttlfLoaded = true;

  const LIST_RE = /\/api\/(recommend|preload|following|explore|prefetch\/explore)\/item_list\//;
  const SURFACE = {
    recommend: 'forYou', preload: 'forYou', following: 'following', explore: 'explore', 'prefetch/explore': 'explore',
  };
  const PLAYER_FEEDS = new Set(['forYou', 'following']);   // one video at a time, "next" button
  const SSR_ID = '__UNIVERSAL_DATA_FOR_REHYDRATION__';
  const nativeParse = LF.nativeParse;

  // ---- state -------------------------------------------------------------------------------
  const items = new Map();          // id -> record (likes, video, surface, user) for every video seen
  const videos = new Map();         // id -> { video, user } raw video object, for the download
  const allowed = new Set();        // ids let through by the empty-batch cap
  const hiddenIds = new Set();
  const anchorIds = new Set();      // out-of-range videos handed over only to keep a player feed moving
  const seenPages = new Set();
  const decided = new Map();        // response -> the list TikTok got (it reads each response 3 times)
  const reserve = { forYou: [], following: [] };   // in-range videos held back, oldest first
  const handed = { forYou: [], following: [] };    // ids in the order TikTok got them: its list
  const dry = { forYou: 0, following: 0 };         // answers in a row that handed over nothing
  const emptyRun = { forYou: 0, following: 0, explore: 0 };
  let passedByCap = 0;

  const idFromPath = () => { const m = /\/video\/(\d+)/.exec(location.pathname); return m ? m[1] : null; };
  const pinnedId = idFromPath();    // a video opened by link is never filtered
  const surfaceOfPage = () => (location.pathname.startsWith('/following') ? 'following'
    : location.pathname.startsWith('/explore') ? 'explore' : 'forYou');
  // TikTok's own settings live in `settings.tiktok`; aheadTarget, emptyPageCap and the switches
  // for the pill and button are shared with Instagram at the top level.
  const tt = () => LF.settings.tiktok;
  const filtering = (surface) => LF.settings.enabled && tt().enabled && !!tt().surfaces[surface];

  // ---- verdict -----------------------------------------------------------------------------
  function likesOf(it) {
    if (it.stats && typeof it.stats.diggCount === 'number') return it.stats.diggCount;
    const v2 = it.statsV2 && Number(it.statsV2.diggCount);
    return Number.isFinite(v2) ? v2 : null;
  }

  function remember(it, surface) {
    if (!it || typeof it !== 'object' || typeof it.id !== 'string') return null;
    const rec = {
      id: it.id,
      likes: likesOf(it),
      video: !it.imagePost,       // photo slideshows carry imagePost
      surface,                    // 'forYou' | 'following' | 'explore'
      user: (it.author && it.author.uniqueId) || null,
    };
    items.set(rec.id, rec);
    return rec;
  }

  // Out of range by the settings alone, without the "opened by link / on screen" exemptions.
  function outOfRange(rec) {
    const s = tt();
    if (!filtering(rec.surface) || allowed.has(rec.id)) return false;
    if (s.scope === 'videos' && !rec.video) return false;
    return !LF.inRange(rec.likes, s.minLikes, s.maxLikes);
  }
  const keep = (rec) => rec.id === pinnedId || rec.id === idFromPath() || !outOfRange(rec);

  // ---- payload filtering -------------------------------------------------------------------
  // TikTok's list past the video playing: how many videos, and how many of them are in range.
  function aheadOf(surface) {
    const list = handed[surface];
    const id = activeVideoId();
    const rest = list.slice((id ? list.lastIndexOf(id) : -1) + 1);
    return { all: rest.length, ready: rest.filter((x) => !anchorIds.has(x)).length };
  }

  // Player feeds (For You, Following). TikTok fetches only while at most one video is left past the
  // one playing, and stops after an answer that adds nothing. So:
  //   - in-range videos go to a reserve. While fewer than `aheadTarget` are ready past the one
  //     playing, one per answer is handed over, which keeps TikTok at the end of its list and
  //     fetching in the background;
  //   - once enough are ready, the whole reserve is handed over and TikTok stops by itself, so
  //     nothing more is fetched (memory and network stay bounded);
  //   - an answer with nothing in range hands over one video from the reserve. With the reserve
  //     empty, the first such answer hands over nothing (TikTok retries once by itself) and the
  //     second an out-of-range "anchor" that scan() skips under a cover, so the player never
  //     stalls and placeholders stay rare;
  //   - after `emptyPageCap` answers in a row with nothing in range, a batch is shown as it is.
  //   (A simulation of TikTok's rules found no stalls from a 50% to a 0.1% hit rate.)
  function release(surface, inRangeItems, dropped, isNewBatch) {
    const q = reserve[surface];
    for (const it of inRangeItems) if (!q.some((x) => x.id === it.id)) q.push(it);
    const target = Math.min(20, Math.max(1, Number(LF.settings.aheadTarget) || 5));
    const give = aheadOf(surface).ready + q.length >= target ? q.splice(0) : q.splice(0, 1);
    if (inRangeItems.length) emptyRun[surface] = 0;
    else if (isNewBatch && dropped.length) emptyRun[surface]++;
    if (!give.length && dropped.length) {
      const cap = Number(LF.settings.emptyPageCap) || 0;
      if (cap > 0 && emptyRun[surface] >= cap) {
        dropped.forEach((d) => allowed.add(d.rec.id));
        passedByCap += dropped.length;
        emptyRun[surface] = 0;
        give.push(...dropped.map((d) => d.it));
      } else if (++dry[surface] >= 2) {
        const anchor = dropped.reduce((a, d) => ((d.rec.likes || 0) > (a.rec.likes || 0) ? d : a));
        anchorIds.add(anchor.rec.id);
        give.push(anchor.it);
      }
    }
    if (give.length) dry[surface] = 0;
    for (const d of dropped) if (!give.includes(d.it)) hiddenIds.add(d.rec.id);
    handed[surface].push(...give.map((it) => it.id));
    return give;
  }

  // Explore is a grid with no player to stall: just drop what is out of range.
  function filterGrid(list, dropped, kept, isNewBatch) {
    if (!dropped.length) {
      if (kept) emptyRun.explore = 0;
      return list;
    }
    if (!kept) {
      if (isNewBatch) emptyRun.explore++;
      const cap = Number(LF.settings.emptyPageCap) || 0;
      if (cap > 0 && emptyRun.explore >= cap) {
        dropped.forEach((d) => allowed.add(d.rec.id));
        passedByCap += dropped.length;
        emptyRun.explore = 0;
        return list;
      }
    } else if (isNewBatch) {
      emptyRun.explore = 0;
    }
    const out = new Set(dropped.map((d) => d.it));
    dropped.forEach((d) => hiddenIds.add(d.rec.id));
    return list.filter((it) => !out.has(it));
  }

  function filterList(list, surface, key) {
    if (decided.has(key)) return decided.get(key).slice();
    const inRangeItems = [];
    const dropped = [];
    const other = [];               // entries that are not videos: passed through
    for (const it of list) {
      const rec = remember(it, surface);
      if (!rec) other.push(it);
      else if (keep(rec)) inRangeItems.push(it);
      else dropped.push({ rec, it });
    }
    const batchKey = surface + ':' + list.map((it) => it && it.id).join(',');
    const isNewBatch = !seenPages.has(batchKey);
    seenPages.add(batchKey);
    let out;
    if (!PLAYER_FEEDS.has(surface)) {
      out = filterGrid(list, dropped, inRangeItems.length, isNewBatch);
    } else if (!filtering(surface)) {
      // Filter off: hand over anything still held back too.
      out = [...reserve[surface].splice(0), ...list];
      handed[surface].push(...out.map((it) => it && it.id));
    } else {
      out = [...release(surface, inRangeItems, dropped, isNewBatch), ...other];
    }
    decided.set(key, out);
    if (decided.size > 40) decided.delete(decided.keys().next().value);
    LF.changed();
    return out.slice();
  }

  // ---- video links (for the download button) ----------------------------------------------
  function collectVideos(root) {
    const stack = [root];
    let guard = 0;
    while (stack.length && guard++ < 500000) {
      const o = stack.pop();
      if (Array.isArray(o)) {
        for (let i = 0; i < o.length; i++) if (o[i] && typeof o[i] === 'object') stack.push(o[i]);
        continue;
      }
      if (typeof o.id === 'string' && o.video && (o.video.playAddr || Array.isArray(o.video.bitrateInfo))) {
        videos.set(o.id, { video: o.video, user: (o.author && o.author.uniqueId) || null });
      }
      for (const k in o) if (o[k] && typeof o[k] === 'object') stack.push(o[k]);
    }
  }

  // Every rendition in bitrateInfo is a complete MP4 with sound and no watermark: the highest
  // resolution (often HEVC), or with `h264Only` the best one that plays everywhere.
  function pickUrls(video, h264Only) {
    const options = [];
    for (const b of video.bitrateInfo || []) {
      const p = b && b.PlayAddr;
      if (!p || !Array.isArray(p.UrlList) || !p.UrlList.length) continue;
      options.push({
        urls: p.UrlList, pixels: (p.Width || 0) * (p.Height || 0),
        h264: !/265|hvc|hev/i.test(b.CodecType || ''), rate: b.Bitrate || 0,
      });
    }
    if (video.playAddr) {
      options.push({
        urls: [video.playAddr], pixels: (video.width || 0) * (video.height || 0),
        h264: !/265|hvc|hev/i.test(video.codecType || ''), rate: video.bitrate || 0,
      });
    }
    let pool = h264Only ? options.filter((o) => o.h264) : options;
    if (!pool.length) pool = options;
    pool.sort((a, b) => b.pixels - a.pixels || b.h264 - a.h264 || b.rate - a.rate);
    return pool.length ? pool[0].urls : null;
  }

  // ---- the player's own bytes (instant downloads) -----------------------------------------
  // TikTok's CDN serves a new request at about playback speed (a 40 s video takes ~40 s or more),
  // but the player already loads every video it shows through window.fetch: a plain GET that
  // preloads the start of the next video and is dropped after some KB, then `Range: bytes=N-`
  // for the rest once it plays. Those pieces are copied (only as fast as the player reads them)
  // for the last few videos, so "Download" can stitch together what is already loaded.
  const MAX_BUFFERS = 4;            // the one playing, the one preloaded, and a little slack
  const buffers = new Map();        // CDN path -> { total, segments: [{ start, got, parts }], listeners }
  const pathOf = (url) => { try { return new URL(url, location.href).pathname; } catch (_) { return null; } };

  function requestRange(input, init) {
    try {
      const h = (init && init.headers) || (input instanceof Request ? input.headers : null);
      const v = !h ? null : h instanceof Headers ? h.get('range') : Array.isArray(h)
        ? (h.find(([k]) => /^range$/i.test(k)) || [])[1] : h.Range || h.range;
      const m = /bytes=(\d+)-/.exec(v || '');
      return m ? Number(m[1]) : 0;
    } catch (_) { return 0; }
  }

  function keepCopy(path, res, start) {
    // "bytes 81920-1326431/1326432" on a 206; a 200 is the whole file from 0.
    const cr = /bytes (\d+)-\d+\/(\d+)/.exec(res.headers.get('content-range') || '');
    const from = cr ? Number(cr[1]) : res.status === 206 ? start : 0;
    const length = Number(res.headers.get('content-length')) || 0;
    const total = cr ? Number(cr[2]) : from + length;
    let buf = buffers.get(path);
    if (!buf || (total && buf.total && buf.total !== total)) buf = { total, segments: [], listeners: new Set() };
    buffers.delete(path);           // most recently used last
    buffers.set(path, buf);
    while (buffers.size > MAX_BUFFERS) buffers.delete(buffers.keys().next().value);
    const seg = { start: from, got: 0, parts: [] };
    buf.segments.push(seg);
    const notify = () => buf.listeners.forEach((fn) => fn());
    const reader = res.body.getReader();
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { notify(); controller.close(); return; }
          seg.parts.push(value);
          seg.got += value.length;
          notify();
          controller.enqueue(value);
        } catch (e) {
          notify();
          controller.error(e);
        }
      },
      cancel(reason) { notify(); return reader.cancel(reason); },   // a dropped preload keeps its bytes
    });
    const copy = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    for (const k of ['url', 'redirected', 'type']) Object.defineProperty(copy, k, { value: res[k] });
    return copy;
  }

  const nativeFetch = window.fetch;
  function fetchHook(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const pending = nativeFetch.apply(window, arguments);
    if (!/mime_type=video/.test(url)) return pending;
    const start = requestRange(input, init);
    return pending.then((res) => ((res.status === 200 || res.status === 206) && res.body
      ? keepCopy(pathOf(url), res, start) : res));
  }
  Object.defineProperty(fetchHook, 'toString', { value: () => 'function fetch() { [native code] }' });
  window.fetch = fetchHook;

  // How many bytes from 0 are covered without a gap, and the slices that cover them.
  function coverage(buf) {
    const slices = [];
    let pos = 0;
    for (const seg of buf.segments.slice().sort((a, b) => a.start - b.start)) {
      const end = seg.start + seg.got;
      if (seg.start > pos) break;
      if (end <= pos) continue;
      slices.push({ seg, from: pos - seg.start });
      pos = end;
    }
    return { pos, slices };
  }

  // The copy of this video the player loaded the most of.
  function bufferFor(video) {
    const paths = [];
    for (const b of video.bitrateInfo || []) for (const u of (b && b.PlayAddr && b.PlayAddr.UrlList) || []) paths.push(pathOf(u));
    if (video.playAddr) paths.push(pathOf(video.playAddr));
    let best = null;
    for (const p of new Set(paths)) {
      const buf = buffers.get(p);
      if (buf && buf.total && (!best || coverage(buf).pos > coverage(best).pos)) best = buf;
    }
    return best;
  }

  // Resolves with the file once the player has loaded all of it; gives up if loading stalls
  // (paused, skipped), and the caller then downloads it again instead.
  function waitFor(buf, onProgress) {
    return new Promise((resolve, reject) => {
      let lastPos = -1;
      let lastMove = Date.now();
      const finish = () => { buf.listeners.delete(check); clearInterval(stallTimer); };
      const check = () => {
        const { pos, slices } = coverage(buf);
        if (pos >= buf.total) {
          finish();
          resolve(new Blob(slices.map(({ seg, from }) => new Blob(seg.parts).slice(from)), { type: 'video/mp4' }));
          return;
        }
        if (pos !== lastPos) { lastPos = pos; lastMove = Date.now(); onProgress(pos, buf.total); }
      };
      const stallTimer = setInterval(() => {
        if (Date.now() - lastMove > 10000) { finish(); reject(new Error('the player stopped loading it')); }
      }, 2000);
      buf.listeners.add(check);
      check();
    });
  }

  // ---- hooks -------------------------------------------------------------------------------
  const nativeJson = Response.prototype.json;
  async function json() {
    const out = await nativeJson.apply(this, arguments);
    try {
      if (out && typeof out === 'object' && /\/api\//.test(this.url || '')) {
        collectVideos(out);
        const m = LIST_RE.exec(this.url);
        if (m && Array.isArray(out.itemList)) out.itemList = filterList(out.itemList, SURFACE[m[1]], this.url);
      }
    } catch (e) { console.warn('[Like Filter]', e); }
    return out;
  }
  Object.defineProperty(json, 'toString', { value: () => 'function json() { [native code] }' });
  Response.prototype.json = json;

  function handleScope(scope, recordOnly) {
    if (!scope || typeof scope !== 'object') return;
    collectVideos(scope);
    const list = scope['webapp.updated-items'];
    if (!Array.isArray(list)) return;
    const surface = surfaceOfPage();
    if (recordOnly) list.forEach((it) => remember(it, surface));
    else scope['webapp.updated-items'] = filterList(list, surface, `inline:${location.pathname}`);
  }

  function parse(text, reviver) {
    const out = nativeParse.apply(this, arguments);
    if (typeof text === 'string' && text.length > 512 && out && typeof out === 'object' && text.includes('__DEFAULT_SCOPE__')) {
      try { handleScope(out.__DEFAULT_SCOPE__, false); } catch (e) { console.warn('[Like Filter]', e); }
    }
    return out;
  }
  Object.defineProperty(parse, 'toString', { value: () => 'function parse() { [native code] }' });
  JSON.parse = parse;

  // ---- on screen ---------------------------------------------------------------------------
  // The most visible <video> (a playing one counts double).
  function activeVideo() {
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
    return best;
  }
  function activeVideoId() {
    const v = activeVideo();
    const wrapper = v && v.closest('[id^="xgwrapper-"]');
    return wrapper ? wrapper.id.split('-').pop() : null;
  }
  const currentVideoId = () => idFromPath() || activeVideoId();

  // DOM fallback: an out-of-range video that reaches the player (an anchor, the inline first
  // videos, settings changed mid-session) is covered and skipped with TikTok's own buttons, in the
  // direction the user is going, so scrolling back past it works too. While the next video is
  // still loading the button is disabled, so this retries until it moves on.
  let lastIndex = null;
  let lastSkip = 0;
  let retryTimer = null;
  function scan() {
    if (idFromPath()) return;                 // a video page: never skip what was opened
    const v = activeVideo();
    const article = v && v.closest('article[data-scroll-index]');
    const index = article ? Number(article.dataset.scrollIndex) : null;
    const back = lastIndex !== null && index !== null && index < lastIndex;
    if (index !== null) lastIndex = index;
    const wrapper = v && v.closest('[id^="xgwrapper-"]');
    const id = wrapper && wrapper.id.split('-').pop();
    const rec = id && items.get(id);
    if (!rec || !PLAYER_FEEDS.has(rec.surface) || id === pinnedId || !outOfRange(rec)) return;
    hiddenIds.add(id);
    if (article) article.dataset.ttlf = 'skip';
    clearTimeout(retryTimer);
    retryTimer = setTimeout(queueScan, 600);
    if (Date.now() - lastSkip < 500) return;
    lastSkip = Date.now();
    const button = document.querySelector(`[data-e2e="feed-navigation-${back ? 'prev' : 'next'}"]`);
    if (button && !button.disabled) button.click();
    else if (!button) {
      const key = back ? 'ArrowUp' : 'ArrowDown';
      document.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, keyCode: back ? 38 : 40, bubbles: true }));
    }
  }

  const readyCount = (surface) => (PLAYER_FEEDS.has(surface) ? aheadOf(surface).ready + reserve[surface].length : null);

  LF.register({
    currentVideo() {
      const id = currentVideoId();
      const rec = id && items.get(id);
      if (!id || (rec && !rec.video)) return null;
      return { id, label: 'Download video' };
    },
    // 'instant': the bytes the player loaded (usually 720p); 'best' / 'h264': fetch that rendition
    // again, at about playback speed. A failed attempt (`fresh`) falls back from the player's copy
    // to a fetch; there is no unsigned way to ask TikTok for new links.
    async resolveVideo(id, fresh) {
      const v = videos.get(id);
      if (!v) return null;
      const user = v.user || (items.get(id) && items.get(id).user) || 'tiktok';
      const name = `${user}_${id}.mp4`.replace(/[^\w.-]+/g, '_');
      const quality = tt().quality;
      if (quality === 'instant') {
        const buf = !fresh && bufferFor(v.video);
        if (buf) return { name, load: (onProgress) => waitFor(buf, onProgress) };
      } else if (fresh) {
        return null;
      }
      const urls = pickUrls(v.video, quality === 'h264');
      // The CDN wants the site's cookies on a plain GET (403 without them).
      return urls && { name, urls, init: { credentials: 'include' } };
    },
    pillText() {
      const s = tt();
      if (!LF.settings.enabled || !s.enabled) return null;
      const surface = surfaceOfPage();
      const ready = readyCount(surface);
      const searching = emptyRun[surface] || 0;
      return `Likes ${LF.rangeText(s.minLikes, s.maxLikes)}`
        + (ready !== null ? ` · ${ready} ready` : '')
        + ` · hidden ${hiddenIds.size} of ${items.size}`
        + (searching ? ` · searching (${searching} empty batch${searching > 1 ? 'es' : ''})` : '');
    },
    stats() {
      const surface = surfaceOfPage();
      return {
        site: 'tiktok', checked: items.size, hidden: hiddenIds.size, passedByCap,
        ready: readyCount(surface), searching: emptyRun[surface] || 0,
      };
    },
  });

  let scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scan();
      LF.changed();
    });
  }

  // ---- wiring ------------------------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    article[data-ttlf="skip"] { position: relative; }
    article[data-ttlf="skip"]::after {
      content: "Skipping: below your like range"; position: absolute; inset: 0; z-index: 5;
      display: flex; align-items: center; justify-content: center; background: #000; color: #8a8a8a;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
    }`;
  (document.head || document.documentElement).appendChild(style);

  LF.onSettings(() => {
    document.querySelectorAll('article[data-ttlf]').forEach((a) => { delete a.dataset.ttlf; });
    queueScan();
  });

  // If TikTok reads the inline data without JSON.parse, the hook above misses it: record the
  // like counts and video links here so scan() and the Download button still have them.
  let harvested = false;
  function harvest() {
    const s = !harvested && document.getElementById(SSR_ID);
    if (!s || !s.textContent) return;
    try {
      handleScope(nativeParse(s.textContent).__DEFAULT_SCOPE__, true);
      harvested = true;
    } catch (_) { /* still streaming in */ }
  }
  document.addEventListener('DOMContentLoaded', () => { harvest(); queueScan(); });

  new MutationObserver(() => { harvest(); queueScan(); })
    .observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', queueScan);
})();

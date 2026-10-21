# Like Filter for Instagram & TikTok

A Chrome extension (Manifest V3) that shows only the Instagram and TikTok posts whose like count is
inside a range you set (each site has its own range). Posts outside the range are dropped from the
site's own data before the page renders them, so they never appear, autoplay or count as "seen". On
Instagram Reels and TikTok a few in-range videos are always kept ready past the one playing.

It also adds a **Download** button that saves the reel or video you are watching as an MP4.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (`ig-like-filter`).
4. Pin the extension and click it to set the ranges. Reload any open Instagram or TikTok tab once.

After pulling a new version, click the reload icon on the extension's card and reload the site tabs:
Chrome keeps running the old page scripts until both happen. Needs Chrome 111 or newer.

## Settings (popup)

The popup opens on the site of the current tab; the Instagram / TikTok switch shows the other one.

| Setting | What it does |
|---|---|
| On/off switch (top) | Turns filtering off on both sites. Downloads keep working. |
| Min / Max likes | The range, per site. Accepts `2500`, `2.5k`, `1.2m`. Empty max = no upper limit. |
| All posts / Videos only | Videos only filters videos; photo posts are always shown. |
| Where | Instagram: home feed, Reels tab, and which feed posts (followed, suggested, ads). TikTok: For You, Following, Explore. |
| Hidden like counts (Instagram) | For posts whose owner hid likes: use the count Instagram still sends, always show, or always hide. |
| Download quality (TikTok) | Instant, highest resolution or H.264 (see below). |
| Keep N ready (both) | In-range videos to have ready past the one playing (default 5, 1–20). Instagram Reels and TikTok keep fetching in the background until that many are ready, then stop. |
| Show a batch anyway after N empty batches (both) | Stops a search that cannot succeed (default 10; 0 = never stop). |
| Status pill / Download button | Show or hide them on the page. The popup button and Alt+Shift+D always work. |

Changes apply right away. Instagram posts already on screen that fall out of range collapse into a thin
"Hidden by Like Filter · tap to show" bar; on TikTok an out-of-range video on screen is skipped.
Posts removed earlier come back after a reload.

## Download the video on screen

- A **Download** button appears at the bottom right (bottom centre on narrow windows) whenever a
  video is on screen. The popup has the same button, and **Alt+Shift+D** works on both sites.
- "On screen" means the video in the address bar (Instagram `/reels/CODE`, `/reel/CODE`, `/p/CODE`;
  TikTok `/@user/video/ID`), otherwise the most visible video (a playing one wins).
- Files are saved as `username_CODE.mp4` / `username_ID.mp4`, with sound and no watermark.
- **Instagram:** the MP4 Instagram itself serves with picture and sound together (`video_versions`,
  720p for reels). The 1080p version only exists as separate video and audio tracks (DASH), so it is not
  used. If the link is missing or expired, the extension asks Instagram's media-info endpoint
  (`/api/v1/media/{id}/info/`, the call the web app uses) for a fresh one.
- **TikTok:** the CDN serves new requests at about playback speed (a 40 s video takes 40 s or more) and
  refuses them without the site's cookies. So by default (**Instant**) the extension keeps a copy of the
  bytes the player itself loads (the last 4 videos, read only as fast as the player reads) and saves
  those: immediate once the video has loaded, usually 720p. **Highest resolution** (often 1080p HEVC)
  and **H.264** download the file again, at that slower speed.
- Download only what you have the right to keep; the owner's copyright still applies.

## What the sites do (inspected 2026-10-21 through Chrome)

### Instagram

**Home feed**
- The first page (about 12 posts) is not a request: it is rendered into the HTML as
  `<script type="application/json" data-sjs>` (`ScheduledServerJS` → `RelayPrefetchedStreamCache` →
  `PolarisFeedTimelineRootV2QueryRelayPreloader`).
- More pages: `POST /graphql/query`, `fb_api_req_friendly_name=PolarisFeedRootPaginationCachedQuery_subscribe`,
  a persisted `doc_id`, and `variables` = `after` cursor, `first: 12`, `variant: "home"`, `device_id`
  and `feed_view_info` (which posts you saw, for how long). Response:
  `data.xdt_api__v1__feed__timeline__connection.edges[].node` with one of
  `media` (accounts you follow), `explore_story.media` (suggested) or `ad.items[0]` (ads).
  Each has `code`, `like_count`, `comment_count`, `media_type`, `product_type`, `like_and_view_counts_disabled`.
- The next page is requested when about 5,400 px of content is left below the viewport (roughly 3 posts
  plus the list's spacer). The list is virtualised: only about 8 `<article>` elements exist at a time,
  with padding standing in for the rest.
- If a page brings nothing new to show, the loader stays on screen and Instagram asks for the next page
  about every 3 seconds with a new cursor. It does not loop faster than that.

**Reels tab**
- First reel(s): `PolarisClipsTabDesktopContainerQueryRelayPreloader`, inline in the HTML.
- More: `POST /graphql/query`, `PolarisClipsTabDesktopPaginationQuery`, `first: 10` (about 12 come back),
  `data.seen_reels` = the reels you watched. Response: `xdt_api__v1__clips__home__connection_v2.edges[].node.media`
  with `like_count` (view and play counts are null on the web).
- Reels ads come separately: `PolarisClipsAdsPoolQuery` → `xdt_injected_reels_units.ad_media_items[].items[0]`.
- The player asks for more only near the end of its list: an empty batch leaves a blank page.

**How responses are read**
- The XHR body is read while still streaming (`responseText` at readyState 3), then again when complete.
- Every payload, inline or XHR, goes through `JSON.parse` (`ghlParseRelayResponse` → `parsePayload`)
  before Relay stores it and React renders it.

### TikTok

- First 3 For You videos: inline in `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">`
  (`__DEFAULT_SCOPE__["webapp.updated-items"]`); a video page has its video in
  `__DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct`.
- More: `fetch` `GET /api/recommend/item_list/` and `/api/preload/item_list/` (For You: `count=14`, often
  fewer come back), `/api/following/item_list/`, `/api/explore/item_list/`, `/api/prefetch/explore/item_list/`.
- Every query is signed once (`msToken`, `X-Bogus`, `X-Gnarly`). Sending a signed URL again returns an
  empty reply, so only TikTok's own player can fetch. The extension never makes these requests itself.
- Responses are read with `Response.prototype.json()`, three times each:
  `{ itemList: [{ id, stats: { diggCount, playCount, … }, video: { playAddr, bitrateInfo[] }, author }], hasMore }`.
- The feed is a scroll-snap list of `<article data-scroll-index>`; only the one or two around the screen
  hold a player (`<div id="xgwrapper-0-VIDEOID"><video src="blob:…">`).
- The player asks for more while at most one video is left past the one playing, asks again after each
  answer while that is still true, retries once after an answer that adds nothing, then gives up
  (loader up, "next" disabled).
- Videos load through `window.fetch`: a plain GET that preloads the start of the next video and is
  dropped after some KB, then `Range: bytes=N-` for the rest once it plays (usually the 720p rendition).
  New requests to the CDN run at about playback speed and get 403 without the site's cookies.

### Can the server do the filtering? No.

- Instagram's queries are persisted (`doc_id`) and have no like-count argument; sending `first: 30` on
  the reels query still returned the usual 12–14 items.
- TikTok's queries are signed and have no like-count parameter either.
- So filtering has to happen in the browser.

## How the extension works

- `src/common.js` (both sites): settings, the status bar with the Download button, the MP4 saver and
  the stats for the popup. `src/instagram.js` and `src/tiktok.js` register a small adapter with it.
- **Instagram** (`src/instagram.js`) wraps `JSON.parse`. When a parsed payload contains the feed, reels
  or reels-ads keys, it removes the edges whose `like_count` is outside the range. Because it works on
  the parsed object, it does not touch the streaming XHR text or the virtualised list's measurements,
  which is where glitches would come from.
- **TikTok** (`src/tiktok.js`) wraps `Response.prototype.json` (and `JSON.parse` for the inline data)
  and removes the `itemList` entries outside the range. A `window.fetch` wrapper copies the player's
  video bytes as it reads them, for instant downloads.
- Requests the sites send are never changed. The post or video in the address bar (opened from a link)
  is never removed. A payload parsed more than once is counted once.
- **Ready ahead (Instagram Reels, TikTok For You and Following):** in-range videos go to a reserve.
  While fewer than `Keep N ready` are ready past the one playing, one per batch is handed to the
  site's list, which keeps the player at the end of its list and fetching in the background. Once
  enough are ready, the whole reserve is handed over and the site stops fetching by itself, so nothing
  more is loaded than needed.
- **No stalls:** a batch with nothing in range hands over one video from the reserve. With the reserve
  empty, an out-of-range video is handed over as an "anchor" (on TikTok only after its own retry also
  came back empty) and skipped the moment it shows; on TikTok it is covered ("Skipping: below your like
  range") and skipped in the direction you are scrolling, so going back works. A simulation of TikTok's
  fetch rules found no stalls from a 50% to a 0.1% in-range rate; below ~5% roughly a third of the
  steps are such skips.
- **Empty-batch cap:** after `N` batches in a row with nothing in range, one is shown as it is, so the
  search ends instead of loading forever. The pill shows "searching (n empty …)" meanwhile.
- **Instagram home feed:** Instagram already re-requests every ~3 s while its loader is visible, so
  out-of-range posts are simply removed; posts already on screen collapse into a thin bar.
- **Fallbacks:** like counts from the inline first page are also read from its `<script>` tag. Any
  out-of-range post that still reaches the screen is collapsed (Instagram feed) or skipped with the
  site's own "next" button (Instagram Reels, TikTok).
- `src/bridge.js` passes settings from `chrome.storage.sync` to the page: it mirrors them into
  `localStorage` (read synchronously at startup, before the first page is parsed) and posts live changes.

## Things to know

- With a high minimum, most posts from accounts you follow disappear: they usually have few likes.
  On Instagram, untick "Accounts you follow" to keep them.
- Removed posts are never reported back as seen (`feed_view_info`, `seen_reels`, TikTok's view logs),
  so the site may show them again on a later visit.
- With a very high minimum, a lot is fetched to find a few videos; `Keep N ready` and the empty-batch
  cap bound it.
- The sites change their web clients often. If the filter stops working, the key names above are the
  first thing to re-check in DevTools → Network.
- Filtering sends nothing extra to either site. Downloads fetch the video (and, on Instagram, the
  media-info call when a link is missing).

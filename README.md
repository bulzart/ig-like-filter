# IG Like Filter

A Chrome extension (Manifest V3) that shows only the Instagram posts and reels whose like count is inside
a range you set. Posts outside the range are dropped from Instagram's own data before the page renders
them, so they never appear, autoplay or count as "seen".

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (`ig-like-filter`).
4. Pin the extension and click it to set the range. Reload any open Instagram tab once.

Needs Chrome 111 or newer (content scripts in the page's MAIN world).

## Settings (popup)

| Setting | What it does |
|---|---|
| Min / Max likes | The range. Accepts `2500`, `2.5k`, `1.2m`. Empty max = no upper limit. Presets 1K+ to 1M+. |
| All posts / Videos only | Videos only filters videos and reels; photos are always shown. |
| Home feed / Reels tab | Where the filter runs. |
| Accounts you follow / Suggested / Ads | Which kinds of feed posts the range applies to. |
| Hidden like counts | For posts whose owner hid likes: use the count Instagram still sends, always show, or always hide. |
| Empty pages cap | After this many pages in a row with nothing in range, one page is shown anyway (see below). 0 = never. |
| Status pill | Small counter at the bottom of Instagram: range, hidden / checked. Click it to hide it for the page. |

Changes apply right away. Posts already on screen that fall out of range collapse into a thin
"Hidden by IG Like Filter · tap to show" bar. Posts removed earlier come back after a reload.

## What Instagram does (inspected 2026-10-21 through Chrome)

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

**How responses are read**
- The XHR body is read while still streaming (`responseText` at readyState 3), then again when complete.
- Every payload, inline or XHR, goes through `JSON.parse` (`ghlParseRelayResponse` → `parsePayload`)
  before Relay stores it and React renders it.

**Can the server do the filtering? No.**
- The queries are persisted (`doc_id`): the server runs a stored query and the variables have no
  like-count argument.
- Asking for bigger pages does not work either: sending `first: 30` on the reels query still returned
  the usual 12–14 items.
- So filtering has to happen in the browser.

## How the extension works

- `src/main.js` runs in the page at `document_start` and wraps `JSON.parse`. When a parsed payload
  contains the feed, reels or reels-ads keys, it removes the edges whose `like_count` is outside the
  range. Instagram never renders them. The request Instagram sends is never changed.
- Because it works on the parsed object, it does not touch the streaming XHR text, its length, or the
  virtualised list's measurements, which is where glitches would come from.
- The post or reel in the address bar (opened from a link) is never removed.
- Instagram can parse the same payload twice; each page is counted once.
- **Empty-page cap:** when a whole page is out of range, Instagram re-requests about every 3 s. After
  `Empty pages cap` such pages in a row (default 10) one page is let through, so the feed settles
  instead of paginating forever. The pill shows "searching (n empty pages)" meanwhile.
- **Fallbacks:** like counts from the inline first page are also read from its `<script>` tags. Any
  out-of-range post that still reaches the screen is collapsed into a thin bar (feed), and an
  out-of-range reel is skipped with the "next reel" button (reels tab).
- `src/bridge.js` passes settings from `chrome.storage.sync` to the page: it mirrors them into
  `localStorage` (read synchronously at startup, before the first page is parsed) and posts live changes.

## Things to know

- With a high minimum, most posts from accounts you follow disappear: they usually have few likes.
  Untick "Accounts you follow" to keep them.
- Removed posts are never reported back as seen (`feed_view_info`, `seen_reels`), so Instagram may show
  them again on a later visit.
- On Reels with a high minimum, each page of ~12 keeps only a few reels, so "next" can wait a second or
  two while the next page loads. The server will not send bigger pages.
- Instagram changes its web client often. If the filter stops working, the key names above
  (`xdt_api__v1__feed__timeline__connection`, `xdt_api__v1__clips__home__connection_v2`,
  `xdt_injected_reels_units`) are the first thing to re-check in DevTools → Network → `graphql/query`.
- This only changes what your own browser shows; it sends nothing extra to Instagram.

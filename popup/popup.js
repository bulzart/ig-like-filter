// Like Filter popup: edits the settings in chrome.storage.sync (the bridge pushes them to open
// Instagram and TikTok tabs) and shows the active tab's stats.
'use strict';

const DEFAULTS = {
  enabled: true,
  minLikes: 1000,
  maxLikes: null,
  scope: 'all',
  surfaces: { feed: true, reels: true },
  include: { following: true, suggested: true, ads: true },
  hiddenLikes: 'count',
  tiktok: {
    enabled: true,
    minLikes: 10000,
    maxLikes: null,
    scope: 'all',
    surfaces: { forYou: true, following: true, explore: true },
    quality: 'instant',
  },
  aheadTarget: 5,
  emptyPageCap: 10,
  showPill: true,
  showDownload: true,
};

const $ = (id) => document.getElementById(id);

// "2500", "2.5k", "1,2m", "1.2M" -> number; "" -> null; junk -> NaN
function parseCount(text) {
  const t = String(text).trim().toLowerCase().replace(/\s/g, '').replace(',', '.');
  if (!t) return null;
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(t);
  if (!m) return NaN;
  return Math.round(parseFloat(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1));
}
const showCount = (n) => (n === null || n === undefined ? '' : n >= 1e6 && n % 1e5 === 0 ? n / 1e6 + 'm' : n >= 1e3 && n % 100 === 0 ? n / 1e3 + 'k' : String(n));
const intIn = (value, min, max, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
};

function merge(stored) {
  const s = stored || {};
  const t = s.tiktok || {};
  return {
    ...DEFAULTS, ...s,
    surfaces: { ...DEFAULTS.surfaces, ...(s.surfaces || {}) },
    include: { ...DEFAULTS.include, ...(s.include || {}) },
    tiktok: { ...DEFAULTS.tiktok, ...t, surfaces: { ...DEFAULTS.tiktok.surfaces, ...(t.surfaces || {}) } },
  };
}

let settings = DEFAULTS;

function setRadio(name, value) {
  for (const r of document.querySelectorAll(`input[name="${name}"]`)) r.checked = r.value === value;
}
const radio = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value || 'all';

function render() {
  const s = settings;
  const t = s.tiktok;
  $('enabled').checked = s.enabled;
  $('ig-min').value = showCount(s.minLikes);
  $('ig-max').value = showCount(s.maxLikes);
  setRadio('ig-scope', s.scope);
  $('ig-feed').checked = s.surfaces.feed;
  $('ig-reels').checked = s.surfaces.reels;
  $('ig-following').checked = s.include.following;
  $('ig-suggested').checked = s.include.suggested;
  $('ig-ads').checked = s.include.ads;
  $('ig-hiddenLikes').value = s.hiddenLikes;
  $('tt-enabled').checked = t.enabled;
  $('tt-min').value = showCount(t.minLikes);
  $('tt-max').value = showCount(t.maxLikes);
  setRadio('tt-scope', t.scope);
  $('tt-forYou').checked = t.surfaces.forYou;
  $('tt-following').checked = t.surfaces.following;
  $('tt-explore').checked = t.surfaces.explore;
  $('tt-quality').value = t.quality;
  $('aheadTarget').value = s.aheadTarget;
  $('emptyPageCap').value = s.emptyPageCap;
  $('showPill').checked = s.showPill;
  $('showDownload').checked = s.showDownload;
}

// Reads one min/max pair; marks bad fields and returns null when either is invalid.
function readRange(prefix) {
  const min = parseCount($(`${prefix}-min`).value);
  const max = parseCount($(`${prefix}-max`).value);
  const badMin = Number.isNaN(min);
  const badMax = Number.isNaN(max) || (max !== null && min !== null && !badMin && max < min);
  $(`${prefix}-min`).classList.toggle('bad', badMin);
  $(`${prefix}-max`).classList.toggle('bad', badMax);
  return badMin || badMax ? null : { min: min ?? 0, max };
}

function read() {
  const ig = readRange('ig');
  const tt = readRange('tt');
  if (!ig || !tt) return null;
  return {
    enabled: $('enabled').checked,
    minLikes: ig.min,
    maxLikes: ig.max,
    scope: radio('ig-scope'),
    surfaces: { feed: $('ig-feed').checked, reels: $('ig-reels').checked },
    include: {
      following: $('ig-following').checked,
      suggested: $('ig-suggested').checked,
      ads: $('ig-ads').checked,
    },
    hiddenLikes: $('ig-hiddenLikes').value,
    tiktok: {
      enabled: $('tt-enabled').checked,
      minLikes: tt.min,
      maxLikes: tt.max,
      scope: radio('tt-scope'),
      surfaces: {
        forYou: $('tt-forYou').checked,
        following: $('tt-following').checked,
        explore: $('tt-explore').checked,
      },
      quality: $('tt-quality').value,
    },
    aheadTarget: intIn($('aheadTarget').value, 1, 20, DEFAULTS.aheadTarget),
    emptyPageCap: intIn($('emptyPageCap').value, 0, 100, DEFAULTS.emptyPageCap),
    showPill: $('showPill').checked,
    showDownload: $('showDownload').checked,
  };
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const next = read();
    if (!next) return;
    settings = next;
    chrome.storage.sync.set({ settings });
  }, 250);
}

function showSite(site) {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.site === site));
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.dataset.panel !== site;
}

let siteChosen = false;
async function refreshStats() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const s = await chrome.tabs.sendMessage(tab.id, { type: 'iglf:getStats' });
    if (!s) { $('stats').textContent = 'Scroll the feed to see stats.'; return; }
    // Open on the tab's own site the first time.
    if (!siteChosen && s.site) { showSite(s.site === 'tiktok' ? 'tt' : 'ig'); siteChosen = true; }
    const where = s.site === 'tiktok' ? 'TikTok' : 'Instagram';
    let text = `${where} tab: checked ${s.checked} · hidden ${s.hidden}`;
    if (s.ready !== null && s.ready !== undefined) text += ` · ${s.ready} ready ahead`;
    if (s.passedByCap) text += ` · shown after empty batches ${s.passedByCap}`;
    if (s.searching) text += ` · searching (${s.searching} empty)`;
    $('stats').textContent = text;
    $('download').disabled = !s.current;
    $('dlStatus').textContent = s.download
      || (s.current ? `On screen: ${s.current}. Shortcut: Alt+Shift+D.` : 'No video on screen. Shortcut: Alt+Shift+D.');
  } catch (_) {
    $('stats').textContent = 'Open Instagram or TikTok in this tab to see stats.';
    $('download').disabled = true;
  }
}

$('download').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'iglf:download' });
    $('dlStatus').textContent = 'Starting download…';
  } catch (_) {
    $('dlStatus').textContent = 'Open Instagram or TikTok in this tab first.';
  }
});

document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-site]');
  if (!b) return;
  siteChosen = true;
  showSite(b.dataset.site);
});

for (const group of document.querySelectorAll('.presets')) {
  group.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $(`${group.dataset.for}-min`).value = showCount(Number(b.dataset.min));
    $(`${group.dataset.for}-max`).value = '';
    save();
  });
}
for (const area of document.querySelectorAll('.panel, body > section')) {
  area.addEventListener('input', save);
  area.addEventListener('change', save);
}
$('enabled').addEventListener('change', save);

chrome.storage.sync.get('settings').then(({ settings: stored }) => {
  settings = merge(stored);
  render();
});
refreshStats();
setInterval(refreshStats, 1500);

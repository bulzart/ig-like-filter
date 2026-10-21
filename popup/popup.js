// IG Like Filter popup: edits the settings in chrome.storage.sync (the bridge pushes them
// to open Instagram tabs) and shows the active tab's stats.
'use strict';

const DEFAULTS = {
  enabled: true,
  minLikes: 1000,
  maxLikes: null,
  scope: 'all',
  surfaces: { feed: true, reels: true },
  include: { following: true, suggested: true, ads: true },
  hiddenLikes: 'count',
  emptyPageCap: 10,
  showPill: true,
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

let settings = DEFAULTS;

function render() {
  $('enabled').checked = settings.enabled;
  $('minLikes').value = showCount(settings.minLikes);
  $('maxLikes').value = showCount(settings.maxLikes);
  for (const r of document.querySelectorAll('input[name="scope"]')) r.checked = r.value === settings.scope;
  $('surf-feed').checked = settings.surfaces.feed;
  $('surf-reels').checked = settings.surfaces.reels;
  $('inc-following').checked = settings.include.following;
  $('inc-suggested').checked = settings.include.suggested;
  $('inc-ads').checked = settings.include.ads;
  $('hiddenLikes').value = settings.hiddenLikes;
  $('emptyPageCap').value = settings.emptyPageCap;
  $('showPill').checked = settings.showPill;
}

function read() {
  const min = parseCount($('minLikes').value);
  const max = parseCount($('maxLikes').value);
  const badMin = Number.isNaN(min);
  const badMax = Number.isNaN(max) || (max !== null && min !== null && !badMin && max < min);
  $('minLikes').classList.toggle('bad', badMin);
  $('maxLikes').classList.toggle('bad', badMax);
  if (badMin || badMax) return null;
  const cap = parseInt($('emptyPageCap').value, 10);
  return {
    enabled: $('enabled').checked,
    minLikes: min ?? 0,
    maxLikes: max,
    scope: document.querySelector('input[name="scope"]:checked')?.value || 'all',
    surfaces: { feed: $('surf-feed').checked, reels: $('surf-reels').checked },
    include: {
      following: $('inc-following').checked,
      suggested: $('inc-suggested').checked,
      ads: $('inc-ads').checked,
    },
    hiddenLikes: $('hiddenLikes').value,
    emptyPageCap: Number.isFinite(cap) && cap >= 0 ? Math.min(cap, 100) : DEFAULTS.emptyPageCap,
    showPill: $('showPill').checked,
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

async function refreshStats() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const s = await chrome.tabs.sendMessage(tab.id, { type: 'iglf:getStats' });
    if (!s) { $('stats').textContent = 'Scroll Instagram to see stats.'; return; }
    let text = `This tab: checked ${s.checked} · hidden ${s.hidden}`;
    if (s.passedByCap) text += ` · shown after empty pages ${s.passedByCap}`;
    if (s.searching) text += ` · searching (${s.searching} empty pages)`;
    $('stats').textContent = text;
  } catch (_) {
    $('stats').textContent = 'Open Instagram in this tab to see stats.';
  }
}

document.getElementById('presets').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $('minLikes').value = showCount(Number(b.dataset.min));
  $('maxLikes').value = '';
  save();
});
document.body.addEventListener('input', save);
document.body.addEventListener('change', save);

chrome.storage.sync.get('settings').then(({ settings: stored }) => {
  const s = stored || {};
  settings = {
    ...DEFAULTS, ...s,
    surfaces: { ...DEFAULTS.surfaces, ...(s.surfaces || {}) },
    include: { ...DEFAULTS.include, ...(s.include || {}) },
  };
  render();
});
refreshStats();
setInterval(refreshStats, 1500);

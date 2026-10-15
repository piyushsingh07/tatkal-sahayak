/*
 * Service worker: server-time sync, badge updates, options page plumbing.
 * Deliberately does NOT talk to IRCTC at all — the only network call it makes
 * is to a public time API so the Book Now click can be aligned to the true
 * IST second boundary.
 */
importScripts('shared/time.js', 'shared/storage.js');

const TIME_URL = 'https://timeapi.io/api/time/current/zone?timeZone=Asia/Kolkata';

function grantSessionStorageToContentScripts() {
  // Content scripts may only read chrome.storage.session after this call.
  if (chrome.storage.session && chrome.storage.session.setAccessLevel) {
    chrome.storage.session
      .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
      .catch(() => {});
  }
}
grantSessionStorageToContentScripts();

chrome.runtime.onInstalled.addListener((details) => {
  grantSessionStorageToContentScripts();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(grantSessionStorageToContentScripts);

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

async function sampleOnce() {
  const t0 = Date.now();
  const res = await fetch(TIME_URL, { cache: 'no-store' });
  const t1 = Date.now();
  if (!res.ok) throw new Error(`time api HTTP ${res.status}`);
  const json = await res.json();
  const serverMs = TA.time.parseTimeApiResponse(json);
  if (!Number.isFinite(serverMs)) throw new Error('time api: unparsable payload');
  return { t0, t1, serverMs };
}

/**
 * Take a few round trips and keep the lowest-RTT one. Result is stored in run
 * state so every IRCTC tab (and the panel countdown) uses the same offset.
 */
async function syncTime(samplesWanted = 3) {
  const samples = [];
  let lastErr = null;
  for (let i = 0; i < samplesWanted; i++) {
    try {
      samples.push(await sampleOnce());
    } catch (e) {
      lastErr = e;
    }
  }
  const best = TA.time.bestOffset(samples);
  const result = best
    ? { ok: true, offsetMs: Math.round(best.offsetMs), rttMs: Math.round(best.rttMs), source: 'timeapi.io', at: Date.now() }
    : { ok: false, offsetMs: 0, rttMs: null, source: 'local-clock', at: Date.now(), error: lastErr ? String(lastErr.message || lastErr) : 'no samples' };
  await TA.storage.patchRun({ timeSync: result });
  return result;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'SYNC_TIME':
      syncTime(msg.samples || 3).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
      return true; // async response
    case 'SET_BADGE':
      chrome.action.setBadgeText({ text: msg.text || '' });
      if (msg.color) chrome.action.setBadgeBackgroundColor({ color: msg.color });
      sendResponse({ ok: true });
      return false;
    case 'OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;
    default:
      return false;
  }
});

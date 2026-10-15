/*
 * Pure time helpers shared by the content script, the service worker, the
 * options page and the node unit tests (UMD-style: attaches to globalThis.TA
 * and also exports via module.exports when running under node).
 *
 * All Tatkal windows are defined in IST (UTC+05:30, no DST), so every
 * calculation here is done in IST regardless of the machine's timezone.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TA = root.TA || {};
  root.TA.time = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const IST_OFFSET_MS = 330 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** Parse "HH:MM" or "HH:MM:SS" -> {h, m, s} or null if malformed. */
  function parseHms(str) {
    if (typeof str !== 'string') return null;
    const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(str);
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]), s = Number(m[3] || 0);
    if (h > 23 || mi > 59 || s > 59) return null;
    return { h, m: mi, s };
  }

  /** "YYYY-MM-DD" of the given epoch in IST. */
  function istDateString(epochMs) {
    return new Date(epochMs + IST_OFFSET_MS).toISOString().slice(0, 10);
  }

  /** "HH:MM:SS.mmm" wall clock in IST for display. */
  function istClock(epochMs, withMs = true) {
    const iso = new Date(epochMs + IST_OFFSET_MS).toISOString();
    return withMs ? iso.slice(11, 23) : iso.slice(11, 19);
  }

  /**
   * Epoch ms of the next occurrence of an IST wall-clock time.
   * If today's occurrence is already in the past but within `graceMs`
   * (default 20 min) it is still returned (caller should act immediately);
   * beyond the grace period we roll over to tomorrow.
   */
  function nextTargetEpoch(hms, nowMs, graceMs = 20 * 60 * 1000) {
    const t = typeof hms === 'string' ? parseHms(hms) : hms;
    if (!t) return null;
    const [y, mo, d] = istDateString(nowMs).split('-').map(Number);
    let target = Date.UTC(y, mo - 1, d, t.h, t.m, t.s) - IST_OFFSET_MS;
    if (target < nowMs - graceMs) target += DAY_MS;
    return target;
  }

  /** Format a millisecond delta as "-mm:ss.t" / "+mm:ss.t". */
  function formatCountdown(deltaMs) {
    const sign = deltaMs < 0 ? '+' : '-'; // negative delta = target already passed
    const abs = Math.abs(deltaMs);
    const totalSec = Math.floor(abs / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const tenth = Math.floor((abs % 1000) / 100);
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return (h ? `${sign}${h}:${mm}:${ss}` : `${sign}${mm}:${ss}`) + `.${tenth}`;
  }

  /**
   * Clock offset from one round trip: server time is assumed to have been
   * observed at the midpoint of the request. offset = server - local.
   */
  function offsetFromSample(sample) {
    const { t0, t1, serverMs } = sample;
    const rtt = t1 - t0;
    return { offsetMs: serverMs - (t0 + rtt / 2), rttMs: rtt };
  }

  /** Pick the lowest-RTT sample (least uncertainty) out of several. */
  function bestOffset(samples) {
    const valid = samples.filter((s) => Number.isFinite(s.serverMs) && s.t1 >= s.t0);
    if (!valid.length) return null;
    return valid.map(offsetFromSample).sort((a, b) => a.rttMs - b.rttMs)[0];
  }

  /**
   * timeapi.io returns the zone-local wall clock without a UTC offset, e.g.
   * "2026-09-29T03:07:45.5652342". We requested Asia/Kolkata so we append
   * +05:30 (and truncate to ms) to get an absolute instant.
   */
  function parseTimeApiResponse(json) {
    if (!json || typeof json.dateTime !== 'string') return NaN;
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?/.exec(json.dateTime);
    if (!m) return NaN;
    const ms = (m[2] || '').padEnd(3, '0').slice(0, 3);
    return Date.parse(`${m[1]}.${ms}+05:30`);
  }

  /** HTTP Date header (RFC 7231) -> epoch ms, second precision. */
  function parseHttpDate(str) {
    const t = Date.parse(str || '');
    return Number.isFinite(t) ? t : NaN;
  }

  return {
    IST_OFFSET_MS,
    parseHms,
    istDateString,
    istClock,
    nextTargetEpoch,
    formatCountdown,
    offsetFromSample,
    bestOffset,
    parseTimeApiResponse,
    parseHttpDate,
  };
});

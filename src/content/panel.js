/*
 * Floating control panel injected into IRCTC pages (Shadow DOM so IRCTC's CSS
 * and ours never collide). Shows what the engine sees, lets you arm/disarm,
 * run the Field Check and capture selectors with the Pick tool.
 */
(function (root) {
  'use strict';

  const TA = (root.TA = root.TA || {});
  const D = TA.dom;
  const S = TA.storage;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 12px; }
    .panel { position: fixed; right: 12px; bottom: 12px; width: 340px; max-height: 80vh; overflow: auto; z-index: 2147483000;
      background: #0f172a; color: #e2e8f0; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.45); border: 1px solid #334155; }
    .panel.collapsed .body { display: none; }
    .hdr { display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: #1e293b; border-radius: 10px 10px 0 0; cursor: pointer; }
    .hdr b { font-size: 13px; flex: 1; }
    .badge { padding: 1px 6px; border-radius: 10px; font-size: 10px; font-weight: 600; text-transform: uppercase; background: #334155; }
    .badge.on { background: #16a34a; color: #fff; } .badge.dry { background: #f59e0b; color: #000; } .badge.page { background: #0ea5e9; color: #fff; }
    .body { padding: 10px; display: grid; gap: 8px; }
    .status { padding: 8px; border-radius: 6px; background: #1e293b; line-height: 1.4; min-height: 34px; word-break: break-word; }
    .status.human { background: #7c2d12; color: #fff; }
    .clock { display: flex; justify-content: space-between; font-variant-numeric: tabular-nums; color: #94a3b8; }
    .clock b { color: #fff; }
    .row { display: flex; gap: 6px; flex-wrap: wrap; }
    button { border: 0; border-radius: 6px; padding: 6px 9px; cursor: pointer; background: #334155; color: #e2e8f0; font-weight: 600; }
    button:hover { filter: brightness(1.15); }
    button.primary { background: #16a34a; color: #fff; } button.warn { background: #f59e0b; color: #000; } button.danger { background: #dc2626; color: #fff; }
    button.sm { padding: 3px 6px; font-size: 11px; font-weight: 500; }
    input { border: 1px solid #475569; background: #0b1220; color: #fff; border-radius: 6px; padding: 5px 7px; flex: 1; min-width: 0; }
    .log { list-style: none; margin: 0; padding: 0; max-height: 150px; overflow: auto; border-top: 1px solid #334155; padding-top: 6px; }
    .log li { padding: 2px 0; color: #cbd5e1; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    .log li.warn { color: #fbbf24; } .log li.error { color: #f87171; } .log li.human { color: #fb923c; }
    .log time { color: #64748b; margin-right: 4px; }
    .fields { display: grid; gap: 3px; }
    .field { display: grid; grid-template-columns: 16px 1fr auto; gap: 6px; align-items: center; padding: 3px 4px; border-radius: 4px; background: #1e293b; }
    .field .ok { color: #4ade80; } .field .miss { color: #f87171; } .field .opt { color: #94a3b8; }
    .field small { display: block; color: #94a3b8; font-size: 10px; word-break: break-all; }
    .note { color: #94a3b8; font-size: 11px; line-height: 1.35; }
    .alert { background: #7f1d1d; color: #fff; padding: 6px 8px; border-radius: 6px; }
    .pickbar { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483001; background: #f59e0b; color: #000; padding: 8px 12px; font-weight: 700; text-align: center; }
  `;

  class Panel {
    constructor(engine) {
      this.engine = engine;
      this.view = 'main'; // main | fields
      this.picking = null; // field key while picking
      this.collapsed = false;
      this.mount();
      engine.onChange(() => this.render());
      setInterval(() => this.renderClock(), 100);
      document.addEventListener('visibilitychange', () => this.render());
    }

    mount() {
      this.host = document.createElement('div');
      this.host.id = 'tatkal-sahayak-root';
      this.shadow = this.host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      this.shadow.appendChild(style);
      this.el = document.createElement('div');
      this.el.className = 'panel';
      this.shadow.appendChild(this.el);
      document.documentElement.appendChild(this.host);
      this.render();
    }

    h(tag, attrs = {}, children = []) {
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'onclick') el.addEventListener('click', v);
        else if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else el.setAttribute(k, v);
      }
      for (const c of [].concat(children)) if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      return el;
    }

    // ---- rendering -------------------------------------------------------
    render() {
      const e = this.engine;
      const h = this.h.bind(this);
      this.el.className = `panel${this.collapsed ? ' collapsed' : ''}`;
      this.el.replaceChildren();

      const armBadge = e.armed ? h('span', { class: `badge ${e.mode === 'dryrun' ? 'dry' : 'on'}`, text: e.mode === 'dryrun' ? 'dry run' : 'armed' }) : h('span', { class: 'badge', text: 'idle' });
      this.el.appendChild(h('div', { class: 'hdr', onclick: () => { this.collapsed = !this.collapsed; this.render(); } }, [
        h('b', { text: 'Tatkal Sahayak' }),
        h('span', { class: 'badge', text: e.site }),
        h('span', { class: 'badge page', text: e.page.toLowerCase() }),
        armBadge,
      ]));

      const body = h('div', { class: 'body' });
      this.el.appendChild(body);

      const humanWait = /^YOU:/.test(e.statusText);
      body.appendChild(h('div', { class: `status${humanWait ? ' human' : ''}`, text: e.statusText || (e.armed ? 'Watching page…' : 'Not armed. Configure in Options, then Arm.') }));
      this.clockEl = h('div', { class: 'clock' });
      body.appendChild(this.clockEl);
      this.renderClock();

      if (document.hidden) body.appendChild(h('div', { class: 'alert', text: 'Tab is in the background — Chrome throttles timers. Keep this tab visible during the window.' }));

      const { errors, warnings } = S.validateSettings(e.settings);
      if (errors.length) body.appendChild(h('div', { class: 'alert', text: `Settings incomplete: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}` }));

      const needsUnlock = e.settings.credentials.passwordEnc && !e.run.password;
      if (needsUnlock) {
        const input = h('input', { type: 'password', placeholder: 'Passphrase to unlock password' });
        const unlock = async () => {
          try {
            const pw = await TA.crypto.decryptString(input.value, e.settings.credentials.passwordEnc);
            await S.patchRun({ password: pw });
            e.run.password = pw;
            e.addLog('Password unlocked for this browser session');
          } catch (_) {
            e.addLog('Wrong passphrase', 'error');
          }
        };
        input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') unlock(); });
        body.appendChild(h('div', { class: 'row' }, [input, h('button', { text: 'Unlock', onclick: unlock })]));
      }

      const row = h('div', { class: 'row' });
      if (!e.armed) {
        row.appendChild(h('button', { class: 'primary', text: 'Arm (live)', onclick: () => this.arm('live', errors) }));
        row.appendChild(h('button', { class: 'warn', text: 'Dry run', onclick: () => this.arm('dryrun', errors) }));
      } else {
        row.appendChild(h('button', { class: 'danger', text: 'Disarm', onclick: () => e.setArmed(false) }));
      }
      row.appendChild(h('button', { text: this.view === 'fields' ? 'Hide fields' : 'Field check', onclick: () => { this.view = this.view === 'fields' ? 'main' : 'fields'; this.render(); } }));
      row.appendChild(h('button', { text: 'Copy debug', title: 'Copy a diagnostic report (no credentials) to paste into a bug report', onclick: () => this.copyDebug() }));
      row.appendChild(h('button', { text: 'Sync clock', onclick: () => e.syncTime() }));
      row.appendChild(h('button', { text: 'Options', onclick: () => chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }) }));
      body.appendChild(row);

      if (this.view === 'fields') body.appendChild(this.renderFields());
      if (this.debugText) {
        const ta = h('textarea', { rows: '8', readonly: 'readonly', style: 'width:100%; font-size:10px; font-family:ui-monospace, monospace; background:#0b1220; color:#e2e8f0; border:1px solid #475569; border-radius:6px;' });
        ta.value = this.debugText;
        ta.addEventListener('click', () => ta.select());
        body.appendChild(h('div', { class: 'note', text: this.debugCopied ? 'Copied to clipboard — paste it into the chat. (Also shown below.)' : 'Clipboard blocked — click the box, Cmd/Ctrl+A, Cmd/Ctrl+C.' }));
        body.appendChild(ta);
        body.appendChild(h('button', { class: 'sm', text: 'Hide report', onclick: () => { this.debugText = null; this.render(); } }));
      }

      const log = h('ul', { class: 'log' });
      for (const entry of e.log.slice(-10).reverse()) {
        log.appendChild(h('li', { class: entry.level || 'info' }, [h('time', { text: TA.time.istClock(entry.t, false) }), entry.message]));
      }
      body.appendChild(log);
    }

    renderClock() {
      if (!this.clockEl) return;
      const e = this.engine;
      const now = e.serverNow();
      const sync = e.run.timeSync;
      const parts = [`IST ${TA.time.istClock(now)}`];
      if (sync) parts.push(sync.ok ? `offset ${sync.offsetMs}ms` : 'local clock');
      let countdown = '';
      const tt = e.settings.automation.targetTime;
      if (tt) {
        const target = TA.time.nextTargetEpoch(tt, now);
        if (target) countdown = `${tt} in ${TA.time.formatCountdown(target - now)}`;
      }
      this.clockEl.replaceChildren(this.h('span', { text: parts.join(' · ') }), this.h('b', { text: countdown }));
    }

    renderFields() {
      const e = this.engine;
      const h = this.h.bind(this);
      const wrap = h('div', { class: 'fields' });
      const page = e.page === 'UNKNOWN' ? 'SEARCH' : e.page;
      wrap.appendChild(h('div', { class: 'note', text: `Fields for ${page}. Red = not found. Pick → click the element on the page to teach the extension. Row fields: pick the one in the first passenger row.` }));
      for (const f of e.fieldReport(page)) {
        const mark = f.count ? h('span', { class: 'ok', text: '✓' }) : h('span', { class: f.optional ? 'opt' : 'miss', text: f.optional ? '○' : '✗' });
        const label = h('div', {}, [f.label + (f.multi ? ` (${f.count})` : ''), f.override ? h('small', { text: `override: ${f.override}` }) : null]);
        const btns = h('div', { class: 'row' }, [
          f.el ? h('button', { class: 'sm', text: 'Show', onclick: () => { D.flash(f.el); f.el.scrollIntoView({ block: 'center' }); } }) : null,
          h('button', { class: 'sm', text: 'Pick', onclick: () => this.startPick(f.key) }),
          f.override ? h('button', { class: 'sm', text: '×', title: 'remove override', onclick: () => e.saveOverride(f.key, '').then(() => this.render()) }) : null,
        ]);
        wrap.appendChild(h('div', { class: 'field' }, [mark, label, btns]));
      }
      return wrap;
    }

    // ---- actions ---------------------------------------------------------
    async copyDebug() {
      let text;
      try {
        text = this.engine.debugReport();
      } catch (e) {
        text = `debugReport failed: ${e && e.message}`;
      }
      this.debugText = text;
      this.debugCopied = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          this.debugCopied = true;
        }
      } catch (_) { /* clipboard permission denied: textarea fallback */ }
      console.log('[Tatkal Sahayak] debug report\n' + text);
      this.render();
    }

    async arm(mode, errors) {
      const e = this.engine;
      if (errors.length) {
        alert(`Fix settings first:\n- ${errors.join('\n- ')}`);
        return;
      }
      if (!e.settings.acknowledgedRisk) {
        const ok = confirm(
          'IRCTC\'s terms prohibit automation/scripting tools and allow deactivating the user ID and cancelling tickets without refund. ' +
          'This extension only fills forms for your personal booking; CAPTCHA, OTP and payment stay manual. Use it at your own risk.\n\nContinue?'
        );
        if (!ok) return;
        const stored = await S.getSettings();
        stored.acknowledgedRisk = true;
        await S.saveSettings(stored);
      }
      if (e.settings.credentials.passwordEnc && !e.run.password) {
        alert('Unlock the password first (passphrase field in the panel).');
        return;
      }
      await e.setArmed(true, mode);
    }

    startPick(key) {
      if (this.picking) this.stopPick();
      this.picking = key;
      const bar = this.h('div', { class: 'pickbar', text: `Click the element for "${TA.profiles.FIELDS[key].label}" — Esc to cancel` });
      this.pickBar = bar;
      this.shadow.appendChild(bar);
      // mousedown selects the element; the follow-up mouseup/click are swallowed
      // so the site never reacts to the pick.
      this.onPickBlock = (ev) => {
        if (ev.composedPath().includes(this.host)) return;
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
      };
      this.onPickClick = (ev) => {
        if (ev.composedPath().includes(this.host)) return; // ignore clicks on our own panel
        this.onPickBlock(ev);
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target || this.pickSaving) return;
        this.pickSaving = true;
        const css = D.cssPath(target);
        D.flash(target, '#22c55e');
        this.engine.saveOverride(key, css).then(() => { this.pickSaving = false; this.stopPick(); this.render(); });
      };
      this.onPickKey = (ev) => { if (ev.key === 'Escape') { this.stopPick(); this.render(); } };
      this.onPickHover = (ev) => {
        if (ev.composedPath().includes(this.host)) return;
        if (this.hovered && this.hovered !== ev.target) this.hovered.style.outline = this.hoveredOutline || '';
        this.hovered = ev.target;
        this.hoveredOutline = ev.target.style.outline;
        ev.target.style.outline = '2px dashed #f59e0b';
      };
      document.addEventListener('mousedown', this.onPickClick, true);
      document.addEventListener('mouseup', this.onPickBlock, true);
      document.addEventListener('click', this.onPickBlock, true);
      document.addEventListener('keydown', this.onPickKey, true);
      document.addEventListener('mouseover', this.onPickHover, true);
    }

    stopPick() {
      document.removeEventListener('mousedown', this.onPickClick, true);
      document.removeEventListener('mouseup', this.onPickBlock, true);
      document.removeEventListener('click', this.onPickBlock, true);
      document.removeEventListener('keydown', this.onPickKey, true);
      document.removeEventListener('mouseover', this.onPickHover, true);
      if (this.hovered) this.hovered.style.outline = this.hoveredOutline || '';
      this.hovered = null;
      if (this.pickBar) this.pickBar.remove();
      this.pickBar = null;
      this.picking = null;
    }
  }

  TA.Panel = Panel;
})(typeof globalThis !== 'undefined' ? globalThis : this);

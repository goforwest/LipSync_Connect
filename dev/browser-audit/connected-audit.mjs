// Connected-state UI audit, driven in a real browser against a full firmware
// fake (fake-firmware.mjs). The node suite verifies behavior through DOM
// stubs; this exercises what those stubs cannot — real layout (mobile
// blowouts, overlaps), real focus order, the accessibility tree, animation
// timing (self-test narration, calibration sequence), and the whole
// connected chrome at several viewport widths.
//
// Run via `npm run test:browser-audit` from dev/ (boots the dev server,
// injects the fake, executes both phases, exits non-zero on any failed
// check). Not part of `npm test`: it needs a Playwright Chromium, exactly
// like the offline e2e.
//
// Phase 1 — core: connect, card values, steppers, thresholds, switch
// mappings, joystick read, feedback, health check, self-test narration +
// completion, live joystick view, hub remote navigation, EX dump, mode
// dialog, disconnect gating.
// Phase 2 — deep flows: offline firmware check, neutral reset, full
// calibration sequence, timing-window ordering refusal, restrictions,
// switch remap, live pressure view, refresh-all, factory-reset danger
// focus, confirmed mode change, share-log fallback.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

export async function runConnectedAudit({ origin, chromium, executablePath }) {
  const findings = [];
  const note = (area, ok, detail) => {
    // Printed as it happens: a crash mid-audit still shows every check up to it.
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${area}  ${detail}`);
    findings.push({ area, ok: !!ok, detail });
  };
  const fakePath = path.join(dir, 'fake-firmware.mjs');

  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    // The automatic update check must not depend on GitHub's reachability.
    await page.route('**api.github.com**', (r) => r.abort());
    await page.addInitScript({ path: fakePath });
    await page.goto(origin + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    const connect = async () => {
      await page.click('#btnConnect');
      await page.waitForFunction(() => document.getElementById('status').textContent === 'Connected', null, {
        timeout: 20000,
      });
      await page.waitForTimeout(400);
    };
    const openCard = async (sec) => {
      await page.click(`.circle-trigger[data-section="${sec}"]`);
      await page.waitForTimeout(800);
    };
    const evalCard = (fn, ...args) => page.evaluate(fn, ...args);

    // ---------------- Phase 1: core connected chrome ----------------
    await connect();
    const chrome1 = await evalCard(() => ({
      status: document.getElementById('status').textContent,
      title: document.title,
      dimmed: document.querySelectorAll('.circle-trigger.dimmed').length,
      cardOff: document.querySelectorAll('.section-card.card-off').length,
    }));
    note(
      'connect-chrome',
      chrome1.status === 'Connected' && chrome1.title.includes('Connected') && chrome1.dimmed === 0 && chrome1.cardOff === 0,
      JSON.stringify(chrome1),
    );

    await openCard('sec-device');
    const dev = await evalCard(() => ({
      model: document.getElementById('model').textContent,
      version: document.getElementById('version').textContent,
      opmode: document.getElementById('opmode').textContent,
      commode: document.getElementById('commode').textContent,
      modeSel: document.getElementById('operatingMode').value,
    }));
    note(
      'device-values',
      dev.model.includes('LipSync 4') && dev.version === '4.5.2' && dev.opmode === 'Mouse' && dev.commode === 'USB' && dev.modeSel === 'mouse',
      JSON.stringify(dev),
    );

    await openCard('sec-cursor');
    const cur = await evalCard(() => ({
      speed: document.getElementById('speedVal').textContent,
      segs: document.querySelectorAll('#speedMeter span.on').length,
      scroll: document.getElementById('scrollVal').textContent,
      accel: document.getElementById('accelVal').textContent,
      accelSegs: document.querySelectorAll('#accelMeter span').length,
      accelLit: document.querySelectorAll('#accelMeter span.on').length,
      accelLitSide: [...document.querySelectorAll('#accelMeter span.on')].every((s, i, arr) =>
        [...document.querySelectorAll('#accelMeter span')].indexOf(s) >= 10,
      ),
    }));
    note(
      'cursor-values',
      cur.speed === '7' &&
        cur.segs === 7 &&
        cur.scroll === '5' &&
        cur.accel === '3' &&
        cur.accelSegs === 20 &&
        cur.accelLit === 3 &&
        cur.accelLitSide,
      JSON.stringify(cur),
    );

    await page.click('[data-target="speed"][data-step="1"]');
    await page.waitForTimeout(400);
    note('stepper-plus', (await evalCard(() => document.getElementById('speedVal').textContent)) === '8', 'speed after +');

    // Inline write confirmation + undo: the stepper write chips with the
    // previous value, Undo rewrites it. The re-plus afterwards restores
    // speed 8 for the stepper-max math below.
    const chip1 = await evalCard(() => ({
      visible: !document.getElementById('writeConfirm').hidden,
      text: document.getElementById('writeConfirmText').textContent,
      undoVisible: !document.getElementById('btnWriteUndo').hidden,
    }));
    note(
      'write-confirm-chip',
      chip1.visible && chip1.text === '\u2713 Cursor speed level 7 \u2192 8' && chip1.undoVisible,
      JSON.stringify(chip1),
    );
    await page.click('#btnWriteUndo');
    await page.waitForTimeout(500);
    note('write-confirm-undo', (await evalCard(() => document.getElementById('speedVal').textContent)) === '7', 'speed restored to 7');
    await page.click('[data-target="speed"][data-step="1"]');
    await page.waitForTimeout(400);

    await openCard('sec-sip');
    const sip = await evalCard(() => ({
      sipVal: document.getElementById('sipVal').textContent,
      puffVal: document.getElementById('puffVal').textContent,
      sipInput: document.getElementById('sipInput').value,
      markLeft: document.getElementById('gaugeSipMark').style.left,
      scaleLabel: document.getElementById('gaugeSipLabel').textContent,
    }));
    await page.click('[data-target="st"][data-step="1"]');
    await page.waitForTimeout(500);
    note(
      'threshold-stepper',
      (await evalCard(() => document.getElementById('sipVal').textContent)) === '12.75',
      'sip 12.50 + 0.25 via the stepper',
    );
    await page.click('#btnWriteUndo');
    await page.waitForTimeout(500);

    note(
      'sip-values',
      sip.sipVal === '12.50' && sip.puffVal === '25.00' && sip.sipInput === '12.50' && sip.markLeft !== '' && sip.scaleLabel.includes('hPa'),
      JSON.stringify(sip),
    );

    await page.click('text=Set exact threshold values');
    await page.fill('#sipInput', '20');
    await page.click('#btnSetSip');
    await page.waitForTimeout(600);
    const afterSet = await evalCard(() => ({
      sipVal: document.getElementById('sipVal').textContent,
      input: document.getElementById('sipInput').value,
    }));
    note('sip-set', afterSet.sipVal === '20.00' && afterSet.input === '20.00', JSON.stringify(afterSet));

    await openCard('sec-cursor');
    // stepper-plus left speed at 8; two natural clicks reach the 10 max — a
    // third would wait on the max-disabled button by design.
    for (let i = 0; i < 2; i++) {
      await page.click('[data-target="speed"][data-step="1"]');
      await page.waitForTimeout(300);
    }
    const atMax = await evalCard(() => ({
      speed: document.getElementById('speedVal').textContent,
      plus: document.querySelector('[data-target="speed"][data-step="1"]').disabled,
      minus: document.querySelector('[data-target="speed"][data-step="-1"]').disabled,
    }));
    note('stepper-max', atMax.speed === '10' && atMax.plus === true && atMax.minus === false, JSON.stringify(atMax));

    await openCard('sec-switches');
    const sw = await evalCard(() => ({
      sa0: document.getElementById('swSA0').value,
      ga0: document.getElementById('swGA0').value,
      options: document.getElementById('swSA0').options.length,
      sbDisabled: document.getElementById('swSB0').disabled,
      resetEnabled: !document.getElementById('btnResetSwitchActions').disabled,
    }));
    note('switch-values', sw.sa0 === '1' && sw.ga0 === '6' && sw.options > 10 && !sw.sbDisabled && sw.resetEnabled, JSON.stringify(sw));

    await openCard('sec-joystick');
    // Auto-live: opening the card while connected starts the live joystick
    // view (DM 1) — the read button yields while the stream runs. Pin the
    // auto-start, then Stop + Read once covers the manual path.
    await page.waitForTimeout(600);
    const autoJoy = await evalCard(() => ({
      pressed: document.getElementById('btnLiveJoy').getAttribute('aria-pressed'),
      readOnce: document.getElementById('btnReadJoy').disabled,
      raw: document.getElementById('joyRaw').textContent,
    }));
    note(
      'auto-live-joystick',
      autoJoy.pressed === 'true' && autoJoy.readOnce && /\d+\.\d+ \| -?\d+\.\d+/.test(autoJoy.raw),
      JSON.stringify(autoJoy),
    );
    await page.click('#btnLiveJoy');
    await page.waitForTimeout(400);
    await page.click('#btnReadJoy');
    await page.waitForTimeout(500);
    const joy = await evalCard(() => ({
      raw: document.getElementById('joyRaw').textContent,
      out: document.getElementById('joyOut').textContent,
      rawDot: !document.getElementById('dotRaw').hidden,
      innerRing: document.getElementById('ringInner').style.width,
      neutral: !document.getElementById('dotN').hidden,
      corner1: !document.getElementById('dotC1').hidden,
    }));
    note(
      'joystick-read',
      joy.raw.includes('2.5') && joy.out.includes('153') && joy.rawDot && joy.innerRing !== '' && joy.neutral && joy.corner1,
      JSON.stringify(joy),
    );

    await openCard('sec-feedback');
    const fb = await evalCard(() => ({
      soundSel: document.getElementById('soundMode').value,
      lightSel: document.getElementById('lightMode').value,
      bright: document.getElementById('brightnessVal').textContent,
      brightSegs: document.querySelectorAll('#brightnessMeter span.on').length,
    }));
    note('feedback-values', fb.soundSel === '1' && fb.lightSel === '2' && fb.bright === '8' && fb.brightSegs === 8, JSON.stringify(fb));

    // Health check
    await openCard('sec-diagnostics');
    await page.click('#btnRunDiagnostics');
    await page.waitForTimeout(1500);
    const health = await evalCard(() => ({
      summary: document.getElementById('healthSummary').textContent,
      cells: [...document.querySelectorAll('.health-cell')].map((c) => ({
        state: c.getAttribute('data-state'),
        label: c.getAttribute('aria-label'),
      })),
      details: document.getElementById('healthDetails').textContent,
    }));
    note(
      'health-check',
      health.summary === 'Passed' &&
        health.cells.every((c) => c.state === 'ok') &&
        health.details.includes('All 5 checks passed') &&
        health.cells[0].label.startsWith('OK'),
      JSON.stringify(health),
    );

    // Self-test: mid-narration, completion, linger, unlock
    await page.click('#btnTestLeds');
    await page.waitForTimeout(600);
    const midTest = await evalCard(() => ({
      visible: !document.getElementById('selfTestPanel').hidden,
      title: document.getElementById('selfTestTitle').textContent,
      steps: document.querySelectorAll('#selfTestSteps li').length,
      ledsLocked: document.getElementById('btnTestLeds').disabled,
      buzzerLocked: document.getElementById('btnTestBuzzer').disabled,
    }));
    note(
      'selftest-mid',
      midTest.visible && midTest.title.includes('LED') && midTest.steps === 13 && midTest.ledsLocked && midTest.buzzerLocked,
      JSON.stringify(midTest),
    );
    await page.waitForTimeout(1800);
    const stillLocked = await evalCard(() => document.getElementById('btnTestLeds').disabled);
    note('selftest-mid-locked', stillLocked === true, 'locked at 2.4s');
    // 'Test Complete' lands at ~3.6s from the fake's narration cadence —
    // probe at 4.4s so the completion marking is never raced.
    await page.waitForTimeout(2000);
    const completed = await evalCard(() => ({
      done: document.querySelectorAll('#selfTestSteps li.done').length,
      active: document.querySelectorAll('#selfTestSteps li.active').length,
      panelStill: !document.getElementById('selfTestPanel').hidden,
    }));
    note('selftest-complete', completed.done === 13 && completed.active === 0 && completed.panelStill, JSON.stringify(completed));
    await page.waitForTimeout(2700); // linger ends ~6.1s
    const postTest = await evalCard(() => ({
      hidden: document.getElementById('selfTestPanel').hidden,
      leds: !document.getElementById('btnTestLeds').disabled,
      buzzer: !document.getElementById('btnTestBuzzer').disabled,
    }));
    note('selftest-linger-end', postTest.hidden && postTest.leds && postTest.buzzer, JSON.stringify(postTest));

    // Live joystick view (lives in the Joystick card)
    await openCard('sec-joystick');
    // Auto-live started the stream on open — the old first click would now
    // stop it. The live button is pressed by the section itself.
    await page.waitForTimeout(800);
    const live1 = await evalCard(() => ({
      text: document.getElementById('btnLiveJoy').textContent,
      pressed: document.getElementById('btnLiveJoy').getAttribute('aria-pressed'),
      panel: !document.getElementById('diagJoy').hidden,
      aria: document.getElementById('diagPlot').getAttribute('aria-label'),
      readOnce: document.getElementById('btnReadJoy').disabled,
    }));
    note(
      'live-view',
      live1.text === 'Stop live view' && live1.pressed === 'true' && live1.panel && live1.aria.includes('raw') && live1.readOnce,
      JSON.stringify(live1),
    );
    await page.click('#btnLiveJoy');
    await page.waitForTimeout(500);
    const live0 = await evalCard(() => ({
      text: document.getElementById('btnLiveJoy').textContent,
      pressed: document.getElementById('btnLiveJoy').getAttribute('aria-pressed'),
      panel: !document.getElementById('diagJoy').hidden,
    }));
    note('live-stop', live0.text === 'Live view' && live0.pressed === 'false' && !live0.panel, JSON.stringify(live0));

    // Hub remote: open, navigate, select Mode, close
    await openCard('sec-diagnostics');
    await page.click('#btnHubOpen');
    await page.waitForTimeout(900);
    const hub1 = await evalCard(() => ({
      wrap: !document.getElementById('hubScreenWrap').hidden,
      header: document.getElementById('hubScreenHeader').textContent,
      items: [...document.querySelectorAll('#hubScreenItems li')].map((li) => li.textContent.trim()),
      firstSelected: document.querySelector('#hubScreenItems li.selected') !== null,
    }));
    note('hub-open', hub1.wrap && hub1.header === 'Main menu' && hub1.items.length === 5 && hub1.firstSelected, JSON.stringify(hub1));
    await page.click('#btnHubNext');
    await page.waitForTimeout(500);
    await page.click('#btnHubNext');
    await page.waitForTimeout(500);
    const hub2 = await evalCard(() => {
      const items = [...document.querySelectorAll('#hubScreenItems li')];
      return { sel: items.findIndex((li) => li.classList.contains('selected')), text: items[2]?.textContent.trim() };
    });
    note('hub-next', hub2.sel === 2 && hub2.text === 'Mode', JSON.stringify(hub2));
    await page.click('#btnHubSelect');
    await page.waitForTimeout(700);
    const hub3 = await evalCard(() => ({
      header: document.getElementById('hubScreenHeader').textContent,
      count: document.querySelectorAll('#hubScreenItems li').length,
    }));
    note('hub-select-mode', hub3.header.toLowerCase().includes('mode') && hub3.count >= 3, JSON.stringify(hub3));
    await page.click('#btnHubClose');
    await page.waitForTimeout(500);
    note('hub-close', (await evalCard(() => document.getElementById('hubScreenWrap').hidden)) === true, 'wrap hidden');

    // Two-way hub remote (CH,5 pushes — emitted by firmware 4.5.4): the mirror
    // follows device-initiated redraws with no app press, reopens when the
    // device menu opens on its own, and closes when the device closes it.
    await page.evaluate(() => window.__fakeFirmware.pushMenu(1, 0, 0)); // physical: user enters the menu
    await page.waitForTimeout(700);
    const push1 = await evalCard(() => ({
      wrap: !document.getElementById('hubScreenWrap').hidden,
      header: document.getElementById('hubScreenHeader').textContent,
    }));
    note('hub-push-opens', push1.wrap && push1.header === 'Main menu', JSON.stringify(push1));
    await page.evaluate(() => window.__fakeFirmware.pushMenu(1, 3, 1)); // physical: navigate to Mode, row 1
    await page.waitForTimeout(700);
    const push2 = await evalCard(() => {
      const items = [...document.querySelectorAll('#hubScreenItems li')];
      return {
        header: document.getElementById('hubScreenHeader').textContent,
        selected: items.findIndex((li) => li.classList.contains('selected')),
        selectedText: items.find((li) => li.classList.contains('selected'))?.textContent.trim(),
      };
    });
    note('hub-push-follows', push2.header.toLowerCase().includes('mode') && push2.selected === 1, JSON.stringify(push2));
    await page.waitForTimeout(1000); // clear the close-grace window before the device-side close
    await page.evaluate(() => window.__fakeFirmware.pushMenu(0, 0, 0)); // device menu times out
    await page.waitForTimeout(700);
    note('hub-push-closes', (await evalCard(() => document.getElementById('hubScreenWrap').hidden)) === true, 'device close hides mirror');

    // Raw console (lives in the Log card since 149a412) + the suggestion list
    await openCard('sec-log');
    await page.fill('#rawCommand', 'EX,0:0');
    await page.click('#btnSendRaw');
    await page.waitForTimeout(800);
    const raw1 = await evalCard(() => {
      const t = document.getElementById('log').textContent;
      return {
        begin: t.includes('EX,0:BEGIN'),
        body: t.includes('SS,0:7'),
        unrecognized: t.includes('Unrecognized device response'),
        suggestions: document.getElementById('rawCommandList').options.length,
      };
    });
    note('raw-ex-dump', raw1.begin && raw1.body && !raw1.unrecognized && raw1.suggestions > 0, JSON.stringify(raw1));

    // Mode change dialog + cancel
    await openCard('sec-device');
    await page.selectOption('#operatingMode', 'gamepad');
    await page.waitForTimeout(300);
    await page.click('#btnSetOperatingMode');
    await page.waitForTimeout(400);
    const modeDlg = await evalCard(() => ({
      open: document.getElementById('confirmDialog').open,
      title: document.getElementById('confirmTitle').textContent,
    }));
    note('mode-dialog', modeDlg.open && modeDlg.title.includes('operating mode'), JSON.stringify(modeDlg));
    await page.click('#confirmCancel');
    await page.waitForTimeout(400);
    const modeAfter = await evalCard(() => ({
      open: document.getElementById('confirmDialog').open,
      opmode: document.getElementById('opmode').textContent,
    }));
    note('mode-cancel', !modeAfter.open && modeAfter.opmode === 'Mouse', JSON.stringify(modeAfter));

    // Disconnect gating
    await page.click('#btnDisconnect');
    await page.waitForTimeout(800);
    const disc = await evalCard(() => ({
      status: document.getElementById('status').textContent,
      title: document.title,
      connectEnabled: !document.getElementById('btnConnect').disabled,
      dimmed: document.querySelectorAll('.circle-trigger.dimmed').length,
      cmdDisabled: document.getElementById('btnSetSip').disabled,
      health: document.getElementById('healthSummary').textContent,
    }));
    note(
      'disconnect',
      disc.status === 'Not connected' && disc.title === 'LipSync Connect' && disc.connectEnabled && disc.dimmed > 0 && disc.cmdDisabled && disc.health === 'Not run',
      JSON.stringify(disc),
    );

    // ---------------- Phase 2: deep flows ----------------
    await connect();

    await openCard('sec-firmware');
    const fwCheck = await evalCard(() => ({
      installed: document.getElementById('fwCurrentVersion').textContent,
      state: document.getElementById('fwUpdateStatus').getAttribute('data-state'),
      text: document.getElementById('fwUpdateStatus').textContent,
    }));
    note(
      'fw-offline-check',
      fwCheck.installed === '4.5.2' && fwCheck.state && ['warn', 'unknown', 'busy'].includes(fwCheck.state),
      JSON.stringify(fwCheck),
    );
    await page.click('#btnCheckUpdate');
    await page.waitForTimeout(600);
    const fwRe = await evalCard(() => ({
      state: document.getElementById('fwUpdateStatus').getAttribute('data-state'),
    }));
    note('fw-recheck-failed', fwRe.state === 'warn' || fwRe.state === 'unknown', JSON.stringify(fwRe));

    await openCard('sec-joystick');
    await page.click('#btnInit');
    await page.waitForTimeout(700);
    const neutral = await evalCard(() => ({
      status: document.getElementById('calStatus').textContent,
      val: document.getElementById('neutralVal').textContent,
    }));
    note('neutral-reset', neutral.status.includes('Neutral position set to') && neutral.val.includes('1.23'), JSON.stringify(neutral));

    await page.click('#btnCalibrate');
    await page.waitForTimeout(900);
    const calMid = await evalCard(() => ({
      strip: !document.getElementById('calSteps').hidden,
      active: document.querySelector('#calSteps li.active')?.textContent,
      status: document.getElementById('calStatus').textContent,
    }));
    note(
      'cal-mid',
      calMid.strip && calMid.active?.includes('corner 3') && calMid.status.includes('Step 3'),
      JSON.stringify(calMid),
    );
    await page.waitForTimeout(2600);
    const calDone = await evalCard(() => ({
      status: document.getElementById('calStatus').textContent,
      done: document.querySelectorAll('#calSteps li.done').length,
      cornerDots: document.querySelectorAll('.dot.corner.captured').length,
    }));
    note('cal-done', calDone.status.includes('Calibration complete') && calDone.done >= 6 && calDone.cornerDots === 4, JSON.stringify(calDone));

    await openCard('sec-sip');
    await page.click('text=Set exact window values');
    await page.fill('#w1Input', '600');
    await page.click('#btnSetWS');
    await page.waitForTimeout(600);
    const w1 = await evalCard(() => ({
      val: document.getElementById('w1Val').textContent,
      input: document.getElementById('w1Input').value,
      err: document.getElementById('sapError').textContent,
    }));
    note('timing-set', w1.val === '600' && w1.input === '600' && w1.err === '', JSON.stringify(w1));
    await page.fill('#w2Input', '500');
    await page.click('#btnSetWL');
    await page.waitForTimeout(500);
    const w2bad = await evalCard(() => ({
      err: document.getElementById('sapError').textContent,
      val: document.getElementById('w2Val').textContent,
    }));
    note('timing-order-refused', w2bad.err.includes('ordered') && w2bad.val === '1000', JSON.stringify(w2bad));

    // Input-window ladder: zones proportional to the windows in force
    // (600/1000/2500 → 24%/16%/60%), scale marks, and the live aria-label.
    const ladder = await evalCard(() => ({
      zones: [...document.querySelectorAll('#winLadder .win-zone')].map((z) => z.style.flexBasis),
      marks: [...document.querySelectorAll('#winScale span')].map((s) => s.textContent),
      aria: document.getElementById('winLadder').getAttribute('aria-label'),
    }));
    note(
      'window-ladder',
      ladder.zones.length === 3 &&
        Math.round(parseFloat(ladder.zones[0])) === 24 &&
        Math.round(parseFloat(ladder.zones[1])) === 16 &&
        Math.round(parseFloat(ladder.zones[2])) === 60 &&
        ladder.marks.join('|') === '0 ms|600|1000|2500 ms' &&
        ladder.aria.includes('600 ms'),
      JSON.stringify(ladder),
    );

    // Watch holds — the card's practice door into the hold stream. Covered
    // again (de-flaked + readout-reset + exclusivity) in the phase-2 block
    // below; the ladder check above already pinned the timeline itself.

    // Diagnostics ladder sweep: the DEBUG,5 sip&puff state stream drives the
    // live hold fill (the fake cycles 2 s holds with 2 s gaps — poll until a
    // hold paints).
    await openCard('sec-diagnostics');
    await page.selectOption('#debugMode', '5');
    await page.click('#btnSetDebug');
    let swept = false;
    let sweepDetail = null;
    for (let i = 0; i < 15 && !swept; i++) {
      await page.waitForTimeout(300);
      sweepDetail = await evalCard(() => ({
        sweepW: parseFloat(document.querySelector('#winLadderDiag .win-sweep').style.width) || 0,
        activeZone: !!document.querySelector('#winLadderDiag .win-zone.active'),
        aria: document.getElementById('winLadderDiag').getAttribute('aria-label'),
      }));
      swept = sweepDetail.sweepW > 5 && sweepDetail.activeZone;
    }
    note('window-ladder-sweep', swept, JSON.stringify(sweepDetail));
    await page.selectOption('#debugMode', '0');
    await page.click('#btnSetDebug');
    await page.waitForTimeout(500);

    await openCard('sec-restrictions');
    await page.check('#sapDisabled');
    await page.waitForTimeout(600);
    const r1 = await evalCard(() => ({
      checked: document.getElementById('sapDisabled').checked,
      enabled: !document.getElementById('sapDisabled').disabled,
    }));
    note('restriction-on', r1.checked && r1.enabled, JSON.stringify(r1));
    await page.uncheck('#sapDisabled');
    await page.waitForTimeout(600);
    note('restriction-off', (await evalCard(() => document.getElementById('sapDisabled').checked)) === false, 'unchecked');

    await openCard('sec-switches');
    await page.selectOption('#swSA0', '5');
    await page.waitForTimeout(700);
    const remap = await evalCard(() => ({
      sel: document.getElementById('swSA0').value,
      err: document.getElementById('switchError').textContent,
    }));
    note('switch-remap', remap.sel === '5' && remap.err === '', JSON.stringify(remap));

    // Switch-card mode toggles: the per-jack segmented tabs swap the visible
    // mapping (mouse ↔ gamepad) and carry aria-pressed; selecting the
    // already-pressed tab is a no-op.
    await page.click('.switch-tab[data-jack="A"][data-mode="gamepad"]');
    await page.waitForTimeout(400);
    const tabGamepad = await evalCard(() => ({
      gamepadVisible: !document.querySelector('.switch-mode[data-jack="A"][data-mode="gamepad"]').hidden,
      mouseHidden: document.querySelector('.switch-mode[data-jack="A"][data-mode="mouse"]').hidden,
      pressed: document.querySelector('.switch-tab[data-jack="A"][data-mode="gamepad"]').getAttribute('aria-pressed'),
      mousePressed: document.querySelector('.switch-tab[data-jack="A"][data-mode="mouse"]').getAttribute('aria-pressed'),
      jackBTabsUntouched: document.querySelector('.switch-tab[data-jack="B"][data-mode="mouse"]').getAttribute('aria-pressed'),
    }));
    note(
      'switch-tab-gamepad',
      tabGamepad.gamepadVisible && tabGamepad.mouseHidden && tabGamepad.pressed === 'true' && tabGamepad.mousePressed === 'false' && tabGamepad.jackBTabsUntouched === 'true',
      JSON.stringify(tabGamepad),
    );
    await page.click('.switch-tab[data-jack="A"][data-mode="mouse"]');
    await page.waitForTimeout(400);
    const tabBack = await evalCard(() => ({
      mouseVisible: !document.querySelector('.switch-mode[data-jack="A"][data-mode="mouse"]').hidden,
      gamepadHidden: document.querySelector('.switch-mode[data-jack="A"][data-mode="gamepad"]').hidden,
      pressed: document.querySelector('.switch-tab[data-jack="A"][data-mode="mouse"]').getAttribute('aria-pressed'),
    }));
    note('switch-tab-mouse-back', tabBack.mouseVisible && tabBack.gamepadHidden && tabBack.pressed === 'true', JSON.stringify(tabBack));

    await openCard('sec-sip');
    // Auto-live: the pressure stream is already running from the open —
    // assert it directly instead of toggling.
    await page.waitForTimeout(700);
    const lp = await evalCard(() => ({
      pressed: document.getElementById('btnLivePressure').getAttribute('aria-pressed'),
      panel: !document.getElementById('diagPressure').hidden,
      mouth: document.getElementById('diagPressMouth').textContent,
      gaugeAria: document.getElementById('diagGauge').getAttribute('aria-label'),
      readOnce: document.getElementById('btnReadPressure').disabled,
    }));
    note(
      'live-pressure',
      lp.pressed === 'true' && lp.panel && lp.mouth.includes('.') && lp.gaugeAria.includes('hPa') && lp.readOnce,
      JSON.stringify(lp),
    );
    await page.click('#btnLivePressure');
    await page.waitForTimeout(400);

    // Practice peaks + suggest-from-practice: the streamed pressure swings
    // (the fake's ±25 hPa wave) must pin both peaks, expose the Suggest
    // button, and Apply must write both thresholds from the measured maxima.
    const peaks = await evalCard(() => ({
      sip: document.getElementById('peakSipVal').textContent,
      puff: document.getElementById('peakPuffVal').textContent,
      suggestVisible: !document.getElementById('btnSuggestThresholds').hidden,
      sipBefore: document.getElementById('sipVal').textContent,
      puffBefore: document.getElementById('puffVal').textContent,
    }));
    note(
      'practice-peaks',
      parseFloat(peaks.sip) >= 10 &&
        parseFloat(peaks.puff) >= 10 &&
        peaks.suggestVisible,
      JSON.stringify(peaks),
    );
    await page.click('#btnSuggestThresholds');
    await page.waitForTimeout(300);
    const suggest = await evalCard(() => ({
      open: !document.getElementById('sapSuggestion').hidden,
      text: document.getElementById('sapSuggestionText').textContent,
    }));
    note('suggest-thresholds', suggest.open && /65% of the practice peaks/.test(suggest.text), JSON.stringify(suggest));
    await page.click('#btnApplySuggested');
    await page.waitForTimeout(600);
    const applied = await evalCard(() => ({
      sip: document.getElementById('sipVal').textContent,
      puff: document.getElementById('puffVal').textContent,
      suggestionHidden: document.getElementById('sapSuggestion').hidden,
    }));
    note(
      'suggest-apply',
      applied.suggestionHidden &&
        applied.sip !== peaks.sipBefore &&
        applied.puff !== peaks.puffBefore &&
        parseFloat(applied.sip) >= 2 &&
        parseFloat(applied.puff) >= 2,
      JSON.stringify(applied),
    );

    // Watch holds (the Sip & Puff card's practice door into the DEBUG,5
    // stream): the button starts the hold stream, both ladders sweep with the
    // device-measured hold, and the card's Hold readout tracks the state.
    // The fake cycles 2 s holds with 2 s gaps — poll for a hold instead of
    // sampling once, so the check never races the cycle phase.
    await page.click('#btnWatchHolds');
    let wh = null;
    for (let i = 0; i < 16; i++) {
      await page.waitForTimeout(300);
      wh = await evalCard(() => {
        const ladder = document.getElementById('winLadder');
        const sweep = ladder.children[3];
        return {
          pressed: document.getElementById('btnWatchHolds').getAttribute('aria-pressed'),
          text: document.getElementById('btnWatchHolds').textContent.trim(),
          sweepWidth: sweep.style.width,
          ladderAria: ladder.getAttribute('aria-label'),
          holdReadout: document.getElementById('sapHoldVal').textContent,
          livePressureOff: document.getElementById('btnLivePressure').getAttribute('aria-pressed') === 'false',
        };
      });
      if (parseFloat(wh.sweepWidth) > 0 && wh.ladderAria.includes('Hold at')) break;
    }
    note(
      'watch-holds',
      wh.pressed === 'true' &&
        wh.text === 'Stop watching' &&
        parseFloat(wh.sweepWidth) > 0 &&
        wh.ladderAria.includes('Hold at') &&
        wh.holdReadout.includes('ms') &&
        wh.livePressureOff,
      JSON.stringify(wh),
    );
    await page.click('#btnWatchHolds');
    await page.waitForTimeout(400);
    const whStopped = await evalCard(() => ({
      pressed: document.getElementById('btnWatchHolds').getAttribute('aria-pressed'),
      text: document.getElementById('btnWatchHolds').textContent.trim(),
      sweepWidth: document.getElementById('winLadder').children[3].style.width,
      ladderAria: document.getElementById('winLadder').getAttribute('aria-label'),
      holdReadout: document.getElementById('sapHoldVal').textContent,
    }));
    // The stop must reset BOTH visualizations — and the always-visible Hold
    // readout must not freeze on its last frame (a stale "· started").
    note(
      'watch-holds-stop',
      whStopped.pressed === 'false' &&
        whStopped.text === 'Watch holds' &&
        parseFloat(whStopped.sweepWidth) === 0 &&
        !whStopped.ladderAria.includes('Hold at') &&
        whStopped.holdReadout === '—',
      JSON.stringify(whStopped),
    );
    // Mutual exclusivity: starting the pressure live view mid-watch hands
    // the stream over — watch un-presses, its readout resets.
    await page.click('#btnWatchHolds');
    await page.waitForTimeout(500);
    await page.click('#btnLivePressure');
    await page.waitForTimeout(600);
    const whEx = await evalCard(() => ({
      watch: document.getElementById('btnWatchHolds').textContent.trim(),
      watchPressed: document.getElementById('btnWatchHolds').getAttribute('aria-pressed'),
      pressure: document.getElementById('btnLivePressure').textContent.trim(),
      pressurePressed: document.getElementById('btnLivePressure').getAttribute('aria-pressed'),
      hold: document.getElementById('sapHoldVal').textContent,
    }));
    note(
      'watch-holds-exclusivity',
      whEx.watch === 'Watch holds' &&
        whEx.watchPressed === 'false' &&
        whEx.pressure === 'Stop live view' &&
        whEx.pressurePressed === 'true' &&
        whEx.hold === '—',
      JSON.stringify(whEx),
    );
    await page.click('#btnLivePressure');
    await page.waitForTimeout(400);

    await openCard('sec-device');
    await page.click('#btnRefreshAll');
    await page.waitForTimeout(2500);
    const refresh = await evalCard(() => ({
      status: document.getElementById('status').textContent,
      w1: document.getElementById('w1Val').textContent,
      sap: document.getElementById('sapDisabled').checked,
      hint: document.getElementById('modeGuardHint').textContent,
    }));
    note('refresh-all', refresh.status === 'Connected' && refresh.w1 === '600' && !refresh.sap && refresh.hint === '', JSON.stringify(refresh));

    await openCard('sec-maintenance');
    await page.click('#btnFactoryReset');
    await page.waitForTimeout(500);
    const frDlg = await evalCard(() => ({
      open: document.getElementById('confirmDialog').open,
      focus: document.activeElement.id,
      title: document.getElementById('confirmTitle').textContent,
    }));
    note('factory-dialog-danger', frDlg.open && frDlg.focus === 'confirmCancel' && frDlg.title === 'Factory reset', JSON.stringify(frDlg));
    await page.click('#confirmCancel');
    await page.waitForTimeout(400);

    // Confirmed mode change: OM+CM then SR, app disconnects with the toast
    await openCard('sec-device');
    await page.selectOption('#operatingMode', 'gamepad');
    await page.waitForTimeout(300);
    await page.click('#btnSetOperatingMode');
    await page.waitForTimeout(500);
    await page.click('#confirmOk');
    await page.waitForTimeout(2500);
    const modeChanged = await evalCard(() => ({
      status: document.getElementById('status').textContent,
      notif: (() => {
        const n = document.getElementById('notification');
        return n.hidden ? null : n.querySelector('.notif-msg')?.textContent;
      })(),
    }));
    note('mode-change-flow', modeChanged.status === 'Not connected' && (modeChanged.notif ?? '').includes('Gamepad'), JSON.stringify(modeChanged));

    await openCard('sec-log');
    // Model "desktop without share support" deterministically: headless
    // Chromium exposes navigator.share but its promise may never settle (no
    // share UI), which makes the real not-supported fallback unreachable.
    // Shadowing it with undefined sends shareLog down the same code path a
    // share-less browser takes — the in-app privacy confirm.
    await page.evaluate(() => {
      try {
        Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
      } catch {}
    });
    const hitInfo = await evalCard(() => {
      const btn = document.getElementById('btnShareLog');
      const r = btn.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        hit: el ? el.tagName + (el.id ? '#' + el.id : '') : null,
        popupOpen: document.getElementById('appearancePopup').classList.contains('open'),
        toastHidden: document.getElementById('notification').hidden,
      };
    });
    await page.click('#btnShareLog');
    await page.waitForTimeout(900);
    const share = await evalCard(() => ({
      open: document.getElementById('confirmDialog').open,
      title: document.getElementById('confirmTitle').textContent,
    }));
    note('share-fallback', share.open && share.title === 'Share log', JSON.stringify({ ...hitInfo, ...share }));
    await page.click('#confirmCancel');

    // UI scale: the appearance popup's 100/125/150 control applies body
    // zoom live and persists; back to 100% removes the choice.
    await page.click('#btnSettings');
    await page.waitForTimeout(300);
    await page.click('.scale-btn[data-scale="1.25"]');
    await page.waitForTimeout(200);
    const scaled = await evalCard(() => ({
      zoom: document.body.style.zoom,
      pressed: document.querySelector('.scale-btn[data-scale="1.25"]').getAttribute('aria-pressed'),
      stored: JSON.parse(localStorage.getItem('lipsync-theme') || '{}').scale,
    }));
    note('ui-scale-125', scaled.zoom === '1.25' && scaled.pressed === 'true' && scaled.stored === 1.25, JSON.stringify(scaled));
    await page.click('.scale-btn[data-scale="1"]');
    await page.waitForTimeout(200);
    const unscaled = await evalCard(() => ({
      zoom: document.body.style.zoom,
      pressed: document.querySelector('.scale-btn[data-scale="1"]').getAttribute('aria-pressed'),
    }));
    note('ui-scale-reset', unscaled.zoom === '1' && unscaled.pressed === 'true', JSON.stringify(unscaled));
    await page.click('#btnSettings'); // close the popup

    // ---------------- Phase 3: the full firmware-update wizard ----------------
    // Uses the dev server's REAL local artifacts: /firmware-manifest.json +
    // /firmware-files/LipSync_Firmware_4.5.4_dfu.zip from dev/firmware/dist
    // (the documented localStorage override), the browser-side bootloader
    // model in the fake, and the fake's app firmware flipping to 4.5.4 when
    // the bootloader activates. Exercises the whole journey: check →
    // backup → confirm → UM restart → bootloader port pick → real DFU wire
    // exchange → STOP/activate → reconnect → verify + settings restore.
    await page.evaluate(() => {
      localStorage.removeItem('lipsync-fw-check'); // the offline check from phase 1/2 is cached
      localStorage.setItem('lipsync-fw-manifest-url', '/firmware-manifest.json');
      window.__fakeFirmware.wantBootloader = false;
      window.__fakeFirmware.state.VN = '4.5.2';
      window.__fakeFirmware.targetVersion = '4.5.4';
    });

    await connect();
    await openCard('sec-firmware');
    // The auto-check (post-connect) read the local manifest: 4.5.4 > 4.5.2.
    const updateBtn = await page.waitForSelector('#btnStartUpdate', { state: 'visible', timeout: 15000 });
    const fwAvail = await evalCard(() => ({
      latest: document.getElementById('fwLatestVersion').textContent,
      installed: document.getElementById('fwCurrentVersion').textContent,
      status: document.getElementById('fwUpdateStatus').getAttribute('data-state'),
      notes: !!document.getElementById('fwNotesLink'),
    }));
    note(
      'fw-update-available',
      fwAvail.latest === '4.5.4' && fwAvail.installed === '4.5.2' && fwAvail.status === 'available',
      JSON.stringify(fwAvail),
    );

    // The settings backup fires as a download; then the confirm dialog.
    const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
    await updateBtn.click();
    const download = await downloadPromise;
    await page.waitForTimeout(400);
    const updDlg = await evalCard(() => ({ open: document.getElementById('confirmDialog').open }));
    note('fw-wizard-backup+confirm', updDlg.open && download.suggestedFilename().includes('settings'), JSON.stringify({ file: download.suggestedFilename(), open: updDlg.open }));
    await page.click('#confirmOk');

    // Restart step: UM acked, wizard disconnects and asks for the update port.
    await page.waitForSelector('#btnFwContinue', { state: 'visible', timeout: 20000 });
    const restartStep = await evalCard(() => ({
      stage: document.querySelector('#fwStepRestart').className,
      text: document.getElementById('fwWizardStep').textContent,
      connected: document.getElementById('status').textContent,
    }));
    note(
      'fw-wizard-restart',
      restartStep.stage.includes('active') &&
        /update port|update mode/.test(restartStep.connected) &&
        /Continue/.test(restartStep.text),
      JSON.stringify(restartStep),
    );
    await page.click('#btnFwContinue'); // picker → the fake presents the bootloader

    // Flash: real DFU over the bootloader model — erase + ~600 data frames
    // against the real 4.5.4 package. Poll the progress to 100%.
    let flashSeen = null;
    let maxPct = 0;
    const flashDeadline = Date.now() + 120000;
    while (Date.now() < flashDeadline) {
      await page.waitForTimeout(800);
      flashSeen = await evalCard(() => ({
        pct: parseInt(document.getElementById('fwPct').textContent) || Math.round(document.getElementById('fwProgress').value) || 0,
        stage: document.querySelector('#fwStepFlash').className,
        text: document.getElementById('fwWizardStep').textContent,
      }));
      maxPct = Math.max(maxPct, flashSeen.pct);
      if (flashSeen.text.includes('Firmware installed')) break;
    }
    note(
      'fw-wizard-flash',
      flashSeen.stage.includes('done') && flashSeen.text.includes('Firmware installed') && maxPct >= 95,
      JSON.stringify({ ...flashSeen, maxPct }),
    );

    // Reconnect: the fake re-presents the application, now on 4.5.4 — the
    // pending-update finisher must verify the version and restore settings.
    await page.click('#btnConnect');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Connected', null, { timeout: 30000 });
    let restore = null;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(600);
      restore = await evalCard(() => ({
        done: document.getElementById('fwWizard')?.getAttribute('data-state'),
        text: document.getElementById('fwWizardStep')?.textContent ?? '',
        version: document.getElementById('version').textContent,
        fwCurrent: document.getElementById('fwCurrentVersion').textContent,
        w1: document.getElementById('w1Val').textContent,
        status: document.getElementById('status').textContent,
      }));
      if (restore.done === 'done') break;
    }
    note(
      'fw-wizard-verify+restore',
      restore.done === 'done' &&
        restore.text.toLowerCase().includes('complete') &&
        restore.version === '4.5.4' &&
        restore.fwCurrent === '4.5.4' &&
        restore.w1 === '600' && // the fake's post-flash factory default is 500 — only the restore brings 600 back
        restore.status === 'Connected',
      JSON.stringify(restore),
    );
    await ctx.close();
  } finally {
    await browser.close();
  }
  return findings;
}

// ---------------- Viewport matrix: the layout guards ----------------
// The connected UI must not horizontally scroll at any width (the round-8
// grid fix). Runs the same fake at phone/narrow-desktop/landscape sizes and
// opens the widest cards.
export async function runViewportAudit({ origin, chromium, executablePath }) {
  const findings = [];
  const note = (area, ok, detail) => findings.push({ area, ok: !!ok, detail });
  const fakePath = path.join(dir, 'fake-firmware.mjs');
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    for (const [w, h] of [
      [390, 844],
      [560, 800],
      [844, 390],
      [1280, 900],
    ]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      await page.route('**api.github.com**', (r) => r.abort());
      await page.addInitScript({ path: fakePath });
      await page.goto(origin + '/', { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      await page.click('#btnConnect');
      await page.waitForFunction(() => document.getElementById('status').textContent === 'Connected', null, { timeout: 20000 });
      for (const sec of ['sec-sip', 'sec-joystick', 'sec-switches', 'sec-log']) {
        await page.click(`.circle-trigger[data-section="${sec}"]`);
        await page.waitForTimeout(900);
        const fit = await page.evaluate(
          ({ id, vw }) => ({
            hScroll: document.documentElement.scrollWidth > vw,
            cardW: Math.round(document.getElementById(id).getBoundingClientRect().width),
          }),
          { id: sec, vw: w },
        );
        note(`${w}x${h}-${sec}`, !fit.hScroll, JSON.stringify(fit));
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  return findings;
}

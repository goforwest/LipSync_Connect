// Browser-side LipSync firmware fake for the connected-state UI audits
// (dev/browser-audit/connected-audit.mjs): installed via playwright
// addInitScript before the app loads, so navigator.serial exists when
// transport.js evaluates. Models the 4.5.2 wire protocol: SETTINGS
// handshake, all GET/SET endpoints with echo rules, PV/JV dynamic reads,
// DM live streams, RT self-test narration, CH hub-menu presses + the
// CH,0:0 state triple, BH bus health, the EX settings dump, and the
// IN/CA calibration flow (corner acks + MANUAL re-center, 4.5.2 shapes).
//
// Not a protocol test fixture — the node tests (tests/harness) own the
// wire-contract coverage. This exists to exercise the CONNECTED UI in a
// real browser: chrome, cards, gauge, plots, panels, hub mirror, toasts.
(() => {
  const enc = new TextEncoder();

  const state = {
    MN: '1', VN: '4.5.2', ID: 'A1B2C3D4', OM: '1', CM: '1',
    SS: '7', SL: '5', AV: '3', ST: '12.5', PT: '25',
    IZ: '0.05', OZ: '0.95', IN: '0.12|-0.34',
    CA: '0.12|-0.34,9.50|8.30,-9.40|8.10,-8.20|-7.05,7.90|-6.98',
    SM: '1', LM: '2', LL: '8', DM: '0',
    SD: '0', MA: '0', LK: '0', CF: '0',
    WS: '500', WL: '1000', WM: '2500',
  };
  // Switch triples as {SA:[s,l,m], ...}; SET carries packed 100000+...
  const switches = { SA: [1, 2, 3], SB: [0, 0, 0], SC: [0, 0, 0], GA: [6, 7, 8], GB: [0, 0, 0], GC: [0, 0, 0] };

  const menu = { active: 0, page: 0, row: 0 };
  const mainRows = 5;
  let debugTimer = null;
  let debugMode = 0;
  let calTimer = null;
  // The most recent open port's emit — lets the audit script play the DEVICE
  // side of the two-way hub remote (MANUAL CH,5 pushes) mid-session.
  let currentEmit = null;

  const ECHO = new Set(['SS','SL','ST','PT','IZ','OZ','SM','LM','LL','DM','OM','CM','SA','SB','SC','GA','GB','GC']);
  const LED_NARRATION = [
    'TEST_MODE_LED: all led off', 'TEST_MODE_LED: left led on', 'TEST_MODE_LED: middle led on',
    'TEST_MODE_LED: right led on', 'TEST_MODE_LED: all led off', 'TEST_MODE_LED: micro led blue',
    'TEST_MODE_LED: micro led purple', 'TEST_MODE_LED: micro led red', 'TEST_MODE_LED: micro led orange',
    'TEST_MODE_LED: micro led yellow', 'TEST_MODE_LED: left led brightness', 'TEST_MODE_LED: error 3',
    'TEST_MODE_LED: led default',
  ];
  const BUZZER_NARRATION = [
    'TEST_MODE_BUZZER: playing startup sound', 'TEST_MODE_BUZZER: playing ready sounds',
    'TEST_MODE_BUZZER: playing error sound', 'TEST_MODE_BUZZER: playing corner calibration sound',
    'TEST_MODE_BUZZER: playing center calibration sound', 'TEST_MODE_BUZZER: playing shutdown sound',
    'SOUND TEST COMPLETE',
  ];

  function makePort() {
    let ctrl = null;
    const port = {
      getInfo: () => ({ usbVendorId: 0x2886, usbProductId: 0x8044 }),
      readable: null,
      writable: null,
      open: async ({ baudRate } = {}) => {
        port.readable = new ReadableStream({
          start(c) { ctrl = c; },
          cancel() { ctrl = null; },
        });
        port.writable = new WritableStream({
          write: (chunk) => { handle(chunk); },
        });
        currentEmit = emit;
      },
      close: async () => {
        if (debugTimer) { clearInterval(debugTimer); debugTimer = null; }
        if (calTimer) { clearTimeout(calTimer); calTimer = null; }
        ctrl = null;
        currentEmit = null;
      },
    };
    const emit = (text, delay = 3) => {
      setTimeout(() => {
        if (!ctrl) return;
        try { ctrl.enqueue(enc.encode(text + '\n')); } catch {}
      }, delay);
    };
    function handle(chunk) {
      const text = new TextDecoder().decode(chunk).replace(/\r?\n$/, '');
      if (!text) return;
      respond(text, emit);
    }
    return port;
  }

  function startDebug(mode, emit) {
    if (debugTimer) clearInterval(debugTimer);
    debugMode = mode;
    if (mode === '0') return;
    let t = 0;
    debugTimer = setInterval(() => {
      t += 100;
      const w = Math.sin(t / 900);
      if (mode === '1') emit(`SUCCESS,0:DEBUG,1:${(w * 4).toFixed(2)}|${(Math.cos(t / 700) * 3).toFixed(2)},0|0,${Math.round(w * 200)}|${Math.round(-w * 150)}`, 0);
      else if (mode === '2') emit(`SUCCESS,0:DEBUG,2:${(1013 + w * 3).toFixed(2)},${(1013.1).toFixed(2)},${(w * 25).toFixed(2)}`, 0);
      else if (mode === '3') emit(`SUCCESS,0:DEBUG,3:${t % 3000 < 800 ? 3 : 0},${t % 3000 < 800 ? 1 : 0},${t % 3000}`, 0);
      else if (mode === '4') emit('SUCCESS,0:DEBUG,4:0,0,0', 0);
      else if (mode === '5') emit(`SUCCESS,0:DEBUG,5:${t % 4000 < 2000 ? 1 : 2},${t % 4000 < 2000 ? 1 : 2},${t % 4000}`, 0);
    }, 100);
  }

  function respond(text, emit) {
    if (text === 'SETTINGS') { emit('SUCCESS,0:SETTINGS'); return; }
    const m = text.match(/^([A-Z]{1,4}),(\d+)(?::(.*))?$/);
    if (!m) return;
    const ep = m[1], n = m[2], val = m[3] ?? '';
    if (n === '0') {
      // GET — acks carry the full command: SUCCESS,0:<EP>,0:<value>
      if (ep === 'PV') { emit('SUCCESS,0:PV,0:985.50,1013.10,-27.60'); return; }
      if (ep === 'JV') { emit('SUCCESS,0:JV,0:2.50,-1.25,0,0,153,-77'); return; }
      if (ep === 'BH') { emit('SUCCESS,0:BH,0:0,1,1,1,1,600,0,0,0,0,0,0,0'); return; }
      if (ep === 'CH') { emit(`SUCCESS,0:CH,0:${menu.active},${menu.page},${menu.row}`); return; }
      if (ep === 'IN') { emit(`SUCCESS,0:IN,0:${state.IN}`); return; }
      if (ep === 'CA') { emit(`SUCCESS,0:CA,0:${state.CA}`); return; }
      if (ep === 'EX') {
        emit('SUCCESS,0:EX,0:BEGIN');
        ['MN','VN','ID','OM','CM','SS','SL','AV','ST','PT','IZ','OZ','SM','LM','LL','WS','WL','WM','SD','MA','LK','CF'].forEach((k, i) =>
          emit(`SUCCESS,0:${k},0:${state[k]}`, 6 + i * 2),
        );
        emit('SUCCESS,0:EX,0:END', 80);
        return;
      }
      if (switches[ep]) { emit(`SUCCESS,0:${ep},0:${switches[ep].join(',')}`); return; }
      emit(`SUCCESS,0:${ep},0:${state[ep] ?? ''}`);
      return;
    }
    // SET (n === '1')
    if (ep === 'RT') {
      emit(`SUCCESS,0:RT,1:${val}`);
      const seq = val === '1' ? LED_NARRATION : BUZZER_NARRATION;
      seq.forEach((line, i) => emit(line, 250 + i * 250));
      emit('Test Complete', 250 + seq.length * 250 + 100);
      return;
    }
    if (ep === 'CH') {
      emit(`SUCCESS,0:CH,1:${val}`);
      if (val === '1') { menu.active = 1; menu.page = 0; menu.row = 0; }
      else if (val === '4') { menu.active = 0; }
      else if (val === '3' && menu.active) {
        const rows = menu.page === 0 ? mainRows : 3;
        menu.row = (menu.row + 1) % rows;
      } else if (val === '2' && menu.active) {
        if (menu.page === 0) {
          // main: 0 Exit, 1 Center Reset, 2 Mode, 3 Cursor Speed, 4 More
          menu.page = [1, 2, 3, 4, 5][menu.row] ?? 0;
          menu.row = 0;
        } else {
          menu.page = 0; menu.row = 0;
        }
      }
      return;
    }
    if (ep === 'DM') {
      state.DM = val;
      emit(`SUCCESS,0:DM,1:${val}`);
      startDebug(val, emit);
      return;
    }
    if (ep === 'IN') {
      state.IN = '1.23|-1.55';
      emit(`SUCCESS,0:IN,1:${state.IN}`);
      return;
    }
    if (ep === 'CA') {
      if (val === '1') {
        // full calibration: corner acks CA,1..CA,4 then the internal re-center
        const corners = ['9.50|8.30', '-9.40|8.10', '-8.20|-7.05', '7.90|-6.98'];
        corners.forEach((c, i) => emit(`SUCCESS,0:CA,${i + 1}:${c}`, 400 + i * 400));
        emit('MANUAL,0:IN,1:0.10|-0.20', 400 + 4 * 400);
        return;
      }
      emit(`SUCCESS,0:CA,0:${state.CA}`);
      return;
    }
    if (ep === 'SR' || ep === 'FR' || ep === 'SE' || ep === 'UM') {
      emit(`SUCCESS,0:${ep},1:${val}`);
      return;
    }
    if (switches[ep]) {
      if (val === '0') switches[ep] = [0, 0, 0];
      else {
        const packed = Number(val) - 100000;
        switches[ep] = [Math.floor(packed / 10000), Math.floor(packed / 100) % 100, packed % 100];
      }
      emit(`SUCCESS,0:${ep},1:${val}`);
      return;
    }
    if (ECHO.has(ep) || ep in state) {
      if (ep in state) state[ep] = val;
      emit(`SUCCESS,0:${ep},1:${val}`);
      return;
    }
    emit(`SUCCESS,0:${ep},1:${val}`);
  }

  const fakeSerial = {
    requestPort: async () => makePort(),
    getPorts: async () => [],
    _fake: true,
  };
  Object.defineProperty(navigator, 'serial', { value: fakeSerial, configurable: true });
  window.__fakeFirmware = { state, menu, switches };
  // Two-way hub remote: emit the firmware's menu-state push (the CH,5 line
  // protocol 4.5.3 proposes) as if a physical press/redraw just happened on
  // the device. Updates the internal state so later CH,0:0 polls agree.
  window.__fakeFirmware.pushMenu = (active, page, row) => {
    menu.active = active;
    menu.page = page;
    menu.row = row;
    currentEmit?.(`MANUAL,0:CH,5:${active},${page},${row}`);
  };
})();

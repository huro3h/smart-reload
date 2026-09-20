const { chromium } = require('playwright');
const os = require('os'), path = require('path'), fs = require('fs');
const { server } = require('./fixture.js');

const BRAVE = '/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly';
const EXT = path.resolve(__dirname, '..');
const BASE = 'http://localhost:8765/';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loads(page) {
  for (let i = 0; i < 30; i++) {
    try { return await page.evaluate(() => window.__loads); } catch (e) { await sleep(100); }
  }
  return null;
}

/** loads が base から増えるまで最大 ms 待つ。増えなければ null */
async function waitForReload(page, base, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const n = await loads(page);
    if (n !== null && n > base) return n;
    await sleep(200);
  }
  return null;
}

(async () => {
  server.listen(8765);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-reload-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: BRAVE,
    headless: false,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');

  // service worker 経由で content script を操作する
  const send = (message) => sw.evaluate(async (msg) => {
    const tabs = await chrome.tabs.query({ url: 'http://localhost:8765/*' });
    if (!tabs.length) return { error: 'no tab' };
    return chrome.tabs.sendMessage(tabs[0].id, msg);
  }, message);

  const setStorage = (obj) => sw.evaluate((o) => chrome.storage.local.set(o), obj);

  const profile = (over = {}) => ({
    interval: 3,
    retryDelay: 2,
    skip: { typing: false, selection: false, media: false, recentInput: false, idleSeconds: 5, ...(over.skip || {}) },
    restore: { scroll: true, form: true, ...(over.restore || {}) },
    watch: { enabled: false, selector: '', reloadOnlyOnChange: true, notify: false, ...(over.watch || {}) },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => !['skip', 'restore', 'watch'].includes(k))),
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(500);

  // --- 1. content script が入っていて OFF から始まる -------------------------
  let status = await send({ type: 'getStatus' });
  check('content script が応答する', !!status && status.supported === true, JSON.stringify(status && status.on));
  check('初期状態は OFF', status && status.on === false);

  // --- 2. 手動 ON で 3 秒ごとにリロードされる --------------------------------
  let base = await loads(page);
  await send({ type: 'start', profile: profile() });
  let next = await waitForReload(page, base, 8000);
  check('手動 ON でリロードされる', next !== null, `loads ${base} -> ${next}`);

  // --- 3. スクロール位置とフォームが復元される ------------------------------
  // ブラウザ自身のスクロール復元を切る。これで 1500 に戻るなら拡張の復元が効いている。
  await page.waitForLoadState('load');
  await sleep(600);
  await page.evaluate(() => {
    history.scrollRestoration = 'manual';
    window.scrollTo(0, 1500);
    document.getElementById('txt').value = 'すまーとりろーど';
    document.getElementById('area').value = '複数行\nのテキスト';
    document.getElementById('pw').value = 'secret-should-not-survive';
    document.getElementById('chk').checked = true;
  });
  await sleep(400);
  const beforeY = await page.evaluate(() => Math.round(window.scrollY));
  check('リロード前にスクロールできている', beforeY === 1500, `scrollY=${beforeY}`);
  base = await loads(page);
  next = await waitForReload(page, base, 8000);
  await sleep(1800); // スクロール復元のリトライを待つ
  const restored = await page.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    txt: document.getElementById('txt').value,
    area: document.getElementById('area').value,
    pw: document.getElementById('pw').value,
    chk: document.getElementById('chk').checked,
  }));
  check('リロードされた(復元テスト)', next !== null, `loads ${base} -> ${next}`);
  check('スクロール位置が戻る', Math.abs(restored.scrollY - 1500) < 40, `scrollY=${restored.scrollY}`);
  check('テキスト入力が戻る', restored.txt === 'すまーとりろーど', restored.txt);
  check('textarea が戻る', restored.area === '複数行\nのテキスト', JSON.stringify(restored.area));
  check('チェックボックスが戻る', restored.chk === true);
  check('パスワードは復元しない', restored.pw === '', JSON.stringify(restored.pw));

  // --- 4. 入力中はスキップする ----------------------------------------------
  await send({ type: 'stop' });
  await send({ type: 'start', profile: profile({ skip: { typing: true } }) });
  await page.evaluate(() => {
    const t = document.getElementById('txt');
    t.value = '入力途中';
    t.focus();
  });
  base = await loads(page);
  next = await waitForReload(page, base, 7000);
  check('入力中はリロードを見送る', next === null, next === null ? '' : `reloaded to ${next}`);
  status = await send({ type: 'getStatus' });
  check('見送り理由が typing になる', status && status.skipReason === 'typing', status && status.skipReason);

  // --- 5. 再生中はスキップする ----------------------------------------------
  await send({ type: 'stop' });
  await page.evaluate(() => { document.getElementById('txt').blur(); document.getElementById('txt').value = ''; });
  // 本当に再生する audio を置く。MAIN world で paused などを差し替えても
  // ISOLATED world の content script からは見えないので、実物で試す。
  const playing = await page.evaluate(async () => {
    const a = document.createElement('audio');
    a.src = '/tone.wav';
    a.loop = true;
    a.muted = false;
    document.body.append(a);
    try { await a.play(); } catch (e) { return 'play() rejected: ' + e.message; }
    await new Promise((r) => setTimeout(r, 600));
    return a.paused ? 'paused' : `playing t=${a.currentTime.toFixed(2)} rs=${a.readyState}`;
  });
  check('テスト用の音声が再生されている', playing.startsWith('playing'), playing);
  await send({ type: 'start', profile: profile({ skip: { media: true } }) });
  base = await loads(page);
  next = await waitForReload(page, base, 7000);
  status = await send({ type: 'getStatus' });
  check('再生中はリロードを見送る', next === null && status && status.skipReason === 'media',
    `reload=${next} reason=${status && status.skipReason}`);

  // --- 6. 変化検知 ----------------------------------------------------------
  await send({ type: 'stop' });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(400);
  await send({ type: 'start', profile: profile({ interval: 3, watch: { enabled: true, reloadOnlyOnChange: true } }) });
  await sleep(1000);
  base = await loads(page);
  next = await waitForReload(page, base, 8000);
  status = await send({ type: 'getStatus' });
  check('変化が無ければリロードしない', next === null && status && status.skipReason === 'unchanged',
    `reload=${next} reason=${status && status.skipReason}`);

  await fetch(`${BASE}set-marker?v=v2`);
  next = await waitForReload(page, base, 10000);
  const marker = next === null ? null : await page.evaluate(() => document.getElementById('marker').textContent);
  check('変化したらリロードする', next !== null && marker === 'v2', `loads=${next} marker=${marker}`);

  // --- 7. URL パターンのルールで自動 ON -------------------------------------
  await send({ type: 'stop' });
  await setStorage({
    rules: [{ id: 'test', pattern: 'http://localhost:8765/*', enabled: true, note: '', profile: profile({ interval: 3 }) }],
  });
  const page2 = await context.newPage();
  await page2.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(800);
  const status2 = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://localhost:8765/*' });
    const tab = tabs[tabs.length - 1];
    return chrome.tabs.sendMessage(tab.id, { type: 'getStatus' });
  });
  check('ルールに当たると自動で ON になる', !!status2 && status2.on === true && status2.source === 'rule',
    JSON.stringify(status2 && { on: status2.on, source: status2.source }));

  // --- 8. リロードを跨いでセッションが続く ----------------------------------
  const b2 = await loads(page2);
  const n2 = await waitForReload(page2, b2, 8000);
  const n3 = await waitForReload(page2, n2 || b2, 8000);
  check('リロード後も自動リロードが続く', n2 !== null && n3 !== null, `loads ${b2} -> ${n2} -> ${n3}`);

  await context.close();
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => { console.error(err); server.close(); process.exit(1); });

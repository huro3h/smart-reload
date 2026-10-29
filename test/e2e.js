const { chromium } = require('playwright');
const { launchBackground } = require('./background-browser.js');
const os = require('os'), path = require('path'), fs = require('fs');
const { server } = require('./fixture.js');

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
  // ブラウザは裏で起動し、作業中のアプリから前面を奪わない (background-browser.js を参照)。
  const browser = await launchBackground(chromium, {
    extension: EXT,
    userDataDir,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  // ページも裏の窓に1枚ずつ開く。内寸は Playwright の既定ビューポートと同じ 1280×720。
  const openPage = () => browser.openPage('about:blank', { width: 1280, height: 720 });

  const sw = await browser.serviceWorker();

  // service worker 経由で content script を操作する
  const send = (message) => sw.evaluate(async (msg) => {
    const tabs = await chrome.tabs.query({ url: 'http://localhost:8765/*' });
    if (!tabs.length) return { error: 'no tab' };
    return chrome.tabs.sendMessage(tabs[0].id, msg);
  }, message);

  const setStorage = (obj) => sw.evaluate((o) => chrome.storage.local.set(o), obj);

  /** ツールバーに実際に出ている値を service worker 側から読む */
  const badgeOf = () => sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://localhost:8765/*' });
    const tabId = tabs[0].id;
    return {
      text: await chrome.action.getBadgeText({ tabId }),
      title: await chrome.action.getTitle({ tabId }),
      color: (await chrome.action.getBadgeBackgroundColor({ tabId })).join(','),
    };
  });

  const profile = (over = {}) => ({
    interval: 3,
    retryDelay: 2,
    skip: { typing: false, selection: false, media: false, recentInput: false, idleSeconds: 5, ...(over.skip || {}) },
    restore: { scroll: true, form: true, ...(over.restore || {}) },
    watch: { enabled: false, selector: '', reloadOnlyOnChange: true, notify: false, ...(over.watch || {}) },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => !['skip', 'restore', 'watch'].includes(k))),
  });

  const page = await openPage();
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

  // --- 2b. バッジ表示 --------------------------------------------------------
  // 間隔 3 秒だと常にカウントダウン圏内なので、長めの間隔で `•` を確かめる
  // content script は state を投げっぱなしで応答を返すので、
  // service worker が塗り替えるのを少し待ってから読む
  const paintDelay = 400;

  await send({ type: 'stop' });
  await sleep(paintDelay);
  let badge = await badgeOf();
  check('OFF ならバッジは空', badge.text === '', JSON.stringify(badge.text));
  check('OFF ならタイトルが OFF', /OFF/.test(badge.title), badge.title);

  await send({ type: 'start', profile: profile({ interval: 600 }) });
  await sleep(paintDelay);
  badge = await badgeOf();
  check('ON のあいだバッジが出ている', badge.text === ' ', JSON.stringify(badge.text));
  check('ON ならタイトルに間隔が出る', /ON/.test(badge.title), badge.title);

  // 動作中は1秒ごとに背景色が変わる
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    seen.add((await badgeOf()).color);
    await sleep(1000);
  }
  check('動作中は背景色が1秒ごとに変わる', seen.size === 2, `${seen.size} 色: ${[...seen].join(' / ')}`);
  check('明滅は濃い色と淡い色の2色',
    [...seen].sort().join(' / ') === '138,180,248,255 / 26,115,232,255',
    [...seen].sort().join(' / '));

  // 見ていないタブでは明滅を止める(バッジは元々見えないし、毎秒メッセージを
  // 送り続けると service worker が寝られなくなるため)。
  //
  // Playwright は裏のタブも visible のままにするので、タブを切り替えても
  // 再現できない。content script と同じ ISOLATED world にコードを流し込んで
  // document.visibilityState を差し替え、実際のコードパスを通す。
  const setHidden = (hidden) => sw.evaluate(async (h) => {
    const tabs = await chrome.tabs.query({ url: 'http://localhost:8765/*' });
    await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: (value) => {
        Object.defineProperty(document, 'visibilityState', {
          get: () => (value ? 'hidden' : 'visible'),
          configurable: true,
        });
        document.dispatchEvent(new Event('visibilitychange'));
      },
      args: [h],
    });
  }, hidden);

  await setHidden(true);
  await sleep(1200);
  const hiddenColors = new Set();
  for (let i = 0; i < 3; i++) {
    hiddenColors.add((await badgeOf()).color);
    await sleep(1000);
  }
  check('裏に回ったタブでは明滅が止まる', hiddenColors.size === 1,
    `${hiddenColors.size} 色: ${[...hiddenColors].join(' / ')}`);
  check('止まった色は明滅の起点になる', [...hiddenColors][0] === '26,115,232,255',
    [...hiddenColors][0]);

  await setHidden(false);
  await sleep(600);

  // 残り 30 秒を切るとカウントダウンの数字になる(見送り中の表示は 4 で確かめる)
  await send({ type: 'stop' });
  await send({ type: 'start', profile: profile({ interval: 8 }) });
  await sleep(600);
  badge = await badgeOf();
  check('残り 30 秒以内はバッジが秒数になる', /^[0-9]+$/.test(badge.text), JSON.stringify(badge.text));

  // カウントダウンに入ったら数字を読ませたいので明滅を止める
  const countdownColors = new Set();
  for (let i = 0; i < 4; i++) {
    countdownColors.add((await badgeOf()).color);
    await sleep(1000);
  }
  check('カウントダウン中は明滅しない', countdownColors.size === 1,
    `${countdownColors.size} 色: ${[...countdownColors].join(' / ')}`);
  check('カウントダウン中は濃い方の色で止まる', [...countdownColors][0] === '26,115,232,255',
    [...countdownColors][0]);

  await send({ type: 'stop' });
  await sleep(paintDelay);
  badge = await badgeOf();
  check('OFF でバッジが消える', badge.text === '', JSON.stringify(badge.text));

  // 以降のテストは 3 秒間隔で動いている前提なので戻しておく
  await send({ type: 'start', profile: profile() });
  await sleep(200);

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
  badge = await badgeOf();
  check('見送り中もバッジは出たまま', badge.text === ' ', JSON.stringify(badge.text));
  check('見送り中はタイトルに理由が出る', /入力中/.test(badge.title), badge.title);

  // 見送り中は明滅させずグレーで止める
  const skipColors = new Set();
  for (let i = 0; i < 3; i++) {
    skipColors.add((await badgeOf()).color);
    await sleep(1000);
  }
  check('見送り中は色が変わらない', skipColors.size === 1, [...skipColors].join(' / '));
  check('見送り中はグレーになる', [...skipColors][0] === '154,160,166,255', [...skipColors][0]);

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
  const page2 = await openPage();
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

  // --- 9. 同じタブの中で別ページへ移ったら止める ----------------------------
  // YouTube の待機ページ → 配信中のページのように、文書を作り直さずに URL だけ
  // 差し替える動き。移った先でリロードを1回打ってしまわないかを見る。
  await send({ type: 'stop' });
  await setStorage({ rules: [] });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(500);
  await send({ type: 'start', profile: profile({ interval: 3 }) });
  await sleep(300);
  base = await loads(page);
  await page.evaluate(() => history.pushState({}, '', '/live'));
  next = await waitForReload(page, base, 7000);
  status = await send({ type: 'getStatus' });
  check('同じタブで別ページへ移ったらリロードしない', next === null,
    next === null ? '' : `reloaded to ${next}`);
  check('移ったら手動セッションが止まる', !!status && status.on === false,
    JSON.stringify(status && status.on));

  // ページ内リンク(ハッシュだけの変化)は「移った」に数えない
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await sleep(500);
  await send({ type: 'start', profile: profile({ interval: 3 }) });
  await sleep(300);
  base = await loads(page);
  await page.evaluate(() => { location.hash = 'section'; });
  next = await waitForReload(page, base, 8000);
  check('ハッシュだけの変化では止まらない', next !== null, `loads ${base} -> ${next}`);

  // ルール由来のセッションは、移った先の URL で引き直す
  await send({ type: 'stop' });
  await setStorage({
    rules: [{ id: 'wait', pattern: `${BASE}waiting`, enabled: true, note: '', profile: profile({ interval: 3 }) }],
  });
  await page.goto(`${BASE}waiting`, { waitUntil: 'domcontentloaded' });
  await sleep(900);
  status = await send({ type: 'getStatus' });
  check('待機ページのルールで自動 ON になる',
    !!status && status.on === true && status.source === 'rule',
    JSON.stringify(status && { on: status.on, source: status.source }));
  base = await loads(page);
  await page.evaluate(() => history.pushState({}, '', '/live'));
  next = await waitForReload(page, base, 7000);
  status = await send({ type: 'getStatus' });
  check('ルールに当たらないページへ移ったら止まる',
    next === null && !!status && status.on === false,
    `reload=${next} on=${status && status.on}`);

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => { console.error(err); server.close(); process.exit(1); });

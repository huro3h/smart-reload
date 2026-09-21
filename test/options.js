const { chromium } = require('playwright');
const os = require('os'), path = require('path'), fs = require('fs');

const BRAVE = '/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly';
const EXT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let fails = 0;
const check = (n, ok, d) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-opt-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: BRAVE, headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  sw.on('console', (m) => { if (m.type() === 'error') errors.push('[sw] ' + m.text()); });
  const id = new URL(sw.url()).host;

  const p = await context.newPage();
  p.on('console', (m) => { if (m.type() === 'error') errors.push('[options] ' + m.text()); });
  p.on('pageerror', (e) => errors.push('[options:throw] ' + e.message));
  await p.goto(`chrome-extension://${id}/src/options.html`);
  await sleep(500);

  const read = () => sw.evaluate(() => chrome.storage.local.get(['rules', 'defaults']));

  // ルールを追加してパターンを入れる
  await p.click('#addRule');
  await sleep(300);
  await p.fill('[data-role="pattern"]', 'https://example.org/*');
  await sleep(400);
  let store = await read();
  check('ルールが追加・保存される',
    store.rules && store.rules.length === 1 && store.rules[0].pattern === 'https://example.org/*',
    JSON.stringify(store.rules && store.rules.map((r) => r.pattern)));

  // ルールの中の設定を変える
  await p.click('.rule summary');
  await sleep(200);
  await p.fill('.rule [data-path="interval"]', '15');
  await p.dispatchEvent('.rule [data-path="interval"]', 'change');
  await sleep(400);
  store = await read();
  check('ルールごとの設定が保存される', store.rules[0].profile.interval === 15, String(store.rules[0].profile.interval));

  // 変化検知のトグルで追加オプションが開く
  const hiddenBefore = await p.locator('.rule .watch-options').evaluate((n) => n.classList.contains('hidden'));
  await p.check('.rule [data-path="watch.enabled"]');
  await sleep(300);
  const hiddenAfter = await p.locator('.rule .watch-options').evaluate((n) => n.classList.contains('hidden'));
  check('変化検知の追加オプションが開閉する', hiddenBefore === true && hiddenAfter === false,
    `before=${hiddenBefore} after=${hiddenAfter}`);

  // 2件目を足してドラッグで並べ替え
  await p.click('#addRule');
  await sleep(300);
  const patterns = p.locator('[data-role="pattern"]');
  await patterns.nth(1).fill('https://second.example/*');
  await sleep(400);

  // 2行目のハンドルを1行目の上へ運ぶ
  await p.dragAndDrop('.rule:nth-child(2) .drag-handle', '.rule:nth-child(1) .drag-handle');
  await sleep(500);
  store = await read();
  check('ドラッグで並べ替えできる', store.rules[0].pattern === 'https://second.example/*',
    JSON.stringify(store.rules.map((r) => r.pattern)));

  const domOrder = await p.locator('.rule [data-role="pattern"]').evaluateAll(
    (nodes) => nodes.map((n) => n.value));
  check('保存した順と画面の並びが一致する',
    domOrder.join(' | ') === store.rules.map((r) => r.pattern).join(' | '),
    JSON.stringify(domOrder));

  // 並べ替え直後の削除が、描画時の添字ではなく id で効くこと
  await p.locator('[data-role="remove"]').first().click();
  await sleep(400);
  store = await read();
  check('並べ替え後に消しても正しい行が消える',
    store.rules.length === 1 && store.rules[0].pattern === 'https://example.org/*',
    JSON.stringify(store.rules.map((r) => r.pattern)));

  // 消した分を戻しておく(以降のテストが2件前提のため)
  await p.click('#addRule');
  await sleep(300);
  await p.locator('[data-role="pattern"]').nth(1).fill('https://second.example/*');
  await sleep(400);

  // 既定の設定
  await p.fill('#defaultsHost [data-path="interval"]', '120');
  await p.dispatchEvent('#defaultsHost [data-path="interval"]', 'change');
  await sleep(400);
  store = await read();
  check('既定の設定が保存される', store.defaults.interval === 120, String(store.defaults.interval));

  // 削除
  const beforeRemove = (await read()).rules.length;
  await p.locator('[data-role="remove"]').first().click();
  await sleep(400);
  store = await read();
  check('ルールを削除できる', store.rules.length === beforeRemove - 1,
    JSON.stringify(store.rules.map((r) => r.pattern)));

  // リロードしても残る
  await p.reload();
  await sleep(600);
  const remaining = (await read()).rules.map((r) => r.pattern);
  const shown = await p.locator('.rule [data-role="pattern"]').evaluateAll(
    (nodes) => nodes.map((n) => n.value));
  check('再読み込みしても順番ごと残る', shown.join(' | ') === remaining.join(' | '),
    JSON.stringify(shown));

  await context.close();
  console.log('\nconsole errors:', errors.length ? '\n  ' + errors.join('\n  ') : 'none');
  process.exit(fails || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

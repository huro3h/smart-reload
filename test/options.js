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

  // 2件目を足して並べ替え
  await p.click('#addRule');
  await sleep(300);
  const patterns = p.locator('[data-role="pattern"]');
  await patterns.nth(1).fill('https://second.example/*');
  await sleep(400);
  await p.locator('[data-role="up"]').nth(1).click();
  await sleep(400);
  store = await read();
  check('並べ替えできる', store.rules[0].pattern === 'https://second.example/*',
    JSON.stringify(store.rules.map((r) => r.pattern)));

  // 既定の設定
  await p.fill('#defaultsHost [data-path="interval"]', '120');
  await p.dispatchEvent('#defaultsHost [data-path="interval"]', 'change');
  await sleep(400);
  store = await read();
  check('既定の設定が保存される', store.defaults.interval === 120, String(store.defaults.interval));

  // 削除
  await p.locator('[data-role="remove"]').first().click();
  await sleep(400);
  store = await read();
  check('ルールを削除できる', store.rules.length === 1, JSON.stringify(store.rules.map((r) => r.pattern)));

  // リロードしても残る
  await p.reload();
  await sleep(600);
  const shown = await p.locator('[data-role="pattern"]').first().inputValue();
  check('再読み込みしても残る', shown === 'https://example.org/*', shown);

  await context.close();
  console.log('\nconsole errors:', errors.length ? '\n  ' + errors.join('\n  ') : 'none');
  process.exit(fails || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

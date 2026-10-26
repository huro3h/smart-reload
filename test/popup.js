// ポップアップの「ルールとして保存」の挙動。
// 本物のツールバーのポップアップは Playwright から開けないので、popup.html を
// 普通のタブで開き、chrome.tabs だけスタブして「そのURLのタブで開いた」ことにする。
const { chromium } = require('playwright');
const { launchBackground } = require('./background-browser.js');
const os = require('os'), path = require('path'), fs = require('fs');

const EXT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-popup-'));
  // ブラウザは裏で起動し、作業中のアプリから前面を奪わない (background-browser.js を参照)。
  const browser = await launchBackground(chromium, { extension: EXT, userDataDir });
  // ページも裏の窓に1枚ずつ開く。内寸は Playwright の既定ビューポートと同じ 1280×720。
  const openPage = () => browser.openPage('about:blank', { width: 1280, height: 720 });
  const sw = await browser.serviceWorker();
  const id = new URL(sw.url()).host;

  const page = await openPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const readRules = () => sw.evaluate(async () => (await chrome.storage.local.get('rules')).rules || []);
  const setRules = (rules) => sw.evaluate((r) => chrome.storage.local.set({ rules: r }), rules);
  const patternsOf = (rules) => rules.map((r) => r.pattern);

  /** 指定 URL のタブでポップアップを開いた状態にする */
  async function openPopupFor(tabUrl, statusOverride = {}) {
    await page.addInitScript(([u, over]) => {
      const fakeTab = { id: 1, url: u, windowId: 1 };
      Object.defineProperty(chrome, 'tabs', {
        configurable: true,
        value: {
          query: async () => [fakeTab],
          sendMessage: async () => Object.assign({
            supported: true, on: false, source: null, profile: null, remaining: 0,
            skipReason: null, skipCount: 0, reloadCount: 0, watchErrors: 0, lastChangeAt: 0, url: u,
          }, over),
        },
      });
    }, [tabUrl, statusOverride]);
    await page.goto(`chrome-extension://${id}/src/popup.html`);
    await sleep(400);
  }

  const runningByRule = (interval) => ({
    on: true,
    source: 'rule',
    profile: {
      interval, retryDelay: 5,
      skip: { typing: true, selection: true, media: true, recentInput: true, idleSeconds: 5 },
      restore: { scroll: true, form: true },
      watch: { enabled: false, selector: '', reloadOnlyOnChange: true, notify: true },
    },
    remaining: 42,
  });

  async function saveRule(tabUrl, interval, { widen = false } = {}) {
    await openPopupFor(tabUrl);
    await page.fill('#interval', String(interval));
    await page.dispatchEvent('#interval', 'change');
    await sleep(200);
    await page.click('#saveRule');
    await sleep(250);
    if (widen) {
      await page.click('#widenPattern');
      await sleep(200);
    }
    const shown = await page.locator('#rulePattern').inputValue();
    const hint = (await page.locator('#patternHint').textContent()).trim();
    await page.click('#confirmSave');
    await sleep(350);
    return { shown, hint };
  }

  // --- 1. 既定はフルパス、同一ドメインの別ページは別ルールになる -------------
  await setRules([]);
  let r = await saveRule('https://example.com/news/1', 30);
  check('既定のパターンがフルパスになる', r.shown === 'https://example.com/news/1', r.shown);
  let rules = await readRules();
  check('1件目が追加される', rules.length === 1 && rules[0].profile.interval === 30,
    JSON.stringify(patternsOf(rules)));

  r = await saveRule('https://example.com/sports/2', 300);
  rules = await readRules();
  check('同一ドメインの別ページは別ルールとして追加される', rules.length === 2,
    JSON.stringify(patternsOf(rules)));
  const news = rules.find((x) => x.pattern === 'https://example.com/news/1');
  check('先に保存したページの設定が書き換わらない', news && news.profile.interval === 30,
    news ? String(news.profile.interval) : 'なし');

  // --- 2. クエリは残し、ハッシュは落とす -------------------------------------
  r = await saveRule('https://example.com/search?q=abc#frag', 45);
  check('クエリは残しハッシュは落とす', r.shown === 'https://example.com/search?q=abc', r.shown);

  // --- 3. サイト全体に広げられる ---------------------------------------------
  await setRules([]);
  r = await saveRule('https://example.com/news/1', 60, { widen: true });
  rules = await readRules();
  check('「このサイト全体にする」でワイルドカードになる',
    rules.length === 1 && rules[0].pattern === 'https://example.com/*',
    JSON.stringify(patternsOf(rules)));

  // --- 4. 広いルールが既にあるとき、新しい具体的なルールがその前に入る -------
  r = await saveRule('https://example.com/news/1', 15);
  rules = await readRules();
  check('先に当たるルールがあると警告が出る', /より前に入れます/.test(r.hint), r.hint);
  check('具体的なルールが広いルールより前に入る',
    patternsOf(rules).join(' | ') === 'https://example.com/news/1 | https://example.com/*',
    JSON.stringify(patternsOf(rules)));
  check('新しいルールが実際に当たる',
    (await page.evaluate((rs) => SR.findRule(rs, 'https://example.com/news/1').pattern, rules))
      === 'https://example.com/news/1');

  // --- 5. 同じパターンなら更新、増えない -------------------------------------
  const before = (await readRules()).length;
  r = await saveRule('https://example.com/news/1', 90);
  rules = await readRules();
  check('同じページをもう一度保存しても増えない', rules.length === before,
    `${before} -> ${rules.length}`);
  check('同じパターンなら設定が更新される',
    rules[0].profile.interval === 90, String(rules[0].profile.interval));
  check('更新時はヒントにそう出る', /書き換えます/.test(r.hint), r.hint);

  // --- 6. 広いルールがあっても初期値はフルパスのまま --------------------------
  await openPopupFor('https://example.com/sports/7');
  await page.click('#saveRule');
  await sleep(250);
  const prefilled = await page.locator('#rulePattern').inputValue();
  const hint6 = (await page.locator('#patternHint').textContent()).trim();
  check('広いルールに覆われていても初期値はフルパス',
    prefilled === 'https://example.com/sports/7', prefilled);
  check('覆っている既存ルールをヒントで知らせる', /より前に入れます/.test(hint6), hint6);

  // --- 7. ヘッダーに適用中のルール名が出る ------------------------------------
  await setRules([
    { id: 'h1', pattern: 'https://example.com/news/*', enabled: true, note: 'ニュース欄',
      profile: { interval: 30, retryDelay: 5,
        skip: { typing: true, selection: true, media: true, recentInput: true, idleSeconds: 5 },
        restore: { scroll: true, form: true },
        watch: { enabled: false, selector: '', reloadOnlyOnChange: true, notify: true } } },
  ]);
  await openPopupFor('https://example.com/news/5', runningByRule(30));
  let head = await page.locator('#heading').textContent();
  check('ルールで動作中はヘッダーにルール名が出る', head.trim() === 'ニュース欄', head);
  check('ヘッダーにパターンがツールチップで付く',
    (await page.locator('#heading').getAttribute('title')) === 'https://example.com/news/*');

  // メモが空ならパターンそのものを出す
  await setRules([
    { id: 'h2', pattern: 'https://example.com/news/*', enabled: true, note: '',
      profile: { interval: 30, retryDelay: 5,
        skip: { typing: true, selection: true, media: true, recentInput: true, idleSeconds: 5 },
        restore: { scroll: true, form: true },
        watch: { enabled: false, selector: '', reloadOnlyOnChange: true, notify: true } } },
  ]);
  await openPopupFor('https://example.com/news/5', runningByRule(30));
  head = await page.locator('#heading').textContent();
  check('メモが空ならパターンを出す', head.trim() === 'https://example.com/news/*', head);

  // ルールで動いていないときはホスト名
  await openPopupFor('https://example.com/news/5');
  head = await page.locator('#heading').textContent();
  const plain = await page.locator('#heading').evaluate((n) => n.classList.contains('plain'));
  check('ルールで動いていなければホスト名を出す', head.trim() === 'example.com' && plain,
    `${head} plain=${plain}`);

  await browser.close();
  console.log('\npage errors:', errors.length ? '\n  ' + errors.join('\n  ') : 'none');
  process.exit(fails || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';

/**
 * popup は content script に直接話しかける(service worker を経由しない)。
 * 開いている間だけ 500ms ごとに状態を取りに行く。
 */

const BINDINGS = [
  ['interval', 'interval', 'number'],
  ['idleSeconds', 'skip.idleSeconds', 'number'],
  ['skipTyping', 'skip.typing', 'bool'],
  ['skipSelection', 'skip.selection', 'bool'],
  ['skipMedia', 'skip.media', 'bool'],
  ['skipRecent', 'skip.recentInput', 'bool'],
  ['restoreScroll', 'restore.scroll', 'bool'],
  ['restoreForm', 'restore.form', 'bool'],
  ['watchEnabled', 'watch.enabled', 'bool'],
  ['watchSelector', 'watch.selector', 'text'],
  ['watchOnlyOnChange', 'watch.reloadOnlyOnChange', 'bool'],
  ['watchNotify', 'watch.notify', 'bool'],
];

const el = (id) => document.getElementById(id);

const ui = {
  tab: null,
  profile: null,
  status: null,
  /** 今のページに当たるルール(無ければ null)。ヘッダーの表示に使う */
  rule: null,
  poll: null,
  toastTimer: null,
};

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((acc, key) => acc[key], obj);
  target[last] = value;
}

function readForm() {
  const profile = SR.clone(ui.profile);
  for (const [id, path, kind] of BINDINGS) {
    const node = el(id);
    if (kind === 'bool') setPath(profile, path, node.checked);
    else if (kind === 'number') setPath(profile, path, Number(node.value));
    else setPath(profile, path, node.value);
  }
  return SR.normalizeProfile(profile);
}

function writeForm(profile) {
  for (const [id, path, kind] of BINDINGS) {
    const node = el(id);
    const value = getPath(profile, path);
    if (kind === 'bool') node.checked = !!value;
    else node.value = value;
  }
  el('watchOptions').classList.toggle('hidden', !profile.watch.enabled);
}

function toast(message) {
  el('toast').textContent = message;
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => { el('toast').textContent = ''; }, 2400);
}

// ---------------------------------------------------------------------------
// 状態の表示
// ---------------------------------------------------------------------------

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (err) {
    return '';
  }
}

/**
 * ヘッダーには「今このページを動かしているルールの名前」を出す。
 * 名前はルールのメモ。メモが空ならパターンそのものを出す。
 * ルールで動いていないときは、代わりにホスト名を控えめに出す。
 */
function renderHeading() {
  const node = el('heading');
  const status = ui.status;

  // chrome:// などではホスト名を出しても意味がないので製品名に戻す
  if (!ui.tab || !SR.isSupportedUrl(ui.tab.url)) {
    node.textContent = 'Smart Reload';
    node.title = '';
    node.classList.add('plain');
    return;
  }

  const byRule = status && status.on && status.source === 'rule' && ui.rule;
  if (byRule) {
    node.textContent = ui.rule.note || ui.rule.pattern;
    node.title = ui.rule.pattern;
    node.classList.remove('plain');
    return;
  }
  node.textContent = (ui.tab && hostOf(ui.tab.url)) || 'Smart Reload';
  node.title = (ui.tab && ui.tab.url) || '';
  node.classList.add('plain');
}

async function refreshRule() {
  ui.rule = ui.tab && SR.isSupportedUrl(ui.tab.url)
    ? SR.findRule(await SR.getRules(), ui.tab.url)
    : null;
}

function renderStatus() {
  const status = ui.status;
  const stateNode = el('state');
  const remainNode = el('remaining');
  const toggle = el('toggle');

  renderHeading();
  stateNode.classList.remove('on', 'skipping');

  if (!status || !status.supported) {
    remainNode.textContent = '';
    stateNode.textContent = 'このページでは使えません。';
    toggle.disabled = true;
    el('saveRule').disabled = true;
    return;
  }

  toggle.disabled = false;
  el('saveRule').disabled = false;

  if (!status.on) {
    remainNode.textContent = '';
    stateNode.innerHTML = '<strong>OFF</strong><span class="sub">このページは自動更新していません。</span>';
    toggle.textContent = 'ON にする';
    toggle.classList.remove('stop');
    return;
  }

  toggle.textContent = 'OFF にする';
  toggle.classList.add('stop');
  stateNode.classList.add('on');
  remainNode.textContent = SR.formatDuration(status.remaining);

  const origin = status.source === 'rule' ? 'ルールで自動 ON' : '手動で ON';
  const parts = [];
  if (status.skipReason) {
    stateNode.classList.add('skipping');
    const label = SR.SKIP_LABELS[status.skipReason] || '待機';
    const head = status.skipReason === 'unchanged'
      ? '<strong>変化なし</strong>'
      : `<strong>${label}のため見送り中</strong>`;
    parts.push(head);
  } else {
    // 残り時間はヘッダーに出ているので、ここでは繰り返さない
    parts.push('<strong>自動更新中</strong>');
  }

  const sub = [origin, `${SR.formatDuration(status.profile.interval)}ごと`];
  if (status.reloadCount) sub.push(`更新 ${status.reloadCount} 回`);
  if (status.skipCount) sub.push(`見送り ${status.skipCount} 回`);
  parts.push(`<span class="sub">${sub.join(' · ')}</span>`);

  if (status.watchErrors > 0) {
    parts.push('<span class="sub">ページを取得できないので、変化検知を使わずに更新しています。</span>');
  }

  stateNode.innerHTML = parts.join('');
}

// ---------------------------------------------------------------------------
// content script とのやりとり
// ---------------------------------------------------------------------------

async function askTab(message) {
  if (!ui.tab) return null;
  try {
    return await chrome.tabs.sendMessage(ui.tab.id, message);
  } catch (err) {
    return null;
  }
}

/** content script が入っていなければ流し込んでから聞き直す */
async function ensureContentScript() {
  let status = await askTab({ type: 'getStatus' });
  if (status) return status;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: ui.tab.id },
      files: ['src/shared.js', 'src/content.js'],
    });
  } catch (err) {
    return null;
  }
  status = await askTab({ type: 'getStatus' });
  return status;
}

async function refresh() {
  const status = await askTab({ type: 'getStatus' });
  if (!status) return;
  ui.status = status;
  renderStatus();
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

async function onToggle() {
  if (!ui.status) return;
  if (ui.status.on) {
    ui.status = await askTab({ type: 'stop' });
  } else {
    const profile = readForm();
    ui.profile = profile;
    await SR.setDefaults(profile);
    ui.status = await askTab({ type: 'start', profile });
  }
  renderStatus();
}

/**
 * 設定を触ったときの反映先:
 *   OFF のとき  → 次に ON にしたときの既定値として保存する
 *   ON のとき   → そのタブのセッションに即時反映する(手動セッション扱いになる)
 * ルールそのものは書き換えない。サイトに固定したいときは「ルールとして保存」を使う。
 */
async function onFormChange() {
  const profile = readForm();
  ui.profile = profile;
  el('watchOptions').classList.toggle('hidden', !profile.watch.enabled);

  if (ui.status && ui.status.on) {
    ui.status = await askTab({ type: 'start', profile });
    renderStatus();
  } else {
    await SR.setDefaults(profile);
  }
}

/** 既定はフルパス。ハッシュは落とし、クエリは残す(別のページとして扱うため) */
function fullPathPattern(urlString) {
  return SR.pageKey(urlString);
}

function sitePattern(urlString) {
  return `${new URL(urlString).origin}/*`;
}

/**
 * 保存パネルを開く。初期値は常にフルパス。
 *
 * 既に当たっているルールのパターンを初期値にすると、広いルール
 * (`https://example.com/*`) が1つあるだけで「このページだけ別設定にする」が
 * できなくなるので、そうしない。既存ルールとの関係はヒントで知らせる。
 */
async function openSavePanel() {
  if (!ui.tab || !SR.isSupportedUrl(ui.tab.url)) return;
  const panel = el('savePanel');
  if (!panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    return;
  }
  el('rulePattern').value = fullPathPattern(ui.tab.url);
  panel.classList.remove('hidden');
  await updateSaveHint();
  el('rulePattern').focus();
  el('rulePattern').select();
}

/** 保存前に「何が起きるか」を出す。押してから驚かないように */
async function updateSaveHint() {
  const pattern = el('rulePattern').value.trim();
  const hint = el('patternHint');
  const button = el('confirmSave');

  if (!pattern) {
    hint.textContent = 'パターンを入力してください。';
    button.disabled = true;
    return;
  }
  button.disabled = false;

  const rules = await SR.getRules();
  if (rules.some((rule) => rule.pattern === pattern)) {
    button.textContent = '更新';
    hint.textContent = '同じパターンのルールがあります。設定を書き換えます。';
    return;
  }

  button.textContent = '保存';
  if (!SR.matchesPattern(pattern, ui.tab.url)) {
    hint.textContent = 'このパターンは今のページに当たりません。';
    return;
  }
  const shadow = rules.find((rule) => rule.enabled && SR.matchesPattern(rule.pattern, ui.tab.url));
  hint.textContent = shadow
    ? `先に当たる ${shadow.pattern} より前に入れます。`
    : '新しいルールとして追加します。';
}

async function onConfirmSave() {
  const pattern = el('rulePattern').value.trim();
  if (!pattern || !ui.tab) return;
  const profile = readForm();
  const rules = await SR.getRules();
  const index = rules.findIndex((rule) => rule.pattern === pattern);

  if (index >= 0) {
    rules[index].profile = profile;
    rules[index].enabled = true;
    toast('ルールを更新しました');
  } else {
    // ルールは上から順で最初に当たった1件しか使われない。広いルールが先にあると
    // 後ろに足した具体的なルールは永久に発火しないので、その前に差し込む。
    let at = rules.length;
    if (SR.matchesPattern(pattern, ui.tab.url)) {
      const shadow = rules.findIndex((rule) => rule.enabled && SR.matchesPattern(rule.pattern, ui.tab.url));
      if (shadow >= 0) at = shadow;
    }
    // 名前は空のままにする。フルパス既定だと同じホストのルールが増えるので、
    // ホスト名を既定にすると全部同じ表示名になってしまう。空ならポップアップの
    // ヘッダーにはパターンがそのまま出るので、どのルールか取り違えない。
    rules.splice(at, 0, SR.normalizeRule({ pattern, profile }));
    toast('ルールを追加しました');
  }

  await SR.setRules(rules);
  await refreshRule();
  renderStatus();
  el('savePanel').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  ui.tab = tab;

  if (!tab || !SR.isSupportedUrl(tab.url)) {
    ui.status = { supported: false };
    ui.profile = await SR.getDefaults();
    writeForm(ui.profile);
    renderStatus();
    return;
  }

  await refreshRule();
  const status = await ensureContentScript();
  ui.status = status || { supported: false };
  // 動いているセッションがあればその設定を、無ければ既定値を出す
  ui.profile = status && status.on ? SR.normalizeProfile(status.profile) : await SR.getDefaults();
  writeForm(ui.profile);
  renderStatus();

  if (status) ui.poll = setInterval(refresh, 500);
}

for (const [id] of BINDINGS) {
  el(id).addEventListener('change', () => { void onFormChange(); });
}
el('toggle').addEventListener('click', () => { void onToggle(); });
el('saveRule').addEventListener('click', () => { void openSavePanel(); });
el('confirmSave').addEventListener('click', () => { void onConfirmSave(); });
el('rulePattern').addEventListener('input', () => { void updateSaveHint(); });
el('widenPattern').addEventListener('click', () => {
  if (!ui.tab) return;
  el('rulePattern').value = sitePattern(ui.tab.url);
  void updateSaveHint();
});
el('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
window.addEventListener('unload', () => clearInterval(ui.poll));

void init();

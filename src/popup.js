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

function renderStatus() {
  const status = ui.status;
  const stateNode = el('state');
  const remainNode = el('remaining');
  const toggle = el('toggle');

  stateNode.classList.remove('on', 'skipping');

  if (!status || !status.supported) {
    remainNode.textContent = '';
    stateNode.textContent = 'このページでは使えません。';
    toggle.disabled = true;
    return;
  }

  toggle.disabled = false;

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

async function onSaveRule() {
  if (!ui.tab || !SR.isSupportedUrl(ui.tab.url)) return;
  const url = new URL(ui.tab.url);
  const pattern = `${url.origin}/*`;
  const profile = readForm();
  const rules = await SR.getRules();
  const existing = rules.find((rule) => rule.pattern === pattern);
  if (existing) {
    existing.profile = profile;
    existing.enabled = true;
    toast(`${url.host} のルールを更新しました`);
  } else {
    rules.push(SR.normalizeRule({ pattern, profile, note: url.host }));
    toast(`${url.host} のルールを追加しました`);
  }
  await SR.setRules(rules);
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
el('saveRule').addEventListener('click', () => { void onSaveRule(); });
el('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
window.addEventListener('unload', () => clearInterval(ui.poll));

void init();

'use strict';

/**
 * service worker はタイマーを持たない。役割は3つだけ。
 *   - content script から届いた状態でアイコン・バッジ・タイトルを塗り替える
 *   - 変化を検知したときの通知を出す
 *   - ショートカットキーと、インストール直後の既存タブへの注入
 *
 * タイマーを持たないので、ここが寝ていてもリロードは止まらない。
 */
importScripts('shared.js');

/** setIcon の相対パスの解決先が紛らわしいので getURL で絶対 URL にしておく */
function iconSet(prefix) {
  const set = {};
  for (const size of [16, 32, 48, 128]) {
    set[size] = chrome.runtime.getURL(`icons/${prefix}${size}.png`);
  }
  return set;
}

const ICON_ON = iconSet('icon');
const ICON_OFF = iconSet('icon-off');

const BADGE_BACKGROUND = '#1A73E8';

// ---------------------------------------------------------------------------
// アイコンとバッジ
// ---------------------------------------------------------------------------

async function paintTab(tabId, on, badge, title) {
  try {
    await chrome.action.setIcon({ tabId, path: on ? ICON_ON : ICON_OFF });
    await chrome.action.setBadgeText({ tabId, text: badge || '' });
    if (badge) await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_BACKGROUND });
    await chrome.action.setTitle({ tabId, title: title || 'Smart Reload' });
  } catch (err) {
    // タブが閉じられた直後などは無視してよい
  }
}

// ---------------------------------------------------------------------------
// 通知
// ---------------------------------------------------------------------------

/** notificationId に tabId を埋めておき、クリックでそのタブへ飛ばす */
function notifyChange(tab, pageTitle) {
  if (!tab) return;
  const id = `smart-reload:change:${tab.windowId}:${tab.id}`;
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'ページが更新されました',
    message: pageTitle || tab.title || tab.url || '',
    contextMessage: tab.url,
  }, () => void chrome.runtime.lastError);
}

chrome.notifications.onClicked.addListener((notificationId) => {
  const match = /^smart-reload:change:(\d+):(\d+)$/.exec(notificationId);
  if (!match) return;
  const windowId = Number(match[1]);
  const tabId = Number(match[2]);
  chrome.windows.update(windowId, { focused: true }, () => void chrome.runtime.lastError);
  chrome.tabs.update(tabId, { active: true }, () => void chrome.runtime.lastError);
  chrome.notifications.clear(notificationId);
});

// ---------------------------------------------------------------------------
// content script からのメッセージ
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== 'string') return undefined;
  const tab = sender.tab;
  if (!tab || typeof tab.id !== 'number') return undefined;

  if (message.type === 'state') {
    void paintTab(tab.id, !!message.on, message.badge, message.title);
  } else if (message.type === 'notify') {
    notifyChange(tab, message.title);
  }
  return undefined;
});

// ---------------------------------------------------------------------------
// ショートカットキー
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-reload') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !SR.isSupportedUrl(tab.url)) return;
  const profile = await SR.getDefaults();
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle', profile });
  } catch (err) {
    // content script がまだ入っていないタブ。何もしない。
  }
});

// ---------------------------------------------------------------------------
// インストール・更新直後の既存タブ
// ---------------------------------------------------------------------------

/**
 * manifest で宣言した content script は、インストール時点で既に開いているタブには
 * 入らない。全部リロードしてもらう代わりにここで流し込む。
 */
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (!SR.isSupportedUrl(tab.url) || typeof tab.id !== 'number') continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/shared.js', 'src/content.js'],
      });
    } catch (err) {
      // 権限が無い・読み込み中などは諦める
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void injectIntoOpenTabs();
});

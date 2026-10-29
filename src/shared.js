'use strict';

/**
 * content script / popup / options / service worker が共有する定数とユーティリティ。
 *
 * content script は ES module にできないので、ここは module ではなくグローバル `SR` を
 * 置く形にしている。manifest の content_scripts.js にこのファイルを content.js より前に
 * 並べることで、同じスコープで読める。popup / options からは通常の <script src> で読む。
 */
/*
 * popup から content script を流し込み直すことがあり、そのとき宣言済みの
 * このファイルがもう一度走る可能性がある。`const SR = {}` だと
 * "Identifier 'SR' has already been declared" で注入ごと失敗するので、
 * 既にあるものを使い回す形にしてある。
 */
var SR = globalThis.SR || (globalThis.SR = {});

/** chrome.storage.local のキー */
SR.KEY_DEFAULTS = 'defaults';
SR.KEY_RULES = 'rules';

/** ページ側 sessionStorage のキー(タブ固有・タブを閉じれば消える) */
SR.SESSION_KEY = 'smart-reload:session';
SR.RESTORE_KEY = 'smart-reload:restore';

/**
 * 1セッション分の設定。popup で手動 ON するときも、ルールで自動 ON するときも
 * この形のオブジェクトを1つ渡す。
 */
SR.DEFAULT_PROFILE = {
  /** リロード間隔(秒) */
  interval: 60,
  /** スキップしたとき、次に再挑戦するまでの秒数 */
  retryDelay: 5,
  skip: {
    /** 入力欄を編集中 */
    typing: true,
    /** テキストを選択中 */
    selection: true,
    /** 動画・音声を再生中 */
    media: true,
    /** 直近に操作した */
    recentInput: true,
    /** 「直近」とみなす秒数 */
    idleSeconds: 5,
  },
  restore: {
    /** スクロール位置を復元する */
    scroll: true,
    /** フォームの入力内容を復元する(パスワード欄は対象外) */
    form: true,
  },
  watch: {
    /** 変化検知を使う */
    enabled: false,
    /** 監視する範囲の CSS セレクタ。空なら <body> 全体 */
    selector: '',
    /** 変化がないときはリロードしない */
    reloadOnlyOnChange: true,
    /** 変化を検知したら通知を出す */
    notify: true,
  },
};

SR.MIN_INTERVAL = 2;
SR.MAX_INTERVAL = 86400;

/** 復元データがこの秒数より古ければ捨てる(別の機会のリロードに巻き込まれないように) */
SR.RESTORE_TTL = 120;

/** バッジにカウントダウンを出し始める残り秒数 */
SR.COUNTDOWN_FROM = 30;

/**
 * ON のあいだバッジに出しておく文字。
 *
 * 空白にしてあるのは「文字を見せず、色の付いた丸だけを出す」ため。
 * `setBadgeText` に空文字を渡すとバッジ自体が消えてしまうので、色を見せるには
 * 何か文字が要る。丸が出ない環境に当たったら、ここを `'●'` に変えれば直る。
 */
SR.BADGE_ON = ' ';

/**
 * バッジの通常色(濃い方)。明滅させないときは常にこの色。
 * カウントダウン中は数字を読ませたいので、ここで止める。
 */
SR.BADGE_COLOR = '#1A73E8';

/** 明滅の淡い方。1秒ごとに BADGE_COLOR と入れ替える */
SR.BADGE_PULSE_COLOR = '#8AB4F8';

/** 見送り中の色。こちらは明滅させず、止まっていることを色で示す */
SR.BADGE_SKIP_COLOR = '#9AA0A6';

// ---------------------------------------------------------------------------
// オブジェクト操作
// ---------------------------------------------------------------------------

SR.clone = function (value) {
  return JSON.parse(JSON.stringify(value));
};

/**
 * base の構造を保ったまま override の値を重ねる。
 * base に無いキーは捨てる — 古いバージョンで保存された設定を読んでも
 * 知らないキーが混ざらないようにするため。
 */
SR.merge = function (base, override) {
  const out = SR.clone(base);
  if (!override || typeof override !== 'object') return out;
  for (const key of Object.keys(out)) {
    if (!(key in override)) continue;
    const a = out[key];
    const b = override[key];
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      out[key] = SR.merge(a, b);
    } else if (b !== undefined && b !== null) {
      out[key] = b;
    }
  }
  return out;
};

SR.normalizeProfile = function (profile) {
  const out = SR.merge(SR.DEFAULT_PROFILE, profile);
  out.interval = SR.clampInterval(out.interval);
  out.retryDelay = Math.min(Math.max(Number(out.retryDelay) || 5, 1), 60);
  out.skip.idleSeconds = Math.min(Math.max(Number(out.skip.idleSeconds) || 5, 1), 300);
  out.watch.selector = String(out.watch.selector || '').trim();
  return out;
};

SR.clampInterval = function (value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return SR.DEFAULT_PROFILE.interval;
  return Math.min(Math.max(n, SR.MIN_INTERVAL), SR.MAX_INTERVAL);
};

// ---------------------------------------------------------------------------
// ストレージ
// ---------------------------------------------------------------------------

SR.getDefaults = async function () {
  const stored = await chrome.storage.local.get(SR.KEY_DEFAULTS);
  return SR.normalizeProfile(stored[SR.KEY_DEFAULTS]);
};

SR.setDefaults = async function (profile) {
  await chrome.storage.local.set({ [SR.KEY_DEFAULTS]: SR.normalizeProfile(profile) });
};

SR.getRules = async function () {
  const stored = await chrome.storage.local.get(SR.KEY_RULES);
  const rules = Array.isArray(stored[SR.KEY_RULES]) ? stored[SR.KEY_RULES] : [];
  return rules.map(SR.normalizeRule);
};

SR.setRules = async function (rules) {
  await chrome.storage.local.set({ [SR.KEY_RULES]: rules.map(SR.normalizeRule) });
};

SR.normalizeRule = function (rule) {
  return {
    id: rule && rule.id ? String(rule.id) : SR.newId(),
    pattern: String((rule && rule.pattern) || '').trim(),
    enabled: !(rule && rule.enabled === false),
    note: String((rule && rule.note) || '').trim(),
    profile: SR.normalizeProfile(rule && rule.profile),
  };
};

SR.newId = function () {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
};

// ---------------------------------------------------------------------------
// URL パターン
// ---------------------------------------------------------------------------

/**
 * ワイルドカード(`*`)だけのパターンマッチ。正規表現は受け付けない。
 *
 * `://` を含まないパターンは部分一致として扱う(`example.com/news` と書けば
 * `https://example.com/news/123` にも当たる)。スキームから書きたい場合は
 * `https://example.com/*` のように明示する。
 */
SR.matchesPattern = function (pattern, url) {
  const raw = String(pattern || '').trim();
  if (!raw || !url) return false;
  const body = raw.includes('://') ? raw : `*${raw}*`;
  const source = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  let re;
  try {
    re = new RegExp(`^${source}$`, 'i');
  } catch (err) {
    return false;
  }
  return re.test(url);
};

/**
 * 同じページとみなす単位。ハッシュは落とし、クエリは残す。
 *
 * ハッシュは同じ文書の中の移動でしかなく、取り直す HTML にも影響しない。
 * ページ内リンクを踏んだだけで「別のページへ移った」と扱いたくないので切り落とす。
 * 「ルールとして保存」が作る既定のパターンもこの形。
 */
SR.pageKey = function (urlString) {
  try {
    const url = new URL(urlString);
    return url.origin + url.pathname + url.search;
  } catch (err) {
    return String(urlString || '');
  }
};

/** url に当たる最初の有効なルールを返す。無ければ null */
SR.findRule = function (rules, url) {
  for (const rule of rules) {
    if (rule.enabled && SR.matchesPattern(rule.pattern, url)) return rule;
  }
  return null;
};

/** 拡張が動ける URL か(chrome:// や Web Store では content script が入らない) */
SR.isSupportedUrl = function (url) {
  if (!url) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  return !/^https:\/\/chromewebstore\.google\.com\//i.test(url) &&
    !/^https:\/\/chrome\.google\.com\/webstore\//i.test(url);
};

// ---------------------------------------------------------------------------
// テキストの指紋
// ---------------------------------------------------------------------------

SR.normalizeText = function (text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
};

/**
 * FNV-1a を係数違いで2本回して 64bit 相当の 16 進文字列にする。
 *
 * crypto.subtle は secure context でないと使えず、http:// のページでは
 * undefined になる。変化検知は http のページでも動かしたいので自前で持つ。
 */
SR.hashText = function (text) {
  const s = String(text || '');
  let h1 = 0x811c9dc5;
  let h2 = 0xc2b2ae35;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  const a = (h1 >>> 0).toString(16).padStart(8, '0');
  const b = (h2 >>> 0).toString(16).padStart(8, '0');
  return a + b;
};

// ---------------------------------------------------------------------------
// 表示用
// ---------------------------------------------------------------------------

SR.formatDuration = function (seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m}分${rest}秒` : `${m}分`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}時間${mm}分` : `${h}時間`;
};

SR.SKIP_LABELS = {
  typing: '入力中',
  selection: 'テキスト選択中',
  media: '再生中',
  recentInput: '操作中',
  unchanged: '変化なし',
};

if (typeof module !== 'undefined' && module.exports) module.exports = SR;

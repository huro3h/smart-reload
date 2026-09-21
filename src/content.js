'use strict';

/**
 * リロードのタイマーはここ(content script)が持つ。
 *
 * service worker 側に setInterval を置くと MV3 では 30 秒で止められるので、
 * 本家 Easy Auto Refresh はタブに keepAlive ポートを注入して延命している。
 * この拡張はそのハックを使わない。スキップ判定・スクロール復元・変化検知は
 * どれもページの中の情報が要るので、タイマーも同じ場所にある方が素直で、
 * service worker が寝ていても動く。
 *
 * 代わりにページのタイマーはバックグラウンドタブで絞られるが、リロードのたびに
 * 新しいドキュメントになって猶予がリセットされるため、5分未満の間隔なら影響を受けない。
 * 詳細は SKILL.md の「バックグラウンドタブのタイマー」を参照。
 */
(() => {
  if (window.__smartReloadLoaded) return;
  window.__smartReloadLoaded = true;

  const state = {
    /** {profile, source} | null */
    session: null,
    /** セッションを張っているページ(ハッシュを除いた URL)。同じタブの中での移動を見るのに使う */
    url: '',
    /** 次に発火する時刻(epoch ms) */
    deadline: 0,
    timer: null,
    busy: false,
    /** 直近でスキップした理由。null なら通常のカウントダウン中 */
    skipReason: null,
    skipCount: 0,
    lastInteraction: 0,
    /** 変化検知の基準ハッシュ */
    baseline: null,
    /** 変化検知の取得に連続で失敗した回数 */
    watchErrors: 0,
    reloadCount: 0,
    lastChangeAt: 0,
    lastBadge: null,
    lastColor: null,
    lastTitle: null,
  };

  // -------------------------------------------------------------------------
  // 操作の検知
  // -------------------------------------------------------------------------

  const bumpInteraction = () => {
    state.lastInteraction = Date.now();
  };

  // scroll は自前の復元でも発火してしまうので入れない。wheel / touch で拾う。
  for (const type of ['keydown', 'pointerdown', 'mousedown', 'wheel', 'touchstart', 'input']) {
    document.addEventListener(type, bumpInteraction, { capture: true, passive: true });
  }

  /** トップと、覗ける同一オリジン iframe の document を列挙する */
  function eachDocument() {
    const docs = [document];
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        if (frame.contentDocument) docs.push(frame.contentDocument);
      } catch (err) {
        // クロスオリジンの iframe は覗けない。無視する。
      }
    }
    return docs;
  }

  function isEditing() {
    const el = document.activeElement;
    if (!el || el === document.body) return false;
    if (el.isContentEditable) return SR.normalizeText(el.textContent) !== '';
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return el.value !== '';
    if (tag !== 'INPUT') return false;
    const type = (el.type || 'text').toLowerCase();
    if (['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes(type)) {
      return false;
    }
    return el.value !== '';
  }

  function hasSelection() {
    for (const doc of eachDocument()) {
      const sel = doc.getSelection && doc.getSelection();
      if (sel && !sel.isCollapsed && SR.normalizeText(sel.toString()) !== '') return true;
    }
    return false;
  }

  /**
   * 再生中の動画・音声があるか。
   * ミュートされているものは対象外 — 記事の頭で自動再生される装飾用の動画まで
   * 拾うと、ほぼ全てのニュースサイトでリロードが止まらなくなるため。
   */
  function isPlayingMedia() {
    for (const doc of eachDocument()) {
      for (const media of doc.querySelectorAll('video, audio')) {
        if (media.paused || media.ended || media.muted) continue;
        if (media.readyState < 2 || media.currentTime <= 0) continue;
        return true;
      }
    }
    return false;
  }

  function detectSkipReason() {
    const skip = state.session.profile.skip;
    if (skip.typing && isEditing()) return 'typing';
    if (skip.selection && hasSelection()) return 'selection';
    if (skip.media && isPlayingMedia()) return 'media';
    if (skip.recentInput && Date.now() - state.lastInteraction < skip.idleSeconds * 1000) {
      return 'recentInput';
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // スクロール位置とフォームの保存・復元
  // -------------------------------------------------------------------------

  /** 値を持ち出したくない入力欄。パスワードは絶対に保存しない。 */
  const UNSAVED_TYPES = new Set(['password', 'hidden', 'file', 'submit', 'reset', 'button', 'image']);

  function formFields() {
    return Array.from(document.querySelectorAll('input, textarea, select'));
  }

  /**
   * リロードを跨いで同じ入力欄を指すためのキー。
   * id → name(+フォームの位置) → 出現順 の優先度で、安定するものから使う。
   */
  function fieldKey(el, index) {
    if (el.id) return `id:${el.id}`;
    if (el.name) {
      const formIndex = el.form ? Array.from(document.forms).indexOf(el.form) : -1;
      return `name:${formIndex}:${el.name}`;
    }
    return `idx:${index}`;
  }

  function captureFields() {
    const out = [];
    formFields().forEach((el, index) => {
      if (el.disabled) return;
      const type = (el.type || '').toLowerCase();
      if (UNSAVED_TYPES.has(type)) return;
      if (type === 'checkbox' || type === 'radio') {
        if (el.checked === el.defaultChecked) return;
        out.push({ key: fieldKey(el, index), checked: el.checked });
        return;
      }
      if (el.value === '' || el.value === el.defaultValue) return;
      out.push({ key: fieldKey(el, index), value: el.value });
    });
    return out;
  }

  function captureRestore() {
    const restore = state.session.profile.restore;
    if (!restore.scroll && !restore.form) return;
    const data = { ts: Date.now(), url: location.href };
    if (restore.scroll) data.scroll = { x: window.scrollX, y: window.scrollY };
    if (restore.form) data.fields = captureFields();
    try {
      sessionStorage.setItem(SR.RESTORE_KEY, JSON.stringify(data));
    } catch (err) {
      // sessionStorage が使えない(容量超過など)場合は復元を諦める
    }
  }

  /**
   * React などの制御コンポーネントは value を instance 側で上書きしているので、
   * prototype の setter を直接呼ばないと変更に気づかせられない。
   */
  function setFieldValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function restoreFields(fields) {
    const wanted = new Map(fields.map((f) => [f.key, f]));
    formFields().forEach((el, index) => {
      const field = wanted.get(fieldKey(el, index));
      if (!field) return;
      if ('checked' in field) el.checked = field.checked;
      else setFieldValue(el, field.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  /**
   * 遅延読み込みでページが伸びると1回では戻りきらないので、少し間を置いて数回試す。
   *
   * ただし再試行の間にユーザーが操作したり、ページ自身がどこかへスクロールしたら
   * そこで降りる。自分が最後に置いた位置から動いていれば他の誰かが動かしたという
   * ことなので、それを上書きしない — さもないとリロード直後の1.5秒間、
   * スクロールしても引き戻される。
   */
  function restoreScroll(pos) {
    const startedAt = Date.now();
    let applied = null;
    const apply = () => {
      if (state.lastInteraction > startedAt) return;
      if (applied !== null && Math.round(window.scrollY) !== applied) return;
      window.scrollTo(pos.x, pos.y);
      applied = Math.round(window.scrollY);
    };
    apply();
    for (const delay of [100, 300, 700, 1500]) setTimeout(apply, delay);
  }

  function applyRestore() {
    let data;
    try {
      const raw = sessionStorage.getItem(SR.RESTORE_KEY);
      if (!raw) return;
      sessionStorage.removeItem(SR.RESTORE_KEY);
      data = JSON.parse(raw);
    } catch (err) {
      return;
    }
    if (!data || data.url !== location.href) return;
    if (Date.now() - data.ts > SR.RESTORE_TTL * 1000) return;
    if (Array.isArray(data.fields) && data.fields.length) restoreFields(data.fields);
    if (data.scroll) restoreScroll(data.scroll);
  }

  // -------------------------------------------------------------------------
  // 変化検知
  // -------------------------------------------------------------------------

  /**
   * 表示中の DOM ではなく、取得し直した HTML 同士を比べる。
   * 表示中の DOM はページの JS に書き換えられていて、取ってきた HTML とは
   * 別物になっていることが多いため。
   */
  async function fetchSignature() {
    try {
      const res = await fetch(location.href, {
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'follow',
      });
      if (!res.ok) return null;
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const selector = state.session.profile.watch.selector;
      const node = selector ? doc.querySelector(selector) : doc.body;
      if (!node) return null;
      return SR.hashText(SR.normalizeText(node.textContent));
    } catch (err) {
      return null;
    }
  }

  async function primeBaseline() {
    const sig = await fetchSignature();
    if (state.session) state.baseline = sig;
  }

  /** 'changed' | 'same' | 'error' */
  async function checkChanged() {
    const sig = await fetchSignature();
    if (sig === null) {
      state.watchErrors += 1;
      return 'error';
    }
    state.watchErrors = 0;
    if (state.baseline === null) {
      state.baseline = sig;
      return 'same';
    }
    if (sig === state.baseline) return 'same';
    state.baseline = sig;
    return 'changed';
  }

  // -------------------------------------------------------------------------
  // セッション
  // -------------------------------------------------------------------------

  function persistSession() {
    if (!state.session) return;
    try {
      sessionStorage.setItem(SR.SESSION_KEY, JSON.stringify({
        profile: state.session.profile,
        source: state.session.source,
        url: location.href,
      }));
    } catch (err) {
      // 保存できなくても今のタブでは動き続ける。リロードを跨げないだけ。
    }
  }

  function clearPersistedSession() {
    try {
      sessionStorage.removeItem(SR.SESSION_KEY);
    } catch (err) {
      // 握りつぶす
    }
  }

  function readPersistedSession() {
    try {
      const raw = sessionStorage.getItem(SR.SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function startTimer() {
    if (state.timer !== null) return;
    state.timer = setInterval(tick, 1000);
  }

  function stopTimer() {
    if (state.timer === null) return;
    clearInterval(state.timer);
    state.timer = null;
  }

  function startSession(profile, source) {
    state.session = { profile: SR.normalizeProfile(profile), source };
    state.url = SR.pageKey(location.href);
    state.skipReason = null;
    state.skipCount = 0;
    state.baseline = null;
    state.watchErrors = 0;
    state.deadline = Date.now() + state.session.profile.interval * 1000;
    persistSession();
    if (state.session.profile.watch.enabled) void primeBaseline();
    startTimer();
    pushState(true);
  }

  function stopSession() {
    state.session = null;
    state.skipReason = null;
    state.busy = false;
    stopTimer();
    clearPersistedSession();
    pushState(true);
  }

  // -------------------------------------------------------------------------
  // 同じタブの中での移動
  // -------------------------------------------------------------------------

  /**
   * YouTube のような SPA は、配信の待機ページから配信中のページへ
   * **文書を作り直さずに URL だけ差し替える**。content script は生き残るので、
   * 素朴に書くと移った先で 1 回だけリロードが走る — そこで初めて
   * 「保存したセッションの URL と違う」と気づいて止まる、という壊れ方をする。
   *
   * 見張る場所は tick の中。リロードが起きうるのも tick なので、毎秒の突き合わせで
   * 必ず先回りできる。ページ自身の pushState は popstate では拾えず、
   * Navigation API が ISOLATED world から見える保証もないので、素朴に比べている。
   *
   * 比べるのは SR.pageKey (ハッシュを落とした URL)。ページ内リンクを踏んだだけで
   * 止まっては困るため。
   */
  function navigated() {
    return SR.pageKey(location.href) !== state.url;
  }

  /**
   * 移った先での振る舞いはセッションの出どころで変える。
   *
   * - `manual` … そのページに対する指示だったので降ろす
   * - `rule`   … 新しい URL でルールを引き直す。当たらなければそのまま止まる
   */
  async function handleNavigation() {
    const source = state.session ? state.session.source : null;
    stopSession();
    state.url = SR.pageKey(location.href);
    if (source === 'rule') await applyRules();
  }

  function defer(reason, seconds) {
    state.skipReason = reason;
    state.skipCount += 1;
    state.deadline = Date.now() + seconds * 1000;
    pushState(true);
  }

  function doReload() {
    captureRestore();
    persistSession();
    state.reloadCount += 1;
    location.reload();
  }

  async function fire() {
    if (state.busy || !state.session) return;
    state.busy = true;
    try {
      const profile = state.session.profile;
      const skipReason = detectSkipReason();
      if (skipReason) {
        defer(skipReason, Math.min(profile.retryDelay, profile.interval));
        return;
      }
      if (profile.watch.enabled) {
        const result = await checkChanged();
        if (!state.session) return;
        if (result === 'changed') {
          state.lastChangeAt = Date.now();
          if (profile.watch.notify) {
            send({ type: 'notify', url: location.href, title: document.title });
          }
        } else if (result === 'same' && profile.watch.reloadOnlyOnChange) {
          // 変化していないので今回は読み込み直さない。次は通常の間隔まで待つ。
          defer('unchanged', profile.interval);
          return;
        }
      }
      // 変化検知の fetch を待っている間に移っているかもしれない
      if (navigated()) {
        void handleNavigation();
        return;
      }
      state.skipReason = null;
      doReload();
    } finally {
      state.busy = false;
    }
  }

  function tick() {
    if (!state.session) {
      stopTimer();
      return;
    }
    // 発火より先に見る。ここで捕まえれば、移った先でリロードが走ることはない。
    if (navigated()) {
      void handleNavigation();
      return;
    }
    if (Date.now() >= state.deadline) {
      void fire();
      return;
    }
    pushState(false);
  }

  // -------------------------------------------------------------------------
  // service worker への通知(アイコン・バッジ・タイトル)
  // -------------------------------------------------------------------------

  function send(message) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        teardown();
        return;
      }
      const result = chrome.runtime.sendMessage(message);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (err) {
      // 拡張が再読み込みされると古い content script は孤児になる
      teardown();
    }
  }

  function teardown() {
    stopTimer();
    state.session = null;
  }

  function remainingSeconds() {
    if (!state.session) return 0;
    return Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
  }

  /**
   * タイトルにはあえて秒数を入れない。毎秒送ると service worker を起こし続けることになる。
   * 残り COUNTDOWN_FROM 秒を切ってからバッジの数字が変わるときだけ送る。
   */
  function buildTitle() {
    if (!state.session) return 'Smart Reload — OFF';
    const profile = state.session.profile;
    if (state.skipReason) {
      return `Smart Reload — ${SR.SKIP_LABELS[state.skipReason] || '待機'}のため見送り中`;
    }
    return `Smart Reload — ON (${SR.formatDuration(profile.interval)}ごと)`;
  }

  /**
   * ON のあいだはバッジを出しっぱなしにする。カウントダウンに入るまでは
   * 文字を見せない空白で、色だけで動作中を示す。
   * 見送り中も同じ文字のまま — 区別は色でつけ、理由はツールチップに出す。
   */
  function badgeText(remain) {
    if (!state.session) return '';
    if (!state.skipReason && remain <= SR.COUNTDOWN_FROM) return String(remain);
    return SR.BADGE_ON;
  }

  /**
   * 動作中は濃い色と淡い色を1秒ごとに入れ替えて明滅させる。
   *
   * 止めるのは次の3つのとき。
   *   - 見送り中     … グレーで固定し、待っていることを色で示す
   *   - カウントダウン中 … 数字が出ているので、明滅させると読みにくい
   *   - 裏に回っているとき … 裏タブのバッジは描画されないので動かしても誰も見ない。
   *                        毎秒メッセージを送ると service worker が寝られなくなる
   */
  function badgeColor(remain) {
    if (!state.session) return null;
    if (state.skipReason) return SR.BADGE_SKIP_COLOR;
    if (remain <= SR.COUNTDOWN_FROM) return SR.BADGE_COLOR;
    if (document.visibilityState !== 'visible') return SR.BADGE_COLOR;
    const odd = Math.floor(Date.now() / 1000) % 2 === 1;
    return odd ? SR.BADGE_PULSE_COLOR : SR.BADGE_COLOR;
  }

  function pushState(force) {
    const remain = remainingSeconds();
    const badge = badgeText(remain);
    const color = badgeColor(remain);
    const title = buildTitle();
    if (!force && badge === state.lastBadge && color === state.lastColor && title === state.lastTitle) {
      return;
    }
    state.lastBadge = badge;
    state.lastColor = color;
    state.lastTitle = title;
    send({ type: 'state', on: !!state.session, badge, color, title });
  }

  // -------------------------------------------------------------------------
  // popup / options とのやりとり
  // -------------------------------------------------------------------------

  function statusPayload() {
    return {
      supported: true,
      on: !!state.session,
      source: state.session ? state.session.source : null,
      profile: state.session ? state.session.profile : null,
      remaining: remainingSeconds(),
      skipReason: state.skipReason,
      skipCount: state.skipCount,
      reloadCount: state.reloadCount,
      watchErrors: state.watchErrors,
      lastChangeAt: state.lastChangeAt,
      url: location.href,
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return undefined;
    switch (message.type) {
      case 'getStatus':
        sendResponse(statusPayload());
        return undefined;
      case 'start':
        startSession(message.profile, 'manual');
        sendResponse(statusPayload());
        return undefined;
      case 'stop':
        stopSession();
        sendResponse(statusPayload());
        return undefined;
      case 'toggle':
        if (state.session) stopSession();
        else startSession(message.profile, 'manual');
        sendResponse(statusPayload());
        return undefined;
      case 'reloadNow':
        if (state.session) doReload();
        else location.reload();
        sendResponse(statusPayload());
        return undefined;
      default:
        return undefined;
    }
  });

  // 別のタブに移ったら明滅を止め、戻ってきたら再開する
  document.addEventListener('visibilitychange', () => {
    if (state.session) pushState(false);
  });

  // ルールを編集したら、開きっぱなしのタブにもすぐ反映する
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SR.KEY_RULES]) return;
    if (state.session && state.session.source === 'manual') return;
    void applyRules();
  });

  async function applyRules() {
    const rule = SR.findRule(await SR.getRules(), location.href);
    if (rule) {
      startSession(rule.profile, 'rule');
    } else if (state.session && state.session.source === 'rule') {
      stopSession();
    }
  }

  // -------------------------------------------------------------------------
  // 起動
  // -------------------------------------------------------------------------

  async function init() {
    applyRestore();

    // 手動セッションだけ sessionStorage から引き継ぐ。ルール由来のものは
    // 保存値ではなく今のルールを正とするので、毎回引き直す。
    const saved = readPersistedSession();
    if (saved && saved.url === location.href && saved.source === 'manual') {
      startSession(saved.profile, 'manual');
      return;
    }
    // 同じオリジンの別ページに移動した場合も引き継がない
    clearPersistedSession();
    await applyRules();
    if (!state.session) pushState(true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { void init(); }, { once: true });
  } else {
    void init();
  }
})();

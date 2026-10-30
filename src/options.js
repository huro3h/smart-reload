'use strict';

/**
 * 設定画面。既定の設定と、URL パターンごとのルールを編集する。
 * 保存は即時。ルールを保存すると、開いているタブの content script が
 * chrome.storage.onChanged で気づいて自動 ON / OFF を付け直す。
 */

const el = (id) => document.getElementById(id);

let rules = [];
let defaults = null;
let toastTimer = null;

function toast(message) {
  const node = el('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 1800);
}

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((acc, key) => acc[key], obj);
  target[last] = value;
}

// ---------------------------------------------------------------------------
// 設定フォーム(既定の設定とルールで共用)
// ---------------------------------------------------------------------------

/**
 * テンプレートから設定フォームを1つ作り、host に差し込む。
 * 値が変わるたびに onChange(profile) を呼ぶ。
 */
function mountProfileForm(host, profile, onChange) {
  const node = el('profileTemplate').content.firstElementChild.cloneNode(true);
  const inputs = Array.from(node.querySelectorAll('[data-path]'));
  const watchOptions = node.querySelector('.watch-options');

  const read = () => {
    const next = SR.clone(profile);
    for (const input of inputs) {
      const path = input.dataset.path;
      if (input.type === 'checkbox') setPath(next, path, input.checked);
      else if (input.type === 'number') setPath(next, path, Number(input.value));
      else setPath(next, path, input.value);
    }
    return SR.normalizeProfile(next);
  };

  const syncVisibility = () => {
    const enabled = node.querySelector('[data-path="watch.enabled"]').checked;
    watchOptions.classList.toggle('hidden', !enabled);
  };

  for (const input of inputs) {
    const value = getPath(profile, input.dataset.path);
    if (input.type === 'checkbox') input.checked = !!value;
    else input.value = value;
    input.addEventListener('change', () => {
      syncVisibility();
      onChange(read());
    });
  }

  syncVisibility();
  host.replaceChildren(node);
}

// ---------------------------------------------------------------------------
// ルール一覧
// ---------------------------------------------------------------------------

function renderRules() {
  const host = el('rules');
  host.replaceChildren();
  el('empty').classList.toggle('hidden', rules.length > 0);

  rules.forEach((rule) => {
    const node = el('ruleTemplate').content.firstElementChild.cloneNode(true);
    const pattern = node.querySelector('[data-role="pattern"]');
    const note = node.querySelector('[data-role="note"]');
    const enabled = node.querySelector('[data-role="enabled"]');

    // 並べ替え後に DOM の並びから配列を組み直すので、行に id を持たせておく
    node.dataset.id = rule.id;
    pattern.value = rule.pattern;
    note.value = rule.note;
    enabled.checked = rule.enabled;
    node.classList.toggle('invalid', rule.pattern === '');

    pattern.addEventListener('input', () => {
      rule.pattern = pattern.value.trim();
      node.classList.toggle('invalid', rule.pattern === '');
      void save();
    });
    note.addEventListener('input', () => {
      rule.note = note.value;
      void save();
    });
    enabled.addEventListener('change', () => {
      rule.enabled = enabled.checked;
      void save();
    });
    node.querySelector('[data-role="remove"]').addEventListener('click', () => void remove(rule.id));

    mountProfileForm(node.querySelector('[data-role="profileHost"]'), rule.profile, (next) => {
      rule.profile = next;
      void save();
    });

    host.append(node);
  });
}

async function save() {
  await SR.setRules(rules);
  toast('保存しました');
}

/**
 * ドラッグ後の DOM の並びを rules に反映して保存する。
 *
 * ここで renderRules() は呼ばない。DOM は既に正しい順に並んでいるし、
 * 描画し直すと開いていた <details> が閉じてしまう。
 */
async function persistOrder() {
  const order = [...el('rules').querySelectorAll('.rule')].map((node) => node.dataset.id);
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const reordered = order.map((id) => byId.get(id)).filter(Boolean);
  if (reordered.length !== rules.length) return;   // 取りこぼしたら触らない
  rules = reordered;
  await save();
}

/**
 * カーソルの位置に落としたとき、ドラッグしている行が手前に入る行。null なら末尾。
 * ドラッグしている行も候補に含める — 元の位置に戻したとき、線がその行の上下どちらかの端に出るように。
 */
function rowAfter(container, y) {
  const rows = [...container.querySelectorAll('.rule')];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: row };
  }
  return closest.element;
}

/**
 * 落としたときに入る位置を示す線を after の手前(null なら末尾)に引く。
 * カードの間には余白があるので、線はその余白の真ん中に置く。
 */
function showDropLine(container, line, after) {
  const rows = [...container.querySelectorAll('.rule')];
  if (rows.length === 0) return;
  const halfGap = parseFloat(getComputedStyle(rows[0]).marginBottom) / 2 || 0;
  const bottomOf = (row) => row.offsetTop + row.offsetHeight;
  const index = after ? rows.indexOf(after) : rows.length;
  const prev = rows[index - 1];
  let y;
  if (after && prev) y = (bottomOf(prev) + after.offsetTop) / 2;
  else if (after) y = after.offsetTop - halfGap;
  else y = bottomOf(prev) + halfGap;
  line.style.top = `${y}px`;
  if (!line.isConnected) container.appendChild(line);
}

/**
 * ドラッグ中にカーソルを画面の上端・下端へ寄せたときの自動スクロールの速さ(px / フレーム)。
 * ブラウザ任せだと端のごく狭い範囲でしか動かず遅いので、広めの帯を取り、端へ寄せるほど速くする。
 */
const AUTO_SCROLL_ZONE = 64;       // 端からこの距離に入ったらスクロールし始める
const AUTO_SCROLL_MAX_SPEED = 18;  // いちばん端に寄せたときの速さ

function autoScrollSpeed(y) {
  const bottom = window.innerHeight;
  if (y < AUTO_SCROLL_ZONE) {
    return -AUTO_SCROLL_MAX_SPEED * Math.min(1, (AUTO_SCROLL_ZONE - y) / AUTO_SCROLL_ZONE);
  }
  if (y > bottom - AUTO_SCROLL_ZONE) {
    return AUTO_SCROLL_MAX_SPEED * Math.min(1, (y - (bottom - AUTO_SCROLL_ZONE)) / AUTO_SCROLL_ZONE);
  }
  return 0;
}

/**
 * 並べ替えのドラッグ&ドロップを配線する。
 * リスナーは行ではなくリスト側に置く — renderRules() が行を作り直しても生き残るため。
 * ドラッグ中は行を動かさず、入る位置を線で示すだけにして、落としたときに初めて並びを変える。
 */
function enableDragReorder(listEl) {
  let dragging = null;
  let dropBefore = null;   // 線の位置 = この行の手前に入る。null なら末尾
  let dropped = false;
  // 自動スクロール用。カーソルの位置はリストの外(見出しの上など)にいるときも拾う
  let pointerY = null;
  let lastDragoverAt = 0;
  let scrollFrame = 0;

  const line = document.createElement('div');
  line.className = 'drop-line';

  function autoScrollStep() {
    scrollFrame = 0;
    if (!dragging) return;
    // dragover は止まっていても数十 ms おきに来る。来なくなった = ウィンドウの外に出たので止める
    if (pointerY != null && performance.now() - lastDragoverAt < 200) {
      const speed = autoScrollSpeed(pointerY);
      const scroller = document.scrollingElement;
      const before = scroller.scrollTop;
      if (speed !== 0) scroller.scrollTop += speed;
      // 行がカーソルの下を流れていくので、線も追いかけて引き直す
      if (scroller.scrollTop !== before && line.isConnected) {
        dropBefore = rowAfter(listEl, pointerY);
        showDropLine(listEl, line, dropBefore);
      }
    }
    scrollFrame = requestAnimationFrame(autoScrollStep);
  }

  document.addEventListener('dragover', (event) => {
    if (!dragging) return;
    pointerY = event.clientY;
    lastDragoverAt = performance.now();
  });

  listEl.addEventListener('dragstart', (event) => {
    const handle = event.target.closest('.drag-handle');
    if (!handle) return;
    dragging = handle.closest('.rule');
    if (!dragging) return;
    dropBefore = dragging.nextElementSibling;
    dropped = false;
    pointerY = null;
    dragging.classList.add('dragging');
    if (!scrollFrame) scrollFrame = requestAnimationFrame(autoScrollStep);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragging.dataset.id || '');
  });

  listEl.addEventListener('dragover', (event) => {
    if (!dragging) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    dropBefore = rowAfter(listEl, event.clientY);
    showDropLine(listEl, line, dropBefore);
  });

  // リストの外へ出たら線を消す(そこで離しても並びは変わらないので)。
  // 子要素をまたぐたびにも dragleave が来るので、行き先がリストの中なら無視する
  listEl.addEventListener('dragleave', (event) => {
    if (!dragging || listEl.contains(event.relatedTarget)) return;
    line.remove();
  });

  listEl.addEventListener('drop', (event) => {
    if (!dragging) return;
    event.preventDefault();
    dropped = true;
  });

  // リストの外で離した・Esc で取り消したときは drop が来ないので、並びを変えない
  listEl.addEventListener('dragend', () => {
    if (!dragging) return;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    line.remove();
    dragging.classList.remove('dragging');
    const moved = dragging;
    dragging = null;
    if (!dropped || dropBefore === moved || dropBefore === moved.nextElementSibling) return;
    if (dropBefore == null) listEl.appendChild(moved);
    else listEl.insertBefore(moved, dropBefore);
    void persistOrder();
  });
}

/**
 * 添字ではなく id で消す。ドラッグで並べ替えたあとは再描画しないので、
 * 描画時に閉じ込めた添字は当てにならない。
 */
async function remove(id) {
  const index = rules.findIndex((rule) => rule.id === id);
  if (index < 0) return;
  rules.splice(index, 1);
  await save();
  renderRules();
}

async function addRule() {
  rules.push(SR.normalizeRule({ pattern: '', profile: defaults }));
  await save();
  renderRules();
  const inputs = el('rules').querySelectorAll('[data-role="pattern"]');
  const last = inputs[inputs.length - 1];
  if (last) last.focus();
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

async function init() {
  defaults = await SR.getDefaults();
  rules = await SR.getRules();

  mountProfileForm(el('defaultsHost'), defaults, async (next) => {
    defaults = next;
    await SR.setDefaults(next);
    toast('保存しました');
  });

  enableDragReorder(el('rules'));
  renderRules();
  el('addRule').addEventListener('click', () => void addRule());
}

void init();

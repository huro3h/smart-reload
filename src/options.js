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
 * ドラッグしている行を、カーソルの下にある行の前に差し込む。
 * null なら末尾。
 */
function rowAfter(container, y) {
  const rows = [...container.querySelectorAll('.rule:not(.dragging)')];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: row };
  }
  return closest.element;
}

/**
 * 並べ替えのドラッグ&ドロップを配線する。
 * リスナーは行ではなくリスト側に置く — renderRules() が行を作り直しても生き残るため。
 */
function enableDragReorder(listEl) {
  let dragging = null;

  listEl.addEventListener('dragstart', (event) => {
    const handle = event.target.closest('.drag-handle');
    if (!handle) return;
    dragging = handle.closest('.rule');
    if (!dragging) return;
    dragging.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragging.dataset.id || '');
  });

  listEl.addEventListener('dragover', (event) => {
    if (!dragging) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const after = rowAfter(listEl, event.clientY);
    if (after == null) listEl.appendChild(dragging);
    else if (after !== dragging) listEl.insertBefore(dragging, after);
  });

  listEl.addEventListener('drop', (event) => {
    if (dragging) event.preventDefault();
  });

  listEl.addEventListener('dragend', () => {
    if (!dragging) return;
    dragging.classList.remove('dragging');
    dragging = null;
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

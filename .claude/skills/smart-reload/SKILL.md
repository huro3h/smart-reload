---
name: smart-reload
description: smart-reload (自動リロードのChrome拡張 MV3) を直すとき・機能を足すときに使う。タイマーをcontent script側に置いた理由、スキップ判定/復元/変化検知の設計、E2Eの回し方、過去にハマった点。
---

# smart-reload の実装メモ

「操作中は見送る・変化したときだけ更新する・スクロールと入力を戻す」自動リロード拡張。
Easy Auto Refresh (ksoft) の構成を読んだうえで、**タイマーの置き場所を変えて**作り直したもの。
機能一覧と使い方は README.md にある。ここは「なぜそうなっているか」だけ。

## ファイル構成

```
manifest.json          MV3。permissions は storage / tabs / scripting / notifications
src/shared.js          定数・プロファイル正規化・パターンマッチ・ハッシュ。3箇所から読まれる
src/content.js         本体。タイマー・スキップ判定・復元・変化検知が全部ここ
src/background.js      service worker。アイコン/バッジ/通知/ショートカット/初回注入だけ
src/popup.*            ツールバーのポップアップ
src/options.*          既定の設定とルール一覧
icons/icon.svg         アイコンのソース1枚。PNG は icons/build.sh で書き出す
test/e2e.js            Playwright + Brave Nightly の E2E。test/fixture.js がテスト用サーバ
```

## いちばん大きい設計判断: タイマーは content script が持つ

本家 Easy Auto Refresh は service worker 側で `setInterval` を回し、MV3 で 30 秒で
止められるのを **タブに `chrome.runtime.connect({name:"keepAlive"})` を注入して 295 秒ごとに
張り直す**ことで延命している。この拡張はそれをやらない。

- スキップ判定 (フォーカス・選択・メディア)、スクロール/フォームの復元、変化検知の
  `fetch` は、どれもページの中の情報が要る。タイマーも同じ場所にある方が素直。
- service worker が寝ていてもリロードが止まらない。background は状態を持たない。
- 60 秒未満は `setInterval`・以上は `chrome.alarms` という本家の分岐も要らなくなった。

### バックグラウンドタブのタイマー

引き換えに、ページのタイマーはタブが隠れていると絞られる (5 分以上隠れると 1 分粒度)。
ただし**リロードするたびに新しいドキュメントになって猶予がリセットされる**ので、
5 分未満の間隔なら実質影響を受けない。5 分以上の間隔、または変化検知で
「変化なし」が続いてリロードが起きない状態だと、最大 1 分ほど遅れて発火する。
発火時刻は `Date.now()` で見ているので、遅れても間隔がずれ込んでいくことはない。

これが許容できなくなったら、`chrome.alarms` を service worker 側の保険として足す形にする
(content script のタイマーは残したまま、遅れを検知したら alarm で起こす)。

## 状態の持ち方

| 置き場所 | 何を置くか | 消えるタイミング |
| --- | --- | --- |
| `chrome.storage.local` | 既定の設定 (`defaults`)、ルール (`rules`) | 明示的に消すまで |
| ページの `sessionStorage` | 実行中セッション、リロード直前の復元データ | タブを閉じたら |
| content script のメモリ | 残り時間・見送り回数・変化検知の基準ハッシュ | リロードのたび |

**タブごとの実行状態を storage に持たない**のが本家との違い。`sessionStorage` に置くと
タブ固有・タブを閉じれば自動で消える・リロードを跨げる、が全部ただで手に入る。
tabId を鍵にした表を service worker で管理する必要がない。

セッションは `source` で 2 種類に分かれる。

- `manual` … ポップアップで ON にしたもの。`sessionStorage` から引き継ぐ
- `rule` … ルールで自動 ON になったもの。**引き継がず毎回ルールから引き直す**
  (ルールを編集したら開きっぱなしのタブにも効くように)

同じオリジンの別ページに移動したときは引き継がない。`sessionStorage` はオリジン単位なので
URL を突き合わせて判断している。

サイト別の設定は持たせていない。本家はドメイン名を storage のキーにして設定を丸ごと
保存していたが、ルール機能があれば足りるので一本化した。

## 各機能の注意点

### スキップ判定

- **入力中の判定は「フォーカスがある」だけでは駄目**。空の検索ボックスにカーソルが
  残っているだけで永久に止まる。値が空でないことを条件にしている。空欄に打ち始めた
  直後は「直前に操作した」が拾う。
- **ミュートされたメディアは再生中に数えない**。ニュースサイトの記事上部で自動再生される
  装飾用の動画まで拾うと、ほぼ全部のサイトでリロードが止まらなくなる。
- 同一オリジンの iframe は `contentDocument` を辿って見ている (`eachDocument()`)。
  クロスオリジンは覗けないので埋め込み動画は検知できない。
- スクロールは `scroll` ではなく `wheel` / `touchstart` で拾う。自前の復元でも `scroll` が
  発火してしまい、自分の操作を「ユーザーの操作」と誤認するため。

### 復元

- **パスワード欄は絶対に保存しない** (`UNSAVED_TYPES`)。file / hidden も同様。
- React などの制御コンポーネントは `value` を instance 側で上書きしているので、
  `el.value = x` では変更に気づかない。`HTMLInputElement.prototype` の setter を
  `call` してから `input` / `change` を投げている (`setFieldValue()`)。
- **スクロール復元のリトライは「誰かが動かしたら降りる」こと**。遅延読み込み対策で
  100/300/700/1500ms に再試行するが、素朴に書くとリロード直後 1.5 秒間は
  スクロールしても引き戻される。自分が最後に置いた位置から動いていたら、
  他の誰かが動かしたとみなして再試行をやめる (E2E で実際に踏んだ)。

### 変化検知

- 比較するのは **`fetch` してきた HTML 同士**。画面に出ている DOM はページの JS に
  書き換えられていて、取ってきた HTML とは別物なので混ぜてはいけない。
- そのため **SPA では効かない**。README にも書いてある。
- ハッシュは `crypto.subtle` ではなく自前の FNV-1a。`crypto.subtle` は secure context が
  要るので `http://` のページでは `undefined` になる。
- `fetch` に失敗したら「変化した」扱いにしてリロードする (fail-open)。
  止まってしまうより、ふつうの自動リロードに落ちる方がまし。
- 「変化なし」で見送ったときの次回待ち時間は **`retryDelay` ではなく `interval`**。
  ここを他のスキップ理由と同じにすると数秒おきに `fetch` し続けることになる。

## ハマった点

- **`const SR = {}` は content script では危ない**。ポップアップから
  `scripting.executeScript` で流し込み直すと二度目の評価で
  `Identifier 'SR' has already been declared` になり、注入ごと失敗する。
  `var SR = globalThis.SR || (globalThis.SR = {})` にしてある。
- **`chrome.action.setIcon` の相対パスの解決先が紛らわしい**。`src/` 配下の service worker
  から呼ぶので、`chrome.runtime.getURL()` で絶対 URL にしてから渡している。
- **MAIN world で `Object.defineProperty(video, 'paused', ...)` してもテストにならない**。
  content script は ISOLATED world にいて、そこからは元の値が見える。E2E では
  実際に音が鳴る `<audio>` を置き、Brave を `--autoplay-policy=no-user-gesture-required`
  で起動して試している。
- **ブラウザ自身のスクロール復元と区別がつかない**。E2E では
  `history.scrollRestoration = 'manual'` にしてから測り、拡張の復元が効いていることを確かめている。

## テストの回し方

`~/projects` 共通の方針どおり、Playwright で **Brave Browser Nightly** を駆動する
(リリース版 Chrome は `--load-extension` を黙って無視する)。

```sh
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
npm test
```

`test/fixture.js` が :8765 で小さなサーバを立てる。`/set-marker?v=...` を叩くと
返す HTML が変わるので、変化検知はこれで試している。

content script の操作は **service worker 越し**に行う。Playwright から
`context.serviceWorkers()[0].evaluate()` すると chrome API が使えるので、
そこから `chrome.tabs.sendMessage(tabId, {type:'getStatus'})` などを投げる。
ポップアップの UI は直接クリックできないので、レイアウト確認は
`chrome-extension://<id>/src/popup.html` を普通のタブで開き、`addInitScript` で
`chrome.tabs` をスタブして撮っている (scratchpad の `shots.js` がその例)。

## アイコン

ワークスペース共通ルール (背景なし・線画・`#1A73E8`・`viewBox="0 0 24 24"`) に従っているが、
**矢じりだけ塗り (`fill`) にしている**のが唯一の逸脱。線だけの V 字の矢じりは 16px で
完全に潰れて「C」にしか見えず、時計回りの矢印だと読めなかった。円弧は `fill="none"` の
ストロークのまま。OFF 状態はグレー (`#9AA0A6`) 版で、`icons/build.sh` が
`icon.svg` から色を差し替えて両方を書き出す (ソースの SVG は 1 枚だけ)。

矢じりを描くときは、**円弧の端の丸キャップが三角からはみ出さないよう**に弧の始点を
三角の内側に少し食い込ませること。はみ出すと 128px で小さな突起になって汚い。

## バージョニング

`~/projects` 共通の方針 (Keep a Changelog + SemVer、タグは `v` なしの数字のみ、注釈付きタグ)。
ユーザー向けの変更を入れたら `CHANGELOG.md` の `[Unreleased]` に 1 行足す。
リリース時に `manifest.json` の `version` と揃える。

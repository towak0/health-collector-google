# health-collector

Google Health API 版 被験者データ収集基盤（Google Apps Script 単体）。

被験者ごとに固有 URL を発行 → Google OAuth で認可 → Fitbit / Pixel Watch の
活動量・心拍・睡眠を毎日自動収集 → スプレッドシート + Drive に蓄積する。
外部クラウド（AWS 等）を使わない。

---

## ファイル構成

```
health-collector/
├── appsscript.json            マニフェスト（TZ / Drive v3 / Web アプリ / スコープ）
├── .clasp.json.example        → .clasp.json にコピーして scriptId を入れる（git 非追跡）
├── .gitignore
├── src/
│   ├── 00_Const.js            定数・スコープ・FILTER_TEMPLATES・列定義
│   ├── 01_Config.js           Script Properties + config / datatypes シート
│   ├── 02_WebApp.js           doGet ルーター / 同意ページ / コールバック / ?setup= ?admin=
│   ├── 03_OAuth.js            認可URL・PKCE・state・code交換・refresh・revoke
│   ├── 04_TokenStore.js       Properties(refresh) + Cache(access)
│   ├── 05_Subjects.js         被験者マスタ CRUD・本人性検証（5層）
│   ├── 06_HealthApi.js        API クライアント（組立・ページング・リトライ）
│   ├── 07_Ingest.js           日次ジョブ・週次キャッチアップ・バックフィル・カーソル
│   ├── 08_SinkSheet.js        シート upsert・Audit・IngestLog・行数自動拡張
│   ├── 09_SinkDrive.js        Drive NDJSON.gz
│   ├── 10_Alerts.js           日次ダイジェスト・カナリア監視
│   ├── 11_Admin.js            セットアップ・URL発行・CSV・撤回・手動リカバリ・各種調査関数
│   └── 12_Util.js             日付・乱数・ハッシュ・マスク・例外型
├── 13_AdminUI.js / AdminUI.html    管理画面（?admin=1）
├── 14_SetupUI.js / SetupUI.html    初期設定画面（?setup=1）
├── 15_Handover.js             引き継ぎ資料の自動生成（Google ドキュメント出力）
├── 16_Diagnose.js             データ欠損の自動診断
└── test/
    └── 90_SelfTest.js         API を叩かないドライラン
```

> Apps Script 側のファイル名がそのまま落ちてくるため、`src/` 配下のものと
> ルート直下のもの（13〜16・HTML）が混在している。揃えるには Apps Script 側の
> ファイル名を変える（= `clasp push`）必要があるので、当面はこのまま。

### ブラウザから使う画面

| URL | 用途 |
|---|---|
| `{WEBAPP_URL}?setup=1` | 初期設定。7ステップで立ち上げが完結する |
| `{WEBAPP_URL}?admin=1` | 日常運用。状況表示・期間指定の再取得・直近データとログの確認 |

どちらも `ADMIN_EMAILS` に登録したアカウントだけが開ける。被験者向けの匿名デプロイからは入れない。

---

## 開発の流れ（clasp + git）

このリポジトリと Apps Script は clasp で行き来する。

```bash
clasp pull     # Apps Script → 手元（エディタで直接編集したものを取り込む）
clasp push     # 手元 → Apps Script
```

**Apps Script のエディタで直接編集した場合は、必ず `clasp pull` してからコミットする。**
しないと手元の内容で上書きされ、エディタ側の変更が消える。

`.clasp.json` は scriptId を含むため追跡していない。クローン後は
`.clasp.json.example` をコピーして scriptId を書き込む。

---

## Phase 0 — GCP セットアップ（コードの前にやる）

100ユーザー上限は**累積・取消不能**なので、プロジェクトを3つに分ける。

| プロジェクト | 用途 | 100枠 |
|---|---|---|
| **A** script-host | Apps Script を紐づける標準 GCP プロジェクト（Cloud Logging 用） | 無関係 |
| **B** subject-oauth | 被験者向け OAuth クライアント + 同意画面 + Health API | 被験者だけで使い切る |
| **C** dev | 開発・カナリア検証用 | 開発者のテストアカウントで消費 |

### Project B の手順

1. GCP プロジェクトを新規作成
2. API ライブラリで **health.googleapis.com** を有効化
3. OAuth 同意画面
   - User Type: 外部
   - アプリ名 / サポートメール / デベロッパー連絡先
   - ホームページ URL・プライバシーポリシー URL・利用規約 URL（必須）+ 承認済みドメイン
   - スコープ：下記4つだけ
     ```
     https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly
     https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly
     https://www.googleapis.com/auth/googlehealth.sleep.readonly
     https://www.googleapis.com/auth/googlehealth.profile.readonly
     ```
4. **公開ステータスを「本番環境（In production）」に切り替える**
   ← 忘れると refresh_token が7日で失効する
5. OAuth クライアント ID（ウェブ アプリケーション）
   - 承認済みリダイレクト URI：`https://script.google.com/macros/s/{DEPLOYMENT_ID}/exec`
   - ※ Phase 2 で GAS をデプロイしてから登録する（ID が確定しないため）
6. Workspace 配下なら、**匿名アクセスの Web アプリ公開がポリシーで許可されているか**を確認

### Project A

Apps Script エディタ → プロジェクトの設定 → GCP プロジェクト → Project A の番号を設定。

### Project C

Project B と同じ設定で別プロジェクト。redirect URI は開発用デプロイの `/exec`。

---

## Stage 0 — 配布 URL の間接化（着手前に必ずやる）

配布 URL を `script.google.com/...` 直リンクにしない。自前ドメインのリダイレクタを1枚挟む。

```
https://study.example.jp/j/{link_id}  →  302  →  https://script.google.com/macros/s/{ID}/exec?link_id={link_id}
```

コストはほぼゼロ。これをやらないと、将来 Cloud Run へ移行するとき全被験者に URL を配り直すことになる。

---

## Phase 1 — GAS プロジェクト作成

```bash
npm i -g @google/clasp
clasp login
clasp create --type standalone --title "health-collector"   # ★ スタンドアロン必須
cp .clasp.json.example .clasp.json                           # scriptId を書き込む
clasp push
```

**スプレッドシートに埋め込まない（コンテナバインドにしない）。**
埋め込むとシート編集権限者が全員 Script Properties（client_secret と全被験者の refresh_token）を読めてしまう。
スクリプトの共有先は PI + エンジニアの2名に限定する。

エディタから順に実行：

```js
runSetup()                                  // シートと Drive フォルダを作成、ID を Properties に投入
setProp('ALERT_EMAIL', 'pi@example.jp')
// config シートに1行追加: config_name / gcp_project / client_id / redirect_uri / base_username / scopes / status=active
setSecret('Experiment_A', '<client_secret>')  // 実行後、引数はエディタから消す
runSelfTest()                               // → ALL PASS  ← Phase 1 完了条件
runConfigCheck()                            // → CONFIG OK
```

---

## Phase 2 — デプロイと OAuth

1. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
   - 次のユーザーとして実行：**自分**
   - アクセスできるユーザー：**全員（匿名ユーザーを含む）**
2. 出た `/exec` URL を
   - Project B の OAuth クライアントの「承認済みリダイレクト URI」に登録
   - `setProp('WEBAPP_URL', 'https://script.google.com/macros/s/.../exec')`
   - config シートの `redirect_uri` にも同じ値
3. `installTriggers()` を実行
4. 自分のアカウントで1件テスト認可し、`subjects.status` が `authorized` になることを確認

### ★ デプロイ運用の鉄則

**新規デプロイを作らず、既存デプロイの「新バージョン」として更新する。**

デプロイを管理 → 対象デプロイの鉛筆アイコン → バージョン「新バージョン」→ デプロイ。

「新しいデプロイ」を選ぶと DEPLOYMENT_ID が変わり、redirect_uri が不一致になって
**配布済みログイン URL が全部死ぬ。**

---

## Phase 3 — カナリア検証（必須ゲート）★ 飛ばさない

「In production かつ未審査」で refresh_token が7日失効しないことは公開情報が割れており、
実測でしか確かめられない。万一失効する挙動だった場合、本番95名に配った後で
全員分の再同意が必要になり研究スケジュールが壊れる。

```js
// Project C の config を1行足したうえで
issueCanaries('Dev_C', 2)   // → 出た URL をテストアカウント2件で認可
```

以後、毎朝 09:00 の `runCanaryCheck()` が実リフレッシュを試み、結果をメールする。
**10日以上 OK が続くまで Phase 7 に進まない。**

---

## Phase 4〜7

| Phase | 内容 | 完了条件 |
|---|---|---|
| 4 | 日次ジョブ | テスト2件で3日分取得。**同じ日を2回実行しても行が増えない**ことを確認 |
| 5 | 運用関数 | `issueSubjects()` で100件発行、`exportSubjectsCsv()`、ダイジェスト受信 |
| 6 | パイロット | テスト被験者5名で1週間。実デバイスから日次で入る、0件検知が動く |
| 7 | 本番配布 | 95名へ URL 配布、バックフィルが分割実行される |

---

## 運用でよく使う関数

```js
issueSubjects('Experiment_A')              // 本番95 + テスト5 を採番して URL 発行
exportSubjectsCsv('Experiment_A')          // 配布用 CSV を Drive に出力
showStatus()                               // 被験者ステータス・カーソル・トリガー一覧

reissueLink('Experiment_A_042')            // 連携切れの被験者に新URL（同一 Google アカウントのみ再連携可）
withdrawSubject('Experiment_A_042')        // 同意撤回（Google 側の認可も revoke する）
clearReviewFlag('Experiment_A_042')        // 人が確認して問題なしと判断したとき

recoverRange('Experiment_A', '2026-09-01', '2026-09-07')   // 期間を取り直す（upsert なので何度でも可）
retryFailed()                              // 直近ジョブの failed 行だけ再取得
enqueueBackfill('Experiment_A', 'Experiment_A_042')
```

### 日次の運用

1. 08:00 のダイジェストで前日結果・エラー・`review_flag` を確認
2. `status != authorized` の被験者にリマインド
3. `consecutive_empty_days >= 3` の被験者にデバイス同期を依頼

---

## 配布メールに必ず書くこと

- Google アカウントが必要（持っていない人のフォロー窓口）
- 同意画面で**すべての項目にチェックを入れたまま**「続行」を押すこと（1つでも外すとそのデータが取れない）
- 「このアプリは Google で確認されていません」の警告が出るので **「詳細」→「(アプリ名) に移動」** を選ぶこと
- 締切と、未対応の場合はデータが取得できないこと

---

## セキュリティ上、絶対に崩さない点

- `client_secret` と `refresh_token` は **Script Properties のみ**。シート・コード・git に置かない
  （シートは版履歴に平文が永久に残り、後から消せない）
- `access_token` は CacheService のみ。永続化しない
- ログに トークン / 生の健康データ を出さない（実行ログは編集権限者全員が読める）。`redact_()` を通す
- 3ファイル分離：Ops（PI+エンジニア）/ Data（解析担当は閲覧のみ）/ Drive raw（エンジニアのみ）
- Drive は**共有ドライブ**に置く（個人のマイドライブだと退職・アカウント削除で消える）
- `humanome_id ↔ 氏名/メール` の対応表はこの基盤に置かない

### なりすまし・取り違えの防止（5層）

1. state は不透明 nonce。`humanome_id` をブラウザ経由で運ばない
2. state は単回使用 + LockService で原子的に消費
3. `/users/me/identity` の `healthUserId` をサーバ側で取得し 1:1 制約を検証
4. PKCE (S256)
5. `link_id` は uuid4（122bit）。失敗は audit シートに記録

取り違えを検出したらトークンを**保存せず即 revoke** する。`review_flag` は日次ダイジェストに載せるだけで、
自動解決させない（研究データの帰属は自動判定してはいけない）。

---

## ★ 実装時に一次情報で確認する項目（§16）

本コードは 2026-09-14 時点の公開ドキュメントに基づく。Google Health API は新しいため、
以下は **実 API のレスポンスで裏を取り、該当箇所を修正すること。**
コード中に `★ §16-n` のコメントを置いてある。

| # | 項目 | 該当箇所 |
|---|---|---|
| 1 | `list` の filter 左辺フィールド名（daily-* 系の camelCase は推定） | `00_Const.gs` `FILTER_TEMPLATES` |
| 2 | `rollUp` の `windowSize` が heart-rate で `"300s"` を受理するか | `datatypes` シート `window` 列 |
| 3 | `dailyRollUp` の `value` 内フィールド名（`countSum` など） | `00_Const.gs` `ROLLUP_EXTRACT` |
| 4 | `sleep` の `pageSize` 上限 25 と `nextPageToken` の挙動 | `06_HealthApi.gs` `followPages_` |
| 5 | `daily-heart-rate-variability` のフィールド名（rmssd か sdnn か、単位） | `00_Const.gs` `DAILY_LIST_MAP` |
| 6 | `/users/me/identity` のレスポンス形 | `06_HealthApi.gs` `getIdentity` |
| 7 | **In production かつ未審査で refresh_token が失効しないこと** | Phase 3 カナリアで実測 |
| 8 | Workspace テナントで匿名 Web アプリ公開が許可されているか | Phase 0 |

`ROLLUP_EXTRACT` / `DAILY_LIST_MAP` は「候補フィールド名を順に探す」方式にしてあり、
全候補が外れた場合は Cloud Logging に `unmapped_rollup_field` / `unmapped_list_field` を
WARNING で出す。**黙って欠測にはならない**ので、パイロット初日のログを必ず見ること。

---

## クォータ（被験者100人）

日次 約1,205 リクエスト。consumer でも UrlFetch 6.0% / トリガー時間 5.6%。
唯一窮屈なのは**ファイル作成 250/日 に対する 100/日（40%）**で、150人に増やすと consumer では破綻する。

→ **最初から Google Workspace アカウントで作ることを推奨。**
UrlFetch 5倍・トリガー4倍・ファイル作成6倍に加え、共有ドライブ・監査ログ・DLP が同時に手に入る。

---

## 既知の限界

| 限界 | 到達点 |
|---|---|
| OAuth 100ユーザー上限（累積・取消不能） | 被験者101人目。最初に当たる壁 |
| Webhook 不可（GAS は doPost でヘッダを読めず任意ステータスを返せない） | データ遅延が常に1日。リアルタイム介入研究には使えない |
| スプレッドシート1000万セル | 日次サマリで約15年分。心拍 intraday は初日から入らない（→ Drive で回避済み） |
| 6分/実行・90分/日（consumer） | 被験者300人 or データ型40 |
| ファイル作成250/日（consumer） | 被験者250人 |
| Secret Manager がない | スクリプト編集者は全トークンを読める |
| デプロイ URL を変えられない | 配布済み URL のホストを永久に変更できない（→ Stage 0 で回避） |

移行パス：Workspace 化（コード無変更）→ 収集だけ Cloud Run + BigQuery → OAuth も Cloud Run
（Stage 0 のリダイレクタの向き先を変えるだけ）→ 100人超はプロジェクト分割 or CASA 審査。
**いずれも再同意不要。**

---

## 旧 AWS 版の後始末（被験者ゼロなので緊急性はないが放置しない）

- `config/Experiment_A.yaml` に Fitbit の client_secret が git 追跡下でコミットされている
  （`git log -- config/Experiment_A.yaml` で履歴にも残存）。`template.yaml` の `CodeUri: .` により
  Lambda パッケージにも同梱されていた
  → Fitbit Developer Portal でアプリを無効化するか secret をローテートし、
    `.gitignore` に `config/*.yaml` を追加して `git rm --cached`
- 既存の AWS スタック（`sam delete`）は、GAS 版が Phase 6 を通過した時点で削除してよい

/**
 * 15_Handover.gs — 引き継ぎ資料を Drive に書き出す
 *
 * HealthStudy フォルダの直下に Google ドキュメントを作る（既にあれば中身を差し替える）。
 * 何も知らない人がこの基盤を引き継げるだけの情報を1枚にまとめる。
 */

function createHandoverDoc() {
  var root = prop_('DRIVE_ROOT_FOLDER_ID', true);
  var name = '【最初に読む】' + studyName_() + ' 引き継ぎ資料';

  var html = Utilities.newBlob(handoverHtml_(), 'text/html', name);

  var found = Drive.Files.list({
    q: "'" + root + "' in parents and name = '" + name.replace(/'/g, "\\'") +
       "' and trashed = false",
    fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true
  }).files || [];

  var id;
  if (found.length) {
    id = found[0].id;
    Drive.Files.update({}, id, html, { supportsAllDrives: true });
  } else {
    id = Drive.Files.create({
      name: name, parents: [root], mimeType: 'application/vnd.google-apps.document'
    }, html, { supportsAllDrives: true }).id;
  }

  var url = 'https://docs.google.com/document/d/' + id + '/edit';
  Audit.log('handover_doc_written', '', url);
  console.log(url);
  return url;
}

/** 引き継ぎ資料の中身。現在の設定値を埋め込んで生成する。 */
function handoverHtml_() {
  var P = function (k) { return String(Props.getProperty(k) || '（未設定）'); };
  var cfg = readSheetObjects_(opsSheet_(OPS_SHEETS.config))[0] || {};
  var subjects = Subjects.all();
  var byStatus = {};
  subjects.forEach(function (s) { byStatus[s.status] = (byStatus[s.status] || 0) + 1; });
  var triggers = ScriptApp.getProjectTriggers()
    .map(function (t) { return t.getHandlerFunction(); });
  var types = [];
  try {
    types = readSheetObjects_(opsSheet_(OPS_SHEETS.datatypes))
      .filter(function (r) { return String(r.enabled).toUpperCase() === 'TRUE'; })
      .map(function (r) { return r.data_type_id; });
  } catch (e) {}

  var E = function (s) { return escapeHtml_(String(s)); };
  var webapp = P('WEBAPP_URL');
  var scriptUrl = 'https://script.google.com/home/projects/' + ScriptApp.getScriptId() + '/edit';
  var statusStr = Object.keys(byStatus).map(function (k) {
    return k + ' ' + byStatus[k];
  }).join(' / ');

  return [
'<html><body>',
'<h1>', E(studyName_()), ' 引き継ぎ資料</h1>',
'<p>最終更新 ', E(isoDate_(new Date())), '｜設定画面の「引き継ぎ資料を作る」で再生成</p>',

'<h2>概要</h2>',
'<p>参加者のウェアラブル端末（Fitbit / Pixel Watch）の健康データを Google Health API 経由で',
'日次取得し、スプレッドシートと Drive に蓄積する基盤。Google Apps Script 単体で稼働し、',
'外部サーバ・クラウド契約・費用はない。</p>',
'<p>参加者は配布 URL から一度 OAuth 認可するだけ。以降は自動。</p>',

'<h2>現在の状態</h2>',
'<table border="1" cellpadding="6" cellspacing="0">',
'<tr><td>研究名</td><td>', E(P('STUDY_NAME')), '</td></tr>',
'<tr><td>試験識別子 / 被験者ID接頭辞</td><td>', E(cfg.config_name || '—'), ' / ',
E(cfg.base_username || '—'), '_001〜</td></tr>',
'<tr><td>参加者</td><td>', subjects.length, ' 名（', E(statusStr), '）</td></tr>',
'<tr><td>取得項目</td><td>', E(types.join('、')), '</td></tr>',
'<tr><td>定時実行</td><td>', E(triggers.join('、') || '未設置'), '</td></tr>',
'<tr><td>管理者 / 通知先</td><td>', E(P('ADMIN_EMAILS')), ' / ', E(P('ALERT_EMAIL')), '</td></tr>',
'</table>',

'<h2>入口</h2>',
'<table border="1" cellpadding="6" cellspacing="0">',
'<tr><th>用途</th><th>URL</th></tr>',
'<tr><td>データ閲覧</td><td>本フォルダ spreadsheets ／ ', E(studyName_()),
'_Data の daily_summary</td></tr>',
'<tr><td>運用（取り直し・ログ）</td><td>', E(webapp), '?admin=1</td></tr>',
'<tr><td>設定変更</td><td>', E(webapp), '?setup=1</td></tr>',
'<tr><td>ソース</td><td>', E(scriptUrl), '</td></tr>',
'</table>',
'<p>管理画面・設定画面は上記「管理者」のアカウントのみ。被験者向けの匿名デプロイからは入れない。</p>',

'<h2>自動実行</h2>',
'<table border="1" cellpadding="6" cellspacing="0">',
'<tr><th>時刻</th><th>処理</th></tr>',
'<tr><td>毎日 03:00</td><td>「3日前〜昨日」を取得し upsert</td></tr>',
'<tr><td>毎日 04:00</td><td>接続端末と最終同期日時を記録</td></tr>',
'<tr><td>毎日 08:00</td><td>前日結果のダイジェスト送信</td></tr>',
'<tr><td>毎日 09:00</td><td>カナリアの refresh_token 生存確認</td></tr>',
'<tr><td>月曜 00:00</td><td>「7日前〜昨日」を再取得し未同期分を回収</td></tr>',
'</table>',
'<p>3日ローリングにしているのは、端末データがスマホ同期を経てクラウドに上がるため',
'当日分が未着になるケースがあるから。(被験者ID, 日付) で upsert するので重複は生じない。</p>',

'<h2>データ構成</h2>',
'<table border="1" cellpadding="6" cellspacing="0">',
'<tr><th>場所</th><th>内容</th></tr>',
'<tr><td>spreadsheets／…_Data</td><td>daily_summary（1行=1人1日）、sleep_sessions、',
'sleep_stages、devices</td></tr>',
'<tr><td>spreadsheets／…_Ops</td><td>config、subjects、datatypes、ingest_log、audit</td></tr>',
'<tr><td>raw</td><td>心拍 intraday（5分粒度）。セル数上限を超えるため Drive に gzip NDJSON</td></tr>',
'<tr><td>exports</td><td>配布用 URL の CSV</td></tr>',
'</table>',

'<h2>運用上の注意</h2>',
'<table border="1" cellpadding="6" cellspacing="0">',
'<tr><th>禁止事項</th><th>影響</th></tr>',
'<tr><td>「新しいデプロイ」での差し替え</td><td>URL が変わり、登録済み redirect_uri と',
'配布済みリンクが全て無効化。更新は既存デプロイの新バージョンとして行う</td></tr>',
'<tr><td>配布後の試験識別子・被験者ID接頭辞の変更</td><td>トークンの保存キーと',
'被験者IDが不整合になり全員再連携</td></tr>',
'<tr><td>client_secret / refresh_token のシート記載</td><td>版履歴に平文で残り削除不能</td></tr>',
'<tr><td>氏名・連絡先と被験者IDの対応表を本基盤に置くこと</td><td>匿名化の前提が崩れる。',
'対応表は別管理</td></tr>',
'</table>',

'<h2>制約</h2>',
'<ul>',
'<li><b>未審査アプリは累計100ユーザーまで</b>。取消不可で、テスト連携も1枠消費する。',
'超える場合は CASA 審査（数か月）が必要</li>',
'<li><b>遡及取得は過去90日まで</b>。研究開始時点での連携が前提</li>',
'<li>スプレッドシートは1ファイル1000万セル。95名で約1.2年ぶん。',
'長期研究は年次でファイルを分割する</li>',
'<li>refresh_token は OAuth アプリが本番公開であれば無期限。テストモードだと7日で失効するため、',
'公開状態を変更しないこと</li>',
'</ul>',

'<h2>障害時の確認順</h2>',
'<p><b>特定の参加者だけ欠測</b>：Ops の subjects で status → Data の devices で',
'last_sync_at → ingest_log のエラー。連携切れなら reissueLink で再発行。</p>',
'<p><b>全体が停止</b>：Apps Script のトリガー画面でエラー → 管理画面の取得ログで',
'HTTP コード → カナリア失敗メールの有無。</p>',
'<p><b>期間を指定した再取得</b>：管理画面の「データを取り直す」。upsert なので何度でも安全。</p>',

'<h2>連絡先</h2>',
'<p>', E(P('ADMIN_EMAILS')), '</p>',
'</body></html>'
  ].join('\n');
}

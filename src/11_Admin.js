/**
 * 11_Admin.gs — 手動で実行する運用関数
 *
 * すべて GAS エディタから手動実行する前提。被験者からは到達できない
 * （doGet からは一切呼ばれない）。
 */

// ==== 期間を指定して手動で取得 =============================================

/**
 * 好きな期間を指定して取り直す（エンジニア向けの入口）。
 * 普段は管理画面（Web アプリの ?admin=1）から操作する。
 * これは管理画面が使えないときの保険。下の3つを書き換えてから実行する。
 *
 * upsert なので、既に入っている日を取り直しても行は増えず上書きされるだけ。
 * 何度実行しても安全。
 */
function fetchRange() {
  // ---- ここを書き換える ----------------------------------------------------
  var FROM        = '2026-09-10';   // この日から（含む）
  var TO          = '2026-09-16';   // この日まで（含む）
  var HUMANOME_ID = '';             // 空なら連携済み全員。1人だけなら被験者IDを書く
  // -------------------------------------------------------------------------

  var cfgRow = readSheetObjects_(opsSheet_(OPS_SHEETS.config))[0];
  if (!cfgRow) throw new Error('config シートに行がありません');

  var msg = recoverRange(cfgRow.config_name, FROM, TO, HUMANOME_ID || undefined);
  console.log(FROM + ' 〜 ' + TO + '\n' + msg);
  return msg;
}

// ==== セットアップ =========================================================

/**
 * 初回セットアップ。Ops / Data スプレッドシートと Drive フォルダを作り、
 * Script Properties に ID を投入する。冪等（既に ID があれば作り直さない）。
 */
function runSetup() {
  var created = [];

  if (!Props.getProperty('OPS_SPREADSHEET_ID')) {
    var ops = SpreadsheetApp.create('HealthStudy_Ops');
    Props.setProperty('OPS_SPREADSHEET_ID', ops.getId());
    created.push('Ops: ' + ops.getUrl());
  }
  if (!Props.getProperty('DATA_SPREADSHEET_ID')) {
    var data = SpreadsheetApp.create('HealthStudy_Data');
    Props.setProperty('DATA_SPREADSHEET_ID', data.getId());
    created.push('Data: ' + data.getUrl());
  }
  if (!Props.getProperty('DRIVE_ROOT_FOLDER_ID')) {
    var root = Drive.Files.create({
      name: 'HealthStudy', mimeType: 'application/vnd.google-apps.folder'
    }, null, { supportsAllDrives: true });
    Props.setProperty('DRIVE_ROOT_FOLDER_ID', root.id);
    created.push('Drive folder: https://drive.google.com/drive/folders/' + root.id);
  }

  ensureSheet_(opsSpreadsheet_(),  OPS_SHEETS.config,     COL_CONFIG);
  ensureSheet_(opsSpreadsheet_(),  OPS_SHEETS.subjects,   COL_SUBJECTS);
  ensureSheet_(opsSpreadsheet_(),  OPS_SHEETS.datatypes,  COL_DATATYPES);
  ensureSheet_(opsSpreadsheet_(),  OPS_SHEETS.ingest_log, COL_INGEST_LOG);
  ensureSheet_(opsSpreadsheet_(),  OPS_SHEETS.audit,      COL_AUDIT);

  ensureSheet_(dataSpreadsheet_(), DATA_SHEETS.daily_summary,  COL_DAILY_SUMMARY);
  ensureSheet_(dataSpreadsheet_(), DATA_SHEETS.sleep_sessions, COL_SLEEP_SESSIONS);
  ensureSheet_(dataSpreadsheet_(), DATA_SHEETS.sleep_stages,   COL_SLEEP_STAGES);
  ensureSheet_(dataSpreadsheet_(), DATA_SHEETS.devices,        COL_DEVICES);

  seedDataTypes_();

  var msg = 'セットアップ完了\n' + created.join('\n') +
    '\n\n次にやること:\n' +
    ' 1. config シートに試験の行を1行追加（config_name / client_id / redirect_uri / base_username）\n' +
    ' 2. setSecret("Experiment_A", "<client_secret>") を実行\n' +
    ' 3. Props に ALERT_EMAIL と WEBAPP_URL を設定（setProp で可）\n' +
    ' 4. installTriggers() を実行\n' +
    ' 5. issueSubjects("Experiment_A") で URL を一括発行';
  console.log(msg);
  return msg;
}

function ensureSheet_(ss, name, cols) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, cols.length).setFontWeight('bold');
  }
  // デフォルトの "シート1" が残っていたら消す
  var first = ss.getSheets()[0];
  if (ss.getSheets().length > 1 && /^(Sheet1|シート1)$/.test(first.getName()) && first.getLastRow() === 0) {
    ss.deleteSheet(first);
  }
  return sh;
}

/** datatypes シートの初期値（§8.2）。既に行があれば何もしない。 */
function seedDataTypes_() {
  var sh = opsSheet_(OPS_SHEETS.datatypes);
  if (sh.getLastRow() > 1) return;
  var rows = [
    ['steps',                        'dailyRollUp', '',     'activity', 10000, 'daily_summary',  true],
    ['distance',                     'dailyRollUp', '',     'activity', 10000, 'daily_summary',  true],
    ['active-energy-burned',         'dailyRollUp', '',     'activity', 10000, 'daily_summary',  true],
    ['total-calories',               'dailyRollUp', '',     'activity', 10000, 'daily_summary',  true],
    ['active-zone-minutes',          'dailyRollUp', '',     'activity', 10000, 'daily_summary',  true],
    ['heart-rate',                   'dailyRollUp', '',     'metrics',  10000, 'daily_summary',  true],
    ['heart-rate',                   'rollUp',      '300s', 'metrics',  10000, 'drive_raw',      true],
    ['daily-resting-heart-rate',     'list',        '',     'metrics',  1440,  'daily_summary',  true],
    ['daily-heart-rate-variability', 'list',        '',     'metrics',  1440,  'daily_summary',  true],
    ['sleep',                        'list',        '',     'sleep',    25,    'sleep_sessions', true]
  ];
  sh.getRange(2, 1, rows.length, COL_DATATYPES.length).setValues(rows);
}

/** client_secret を Script Properties に入れる（シート・コード・git には置かない）。 */
function setSecret(configName, clientSecret) {
  if (!configName || !clientSecret) throw new Error('usage: setSecret("Experiment_A", "<client_secret>")');
  Props.setProperty('secret:' + configName, String(clientSecret));
  Audit.log('secret_set', '', configName);
  return 'secret:' + configName + ' を設定しました。この関数の引数はエディタから消してください。';
}

function setProp(key, value) {
  Props.setProperty(String(key), String(value));
  return key + ' を設定しました';
}

/** 定時トリガーを設置する（§9.1）。既存の同名定時トリガーは張り替える。 */
function installTriggers() {
  // onManualFetchEdit は廃止。過去に作られたトリガーを消すためだけに名前を残す。
  var wanted = ['runDailyIngest', 'runCanaryCheck', 'runWeeklyDevices',
                'sendDailyDigest', 'runWeeklyCatchup', 'onManualFetchEdit'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (wanted.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });

  var uids = [];
  uids.push(ScriptApp.newTrigger('runDailyIngest').timeBased().atHour(3).everyDays(1).inTimezone(TZ).create().getUniqueId());
  uids.push(ScriptApp.newTrigger('sendDailyDigest').timeBased().atHour(8).everyDays(1).inTimezone(TZ).create().getUniqueId());
  uids.push(ScriptApp.newTrigger('runCanaryCheck').timeBased().atHour(9).everyDays(1).inTimezone(TZ).create().getUniqueId());
  uids.push(ScriptApp.newTrigger('runWeeklyDevices').timeBased().atHour(4).everyDays(1).inTimezone(TZ).create().getUniqueId());
  // 週次キャッチアップ：月曜 0時台に直近7日を取り直す（未同期分の回収）
  uids.push(ScriptApp.newTrigger('runWeeklyCatchup').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(0).inTimezone(TZ).create().getUniqueId());

  // cleanupOneOffTriggers_ が定時トリガーを消さないようにUIDを記録しておく
  Props.setProperty('scheduled_trigger_uids', uids.join(','));
  return 'トリガーを設置しました: ' + wanted.join(', ');
}

// ==== 被験者 URL の一括発行（§12.1） =======================================

/**
 * 本番95 + テスト5 を採番して subjects シートに書き込む。
 * 採番規則は AWS 版 scripts/generate_urls.py を踏襲：
 *   本番  {base_username}_001 〜 _095
 *   テスト test_{base_username}_001 〜 _005
 *
 * ★ テスト5件も Project B の100枠を消費する。デバッグ・カナリアは Project C で行うこと（§2.1）。
 */
function issueSubjects(configName, nProduction, nTest) {
  nProduction = (nProduction === undefined) ? 95 : nProduction;
  nTest       = nTest === undefined ? 5 : nTest;

  var cfg     = Config.forConfigName(configName);
  var webapp  = prop_('WEBAPP_URL', true);
  var existing = {};
  Subjects.all().forEach(function (s) { existing[s.humanome_id] = true; });

  var records = [];
  var pad = function (n) { return ('00' + n).slice(-3); };

  for (var i = 1; i <= nProduction; i++) {
    var id = cfg.base_username + '_' + pad(i);
    if (existing[id]) continue;
    records.push(newSubjectRecord_(cfg, id, 'production', webapp));
  }
  for (var j = 1; j <= nTest; j++) {
    var tid = 'test_' + cfg.base_username + '_' + pad(j);
    if (existing[tid]) continue;
    records.push(newSubjectRecord_(cfg, tid, 'test', webapp));
  }

  Subjects.appendRows(records);
  Audit.log('subjects_issued', '', configName + ' n=' + records.length);
  return records.length + ' 件を発行しました。exportSubjectsCsv("' + configName + '") で配布用CSVを出力できます。';
}

/** カナリア用の被験者行を作る（Project C の config で使う。type=canary）。 */
function issueCanaries(configName, n) {
  n = (n === undefined) ? 2 : n;
  var cfg    = Config.forConfigName(configName);
  var webapp = prop_('WEBAPP_URL', true);
  var records = [];
  for (var i = 1; i <= n; i++) {
    records.push(newSubjectRecord_(cfg, 'canary_' + cfg.base_username + '_' + i, 'canary', webapp));
  }
  Subjects.appendRows(records);
  return records.map(function (r) { return r.humanome_id + '  ' + r.login_url; }).join('\n');
}

function newSubjectRecord_(cfg, humanomeId, type, webapp) {
  var link = uuid4_();
  return {
    config_name: cfg.config_name,
    humanome_id: humanomeId,
    type:        type,
    link_id:     link,
    login_url:   webapp + '?link_id=' + link,
    created_at:  nowIso_(),
    status:      'issued',
    consecutive_empty_days: 0
  };
}

/** 配布用 CSV（type, id, url）を Drive に書き出してURLを返す。 */
function exportSubjectsCsv(configName) {
  var rows = Subjects.all().filter(function (s) {
    return s.config_name === configName && s.link_id;
  });
  var csv = 'type,id,url\n' + rows.map(function (s) {
    return [s.type, s.humanome_id, s.login_url].join(',');
  }).join('\n');

  var folder = ensureFolderPath_(['exports']);
  var name   = 'subjects_' + configName + '_' + isoDate_(new Date()) + '.csv';
  var file   = Drive.Files.create({ name: name, parents: [folder] },
                 Utilities.newBlob(csv, 'text/csv', name), { supportsAllDrives: true });
  Audit.log('csv_exported', '', name + ' n=' + rows.length);
  return 'https://drive.google.com/file/d/' + file.id + '/view （' + rows.length + ' 件）';
}

// ==== 個別対応 =============================================================

/** 連携が切れた被験者に新しい URL を発行する（§10.1）。 */
function reissueLink(humanomeId) {
  var webapp = prop_('WEBAPP_URL', true);
  var s = Subjects.findByHumanomeId(humanomeId);
  if (!s) throw new Error('被験者が見つかりません: ' + humanomeId);
  var url = Subjects.reissueLink(humanomeId, webapp);
  Subjects.setStatus(humanomeId, 'issued');
  Audit.log('link_reissued', humanomeId, '');
  // 再連携時、verifyBinding(2) により同一 Google アカウントでないと通らないので取り違えは起きない
  return url;
}

/**
 * 同意撤回（§11.3）。口頭対応にせず必ずこの関数を通す。
 * トークンを消すだけでは Google 側の認可が生きたままで、被験者のマイアカウントに連携が残る。
 */
function withdrawSubject(humanomeId) {
  var s = Subjects.findByHumanomeId(humanomeId);
  if (!s) throw new Error('被験者が見つかりません: ' + humanomeId);
  var cfg = Config.forConfigName(s.config_name);
  var rt  = TokenStore.getRefresh(cfg.config_name, humanomeId);
  if (rt) revokeToken_(rt);                    // ★ Google 側の認可も取り消す
  TokenStore.drop(cfg.config_name, humanomeId);
  Subjects.setStatus(humanomeId, 'withdrawn');
  Subjects.invalidateLink(humanomeId);
  Audit.log('withdrawn', humanomeId, 'manual');
  return humanomeId + ' を撤回処理しました。データ削除はプロトコル（撤回以降の停止 or 遡及削除）に従って別途対応してください。';
}

/** review_flag を解除する（人が確認して問題なしと判断したとき）。 */
function clearReviewFlag(humanomeId) {
  var s = Subjects.findByHumanomeId(humanomeId);
  if (!s) throw new Error('被験者が見つかりません: ' + humanomeId);
  var sh = opsSheet_(OPS_SHEETS.subjects);
  sh.getRange(s.__row, headerIndex_(sh)['review_flag']).setValue('');
  Audit.log('review_flag_cleared', humanomeId, '');
  return 'cleared';
}

// ==== 手動リカバリ（§9.5） =================================================

/**
 * 指定期間を取り直す。
 *   recoverRange('Experiment_A', '2026-09-01', '2026-09-07')                全 authorized 被験者
 *   recoverRange('Experiment_A', '2026-09-01', '2026-09-07', 'Experiment_A_042')  1名だけ
 * upsert なので何度実行しても行は増えない。
 */
function recoverRange(configName, fromIso, toIso, humanomeId) {
  var types = DataTypes.listEnabled();
  var subjects = humanomeId
    ? [Subjects.findByHumanomeId(humanomeId)].filter(Boolean)
    : Subjects.listActive(configName);
  if (!subjects.length) return '対象の被験者がいません';

  var jobId = 'rec-' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss');
  var started = Date.now();
  var done = 0;

  chunk_(subjects, SUBJECT_CHUNK).forEach(function (ch) {
    if (Date.now() - started > SOFT_DEADLINE_MS) return;   // 手動実行なので分割は人が繰り返す
    processChunk_(jobId, { from: fromIso, to: toIso }, ch, types);
    done += ch.length;
  });

  IngestLog.flush();
  Audit.log('manual_recovery', humanomeId || '', configName + ' ' + fromIso + '..' + toIso + ' n=' + done);
  return done + '/' + subjects.length + ' 名を処理しました（job ' + jobId + '）。'
       + (done < subjects.length ? '残りはもう一度この関数を実行してください。' : '');
}

/** 直近ジョブの failed 行だけを取り直す。 */
function retryFailed(jobId) {
  jobId = jobId || String(Props.getProperty('last_job_id') || '');
  var failed = IngestLog.failedOf(jobId);
  if (!failed.length) return 'job ' + jobId + ' に失敗行はありません';

  var byRange = {};
  failed.forEach(function (r) {
    var range = String(r.target_range || '');
    var k = r.humanome_id + '|' + range;
    byRange[k] = { humanome_id: String(r.humanome_id), range: range };
  });

  var n = 0;
  Object.keys(byRange).forEach(function (k) {
    var e = byRange[k];
    var p = e.range.split('..');
    if (p.length !== 2) return;
    var s = Subjects.findByHumanomeId(e.humanome_id);
    if (!s || s.status !== 'authorized') return;
    recoverRange(s.config_name, p[0], p[1], e.humanome_id);
    n++;
  });
  return n + ' 件を再取得しました';
}

/** バックフィルを手動で予約し直す。 */
function enqueueBackfill(configName, humanomeId) {
  Ingest.enqueueBackfill(configName, humanomeId);
  return 'バックフィルを予約しました: ' + humanomeId;
}

/** 現在の状態をざっと見る。 */
function showStatus() {
  var subjects = Subjects.all();
  var byStatus = {};
  subjects.forEach(function (s) { byStatus[s.status] = (byStatus[s.status] || 0) + 1; });
  var out = [
    'subjects: ' + subjects.length,
    'status: ' + JSON.stringify(byStatus),
    'refresh_token 保有数: ' + TokenStore.countRefresh(),
    'datatypes(enabled): ' + DataTypes.listEnabled().length,
    'ingest_cursor: ' + (Props.getProperty(CURSOR_KEY) || '(none)'),
    'backfill_queue: ' + String(Props.getProperty(BACKFILL_QUEUE_KEY) || '(empty)').split(',').filter(String).length + ' 名',
    'triggers: ' + ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }).join(', ')
  ].join('\n');
  console.log(out);
  return out;
}

// ==== 引数なしラッパー =====================================================
// GAS エディタの実行ボタンは関数に引数を渡せないため、よく使う操作は
// 引数なしの関数として用意しておく。

/** config シートの1行目を設定する。client_id を書き換えてから実行。 */
function setupConfigRow() {
  var CLIENT_ID = '297091412356-talcj9eu674h94oa11p36frejvts2niq.apps.googleusercontent.com';

  var sh = opsSheet_(OPS_SHEETS.config);
  sh.getRange(2, 1, 1, COL_CONFIG.length).setValues([[
    'Experiment_A',
    'humanome-hs-subjects',
    CLIENT_ID,
    prop_('WEBAPP_URL', true),
    'Experiment_A',
    REQUIRED_SCOPES.join(' '),
    'active'
  ]]);
  Config.invalidate();
  return runConfigCheck();
}

/** テスト被験者を1件だけ発行する。 */
function issueTestSubject() {
  var msg = issueSubjects('Experiment_A', 0, 1);
  var s = Subjects.all().filter(function (x) { return x.type === 'test'; });
  return msg + '\n\n' + s.map(function (x) {
    return x.humanome_id + '\n' + x.login_url;
  }).join('\n');
}

/** テスト被験者の連携用 URL を表示する。 */
function showTestUrl() {
  var s = Subjects.all().filter(function (x) { return x.type === 'test'; })[0];
  if (!s) return 'テスト被験者が見つかりません';
  console.log(s.humanome_id + '\n' + s.login_url);
  return s.login_url;
}

/** テスト被験者の直近3日分を取り直す。日付は必要に応じて書き換える。 */
function retestFetch() {
  var to   = isoDate_(daysAgo_(1));
  var from = isoDate_(daysAgo_(3));
  return recoverRange('Experiment_A', from, to, 'test_Experiment_A_001');
}

/** ingest_log の直近40行を1行1件で表示する。 */
function showLastLog() {
  var rows = readSheetObjects_(opsSheet_(OPS_SHEETS.ingest_log));
  var tail = rows.slice(-40);
  console.log(tail.map(function (r) {
    return [r.data_type, r.target_range, r.status, 'HTTP' + r.http_code,
            'n=' + r.n_points, String(r.error || '').substring(0, 140)].join('  |  ');
  }).join('\n'));
  return tail.length + ' 行';
}

/** daily_summary と sleep_sessions の直近行を表示する。 */
function showData() {
  var d = readSheetObjects_(dataSheet_(DATA_SHEETS.daily_summary)).slice(-10);
  console.log('===== daily_summary（直近10行）=====');
  console.log(d.length ? JSON.stringify(d, null, 1) : '(行なし)');

  var s = readSheetObjects_(dataSheet_(DATA_SHEETS.sleep_sessions)).slice(-5);
  console.log('\n===== sleep_sessions（直近5行）=====');
  console.log(s.length ? JSON.stringify(s, null, 1) : '(行なし)');
}

// ==== API 調査用 ===========================================================
// レスポンスの生の中身を見たいときに使う。仕様が変わったときの調査用。

/** 1データ型のリクエスト内容とレスポンス本文をそのまま出す。 */
function probeOne() {
  var cfg = Config.forConfigName('Experiment_A');
  var at  = refreshAccessToken_(cfg, 'test_Experiment_A_001');
  var dt  = { id: 'steps', method: 'dailyRollUp', page_size: 10000, key: 'steps:dailyRollUp' };
  var req = buildRequest_(at, dt, '2026-09-12', '2026-09-14');

  console.log('--- REQUEST ---');
  console.log(req.payload);

  var res = UrlFetchApp.fetch(req.url, req);
  console.log('--- HTTP ' + res.getResponseCode() + ' ---');
  console.log(res.getContentText().substring(0, 3000));
  return 'done';
}

/** dailyRollUp 系の生レスポンスをデータ型ごとに出す（集計フィールド名の確認用）。 */
function probeRollup() {
  var cfg = Config.forConfigName('Experiment_A');
  var hid = 'test_Experiment_A_001';
  var at  = TokenStore.getAccess(cfg.config_name, hid);
  if (!at) {
    refreshBatch_(cfg, [{ humanome_id: hid }], {});
    at = TokenStore.getAccess(cfg.config_name, hid);
  }

  var to   = isoDate_(new Date());
  var from = isoDate_(daysAgo_(3));

  ['steps', 'distance', 'total-calories', 'active-energy-burned', 'active-zone-minutes']
  .forEach(function (id) {
    var url = HEALTH_API + '/users/me/dataTypes/' + id + '/dataPoints:dailyRollUp';
    var res = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + at },
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({
        range: { start: civilDateTime_(from), end: civilDateTime_(to) },
        windowSizeDays: 1, pageSize: 5
      })
    });
    console.log('\n===== ' + id + ' [' + res.getResponseCode() + '] =====');
    console.log(res.getContentText().substring(0, 1200));
  });
}

/** list 系（心拍・睡眠）の生レスポンスを出す。 */
function probeListTypes() {
  var cfg = Config.forConfigName('Experiment_A');
  var hid = 'test_Experiment_A_001';
  var at  = TokenStore.getAccess(cfg.config_name, hid);
  if (!at) {
    refreshBatch_(cfg, [{ humanome_id: hid }], {});
    at = TokenStore.getAccess(cfg.config_name, hid);
  }

  ['daily-resting-heart-rate', 'daily-heart-rate-variability', 'sleep'].forEach(function (id) {
    var res = UrlFetchApp.fetch(
      HEALTH_API + '/users/me/dataTypes/' + id + '/dataPoints?' + qs_({ pageSize: 3 }),
      { headers: { Authorization: 'Bearer ' + at }, muteHttpExceptions: true });
    console.log('\n===== ' + id + ' [' + res.getResponseCode() + '] =====');
    console.log(res.getContentText().substring(0, 1500));
  });
}

// ==== シート構造の移行 =====================================================

/**
 * 列定義に追加された列を、既存シートのヘッダ末尾に足す。
 * 列を増やしたあとに1回だけ実行する。既にある列は触らない。
 */
function migrateSheetColumns() {
  var targets = [
    { ss: dataSpreadsheet_(), name: DATA_SHEETS.daily_summary,  cols: COL_DAILY_SUMMARY },
    { ss: dataSpreadsheet_(), name: DATA_SHEETS.sleep_sessions, cols: COL_SLEEP_SESSIONS },
    { ss: dataSpreadsheet_(), name: DATA_SHEETS.sleep_stages,   cols: COL_SLEEP_STAGES },
    { ss: dataSpreadsheet_(), name: DATA_SHEETS.devices,        cols: COL_DEVICES },
    { ss: opsSpreadsheet_(),  name: OPS_SHEETS.subjects,        cols: COL_SUBJECTS },
    { ss: opsSpreadsheet_(),  name: OPS_SHEETS.ingest_log,      cols: COL_INGEST_LOG }
  ];

  var added = [];
  targets.forEach(function (t) {
    var sh = t.ss.getSheetByName(t.name);
    if (!sh) return;
    var width  = Math.max(1, sh.getLastColumn());
    var header = sh.getRange(1, 1, 1, width).getValues()[0]
                   .map(function (h) { return String(h).trim(); });
    var missing = t.cols.filter(function (c) { return header.indexOf(c) < 0; });
    if (!missing.length) return;
    sh.getRange(1, width + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    added.push(t.name + ': ' + missing.join(', '));
  });

  var msg = added.length ? added.join('\n') : '追加する列はありませんでした';
  console.log(msg);
  return msg;
}

/** sleep_sessions の civil_date が日付型になっている行を文字列に直す。 */
function repairSleepSessions() {
  var sh = dataSheet_(DATA_SHEETS.sleep_sessions);
  var last = sh.getLastRow();
  if (last < 2) return '行がありません';
  var at = COL_SLEEP_SESSIONS.indexOf('civil_date') + 1;
  var rng = sh.getRange(2, at, last - 1, 1);
  var fixed = rng.getValues().map(function (r) { return [cellToIsoDate_(r[0])]; });
  sh.getRange(1, at, sh.getMaxRows(), 1).setNumberFormat('@');
  rng.setValues(fixed);
  return fixed.length + ' 行を直しました';
}

// ==== Drive の整理 =========================================================

/**
 * スプレッドシートを HealthStudy/spreadsheets/ の下に移動し、
 * フォルダ構成を整える。何度実行しても安全。
 *
 * 完成形:
 *   HealthStudy/
 *   ├─ spreadsheets/   HealthStudy_Ops, HealthStudy_Data
 *   ├─ raw/{試験名}/{データ型}/{被験者ID}/{年}/{日付}.ndjson.gz
 *   └─ exports/        配布用CSV
 */
function organizeDrive() {
  var root = prop_('DRIVE_ROOT_FOLDER_ID', true);
  var moved = [];

  var sheetsFolder = ensureChildFolder_(root, 'spreadsheets');
  [['OPS_SPREADSHEET_ID', 'Ops'], ['DATA_SPREADSHEET_ID', 'Data']].forEach(function (e) {
    var id = Props.getProperty(e[0]);
    if (!id) return;
    var f = Drive.Files.get(id, { fields: 'id,name,parents', supportsAllDrives: true });
    var parents = f.parents || [];
    if (parents.indexOf(sheetsFolder) >= 0) return;      // 既に移動済み
    Drive.Files.update({}, id, null, {
      addParents: sheetsFolder,
      removeParents: parents.join(','),
      supportsAllDrives: true
    });
    moved.push(f.name);
  });

  // 空でも先に作っておく（存在が分かるほうが扱いやすい）
  ensureChildFolder_(root, 'raw');
  ensureChildFolder_(root, 'exports');

  var msg = 'https://drive.google.com/drive/folders/' + root + '\n' +
            (moved.length ? '移動: ' + moved.join(', ') : '移動するものはありませんでした') +
            '\n\nHealthStudy/\n' +
            '  spreadsheets/  ... Ops / Data スプレッドシート\n' +
            '  raw/           ... {試験名}/{データ型}/{被験者ID}/{年}/{日付}.ndjson.gz\n' +
            '  exports/       ... 配布用CSV';
  console.log(msg);
  return msg;
}

/** Drive に置かれた生データのフォルダ構成とファイル数を一覧する。 */
function showDriveTree() {
  var root = prop_('DRIVE_ROOT_FOLDER_ID', true);
  var out = [];

  function walk(id, prefix, depth) {
    if (depth > 5) return;
    var res = Drive.Files.list({
      q: "'" + id + "' in parents and trashed = false",
      fields: 'files(id,name,mimeType,size)',
      pageSize: 200,
      supportsAllDrives: true, includeItemsFromAllDrives: true
    }).files || [];

    var folders = res.filter(function (f) {
      return f.mimeType === 'application/vnd.google-apps.folder';
    });
    var files = res.filter(function (f) {
      return f.mimeType !== 'application/vnd.google-apps.folder';
    });

    folders.forEach(function (f) {
      out.push(prefix + f.name + '/');
      walk(f.id, prefix + '  ', depth + 1);
    });
    if (files.length <= 5) {
      files.forEach(function (f) {
        out.push(prefix + f.name + (f.size ? '  (' + f.size + ' B)' : ''));
      });
    } else {
      out.push(prefix + files.length + ' ファイル（' + files[0].name + ' 他）');
    }
  }

  out.push('HealthStudy/');
  walk(root, '  ', 0);
  var msg = out.join('\n');
  console.log(msg);
  return msg;
}

// ==== 試験名の変更（配布前にだけ実行できる） ================================

/**
 * config_name と base_username を変更する。
 *
 * ★ これは「作り直し」であって「改名」ではない。
 *   config_name はトークンの保存キー、base_username は被験者IDそのもので、
 *   両方ともシート・Script Properties・Drive のパスに埋め込まれている。
 *   途中で名前だけ差し替えると必ず不整合が出るので、既存の連携とデータを
 *   一度すべて破棄して、新しい名前で採番し直す。
 *
 * ★ 被験者に URL を配ったあとは絶対に実行しないこと。配布済みリンクが全部無効になる。
 *
 * 実行前に下の3つを書き換えてから実行する。
 */
function resetProject() {
  // ---- ここを書き換える ----------------------------------------------------
  var NEW_CONFIG_NAME   = 'Experiment_A';   // 内部の識別子。英数字と _ のみ
  var NEW_BASE_USERNAME = 'Experiment_A';   // 被験者IDの接頭辞（→ XXX_001）
  var CONFIRM           = 'NO';             // 実行するときだけ 'YES' にする
  // -------------------------------------------------------------------------

  if (CONFIRM !== 'YES') {
    return '実行されていません。関数内の CONFIRM を "YES" にしてから再実行してください。\n' +
           '既存の連携データはすべて破棄されます。';
  }

  var oldCfg = readSheetObjects_(opsSheet_(OPS_SHEETS.config))[0];
  if (!oldCfg) throw new Error('config シートに行がありません');
  var oldName = oldCfg.config_name;

  // 1. 既存の認可を Google 側ごと取り消してトークンを捨てる
  var revoked = 0;
  Subjects.all().forEach(function (s) {
    var rt = TokenStore.getRefresh(s.config_name, s.humanome_id);
    if (rt) { try { revokeToken_(rt); revoked++; } catch (e) {} }
    TokenStore.drop(s.config_name, s.humanome_id);
  });

  // 2. シートの中身を空にする（ヘッダは残す）
  [[opsSpreadsheet_(),  OPS_SHEETS.subjects],
   [dataSpreadsheet_(), DATA_SHEETS.daily_summary],
   [dataSpreadsheet_(), DATA_SHEETS.sleep_sessions],
   [dataSpreadsheet_(), DATA_SHEETS.sleep_stages],
   [dataSpreadsheet_(), DATA_SHEETS.devices]].forEach(function (t) {
    var sh = t[0].getSheetByName(t[1]);
    if (sh && sh.getLastRow() > 1) {
      sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
    }
  });

  // 3. client_secret を新しいキーに移す
  var secret = Props.getProperty('secret:' + oldName);
  if (secret) {
    Props.setProperty('secret:' + NEW_CONFIG_NAME, secret);
    if (NEW_CONFIG_NAME !== oldName) Props.deleteProperty('secret:' + oldName);
  }

  // 4. config 行を書き換える（client_id と redirect_uri は今のものを引き継ぐ）
  var sh = opsSheet_(OPS_SHEETS.config);
  sh.getRange(2, 1, 1, COL_CONFIG.length).setValues([[
    NEW_CONFIG_NAME,
    oldCfg.gcp_project,
    oldCfg.client_id,
    prop_('WEBAPP_URL', true),
    NEW_BASE_USERNAME,
    REQUIRED_SCOPES.join(' '),
    'active'
  ]]);
  Config.invalidate();

  // 5. 新しい名前で採番し直す
  issueSubjects(NEW_CONFIG_NAME, 95, 1);

  var test = Subjects.all().filter(function (x) { return x.type === 'test'; })[0];
  var msg = '作り直しました。\n' +
            '  config_name:   ' + oldName + ' → ' + NEW_CONFIG_NAME + '\n' +
            '  base_username: ' + oldCfg.base_username + ' → ' + NEW_BASE_USERNAME + '\n' +
            '  取り消した認可: ' + revoked + ' 件\n\n' +
            'このURLを開いて連携し直してください:\n' +
            (test ? test.humanome_id + '\n' + test.login_url : '(テスト被験者なし)') + '\n\n' +
            '※ Drive の raw/' + oldName + ' フォルダは残っています。不要なら手で削除してください。\n' +
            '※ 関数内の CONFIRM を "NO" に戻しておいてください。';
  console.log(msg);
  return msg;
}

/**
 * raw/.../{被験者ID}/{年}/ の年フォルダを廃止し、ファイルを1つ上へ移す（1回だけ）。
 * ファイル名に年が入っているので年フォルダは不要。
 */
function migrateRawDropYear() {
  var root = prop_('DRIVE_ROOT_FOLDER_ID', true);
  var moved = 0, removed = [];

  function folders(id) {
    return (Drive.Files.list({
      q: "'" + id + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: 'files(id,name)', pageSize: 200,
      supportsAllDrives: true, includeItemsFromAllDrives: true
    }).files || []);
  }
  function files(id) {
    return (Drive.Files.list({
      q: "'" + id + "' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false",
      fields: 'files(id,name)', pageSize: 500,
      supportsAllDrives: true, includeItemsFromAllDrives: true
    }).files || []);
  }

  var rawFolder = ensureChildFolder_(root, 'raw');
  folders(rawFolder).forEach(function (cfg) {            // 試験名
    folders(cfg.id).forEach(function (dt) {              // データ型
      folders(dt.id).forEach(function (subj) {           // 被験者
        folders(subj.id).forEach(function (yr) {         // 年（これを畳む）
          if (!/^\d{4}$/.test(yr.name)) return;
          files(yr.id).forEach(function (f) {
            Drive.Files.update({}, f.id, null, {
              addParents: subj.id, removeParents: yr.id, supportsAllDrives: true
            });
            moved++;
          });
          Drive.Files.update({ trashed: true }, yr.id, null, { supportsAllDrives: true });
          removed.push(subj.name + '/' + yr.name);
        });
      });
    });
  });

  CacheService.getScriptCache().removeAll(['folder:raw']);
  var msg = moved + ' ファイルを移動、' + removed.length + ' 個の年フォルダをゴミ箱へ\n' +
            removed.join('\n');
  console.log(msg);
  return msg;
}

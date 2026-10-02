/**
 * 14_SetupUI.gs — 初期設定の画面
 *
 * 管理画面（13_AdminUI）が「日々の運用」なのに対し、こちらは「立ち上げ」。
 * Script Properties の入力と、runSetup / issueSubjects / installTriggers の実行を
 * ブラウザから順番に行えるようにする。
 *
 * ★ 権限の扱いが管理画面と少しだけ違う。
 *   ADMIN_EMAILS がまだ空のときは設定できなくなってしまうため、
 *   「未設定のあいだは、スクリプトの所有者本人だけ通す」という抜け道を用意している。
 *   匿名アクセスでは getActiveUser() が空になるので、被験者向けデプロイからは入れない。
 */

function requireSetupAdmin_() {
  var me = '';
  try { me = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) {}
  if (!me) { Audit.log('setup_denied', '', '(anonymous)'); throw new Error('権限がありません'); }

  var allow = String(Props.getProperty('ADMIN_EMAILS') || '')
    .split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(String);

  if (!allow.length) {
    // 初回のみ：所有者本人だけ通す
    var owner = '';
    try { owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) {}
    if (me && me === owner) return me;
    Audit.log('setup_denied', '', me);
    throw new Error('権限がありません');
  }

  if (allow.indexOf(me) < 0) { Audit.log('setup_denied', '', me); throw new Error('権限がありません'); }
  return me;
}

function renderSetupPage_() {
  try { requireSetupAdmin_(); }
  catch (e) {
    return page_('権限がありません',
      '<p>この画面は研究担当者専用です。</p>');
  }
  return HtmlService.createHtmlOutputFromFile('SetupUI')
    .setTitle(studyName_() + ' 初期設定')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ---- 画面から呼ばれる関数 -------------------------------------------------

/** 各ステップが終わっているかを判定して返す。 */
function setupStatus() {
  var me = requireSetupAdmin_();
  var P = function (k) { return String(Props.getProperty(k) || ''); };

  var sheetsReady = false, opsUrl = '', dataUrl = '', driveUrl = '';
  try {
    opsUrl  = opsSpreadsheet_().getUrl();
    dataUrl = dataSpreadsheet_().getUrl();
    driveUrl = 'https://drive.google.com/drive/folders/' + P('DRIVE_ROOT_FOLDER_ID');
    sheetsReady = !!(P('OPS_SPREADSHEET_ID') && P('DATA_SPREADSHEET_ID') && P('DRIVE_ROOT_FOLDER_ID'));
  } catch (e) {}

  var cfg = null;
  try { cfg = readSheetObjects_(opsSheet_(OPS_SHEETS.config))[0] || null; } catch (e) {}

  var subjects = [];
  try { subjects = Subjects.all(); } catch (e) {}
  var authorized = subjects.filter(function (s) { return s.status === 'authorized'; }).length;

  var triggers = [];
  try {
    triggers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  } catch (e) {}

  var test = subjects.filter(function (s) { return s.type === 'test'; })[0];

  return {
    me:          me,
    // 相対パス（?admin=1）はサンドボックス iframe を基準に解決されて飛び先を失う。
    // 絶対URLをサーバ側から渡す。
    selfUrl:     (function () { try { return ScriptApp.getService().getUrl(); } catch (e) { return ''; } })(),
    studyName:   P('STUDY_NAME') || 'HealthStudy',
    adminEmails: P('ADMIN_EMAILS'),
    alertEmail:  P('ALERT_EMAIL'),
    webappUrl:   P('WEBAPP_URL'),
    hasSecret:   !!(cfg && P('secret:' + cfg.config_name)),
    sheetsReady: sheetsReady,
    opsUrl: opsUrl, dataUrl: dataUrl, driveUrl: driveUrl,
    config: cfg ? {
      configName:   String(cfg.config_name || ''),
      gcpProject:   String(cfg.gcp_project || ''),
      clientId:     String(cfg.client_id || ''),
      redirectUri:  String(cfg.redirect_uri || ''),
      baseUsername: String(cfg.base_username || ''),
      status:       String(cfg.status || '')
    } : null,
    subjectCount: subjects.length,
    authorized:   authorized,
    testUrl:      test ? test.login_url : '',
    testId:       test ? test.humanome_id : '',
    triggers:     triggers,
    scopes:       REQUIRED_SCOPES
  };
}

/** 研究名・通知先・管理者を保存する。 */
function setupSaveBasics(o) {
  requireSetupAdmin_();
  if (o.studyName)   Props.setProperty('STUDY_NAME', String(o.studyName).trim());
  if (o.alertEmail)  Props.setProperty('ALERT_EMAIL', String(o.alertEmail).trim());
  if (o.adminEmails) Props.setProperty('ADMIN_EMAILS', String(o.adminEmails).trim());
  Audit.log('setup_basics_saved', '', String(o.studyName || ''));
  return '保存しました';
}

/** スプレッドシートとドライブフォルダを作る。 */
function setupRunSetup() {
  requireSetupAdmin_();
  return runSetup();
}

/** ウェブアプリの URL を保存する（被験者向けデプロイの /exec）。 */
function setupSaveWebappUrl(url) {
  requireSetupAdmin_();
  var u = String(url || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^\/]+\/exec$/.test(u)) {
    throw new Error('/exec で終わるウェブアプリの URL を入れてください');
  }
  Props.setProperty('WEBAPP_URL', u);
  Audit.log('setup_webapp_url', '', u);
  return '保存しました';
}

/** 試験の設定行を書き込む。client_secret は Script Properties にだけ入れる。 */
function setupSaveConfig(o) {
  requireSetupAdmin_();
  var name = String(o.configName || '').trim();
  var base = String(o.baseUsername || '').trim();
  var cid  = String(o.clientId || '').trim();
  var sec  = String(o.clientSecret || '');

  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('試験の識別子は英数字とアンダースコアのみです');
  if (!/^[A-Za-z0-9_]+$/.test(base)) throw new Error('被験者IDの接頭辞は英数字とアンダースコアのみです');
  if (!cid) throw new Error('クライアントIDを入れてください');

  var webapp = String(Props.getProperty('WEBAPP_URL') || '');
  if (!webapp) throw new Error('先にウェブアプリの URL を保存してください');

  var sh = opsSheet_(OPS_SHEETS.config);
  sh.getRange(2, 1, 1, COL_CONFIG.length).setValues([[
    name, String(o.gcpProject || ''), cid, webapp, base,
    REQUIRED_SCOPES.join(' '), 'active'
  ]]);

  // ★ シークレットはシートに書かない（版履歴に平文で永久に残るため）
  if (sec) Props.setProperty('secret:' + name, sec);

  Config.invalidate();
  Audit.log('setup_config_saved', '', name);
  return '保存しました' + (sec ? '（シークレットも登録しました）' : '');
}

/** 被験者IDと連携用URLを発行する。 */
function setupIssueSubjects(nProduction, nTest) {
  requireSetupAdmin_();
  var cfg = readSheetObjects_(opsSheet_(OPS_SHEETS.config))[0];
  if (!cfg) throw new Error('先に試験の設定を保存してください');
  var np = Number(nProduction), nt = Number(nTest);
  if (!(np >= 0 && np <= 1000) || !(nt >= 0 && nt <= 100)) throw new Error('件数が不正です');
  return issueSubjects(cfg.config_name, np, nt);
}

/** 定時トリガーを設置する。 */
function setupInstallTriggers() {
  requireSetupAdmin_();
  return installTriggers();
}

/** シートの列追加とドライブの整理をまとめて行う。 */
function setupTidy() {
  requireSetupAdmin_();
  var a = migrateSheetColumns();
  var b = organizeDrive();
  return a + '\n\n' + b;
}

/** 配布用CSVを書き出す。 */
function setupExportCsv() {
  requireSetupAdmin_();
  var cfg = readSheetObjects_(opsSheet_(OPS_SHEETS.config))[0];
  if (!cfg) throw new Error('先に試験の設定を保存してください');
  return exportSubjectsCsv(cfg.config_name);
}

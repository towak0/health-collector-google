/**
 * 90_SelfTest.gs — ドライラン。API を一切叩かずにリクエスト組立とパースを検証する。
 * GAS エディタから runSelfTest() を実行し、ログが「ALL PASS」になることを確認する（Phase 1 完了条件）。
 */

function runSelfTest() {
  var fails = [];
  function ok(cond, name, detail) {
    if (!cond) fails.push(name + (detail ? ' — ' + detail : ''));
  }
  function eq(a, b, name) { ok(a === b, name, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

  // ---- 日付ユーティリティ ----
  eq(addDays_('2026-09-14', 1), '2026-09-15', 'addDays +1');
  eq(addDays_('2026-12-31', 1), '2027-01-01', 'addDays 年またぎ');
  eq(addDays_('2026-03-01', -1), '2026-02-28', 'addDays 月またぎ');
  eq(diffDays_('2026-09-14', '2026-09-11'), 3, 'diffDays');
  eq(JSON.stringify(civil_('2026-09-11')), JSON.stringify({year:2026,month:9,day:11}), 'civil_');
  eq(civilToIso_({year:2026,month:9,day:1}), '2026-09-01', 'civilToIso_');

  var spans = splitRange_('2026-06-16', '2026-09-13', 14);
  eq(spans.length, 7, 'splitRange 90日を14日刻み → 7分割');
  eq(spans[0].from, '2026-06-16', 'splitRange 先頭');
  eq(spans[spans.length - 1].to, '2026-09-13', 'splitRange 末尾');

  // ---- PKCE ----
  var verifier = randomToken_(64);
  eq(verifier.length, 128, 'PKCE verifier 長 (43-128)');
  ok(/^[A-Za-z0-9_-]+$/.test(base64UrlSha256_(verifier)), 'code_challenge が base64url');

  // ---- リクエスト組立 ----
  var AT = 'DUMMY_ACCESS_TOKEN';

  var dtDaily = { id: 'steps', method: 'dailyRollUp', page_size: 10000, key: 'steps:dailyRollUp' };
  var r1 = buildRequest_(AT, dtDaily, '2026-09-11', '2026-09-13');
  ok(r1.url.indexOf('dataTypes/steps/dataPoints:dailyRollUp') > 0, 'dailyRollUp URL');
  var p1 = JSON.parse(r1.payload);
  eq(JSON.stringify(p1.range.start), JSON.stringify({year:2026,month:9,day:11}), 'dailyRollUp range.start');
  eq(JSON.stringify(p1.range.end), JSON.stringify({year:2026,month:9,day:14}), 'dailyRollUp range.end は半開区間(+1日)');
  eq(p1.windowSizeDays, 1, 'windowSizeDays');

  var dtRoll = { id: 'heart-rate', method: 'rollUp', window: '300s', page_size: 10000, key: 'heart-rate:rollUp' };
  var r2 = buildRequest_(AT, dtRoll, '2026-09-13', '2026-09-13');
  var p2 = JSON.parse(r2.payload);
  eq(p2.windowSize, '300s', 'rollUp windowSize');
  eq(p2.range.startTime, '2026-09-13T00:00:00+09:00', 'rollUp startTime は RFC3339');
  eq(p2.range.endTime, '2026-09-14T00:00:00+09:00', 'rollUp endTime は半開区間');

  var dtList = { id: 'sleep', method: 'list', page_size: 25, key: 'sleep:list' };
  var r3 = buildRequest_(AT, dtList, '2026-09-11', '2026-09-13');
  ok(r3.url.indexOf('pageSize=25') > 0, 'sleep pageSize=25（§5.4 上限）');
  ok(decodeURIComponent(r3.url).indexOf('sleep.interval.civil_start_time >= "2026-09-11T00:00:00"') > 0, 'sleep filter from');
  ok(decodeURIComponent(r3.url).indexOf('< "2026-09-14T00:00:00"') > 0, 'sleep filter toExclusive');

  // 未知のデータ型は黙って全件取得にせず例外（§5.5）
  var threw = false;
  try { buildRequest_(AT, { id: 'unknown-type', method: 'list', page_size: 100 }, '2026-09-11', '2026-09-13'); }
  catch (e) { threw = (e.name === 'FatalConfigError'); }
  ok(threw, 'FILTER_TEMPLATES 未定義のデータ型は例外を投げる');

  // ---- 期間分割（§5.3） ----
  eq(splitByMaxSpan_({ id: 'heart-rate' }, '2026-06-16', '2026-09-13').length, 7, '心拍は14日で分割');
  eq(splitByMaxSpan_({ id: 'steps' }, '2026-06-16', '2026-09-13').length, 1, '歩数は90日1回');
  eq(splitByMaxSpan_({ id: 'heart-rate' }, '2026-09-11', '2026-09-13').length, 1, '3日窓は分割不要');

  // ---- レスポンスのパース ----
  var daily = {};
  collectDailyRollUp_(daily, 'X_001', dtDaily, [
    { civilStartTime: { year: 2026, month: 9, day: 12 }, value: { steps: { countSum: 8432 } } }
  ], 'job1');
  eq(daily['X_001|2026-09-12'].steps, 8432, 'dailyRollUp steps パース');

  var sessions = [], stages = [], map2 = {};
  collectSleep_(map2, sessions, stages, 'X_001', [{
    sleep: {
      interval: { startTime: '2026-09-12T23:10:00+09:00', endTime: '2026-09-13T06:40:00+09:00' },
      type: 'STAGES',
      stages: [
        { startTime: '2026-09-12T23:10:00+09:00', endTime: '2026-09-13T00:10:00+09:00', type: 'LIGHT' },
        { startTime: '2026-09-13T00:10:00+09:00', endTime: '2026-09-13T01:10:00+09:00', type: 'DEEP' }
      ],
      shortAwakenings: [{}],
      minutesToFallAsleep: 12
    }
  }], 'job1');
  eq(sessions.length, 1, 'sleep セッション数');
  eq(sessions[0].civil_date, '2026-09-13', 'sleep の civil_date は起床日');
  eq(sessions[0].duration_min, 450, 'sleep duration_min');
  eq(sessions[0].deep_min, 60, 'sleep deep_min');
  eq(stages.length, 2, 'sleep ステージ展開');
  ok(stages[0].dedupe_key !== stages[1].dedupe_key, 'ステージの dedupe_key が一意');
  eq(map2['X_001|2026-09-13'].sleep_deep_min, 60, 'daily_summary に deep が入る');

  var raw = {};
  collectIntraday_(raw, 'X_001', dtRoll, [
    { startTime: '2026-09-13T00:00:00+09:00', endTime: '2026-09-13T00:05:00+09:00', heartRate: { bpmAvg: 58 } }
  ]);
  eq(Object.keys(raw)[0], 'X_001|2026-09-13', '心拍 intraday は日付ごとに束ねる');

  // ---- スコープ判定 ----
  var subj = { granted_scopes: REQUIRED_SCOPES.join(' '), disabled_data_types: 'sleep:list' };
  ok(hasScope_(subj, { scope_key: 'metrics', key: 'heart-rate:rollUp' }), 'スコープあり → 取得対象');
  ok(!hasScope_(subj, { scope_key: 'sleep', key: 'sleep:list' }), '恒久スキップ登録済みは除外');
  ok(!hasScope_({ granted_scopes: SCOPE_ACTIVITY, disabled_data_types: '' },
                { scope_key: 'sleep', key: 'sleep:list' }), 'スコープ不足は除外');

  // ---- 秘匿情報のマスク ----
  ok(redact_('token=ya29.abcDEF-123_x').indexOf('ya29.abc') < 0, 'access_token をログに出さない');
  ok(redact_('{"refresh_token":"1//05xyz"}').indexOf('1//05xyz') < 0, 'refresh_token をログに出さない');

  // ---- 結果 ----
  if (fails.length) {
    console.log('SELF TEST FAILED (' + fails.length + ')\n - ' + fails.join('\n - '));
    throw new Error('Self test failed: ' + fails.length + ' 件');
  }
  console.log('ALL PASS — リクエスト組立・パース・マスクの検証に成功しました');
  return 'ALL PASS';
}

/**
 * 設定まわりの健全性チェック（シート・Properties が揃っているか）。
 * API は叩かないが、スプレッドシートへは読みに行く。
 */
function runConfigCheck() {
  var problems = [];
  ['OPS_SPREADSHEET_ID', 'DATA_SPREADSHEET_ID', 'DRIVE_ROOT_FOLDER_ID', 'WEBAPP_URL', 'ALERT_EMAIL']
    .forEach(function (k) { if (!Props.getProperty(k)) problems.push('Script Property 未設定: ' + k); });

  try {
    Config.listActive().forEach(function (c) {
      if (!Props.getProperty('secret:' + c.config_name)) problems.push('client_secret 未設定: secret:' + c.config_name);
      if (c.redirect_uri !== Props.getProperty('WEBAPP_URL'))
        problems.push('redirect_uri と WEBAPP_URL が不一致: ' + c.config_name);
      var missing = REQUIRED_SCOPES.filter(function (s) { return c.scopes.indexOf(s) < 0; });
      if (missing.length) problems.push('scopes 不足 (' + c.config_name + '): ' + missing.length + ' 件');
    });
  } catch (e) { problems.push('config シート読み込み失敗: ' + e.message); }

  try {
    DataTypes.listEnabled().forEach(function (dt) {
      if (dt.method === 'list' && !FILTER_TEMPLATES[dt.id])
        problems.push('FILTER_TEMPLATES 未定義: ' + dt.id);
      if (dt.method === 'dailyRollUp' && !ROLLUP_EXTRACT[dt.id])
        problems.push('ROLLUP_EXTRACT 未定義: ' + dt.id);
      if (!SCOPE_KEYS[dt.scope_key]) problems.push('未知の scope_key: ' + dt.scope_key + ' (' + dt.id + ')');
    });
  } catch (e) { problems.push('datatypes シート読み込み失敗: ' + e.message); }

  var out = problems.length ? ('問題 ' + problems.length + ' 件\n - ' + problems.join('\n - ')) : 'CONFIG OK';
  console.log(out);
  return out;
}

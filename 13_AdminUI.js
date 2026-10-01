/**
 * 13_AdminUI.gs — 管理用の画面（ブラウザから操作する）
 *
 * ★ この画面は被験者向けの Web アプリと同じスクリプトで動くが、
 *   Session.getActiveUser() が ADMIN_EMAILS に含まれる場合しか表示しない。
 *   被験者向けデプロイは匿名アクセスなので getActiveUser() が空になり、必ず弾かれる。
 *
 * 使うには「アクセスできるユーザー」を限定した**別のデプロイ**を1つ作り、
 * その URL の末尾に ?admin=1 を付けてブックマークする。
 * 被験者に配布済みのデプロイは触らないこと。
 */

/** 画面に出す研究の名前。Script Properties の STUDY_NAME で変えられる。 */
function studyName_() {
  return String(Props.getProperty('STUDY_NAME') || 'HealthStudy');
}

/** 管理者かどうか。違えば例外。google.script.run の入口すべてで呼ぶ。 */
function requireAdmin_() {
  var me = '';
  try { me = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) {}
  var allow = String(Props.getProperty('ADMIN_EMAILS') || '')
    .split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(String);
  if (!me || allow.indexOf(me) < 0) {
    Audit.log('admin_denied', '', me || '(anonymous)');
    throw new Error('権限がありません');
  }
  return me;
}

function renderAdminPage_() {
  try { requireAdmin_(); }
  catch (e) {
    return page_('権限がありません',
      '<p>この画面は研究担当者専用です。</p>' +
      '<p class="note">担当者の方へ：Script Properties の ADMIN_EMAILS に自分のアドレスを' +
      '登録し、アクセスを限定したデプロイからこの URL を開いてください。</p>');
  }

  return HtmlService.createHtmlOutputFromFile('AdminUI')
    .setTitle(studyName_() + ' 管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ---- google.script.run から呼ばれる関数 -----------------------------------

/** 画面を開いたときに出す概況。 */
function adminSummary() {
  requireAdmin_();
  var subjects = Subjects.all();
  var byStatus = {};
  subjects.forEach(function (s) { byStatus[s.status] = (byStatus[s.status] || 0) + 1; });

  var rows = readSheetObjects_(dataSheet_(DATA_SHEETS.daily_summary));
  var latest = '';
  rows.forEach(function (r) {
    var u = String(r.updated_at || '');
    if (u > latest) latest = u;
  });

  return {
    studyName:  studyName_(),
    total:      subjects.length,
    authorized: byStatus['authorized'] || 0,
    issued:     byStatus['issued'] || 0,
    withdrawn:  byStatus['withdrawn'] || 0,
    dataRows:   rows.length,
    lastUpdate: latest ? latest.replace('T', ' ').substring(0, 16) : '—',
    opsUrl:     opsSpreadsheet_().getUrl(),
    dataUrl:    dataSpreadsheet_().getUrl(),
    driveUrl:   'https://drive.google.com/drive/folders/' + prop_('DRIVE_ROOT_FOLDER_ID', true),
    subjects:   subjects.filter(function (s) { return s.status === 'authorized'; })
                        .map(function (s) { return s.humanome_id; })
  };
}

/** 範囲を指定して取り直す。 */
function adminFetch(from, to, humanomeId) {
  requireAdmin_();
  var ok = /^\d{4}-\d{2}-\d{2}$/;
  if (!ok.test(from) || !ok.test(to)) throw new Error('日付の形式が正しくありません');
  if (from > to) throw new Error('開始日が終了日より後になっています');

  var hid = String(humanomeId || '').trim();
  if (hid && !Subjects.findByHumanomeId(hid)) throw new Error('被験者IDが見つかりません: ' + hid);

  var cfgRow = readSheetObjects_(opsSheet_(OPS_SHEETS.config))[0];
  if (!cfgRow) throw new Error('config シートに行がありません');

  return recoverRange(cfgRow.config_name, from, to, hid || undefined);
}

/** daily_summary の直近行（画面の表用）。 */
function adminRecent(limit) {
  requireAdmin_();
  var cols = ['humanome_id', 'civil_date', 'steps', 'distance_m', 'resting_hr',
              'hrv_rmssd_ms', 'sleep_total_min'];
  var rows = readSheetObjects_(dataSheet_(DATA_SHEETS.daily_summary));
  rows.sort(function (a, b) {
    return String(cellToIsoDate_(b.civil_date)).localeCompare(String(cellToIsoDate_(a.civil_date)));
  });
  return {
    cols: cols,
    rows: rows.slice(0, limit || 15).map(function (r) {
      return cols.map(function (c) {
        var v = c === 'civil_date' ? cellToIsoDate_(r[c]) : r[c];
        return (v === '' || v === null || v === undefined) ? '' :
               (typeof v === 'number' ? Math.round(v * 100) / 100 : String(v));
      });
    })
  };
}

/** 欠測の理由を被験者ごとに判定して返す。 */
function adminDiagnose() {
  requireAdmin_();
  return diagnoseSubjects();
}

/** ingest_log の直近行。 */
function adminLog(limit) {
  requireAdmin_();
  var rows = readSheetObjects_(opsSheet_(OPS_SHEETS.ingest_log)).slice(-(limit || 30)).reverse();
  return rows.map(function (r) {
    return {
      at:     String(r.ts || '').replace('T', ' ').substring(0, 16),
      type:   String(r.data_type || ''),
      range:  String(r.target_range || ''),
      status: String(r.status || ''),
      code:   String(r.http_code || ''),
      n:      String(r.n_points || ''),
      error:  String(r.error || '').substring(0, 120)
    };
  });
}

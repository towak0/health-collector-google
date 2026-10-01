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

  // Viz.html を取り込むためテンプレートとして評価する
  return HtmlService.createTemplateFromFile('AdminUI').evaluate()
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

// ---- グラフ用のデータ -------------------------------------------------------
//
// 方針：
//  - 画面側で重い計算をしない。ここで日付軸に揃えた配列まで作って返す。
//  - 被験者を指定しなければコホートの中央値を返す。平均だと1人の外れ値で形が変わる。
//  - 単位の違う指標を1つのグラフに重ねない。指標ごとに別の系列として返し、
//    画面側でも別々のグラフに描く。

/** 末尾が昨日になる N 日分の ISO 日付。 */
function lastDays_(days) {
  var out = [], base = new Date();
  base.setHours(0, 0, 0, 0);
  for (var i = days; i >= 1; i--) {
    out.push(Utilities.formatDate(new Date(base.getTime() - i * 864e5), TZ, 'yyyy-MM-dd'));
  }
  return out;
}

function median_(xs) {
  var a = xs.filter(function (v) { return typeof v === 'number' && isFinite(v); }).sort(function (x, y) { return x - y; });
  if (!a.length) return null;
  var m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function num_(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * 推移グラフ用。humanomeId を省くとコホートの中央値。
 * 返すのは日付軸と、指標ごとの同じ長さの配列（欠測は null）。
 */
function adminSeries(humanomeId, days) {
  requireAdmin_();
  days = Math.min(Math.max(parseInt(days, 10) || 30, 7), 90);

  var METRICS = [
    { key: 'steps',           label: '歩数',       unit: '歩'  },
    { key: 'sleep_total_min', label: '睡眠',       unit: '分'  },
    { key: 'resting_hr',      label: '安静時心拍', unit: 'bpm' }
  ];

  var hid  = String(humanomeId || '').trim();
  var axis = lastDays_(days);
  var idx  = {};
  axis.forEach(function (d, i) { idx[d] = i; });

  // 日付 → 指標 → その日の値（被験者ごと）
  var bucket = axis.map(function () { return { steps: [], sleep_total_min: [], resting_hr: [] }; });

  readSheetObjects_(dataSheet_(DATA_SHEETS.daily_summary)).forEach(function (r) {
    if (hid && String(r.humanome_id) !== hid) return;
    var i = idx[cellToIsoDate_(r.civil_date)];
    if (i === undefined) return;
    METRICS.forEach(function (m) {
      var v = num_(r[m.key]);
      if (v !== null) bucket[i][m.key].push(v);
    });
  });

  return {
    axis: axis,
    subject: hid || null,
    series: METRICS.map(function (m) {
      return {
        key: m.key, label: m.label, unit: m.unit,
        values: bucket.map(function (b) { return hid ? (b[m.key].length ? b[m.key][0] : null) : median_(b[m.key]); })
      };
    })
  };
}

/**
 * 収集カバレッジ。被験者 × 日 の格子で、その日に揃った指標の数（0〜3）を返す。
 * 「誰がいつ落ちたか」を見るためのもので、値そのものは見ない。
 */
function adminCoverage(days) {
  requireAdmin_();
  return coverageData_(days);
}

/** 実体。進捗ページ（17_Report）からも使うので権限チェックと分けてある。 */
function coverageData_(days) {
  days = Math.min(Math.max(parseInt(days, 10) || 30, 7), 90);

  var axis = lastDays_(days);
  var idx  = {};
  axis.forEach(function (d, i) { idx[d] = i; });

  var ids = Subjects.all()
    .filter(function (s) { return s.status === 'authorized'; })
    .map(function (s) { return s.humanome_id; })
    .sort();
  var pos = {};
  ids.forEach(function (id, i) { pos[id] = i; });

  var grid = ids.map(function () { return axis.map(function () { return 0; }); });

  readSheetObjects_(dataSheet_(DATA_SHEETS.daily_summary)).forEach(function (r) {
    var i = pos[String(r.humanome_id)];
    var j = idx[cellToIsoDate_(r.civil_date)];
    if (i === undefined || j === undefined) return;
    var n = 0;
    if (num_(r.steps)           !== null) n++;
    if (num_(r.resting_hr)      !== null) n++;
    if (num_(r.sleep_total_min) !== null) n++;
    grid[i][j] = n;
  });

  // 直近7日が全部 0 の被験者を上に出す。対応が要るのはそこなので。
  var order = ids.map(function (id, i) {
    var tail = grid[i].slice(-7).reduce(function (a, b) { return a + b; }, 0);
    return { id: id, row: grid[i], tail: tail };
  }).sort(function (a, b) { return a.tail - b.tail || a.id.localeCompare(b.id); });

  return {
    axis:  axis,
    ids:   order.map(function (o) { return o.id; }),
    grid:  order.map(function (o) { return o.row; }),
    maxPerDay: 3
  };
}

// ---- 被験者ごとの操作 -------------------------------------------------------
//
// 以前はエディタからしか実行できなかった。日常運用で確実に必要になるものなので
// 画面に出す。撤回だけは取り返しがつかないので、画面側で確認を取ってから呼ぶ。

/** 被験者の一覧（操作のプルダウン用）。状態も併せて返す。 */
function adminSubjectList() {
  requireAdmin_();
  return Subjects.all().map(function (s) {
    return {
      id:     s.humanome_id,
      status: String(s.status || ''),
      flag:   String(s.review_flag || ''),
      empty:  Number(s.consecutive_empty_days) || 0
    };
  }).sort(function (a, b) { return a.id.localeCompare(b.id); });
}

/** 連携が切れた被験者に新しい URL を発行する。 */
function adminReissue(humanomeId) {
  requireAdmin_();
  var url = reissueLink(String(humanomeId || '').trim());
  return '新しい URL を発行しました。本人に送ってください。\n' + url;
}

/** 同意撤回。取り返しがつかないので、画面側で確認を取ってから呼ぶこと。 */
function adminWithdraw(humanomeId) {
  requireAdmin_();
  return withdrawSubject(String(humanomeId || '').trim());
}

/** 要確認フラグを消す。人が見て問題なしと判断したとき。 */
function adminClearFlag(humanomeId) {
  requireAdmin_();
  clearReviewFlag(String(humanomeId || '').trim());
  return '要確認フラグを消しました。';
}

/** 直近ジョブの失敗ぶんだけ取り直す。 */
function adminRetryFailed() {
  requireAdmin_();
  return retryFailed();
}

/** 配布用 CSV を書き出す。 */
function adminExportCsv() {
  requireAdmin_();
  var cfgRow = readSheetObjects_(opsSheet_(OPS_SHEETS.config))[0];
  if (!cfgRow) throw new Error('config シートに行がありません');
  return exportSubjectsCsv(cfgRow.config_name);
}

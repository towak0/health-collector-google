/**
 * 17_Report.gs — 進捗ページ（研究責任者・上長向け）
 *
 * 管理画面（13_AdminUI）とは読む人も目的も違う。
 *   管理画面   … 運用担当者向け。操作ができる。毎日見る。
 *   このページ … 上長向け。読むだけ。ときどき開く。URL をブックマークして使う。
 *
 * 権限は別枠。Script Properties の REPORT_EMAILS に登録したアカウントが開ける。
 * ADMIN_EMAILS に入っている人も開ける（管理者は上位権限とみなす）。
 * 読むだけなので、取り直しや撤回といった操作の入口は一切置いていない。
 *
 * 中心に置いているのは「解析に使える被験者-日」。
 * 行数は指標にならない。1種類しか入っていない日は行としては存在するが、
 * 活動量と睡眠を突き合わせる分析には使えないため。
 */

var REPORT_CORE = ['steps', 'resting_hr', 'sleep_total_min'];

/** 閲覧者かどうか。違えば例外。 */
function requireReportViewer_() {
  var me = '';
  try { me = String(Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (e) {}
  var list = function (k) {
    return String(Props.getProperty(k) || '').split(',')
      .map(function (x) { return x.trim().toLowerCase(); }).filter(String);
  };
  var allow = list('REPORT_EMAILS').concat(list('ADMIN_EMAILS'));
  if (!me || allow.indexOf(me) < 0) {
    Audit.log('report_denied', '', me || '(anonymous)');
    throw new Error('権限がありません');
  }
  return me;
}

function renderReportPage_() {
  try { requireReportViewer_(); }
  catch (e) {
    return page_('権限がありません',
      '<p>このページは研究関係者専用です。</p>' +
      '<p class="note">担当者の方へ：Script Properties の REPORT_EMAILS に閲覧者の' +
      'アドレスを登録してください。</p>');
  }
  return HtmlService.createTemplateFromFile('ReportUI').evaluate()
    .setTitle(studyName_() + ' 進捗')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ---- google.script.run から呼ばれる関数 -----------------------------------

/** 一目で分かる部分。信号（ok / warn / bad）と数字と一文。 */
function reportSummary() {
  requireReportViewer_();
  var windowDays = 7;

  var subjects = Subjects.all();
  var byStatus = {};
  subjects.forEach(function (s) { byStatus[s.status] = (byStatus[s.status] || 0) + 1; });
  var authorized = byStatus['authorized'] || 0;

  var recentFrom = Utilities.formatDate(
    new Date(new Date().setHours(0, 0, 0, 0) - windowDays * 864e5), TZ, 'yyyy-MM-dd');

  var usable = 0, recentUsable = 0, first = '', last = '', seen = {};
  readSheetObjects_(dataSheet_(DATA_SHEETS.daily_summary)).forEach(function (r) {
    var d = cellToIsoDate_(r.civil_date);
    if (!d) return;
    if (!first || d < first) first = d;
    if (d > last) last = d;
    seen[String(r.humanome_id)] = true;
    if (coreCount_(r) === REPORT_CORE.length) {
      usable++;
      if (d >= recentFrom) recentUsable++;
    }
  });

  var denom = authorized * windowDays;
  var rate  = denom ? Math.round(recentUsable / denom * 1000) / 10 : 0;

  var pending = subjects.filter(function (s) { return s.status === 'issued'; }).length;
  var revoked = subjects.filter(function (s) { return s.status === 'revoked'; }).length;
  var stale   = subjects.filter(function (s) {
    return s.status === 'authorized' && (Number(s.consecutive_empty_days) || 0) >= 3;
  }).length;

  var attention = [];
  if (revoked) attention.push({ level: 'bad',  text: '連携が切れている被験者が ' + revoked + ' 名。URL の再発行が要ります。' });
  if (stale)   attention.push({ level: 'warn', text: '3日以上データが入っていない被験者が ' + stale + ' 名。端末の同期か装着の確認が要ります。' });
  if (pending) attention.push({ level: 'warn', text: 'まだ連携していない被験者が ' + pending + ' 名。リマインドが要ります。' });

  // 信号は「放っておくと研究が壊れるか」で決める。取得率は下がりはじめが分かれば十分。
  var level, headline;
  if (!authorized)        { level = 'warn'; headline = 'まだ誰も連携していません。配布と連携の呼びかけが次の作業です。'; }
  else if (revoked)       { level = 'bad';  headline = '連携が切れている被験者がいます。対応しないとその人のデータは増えません。'; }
  else if (rate < 50)     { level = 'bad';  headline = '直近の取得率が ' + rate + '% まで落ちています。原因の切り分けが要ります。'; }
  else if (rate < 80 || pending || stale)
                          { level = 'warn'; headline = '収集は動いていますが、対応が要るものがあります。'; }
  else                    { level = 'ok';   headline = '順調です。対応が要るものはありません。'; }

  return {
    studyName: studyName_(),
    level: level, headline: headline, attention: attention,
    usableDays: usable, recentRate: rate,
    authorized: authorized, issued: byStatus['issued'] || 0,
    withdrawn: byStatus['withdrawn'] || 0, total: subjects.length,
    subjectsWithData: Object.keys(seen).length,
    firstDate: first || '—', lastDate: last || '—',
    updatedAt: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm')
  };
}

function coreCount_(r) {
  var n = 0;
  REPORT_CORE.forEach(function (k) {
    var v = r[k];
    if (v !== '' && v !== null && v !== undefined && isFinite(Number(v))) n++;
  });
  return n;
}

/**
 * 推移2本。
 *   rate       … その日に3種そろった被験者の割合（連携済み人数が分母）
 *   cumulative … 解析に使える被験者-日の累計
 * 分母は現在の連携済み人数で固定している。過去にさかのぼって人数を復元できないため、
 * 連携者が増えた直後は過去の率が低めに出る。傾きを見るための線と考える。
 */
function reportTrend(days) {
  requireReportViewer_();
  days = Math.min(Math.max(parseInt(days, 10) || 30, 7), 90);

  var axis = lastDays_(days), idx = {};
  axis.forEach(function (d, i) { idx[d] = i; });

  var authorized = Subjects.all().filter(function (s) { return s.status === 'authorized'; }).length;
  var perDay = axis.map(function () { return 0; });
  var before = 0;   // 期間より前の分（累計の起点）

  readSheetObjects_(dataSheet_(DATA_SHEETS.daily_summary)).forEach(function (r) {
    if (coreCount_(r) !== REPORT_CORE.length) return;
    var d = cellToIsoDate_(r.civil_date);
    if (!d) return;
    var i = idx[d];
    if (i === undefined) { if (d < axis[0]) before++; return; }
    perDay[i]++;
  });

  var cum = [], run = before;
  perDay.forEach(function (n) { run += n; cum.push(run); });

  return {
    axis: axis,
    authorized: authorized,
    rate: perDay.map(function (n) { return authorized ? Math.round(n / authorized * 1000) / 10 : null; }),
    cumulative: cum
  };
}

/** カバレッジ格子。管理画面と同じ中身を閲覧権限で返す。 */
function reportCoverage(days) {
  requireReportViewer_();
  return coverageData_(days);
}

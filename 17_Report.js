/**
 * 17_Report.gs — 進捗の判定
 *
 * 管理画面の最上段に出す「信号」を作る。
 *
 * 当初は上長向けに別ページ（?report=1）を用意したが、運用担当と上長の2人しか
 * おらず、操作権限も両方に与えてよいため1画面に統合した。
 * 違うのは読む深さだけなので、最初の3行で結論が分かるようにしてある。
 *
 * 中心に置いているのは「解析に使える被験者-日」。
 * 行数は指標にならない。1種類しか入っていない日は行としては存在するが、
 * 活動量と睡眠を突き合わせる分析には使えないため。
 */

var REPORT_CORE = ['steps', 'resting_hr', 'sleep_total_min'];

// ---- google.script.run から呼ばれる関数 -----------------------------------

/** 一目で分かる部分。信号（ok / warn / bad）と数字と一文。 */
function reportSummary() {
  requireAdmin_();
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

  // 信号は「放っておくと研究が壊れるか」で決める。
  // 配布前・配布途中は取得率で赤を出さない。母数が揃う前の率は意味を持たず、
  // ここで赤を出すと本番で赤が出たときに信用されなくなる。
  var distributing = pending > authorized;
  var level, headline;
  if (!authorized)        { level = 'warn'; headline = 'まだ誰も連携していません。配布と連携の呼びかけが次の作業です。'; }
  else if (revoked)       { level = 'bad';  headline = '連携が切れている被験者がいます。対応しないとその人のデータは増えません。'; }
  else if (distributing)  { level = 'warn'; headline = '配布がまだ途中です（連携 ' + authorized + ' 名 / 未連携 ' + pending +
                                                       ' 名）。この段階の取得率は参考値です。'; }
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
  requireAdmin_();
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

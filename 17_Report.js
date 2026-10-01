/**
 * 17_Report.gs — 進捗報告（研究責任者・上長向け）
 *
 * 日次ダイジェスト（10_Alerts）とは読む人も目的も違う。
 *   日次ダイジェスト … 運用担当者向け。「今日やること」。毎朝届く。
 *   この進捗報告     … 上長向け。「順調か、いつ解析に入れるか」。週1回。
 *
 * 宛先は Script Properties の REPORT_EMAIL。未設定なら ALERT_EMAIL に送る。
 * 日次の細かい通知を上長に流さないよう、別プロパティにしている。
 *
 * 中心に置いているのは「解析に使える被験者-日」。
 * 行数は指標にならない。1種類しか入っていない日は行としては存在するが、
 * 活動量と睡眠を突き合わせる分析には使えないため。
 */

var REPORT_CORE = ['steps', 'resting_hr', 'sleep_total_min'];

function sendProgressReport() { Report.send(7); }

var Report = {

  /** 直近 windowDays 日を「最近」として集計し、全期間の累計と併せて1通にする。 */
  send: function (windowDays) {
    windowDays = windowDays || 7;
    var to = prop_('REPORT_EMAIL', false) || prop_('ALERT_EMAIL');
    if (!to) { slog_('WARNING', 'report_no_recipient', {}); return; }

    var m = Report.collect(windowDays);
    var L = [];

    L.push(m.studyName + ' 進捗報告  ' + isoDate_(new Date()));
    L.push('');
    L.push('【結論】');
    L.push('  ' + m.headline);
    L.push('');

    L.push('【蓄積】');
    L.push('  解析に使える被験者-日   ' + m.usableDays.toLocaleString() + ' 日分');
    L.push('    （活動量・心拍・睡眠が3つとも揃った日の、被験者ごとの合計）');
    L.push('  収集期間               ' + (m.firstDate || '—') + ' 〜 ' + (m.lastDate || '—'));
    L.push('  記録のある被験者        ' + m.subjectsWithData + ' 名');
    L.push('');

    L.push('【被験者】');
    L.push('  連携済み               ' + m.authorized + ' 名');
    L.push('  未連携                 ' + m.issued + ' 名');
    L.push('  撤回                   ' + m.withdrawn + ' 名');
    L.push('  合計                   ' + m.total + ' 名');
    L.push('');

    L.push('【直近' + windowDays + '日の取得率】');
    L.push('  ' + m.recentRate + '%  （連携済み ' + m.authorized + ' 名 × ' + windowDays +
           ' 日 のうち、3つとも揃った ' + m.recentUsable + ' 日分）');
    L.push('  この数字が下がっているときは、装着の中断か端末の同期停止が起きている。');
    L.push('');

    if (m.attention.length) {
      L.push('【対応が要るもの】');
      m.attention.forEach(function (a) { L.push('  ・' + a); });
      L.push('');
    } else {
      L.push('【対応が要るもの】');
      L.push('  なし');
      L.push('');
    }

    L.push('---');
    L.push('この報告は毎週自動で送信しています。');
    L.push('内訳や個別の状況は管理画面で確認できます。');

    MailApp.sendEmail({
      to: to,
      subject: '[' + m.studyName + '] 進捗報告 ' + isoDate_(new Date()) +
               (m.attention.length ? '（要対応 ' + m.attention.length + ' 件）' : ''),
      body: L.join('\n')
    });
    slog_('INFO', 'report_sent', { usableDays: m.usableDays, rate: m.recentRate });
  },

  /** 数字をまとめて作る。画面やテストから使えるよう送信と分けてある。 */
  collect: function (windowDays) {
    var subjects = Subjects.all();
    var byStatus = {};
    subjects.forEach(function (s) { byStatus[s.status] = (byStatus[s.status] || 0) + 1; });
    var authorized = byStatus['authorized'] || 0;

    var recentFrom = Utilities.formatDate(
      new Date(new Date().setHours(0, 0, 0, 0) - windowDays * 864e5), TZ, 'yyyy-MM-dd');

    var usable = 0, recentUsable = 0, first = '', last = '';
    var seen = {};

    readSheetObjects_(dataSheet_(DATA_SHEETS.daily_summary)).forEach(function (r) {
      var d = cellToIsoDate_(r.civil_date);
      if (!d) return;
      if (!first || d < first) first = d;
      if (d > last) last = d;
      seen[String(r.humanome_id)] = true;

      var n = 0;
      REPORT_CORE.forEach(function (k) {
        var v = r[k];
        if (v !== '' && v !== null && v !== undefined && isFinite(Number(v))) n++;
      });
      if (n === REPORT_CORE.length) {
        usable++;
        if (d >= recentFrom) recentUsable++;
      }
    });

    var denom = authorized * windowDays;
    var rate  = denom ? Math.round(recentUsable / denom * 1000) / 10 : 0;

    var attention = [];
    var pending = subjects.filter(function (s) { return s.status === 'issued'; }).length;
    var revoked = subjects.filter(function (s) { return s.status === 'revoked'; }).length;
    var stale   = subjects.filter(function (s) {
      return s.status === 'authorized' && (Number(s.consecutive_empty_days) || 0) >= 3;
    }).length;
    if (pending) attention.push('未連携が ' + pending + ' 名。リマインドが要る。');
    if (revoked) attention.push('連携が切れているのが ' + revoked + ' 名。URL の再発行が要る。');
    if (stale)   attention.push('3日以上データが入っていないのが ' + stale + ' 名。端末の同期か装着の確認が要る。');

    var headline;
    if (!authorized)        headline = 'まだ誰も連携していない。配布と連携の呼びかけが次の作業。';
    else if (!usable)       headline = '連携は始まっているが、まだ解析に使えるデータが溜まっていない。';
    else if (rate >= 80)    headline = '順調。' + usable.toLocaleString() + ' 日分が蓄積済み、直近の取得率も ' + rate + '%。';
    else if (rate >= 50)    headline = '収集は動いているが取得率が ' + rate + '% に留まっている。装着の継続状況を確認したい。';
    else                    headline = '取得率が ' + rate + '% まで落ちている。原因の切り分けが要る。';

    return {
      studyName: String(Props.getProperty('STUDY_NAME') || 'HealthStudy'),
      total: subjects.length, authorized: authorized,
      issued: byStatus['issued'] || 0, withdrawn: byStatus['withdrawn'] || 0,
      subjectsWithData: Object.keys(seen).length,
      usableDays: usable, recentUsable: recentUsable, recentRate: rate,
      firstDate: first, lastDate: last,
      attention: attention, headline: headline
    };
  }
};

/** 送信せずに中身だけ確認する（エディタから実行してログで見る）。 */
function previewProgressReport() {
  var m = Report.collect(7);
  Logger.log(JSON.stringify(m, null, 2));
  return m;
}

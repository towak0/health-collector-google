/**
 * 16_Diagnose.gs — 「なぜデータが入っていないのか」を自動で切り分ける
 *
 * 欠測には理由がいくつもあり、見分けないと対応を間違える。
 *   連携が切れている  → 再連携の依頼が必要（こちらの作業）
 *   同期が止まっている → アプリを開いてもらう（本人の作業。データは端末に残っている）
 *   着けていない       → 装着のお願い（データは存在しない）
 *   電池切れ           → 充電のお願い
 *
 * 追加の API 呼び出しはしない。既に毎日取っている daily_summary と devices から判定する。
 */

var DIAG_WINDOW_DAYS = 3;     // 直近何日を見るか
var DIAG_STALE_DAYS  = 2;     // 同期が何日途切れたら「未同期」とみなすか
var DIAG_LOW_BATTERY = 20;    // 電池残量の警告水準（%）

/**
 * 連携済みの被験者ごとに状態を判定して返す。
 * [{humanome_id, level, label, detail, lastSync, battery, days:{...}}]
 *   level: ok / info / warn / bad
 */
function diagnoseSubjects() {
  var today = isoDate_(new Date());
  var from  = isoDate_(daysAgo_(DIAG_WINDOW_DAYS));

  // 直近 N 日の daily_summary を被験者ごとに集める
  var rows = readSheetObjects_(dataSheet_(DATA_SHEETS.daily_summary));
  var byId = {};
  rows.forEach(function (r) {
    var d = cellToIsoDate_(r.civil_date);
    if (!d || d < from) return;
    var id = String(r.humanome_id);
    (byId[id] = byId[id] || []).push({
      date:  d,
      steps: toNum_(r.steps) || 0,
      hr:    toNum_(r.hr_avg) || toNum_(r.resting_hr) || 0,
      sleep: toNum_(r.sleep_total_min) || 0
    });
  });

  // 端末情報（最終同期・電池）を被験者ごとに、いちばん新しいものだけ
  var dev = {};
  try {
    readSheetObjects_(dataSheet_(DATA_SHEETS.devices)).forEach(function (r) {
      var id = String(r.humanome_id);
      var sync = String(r.last_sync_at || '');
      if (!dev[id] || sync > dev[id].lastSync) {
        dev[id] = {
          lastSync: sync,
          battery:  toNum_(r.battery),
          model:    String(r.model || '')
        };
      }
    });
  } catch (e) {}

  return Subjects.all()
    .filter(function (s) { return s.status === 'authorized' || s.status === 'revoked'; })
    .map(function (s) {
      var id = s.humanome_id;
      var d  = byId[id] || [];
      var withSteps = d.filter(function (x) { return x.steps > 0; }).length;
      var withHr    = d.filter(function (x) { return x.hr    > 0; }).length;
      var withSleep = d.filter(function (x) { return x.sleep > 0; }).length;
      var dv = dev[id] || {};
      var syncDate = String(dv.lastSync || '').substring(0, 10);
      var syncAge  = syncDate ? diffDays_(today, syncDate) : null;

      var r = diagnose_(s, d.length, withSteps, withHr, withSleep, syncAge, dv.battery);
      return {
        humanome_id: id,
        level:  r.level,
        label:  r.label,
        detail: r.detail,
        lastSync: syncDate || '',
        syncAge:  syncAge === null ? '' : syncAge,
        battery:  (dv.battery === '' || dv.battery === undefined) ? '' : dv.battery,
        model:    dv.model || '',
        days: { total: d.length, steps: withSteps, hr: withHr, sleep: withSleep }
      };
    })
    // 問題があるものを先に
    .sort(function (a, b) {
      var rank = { bad: 0, warn: 1, info: 2, ok: 3 };
      return rank[a.level] - rank[b.level];
    });
}

/**
 * 判定の本体。上から順に見て、最初に当てはまったものを返す。
 * 順番が意味を持つ（連携切れが最優先、正常が最後）。
 */
function diagnose_(s, nDays, withSteps, withHr, withSleep, syncAge, battery) {
  if (s.status === 'revoked') {
    return { level: 'bad', label: '連携切れ',
             detail: 'reissueLink で新しいリンクを発行し、再連携を依頼してください' };
  }

  if (battery !== '' && battery !== undefined && battery < DIAG_LOW_BATTERY && withHr === 0) {
    return { level: 'bad', label: '電池切れの可能性',
             detail: '残量 ' + battery + '%。充電を依頼してください' };
  }

  if (syncAge !== null && syncAge >= DIAG_STALE_DAYS && withSteps === 0) {
    return { level: 'bad', label: '同期が止まっている',
             detail: syncAge + '日間クラウドに上がっていません。' +
                     'スマホのアプリを開いてもらえば、溜まっているぶんが送られます' };
  }

  if (nDays === 0) {
    return { level: 'bad', label: 'データなし',
             detail: '直近' + DIAG_WINDOW_DAYS + '日ぶんが1件もありません' };
  }

  // 歩数はあるのに心拍がない＝歩数はスマホ由来で、時計を着けていない
  if (withSteps > 0 && withHr === 0) {
    return { level: 'warn', label: '時計を着けていない可能性',
             detail: '歩数はスマホから入っていますが、心拍が' + DIAG_WINDOW_DAYS +
                     '日間ありません。装着を依頼してください' };
  }

  if (withHr > 0 && withSleep === 0) {
    return { level: 'info', label: '就寝時に外している可能性',
             detail: '日中の心拍はありますが、睡眠が' + DIAG_WINDOW_DAYS + '日間ありません' };
  }

  if (battery !== '' && battery !== undefined && battery < DIAG_LOW_BATTERY) {
    return { level: 'info', label: '電池残量が少ない',
             detail: '残量 ' + battery + '%' };
  }

  if (withSteps < nDays || withHr < nDays) {
    return { level: 'info', label: '一部の日が欠測',
             detail: nDays + '日中 歩数' + withSteps + '日 / 心拍' + withHr + '日' };
  }

  return { level: 'ok', label: '正常', detail: '' };
}

/** 日次ダイジェストに差し込むテキスト。 */
function diagnoseDigestLines_() {
  var d = diagnoseSubjects().filter(function (x) { return x.level !== 'ok'; });
  if (!d.length) return ['● データ状況: 全員正常', ''];

  var lines = ['● 対応が要るかもしれない被験者: ' + d.length + ' 名'];
  d.slice(0, 40).forEach(function (x) {
    lines.push('   - ' + x.humanome_id + '  [' + x.label + ']  ' + x.detail);
  });
  lines.push('');
  return lines;
}

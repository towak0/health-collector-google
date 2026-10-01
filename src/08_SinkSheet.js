/**
 * 08_SinkSheet.gs — シート書き込み（upsert）とログ
 *
 * 書き込みは必ず1回の setValues にまとめる。appendRow のループは桁違いに遅い。
 */

// ---- 監査ログ / 取得ログ --------------------------------------------------

var Audit = {
  log: function (event, humanomeId, detail) {
    try {
      var sh = opsSheet_(OPS_SHEETS.audit);
      sh.appendRow([nowIso_(), String(event), String(humanomeId || ''), redact_(detail)]);
    } catch (e) { /* 監査ログの失敗で本処理を止めない */ }
    slog_('INFO', event, { humanome_id: humanomeId || '', detail: redact_(detail) });
  }
};

var IngestLog = (function () {
  var buffer = [];

  return {
    /** バッファに積む。flush() でまとめて書く。 */
    record: function (jobId, meta, httpCode, nPoints, ms, error) {
      buffer.push([
        jobId,
        nowIso_(),
        meta.humanome_id || '',
        meta.dt ? meta.dt.key : '',
        (meta.from || '') + '..' + (meta.to || ''),
        (httpCode === 200 || httpCode === 404) ? 'ok' : 'failed',
        httpCode || '',
        nPoints || 0,
        ms || 0,
        redact_(error || '')
      ]);
      if (buffer.length >= 500) this.flush();
    },

    flush: function () {
      if (!buffer.length) return;
      try {
        var sh = opsSheet_(OPS_SHEETS.ingest_log);
        sh.getRange(sh.getLastRow() + 1, 1, buffer.length, COL_INGEST_LOG.length).setValues(buffer);
      } catch (e) {
        slog_('ERROR', 'ingest_log_flush_failed', { detail: redact_(String(e)) });
      }
      buffer = [];
    },

    /** 前日ジョブの失敗行を取り出す（翌日の頭の再試行・ダイジェスト用）。 */
    failedOf: function (jobId) {
      return readSheetObjects_(opsSheet_(OPS_SHEETS.ingest_log)).filter(function (r) {
        return String(r.job_id) === String(jobId) && String(r.status) === 'failed';
      });
    }
  };
})();

// ---- レスポンス → 行への変換 ---------------------------------------------

/**
 * parsed（[{meta, body}]）を daily_summary / sleep / Drive 用に仕分けて書き込む。
 * 同じ (humanome_id, civil_date) に複数データ型が寄与するので、いったん Map に集約してから
 * 1回の upsert にまとめる。
 */
var Sink = {
  flush: function (jobId, parsed) {
    var daily    = {};   // "hid|date" → 行オブジェクト
    var sessions = [];
    var stages   = [];
    var rawByKey = {};   // "hid|date|dataType" → intraday レコード配列
    var touched  = {};   // hid → データが1点でもあったか

    parsed.forEach(function (item) {
      var meta = item.meta, dt = meta.dt, hid = meta.humanome_id;
      var points = extractPoints_(item.body);
      if (points.length) touched[hid] = true;
      else if (touched[hid] === undefined) touched[hid] = false;

      if (dt.method === 'dailyRollUp') {
        collectDailyRollUp_(daily, hid, dt, points, jobId);
      } else if (dt.method === 'rollUp') {
        collectIntraday_(rawByKey, hid, dt, points);
      } else if (dt.id === 'sleep') {
        collectSleep_(daily, sessions, stages, hid, points, jobId, meta);
      } else if (DAILY_LIST_MAP[dt.id]) {
        collectDailyList_(daily, hid, dt, points, jobId);
      } else {
        slog_('WARNING', 'unhandled_datatype', { data_type: dt.key });
      }
    });

    var dailyRows = Object.keys(daily).map(function (k) { return daily[k]; });
    if (dailyRows.length) upsertDailySummary_(dailyRows);
    if (sessions.length)  upsertByKey_(dataSheet_(DATA_SHEETS.sleep_sessions), COL_SLEEP_SESSIONS, sessions, 'dedupe_key');
    if (stages.length)    upsertByKey_(dataSheet_(DATA_SHEETS.sleep_stages),   COL_SLEEP_STAGES,   stages,   'dedupe_key');

    Object.keys(rawByKey).forEach(function (k) {
      var p = k.split('|');
      SinkDrive.writeRaw(p[0], p[1], p[2], rawByKey[k]);
    });

    Object.keys(touched).forEach(function (hid) {
      Subjects.recordSuccess(hid, touched[hid]);
    });

    IngestLog.flush();
  }
};

function dailyRow_(map, hid, date, jobId) {
  var k = hid + '|' + date;
  if (!map[k]) map[k] = { humanome_id: hid, civil_date: date, source_job_id: jobId, updated_at: nowIso_() };
  return map[k];
}

function collectDailyRollUp_(map, hid, dt, points, jobId) {
  var specs = ROLLUP_EXTRACT[dt.id];
  if (!specs) { slog_('WARNING', 'no_rollup_extract', { data_type: dt.id }); return; }

  points.forEach(function (pt) {
    var date = civilToIso_(pt.civilStartTime || pt.civilTime || pt.startTime);
    if (!date) return;
    var row = dailyRow_(map, hid, date, jobId);
    var value = pt.value || pt;

    specs.forEach(function (spec) {
      var env = null;
      for (var i = 0; i < spec.envelopes.length && !env; i++) env = value[spec.envelopes[i]];
      if (!env) return;
      var v = pickField_(env, spec.fields);
      if (v === null) {
        // 候補が全部外れた＝フィールド名が想定と違う。黙って欠測にせず気づけるようにする（§16-3）
        slog_('WARNING', 'unmapped_rollup_field', {
          data_type: dt.id, column: spec.column, keys: Object.keys(env).join(',')
        });
        return;
      }
      var num = toNum_(typeof v === 'object' ? pickField_(v, ['value', 'amount']) : v);
      if (num !== '' && spec.scale) num = num * spec.scale;   // 単位換算（mm → m など）
      row[spec.column] = num;
    });
  });
}

function collectDailyList_(map, hid, dt, points, jobId) {
  var spec = DAILY_LIST_MAP[dt.id];
  points.forEach(function (pt) {
    var env = pt[spec.envelope] || pt;
    var date = civilToIso_(env.date || pt.civilStartTime) ||
               tsToLocalDate_(env.time || pt.startTime);
    if (!date) return;
    var row = dailyRow_(map, hid, date, jobId);

    spec.extract.forEach(function (e) {
      var v = pickField_(env, e.fields);
      if (v === null) {
        // 第一候補以外が全部外れたときだけ警告（任意項目は静かに欠測でよい）
        if (!e.optional) {
          slog_('WARNING', 'unmapped_list_field', {
            data_type: dt.id, column: e.column, keys: Object.keys(env).join(',')
          });
        }
        return;
      }
      row[e.column] = toNum_(typeof v === 'object'
        ? pickField_(v, ['value', 'amount', 'milliseconds']) : v);
    });
  });
}

/** 睡眠セッション（§5.6）。日次サマリのステージ合計もここで埋める。 */
function collectSleep_(map, sessions, stages, hid, points, jobId, meta) {
  points.forEach(function (pt) {
    var sleep = pt.sleep || pt;
    var iv    = sleep.interval || {};
    var start = iv.startTime || sleep.startTime;
    var end   = iv.endTime   || sleep.endTime;
    if (!start || !end) return;

    var date = tsToLocalDate_(end);   // 起床日をその睡眠の civil_date とする
    // ★ sleep は API 側でフィルタできないため、ここで対象期間外を捨てる
    if (meta && meta.from && date < meta.from) return;
    if (meta && meta.to   && date > meta.to)   return;
    var sid  = String(pt.name || sleep.sessionId || pt.dataPointId ||
                      sha256Hex_(hid + '|' + start + '|' + end).substring(0, 16));
    var dedupe = sha256Hex_(hid + '|sleep|' + start + '|' + end);

    var per = { DEEP: 0, LIGHT: 0, REM: 0, AWAKE: 0 };
    var list = sleep.stages || [];
    list.forEach(function (st, i) {
      var m = minutesBetween_(st.startTime, st.endTime);
      var type = String(st.type || st.stageType || '').toUpperCase();
      if (per[type] !== undefined && m !== '') per[type] += m;
      stages.push({
        humanome_id: hid, session_id: sid, stage_index: i, stage_type: type,
        start_at: st.startTime || '', end_at: st.endTime || '', duration_min: m,
        dedupe_key: sha256Hex_(dedupe + '|' + i + '|' + (st.startTime || ''))
      });
    });

    var total = minutesBetween_(start, end);
    sessions.push({
      humanome_id: hid, civil_date: date, session_id: sid,
      start_at: start, end_at: end, duration_min: total,
      deep_min: per.DEEP, light_min: per.LIGHT, rem_min: per.REM, awake_min: per.AWAKE,
      short_awakenings: (sleep.shortAwakenings || []).length,
      minutes_to_fall_asleep: toNum_(sleep.minutesToFallAsleep),
      minutes_after_wakeup:   toNum_(sleep.minutesAfterWakeup),
      dedupe_key: dedupe, updated_at: nowIso_()
    });

    var row = dailyRow_(map, hid, date, jobId);
    row.sleep_total_min = (toNum_(row.sleep_total_min) || 0) + (total || 0);
    Object.keys(SLEEP_STAGE_TO_COLUMN).forEach(function (k) {
      var col = SLEEP_STAGE_TO_COLUMN[k];
      row[col] = (toNum_(row[col]) || 0) + per[k];
    });
  });
}

/** 心拍 intraday。スプレッドシートには絶対に入れない（§8.4）。日付ごとに束ねて Drive へ。 */
function collectIntraday_(rawByKey, hid, dt, points) {
  points.forEach(function (pt) {
    var start = pt.startTime || (pt.interval && pt.interval.startTime);
    if (!start) return;
    var date = tsToLocalDate_(start);
    var k = hid + '|' + date + '|' + dt.id;
    if (!rawByKey[k]) rawByKey[k] = [];
    rawByKey[k].push(pt);
  });
}

// ---- upsert ---------------------------------------------------------------

/** (humanome_id, civil_date) で upsert（§9.5a）。同じ日を何度取得しても行数は増えない。 */
function upsertDailySummary_(rows) {
  var sh   = dataSheet_(DATA_SHEETS.daily_summary);
  var last = sh.getLastRow();
  var W    = COL_DAILY_SUMMARY.length;

  // 既存キー→行番号の索引を1回の読み取りで作る（36,500行でも数百ms）
  var idx = {};
  var existing = {};
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, W).getValues();
    for (var i = 0; i < vals.length; i++) {
      var k = vals[i][0] + '|' + cellToIsoDate_(vals[i][1]);
      idx[k] = i + 2;
      existing[k] = vals[i];
    }
  }

  var appends = [], updates = [];
  rows.forEach(function (r) {
    var k = r.humanome_id + '|' + cellToIsoDate_(r.civil_date);
    var base = existing[k] || null;
    var arr = COL_DAILY_SUMMARY.map(function (c, j) {
      if (r[c] !== undefined && r[c] !== null && r[c] !== '') return r[c];
      // 今回そのデータ型を取っていない列は、既存値を保持する（部分更新で欠測にしない）
      return base ? base[j] : '';
    });
    if (idx[k]) updates.push({ row: idx[k], values: arr });
    else        appends.push(arr);
  });

  // civil_date 列は必ず「書式なしテキスト」にする（日付型に化けるとキー照合が壊れる）
  sh.getRange(1, 2, sh.getMaxRows(), 1).setNumberFormat('@');

  updates.forEach(function (u) { sh.getRange(u.row, 1, 1, W).setValues([u.values]); });
  if (appends.length) {
    ensureRows_(sh, last + appends.length);
    sh.getRange(last + 1, 1, appends.length, W).setValues(appends);
  }
}

/**
 * civil_date が日付型で書かれてしまった既存行を文字列に直し、重複行を1本にまとめる。
 * 手動で1回だけ実行する復旧用。
 */
function repairDailySummary() {
  var sh = dataSheet_(DATA_SHEETS.daily_summary);
  var last = sh.getLastRow(), W = COL_DAILY_SUMMARY.length;
  if (last < 2) return { merged: 0, rows: 0 };

  var vals = sh.getRange(2, 1, last - 1, W).getValues();
  var byKey = {}, order = [];
  vals.forEach(function (v) {
    v[1] = cellToIsoDate_(v[1]);
    var k = v[0] + '|' + v[1];
    if (!byKey[k]) { byKey[k] = v; order.push(k); return; }
    // 後勝ちだが、空セルは既存値を残す
    var prev = byKey[k];
    for (var j = 0; j < W; j++) if (v[j] !== '' && v[j] !== null) prev[j] = v[j];
  });

  var out = order.map(function (k) { return byKey[k]; });
  sh.getRange(2, 1, last - 1, W).clearContent();
  sh.getRange(1, 2, sh.getMaxRows(), 1).setNumberFormat('@');
  if (out.length) sh.getRange(2, 1, out.length, W).setValues(out);
  return { before: vals.length, after: out.length };
}

/** dedupe_key で upsert（セッション系。§9.5b） */
function upsertByKey_(sh, cols, rows, keyCol) {
  var last  = sh.getLastRow();
  var W     = cols.length;
  var keyAt = cols.indexOf(keyCol);
  // civil_date 列があればテキスト書式に固定する（Sheets の日付型化を防ぐ）
  var dateAt = cols.indexOf('civil_date');
  if (dateAt >= 0) sh.getRange(1, dateAt + 1, sh.getMaxRows(), 1).setNumberFormat('@');
  var idx   = {};
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, W).getValues();
    for (var i = 0; i < vals.length; i++) idx[vals[i][keyAt]] = i + 2;
  }

  var appends = [], updates = [], seen = {};
  rows.forEach(function (r) {
    var k = r[keyCol];
    if (seen[k]) return;   // 同一ジョブ内の重複（ページ境界の再送など）
    seen[k] = true;
    var arr = cols.map(function (c) { return (r[c] !== undefined && r[c] !== null) ? r[c] : ''; });
    if (idx[k]) updates.push({ row: idx[k], values: arr });
    else        appends.push(arr);
  });


  updates.forEach(function (u) { sh.getRange(u.row, 1, 1, W).setValues([u.values]); });
  if (appends.length) {
    ensureRows_(sh, last + appends.length);
    sh.getRange(last + 1, 1, appends.length, W).setValues(appends);
  }
}



/** 週次のデバイス情報を upsert（(humanome_id, device_id) キー）。 */
function upsertDevices_(rows) {
  var sh = dataSheet_(DATA_SHEETS.devices);
  var W  = COL_DEVICES.length;
  var last = sh.getLastRow();
  var idx = {};
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, W).getValues();
    for (var i = 0; i < vals.length; i++) idx[vals[i][0] + '|' + vals[i][1]] = i + 2;
  }
  var appends = [], updates = [];
  rows.forEach(function (r) {
    var k = r.humanome_id + '|' + r.device_id;
    var arr = COL_DEVICES.map(function (c) { return r[c] !== undefined ? r[c] : ''; });
    if (idx[k]) updates.push({ row: idx[k], values: arr });
    else        appends.push(arr);
  });

  updates.forEach(function (u) { sh.getRange(u.row, 1, 1, W).setValues([u.values]); });
  if (appends.length) {
    ensureRows_(sh, last + appends.length);
    sh.getRange(last + 1, 1, appends.length, W).setValues(appends);
  }
}




/**
 * シートの行数が足りなければ拡張する。
 *
 * ★ 新規シートは既定 1000 行しかなく、範囲を超えた setValues は例外で落ちる。
 *   95名なら daily_summary は約10日、sleep_stages は1日未満で 1000 行に達するので、
 *   配布前にこの処理が入っていないと本番初週で必ず止まる。
 */
function ensureRows_(sh, needed) {
  var max = sh.getMaxRows();
  if (needed <= max) return;
  sh.insertRowsAfter(max, Math.max(needed - max, 1000));   // まとめて足す（毎回の呼び出しを避ける）
}
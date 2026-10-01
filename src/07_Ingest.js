/**
 * 07_Ingest.gs — 日次ジョブ本体・継続実行・カーソル
 *
 * 6分制限への対処（§9.2）は3点セット：
 *   LockService（二重起動防止）+ カーソル（再開点）+ ワンショットトリガー（継続）
 *
 * カーソルは軽く作るのが肝。100被験者×10データ型のキューを JSON 化すると 50KB 超になり、
 * Properties の 9KB/値上限を超えて保存に失敗する。保存するのは進捗インデックスだけにし、
 * 対象リストは毎回シートから決定的順序で再生成する。
 */
var Ingest = {

  /** 認可直後に過去90日のバックフィルを予約する。 */
  enqueueBackfill: function (configName, humanomeId) {
    var key = configName + '|' + humanomeId;
    var cur = String(Props.getProperty(BACKFILL_QUEUE_KEY) || '').split(',').filter(String);
    if (cur.indexOf(key) < 0) {
      cur.push(key);
      Props.setProperty(BACKFILL_QUEUE_KEY, cur.join(','));
    }
    ensureBackfillTrigger_();
  }
};

// ---- 週次キャッチアップ ---------------------------------------------------

/**
 * 毎週月曜 00:00。直近7日分をまるごと取り直す（§9.5）。
 *
 * 日次ジョブは「3日前〜昨日」しか見ないので、被験者がスマホと4日以上同期しなかった
 * 期間のデータは日次だけでは永久に埋まらない。週1回だけ窓を7日に広げて取りこぼしを回収する。
 * upsert なので、既に入っている日は上書きされるだけで行は増えない。
 *
 * 6分制限の扱いは日次ジョブと同じ（カーソル + ワンショットトリガーで継続）。
 */
function runWeeklyCatchup() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { slog_('INFO', 'catchup_already_running', {}); return; }
  var started = Date.now();

  try {
    cleanupOneOffTriggers_('runWeeklyCatchup');

    var cur = loadCursor_(WEEKLY_CURSOR_KEY);
    if (!cur) {
      cur = {
        job_id: 'wk-' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss'),
        from:   isoDate_(daysAgo_(WEEKLY_CATCHUP_DAYS)),
        to:     isoDate_(daysAgo_(1)),
        offset: 0
      };
      saveCursor_(WEEKLY_CURSOR_KEY, cur);
    }

    var subjects = Subjects.listActive();
    var types    = DataTypes.listEnabled();

    while (cur.offset < subjects.length) {
      if (Date.now() - started > SOFT_DEADLINE_MS) {
        saveCursor_(WEEKLY_CURSOR_KEY, cur);
        scheduleContinuation_('runWeeklyCatchup');
        slog_('INFO', 'catchup_deferred', { offset: cur.offset, total: subjects.length });
        return;
      }

      var chunk = subjects.slice(cur.offset, cur.offset + SUBJECT_CHUNK);
      try {
        processChunk_(cur.job_id, cur, chunk, types);
      } catch (e) {
        if (e.name === 'FatalConfigError') {
          clearCursor_(WEEKLY_CURSOR_KEY);
          IngestLog.flush();
          Alerts.fatal('設定エラーにより週次キャッチアップを中断しました: ' + e.config + ' / ' + e.detail);
          return;
        }
        throw e;
      }

      cur.offset += chunk.length;
      saveCursor_(WEEKLY_CURSOR_KEY, cur);
    }

    IngestLog.flush();
    clearCursor_(WEEKLY_CURSOR_KEY);
    slog_('INFO', 'catchup_completed', {
      job_id: cur.job_id, range: cur.from + '..' + cur.to, subjects: subjects.length
    });

  } finally {
    IngestLog.flush();
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ---- 日次ジョブ -----------------------------------------------------------

function runDailyIngest() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { slog_('INFO', 'ingest_already_running', {}); return; }
  var started = Date.now();

  try {
    cleanupOneOffTriggers_('runDailyIngest');   // 20トリガー上限に当たらないよう毎回掃除

    var cur = loadCursor_(CURSOR_KEY);
    if (!cur) {
      cur = {
        job_id: Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss'),
        from:   isoDate_(daysAgo_(LOOKBACK_DAYS)),
        to:     isoDate_(daysAgo_(1)),
        offset: 0
      };
      saveCursor_(CURSOR_KEY, cur);   // 約160バイト。9KB 上限に余裕
    }

    var subjects = Subjects.listActive();   // 行順＝処理順。決定的
    var types    = DataTypes.listEnabled();

    while (cur.offset < subjects.length) {
      if (Date.now() - started > SOFT_DEADLINE_MS) {
        saveCursor_(CURSOR_KEY, cur);
        scheduleContinuation_('runDailyIngest');
        slog_('INFO', 'ingest_deferred', { offset: cur.offset, total: subjects.length });
        return;
      }

      var chunk = subjects.slice(cur.offset, cur.offset + SUBJECT_CHUNK);
      try {
        processChunk_(cur.job_id, cur, chunk, types);
      } catch (e) {
        if (e.name === 'FatalConfigError') {
          clearCursor_(CURSOR_KEY);
          IngestLog.flush();
          Alerts.fatal('設定エラーによりジョブを中断しました: ' + e.config + ' / ' + e.detail);
          return;
        }
        throw e;
      }

      cur.offset += chunk.length;
      saveCursor_(CURSOR_KEY, cur);   // 途中クラッシュしても25人単位で再開
    }

    IngestLog.flush();
    clearCursor_(CURSOR_KEY);
    Props.setProperty('last_job_id', cur.job_id);
    slog_('INFO', 'ingest_completed', { job_id: cur.job_id, subjects: subjects.length });

  } finally {
    IngestLog.flush();
    lock.releaseLock();
  }
}

/**
 * 被験者チャンク1つ分を取得して書き込む（§9.3）。
 * 逐次 fetch だと 1,400リクエスト×0.5秒 ≒ 12分で6分制限を確実に超えるので fetchAll 必須。
 */
function processChunk_(jobId, cur, subjects, types) {
  if (!subjects.length) return;
  var cfg = Config.forConfigName(subjects[0].config_name);

  // Phase 1: アクセストークンを一括確保（リフレッシュも fetchAll で並列化）
  var tokens = {}, needRefresh = [];
  subjects.forEach(function (s) {
    var t = TokenStore.getAccess(cfg.config_name, s.humanome_id);
    if (t) tokens[s.humanome_id] = t; else needRefresh.push(s);
  });
  refreshBatch_(cfg, needRefresh, tokens);

  // Phase 2: 全リクエストを組み立てる
  var reqs = [], meta = [];
  subjects.forEach(function (s) {
    var at = tokens[s.humanome_id];
    if (!at) return;                      // 認証NG（recordError 済み）
    types.forEach(function (dt) {
      if (!hasScope_(s, dt)) return;      // 403 を食らった組み合わせは恒久スキップ
      splitByMaxSpan_(dt, cur.from, cur.to).forEach(function (span) {
        reqs.push(buildRequest_(at, dt, span.from, span.to));
        meta.push({ humanome_id: s.humanome_id, dt: dt, from: span.from, to: span.to });
      });
    });
  });

  // Phase 3: FETCH_CHUNK 件ずつ fetchAll
  var results = [];
  chunk_(reqs, FETCH_CHUNK).forEach(function (slice, ci) {
    var t0 = Date.now();
    var responses = UrlFetchApp.fetchAll(slice);
    var ms = Date.now() - t0;
    responses.forEach(function (r, j) {
      results.push({ meta: meta[ci * FETCH_CHUNK + j], resp: r, ms: Math.round(ms / slice.length) });
    });
  });

  // Phase 4: 仕分け
  var parsed = [], retry = [];
  results.forEach(function (x) {
    var code = x.resp.getResponseCode();
    var body = null;
    if (code === 200) {
      body = safeJson_(x.resp.getContentText()) || {};
      parsed.push({ meta: x.meta, body: body });
    } else if (code === 404) {
      parsed.push({ meta: x.meta, body: {} });          // 記録なし＝正常。0件として扱う
    } else if (code === 403) {
      Subjects.disableDataType(x.meta.humanome_id, x.meta.dt.key);
      Audit.log('scope_insufficient', x.meta.humanome_id, x.meta.dt.key);
    } else if (code === 401 || code === 429 || code >= 500) {
      x.meta.code = code;
      retry.push(x.meta);
    }
    IngestLog.record(jobId, x.meta, code, body ? extractPoints_(body).length : 0, x.ms,
                     code === 200 || code === 404 ? '' : redact_(x.resp.getContentText()));
  });

  parsed = parsed.concat(retryWithBackoff_(cfg, retry, tokens, jobId));
  parsed = parsed.concat(followPages_(tokens, parsed, jobId));   // sleep は pageSize 25

  // Phase 5: まとめて書き込み
  Sink.flush(jobId, parsed);
}

/** §5.3 の期間上限でリクエストを分割する（心拍系は14日、他は90日）。 */
function splitByMaxSpan_(dt, fromIso, toIso) {
  var max = MAX_SPAN_DAYS[dt.id] || STD_MAX_SPAN_DAYS;
  var span = diffDays_(toIso, fromIso) + 1;
  if (span <= max) return [{ from: fromIso, to: toIso }];
  return splitRange_(fromIso, toIso, max);
}

// ---- バックフィル（§9.6） -------------------------------------------------

/**
 * 過去90日を分割取得する。日次ジョブとは別トリガー・別カーソルで動かす
 * （1人あたり20〜26リクエスト。95人が同時期に連携すると約2,400リクエストになるため）。
 */
function runBackfill() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { slog_('INFO', 'backfill_already_running', {}); return; }
  var started = Date.now();

  try {
    cleanupOneOffTriggers_('runBackfill');

    var queue = String(Props.getProperty(BACKFILL_QUEUE_KEY) || '').split(',').filter(String);
    if (!queue.length) { slog_('INFO', 'backfill_queue_empty', {}); return; }

    var jobId = 'bf-' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss');
    var to    = isoDate_(daysAgo_(1));
    var from  = isoDate_(daysAgo_(BACKFILL_DAYS));
    var types = DataTypes.listEnabled();

    while (queue.length) {
      if (Date.now() - started > SOFT_DEADLINE_MS) {
        Props.setProperty(BACKFILL_QUEUE_KEY, queue.join(','));
        scheduleContinuation_('runBackfill');
        slog_('INFO', 'backfill_deferred', { remaining: queue.length });
        return;
      }

      var entry = queue[0];
      var p = entry.split('|');
      var s = Subjects.findByHumanomeId(p[1]);

      if (s && s.status === 'authorized') {
        try {
          processChunk_(jobId, { from: from, to: to }, [s], types);
          Subjects.setBackfillDone(s.humanome_id, to);
          Audit.log('backfill_done', s.humanome_id, from + '..' + to);
        } catch (e) {
          if (e.name === 'FatalConfigError') {
            Props.setProperty(BACKFILL_QUEUE_KEY, queue.join(','));
            Alerts.fatal('バックフィル中に設定エラー: ' + e.config + ' / ' + e.detail);
            return;
          }
          Subjects.recordError(p[1], String(e.message || e));
        }
      }

      queue.shift();
      Props.setProperty(BACKFILL_QUEUE_KEY, queue.join(','));
    }

    IngestLog.flush();
    Props.deleteProperty(BACKFILL_QUEUE_KEY);
    slog_('INFO', 'backfill_completed', { job_id: jobId });

  } finally {
    IngestLog.flush();
    lock.releaseLock();
  }
}

// ---- 週次：デバイス情報（§9.1） -------------------------------------------

function runWeeklyDevices() {
  var subjects = Subjects.listActive();
  var rows = [];
  var byConfig = {};
  subjects.forEach(function (s) {
    (byConfig[s.config_name] = byConfig[s.config_name] || []).push(s);
  });

  Object.keys(byConfig).forEach(function (cn) {
    var cfg = Config.forConfigName(cn);
    byConfig[cn].forEach(function (s) {
      var at;
      try { at = refreshAccessToken_(cfg, s.humanome_id); } catch (e) { return; }

      // identity も更新しておく（アカウント差し替えの検知材料）
      try {
        var ident = HealthApi.getIdentity(at);
        if (ident.healthUserId && s.health_user_id && ident.healthUserId !== s.health_user_id) {
          Subjects.flagForReview(s.humanome_id, 'identity_changed', '');
        }
      } catch (e) { /* ignore */ }

      HealthApi.getPairedDevices(at).forEach(function (d) {
        rows.push({
          humanome_id: s.humanome_id,
          device_id:   String(d.id || d.name || d.deviceId || ''),
          model:       String(d.model || d.deviceModel || d.type || ''),
          last_sync_at: String(d.lastSyncTime || d.lastSyncedTime || ''),
          battery:     String(d.batteryLevel || d.battery || ''),
          checked_at:  nowIso_()
        });
      });
    });
  });

  if (rows.length) upsertDevices_(rows);
  slog_('INFO', 'weekly_devices_done', { rows: rows.length });
}

// ---- カーソル / トリガー --------------------------------------------------

function loadCursor_(key) {
  var v = Props.getProperty(key);
  return v ? safeJson_(v) : null;
}
function saveCursor_(key, cur) { Props.setProperty(key, JSON.stringify(cur)); }
function clearCursor_(key)     { Props.deleteProperty(key); }

function scheduleContinuation_(fnName) {
  ScriptApp.newTrigger(fnName).timeBased().after(60 * 1000).create();
}

function ensureBackfillTrigger_() {
  var has = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'runBackfill';
  });
  if (!has) scheduleContinuation_('runBackfill');
}

/**
 * ワンショットトリガーだけを掃除する。定時トリガー（EventType.CLOCK で everyDays 等）は消さない。
 * GAS のトリガー上限は 20/ユーザー/スクリプト。
 */
function cleanupOneOffTriggers_(fnName) {
  var now = Date.now();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() !== fnName) return;
    // ワンショット（.after()）は UID が使い捨て。定時トリガーと区別するため
    // Properties に登録した定時トリガーUIDの一覧を使う。
    var scheduled = String(Props.getProperty('scheduled_trigger_uids') || '');
    if (scheduled.indexOf(t.getUniqueId()) >= 0) return;   // 定時トリガーは残す
    try { ScriptApp.deleteTrigger(t); } catch (e) { /* ignore */ }
  });
  return now;
}
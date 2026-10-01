/**
 * 06_HealthApi.gs — Google Health API クライアント
 *
 * 3つのメソッドを使い分ける（§5.2）：
 *   dataPoints:dailyRollUp (POST) 日次集計。range は CivilTimeInterval（TZの概念がない）
 *   dataPoints:rollUp      (POST) 任意間隔集計。range は RFC3339（dailyRollUp と違う）
 *   dataPoints:list        (GET)  生データ点 / セッション。filter は AIP-160
 *
 * range はいずれも閉-開区間（end は含まない）。
 */
var HealthApi = {

  /** 本人性検証に使う。ブラウザ申告ではなくトークンから誰かを引く（§7.8 層3）。 */
  getIdentity: function (accessToken) {
    var res = UrlFetchApp.fetch(HEALTH_API + '/users/me/identity', {
      headers: { Authorization: 'Bearer ' + accessToken },
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    var body = safeJson_(res.getContentText());
    if (code !== 200 || !body) {
      throw new TransientError(code, 'identity fetch failed: ' + redact_(res.getContentText()));
    }
    // ★ §16-6：レスポンスのキー名は実装時に REST リファレンスで確認すること。
    //   ネストされていた場合にも拾えるようフォールバックを入れてある。
    var src = body.identity || body;
    return {
      healthUserId: String(pickField_(src, ['healthUserId', 'health_user_id', 'name']) || ''),
      legacyUserId: String(pickField_(src, ['legacyUserId', 'legacy_user_id']) || '')
    };
  },

  /** 週次でデバイス同期状況を更新する（§9.1）。 */
  getPairedDevices: function (accessToken) {
    var res = UrlFetchApp.fetch(HEALTH_API + '/users/me/pairedDevices', {
      headers: { Authorization: 'Bearer ' + accessToken },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return [];
    var body = safeJson_(res.getContentText()) || {};
    return body.pairedDevices || body.devices || [];
  }
};

/**
 * 1リクエストを組み立てる。fetchAll にそのまま渡せる形で返す。
 * from / to はいずれも 'yyyy-MM-dd'、to は「含む」日付（API には +1 日して半開区間で渡す）。
 */
function buildRequest_(accessToken, dt, fromIso, toIso, pageToken) {
  var base   = HEALTH_API + '/users/me/dataTypes/' + dt.id + '/dataPoints';
  var common = { headers: { Authorization: 'Bearer ' + accessToken }, muteHttpExceptions: true };

  if (dt.method === 'dailyRollUp') {
    // ★ windowSizeDays × pageSize が期間上限（90日／心拍系は14日）を超えると 400。
    //   windowSizeDays=1 なので pageSize はその上限日数そのものが最大値になる。
    var maxDays = MAX_SPAN_DAYS[dt.id] || STD_MAX_SPAN_DAYS;
    var payload = {
      range: { start: civilDateTime_(fromIso), end: civilDateTime_(addDays_(toIso, 1)) },   // 半開区間
      windowSizeDays: 1,
      pageSize: maxDays
    };
    if (pageToken) payload.pageToken = pageToken;
    return Object.assign({
      url: base + ':dailyRollUp',
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload)
    }, common);
  }

  if (dt.method === 'rollUp') {
    // ★ dailyRollUp と同じ制約。windowSize × pageSize が期間上限を超えないようにする。
    var win     = dt.window || '300s';
    var winSec  = Math.max(1, parseInt(String(win).replace(/[^0-9]/g, ''), 10) || 300);
    var maxDays2 = MAX_SPAN_DAYS[dt.id] || STD_MAX_SPAN_DAYS;
    var maxPage = Math.max(1, Math.floor(maxDays2 * 86400 / winSec));
    var payload2 = {
      range: {
        startTime: fromIso + 'T00:00:00' + TZ_OFFSET,
        endTime:   addDays_(toIso, 1) + 'T00:00:00' + TZ_OFFSET
      },
      windowSize: win,
      pageSize: Math.min(dt.page_size || maxPage, maxPage)
    };
    if (pageToken) payload2.pageToken = pageToken;
    return Object.assign({
      url: base + ':rollUp',
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload2)
    }, common);
  }

  if (dt.method === 'list') {
    var tpl = FILTER_TEMPLATES[dt.id];
    // 未知のデータ型を暗黙に「フィルタなし＝全件取得」にしない（§5.5 / §9.4）
    if (!tpl) throw new FatalConfigError('datatypes', 'FILTER_TEMPLATES に定義がありません: ' + dt.id);
    var params = { pageSize: dt.page_size || 1440 };
    // ★ 実測：sleep は filter 非対応。フィルタなしで取り、新しい順に返るのを利用して
    //   from より古いページに入った時点でページ送りを止め、日付の絞りはコード側で行う。
    if (tpl !== NO_FILTER) {
      params.filter = tpl.replace(/\{from\}/g, fromIso).replace(/\{toExclusive\}/g, addDays_(toIso, 1));
    }
    if (pageToken) params.pageToken = pageToken;
    return Object.assign({ url: base + '?' + qs_(params), method: 'get' }, common);
  }

  throw new FatalConfigError('datatypes', '未知の method: ' + dt.method + ' (' + dt.id + ')');
}

/** レスポンス本文からデータ点の配列を取り出す（メソッドごとに包み名が違う）。 */
function extractPoints_(body) {
  if (!body) return [];
  return body.rollupDataPoints || body.dataPoints || [];
}

/**
 * nextPageToken を辿る（§5.4：sleep は pageSize 25 なので必須）。
 * ページ数の暴走を防ぐため 1リクエストあたり maxPages で打ち切り、
 * 打ち切った場合は ingest_log に truncated として残す。
 */
function followPages_(tokens, parsed, jobId, maxPages) {
  maxPages = maxPages || 20;
  var extra = [];

  parsed.forEach(function (item) {
    var body  = item.body;
    var token = body && body.nextPageToken;
    var page  = 1;

    while (token && page < maxPages) {
      var at = tokens[item.meta.humanome_id];
      if (!at) break;
      var req = buildRequest_(at, item.meta.dt, item.meta.from, item.meta.to, token);
      var res = UrlFetchApp.fetch(req.url, req);
      var code = res.getResponseCode();
      if (code !== 200) {
        IngestLog.record(jobId, item.meta, code, 0, 0, 'page ' + (page + 1) + ' failed');
        break;
      }
      var b = safeJson_(res.getContentText()) || {};
      extra.push({ meta: item.meta, body: b });
      token = b.nextPageToken;
      page++;
      // フィルタ非対応型（sleep）は新しい順に返るので、from より古くなったら打ち切る
      if (token && FILTER_TEMPLATES[item.meta.dt.id] === NO_FILTER &&
          pageIsOlderThan_(b, item.meta.from)) { token = null; break; }
    }

    if (token) {
      IngestLog.record(jobId, item.meta, 200, 0, 0, 'truncated at page ' + maxPages);
      slog_('WARNING', 'pagination_truncated', {
        humanome_id: item.meta.humanome_id, data_type: item.meta.dt.key, pages: maxPages
      });
    }
  });

  return extra;
}

/** ページ内の最古の点が fromIso より前か（フィルタ非対応型の打ち切り判定用）。 */
function pageIsOlderThan_(body, fromIso) {
  var pts = extractPoints_(body);
  if (!pts.length) return true;
  var oldest = null;
  pts.forEach(function (pt) {
    var iv = (pt.sleep && pt.sleep.interval) || pt.interval || {};
    var t  = iv.startTime || pt.startTime;
    if (t && (!oldest || t < oldest)) oldest = t;
  });
  return oldest ? (String(oldest).substring(0, 10) < fromIso) : true;
}

/**
 * 一時エラー（401 / 429 / 5xx）を指数バックオフ + ジッタで再試行（§10）。
 * 401 は access_token を1回だけ捨ててリフレッシュしてから再試行する。
 */
function retryWithBackoff_(cfg, retryMetas, tokens, jobId) {
  var out = [];
  var pending = retryMetas.slice();

  for (var attempt = 1; attempt <= MAX_RETRY && pending.length; attempt++) {
    Utilities.sleep(Math.min(20000, Math.pow(2, attempt) * 500) + Math.floor(Math.random() * 400));

    var next = [];
    var reqs = [], metas = [];
    pending.forEach(function (m) {
      if (m.code === 401) {
        TokenStore.dropAccess(cfg.config_name, m.humanome_id);
        try {
          tokens[m.humanome_id] = refreshAccessToken_(cfg, m.humanome_id);
        } catch (e) {
          if (e.name === 'FatalConfigError') throw e;
          return;   // 認証が死んでいる。この被験者は今日は諦める
        }
      }
      var at = tokens[m.humanome_id];
      if (!at) return;
      reqs.push(buildRequest_(at, m.dt, m.from, m.to));
      metas.push(m);
    });

    if (!reqs.length) break;

    chunk_(reqs, FETCH_CHUNK).forEach(function (slice, ci) {
      UrlFetchApp.fetchAll(slice).forEach(function (res, j) {
        var m = metas[ci * FETCH_CHUNK + j];
        var code = res.getResponseCode();
        IngestLog.record(jobId, m, code, 0, 0, 'retry' + attempt);
        if (code === 200)       out.push({ meta: m, body: safeJson_(res.getContentText()) || {} });
        else if (code === 404)  out.push({ meta: m, body: {} });
        else if (code === 403)  Subjects.disableDataType(m.humanome_id, m.dt.key);
        else if (code === 401 || code === 429 || code >= 500) { m.code = code; next.push(m); }
      });
    });

    pending = next;
  }

  // 3回失敗したものは failed として残し、翌日の頭で再試行する（§9.5）
  pending.forEach(function (m) {
    IngestLog.record(jobId, m, m.code || 0, 0, 0, 'failed after ' + MAX_RETRY + ' retries');
  });

  return out;
}
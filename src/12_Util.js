/**
 * 12_Util.gs — 汎用ユーティリティ
 * 依存なし。他のどのファイルからも呼ばれる。
 */

// ---- 乱数 / ハッシュ ------------------------------------------------------

/** nBytes バイト相当の16進文字列（= nBytes*2 文字）を返す。 */
function randomToken_(nBytes) {
  var s = '';
  while (s.length < nBytes * 2) s += Utilities.getUuid().replace(/-/g, '');
  return s.substring(0, nBytes * 2);
}

function base64UrlSha256_(str) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(d).replace(/=+$/, '');
}

function sha256Hex_(str) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return d.map(function (b) {
    return ('0' + (b & 0xff).toString(16)).slice(-2);
  }).join('');
}

function uuid4_() { return Utilities.getUuid(); }

// ---- 文字列 / HTML --------------------------------------------------------

function qs_(obj) {
  return Object.keys(obj).filter(function (k) {
    return obj[k] !== null && obj[k] !== undefined && obj[k] !== '';
  }).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]);
  }).join('&');
}

function escapeHtml_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr_(s) { return escapeHtml_(s); }

function safeJson_(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

/** ログや監査に出す前に、トークンらしき文字列を潰す。 */
function redact_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/ya29\.[A-Za-z0-9._\-]+/g, 'ya29.[REDACTED]')
    .replace(/1\/\/[A-Za-z0-9._\-]+/g, '1//[REDACTED]')
    .replace(/"(access_token|refresh_token|client_secret|code_verifier|code)"\s*:\s*"[^"]*"/g, '"$1":"[REDACTED]"')
    .substring(0, 500);
}

// ---- 日付 -----------------------------------------------------------------

function isoDate_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function nowIso_()   { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"); }

function daysAgo_(n) {
  var d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

/** 'yyyy-MM-dd' に n 日足した 'yyyy-MM-dd' を返す（UTC 正午基準でDST/桁上がり事故を避ける）。 */
function addDays_(iso, n) {
  var p = iso.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12, 0, 0));
  d.setUTCDate(d.getUTCDate() + n);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

/** iso1 - iso2 の日数。 */
function diffDays_(iso1, iso2) {
  var a = isoToUtc_(iso1), b = isoToUtc_(iso2);
  return Math.round((a - b) / 86400000);
}

function isoToUtc_(iso) {
  var p = iso.split('-');
  return Date.UTC(+p[0], +p[1] - 1, +p[2], 12, 0, 0);
}

/** 'yyyy-MM-dd' → CivilDate {year, month, day} */
function civil_(iso) {
  var p = iso.split('-');
  return { year: +p[0], month: +p[1], day: +p[2] };
}

/** 'yyyy-MM-dd' → CivilDateTime { date: {...}, time: {...} }
 *  ★ dailyRollUp の range.start / range.end はこの形（google.type.Date が date に入れ子）。 */
function civilDateTime_(iso) {
  return { date: civil_(iso), time: { hours: 0, minutes: 0, seconds: 0 } };
}

/** CivilDate / CivilDateTime / 文字列 → 'yyyy-MM-dd' */
function civilToIso_(c) {
  if (!c) return '';
  if (typeof c === 'string') return c.substring(0, 10);
  if (c.date) c = c.date;            // CivilDateTime なら中の date を見る
  if (!c.year) return '';
  var pad = function (n) { return ('0' + n).slice(-2); };
  return c.year + '-' + pad(c.month || 1) + '-' + pad(c.day || 1);
}

/** RFC3339 タイムスタンプ → 'yyyy-MM-dd'（TZ ローカル日） */
function tsToLocalDate_(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts).substring(0, 10);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

function minutesBetween_(startTs, endTs) {
  var a = new Date(startTs).getTime(), b = new Date(endTs).getTime();
  if (isNaN(a) || isNaN(b)) return '';
  return Math.round((b - a) / 60000 * 10) / 10;
}

/** [from, toInclusive] を maxSpan 日以下の区間に分割。返り値は {from, to}（to は含む）。 */
function splitRange_(fromIso, toIso, maxSpanDays) {
  var out = [], cur = fromIso;
  while (diffDays_(toIso, cur) >= 0) {
    var end = addDays_(cur, maxSpanDays - 1);
    if (diffDays_(end, toIso) > 0) end = toIso;
    out.push({ from: cur, to: end });
    cur = addDays_(end, 1);
  }
  return out;
}

// ---- 配列 -----------------------------------------------------------------

function chunk_(arr, n) {
  var out = [];
  for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function toNum_(v) {
  if (v === null || v === undefined || v === '') return '';
  var n = Number(v);
  return isNaN(n) ? '' : n;
}

/** obj から候補キーの最初に見つかった値を返す。 */
function pickField_(obj, candidates) {
  if (!obj) return null;
  for (var i = 0; i < candidates.length; i++) {
    var k = candidates[i];
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

// ---- 例外型（§10） --------------------------------------------------------

function AuthError(code, hid, detail) {
  this.name = 'AuthError'; this.code = code; this.humanome_id = hid; this.detail = detail;
  this.message = 'AuthError ' + code + ' ' + (hid || '') + ' ' + (detail || '');
}
AuthError.prototype = Object.create(Error.prototype);

function FatalConfigError(cfg, d) {
  this.name = 'FatalConfigError'; this.config = cfg; this.detail = d;
  this.message = 'FatalConfigError ' + cfg + ' ' + d;
}
FatalConfigError.prototype = Object.create(Error.prototype);

function TransientError(code, d) {
  this.name = 'TransientError'; this.code = code; this.detail = d;
  this.message = 'TransientError ' + code + ' ' + d;
}
TransientError.prototype = Object.create(Error.prototype);

// ---- ログ -----------------------------------------------------------------

/** 構造化ログ。Cloud Logging に JSON として出る（Project A を標準 GCP にした場合）。
 *  トークン・生の健康データは絶対に渡さないこと（§11.2）。 */
function slog_(severity, event, fields) {
  var payload = { event: event, severity: severity };
  if (fields) Object.keys(fields).forEach(function (k) { payload[k] = fields[k]; });
  console.log(JSON.stringify(payload));
}


/**
 * シートから読んだセル値を 'yyyy-MM-dd' に正規化する。
 * ★ Sheets は "2026-09-14" を日付型として解釈して Date オブジェクトで返すため、
 *   文字列キーとの突合が壊れる（毎回追記され重複行になる）。読み取り側で必ず通すこと。
 */
function cellToIsoDate_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  }
  return String(v).substring(0, 10);
}

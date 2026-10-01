/**
 * 01_Config.gs — Script Properties と config シートの読み込み
 *
 * Script Properties に入れる key（§11.1）：
 *   OPS_SPREADSHEET_ID    Ops スプレッドシートID
 *   DATA_SPREADSHEET_ID   Data スプレッドシートID
 *   DRIVE_ROOT_FOLDER_ID  HealthStudy フォルダID（setup で自動作成・自動投入）
 *   ALERT_EMAIL           ダイジェスト/アラート送信先（カンマ区切り可）
 *   WEBAPP_URL            https://script.google.com/macros/s/{DEPLOYMENT_ID}/exec
 *   secret:{config_name}  OAuth client_secret
 *   rt:{config}|{id}      refresh_token（TokenStore が管理）
 */

var Props = PropertiesService.getScriptProperties();

function prop_(key, required) {
  var v = Props.getProperty(key);
  if (!v && required) throw new FatalConfigError('script_properties', 'missing property: ' + key);
  return v;
}

// ---- スプレッドシートアクセス --------------------------------------------

var _ssCache = {};

function opsSpreadsheet_() {
  if (!_ssCache.ops) _ssCache.ops = SpreadsheetApp.openById(prop_('OPS_SPREADSHEET_ID', true));
  return _ssCache.ops;
}

function dataSpreadsheet_() {
  if (!_ssCache.data) _ssCache.data = SpreadsheetApp.openById(prop_('DATA_SPREADSHEET_ID', true));
  return _ssCache.data;
}

function opsSheet_(name) {
  var sh = opsSpreadsheet_().getSheetByName(name);
  if (!sh) throw new FatalConfigError('ops_sheet', 'sheet not found: ' + name + '（runSetup() を実行したか確認）');
  return sh;
}

function dataSheet_(name) {
  var sh = dataSpreadsheet_().getSheetByName(name);
  if (!sh) throw new FatalConfigError('data_sheet', 'sheet not found: ' + name + '（runSetup() を実行したか確認）');
  return sh;
}

/** シートを「ヘッダ名 → 値」のオブジェクト配列として読む。 */
function readSheetObjects_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var width = sheet.getLastColumn();
  var values = sheet.getRange(1, 1, last, width).getValues();
  var header = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = {};
    var empty = true;
    for (var j = 0; j < header.length; j++) {
      if (!header[j]) continue;
      row[header[j]] = values[i][j];
      if (values[i][j] !== '' && values[i][j] !== null) empty = false;
    }
    if (empty) continue;
    row.__row = i + 1;   // 1-indexed のシート行番号
    out.push(row);
  }
  return out;
}

/** ヘッダ名 → 列番号(1-indexed) の対応。 */
function headerIndex_(sheet) {
  var width = sheet.getLastColumn();
  if (width < 1) return {};
  var header = sheet.getRange(1, 1, 1, width).getValues()[0];
  var idx = {};
  header.forEach(function (h, j) { if (h) idx[String(h).trim()] = j + 1; });
  return idx;
}

// ---- config -------------------------------------------------------------

var Config = (function () {
  var cache = null;

  function loadAll() {
    if (cache) return cache;
    cache = {};
    readSheetObjects_(opsSheet_(OPS_SHEETS.config)).forEach(function (r) {
      var name = String(r.config_name).trim();
      if (!name) return;
      cache[name] = {
        config_name:   name,
        gcp_project:   String(r.gcp_project || ''),
        client_id:     String(r.client_id || '').trim(),
        redirect_uri:  String(r.redirect_uri || '').trim(),
        base_username: String(r.base_username || '').trim(),
        scopes:        String(r.scopes || REQUIRED_SCOPES.join(' ')).trim().split(/\s+/),
        status:        String(r.status || 'active').trim(),
        __row:         r.__row
      };
    });
    return cache;
  }

  return {
    forConfigName: function (name) {
      var all = loadAll();
      var c = all[String(name).trim()];
      if (!c) throw new FatalConfigError(String(name), 'config row not found');
      if (!c.client_id)    throw new FatalConfigError(c.config_name, 'client_id is empty');
      if (!c.redirect_uri) throw new FatalConfigError(c.config_name, 'redirect_uri is empty');
      // client_secret はシートに置かない。Script Properties から読む。
      c.client_secret = prop_('secret:' + c.config_name, true);
      return c;
    },
    listActive: function () {
      var all = loadAll();
      return Object.keys(all).map(function (k) { return all[k]; })
        .filter(function (c) { return c.status === 'active'; });
    },
    invalidate: function () { cache = null; _ssCache = {}; }
  };
})();

// ---- datatypes ----------------------------------------------------------

var DataTypes = (function () {
  var cache = null;

  return {
    listEnabled: function () {
      if (cache) return cache;
      cache = readSheetObjects_(opsSheet_(OPS_SHEETS.datatypes))
        .filter(function (r) { return r.enabled === true || String(r.enabled).toUpperCase() === 'TRUE'; })
        .map(function (r) {
          var id     = String(r.data_type_id).trim();
          var method = String(r.method).trim();
          return {
            id:        id,
            method:    method,
            window:    String(r.window || '').trim(),
            scope_key: String(r.scope_key || '').trim(),
            page_size: Number(r.page_size) || (method === 'list' ? 1440 : 10000),
            sink:      String(r.sink || '').trim(),
            /** ログ・スキップ管理で使う一意キー（heart-rate は dailyRollUp と rollUp の2行ある） */
            key:       id + ':' + method
          };
        });
      return cache;
    },
    invalidate: function () { cache = null; }
  };
})();

/** その被験者が、そのデータ型に必要なスコープを持っているか（§9.3） */
function hasScope_(subject, dt) {
  var need = SCOPE_KEYS[dt.scope_key];
  if (!need) return true;   // scope_key 未設定なら判定しない
  var granted = String(subject.granted_scopes || '').split(/\s+/);
  if (granted.indexOf(need) < 0) return false;
  // 403 を食らって恒久スキップ登録済みの組み合わせを除外
  var disabled = String(subject.disabled_data_types || '').split(/\s*,\s*/);
  return disabled.indexOf(dt.key) < 0;
}

/**
 * 09_SinkDrive.gs — 心拍 intraday を Drive に NDJSON.gz で置く（§8.4）
 *
 * 5分間隔 = 288点/日/人 → 100人×365日 = 1,051万点/年。スプレッドシートの
 * 1000万セル上限を1年で突破する。物理的に入らないので最初から Drive に出す。
 *
 * 置き場所：raw/{試験名}/{データ型}/{被験者ID}/{日付}.ndjson.gz
 * ファイル名に年が入っているので、年フォルダは作らない。
 * データ型ごとに分けてあるので、心拍だけまとめて取り出す、といった扱いがしやすい。
 *
 * 1被験者1日1ファイル：
 *   - 100ファイル/日 → consumer の「ドキュメント作成 250/日」に収まる
 *   - ファイル名が決定的なので、再実行時は置き換えで自然に冪等
 *   - gzip 後 20〜60KB/日/人 → 100人×365日 ≒ 0.7〜2GB/年
 *
 * Drive Advanced Service (v3) を使う。DriveApp は広い /auth/drive を要求するため使わない。
 */
var SinkDrive = {

  writeRaw: function (humanomeId, civilDate, dataType, records) {
    if (!records || !records.length) return;
    var subject = Subjects.findByHumanomeId(humanomeId);
    var configName = subject ? subject.config_name : 'unknown';

    var folder = ensureFolderPath_([
      'raw', configName, dataType || 'unknown', humanomeId
    ]);
    var name   = civilDate + '.ndjson.gz';
    var ndjson = records.map(function (r) { return JSON.stringify(r); }).join('\n');
    var blob   = Utilities.gzip(
      Utilities.newBlob(ndjson, 'application/x-ndjson', civilDate + '.ndjson'), name);

    var existing = Drive.Files.list({
      q: "'" + folder + "' in parents and name = '" + name + "' and trashed = false",
      fields: 'files(id)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    }).files || [];

    if (existing.length) {
      Drive.Files.update({}, existing[0].id, blob, { supportsAllDrives: true });
    } else {
      Drive.Files.create({ name: name, parents: [folder] }, blob, { supportsAllDrives: true });
    }
  }
};

/** DRIVE_ROOT_FOLDER_ID 配下にパスを作って、最終フォルダのIDを返す。 */
function ensureFolderPath_(parts) {
  var cache  = CacheService.getScriptCache();
  var ckey   = 'folder:' + parts.join('/');
  var cached = cache.get(ckey);
  if (cached) return cached;

  var parent = prop_('DRIVE_ROOT_FOLDER_ID', true);
  parts.forEach(function (p) { parent = ensureChildFolder_(parent, p); });
  cache.put(ckey, parent, 21600);
  return parent;
}

function ensureChildFolder_(parentId, name) {
  var q = "'" + parentId + "' in parents and name = '" + String(name).replace(/'/g, "\\'") +
          "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  var found = Drive.Files.list({
    q: q, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true
  }).files || [];
  if (found.length) return found[0].id;

  var created = Drive.Files.create({
    name: String(name),
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId]
  }, null, { supportsAllDrives: true });
  return created.id;
}
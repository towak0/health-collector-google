/**
 * 05_Subjects.gs — 被験者マスタ CRUD と本人性検証（§7.8）
 *
 * subjects シートは 100 行程度なので、起動時に1回全部読んで Map を作る。
 * DynamoDB の GSI に相当する仕組みは不要（§8.2）。
 * 行順＝処理順なので、シートをソートしないこと。
 */
var Subjects = (function () {
  var rows = null;      // 生オブジェクト配列（__row 付き）
  var byLink = null, byId = null, byHuid = null;

  function load() {
    if (rows) return;
    rows = readSheetObjects_(opsSheet_(OPS_SHEETS.subjects));
    byLink = {}; byId = {}; byHuid = {};
    rows.forEach(function (r) {
      r.link_id     = String(r.link_id || '').trim();
      r.humanome_id = String(r.humanome_id || '').trim();
      r.status      = String(r.status || 'issued').trim();
      r.health_user_id = String(r.health_user_id || '').trim();
      if (r.link_id)        byLink[r.link_id] = r;
      if (r.humanome_id)    byId[r.humanome_id] = r;
      if (r.health_user_id) byHuid[r.health_user_id] = r;
    });
  }

  /** 1セル更新。シートを直接触るのはここだけに集約する。 */
  function setCell(row, column, value) {
    var sh  = opsSheet_(OPS_SHEETS.subjects);
    var idx = headerIndex_(sh);
    if (!idx[column]) throw new FatalConfigError('subjects', 'column not found: ' + column);
    sh.getRange(row.__row, idx[column]).setValue(value);
    row[column] = value;
  }

  function setCells(row, obj) {
    var sh  = opsSheet_(OPS_SHEETS.subjects);
    var idx = headerIndex_(sh);
    Object.keys(obj).forEach(function (k) {
      if (!idx[k]) return;
      sh.getRange(row.__row, idx[k]).setValue(obj[k]);
      row[k] = obj[k];
    });
  }

  return {
    invalidate: function () { rows = null; byLink = null; byId = null; byHuid = null; },

    all: function () { load(); return rows; },

    findByLinkId:      function (v) { load(); return byLink[String(v).trim()] || null; },
    findByHumanomeId:  function (v) { load(); return byId[String(v).trim()] || null; },
    findByHealthUserId:function (v) { load(); return v ? (byHuid[String(v).trim()] || null) : null; },

    /** 日次収集の対象。行順を保つ（カーソルの offset がこの順序に依存する）。 */
    listActive: function (configName) {
      load();
      return rows.filter(function (r) {
        if (r.status !== 'authorized') return false;
        if (configName && r.config_name !== configName) return false;
        return true;
      });
    },

    /** ---- 本人性検証（§7.8）。ここを緩めない。 ---- */
    verifyBinding: function (humanomeId, ident, grantedScope) {
      var row = this.findByHumanomeId(humanomeId);
      if (!row) return { ok: false, code: 'no_subject', detail: humanomeId,
        message: '被験者IDが見つかりません。担当者にご連絡ください。' };
      if (row.status === 'withdrawn') return { ok: false, code: 'withdrawn', detail: humanomeId,
        message: 'この被験者IDは参加終了済みです。' };
      if (!ident || !ident.healthUserId) return { ok: false, code: 'no_identity', detail: '',
        message: 'アカウント情報を確認できませんでした。もう一度お試しください。' };

      // (1) この Google アカウントが既に別の被験者IDに紐づいていないか
      var other = this.findByHealthUserId(ident.healthUserId);
      if (other && other.humanome_id !== humanomeId) {
        this.flagForReview(humanomeId, 'account_reuse', other.humanome_id);
        return { ok: false, code: 'account_reuse', detail: other.humanome_id,
          message: 'このGoogleアカウントは既に別の被験者IDで登録されています。担当者にご連絡ください。' };
      }

      // (2) この被験者IDが既に別の Google アカウントに紐づいていないか
      if (row.health_user_id && row.health_user_id !== ident.healthUserId) {
        this.flagForReview(humanomeId, 'identity_mismatch', 'new_account');
        return { ok: false, code: 'identity_mismatch', detail: '',
          message: '登録済みのアカウントと異なります。担当者にご連絡ください。' };
      }

      // (3) 必須スコープが揃っているか（granular consent で外される可能性がある）
      var granted = String(grantedScope || '').split(/\s+/);
      var missing = REQUIRED_SCOPES.filter(function (s) { return granted.indexOf(s) < 0; });
      if (missing.length) {
        return { ok: false, code: 'partial_scope', detail: String(missing.length),
          message: 'すべての項目にチェックを入れて許可してください（不足 ' + missing.length + ' 件）。' };
      }
      return { ok: true, code: 'ok', detail: '' };
    },

    /** ---- 状態更新 ---- */
    markAuthorized: function (humanomeId, ident, grantedScope) {
      var row = this.findByHumanomeId(humanomeId);
      if (!row) return;
      setCells(row, {
        status:          'authorized',
        health_user_id:  ident.healthUserId || '',
        legacy_user_id:  ident.legacyUserId || '',
        granted_scopes:  String(grantedScope || ''),
        authorized_at:   nowIso_(),
        last_error:      '',
        last_error_at:   '',
        review_flag:     ''
      });
      load();
      if (row.health_user_id) byHuid[row.health_user_id] = row;
    },

    markRevoked: function (humanomeId, reason) {
      var row = this.findByHumanomeId(humanomeId);
      if (!row) return;
      setCells(row, { status: 'revoked', last_error: String(reason || '').substring(0, 200), last_error_at: nowIso_() });
    },

    setStatus: function (humanomeId, status) {
      var row = this.findByHumanomeId(humanomeId);
      if (row) setCell(row, 'status', status);
    },

    /** 旧 link_id を無効化（撤回・再発行時）。 */
    invalidateLink: function (humanomeId) {
      var row = this.findByHumanomeId(humanomeId);
      if (!row) return;
      if (row.link_id) delete byLink[row.link_id];
      setCells(row, { link_id: '', login_url: '' });
    },

    /** 新しい link_id を採番して返す。 */
    reissueLink: function (humanomeId, webappUrl) {
      var row = this.findByHumanomeId(humanomeId);
      if (!row) throw new Error('subject not found: ' + humanomeId);
      if (row.link_id) delete byLink[row.link_id];
      var link = uuid4_();
      setCells(row, { link_id: link, login_url: webappUrl + '?link_id=' + link });
      byLink[link] = row;
      return row.login_url;
    },

    flagForReview: function (humanomeId, code, detail) {
      var row = this.findByHumanomeId(humanomeId);
      if (!row) return;
      setCells(row, {
        review_flag: code,
        notes: String(row.notes || '') + '[' + nowIso_() + '] ' + code + ':' + String(detail || '') + '\n'
      });
    },

    /** 403（スコープ不足）を食らった (被験者, データ型) を恒久スキップに登録。 */
    disableDataType: function (humanomeId, dtKey) {
      var row = this.findByHumanomeId(humanomeId);
      if (!row) return;
      var cur = String(row.disabled_data_types || '').split(/\s*,\s*/).filter(String);
      if (cur.indexOf(dtKey) >= 0) return;
      cur.push(dtKey);
      setCell(row, 'disabled_data_types', cur.join(','));
    },

    recordSuccess: function (humanomeId, hadData) {
      var row = this.findByHumanomeId(humanomeId);
      if (!row) return;
      var empty = hadData ? 0 : (Number(row.consecutive_empty_days) || 0) + 1;
      setCells(row, { last_success_at: nowIso_(), consecutive_empty_days: empty });
    },

    recordError: function (humanomeId, msg) {
      var row = this.findByHumanomeId(humanomeId);
      if (!row) return;
      setCells(row, { last_error_at: nowIso_(), last_error: redact_(msg).substring(0, 200) });
    },

    setBackfillDone: function (humanomeId, untilIso) {
      var row = this.findByHumanomeId(humanomeId);
      if (row) setCell(row, 'backfill_done_until', untilIso);
    },

    /** Admin から一括発行するときに使う（1回の setValues で追記）。 */
    appendRows: function (records) {
      if (!records.length) return;
      var sh = opsSheet_(OPS_SHEETS.subjects);
      var idx = headerIndex_(sh);
      var width = COL_SUBJECTS.length;
      var values = records.map(function (r) {
        var arr = new Array(width).fill('');
        COL_SUBJECTS.forEach(function (c, j) {
          if (idx[c]) arr[idx[c] - 1] = (r[c] !== undefined ? r[c] : '');
        });
        return arr;
      });
      sh.getRange(sh.getLastRow() + 1, 1, values.length, width).setValues(values);
      this.invalidate();
    }
  };
})();

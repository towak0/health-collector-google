/**
 * 03_OAuth.gs — 認可URL生成 / PKCE / state / code交換 / refresh / revoke
 *
 * 設計の要（§7.5, §7.8）：
 *   - state はブラウザに渡す不透明 nonce のみ。humanome_id をブラウザ経由で運ばない
 *     （AWS 版の state="config_name|humanome_id" が脆弱性の根本原因だった）
 *   - nonce → 被験者の対応は CacheService にだけ置き、TTL 600s で自動失効
 *   - PKCE(S256) を併用。client_secret を持つサーバ側フローでも多層防御になる
 */
var OAuth = {

  buildAuthUrl: function (subject) {
    var cfg      = Config.forConfigName(subject.config_name);
    var verifier = randomToken_(64);   // 128文字（PKCE 仕様: 43-128文字）
    var nonce    = randomToken_(32);

    CacheService.getScriptCache().put('oauth:' + nonce, JSON.stringify({
      link_id:     subject.link_id,
      config_name: subject.config_name,
      humanome_id: subject.humanome_id,
      verifier:    verifier,
      created_at:  Date.now()
    }), STATE_TTL_SEC);

    return AUTH_EP + '?' + qs_({
      client_id:             cfg.client_id,
      redirect_uri:          cfg.redirect_uri,
      response_type:         'code',
      scope:                 cfg.scopes.join(' '),
      access_type:           'offline',
      prompt:                'consent select_account',
      include_granted_scopes: 'false',
      state:                 nonce,
      code_challenge:        base64UrlSha256_(verifier),
      code_challenge_method: 'S256'
    });
  },

  /** state を単回消費する。LockService でリプレイを原子的に潰す（§7.7）。 */
  consumeState: function (nonce) {
    if (!nonce) return null;
    var key = 'oauth:' + nonce;
    var cache = CacheService.getScriptCache();
    var st = null;
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (e) {
      return null;
    }
    try {
      var raw = cache.get(key);
      if (raw) { cache.remove(key); st = safeJson_(raw); }
    } finally {
      lock.releaseLock();
    }
    return st;
  }
};

/** 認可コード → トークン。Google 形式（Basic 認証ヘッダではなく body に client_id/secret）。 */
function exchangeCode_(cfg, code, verifier) {
  var res = UrlFetchApp.fetch(TOKEN_EP, {
    method: 'post',
    payload: {
      code:          code,
      client_id:     cfg.client_id,
      client_secret: cfg.client_secret,
      redirect_uri:  cfg.redirect_uri,
      grant_type:    'authorization_code',
      code_verifier: verifier
    },
    muteHttpExceptions: true
  });
  return safeJson_(res.getContentText());
}

/**
 * access_token を得る。キャッシュ優先、なければリフレッシュ。
 *
 * ★ リフレッシュ応答に refresh_token は通常含まれない。
 *   無条件に参照すると必ず落ちる（AWS 版 app/db.py:78 が踏んでいた罠）。
 */
function refreshAccessToken_(cfg, humanomeId) {
  var cached = TokenStore.getAccess(cfg.config_name, humanomeId);
  if (cached) return cached;

  var rt = TokenStore.getRefresh(cfg.config_name, humanomeId);
  if (!rt) throw new AuthError('no_refresh_token', humanomeId, '');

  var res  = UrlFetchApp.fetch(TOKEN_EP, {
    method: 'post',
    payload: {
      client_id:     cfg.client_id,
      client_secret: cfg.client_secret,
      refresh_token: rt,
      grant_type:    'refresh_token'
    },
    muteHttpExceptions: true
  });
  return handleRefreshResponse_(cfg, humanomeId, rt, res);
}

/** fetchAll での一括リフレッシュと逐次リフレッシュで共用する応答処理。 */
function handleRefreshResponse_(cfg, humanomeId, oldRefreshToken, res) {
  var code = res.getResponseCode();
  var body = safeJson_(res.getContentText()) || {};

  if (code === 200 && body.access_token) {
    TokenStore.save(cfg.config_name, humanomeId, {
      access_token:  body.access_token,
      refresh_token: body.refresh_token || oldRefreshToken,   // ★ 応答に無いのが通常
      expires_in:    body.expires_in
    });
    return body.access_token;
  }

  if (code === 400 && body.error === 'invalid_grant') {
    Subjects.markRevoked(humanomeId, body.error_description || 'invalid_grant');
    TokenStore.drop(cfg.config_name, humanomeId);
    Audit.log('token_revoked', humanomeId, String(body.error_description || 'invalid_grant'));
    throw new AuthError('invalid_grant', humanomeId, body.error_description || '');
  }

  // 全被験者が同時に失敗する種類のエラー。1人分として飲み込むと100件のエラーになる（§10）
  if (body.error === 'invalid_client' || body.error === 'unauthorized_client' || body.error === 'deleted_client') {
    throw new FatalConfigError(cfg.config_name, body.error);
  }

  throw new TransientError(code, body.error || redact_(res.getContentText()));
}

/**
 * 被験者チャンク分のアクセストークンを fetchAll で並列リフレッシュする（§9.3 Phase 1）。
 * tokens[humanome_id] に access_token を詰める。失敗した被験者は詰めない。
 */
function refreshBatch_(cfg, subjects, tokens) {
  if (!subjects.length) return;

  var reqs = [], meta = [];
  subjects.forEach(function (s) {
    var rt = TokenStore.getRefresh(cfg.config_name, s.humanome_id);
    if (!rt) {
      Subjects.recordError(s.humanome_id, 'no_refresh_token');
      return;
    }
    reqs.push({
      url: TOKEN_EP,
      method: 'post',
      payload: {
        client_id:     cfg.client_id,
        client_secret: cfg.client_secret,
        refresh_token: rt,
        grant_type:    'refresh_token'
      },
      muteHttpExceptions: true
    });
    meta.push({ humanome_id: s.humanome_id, rt: rt });
  });

  var offset = 0;
  chunk_(reqs, FETCH_CHUNK).forEach(function (slice) {
    var responses;
    try {
      responses = UrlFetchApp.fetchAll(slice);
    } catch (e) {
      // fetchAll ごと落ちた場合は一時エラーとして全件スキップ（翌日再試行）
      slog_('WARNING', 'refresh_batch_failed', { detail: redact_(String(e)) });
      offset += slice.length;
      return;
    }
    responses.forEach(function (res, j) {
      var m = meta[offset + j];
      try {
        tokens[m.humanome_id] = handleRefreshResponse_(cfg, m.humanome_id, m.rt, res);
      } catch (e) {
        if (e.name === 'FatalConfigError') throw e;   // 上に抜けさせてジョブごと中断
        Subjects.recordError(m.humanome_id, e.message || String(e));
      }
    });
    offset += slice.length;
  });
}

/** Google 側の認可も確実に取り消す。消すだけだと被験者のマイアカウントに連携が残る（§11.3）。 */
function revokeToken_(token) {
  if (!token) return;
  try {
    UrlFetchApp.fetch(REVOKE_EP + '?token=' + encodeURIComponent(token), {
      method: 'post', muteHttpExceptions: true
    });
  } catch (e) { /* best effort */ }
}

/**
 * 02_WebApp.gs — Web アプリのルーターと画面
 *
 * GAS 固有の制約（§7.2）：
 *   - ScriptApp.newStateToken() + usercallback は使えない（state が発行者に紐づくため
 *     被験者=他人のアカウントでコールバックすると "Authorization is required" で落ちる）
 *   - doGet は HTTP 302 を返せない。サンドボックス iframe 内なので location.href も
 *     X-Frame-Options で拒否される → <base target="_top"> + リンクでトップフレームを遷移させる
 *   - 同意ページは自動遷移させず明示ボタン（ポップアップブロッカー対策 + 倫理審査上の説明責任）
 */

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.setup)           return renderSetupPage_();
    if (p.admin)           return renderAdminPage_();
    if (p.code || p.error) return handleCallback_(p);
    if (p.link_id)         return renderConsentPage_(p.link_id);
    return page_('無効なURL', '<p>このURLは無効です。配布されたリンクをご確認ください。</p>');
  } catch (err) {
    Audit.log('doGet_error', '', redact_(String((err && err.stack) || err)));
    return page_('エラー', '<p>処理中にエラーが発生しました。お手数ですが担当者にご連絡ください。</p>');
  }
}

/** GAS は 302 を返せないので、トップフレームを遷移させる HTML を返す。 */
function page_(title, bodyHtml, actionUrl, actionLabel) {
  var btn = actionUrl
    ? '<p><a class="btn" href="' + escapeAttr_(actionUrl) + '" target="_top">'
      + escapeHtml_(actionLabel) + '</a></p>'
    : '';
  var html =
    '<!DOCTYPE html><html lang="ja"><head><base target="_top"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeHtml_(title) + '</title>' +
    '<style>' +
    'body{font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;' +
    'max-width:640px;margin:40px auto;padding:0 20px;line-height:1.8;color:#202124}' +
    'h1{font-size:1.4rem;line-height:1.5}' +
    '.btn{display:inline-block;background:#1a73e8;color:#fff;padding:14px 28px;' +
    'border-radius:6px;text-decoration:none;font-weight:600}' +
    '.btn:hover{background:#1765cc}' +
    'ul{background:#f5f5f5;padding:16px 16px 16px 36px;border-radius:6px}' +
    '.note{color:#5f6368;font-size:.9em}' +
    '</style></head><body>' +
    '<h1>' + escapeHtml_(title) + '</h1>' + bodyHtml + btn +
    '</body></html>';
  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ---- 同意ページ -----------------------------------------------------------

function renderConsentPage_(linkId) {
  if (!/^[0-9a-fA-F-]{36}$/.test(String(linkId))) {
    Audit.log('bad_link_format', '', '');
    return page_('無効なURL', '<p>このURLは無効です。配布されたリンクをご確認ください。</p>');
  }
  var s = Subjects.findByLinkId(linkId);
  if (!s) {
    Audit.log('link_not_found', '', '');   // 総当たり列挙の検知材料
    return page_('無効なURL', '<p>このリンクは登録されていません。配布されたリンクをご確認ください。</p>');
  }
  if (s.status === 'withdrawn') {
    return page_('参加終了', '<p>この被験者IDは参加終了済みです。</p>');
  }

  var authUrl = OAuth.buildAuthUrl(s);
  var body =
    '<p>被験者ID <b>' + escapeHtml_(s.humanome_id) + '</b> として、' +
    'Google アカウントの健康データを研究のために連携します。</p>' +
    '<p>取得する情報:</p><ul>' +
    '<li>歩数・移動距離・消費カロリー・アクティブゾーン分</li>' +
    '<li>心拍数・安静時心拍・心拍変動</li>' +
    '<li>睡眠記録（睡眠ステージを含む）</li>' +
    '</ul>' +
    '<p>次の画面で <b>すべての項目にチェックを入れて</b>「続行」を押してください。' +
    '一部でも外すとデータを取得できません。</p>' +
    '<p class="note">審査前のアプリのため「このアプリは Google で確認されていません」' +
    'という警告が表示されます。「詳細」→「(アプリ名) に移動」を選んでください。</p>';

  Audit.log('consent_page_view', s.humanome_id, '');
  return page_('研究データ連携のお願い', body, authUrl, 'Google アカウントと連携する');
}

// ---- コールバック ---------------------------------------------------------

function handleCallback_(p) {
  if (p.error) {
    Audit.log('oauth_denied', '', String(p.error).substring(0, 100));
    return page_('連携がキャンセルされました',
      '<p>もう一度お試しになる場合は、配布されたリンクを開き直してください。</p>');
  }

  var st = OAuth.consumeState(p.state);
  if (!st) {
    Audit.log('oauth_bad_state', '', 'state not found / replayed');
    return page_('セッションの有効期限が切れました',
      '<p>お手数ですが、配布されたリンクをもう一度開いてください。</p>');
  }

  var cfg = Config.forConfigName(st.config_name);
  var tok = exchangeCode_(cfg, p.code, st.verifier);
  if (!tok || !tok.refresh_token) {
    Audit.log('oauth_no_refresh_token', st.humanome_id,
      tok ? String(tok.error || 'no refresh_token in response') : 'empty response');
    return page_('もう一度お試しください',
      '<p>連携情報を取得できませんでした。お手数ですが、配布されたリンクをもう一度開いてください。</p>');
  }

  // 本人性確認：トークンで実際に誰なのかを API に聞く（ブラウザの申告を信用しない）
  var ident;
  try {
    ident = HealthApi.getIdentity(tok.access_token);
  } catch (e) {
    revokeToken_(tok.refresh_token);
    Audit.log('identity_fetch_failed', st.humanome_id, redact_(String(e)));
    return page_('連携できませんでした',
      '<p>アカウント情報を確認できませんでした。お手数ですが、しばらくしてからもう一度お試しください。</p>');
  }

  var v = Subjects.verifyBinding(st.humanome_id, ident, tok.scope);
  if (!v.ok) {
    revokeToken_(tok.refresh_token);   // 取り違えたトークンは保存せず即失効させる
    Audit.log('oauth_binding_rejected', st.humanome_id, v.code + ' ' + v.detail);
    return page_('連携できませんでした', '<p>' + escapeHtml_(v.message) + '</p>');
  }

  TokenStore.save(st.config_name, st.humanome_id, tok);
  Subjects.markAuthorized(st.humanome_id, ident, tok.scope);
  Audit.log('oauth_success', st.humanome_id, ident.healthUserId);
  Ingest.enqueueBackfill(st.config_name, st.humanome_id);

  return page_('連携が完了しました',
    '<p>ありがとうございました。この画面を閉じてください。</p>' +
    '<p class="note">連携を解除したい場合は、担当者にご連絡ください。</p>');
}

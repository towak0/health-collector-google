/**
 * 10_Alerts.gs — 日次ダイジェストとカナリア監視
 *
 * 運用で見たいのは「認証が生きているか」「データが入っているか」であって
 * トークンの中身ではない（§8.5）。メールにトークンや生の健康データを載せない。
 */
var Alerts = {

  /** 設定エラーなど全被験者が失敗する事象。即時メール（§10）。 */
  fatal: function (message) {
    var to = prop_('ALERT_EMAIL');
    slog_('ERROR', 'fatal', { detail: redact_(message) });
    Audit.log('fatal', '', message);
    if (!to) return;
    MailApp.sendEmail({
      to: to,
      subject: '[HealthStudy] 緊急: 収集ジョブが中断しました',
      body: message + '\n\n対応：config シートの client_id / Script Properties の secret:{config_name} と、'
          + 'GCP の OAuth クライアントが削除されていないかを確認してください。'
    });
  },

  /** 毎朝 08:00。前日ジョブの結果を1通にまとめる（§12.3）。 */
  digest: function () {
    var to = prop_('ALERT_EMAIL');
    if (!to) { slog_('WARNING', 'digest_no_recipient', {}); return; }

    var subjects = Subjects.all();
    var jobId    = String(Props.getProperty('last_job_id') || '');
    var failed   = jobId ? IngestLog.failedOf(jobId) : [];

    var byStatus = {};
    subjects.forEach(function (s) { byStatus[s.status] = (byStatus[s.status] || 0) + 1; });

    var stale = subjects.filter(function (s) {
      return s.status === 'authorized' && (Number(s.consecutive_empty_days) || 0) >= 3;
    });
    var revoked = subjects.filter(function (s) { return s.status === 'revoked'; });
    var flagged = subjects.filter(function (s) { return String(s.review_flag || '') !== ''; });
    var pending = subjects.filter(function (s) { return s.status === 'issued'; });

    var lines = [];
    lines.push('■ ジョブ: ' + (jobId || '(未完了)'));
    lines.push('■ 被験者ステータス: ' + Object.keys(byStatus).map(function (k) {
      return k + '=' + byStatus[k];
    }).join(' / '));
    lines.push('■ 失敗リクエスト: ' + failed.length + ' 件');
    lines.push('');

    // 欠測の理由を切り分けて差し込む
    try { diagnoseDigestLines_().forEach(function (l) { lines.push(l); }); }
    catch (e) { lines.push('● データ状況: 判定に失敗しました', ''); }

    if (revoked.length) {
      lines.push('● 連携切れ（URL 再発行が必要 / reissueLink を実行）: ' + revoked.length + ' 名');
      revoked.slice(0, 30).forEach(function (s) {
        lines.push('   - ' + s.humanome_id + '  ' + String(s.last_error || '').substring(0, 80));
      });
      lines.push('');
    }

    if (flagged.length) {
      lines.push('● 要人手確認（review_flag）: ' + flagged.length + ' 名  ※自動解決しません');
      flagged.slice(0, 30).forEach(function (s) {
        lines.push('   - ' + s.humanome_id + '  ' + s.review_flag);
      });
      lines.push('');
    }

    if (stale.length) {
      lines.push('● 0件が3日以上継続（デバイス未同期の疑い）: ' + stale.length + ' 名');
      stale.slice(0, 30).forEach(function (s) {
        lines.push('   - ' + s.humanome_id + '  ' + s.consecutive_empty_days + '日');
      });
      lines.push('');
    }

    if (pending.length) {
      lines.push('● 未連携（リマインド対象）: ' + pending.length + ' 名');
      lines.push('');
    }

    if (failed.length) {
      lines.push('● 失敗リクエスト（先頭20件。翌日のジョブで再取得されます）');
      failed.slice(0, 20).forEach(function (r) {
        lines.push('   - ' + r.humanome_id + ' ' + r.data_type + ' ' + r.target_range +
                   ' HTTP' + r.http_code + ' ' + String(r.error || '').substring(0, 60));
      });
    }

    MailApp.sendEmail({
      to: to,
      subject: '[HealthStudy] 日次ダイジェスト ' + isoDate_(new Date()) +
               (revoked.length || flagged.length ? ' ※要対応あり' : ''),
      body: lines.join('\n')
    });
  },

  /**
   * カナリア監視（§2.3）。Phase 3 の必須ゲート。
   * Project C のテストアカウント2件で認可し、10日以上にわたって毎日リフレッシュが
   * 成功することを確認するまで Phase 7（本番配布）に進んではならない。
   *
   * 「In production かつ未審査」で refresh_token が7日失効しないことは公開情報が割れており、
   * 実測でしか確かめられない。ここが赤くなったら配布計画を止める。
   */
  canary: function () {
    var canaries = Subjects.all().filter(function (s) {
      return String(s.type) === 'canary' && s.status === 'authorized';
    });
    if (!canaries.length) { slog_('INFO', 'canary_none', {}); return; }

    var results = [];
    var allOk = true;
    canaries.forEach(function (s) {
      var cfg = Config.forConfigName(s.config_name);
      TokenStore.dropAccess(cfg.config_name, s.humanome_id);   // 必ず実リフレッシュさせる
      var authorizedAt = s.authorized_at ? String(s.authorized_at).substring(0, 10) : '';
      var days = authorizedAt ? diffDays_(isoDate_(new Date()), authorizedAt) : 0;
      try {
        refreshAccessToken_(cfg, s.humanome_id);
        results.push('  OK   ' + s.humanome_id + '  認可から ' + days + ' 日');
      } catch (e) {
        allOk = false;
        results.push('  FAIL ' + s.humanome_id + '  認可から ' + days + ' 日  ' + (e.code || e.name));
      }
    });

    var to = prop_('ALERT_EMAIL');
    Audit.log('canary_check', '', (allOk ? 'ok' : 'FAILED') + ' n=' + canaries.length);
    if (!to) return;
    if (!allOk) {
      MailApp.sendEmail({
        to: to,
        subject: '[HealthStudy] ★カナリア失敗★ refresh_token が失効しました',
        body: 'refresh_token のリフレッシュに失敗しました。本番配布（Phase 7）に進まないでください。\n\n'
            + results.join('\n')
            + '\n\n確認事項:\n'
            + ' - OAuth 同意画面の公開ステータスが「本番環境（In production）」になっているか\n'
            + ' - 手動で認可を取り消していないか\n'
            + ' - 7日前後で失効している場合、未審査アプリにも7日制限が適用されている可能性があります'
      });
    } else {
      MailApp.sendEmail({
        to: to,
        subject: '[HealthStudy] カナリア OK ' + isoDate_(new Date()),
        body: results.join('\n') + '\n\n10日以上 OK が続いたら Phase 7 に進めます。'
      });
    }
  }
};

function sendDailyDigest() { Alerts.digest(); }
function runCanaryCheck()  { Alerts.canary(); }


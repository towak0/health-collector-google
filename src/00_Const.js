/**
 * 00_Const.gs — 定数定義
 *
 * ここに書いてよいのは「コードのバージョンと一体で変わるもの」だけ。
 * 試験ごとに変わる設定は config シート、収集対象は datatypes シート、
 * 秘密情報は Script Properties に置く（§5.7 / §8.2 / §11.1）。
 */

// ---- エンドポイント -------------------------------------------------------
var AUTH_EP    = 'https://accounts.google.com/o/oauth2/v2/auth';
var TOKEN_EP   = 'https://oauth2.googleapis.com/token';
var REVOKE_EP  = 'https://oauth2.googleapis.com/revoke';
var HEALTH_API = 'https://health.googleapis.com/v4';

// ---- スコープ（§5.1：この4つのみ。増やさない） ----------------------------
var SCOPE_ACTIVITY = 'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly';
var SCOPE_METRICS  = 'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly';
var SCOPE_SLEEP    = 'https://www.googleapis.com/auth/googlehealth.sleep.readonly';
var SCOPE_PROFILE  = 'https://www.googleapis.com/auth/googlehealth.profile.readonly';

var REQUIRED_SCOPES = [SCOPE_ACTIVITY, SCOPE_METRICS, SCOPE_SLEEP, SCOPE_PROFILE];

/** datatypes シートの scope_key 列 → 実スコープ URL */
var SCOPE_KEYS = {
  activity: SCOPE_ACTIVITY,
  metrics:  SCOPE_METRICS,
  sleep:    SCOPE_SLEEP,
  profile:  SCOPE_PROFILE
};

// ---- タイムゾーン / 日付 --------------------------------------------------
var TZ = 'Asia/Tokyo';
/** rollUp の RFC3339 range に使う UTC オフセット。TZ を変えたらここも変える。 */
var TZ_OFFSET = '+09:00';

// ---- 実行制御（§9.2） -----------------------------------------------------
var SOFT_DEADLINE_MS = 4.5 * 60 * 1000;  // 6分制限に対する安全マージン
var SUBJECT_CHUNK    = 25;               // 1ラウンドで処理する被験者数
var FETCH_CHUNK      = 40;               // fetchAll 1回あたりのリクエスト数
var MAX_RETRY        = 3;
var LOOKBACK_DAYS    = 3;                // 日次：「3日前〜昨日」のローリング窓
var WEEKLY_CATCHUP_DAYS = 7;             // 週次：「7日前〜昨日」を取り直して未同期分を回収
var BACKFILL_DAYS    = 90;
var HR_MAX_SPAN_DAYS = 14;               // §5.3 心拍系の1リクエスト上限
var STD_MAX_SPAN_DAYS = 90;

// ---- Properties / Cache キー ---------------------------------------------
var CURSOR_KEY          = 'ingest_cursor';
var BACKFILL_CURSOR_KEY = 'backfill_cursor';
var WEEKLY_CURSOR_KEY   = 'weekly_cursor';
var BACKFILL_QUEUE_KEY  = 'backfill_queue';   // "config|humanome_id" のカンマ区切り
var STATE_TTL_SEC       = 600;

// ---- シート名 -------------------------------------------------------------
var OPS_SHEETS = {
  config:     'config',
  subjects:   'subjects',
  datatypes:  'datatypes',
  ingest_log: 'ingest_log',
  audit:      'audit'
};
var DATA_SHEETS = {
  daily_summary:  'daily_summary',
  sleep_sessions: 'sleep_sessions',
  sleep_stages:   'sleep_stages',
  devices:        'devices'
};

// ---- シート列定義（順序 = 列順。変更時は既存シートの移行が必要） ----------
var COL_CONFIG = ['config_name','gcp_project','client_id','redirect_uri','base_username','scopes','status'];

var COL_SUBJECTS = [
  'config_name','humanome_id','type','link_id','login_url','created_at','status',
  'health_user_id','legacy_user_id','granted_scopes','authorized_at',
  'last_success_at','last_error_at','last_error','consecutive_empty_days',
  'backfill_done_until','disabled_data_types','review_flag','notes'
];

var COL_DATATYPES = ['data_type_id','method','window','scope_key','page_size','sink','enabled'];

var COL_INGEST_LOG = ['job_id','ts','humanome_id','data_type','target_range','status','http_code','n_points','ms','error'];

var COL_AUDIT = ['ts','event','humanome_id','detail'];

var COL_DAILY_SUMMARY = [
  'humanome_id','civil_date','steps','distance_m','active_energy_kcal','total_calories_kcal',
  'azm_total','hr_avg','hr_min','hr_max','resting_hr','hrv_rmssd_ms',
  'sleep_total_min','sleep_deep_min','sleep_light_min','sleep_rem_min','sleep_awake_min',
  'source_job_id','updated_at',
  // ★ 後から追加した列は末尾に足す（既存シートの列順を壊さないため）。
  //   追加したら migrateSheetColumns() を1回実行してヘッダを揃える。
  'hrv_avg_ms','hrv_entropy','non_rem_hr'
];

var COL_SLEEP_SESSIONS = [
  'humanome_id','civil_date','session_id','start_at','end_at','duration_min',
  'deep_min','light_min','rem_min','awake_min','short_awakenings',
  'minutes_to_fall_asleep','minutes_after_wakeup','dedupe_key','updated_at'
];

var COL_SLEEP_STAGES = [
  'humanome_id','session_id','stage_index','stage_type','start_at','end_at','duration_min','dedupe_key'
];

var COL_DEVICES = ['humanome_id','device_id','model','last_sync_at','battery','checked_at'];

// ---- filter 式テンプレート（§5.5） ---------------------------------------
// ★ §16-1：daily-* 系の左辺 camelCase は公式例からの推定。実装時に
//   各データ型の REST リファレンスで filter parameter 名を確認して確定させること。
//   ここに定義のないデータ型は FILTER_TEMPLATES 参照時に例外を投げる（全件取得の暗黙発生を防ぐ）。
/** filter を一切付けずに取得し、コード側で日付を絞る型の印（sleep 用）。 */
var NO_FILTER = '@NO_FILTER';

var FILTER_TEMPLATES = {
  'steps':                        'steps.interval.civil_start_time >= "{from}T00:00:00" AND steps.interval.civil_start_time < "{toExclusive}T00:00:00"',
  'distance':                     'distance.interval.civil_start_time >= "{from}T00:00:00" AND distance.interval.civil_start_time < "{toExclusive}T00:00:00"',
  // ★ 実測：sleep はどのメンバーも filter に使えない（全て INVALID_DATA_POINT_FILTER_DATA_TYPE_MEMBER）。
  //    フィルタなしで取得し、コード側で日付を絞る。
  'sleep':                        NO_FILTER,
  'heart-rate':                   'heartRate.sample_time.physical_time >= "{from}T00:00:00Z" AND heartRate.sample_time.physical_time < "{toExclusive}T00:00:00Z"',
  'daily-resting-heart-rate':     'daily_resting_heart_rate.date >= "{from}" AND daily_resting_heart_rate.date < "{toExclusive}"',
  'daily-heart-rate-variability': 'daily_heart_rate_variability.date >= "{from}" AND daily_heart_rate_variability.date < "{toExclusive}"'
};

/** 1リクエストで取得できる期間上限（§5.3） */
var MAX_SPAN_DAYS = {
  'heart-rate': HR_MAX_SPAN_DAYS,
  'total-calories': HR_MAX_SPAN_DAYS,
  'active-minutes': HR_MAX_SPAN_DAYS,
  'calories-in-heart-rate-zone': HR_MAX_SPAN_DAYS
};

/** dailyRollUp レスポンス value.{envelope}.{field} → daily_summary の列
 *  ★ §16-3：集計フィールド名（{元フィールド}_{集計関数}）はデータ型ごとに RollupValue 型が
 *    異なる。実測レスポンスで確定させること。ここは候補を順に探す方式にして名前揺れに耐える。
 *    候補が全部外れた場合は ingest_log に unmapped_field として記録される（黙って欠測にしない）。 */
var ROLLUP_EXTRACT = {
  'steps': [
    { envelopes: ['steps'], fields: ['countSum'], column: 'steps' }
  ],
  'distance': [
    // ★ 実測：distance は millimetersSum（ミリメートル）。メートルに直す。
    { envelopes: ['distance'], fields: ['millimetersSum', 'distanceMetersSum', 'metersSum', 'valueSum'], column: 'distance_m', scale: 0.001 }
  ],
  'active-energy-burned': [
    { envelopes: ['activeEnergyBurned'], fields: ['kcalSum', 'energyKilocaloriesSum', 'kilocaloriesSum', 'caloriesSum', 'valueSum'], column: 'active_energy_kcal' }
  ],
  'total-calories': [
    // ★ 実測：total-calories は kcalSum。
    { envelopes: ['totalCalories'], fields: ['kcalSum', 'energyKilocaloriesSum', 'kilocaloriesSum', 'valueSum'], column: 'total_calories_kcal' }
  ],
  'active-zone-minutes': [
    { envelopes: ['activeZoneMinutes'], fields: ['minutesSum', 'totalMinutesSum', 'valueSum'], column: 'azm_total' }
  ],
  'heart-rate': [
    { envelopes: ['heartRate'], fields: ['beatsPerMinuteAvg', 'bpmAvg', 'beatsPerMinuteMean'], column: 'hr_avg' },
    { envelopes: ['heartRate'], fields: ['beatsPerMinuteMin', 'bpmMin'], column: 'hr_min' },
    { envelopes: ['heartRate'], fields: ['beatsPerMinuteMax', 'bpmMax'], column: 'hr_max' }
  ]
};

/** list メソッドで取る daily-* 系 → daily_summary の列名と値の探索候補 */
var DAILY_LIST_MAP = {
  'daily-resting-heart-rate': {
    envelope: 'dailyRestingHeartRate',
    extract: [
      { column: 'resting_hr', fields: ['beatsPerMinute', 'bpm', 'value'] }
    ]
  },
  // ★ 実測：Fitbit は HRV を4つの指標で返す。RMSSD（深睡眠中）と平均 HRV は別物なので
  //   同じ列に混ぜない。entropy と非REM心拍も解析で使えるので拾っておく。
  'daily-heart-rate-variability': {
    envelope: 'dailyHeartRateVariability',
    extract: [
      { column: 'hrv_rmssd_ms', fields: ['deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds', 'rmssdMilliseconds', 'rmssd'] },
      { column: 'hrv_avg_ms',   fields: ['averageHeartRateVariabilityMilliseconds'] },
      { column: 'hrv_entropy',  fields: ['entropy'] },
      { column: 'non_rem_hr',   fields: ['nonRemHeartRateBeatsPerMinute'] }
    ]
  }
};

var SLEEP_STAGE_TO_COLUMN = {
  DEEP:  'sleep_deep_min',
  LIGHT: 'sleep_light_min',
  REM:   'sleep_rem_min',
  AWAKE: 'sleep_awake_min'
};
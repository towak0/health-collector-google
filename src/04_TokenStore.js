/**
 * 04_TokenStore.gs — refresh_token(Properties) / access_token(Cache) の抽象
 *
 * §8.5：refresh_token は Script Properties 一択。スプレッドシートに書かない
 * （版履歴に平文で永久に残り、後から消せない）。ログにも出さない。
 */
var TokenStore = (function () {
  var props = PropertiesService.getScriptProperties();
  var cache = CacheService.getScriptCache();

  function rk(c, h) { return 'rt:' + c + '|' + h; }
  function ak(c, h) { return 'at:' + c + '|' + h; }

  return {
    save: function (c, h, tok) {
      if (tok.refresh_token) props.setProperty(rk(c, h), tok.refresh_token);
      if (tok.access_token) {
        var ttl = Math.max(60, Math.min(21600, (tok.expires_in || 3600) - 300));
        cache.put(ak(c, h), JSON.stringify({ t: tok.access_token, exp: Date.now() + ttl * 1000 }), ttl);
      }
    },

    getRefresh: function (c, h) { return props.getProperty(rk(c, h)); },

    getAccess: function (c, h) {
      var v = cache.get(ak(c, h));
      if (!v) return null;
      var o = safeJson_(v);
      return (o && o.exp > Date.now()) ? o.t : null;
    },

    /** 401 を受けたとき、キャッシュだけ捨てて強制リフレッシュさせる。 */
    dropAccess: function (c, h) { cache.remove(ak(c, h)); },

    drop: function (c, h) {
      props.deleteProperty(rk(c, h));
      cache.remove(ak(c, h));
    },

    /** 保有している refresh_token の本数（中身は返さない）。 */
    countRefresh: function () {
      var all = props.getKeys();
      return all.filter(function (k) { return k.indexOf('rt:') === 0; }).length;
    }
  };
})();

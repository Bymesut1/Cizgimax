// ============================================================
//  cizgimax — Nuvio scraper (cizgimax.online, Türkçe dublajlı çizgi film / anime)
//  Akış: TMDB (dizi adı) -> /ara/?q= araması (+ adres tahmini) -> bölüm sayfası
//        -> sayfadaki sunucu listesi (base64) -> /oynat/?t= yönlendirmesi çöz -> video linki
// ============================================================

var AYAR = {
  SITE: 'https://cizgimax.online',
  EKLENTI_ADI: 'ÇizgiMax',
  DEBUG_MODU: false,     // true: akışların altında da teşhis satırları görünür. (Akış çıkmazsa zaten otomatik görünür.)
  MAX_ADAY: 3,           // en fazla kaç aday dizi için bölüm sayfası denensin
  MAX_SORGU: 3,          // en fazla kaç arama yapılsın
  TELIF_ATLA: true,      // site "telif nedeniyle açılmıyor" diyen sunucuları (sibnet) atla
  SADECE_DUBLAJ: false,  // true: altyazılı sunucular gösterilmesin
  ARAMA_SURESI: 5000,    // ms
  SUNUCU_SURESI: 6000,   // ms (her sunucu çözümü)
  GENEL_SURE: 11000      // ms
};

var TMDB_KEY = '000316508321ce461cf81e7c6815eec7';
var PROVIDER_ID = 'cizgimax';
var UA = 'Mozilla/5.0 (Linux; Android 13; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36';
var dbg = [];

// ---------------- Yardımcılar ----------------
function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
    promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}
function waitWithin(promises, ms) {
  return new Promise(function (resolve) {
    var left = promises.length, done = false;
    if (!left) { resolve(); return; }
    var t = setTimeout(function () { if (!done) { done = true; resolve(); } }, ms);
    promises.forEach(function (p) {
      p.then(function () {}, function () {}).then(function () {
        left--;
        if (left === 0 && !done) { done = true; clearTimeout(t); resolve(); }
      });
    });
  });
}
function uniq(list) { var o = []; list.forEach(function (x) { if (x && o.indexOf(x) === -1) o.push(x); }); return o; }
function getJson(url) { return withTimeout(fetch(url), 10000).then(function (r) { return r.json(); }); }
function pageHeaders(extra) {
  var h = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8', 'Referer': AYAR.SITE + '/' };
  if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
  return h;
}
function decodeHtml(s) {
  return String(s || '').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
var TRM = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u' };
function asciiLower(s) {
  return String(s || '').replace(/İ/g, 'i').replace(/I/g, 'i').toLowerCase().replace(/[çğıöşüâîû]/g, function (c) { return TRM[c]; });
}
function norm(s) { return asciiLower(s).replace(/[^a-z0-9]/g, ''); }
function slugify(s) { return asciiLower(s).replace(/&/g, ' ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
var STOP = { the: 1, a: 1, an: 1, of: 1, and: 1, ve: 1, izle: 1 };
function toks(s) { return asciiLower(s).split(/[^a-z0-9]+/).filter(function (t) { return t && !STOP[t]; }); }
function simScore(a, b) {
  var na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (na.length >= 4 && nb.length >= 4 && (na.indexOf(nb) > -1 || nb.indexOf(na) > -1)) {
    return 55 + Math.round(30 * Math.min(na.length, nb.length) / Math.max(na.length, nb.length));
  }
  var ta = toks(a), tb = toks(b);
  if (!ta.length || !tb.length) return 0;
  var common = ta.filter(function (x) { return tb.indexOf(x) > -1; }).length;
  return Math.round(60 * common / Math.max(ta.length, tb.length));
}
function absUrl(u) {
  u = String(u || '');
  if (u.indexOf('//') === 0) return 'https:' + u;
  if (u.charAt(0) === '/') return AYAR.SITE + u;
  return u;
}
function hostOf(u) { var m = String(u || '').match(/^https?:\/\/([^\/?#]+)/i); return m ? m[1].toLowerCase() : ''; }

// base64 (atob her ortamda olmayabilir) -> UTF-8 metin
function b64d(s) {
  var C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+\/]/g, '');
  var bytes = [], bits = 0, val = 0, i;
  for (i = 0; i < s.length; i++) {
    val = (val << 6) | C.indexOf(s.charAt(i));
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((val >> bits) & 255); }
  }
  try { return decodeURIComponent(bytes.map(function (b) { return '%' + ('0' + b.toString(16)).slice(-2); }).join('')); }
  catch (e) { return bytes.map(function (b) { return String.fromCharCode(b); }).join(''); }
}

// ---------------- Arama ----------------
function parseSearch(html) {
  var map = {}, order = [], i, c;
  html = String(html || '');
  function put(path, title, alt, year) {
    if (!map[path]) { map[path] = { path: path, titles: [], year: 0 }; order.push(path); }
    var e = map[path];
    [title, alt].forEach(function (t) { t = decodeHtml(t || '').trim(); if (t && e.titles.indexOf(t) === -1) e.titles.push(t); });
    if (year && !e.year) e.year = parseInt(year, 10) || 0;
  }
  var chunks = html.split('<div class="film-item');
  for (i = 1; i < chunks.length; i++) {
    c = chunks[i];
    var m = c.match(/href="(\/diziler\/[^"\/]+\/)"[^>]*class="film-name"([^>]*)>([^<]+)</) || c.match(/href="(\/diziler\/[^"\/]+\/)"/);
    if (!m) continue;
    put(m[1], m[3] || (c.match(/alt="([^"]+)"/) || [])[1], (c.match(/data-alt-title="([^"]*)"/) || [])[1],
        (c.match(/Yay[ıi]n Y[ıi]l[ıi]:<\/span>\s*(\d{4})/) || [])[1]);
  }
  var re = /href="(?:https?:\/\/cizgimax\.online)?(\/diziler\/([a-z0-9\-]+)-izle\/)"[^>]*?(?:title="([^"]*)")?[^>]*>([^<]*)</gi, mm;
  while ((mm = re.exec(html)) !== null) {
    put(mm[1], mm[3] || mm[4] || mm[2].replace(/-/g, ' '), '', 0);
  }
  var re2 = /href="(?:https?:\/\/cizgimax\.online)?(\/diziler\/([a-z0-9\-]+)-izle\/)"/gi, m2;
  while ((m2 = re2.exec(html)) !== null) put(m2[1], m2[2].replace(/-/g, ' '), '', 0);
  return order.map(function (p) { return map[p]; });
}
function fetchInfo(url, headers) {
  return withTimeout(fetch(url, { headers: headers }), AYAR.SUNUCU_SURESI).then(function (res) {
    var ct = ''; try { ct = String(res.headers.get('content-type') || ''); } catch (e) {}
    var fin = res.url || url;
    if (/^(video|audio)\/|mpegurl|dash\+xml|octet-stream/i.test(ct)) return { status: res.status, url: fin, ct: ct, text: '', media: true };
    return withTimeout(res.text(), 5000).then(
      function (t) { return { status: res.status, url: fin, ct: ct, text: t || '', media: false }; },
      function () { return { status: res.status, url: fin, ct: ct, text: '', media: false }; });
  }).catch(function (e) { return { status: 0, url: url, ct: '', text: '', media: false, err: (e && e.message) || 'hata' }; });
}

// ---------------- Sunucu listesi (bölüm sayfası) ----------------
function parseServers(html) {
  var out = [], seen = {};
  function lit(name) {
    var m = html.match(new RegExp('var ' + name + '\\s*=\\s*JSON\\.parse\\(atob\\(("(?:\\\\.|[^"\\\\])*")\\)\\)'));
    if (!m) return null;
    try { return JSON.parse(b64d(JSON.parse(m[1]))); } catch (e) { return null; }
  }
  function add(s, lang) {
    if (!s) return;
    var key = s.src || s.streamUrl || s.resolveUrl || s.metaUrl;
    if (!key || seen[key]) return;
    seen[key] = true;
    s.lang = s.lang || lang || 'any';
    out.push(s);
  }
  var byLang = lit('serversByLang');
  if (byLang) ['dub', 'any', 'sub'].forEach(function (l) { (byLang[l] || []).forEach(function (s) { add(s, l); }); });
  (lit('servers') || []).forEach(function (s) { add(s, ''); });
  if (!out.length) {
    var im = html.match(/<iframe[^>]+id="cizgimax-iframe"[^>]+src="([^"]+)"/i);
    if (im) add({ type: 'iframe', src: decodeHtml(im[1]), label: 'Oynatıcı', lang: 'any' }, 'any');
  }
  return out;
}

// ---------------- Video linki çözme ----------------
var OKQ = { ultra: 2160, quad: 1440, full: 1080, hd: 720, sd: 480, low: 360, lowest: 240, mobile: 144 };
function fixMediaUrl(u) {
  u = decodeHtml(String(u || '')).replace(/\\u002F/gi, '/').replace(/\\u0026/gi, '&').replace(/\\\//g, '/');
  return u.indexOf('//') === 0 ? 'https:' + u : u;
}
function okruMeta(html) {
  var re = /data-options="([^"]+)"/g, m;
  while ((m = re.exec(html)) !== null) {
    if (m[1].indexOf('flashvars') === -1) continue;
    try {
      var o = JSON.parse(decodeHtml(m[1])), md = o.flashvars && o.flashvars.metadata;
      if (typeof md === 'string') md = JSON.parse(md);
      if (!md) continue;
      var res = [];
      (md.videos || []).forEach(function (v) {
        var h = OKQ[v.name] || 0;
        res.push({ url: fixMediaUrl(v.url), quality: h ? h + 'p' : (v.name || 'Auto'), h: h });
      });
      res.sort(function (a, b) { return b.h - a.h; });
      var hls = md.hlsManifestUrl || md.hlsMasterPlaylistUrl || md.ondemandHls;
      if (hls) res.push({ url: fixMediaUrl(hls), quality: 'Auto', h: 0 });
      if (res.length) return res;
    } catch (e) {}
  }
  return [];
}
function qualOf(u) {
  var m = String(u).match(/(2160|1440|1080|720|480|360|240)p?/);
  if (/dzen_dash/.test(u)) return 'DASH';
  if (/\.m3u8/i.test(u)) return 'Auto';
  return m ? m[1] + 'p' : 'Auto';
}
function scanMedia(text) {
  var t = fixMediaUrl(text), out = [], seen = {}, m;
  var re = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi;
  var re2 = /https?:\/\/[a-z0-9\-]+\.(?:okcdn\.ru|mycdn\.me|vkuser\.net)\/\?[^\s"'<>\\]+/gi;
  [re, re2].forEach(function (r) {
    while ((m = r.exec(t)) !== null) { if (!seen[m[0]]) { seen[m[0]] = true; out.push({ url: m[0], quality: qualOf(m[0]) }); } }
  });
  return out;
}
function isMediaUrl(u) {
  return /\.(mp4|m3u8)(\?|$)/i.test(u) || /(okcdn\.ru|mycdn\.me|vkuser\.net)\/\?/i.test(u);
}
function refererFor(u, fallback) {
  var h = hostOf(u);
  if (/okcdn|mycdn|vkuser|ok\.ru/.test(h)) return 'https://ok.ru/';
  if (/sibnet/.test(h)) return 'https://video.sibnet.ru/';
  return fallback;
}
function extract(r, pageUrl) {
  var u = r.url, t = r.text || '', res = [];
  if (r.media || (isMediaUrl(u) && !/html/i.test(r.ct))) return [{ url: u, quality: qualOf(u), ref: refererFor(u, pageUrl) }];
  res = okruMeta(t);
  if (!res.length) {                                              // sibnet
    var sm = t.match(/player\.src\(\s*\[\s*\{\s*src:\s*"([^"]+)"/);
    if (sm) res = [{ url: /^https?:/.test(sm[1]) ? sm[1] : 'https://video.sibnet.ru' + sm[1], quality: 'Auto' }];
  }
  if (!res.length) res = scanMedia(t);
  var base = refererFor(u, u.replace(/^(https?:\/\/[^\/]+).*$/, '$1/'));
  return res.map(function (x) { x.ref = /sibnet/.test(hostOf(u)) ? u : base; return x; });
}
function resolveServer(s, pageUrl) {
  var direct = s.streamUrl ? absUrl(s.streamUrl) : '';
  if (/^https?:/.test(direct)) return Promise.resolve([{ url: direct, quality: qualOf(direct), ref: AYAR.SITE + '/' }]);
  var src = absUrl(s.src || s.resolveUrl || s.metaUrl || '');
  if (!src) return Promise.resolve([]);
  return fetchInfo(src, pageHeaders({ 'Referer': pageUrl, 'Range': 'bytes=0-0' })).then(function (r) {
    dbg.push((s.label || s.type) + ' -> ' + (r.status || r.err || '?') + ' ' + hostOf(r.url) + ' ' + String(r.ct).slice(0, 24) + ' ' + (r.media ? 'MEDYA' : r.text.length + 'b'));
    return extract(r, pageUrl);
  });
}

// ---------------- Ana akış ----------------
function debugStream(msg) {
  return [msg].concat(dbg.slice(0, 40)).map(function (r) {
    return { name: 'DEBUG ' + r, title: 'DEBUG ' + r, url: 'https://debug.invalid/', quality: 'Auto', provider: PROVIDER_ID };
  });
}
function langLabel(l) { return l === 'dub' ? 'TR Dublaj' : (l === 'sub' ? 'TR Altyazı' : 'TR'); }

function getStreamsInner(tmdbId, mediaType, season, episode) {
  if (mediaType !== 'tv') return Promise.resolve([]);
  season = parseInt(season, 10) || 1; episode = parseInt(episode, 10) || 1;
  dbg = ['cizgimax v1.0.0'];
  var base = 'https://api.themoviedb.org/3/tv/' + tmdbId + '?api_key=' + TMDB_KEY;
  return Promise.all([
    getJson(base + '&language=tr-TR&append_to_response=alternative_titles'),
    getJson(base + '&language=en-US').catch(function () { return {}; })
  ]).then(function (both) {
    var tr = both[0] || {}, en = both[1] || {};
    var year = parseInt((tr.first_air_date || en.first_air_date || '').slice(0, 4), 10) || 0;
    var alts = [];
    try {
      var at = tr.alternative_titles || {};
      (at.results || at.titles || []).forEach(function (a) { if (a && a.title && /^(TR|US|GB)$/.test(a.iso_3166_1 || '')) alts.push(a.title); });
    } catch (e) {}
    var names = uniq([tr.name, en.name, tr.original_name].concat(alts.slice(0, 4)));
    if (!names.length) return debugStream('TMDB bilgisi eksik');
    dbg.push('dizi ' + names[0] + ' ' + year + ' S' + season + 'E' + episode);

    var sinks = [], jobs = [];
    names.slice(0, AYAR.MAX_SORGU).forEach(function (q) {
      var sink = []; sinks.push(sink);
      jobs.push(fetchInfo(AYAR.SITE + '/ara/?q=' + encodeURIComponent(q), pageHeaders()).then(function (r) {
        var items = r.status === 200 ? parseSearch(r.text) : [];
        dbg.push('ara "' + q + '" ' + (r.status || r.err) + ' n=' + items.length);
        sink.push.apply(sink, items);
      }));
    });
    return waitWithin(jobs, AYAR.ARAMA_SURESI).then(function () {
      var cand = {};
      sinks.forEach(function (l) { l.forEach(function (it) { if (!cand[it.path]) cand[it.path] = it; }); });
      names.forEach(function (n) {                                    // adres tahmini: /diziler/<ad>-izle/
        var sl = slugify(n);
        if (sl && !cand['/diziler/' + sl + '-izle/']) cand['/diziler/' + sl + '-izle/'] = { path: '/diziler/' + sl + '-izle/', titles: [n], year: 0, guess: true };
      });
      var ranked = Object.keys(cand).map(function (p) {
        var c = cand[p], best = 0;
        c.titles.forEach(function (t) { names.forEach(function (n) { best = Math.max(best, simScore(t, n)); }); });
        if (c.guess) best = Math.min(best, 75);
        if (c.year && year) { var d = Math.abs(c.year - year); best += d === 0 ? 20 : (d === 1 ? 10 : (d > 3 ? -25 : 0)); }
        return { c: c, score: best };
      }).filter(function (x) { return x.score >= 50; }).sort(function (a, b) { return b.score - a.score; }).slice(0, AYAR.MAX_ADAY);
      dbg.push('aday ' + ranked.map(function (x) { return x.c.path.replace('/diziler/', '').replace('/', '') + ':' + x.score; }).join(' '));
      if (!ranked.length) return debugStream('dizi bulunamadi');

      var pages = ranked.map(function () { return null; });
      var pj = ranked.map(function (x, i) {
        var slug = x.c.path.replace(/^\/diziler\//, '').replace(/-izle\/$/, '');
        var url = AYAR.SITE + '/' + slug + '-' + season + '-sezon-' + episode + '-bolum-izle/';
        return fetchInfo(url, pageHeaders()).then(function (r) {
          var servers = r.status === 200 ? parseServers(r.text) : [];
          dbg.push('bolum ' + url.replace(AYAR.SITE, '') + ' ' + (r.status || r.err) + ' sunucu=' + servers.length);
          if (servers.length) pages[i] = { url: url, servers: servers };
        });
      });
      return waitWithin(pj, AYAR.ARAMA_SURESI).then(function () {
        var pg = null;
        pages.forEach(function (p) { if (!pg && p) pg = p; });
        if (!pg) return debugStream('bolum sayfasi/sunucu yok');
        var list = pg.servers.filter(function (s) {
          if (AYAR.TELIF_ATLA && s.notice === 'copyright') { dbg.push('telif atlandi ' + (s.label || '')); return false; }
          if (AYAR.SADECE_DUBLAJ && s.lang === 'sub') return false;
          return true;
        });
        var results = list.map(function () { return []; });
        var rj = list.map(function (s, i) {
          return resolveServer(s, pg.url).then(function (r) { results[i] = r || []; }, function () {});
        });
        return waitWithin(rj, AYAR.SUNUCU_SURESI + 1500).then(function () {
          var streams = [], seen = {};
          list.forEach(function (s, i) {
            (results[i] || []).forEach(function (v) {
              if (seen[v.url]) return;
              seen[v.url] = true;
              var ref = v.ref || (AYAR.SITE + '/');
              var parts = ['ÇizgiMax', s.label || langLabel(s.lang), v.quality || 'Auto'];
              streams.push({
                name: AYAR.EKLENTI_ADI + ' ' + langLabel(s.lang),
                title: parts.join(' | '),
                url: v.url,
                quality: v.quality || 'Auto',
                type: /dzen_dash/.test(v.url) ? 'dash' : (/\.m3u8/i.test(v.url) ? 'hls' : 'mp4'),
                headers: { 'User-Agent': UA, 'Referer': ref, 'Origin': ref.replace(/\/$/, '') },
                provider: PROVIDER_ID
              });
            });
          });
          if (!streams.length) return debugStream('video linki cikmadi');
          return AYAR.DEBUG_MODU ? streams.concat(debugStream('akis: ' + streams.length)) : streams;
        });
      });
    });
  }).catch(function (e) { return debugStream('hata ' + (e && e.message)); });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; resolve(debugStream('zaman asimi ' + AYAR.GENEL_SURE + 'ms')); } }, AYAR.GENEL_SURE);
    getStreamsInner(tmdbId, mediaType, season, episode).then(function (r) {
      if (!done) { done = true; clearTimeout(timer); resolve(r); }
    }, function () { if (!done) { done = true; clearTimeout(timer); resolve([]); } });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams, _t: { parseServers: parseServers, parseSearch: parseSearch, b64d: b64d } };
} else {
  global.getStreams = getStreams;
}

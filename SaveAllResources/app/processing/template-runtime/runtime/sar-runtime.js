/* Template runtime guard (loaded before any captured script).
 * Blocks network requests to the original site's operational endpoints and to any origin that is
 * not allowed in site.config.json (integrations.allowedOrigins), disables service-worker
 * registration, and stops submissions of forms that have no configured endpoint.
 * Blocked attempts are recorded in window.__SAR_BLOCKED__ and logged with console.info. */
(function () {
  'use strict';
  var cfg = window.__SAR_RUNTIME__ || { allowedOrigins: [], blockedEndpoints: [] };
  var blocked = (window.__SAR_BLOCKED__ = []);
  function record(kind, url) {
    blocked.push({ kind: kind, url: String(url) });
    try { console.info('[template] blocked ' + kind + ': ' + url + ' (configure integrations in site.config.json)'); } catch (e) {}
  }
  function isBlocked(raw) {
    var u;
    try { u = new URL(raw, location.href); } catch (e) { return false; }
    if (u.protocol === 'data:' || u.protocol === 'blob:') return false;
    if (u.origin === location.origin) return cfg.blockedEndpoints.indexOf(u.pathname) !== -1;
    return cfg.allowedOrigins.indexOf(u.origin) === -1;
  }
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : input && input.url;
      if (isBlocked(url)) {
        record('fetch', url);
        return Promise.reject(new TypeError('Blocked by template runtime: ' + url));
      }
      return origFetch.apply(this, arguments);
    };
  }
  var XHR = window.XMLHttpRequest;
  if (XHR) {
    var open = XHR.prototype.open;
    var send = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__sarBlocked = isBlocked(url) ? String(url) : null;
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      if (this.__sarBlocked) {
        record('xhr', this.__sarBlocked);
        var xhr = this;
        setTimeout(function () { xhr.dispatchEvent(new Event('error')); xhr.dispatchEvent(new Event('loadend')); }, 0);
        return;
      }
      return send.apply(this, arguments);
    };
  }
  if (navigator.sendBeacon) {
    var beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (isBlocked(url)) { record('beacon', url); return false; }
      return beacon(url, data);
    };
  }
  ['WebSocket', 'EventSource'].forEach(function (name) {
    var Orig = window[name];
    if (!Orig) return;
    window[name] = function (url, opts) {
      var abs = String(url).replace(/^ws/, 'http');
      if (isBlocked(abs)) { record(name, url); throw new DOMException('Blocked by template runtime', 'SecurityError'); }
      return new Orig(url, opts);
    };
    window[name].prototype = Orig.prototype;
  });
  if (navigator.serviceWorker && navigator.serviceWorker.register) {
    navigator.serviceWorker.register = function (url) {
      record('service-worker', url);
      return Promise.reject(new DOMException('Service workers are disabled in the template', 'SecurityError'));
    };
  }
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form && form.hasAttribute && form.hasAttribute('data-sar-form-disabled')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      record('form-submit', form.getAttribute('data-sar-form'));
      form.setAttribute('data-sar-submit-blocked', '');
    }
  }, true);
})();

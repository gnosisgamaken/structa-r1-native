/**
 * Structa server base + auth config.
 *
 * The r1 hosts this app as a static creation — there is no /v1/* backend on
 * that origin. All server calls (orchestrator postJSON, diagnostics fetchJson)
 * route through StructaServerConfig.resolve():
 *   1. ?server=<url> query param (one-off testing)
 *   2. localStorage 'structa-server-base' (set once from diagnostics drawer)
 *   3. window.StructaBuild.serverBase (baked at publish time)
 *   4. '' — same-origin (classic local/server-hosted deployment)
 *
 * Auth: if a token is configured (window.StructaBuild.serverToken or
 * localStorage 'structa-server-token'), requests to /v1/* and /buildinfo
 * carry 'X-Structa-Token'. The token is never logged.
 */
(function() {
  'use strict';

  var BASE_STORAGE_KEY = 'structa-server-base';
  var TOKEN_STORAGE_KEY = 'structa-server-token';

  function trimSlash(value) {
    return String(value || '').replace(/\/+$/, '');
  }

  function readStored(key) {
    try {
      var value = window.localStorage ? window.localStorage.getItem(key) : '';
      return value ? String(value).trim() : '';
    } catch (_) {
      return '';
    }
  }

  function getBase() {
    var fromQuery = '';
    try {
      fromQuery = new URLSearchParams(window.location.search || '').get('server') || '';
    } catch (_) {}
    var base = trimSlash(fromQuery) ||
      trimSlash(readStored(BASE_STORAGE_KEY)) ||
      trimSlash(window.StructaBuild && window.StructaBuild.serverBase) ||
      '';
    return base;
  }

  function getToken() {
    var token = trimSlash((window.StructaBuild && window.StructaBuild.serverToken) || '') ||
      readStored(TOKEN_STORAGE_KEY);
    return token;
  }

  function resolve(path) {
    if (/^https?:\/\//i.test(String(path))) return path;
    return getBase() + path;
  }

  function authHeaders(path) {
    var headers = {};
    var target = String(path || '');
    var needsAuth = getBase() !== '' ||
      target.indexOf('/v1/') === 0 ||
      target === '/buildinfo';
    if (needsAuth) {
      var token = getToken();
      if (token) headers['X-Structa-Token'] = token;
    }
    return headers;
  }

  function setBase(value) {
    try {
      if (value) window.localStorage.setItem(BASE_STORAGE_KEY, trimSlash(value));
      else window.localStorage.removeItem(BASE_STORAGE_KEY);
    } catch (_) {}
    return getBase();
  }

  function setToken(value) {
    try {
      if (value) window.localStorage.setItem(TOKEN_STORAGE_KEY, String(value).trim());
      else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch (_) {}
  }

  function status() {
    var base = getBase();
    return {
      configured: base !== '',
      base: base,
      hasToken: !!getToken()
    };
  }

  window.StructaServerConfig = Object.freeze({
    resolve: resolve,
    authHeaders: authHeaders,
    getBase: getBase,
    setBase: setBase,
    setToken: setToken,
    status: status
  });
})();
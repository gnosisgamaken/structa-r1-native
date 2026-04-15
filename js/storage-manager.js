/**
 * storage-manager.js — Multi-tier persistence for Structa on R1.
 *
 * Three tiers:
 * 1. creationStorage.plain (R1 native, base64 encoded)
 * 2. IndexedDB (browser, large capacity)
 * 3. localStorage (fast, emergency fallback)
 *
 * Write: all available tiers on every save()
 * Read: most recent timestamp wins
 * Emergency: beforeunload → sync snapshot to localStorage
 */
(() => {
  'use strict';

  const DB_NAME = 'StructaDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'appData';
  const STORAGE_KEY = 'structa-data';

  let db = null;
  const status = {
    r1Storage: false,
    indexedDB: false,
    localStorage: false
  };

  // === Tier 1: R1 creationStorage ===

  async function testR1Storage() {
    try {
      if (window.creationStorage?.plain) {
        const testKey = '_structa_test_';
        const testValue = btoa('test');
        await window.creationStorage.plain.setItem(testKey, testValue);
        const result = await window.creationStorage.plain.getItem(testKey);
        await window.creationStorage.plain.removeItem(testKey);
        status.r1Storage = (result === testValue);
      }
    } catch (e) {
      status.r1Storage = false;
    }
  }

  async function r1Save(data) {
    if (!status.r1Storage) return false;
    try {
      const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
      await window.creationStorage.plain.setItem(STORAGE_KEY, encoded);
      return true;
    } catch (e) { return false; }
  }

  async function r1Load() {
    if (!status.r1Storage) return null;
    try {
      const encoded = await window.creationStorage.plain.getItem(STORAGE_KEY);
      if (!encoded) return null;
      const json = decodeURIComponent(escape(atob(encoded)));
      return JSON.parse(json);
    } catch (e) { return null; }
  }

  // === Tier 2: IndexedDB ===

  function initIndexedDB() {
    return new Promise(resolve => {
      try {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => { status.indexedDB = false; resolve(false); };
        request.onsuccess = () => { db = request.result; status.indexedDB = true; resolve(true); };
        request.onupgradeneeded = event => {
          const database = event.target.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            database.createObjectStore(STORE_NAME, { keyPath: 'key' });
          }
        };
        setTimeout(() => { if (!status.indexedDB) resolve(false); }, 3000);
      } catch (e) { status.indexedDB = false; resolve(false); }
    });
  }

  function idbSave(data) {
    if (!status.indexedDB || !db) return false;
    try {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      tx.objectStore(STORE_NAME).put({ key: STORAGE_KEY, value: data, timestamp: Date.now() });
      return true;
    } catch (e) { return false; }
  }

  function idbLoad() {
    if (!status.indexedDB || !db) return Promise.resolve(null);
    return new Promise(resolve => {
      try {
        const tx = db.transaction([STORE_NAME], 'readonly');
        const req = tx.objectStore(STORE_NAME).get(STORAGE_KEY);
        req.onsuccess = () => resolve(req.result ? { data: req.result.value, timestamp: req.result.timestamp } : null);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }

  // === Tier 3: localStorage ===

  function testLocalStorage() {
    try {
      localStorage.setItem('_structa_test_', 'test');
      localStorage.removeItem('_structa_test_');
      status.localStorage = true;
    } catch (e) { status.localStorage = false; }
  }

  function lsSave(data) {
    if (!status.localStorage) return false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ value: data, timestamp: Date.now() }));
      return true;
    } catch (e) { return false; }
  }

  function lsLoad() {
    if (!status.localStorage) return null;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return null;
      const parsed = JSON.parse(stored);
      return { data: parsed.value || parsed, timestamp: parsed.timestamp || 0 };
    } catch (e) { return null; }
  }

  // === Public API ===

  async function init() {
    await testR1Storage();
    await initIndexedDB();
    testLocalStorage();
    return { ...status };
  }

  async function save(data) {
    const results = [];
    if (status.r1Storage) { if (await r1Save(data)) results.push('r1'); }
    if (status.indexedDB) { if (idbSave(data)) results.push('idb'); }
    if (status.localStorage) { if (lsSave(data)) results.push('ls'); }
    return results;
  }

  async function load() {
    const sources = [];

    if (status.r1Storage) {
      const r1Data = await r1Load();
      if (r1Data) sources.push({ data: r1Data, source: 'r1', timestamp: Date.now() });
    }

    if (status.indexedDB) {
      const idbData = await idbLoad();
      if (idbData) sources.push({ data: idbData.data, source: 'idb', timestamp: idbData.timestamp || 0 });
    }

    if (status.localStorage) {
      const lsData = lsLoad();
      if (lsData) sources.push({ data: lsData.data, source: 'ls', timestamp: lsData.timestamp || 0 });
    }

    if (!sources.length) return null;
    sources.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return sources[0].data;
  }

  function snapshot(data) {
    try {
      localStorage.setItem(STORAGE_KEY + '_emergency', JSON.stringify({
        value: data, timestamp: Date.now()
      }));
    } catch (e) { /* emergency — ignore */ }
  }

  window.StructaStorage = Object.freeze({
    init,
    save,
    load,
    snapshot,
    get status() { return { ...status }; }
  });
})();

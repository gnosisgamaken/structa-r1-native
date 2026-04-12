(() => {
  const state = {
    events: [],
    listeners: [],
    active: false,
    wrappedBridge: false
  };

  const MAX_EVENTS = 160;

  function clone(value) {
    try {
      if (typeof structuredClone === 'function') return structuredClone(value);
    } catch (_) {}
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  function record(source, name, payload = null) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source,
      name,
      payload: clone(payload),
      created_at: new Date().toISOString()
    };
    state.events.push(entry);
    state.events = state.events.slice(-MAX_EVENTS);
    try {
      window.dispatchEvent(new CustomEvent('structa-probe-event', { detail: entry }));
    } catch (_) {}
    return entry;
  }

  function attachWindowListener(name) {
    const handler = event => record('window', name, event?.detail || {
      type: event?.type,
      key: event?.key,
      code: event?.code,
      deltaY: event?.deltaY
    });
    window.addEventListener(name, handler);
    state.listeners.push(() => window.removeEventListener(name, handler));
  }

  function attachDocumentListener(name) {
    const handler = event => record('document', name, {
      type: event?.type,
      key: event?.key,
      code: event?.code,
      deltaY: event?.deltaY,
      pointerType: event?.pointerType
    });
    document.addEventListener(name, handler, { passive: false });
    state.listeners.push(() => document.removeEventListener(name, handler, { passive: false }));
  }

  function attachPluginWrapper() {
    const bridge = window.PluginMessageHandler;
    if (!bridge || typeof bridge.postMessage !== 'function' || state.wrappedBridge) return;
    const original = bridge.postMessage.bind(bridge);
    bridge.postMessage = payload => {
      record('bridge-out', 'PluginMessageHandler.postMessage', payload);
      return original(payload);
    };
    state.wrappedBridge = true;
  }

  function start() {
    if (state.active) return;
    state.active = true;
    [
      'backbutton',
      'scrollUp',
      'scrollDown',
      'sideClick',
      'longPressStart',
      'longPressEnd',
      'pttStart',
      'pttEnd',
      'structa-native-event'
    ].forEach(attachWindowListener);
    ['keydown', 'wheel', 'pointerdown', 'pointerup'].forEach(attachDocumentListener);
    attachPluginWrapper();
    record('probe', 'started', {
      href: window.location.href,
      userAgent: navigator.userAgent,
      hasPluginMessageHandler: !!window.PluginMessageHandler,
      hasCreationStorage: !!window.creationStorage
    });
  }

  function stop() {
    state.listeners.splice(0).forEach(dispose => dispose());
    state.active = false;
    record('probe', 'stopped');
  }

  function getEvents() {
    return state.events.map(clone);
  }

  function isActive() {
    return state.active;
  }

  window.StructaRuntimeProbe = Object.freeze({
    start,
    stop,
    getEvents,
    isActive,
    record
  });
})();

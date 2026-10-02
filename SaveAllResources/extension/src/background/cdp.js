// Thin promise wrapper around chrome.debugger (the DevTools protocol transport available to
// extensions without an open DevTools window).

const listeners = new Map(); // tabId -> Set(fn)
const detachHandlers = new Map(); // tabId -> fn
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const set = listeners.get(source.tabId);
    if (set) for (const fn of set) fn(method, params);
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    const fn = detachHandlers.get(source.tabId);
    if (fn) fn(reason);
  });
}

export class CdpSession {
  constructor(tabId) {
    this.tabId = tabId;
    this.target = { tabId };
    this.attached = false;
    this.detachReason = null;
  }

  async attach() {
    install();
    await chrome.debugger.attach(this.target, '1.3');
    this.attached = true;
    detachHandlers.set(this.tabId, (reason) => {
      this.attached = false;
      this.detachReason = reason;
    });
  }

  send(method, params = {}, timeoutMs = 30_000) {
    if (!this.attached) return Promise.reject(new Error(`debugger detached (${this.detachReason || 'not attached'})`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), timeoutMs);
      chrome.debugger.sendCommand(this.target, method, params).then(
        (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
  }

  on(fn) {
    if (!listeners.has(this.tabId)) listeners.set(this.tabId, new Set());
    listeners.get(this.tabId).add(fn);
    return () => listeners.get(this.tabId)?.delete(fn);
  }

  waitFor(method, predicate = () => true, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const off = this.on((m, p) => {
        if (m === method && predicate(p)) {
          clearTimeout(timer);
          off();
          resolve(p);
        }
      });
      const timer = setTimeout(() => {
        off();
        reject(Object.assign(new Error(`timeout waiting for ${method}`), { code: 'TIMEOUT' }));
      }, timeoutMs);
    });
  }

  async evaluate(expression, { awaitPromise = true, timeoutMs = 30_000 } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: false }, timeoutMs);
    if (r.exceptionDetails) {
      throw new Error('page script failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }

  async detach() {
    listeners.delete(this.tabId);
    detachHandlers.delete(this.tabId);
    if (!this.attached) return;
    this.attached = false;
    try {
      await chrome.debugger.detach(this.target);
    } catch {
      /* tab already gone */
    }
  }
}

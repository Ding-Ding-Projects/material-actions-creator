// Server API access, the access key, and the live event stream.
const listeners = { build: new Set(), remove: new Set(), auth: new Set(), recovery: new Set(), hello: new Set(), connection: new Set(), extension: new Set(), extensions: new Set() };
let key = '';
try { key = sessionStorage.getItem('mac-key') || ''; } catch { /* ignore */ }
let keyPrompt = () => {};

export function setKey(k) { key = k; try { sessionStorage.setItem('mac-key', k); } catch { /* ignore */ } }
export function getKey() { return key; }
export function onKeyRequired(fn) { keyPrompt = fn; }
export function withKey(url) { return key ? `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}` : url; }

export async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(key ? { 'x-access-key': key } : {}), ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    const err = new Error('offline');
    err.offline = true;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.accessKeyRequired) { keyPrompt(); throw new Error('Access key required'); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function on(event, fn) { listeners[event].add(fn); return () => listeners[event].delete(fn); }
const emit = (event, data) => { for (const fn of listeners[event]) fn(data); };

let es;
export function connect() {
  es?.close();
  es = new EventSource(withKey('/api/events'));
  es.addEventListener('open', () => emit('connection', true));
  for (const ev of ['hello', 'build', 'remove', 'auth', 'recovery', 'extension', 'extensions']) {
    es.addEventListener(ev, (e) => emit(ev, JSON.parse(e.data)));
  }
  es.onerror = () => { emit('connection', false); es.close(); setTimeout(connect, 3000); };
}

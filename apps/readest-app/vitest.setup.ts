// jsdom does not implement the CSS namespace; foliate-js TTS uses CSS.escape
// (mark[name="…"] lookups). Provide the standard polyfill so those paths work.
const globalWithCSS = globalThis as { CSS?: { escape?: (value: string) => string } };
if (!globalWithCSS.CSS) globalWithCSS.CSS = {};
if (typeof globalWithCSS.CSS.escape !== 'function') {
  globalWithCSS.CSS.escape = (value: string): string => {
    const string = String(value);
    const length = string.length;
    const firstCodeUnit = string.charCodeAt(0);
    let result = '';
    let index = -1;
    while (++index < length) {
      const codeUnit = string.charCodeAt(index);
      if (codeUnit === 0x0000) {
        result += '�';
      } else if (
        (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
        codeUnit === 0x007f ||
        (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
        (index === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && firstCodeUnit === 0x002d)
      ) {
        result += '\\' + codeUnit.toString(16) + ' ';
      } else if (index === 0 && length === 1 && codeUnit === 0x002d) {
        result += '\\' + string.charAt(index);
      } else if (
        codeUnit >= 0x0080 ||
        codeUnit === 0x002d ||
        codeUnit === 0x005f ||
        (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
        (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
        (codeUnit >= 0x0061 && codeUnit <= 0x007a)
      ) {
        result += string.charAt(index);
      } else {
        result += '\\' + string.charAt(index);
      }
    }
    return result;
  };
}

// This runner exposes Node's experimental `localStorage` (throws without
// --localstorage-file), so any code — production or test — that touches it
// crashes. jsdom's own window.localStorage is a real, working Storage, so
// prefer it and install THAT on every global alias; only fall back to a plain
// in-memory mock when jsdom's is unusable. The real jsdom instance matters:
// jsdom type-checks `StorageEvent.storageArea` and rejects a plain object
// (upstream's KeyboardShortcutsSettings tests dispatch such events).
// Unblocks the RSVP controller/overlay suites; see review B4/F1.
{
  const store = new Map<string, string>();
  const mock: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => {
      store.delete(k);
    },
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
  };
  const jsdomStorage = (() => {
    try {
      // vitest's jsdom environment leaves Node's own (non-functional)
      // `localStorage` accessor on the global untouched, but `frames` still
      // resolves to the real jsdom window, whose Storage is the genuine one.
      const win = (globalThis as { frames?: Window }).frames;
      const ls = win && win !== (globalThis as unknown as Window) ? win.localStorage : undefined;
      if (!ls) return undefined;
      ls.setItem('__readest_probe__', '1');
      ls.removeItem('__readest_probe__');
      return ls;
    } catch {
      return undefined;
    }
  })();
  const storage: Storage = jsdomStorage ?? mock;
  const install = (target: object | undefined) => {
    if (!target) return;
    try {
      Reflect.deleteProperty(target, 'localStorage');
    } catch {
      /* non-deletable — defineProperty below still overrides */
    }
    try {
      Object.defineProperty(target, 'localStorage', {
        configurable: true,
        writable: true,
        value: storage,
      });
    } catch {
      try {
        (target as Record<string, unknown>).localStorage = storage;
      } catch {
        /* give up on this alias */
      }
    }
  };
  // The controller code and the test file can resolve `localStorage` against
  // different global aliases (jsdom window vs Node global), so install on all.
  install(globalThis);
  install(typeof window !== 'undefined' ? window : undefined);
  install(typeof global !== 'undefined' ? (global as object) : undefined);
}

// matchMedia mock
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom reports these unimplemented methods to its virtual console even when
// the calling test passes. Tests that need media behavior replace them locally.
if (typeof HTMLMediaElement !== 'undefined') {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
  HTMLMediaElement.prototype.load = () => {};
}

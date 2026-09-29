import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * FORK: the feed reader's image proxy. Article images come from feeds, i.e. from
 * content an attacker can influence, and the proxy runs INSIDE the VPS network.
 * The two properties that matter are therefore security properties:
 *
 *   - no request ever reaches a private/link-local host — including via a
 *     redirect, which the original `redirect: 'follow'` left unchecked;
 *   - no upstream can make us buffer an unbounded body, including by lying
 *     about (or omitting) Content-Length.
 */

// sharp is a native module and only reached on the happy raster path; stub it so
// these tests stay fast and encode-independent.
vi.mock('sharp', () => {
  const chain = {
    rotate: () => chain,
    resize: () => chain,
    webp: () => chain,
    toBuffer: async () => Buffer.from([1, 2, 3, 4]),
  };
  return { default: () => chain };
});

const { GET } = await import('@/app/api/img/route');

const PNG = 'image/png';
const fetchMock = vi.fn();

const req = (url: string, extra = '') =>
  new NextRequest(`http://localhost:3000/api/img?url=${encodeURIComponent(url)}${extra}`);

const res = (body: BodyInit | null, init: ResponseInit = {}) => new Response(body, init);
const imageRes = (type = PNG, bytes = [137, 80, 78, 71]) =>
  res(new Uint8Array(bytes), { status: 200, headers: { 'content-type': type } });
const redirectTo = (location: string, status = 302) => res(null, { status, headers: { location } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

// The host list itself is upstream's `utils/network` isBlockedHost (tested in
// network-ssrf-hardening.test.ts). What matters here is that the proxy uses it:
// these are hosts the fork's old local copy let through.
describe('/api/img — uses the shared SSRF block-list', () => {
  test.each([
    'http://100.64.0.1/a.png', // CGNAT / Tailscale
    'http://[::ffff:127.0.0.1]/a.png', // IPv4-mapped loopback
    'http://nas.local/a.png',
    'http://router.lan/a.png',
    'http://intranet/a.png', // bare single-label name
  ])('refuses %s without contacting it', async (url) => {
    const r = await GET(req(url));
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: 'blocked host' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('/api/img — request gate', () => {
  test('rejects a missing url', async () => {
    const r = await GET(new NextRequest('http://localhost:3000/api/img'));
    expect(r.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects an unparseable url', async () => {
    const r = await GET(req('not a url'));
    expect(r.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    'file:///etc/passwd',
    'gopher://x/1',
    'data:image/png;base64,AAA',
  ])('rejects the %s scheme', async (url) => {
    const r = await GET(req(url));
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: 'bad scheme' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects a private host WITHOUT contacting it', async () => {
    const r = await GET(req('http://169.254.169.254/latest/meta-data/'));
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: 'blocked host' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('fetches a public host with redirect: manual, never follow', async () => {
    fetchMock.mockResolvedValue(imageRes());
    await GET(req('https://example.com/a.png'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
  });
});

describe('/api/img — redirect re-validation (A1)', () => {
  test('a redirect INTO cloud metadata is refused', async () => {
    fetchMock
      .mockResolvedValueOnce(redirectTo('http://169.254.169.254/latest/meta-data/'))
      .mockResolvedValueOnce(imageRes());
    const r = await GET(req('https://cdn.example.com/a.png'));
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: 'blocked host' });
    // Critically: the metadata endpoint was never requested.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    'http://127.0.0.1:9200/',
    'http://10.1.2.3/',
    'http://[::1]/',
  ])('a redirect to %s is refused', async (location) => {
    fetchMock.mockResolvedValueOnce(redirectTo(location)).mockResolvedValueOnce(imageRes());
    const r = await GET(req('https://cdn.example.com/a.png'));
    expect(r.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([301, 302, 303, 307, 308])('re-validates on a %i too', async (status) => {
    fetchMock
      .mockResolvedValueOnce(redirectTo('http://192.168.0.9/a.png', status))
      .mockResolvedValueOnce(imageRes());
    const r = await GET(req('https://cdn.example.com/a.png'));
    expect(r.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a redirect to another PUBLIC host is followed and served', async () => {
    fetchMock
      .mockResolvedValueOnce(redirectTo('https://images.example.org/a.png'))
      .mockResolvedValueOnce(imageRes());
    const r = await GET(req('https://cdn.example.com/a.png'));
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe('https://images.example.org/a.png');
  });

  test('a relative Location resolves against the CURRENT hop', async () => {
    fetchMock
      .mockResolvedValueOnce(redirectTo('https://images.example.org/dir/a.png'))
      .mockResolvedValueOnce(redirectTo('../b.png'))
      .mockResolvedValueOnce(imageRes());
    const r = await GET(req('https://cdn.example.com/a.png'));
    expect(r.status).toBe(200);
    expect(fetchMock.mock.calls[2]![0]).toBe('https://images.example.org/b.png');
  });

  test('a redirect that switches to a non-http scheme is refused', async () => {
    fetchMock.mockResolvedValueOnce(redirectTo('file:///etc/passwd'));
    const r = await GET(req('https://cdn.example.com/a.png'));
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: 'bad redirect scheme' });
  });

  test('a redirect loop is cut off rather than followed forever', async () => {
    fetchMock.mockResolvedValue(redirectTo('https://a.example.com/next.png'));
    const r = await GET(req('https://a.example.com/a.png'));
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ error: 'too many redirects' });
    // Bounded: the initial hop plus at most MAX_REDIRECTS more.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
  });

  test('a 3xx with no Location is treated as the final response', async () => {
    fetchMock.mockResolvedValueOnce(res(null, { status: 304 }));
    const r = await GET(req('https://cdn.example.com/a.png'));
    expect(r.status).toBe(502); // not ok -> upstream error, not an infinite loop
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('/api/img — size cap (A2)', () => {
  test('refuses on a declared Content-Length over the cap, before downloading', async () => {
    fetchMock.mockResolvedValue(
      res(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': PNG, 'content-length': String(64 * 1024 * 1024) },
      }),
    );
    const r = await GET(req('https://example.com/huge.png'));
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ error: 'too large' });
  });

  test('a LYING Content-Length cannot make us buffer the whole body', async () => {
    // Declares 1 KB, then streams 1 MB chunks forever. The running cap must stop
    // it; without the streaming check this buffers until the process dies.
    let pulls = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 64) return controller.close();
        controller.enqueue(chunk);
      },
    });
    fetchMock.mockResolvedValue(
      res(body, {
        status: 200,
        headers: { 'content-type': PNG, 'content-length': '1024' },
      }),
    );
    const r = await GET(req('https://example.com/liar.png'));
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ error: 'too large' });
    // Stopped near the 8 MB cap rather than reading all 64 MB.
    expect(pulls).toBeLessThan(12);
  });

  test('an empty body is rejected', async () => {
    fetchMock.mockResolvedValue(
      res(new Uint8Array(0), { status: 200, headers: { 'content-type': PNG } }),
    );
    const r = await GET(req('https://example.com/empty.png'));
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ error: 'bad size' });
  });

  test('a body under the cap is served', async () => {
    fetchMock.mockResolvedValue(imageRes());
    const r = await GET(req('https://example.com/ok.png'));
    expect(r.status).toBe(200);
  });
});

describe('/api/img — content-type gate', () => {
  test.each([
    'text/html',
    'application/json',
    'text/plain',
    '',
  ])('refuses %s with 415', async (type) => {
    fetchMock.mockResolvedValue(
      res(new Uint8Array([1, 2]), { status: 200, headers: type ? { 'content-type': type } : {} }),
    );
    const r = await GET(req('https://example.com/x'));
    expect(r.status).toBe(415);
    expect(await r.json()).toMatchObject({ error: 'not an image' });
  });

  test('re-encodes raster images to WebP', async () => {
    fetchMock.mockResolvedValue(imageRes('image/jpeg'));
    const r = await GET(req('https://example.com/a.jpg'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/webp');
  });

  test('passes SVG and GIF through untouched', async () => {
    for (const type of ['image/svg+xml', 'image/gif']) {
      fetchMock.mockResolvedValue(imageRes(type));
      const r = await GET(req('https://example.com/a'));
      expect(r.headers.get('content-type')).toBe(type);
    }
  });

  test('never caches publicly — the proxy sits behind the app gate', async () => {
    fetchMock.mockResolvedValue(imageRes());
    const r = await GET(req('https://example.com/a.png'));
    expect(r.headers.get('cache-control')).toContain('private');
  });
});

describe('/api/img — upstream failures', () => {
  test('a non-ok upstream becomes a 502', async () => {
    fetchMock.mockResolvedValue(res(null, { status: 404 }));
    const r = await GET(req('https://example.com/missing.png'));
    expect(r.status).toBe(502);
  });

  test('a network error becomes a 502 rather than an unhandled rejection', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await GET(req('https://example.com/a.png'));
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ error: expect.stringContaining('fetch failed') });
  });

  test('sends a Referer origin when asked, and only the origin', async () => {
    fetchMock.mockResolvedValue(imageRes());
    await GET(
      req('https://example.com/a.png', `&referer=${encodeURIComponent('https://nyt.com/a/b?c=d')}`),
    );
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['Referer']).toBe('https://nyt.com/');
  });

  test('an unparseable referer is ignored rather than fatal', async () => {
    fetchMock.mockResolvedValue(imageRes());
    const r = await GET(req('https://example.com/a.png', '&referer=%3A%3A%3A'));
    expect(r.status).toBe(200);
  });
});

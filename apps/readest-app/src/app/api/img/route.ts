import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { isBlockedHost } from '@/utils/network';

// Server-side image proxy for the FreshRSS article view. The browser can't
// fetch third-party article images (CORS), so the asset bundler routes its
// fetches through here when building the article EPUB. Raster images are
// downscaled + re-encoded to WebP server-side so the (mobile) client only ever
// downloads a small version — high enough quality for a phone screen, no larger.
//
// Reachable only behind the app's auth gate (Caddy basic_auth), so it isn't a
// public open proxy; we still enforce http(s) + an image content-type + a size
// cap + upstream's canonical SSRF host block-list (`utils/network`, shared with
// /api/opds/proxy, /api/kosync, /api/send/fetch-url), re-checked on every hop.

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
/** Redirect hops we follow manually, re-validating the host at every one. */
const MAX_REDIRECTS = 3;
// Mobile-first defaults: cap the long edge and re-encode at a quality that's
// crisp on a phone (incl. hi-DPI) without shipping desktop-sized originals.
// Override the width per-request with ?w= (clamped). Tune via env if needed.
const DEFAULT_MAX_WIDTH = Number(process.env['IMG_MAX_WIDTH']) || 1080;
const WEBP_QUALITY = Number(process.env['IMG_QUALITY']) || 72;
// Only raster formats sharp can resize cleanly; SVG (vector) and GIF (possibly
// animated) pass through untouched.
const RESIZABLE = /^image\/(jpe?g|png|webp|avif)$/;

/**
 * Read a response body, aborting as soon as it exceeds `max` bytes. A server
 * that lies about (or omits) Content-Length can't make us buffer more than the
 * cap: we stop reading and drop what we have. Throws when the cap is exceeded.
 */
const readCapped = async (res: Response, max: number): Promise<ArrayBuffer> => {
  const body = res.body;
  // No stream available (e.g. a mocked/edge response) — fall back to buffering,
  // still bounded because the Content-Length pre-check ran and the upstream
  // fetch has a timeout.
  if (!body) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > max) throw new Error('too large');
    return buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new Error('too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
};

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url');
  const referer = request.nextUrl.searchParams.get('referer') || undefined;
  if (!url) return NextResponse.json({ error: 'missing url' }, { status: 400 });
  const wParam = Number(request.nextUrl.searchParams.get('w'));
  const maxWidth =
    Number.isFinite(wParam) && wParam >= 64 ? Math.min(wParam, 2000) : DEFAULT_MAX_WIDTH;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return NextResponse.json({ error: 'bad url' }, { status: 400 });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return NextResponse.json({ error: 'bad scheme' }, { status: 400 });
  }
  if (isBlockedHost(target.hostname)) {
    return NextResponse.json({ error: 'blocked host' }, { status: 400 });
  }

  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  };
  // Some CDNs (NYT/WSJ) gate images on a same-origin Referer.
  if (referer) {
    try {
      headers['Referer'] = new URL(referer).origin + '/';
    } catch {
      /* ignore unparseable referer */
    }
  }

  // Follow redirects MANUALLY so every hop is re-checked against the block-list.
  // With `redirect: 'follow'` only the first hostname is ever validated, so a
  // feed-supplied URL could 302 into the private network / cloud metadata.
  let upstream: Response;
  let current = target;
  try {
    for (let hop = 0; ; hop++) {
      upstream = await fetch(current.toString(), {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const location =
        upstream.status >= 300 && upstream.status < 400 ? upstream.headers.get('location') : null;
      if (!location) break;
      if (hop >= MAX_REDIRECTS) {
        return NextResponse.json({ error: 'too many redirects' }, { status: 502 });
      }
      let next: URL;
      try {
        next = new URL(location, current); // resolve relative Location headers
      } catch {
        return NextResponse.json({ error: 'bad redirect' }, { status: 502 });
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        return NextResponse.json({ error: 'bad redirect scheme' }, { status: 400 });
      }
      if (isBlockedHost(next.hostname)) {
        return NextResponse.json({ error: 'blocked host' }, { status: 400 });
      }
      current = next;
    }
  } catch (e) {
    return NextResponse.json({ error: `fetch failed: ${String(e)}` }, { status: 502 });
  }
  if (!upstream.ok) {
    return NextResponse.json({ error: `upstream ${upstream.status}` }, { status: 502 });
  }
  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('image/')) {
    return NextResponse.json({ error: 'not an image' }, { status: 415 });
  }
  // Reject on the declared size BEFORE downloading, then enforce the cap while
  // streaming — `arrayBuffer()` alone would buffer a hostile multi-hundred-MB
  // body into a container that shares 3.7 GB with eleven others.
  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return NextResponse.json({ error: 'too large' }, { status: 502 });
  }
  let buf: ArrayBuffer;
  try {
    buf = await readCapped(upstream, MAX_BYTES);
  } catch {
    return NextResponse.json({ error: 'too large' }, { status: 502 });
  }
  if (buf.byteLength === 0) {
    return NextResponse.json({ error: 'bad size' }, { status: 502 });
  }

  // Downscale + re-encode raster images to WebP so the client gets a small,
  // phone-appropriate file. SVG/GIF pass through; any sharp failure falls back
  // to the original bytes so a quirky image never breaks the article.
  if (RESIZABLE.test(contentType)) {
    try {
      const out = await sharp(Buffer.from(buf), { failOn: 'none' })
        .rotate() // honor EXIF orientation before stripping metadata
        .resize({ width: maxWidth, withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      return new NextResponse(new Uint8Array(out), {
        status: 200,
        headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=86400' },
      });
    } catch {
      /* fall through to returning the original bytes */
    }
  }

  return new NextResponse(buf, {
    status: 200,
    headers: { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=86400' },
  });
}

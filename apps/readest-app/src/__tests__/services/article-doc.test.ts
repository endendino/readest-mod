import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * FORK: feed articles are staged as EPUBs so the normal reader (and the RSVP
 * overlay) can open them. `articleDoc` builds that document, and everything in
 * it comes from the feed — i.e. from content the fork does not control. Two
 * things therefore matter: the masthead must escape what it interpolates, and
 * the read-time/byline it renders must be the fork's own rather than whatever
 * widget the publisher injected.
 */

// Mock signatures are spelled out so `mock.calls[n][i]` stays type-checked —
// these assertions are about WHICH arguments reach the conversion pipeline.
type BundleArgs = [html: string, base: string, opts: unknown];
type BookArgs = [
  html: string,
  title: string,
  author: string,
  id: string,
  images: unknown,
  cover?: string,
];

const bundleAssets = vi.fn(async (html: string, ..._rest: [string, unknown]) => ({
  html,
  images: [],
}));
const htmlToBook = vi.fn(async (..._args: BookArgs) => ({ file: new File(['x'], 'a.epub') }));
const generateCoverSvg = vi.fn((_arg: { favicon?: { mime: string } }) => '<svg/>');

vi.mock('@/services/send/conversion/assetBundler', () => ({
  bundleAssets: (...args: BundleArgs) => bundleAssets(...args),
}));
vi.mock('@/services/send/conversion/convertToEpub', () => ({
  htmlToBook: (...args: BookArgs) => htmlToBook(...args),
}));
// The fixtures' bodies are teaser-sized, which would send them down the
// full-text path; that path has its own suite (article-full-text.test.ts).
vi.mock('@/services/rss/feedGuardedFetch', () => ({
  guardedFetchText: async () => {
    throw new Error('no page fetch in masthead tests');
  },
}));
vi.mock('@/services/send/conversion/coverGenerator', () => ({
  generateCoverSvg: (arg: unknown) => generateCoverSvg(arg as never),
}));

import { articleToFile } from '@/services/freshrss/articleDoc';
import type { FreshRSSArticle } from '@/types/freshrss';

const article = (over: Partial<FreshRSSArticle> = {}): FreshRSSArticle =>
  ({
    id: 'a1',
    title: 'Council approves the budget',
    contentHtml: '<p>Body text.</p>',
    summaryHtml: '',
    url: 'https://news.example.com/budget',
    publishedAt: Date.parse('2026-03-04T10:00:00Z'),
    feedId: 'feed/1',
    feedTitle: 'Example News',
    author: 'A. Reporter',
    categories: [],
    ...over,
  }) as unknown as FreshRSSArticle;

/** The document body handed to the asset bundler — masthead + article HTML. */
const buildDoc = async (over: Partial<FreshRSSArticle> = {}) => {
  await articleToFile(article(over));
  return String(bundleAssets.mock.calls.at(-1)![0]);
};

beforeEach(() => {
  vi.clearAllMocks();
  bundleAssets.mockImplementation(async (html: string) => ({ html, images: [] }));
  htmlToBook.mockImplementation(async () => ({ file: new File(['x'], 'a.epub') }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 404 })),
  );
});

describe('articleDoc — masthead', () => {
  test('renders source, headline and byline in that order', async () => {
    const doc = await buildDoc();
    const source = doc.indexOf('rss-source');
    const title = doc.indexOf('<h1>');
    const byline = doc.indexOf('rss-byline');
    expect(source).toBeGreaterThanOrEqual(0);
    expect(source).toBeLessThan(title);
    expect(title).toBeLessThan(byline);
    expect(doc).toContain('<hr />');
  });

  test('the source row links to the original article', async () => {
    const doc = await buildDoc();
    expect(doc).toContain('<a href="https://news.example.com/budget">');
    expect(doc).toContain('<strong>Example News</strong>');
  });

  test('drops the link when the article has no url', async () => {
    const doc = await buildDoc({ url: '' });
    expect(doc).toContain('<strong>Example News</strong>');
    expect(doc).not.toContain('<a href');
  });

  test('includes the favicon as a bundleable img when the feed has one', async () => {
    const doc = await buildDoc({ feedIconUrl: 'https://news.example.com/icon.png' } as never);
    expect(doc).toContain('class="rss-logo"');
    expect(doc).toContain('src="https://news.example.com/icon.png"');
    expect(doc).toContain('alt=""');
  });

  test('omits the source row entirely when there is no logo and no name', async () => {
    const doc = await buildDoc({ feedTitle: '', url: '' });
    expect(doc).not.toContain('rss-source');
  });

  test('falls back to (untitled) rather than an empty headline', async () => {
    const doc = await buildDoc({ title: '' });
    expect(doc).toContain('<h1>(untitled)</h1>');
  });

  test('the byline joins author, date and read time', async () => {
    const doc = await buildDoc();
    const byline = doc.match(/<p class="rss-byline">(.*?)<\/p>/)![1]!;
    expect(byline).toContain('A. Reporter');
    expect(byline).toContain('min read');
    expect(byline.split(' · ')).toHaveLength(3);
  });

  test('omits the byline when there is nothing to put in it', async () => {
    // No author, no date — the read time alone still counts, so drop that too.
    const doc = await buildDoc({ author: '', publishedAt: 0, contentHtml: '<p></p>' });
    const byline = doc.match(/<p class="rss-byline">(.*?)<\/p>/);
    // A read-time is always computed (min 1), so the byline exists but holds only it.
    expect(byline?.[1]).toBe('1 min read');
  });
});

describe('articleDoc — escaping feed-supplied text', () => {
  test('escapes HTML in the title', async () => {
    const doc = await buildDoc({ title: 'Tags <script>alert(1)</script> & "quotes"' });
    expect(doc).toContain('&lt;script&gt;');
    expect(doc).not.toContain('<script>');
    expect(doc).toContain('&amp;');
  });

  test('escapes HTML in the feed name and author', async () => {
    const doc = await buildDoc({ feedTitle: 'A & B <b>', author: '<i>me</i>' });
    expect(doc).toContain('A &amp; B &lt;b&gt;');
    expect(doc).toContain('&lt;i&gt;me&lt;/i&gt;');
  });

  test('escapes the article url so a crafted link cannot break out of href', async () => {
    const doc = await buildDoc({ url: 'https://x.example/a"><script>alert(1)</script>' });
    expect(doc).not.toContain('"><script>');
    expect(doc).toContain('&quot;');
  });

  test('escapes the favicon url too', async () => {
    const doc = await buildDoc({ feedIconUrl: 'https://x/i.png"><b>' } as never);
    expect(doc).not.toContain('.png"><b>');
  });
});

describe('articleDoc — read time', () => {
  const minutesIn = (doc: string) => Number(doc.match(/(\d+) min read/)![1]);

  test('estimates at roughly 200 words per minute', async () => {
    const body = `<p>${'word '.repeat(600)}</p>`;
    expect(minutesIn(await buildDoc({ contentHtml: body }))).toBe(3);
  });

  test('never reports zero minutes for a very short article', async () => {
    expect(minutesIn(await buildDoc({ contentHtml: '<p>Two words.</p>' }))).toBe(1);
  });

  test('counts words, not markup', async () => {
    // Same 400 words, but the second body carries 800 tags around them. If markup
    // leaked into the word count the estimate would triple.
    const plain = `<p>${'word '.repeat(400)}</p>`;
    const marked = `<div>${'<span class="a b c">word</span> '.repeat(400)}</div>`;
    expect(minutesIn(await buildDoc({ contentHtml: plain }))).toBe(2);
    expect(minutesIn(await buildDoc({ contentHtml: marked }))).toBe(2);
  });

  test('labels the read time in Hebrew for a Hebrew article', async () => {
    const doc = await buildDoc({ title: 'התקציב אושר', feedTitle: 'חדשות' });
    expect(doc).toContain('דקות קריאה');
    expect(doc).not.toContain('min read');
  });

  test('a Hebrew feed name alone is enough to switch the label', async () => {
    const doc = await buildDoc({ title: 'Budget approved', feedTitle: 'ynet' });
    expect(doc).toContain('min read');
    const rtl = await buildDoc({ title: 'Budget approved', feedTitle: 'ynet — חדשות' });
    expect(rtl).toContain('דקות קריאה');
  });
});

describe("articleDoc — stripping the publisher's own read-time widget", () => {
  test("removes ynet's stopwatch block so it doesn't duplicate ours", async () => {
    const doc = await buildDoc({
      title: 'התקציב אושר',
      contentHtml: '<p>⏱ 2 דקות קריאה (במהירות: 1)</p><p>גוף הכתבה.</p>',
    });
    expect(doc).not.toContain('במהירות');
    expect(doc).toContain('גוף הכתבה.');
  });

  test('removes an English "min read" stopwatch line', async () => {
    const doc = await buildDoc({ contentHtml: '<div>⏱ 4 min read</div><p>Real body.</p>' });
    expect(doc).not.toContain('4 min read</div>');
    expect(doc).toContain('Real body.');
  });

  test('removes a nested-span stopwatch widget', async () => {
    const doc = await buildDoc({
      contentHtml: '<p><span><b>⏲</b> 3 minutes</span></p><p>Body.</p>',
    });
    expect(doc).not.toContain('3 minutes');
    expect(doc).toContain('Body.');
  });

  test('leaves real prose that merely mentions minutes alone', async () => {
    const body = '<p>The vote took 20 minutes and the reading of the bill followed.</p>';
    const doc = await buildDoc({ contentHtml: body });
    expect(doc).toContain('took 20 minutes');
  });

  test('leaves a stopwatch emoji inside ordinary prose alone', async () => {
    const doc = await buildDoc({ contentHtml: '<p>He set a ⏱ on the desk and waited.</p>' });
    expect(doc).toContain('on the desk and waited');
  });
});

describe('articleDoc — pipeline wiring', () => {
  test('bundles assets through the same-origin proxy, based at the article url', async () => {
    await articleToFile(article());
    const [, base, opts] = bundleAssets.mock.calls.at(-1)!;
    expect(base).toBe('https://news.example.com/budget');
    expect(opts).toMatchObject({ useProxy: true });
  });

  test('falls back to the title as the body when the article has no content', async () => {
    const doc = await buildDoc({ contentHtml: '' });
    // Appears twice: once in the h1, once as the stand-in body.
    expect(doc.match(/Council approves the budget/g)?.length).toBe(2);
  });

  test('builds a cover so foliate cannot promote the lead photo to cover', async () => {
    await articleToFile(article());
    expect(generateCoverSvg).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Council approves the budget', siteName: 'Example News' }),
    );
    expect(htmlToBook.mock.calls.at(-1)![5]).toBe('<svg/>');
  });

  test('falls back to the feed name as author when the article has none', async () => {
    await articleToFile(article({ author: '' }));
    expect(htmlToBook.mock.calls.at(-1)![2]).toBe('Example News');
  });

  test('identifies the book by url, falling back to the article id', async () => {
    await articleToFile(article());
    expect(htmlToBook.mock.calls.at(-1)![3]).toBe('https://news.example.com/budget');
    await articleToFile(article({ url: '' }));
    expect(htmlToBook.mock.calls.at(-1)![3]).toBe('a1');
  });

  test('fetches the favicon via the image proxy, and tolerates failure', async () => {
    const f = vi.fn(async (_url: string) => new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', f);
    await articleToFile(article({ feedIconUrl: 'https://news.example.com/i.png' } as never));
    expect(String(f.mock.calls[0]![0])).toContain('/api/img?url=');
    expect(generateCoverSvg.mock.calls.at(-1)![0]).toMatchObject({ favicon: undefined });
  });

  test('ignores a favicon response that is not actually an image', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html/>', { status: 200, headers: { 'content-type': 'text/html' } }),
      ),
    );
    await articleToFile(article({ feedIconUrl: 'https://news.example.com/i.png' } as never));
    expect(generateCoverSvg.mock.calls.at(-1)![0]).toMatchObject({ favicon: undefined });
  });

  test('passes a real favicon through to the cover', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
      ),
    );
    await articleToFile(article({ feedIconUrl: 'https://news.example.com/i.png' } as never));
    expect(generateCoverSvg.mock.calls.at(-1)![0]).toMatchObject({
      favicon: { mime: 'image/png' },
    });
  });
});

import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * FORK: summary-only feeds hand FreshRSS a teaser as the article body. The feed
 * reader recovers the full article with UPSTREAM's RSS building blocks — its
 * "is the feed's own content enough?" rule (resolveArticleHtml /
 * MIN_FEED_CONTENT), its guarded page fetch and its Readability extraction — so
 * upstream's tuning of any of them reaches the fork unchanged. What the fork
 * owns is the policy around them: when to try, how long to wait, what to cache,
 * and that a failure never costs the reader the teaser it already had.
 */

const guardedFetchText = vi.fn<(url: string) => Promise<string>>();
vi.mock('@/services/rss/feedGuardedFetch', () => ({
  guardedFetchText: (url: string) => guardedFetchText(url),
}));

import { resolveArticleBody, clearFullTextCache } from '@/services/freshrss/articleDoc';
import { MIN_FEED_CONTENT } from '@/services/rss/feedArticleContent';
import type { FreshRSSArticle } from '@/types/freshrss';

const article = (over: Partial<FreshRSSArticle> = {}): FreshRSSArticle =>
  ({
    id: 'a1',
    title: 'Council approves the budget',
    contentHtml: '<p>Teaser only.</p>',
    url: 'https://news.example.com/budget',
    publishedAt: 0,
    feedId: 'feed/1',
    feedTitle: 'Example News',
    categories: [],
    ...over,
  }) as unknown as FreshRSSArticle;

const para = 'The council met on Tuesday and approved the budget after a long debate. ';
const PAGE = `<!doctype html><html><head><title>Council approves the budget</title></head><body>
  <nav>Home | News | Sport</nav>
  <article><h1>Council approves the budget</h1>
  ${`<p>${para.repeat(4)}</p>`.repeat(6)}
  </article><footer>Copyright</footer></body></html>`;

beforeEach(() => {
  guardedFetchText.mockReset();
  clearFullTextCache();
});

describe('resolveArticleBody', () => {
  test('keeps the feed content when upstream deems it enough — no page fetch', async () => {
    const full = `<p>${'x'.repeat(MIN_FEED_CONTENT)}</p>`;
    expect(await resolveArticleBody(article({ contentHtml: full }))).toBe(full);
    expect(guardedFetchText).not.toHaveBeenCalled();
  });

  test('fetches and extracts the full article for a teaser-only feed', async () => {
    guardedFetchText.mockResolvedValue(PAGE);
    const body = await resolveArticleBody(article());
    expect(guardedFetchText).toHaveBeenCalledWith('https://news.example.com/budget');
    expect(body).toContain('approved the budget after a long debate');
    expect(body).not.toContain('Home | News | Sport');
  });

  test('drops the extracted <h1> — the masthead already shows the headline', async () => {
    guardedFetchText.mockResolvedValue(PAGE);
    const body = await resolveArticleBody(article());
    expect(body).not.toMatch(/<h1/i);
  });

  test('falls back to the teaser when the page fetch fails', async () => {
    guardedFetchText.mockRejectedValue(new Error('Fetch failed: 403'));
    expect(await resolveArticleBody(article())).toBe('<p>Teaser only.</p>');
  });

  test('falls back to the teaser when the page has no readable article', async () => {
    guardedFetchText.mockResolvedValue('<html><body></body></html>');
    expect(await resolveArticleBody(article())).toBe('<p>Teaser only.</p>');
  });

  test('falls back to the teaser when the page is slower than the deadline', async () => {
    vi.useFakeTimers();
    try {
      guardedFetchText.mockReturnValue(new Promise(() => {}));
      const pending = resolveArticleBody(article());
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await pending).toBe('<p>Teaser only.</p>');
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not fetch when the article has no URL', async () => {
    expect(await resolveArticleBody(article({ url: '' }))).toBe('<p>Teaser only.</p>');
    expect(guardedFetchText).not.toHaveBeenCalled();
  });

  test('fetches a page once per article (open + summary share it)', async () => {
    guardedFetchText.mockResolvedValue(PAGE);
    const [a, b] = await Promise.all([
      resolveArticleBody(article()),
      resolveArticleBody(article()),
    ]);
    expect(a).toBe(b);
    expect(guardedFetchText).toHaveBeenCalledTimes(1);
  });

  test('a failed fetch is not cached — the next open retries', async () => {
    guardedFetchText.mockRejectedValueOnce(new Error('offline'));
    await resolveArticleBody(article());
    guardedFetchText.mockResolvedValue(PAGE);
    expect(await resolveArticleBody(article())).toContain('long debate');
    expect(guardedFetchText).toHaveBeenCalledTimes(2);
  });
});

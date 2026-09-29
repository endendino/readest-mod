import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const markRead = vi.fn().mockResolvedValue(undefined);
const markUnread = vi.fn().mockResolvedValue(undefined);
vi.mock('@/services/freshrss/greaderClient', () => ({
  FreshRSSClient: class {
    markRead = markRead;
    markUnread = markUnread;
  },
}));

const openFeedArticle = vi.fn().mockResolvedValue(true);
vi.mock('@/app/feeds/useOpenFeedArticle', () => ({
  useOpenFeedArticle: () => openFeedArticle,
}));

import { ArticleList } from '@/app/feeds/components/ArticleList';
import { useFeedsStore } from '@/store/feedsStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { FreshRSSArticle } from '@/types/freshrss';
import type { SystemSettings } from '@/types/settings';

const article = (id: string, title: string, blurb = '', publishedAt = 0): FreshRSSArticle =>
  ({
    id,
    title,
    contentHtml: `<p>${blurb || title}</p>`,
    summaryHtml: `<p>${blurb || title}</p>`,
    url: `https://example.com/${id}`,
    publishedAt,
    feedId: 'feed/a',
    feedTitle: 'Feed A',
    author: 'Author',
    categories: [],
  }) as unknown as FreshRSSArticle;

const ARTICLES = [
  article('a1', 'Budget approved by council', 'local government spending', 300),
  article('a2', 'שלום עולם כאן', 'כתבה בעברית', 200),
  article('a3', 'Tick that hunts hosts', 'parasite biology', 100),
];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useSettingsStore.setState({
    settings: { freshrss: { enabled: true } } as unknown as SystemSettings,
  });
  useFeedsStore.setState({
    folders: [],
    feeds: [{ id: 'feed/a', title: 'Feed A', folderId: null, unreadCount: 3 }] as never,
    articles: [...ARTICLES],
    currentStreamId: 'feed/a',
    currentTitle: 'Feed A',
    continuation: undefined,
    loading: false,
    error: undefined,
    openArticles: {},
    openArticlesHydrated: true,
    summaries: {},
    pendingUndo: null,
  });
});
afterEach(() => cleanup());

describe('ArticleList — rendering', () => {
  test('renders every queued article', () => {
    render(<ArticleList />);
    expect(screen.getByText('Budget approved by council')).toBeTruthy();
    expect(screen.getByText('שלום עולם כאן')).toBeTruthy();
    expect(screen.getByText('Tick that hunts hosts')).toBeTruthy();
  });

  test('keeps the constrained reading measure and type scale', () => {
    const { container } = render(<ArticleList />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('max-w-[600px]');
    expect(root.className).toContain('text-[16px]');
    expect(root.className).toContain('leading-[1.5]');
  });
});

describe('ArticleList — byline direction', () => {
  // A Hebrew row's byline mixes Hebrew (author, feed) with Latin segments
  // ("Hebrew" label, "201 words") and digits. Joined into one string, the
  // bidi algorithm merged neighbouring Latin runs and reordered the line.
  // Each segment is its own isolate, with the separators between them.
  test('renders each byline segment as a bidi isolate', () => {
    useFeedsStore.setState({
      articles: [
        {
          ...article('h1', 'מתנחלים פשטו על הכפר', 'כתבה'),
          author: 'מערכת "זו הדרך"',
          categories: ['Hebrew'],
        } as FreshRSSArticle,
      ],
    });
    const { container } = render(<ArticleList />);
    const segments = Array.from(container.querySelectorAll('bdi')).map((b) => b.textContent);
    expect(segments).toContain('מערכת "זו הדרך"');
    expect(segments).toContain('Hebrew');
    expect(segments.some((t) => /words/.test(t ?? ''))).toBe(true);
  });
});

describe('ArticleList — search (C2)', () => {
  test('/ opens the filter and narrows the queue', () => {
    render(<ArticleList />);
    fireEvent.keyDown(document, { key: '/' });
    const field = screen.getByLabelText('Filter articles') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'tick' } });
    expect(screen.getByText('Tick that hunts hosts')).toBeTruthy();
    expect(screen.queryByText('Budget approved by council')).toBeNull();
  });

  test('matches the blurb and the author too, not just the title', () => {
    render(<ArticleList />);
    fireEvent.keyDown(document, { key: '/' });
    const field = screen.getByLabelText('Filter articles') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'parasite' } });
    expect(screen.getByText('Tick that hunts hosts')).toBeTruthy();
    expect(screen.queryByText('שלום עולם כאן')).toBeNull();
  });

  test('filters Hebrew titles (RTL content is searchable)', () => {
    render(<ArticleList />);
    fireEvent.keyDown(document, { key: '/' });
    fireEvent.change(screen.getByLabelText('Filter articles'), { target: { value: 'עולם' } });
    expect(screen.getByText('שלום עולם כאן')).toBeTruthy();
    expect(screen.queryByText('Tick that hunts hosts')).toBeNull();
  });

  test('a query with no matches says so instead of looking empty', () => {
    render(<ArticleList />);
    fireEvent.keyDown(document, { key: '/' });
    fireEvent.change(screen.getByLabelText('Filter articles'), { target: { value: 'zzzz' } });
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  test('Escape clears the filter', () => {
    render(<ArticleList />);
    fireEvent.keyDown(document, { key: '/' });
    fireEvent.change(screen.getByLabelText('Filter articles'), { target: { value: 'tick' } });
    expect(screen.queryByText('Budget approved by council')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByText('Budget approved by council')).toBeTruthy();
  });
});

describe('ArticleList — keyboard flow (C1)', () => {
  test('j/k move the selection and o opens it', () => {
    render(<ArticleList />);
    fireEvent.keyDown(document, { key: 'j' }); // select first
    fireEvent.keyDown(document, { key: 'j' }); // second
    fireEvent.keyDown(document, { key: 'o' });
    expect(openFeedArticle).toHaveBeenCalledTimes(1);
    expect(openFeedArticle.mock.calls[0]![0].id).toBe('a2');
  });

  test('n reads the NEXT article after the selection', () => {
    render(<ArticleList />);
    fireEvent.keyDown(document, { key: 'j' }); // a1 selected
    fireEvent.keyDown(document, { key: 'n' });
    expect(openFeedArticle.mock.calls[0]![0].id).toBe('a2');
  });

  test('n with nothing selected starts at the top of the queue', () => {
    render(<ArticleList />);
    fireEvent.keyDown(document, { key: 'n' });
    expect(openFeedArticle).toHaveBeenCalledTimes(1);
    expect(openFeedArticle.mock.calls[0]![0].id).toBe('a1');
  });

  test('d marks the selected article read and drops it from the queue', () => {
    render(<ArticleList />);
    fireEvent.keyDown(document, { key: 'j' });
    fireEvent.keyDown(document, { key: 'd' });
    expect(markRead).toHaveBeenCalledWith('a1');
    expect(useFeedsStore.getState().articles.map((a) => a.id)).toEqual(['a2', 'a3']);
  });

  test('keys do not fire while the filter field has focus', () => {
    render(<ArticleList />);
    fireEvent.keyDown(document, { key: '/' });
    const field = screen.getByLabelText('Filter articles');
    fireEvent.keyDown(field, { key: 'd' });
    fireEvent.keyDown(field, { key: 'n' });
    expect(markRead).not.toHaveBeenCalled();
    expect(openFeedArticle).not.toHaveBeenCalled();
  });
});

describe('ArticleList — dismiss undo (C4)', () => {
  test('dismissing drops the article and offers it back via the store', () => {
    render(<ArticleList />);
    fireEvent.keyDown(document, { key: 'j' });
    fireEvent.keyDown(document, { key: 'd' });
    expect(useFeedsStore.getState().articles.map((a) => a.id)).toEqual(['a2', 'a3']);
    // The undo control itself lives in the page header now, not in the list.
    expect(useFeedsStore.getState().pendingUndo?.id).toBe('a1');
  });

  test('the list renders NO inline undo bar — it would push the queue down', () => {
    render(<ArticleList />);
    fireEvent.keyDown(document, { key: 'j' });
    fireEvent.keyDown(document, { key: 'd' });
    expect(screen.queryByText('Undo')).toBeNull();
    expect(screen.queryByText(/Marked read:/)).toBeNull();
  });

  test('dismissing still marks the article read server-side', async () => {
    render(<ArticleList />);
    fireEvent.keyDown(document, { key: 'j' });
    fireEvent.keyDown(document, { key: 'd' });
    await vi.waitFor(() => expect(markRead).toHaveBeenCalledWith('a1'));
  });
});

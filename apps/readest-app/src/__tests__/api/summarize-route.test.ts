import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/summarize/route';

/**
 * FORK: the article summarizer. The behaviour under test is the length-aware
 * banding — the original route truncated input at 6,000 chars and always asked
 * for "1–2 sentences", so a long feature was summarized from its opening ~12%
 * and got the same two lines as a 200-word brief. The shape must be chosen from
 * the article's REAL word count, and must reach the model in the prompt.
 */

const fetchMock = vi.fn();

const post = (payload: unknown, raw?: string) =>
  POST(
    new NextRequest('http://localhost:3000/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw ?? JSON.stringify(payload),
    }),
  );

const completion = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** The request body the route sent upstream. */
const sent = () => JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
const prompts = () => {
  const body = sent();
  return {
    system: body.messages[0].content as string,
    user: body.messages[1].content as string,
    maxTokens: body.max_tokens as number,
  };
};

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(completion('A summary.'));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('SUMMARY_API_KEY', 'test-key');
  vi.stubEnv('SUMMARY_MODEL', 'test-model');
  vi.stubEnv('SUMMARY_BASE_URL', 'https://api.example.com/v1');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('/api/summarize — request gate', () => {
  test('reports 501 when no API key is configured', async () => {
    vi.stubEnv('SUMMARY_API_KEY', '');
    const r = await post({ text: 'hello' });
    expect(r.status).toBe(501);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects a malformed body', async () => {
    const r = await post(null, '{nope');
    expect(r.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([{}, { text: '' }, { text: '   \n  ' }])('rejects empty text (%j)', async (payload) => {
    const r = await post(payload);
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: 'missing text' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('keeps the key server-side, in the Authorization header only', async () => {
    await post({ text: words(100) });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key');
    expect(String(init.body)).not.toContain('test-key');
  });

  test('targets the configured provider and model', async () => {
    await post({ text: words(100) });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://api.example.com/v1/chat/completions');
    expect(sent().model).toBe('test-model');
  });

  test('trims a trailing slash off the base url', async () => {
    vi.stubEnv('SUMMARY_BASE_URL', 'https://api.example.com/v1///');
    await post({ text: words(100) });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://api.example.com/v1/chat/completions');
  });
});

describe('/api/summarize — length banding (B2)', () => {
  test('a short brief asks for 1–2 sentences of prose', async () => {
    const r = await post({ text: words(200) });
    const { system, maxTokens } = prompts();
    expect(system).toContain('1–2 sentences');
    expect(maxTokens).toBe(220);
    expect(await r.json()).toMatchObject({ format: 'prose', words: 200 });
  });

  test('a mid-length article asks for 3–4 sentences', async () => {
    const r = await post({ text: words(1200) });
    const { system, maxTokens } = prompts();
    expect(system).toContain('3–4 sentences');
    expect(maxTokens).toBe(400);
    expect(await r.json()).toMatchObject({ format: 'prose', words: 1200 });
  });

  test('a long article switches to a bulleted digest', async () => {
    const r = await post({ text: words(3000) });
    const { system, maxTokens } = prompts();
    expect(system).toContain('4–6 short bullet points');
    expect(maxTokens).toBe(700);
    expect(await r.json()).toMatchObject({ format: 'bullets', words: 3000 });
  });

  test('a feature-length piece asks for a sectioned digest', async () => {
    const r = await post({ text: words(8000) });
    const { system, maxTokens } = prompts();
    expect(system).toContain('6–9 short bullet points');
    expect(system).toContain('distinct sections');
    expect(maxTokens).toBe(1100);
    expect(await r.json()).toMatchObject({ format: 'bullets', words: 8000 });
  });

  test('the ask GROWS with length but sub-linearly (8000w is not 40x a 200w ask)', async () => {
    const budgets: number[] = [];
    for (const n of [200, 1200, 3000, 8000]) {
      fetchMock.mockClear();
      await post({ text: words(n) });
      budgets.push(prompts().maxTokens);
    }
    // Strictly increasing...
    expect(budgets).toEqual([...budgets].sort((a, b) => a - b));
    expect(new Set(budgets).size).toBe(4);
    // ...but a 40x longer article gets nowhere near a 40x longer summary.
    expect(budgets[3]! / budgets[0]!).toBeLessThan(10);
  });

  test('tells the model the real word count and demands whole-article coverage', async () => {
    await post({ text: words(4321) });
    const { system } = prompts();
    expect(system).toContain('about 4321 words long');
    expect(system).toContain('not just its opening');
  });

  test('asks for bullet lines when the band is bulleted, prose otherwise', async () => {
    await post({ text: words(3000) });
    expect(prompts().system).toContain('bullet lines');
    fetchMock.mockClear();
    await post({ text: words(100) });
    expect(prompts().system).toContain('ONLY the summary text');
  });
});

describe('/api/summarize — input budget (B1)', () => {
  test('sends a normal article in full — no truncation marker', async () => {
    const text = words(5000); // well under the 200k-char budget
    await post({ text });
    expect(prompts().user).toContain(text);
    expect(prompts().user).not.toContain('[…]');
  });

  test('an article past the budget keeps its ENDING, not just its opening', async () => {
    const head = 'START-MARKER';
    const tail = 'END-MARKER';
    const filler = 'x'.repeat(250_000);
    await post({ text: `${head} ${filler} ${tail}` });
    const { user } = prompts();
    expect(user).toContain(head);
    expect(user).toContain(tail); // the old head-only cut lost this entirely
    expect(user).toContain('[…]');
  });

  test('a trimmed article is still BANDED on its full length', async () => {
    // 60,000 words -> top band, even though the body had to be trimmed to fit.
    await post({ text: words(60_000) });
    const { system, maxTokens, user } = prompts();
    expect(system).toContain('6–9 short bullet points');
    expect(maxTokens).toBe(1100);
    expect(user).toContain('[…]');
  });
});

describe('/api/summarize — blurb complementarity', () => {
  test('with a blurb, the model is told to complement rather than restate it', async () => {
    await post({ text: words(300), blurb: 'Council votes on the budget.' });
    const { system, user } = prompts();
    expect(system).toContain('ALREADY read the blurb');
    expect(user).toContain('Council votes on the budget.');
  });

  test('NONE becomes a redundant flag, not a summary reading "NONE"', async () => {
    fetchMock.mockResolvedValue(completion('NONE'));
    const r = await post({ text: words(300), blurb: 'Everything, already.' });
    expect(await r.json()).toEqual({ summary: '', redundant: true });
  });

  test.each(['NONE', 'none', 'None.', 'none!', ' NONE '])('treats %j as redundant', async (c) => {
    fetchMock.mockResolvedValue(completion(c));
    const r = await post({ text: words(300), blurb: 'b' });
    expect(await r.json()).toMatchObject({ redundant: true });
  });

  test('a summary that merely MENTIONS none is not swallowed', async () => {
    fetchMock.mockResolvedValue(completion('None of the amendments passed.'));
    const r = await post({ text: words(300), blurb: 'b' });
    const data = await r.json();
    expect(data.redundant).toBeUndefined();
    expect(data.summary).toBe('None of the amendments passed.');
  });

  test('without a blurb there is nothing to be redundant WITH, so NONE passes through', async () => {
    fetchMock.mockResolvedValue(completion('NONE'));
    const r = await post({ text: words(300) });
    const data = await r.json();
    expect(data.summary).toBe('NONE');
    expect(data).not.toHaveProperty('redundant');
  });

  test('an over-long blurb is capped before it reaches the prompt', async () => {
    await post({ text: words(300), blurb: 'b'.repeat(5000) });
    expect(prompts().user).not.toContain('b'.repeat(1501));
  });
});

describe('/api/summarize — upstream failures', () => {
  test('a provider error becomes a 502 carrying a bounded detail', async () => {
    fetchMock.mockResolvedValue(new Response('quota exceeded '.repeat(200), { status: 429 }));
    const r = await post({ text: words(100) });
    expect(r.status).toBe(502);
    const data = await r.json();
    expect(data.error).toContain('429');
    expect(data.detail.length).toBeLessThanOrEqual(300);
  });

  test('an empty completion becomes a 502 rather than a blank summary box', async () => {
    fetchMock.mockResolvedValue(completion('   '));
    const r = await post({ text: words(100) });
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ error: 'empty summary' });
  });

  test('an unparseable completion becomes a 502', async () => {
    fetchMock.mockResolvedValue(
      new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const r = await post({ text: words(100) });
    expect(r.status).toBe(502);
  });

  test('a network error becomes a 502', async () => {
    fetchMock.mockRejectedValue(new Error('ETIMEDOUT'));
    const r = await post({ text: words(100) });
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ error: expect.stringContaining('upstream fetch') });
  });

  test('the summary is returned trimmed', async () => {
    fetchMock.mockResolvedValue(completion('  A tidy summary.\n\n'));
    const r = await post({ text: words(100) });
    expect(await r.json()).toMatchObject({ summary: 'A tidy summary.' });
  });
});

/**
 * FORK: thinking-model support. Gemini 3.x flash (and peers) enable reasoning by
 * default and bill thinking tokens as OUTPUT — and, critically, count them
 * against `max_tokens`, which is a COMBINED budget rather than an answer budget.
 * With the bare answer caps above, a medium thinking pass eats the whole budget
 * and the completion comes back empty. The route must therefore (a) leave the
 * caps alone for non-thinking models, (b) add headroom when reasoning is on, and
 * (c) say so when a response is truncated instead of reporting "empty summary".
 */
describe('/api/summarize — thinking models', () => {
  test('sends no reasoning_effort by default, so flash-lite is untouched', async () => {
    await post({ text: words(100) });
    expect(sent()).not.toHaveProperty('reasoning_effort');
    expect(prompts().maxTokens).toBe(220);
  });

  test('forwards the configured reasoning effort', async () => {
    vi.stubEnv('SUMMARY_REASONING_EFFORT', 'low');
    await post({ text: words(100) });
    expect(sent().reasoning_effort).toBe('low');
  });

  test('adds thinking headroom to every band so the answer survives the reasoning pass', async () => {
    vi.stubEnv('SUMMARY_REASONING_EFFORT', 'low');
    for (const [n, bare] of [
      [200, 220],
      [1200, 400],
      [3000, 700],
      [8000, 1100],
    ] as const) {
      fetchMock.mockClear();
      await post({ text: words(n) });
      expect(prompts().maxTokens).toBe(bare + 1000);
    }
  });

  test('the headroom is tunable for higher reasoning efforts', async () => {
    vi.stubEnv('SUMMARY_REASONING_EFFORT', 'high');
    vi.stubEnv('SUMMARY_THINKING_HEADROOM', '4000');
    await post({ text: words(200) });
    expect(prompts().maxTokens).toBe(220 + 4000);
  });

  test('headroom is not added when reasoning is off, whatever the headroom says', async () => {
    vi.stubEnv('SUMMARY_THINKING_HEADROOM', '4000');
    await post({ text: words(200) });
    expect(prompts().maxTokens).toBe(220);
  });

  test('a budget-truncated completion names the cap instead of "empty summary"', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await post({ text: words(100) });
    expect(r.status).toBe(502);
    const data = await r.json();
    expect(data.error).toContain('truncated');
    // The operator needs the number to know what to raise.
    expect(String(data.error)).toContain('220');
  });

  test('a truncated but non-empty summary is still returned', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Half a summ' }, finish_reason: 'length' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await post({ text: words(100) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ summary: 'Half a summ' });
  });
});

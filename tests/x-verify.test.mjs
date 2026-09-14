import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postIdFrom, verifyPost } from '../tools/x-verify.mjs';

test('post ids come out of x.com URLs, twitter.com URLs and bare ids', () => {
  assert.equal(postIdFrom('https://x.com/realDonaldTrump/status/2082159711852298494'), '2082159711852298494');
  assert.equal(postIdFrom('https://twitter.com/realDonaldTrump/status/2082159711852298494?s=20'), '2082159711852298494');
  assert.equal(postIdFrom('https://x.com/realDonaldTrump/statuses/2082159711852298494'), '2082159711852298494');
  assert.equal(postIdFrom('2082159711852298494'), '2082159711852298494');
  assert.equal(postIdFrom(' 2082159711852298494 '), '2082159711852298494');
});

test('junk is rejected rather than guessed at', () => {
  assert.equal(postIdFrom('https://x.com/realDonaldTrump'), null);
  assert.equal(postIdFrom('2082159711852298494abc'), null);
  assert.equal(postIdFrom('123'), null);
  assert.equal(postIdFrom(''), null);
  assert.equal(postIdFrom(null), null);
});

test('verifyPost refuses anything that is not a post reference', async () => {
  await assert.rejects(() => verifyPost('https://example.com/hello'), /not a post id/);
});

test('a paraphrase can never be the source: verifyPost returns the mirror text, not a caller-supplied one', async () => {
  // Guards the contract the ingest pipeline relies on. Live fetch is skipped when the
  // mirror is unreachable (offline CI), because the point here is the shape, not the network.
  const original = globalThis.fetch;
  let calledUrl = null;
  globalThis.fetch = async (url) => {
    calledUrl = String(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        code: 200,
        tweet: {
          id: '2082159711852298494',
          text: 'Verbatin text from the mirror.',
          url: 'https://x.com/realDonaldTrump/status/2082159711852298494',
          created_at: '2026-07-28T17:42:14.000Z',
          author: { screen_name: 'realDonaldTrump', name: 'Donald J. Trump' },
        },
      }),
    };
  };
  try {
    const post = await verifyPost('https://x.com/realDonaldTrump/status/2082159711852298494');
    assert.equal(post.text, 'Verbatin text from the mirror.');
    assert.equal(post.createdAt, '2026-07-28');
    assert.match(post.verifiedBy, /fxtwitter|mirror/i);
    assert.match(calledUrl, /status\/2082159711852298494$/);
  } finally {
    globalThis.fetch = original;
  }
});
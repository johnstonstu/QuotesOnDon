import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postIdFrom, verifyPost, extractPostRefs } from '../tools/x-verify.mjs';

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
test('a blob of paste — a Grok answer, a forwarded message, OCR text — yields its post refs', () => {
  const blob = `Sure, here are the recent posts:
   1. https://x.com/realDonaldTrump/status/2082159711852298494 — about the White House
   2. twitter.com/realDonaldTrump/status/2028505632123326484
   3. bare id 2057968277062582378
   also x.com/i/status/2100000000000000000 and a number that is not a post: 12345.`;
  const refs = extractPostRefs(blob);
  assert.deepEqual(
    refs.map((r) => r.id),
    ['2082159711852298494', '2028505632123326484', '2057968277062582378', '2100000000000000000'],
  );
  assert.equal(refs[0].user, 'realDonaldTrump');
  assert.equal(refs[3].user, null, 'an /i/ link has no username to trust');
  assert.equal(refs[0].url, 'https://x.com/realDonaldTrump/status/2082159711852298494');
});

test('the same post pasted twice is queued once', () => {
  const refs = extractPostRefs('https://x.com/realDonaldTrump/status/2082159711852298494 and again 2082159711852298494');
  assert.equal(refs.length, 1);
});

test('prose with no post reference yields nothing rather than a guess', () => {
  assert.deepEqual(extractPostRefs('He said a lot of things today, all very interesting.'), []);
  assert.deepEqual(extractPostRefs(''), []);
  assert.deepEqual(extractPostRefs(undefined), []);
});

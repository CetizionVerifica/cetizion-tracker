import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitQuoted, trimQuotedPreview } from '../src/lib/mailbox/quotes.js';
import { cleanHtml, snippet } from '../src/lib/mailbox/rules.js';

/**
 * Telling a reply's new writing from the email it quotes (#30).
 *
 * The preview used to be two lines of answer followed by our own previous
 * message read back to us, which is the one thing the reader already
 * knows. None of these needs a database.
 */

const gmail = '<div dir="ltr">Yes, the 14th works for us.</div>'
  + '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, 22 Sep 2026 at 09:12, R. Iyer &lt;r.iyer@tatasteel.com&gt; wrote:</div>'
  + '<blockquote class="gmail_quote" type="cite">Could you confirm the audit window for Jamshedpur?</blockquote></div>';

const outlook = '<div>Approved, please proceed.</div>'
  + '<div id="appendonsend"></div><div id="divRplyFwdMsg">'
  + '<b>From:</b> R. Iyer<br><b>Sent:</b> Monday 22 September 2026 09:12<br>The original request.</div>';

test('the markers a mail client leaves survive sanitising', () => {
  const stored = cleanHtml(gmail);
  assert.match(stored, /class="[^"]*gmail_quote/, 'without this there is no boundary to find');
  assert.match(stored, /type="cite"/);
});

test('and so does every other class, because a <style> block needs them', () => {
  // This used to assert the opposite: classes other than the quote markers
  // were dropped, on the reasoning that anything else was a styling hook.
  // It is a styling hook, and that is now the point — a message's own
  // <style> block reaches nothing without them, so a designed email
  // arrived as bare paragraphs. What makes it safe is not this list: the
  // body is rendered in an iframe under default-src 'none' (mailFrame.js),
  // which is where CSS is stopped from reaching the network.
  const stored = cleanHtml('<div class="promo-banner">Buy now</div>');
  assert.match(stored, /class="promo-banner"/);
});

test('the styling a sender wrote survives, and the things that run do not', () => {
  const stored = cleanHtml(
    '<style>.btn{background:#0a7}</style>'
    + '<table width="640" bgcolor="#ffffff" cellpadding="12"><tr><td align="center">'
    + '<a href="https://x.test" class="btn" style="padding:10px 18px">Open</a>'
    + '</td></tr></table>'
    + '<script>alert(1)</script><img src=x onerror=alert(1)><iframe src="https://evil.test"></iframe>'
  );
  // The design.
  assert.match(stored, /<style>/, 'the message\'s own stylesheet');
  assert.match(stored, /style="padding:10px 18px"/, 'and its inline styling');
  assert.match(stored, /width="640"/, 'email layout is built from these attributes');
  assert.match(stored, /bgcolor="#ffffff"/);
  // And nothing that executes, navigates or posts.
  assert.doesNotMatch(stored, /<script/);
  assert.doesNotMatch(stored, /onerror/);
  assert.doesNotMatch(stored, /<iframe/);
});

test('a marked reply splits into what it says and what it quotes', () => {
  const { main, quoted, hasQuoted } = splitQuoted(cleanHtml(gmail));
  assert.equal(hasQuoted, true);
  assert.match(main, /Yes, the 14th works for us/);
  assert.doesNotMatch(main, /audit window/, 'the quoted question is not part of the answer');
  assert.match(quoted, /audit window/);
});

test("Outlook's id markers work the same way", () => {
  const { main, hasQuoted } = splitQuoted(cleanHtml(outlook));
  assert.equal(hasQuoted, true);
  assert.match(main, /Approved, please proceed/);
  assert.doesNotMatch(main, /The original request/);
});

/**
 * Everything synced before the markers were kept has none of them, and
 * that is all of the existing mail. The attribution line is what gives the
 * backlog a usable preview without re-syncing it.
 */
test('mail stored before the markers were kept still splits, on the attribution line', () => {
  const legacy = '<div>Yes, the 14th works for us.</div><div>On Mon, 22 Sep 2026 at 09:12, R. Iyer wrote:</div>'
    + '<blockquote>Could you confirm the audit window?</blockquote>';
  const { main, hasQuoted } = splitQuoted(legacy);
  assert.equal(hasQuoted, true);
  assert.match(main, /Yes, the 14th works for us/);
  assert.doesNotMatch(main, /audit window/);
});

test('Outlook’s separator and its localised forms count too', () => {
  for (const line of [
    '-----Original Message-----',
    'El 22 sept 2026, a las 09:12, R. Iyer escribió:',
    'Am 22.09.2026 um 09:12 schrieb R. Iyer:',
  ]) {
    const { hasQuoted } = splitQuoted(`<div>Fine by us.</div><div>${line}</div><blockquote>Older.</blockquote>`);
    assert.equal(hasQuoted, true, line);
  }
});

test('ordinary prose that happens to say "wrote" is left alone', () => {
  const plain = '<p>I wrote: please send the revised terms by Friday so we can review them.</p>';
  const { hasQuoted, main } = splitQuoted(plain);
  assert.equal(hasQuoted, false, 'cutting here would hide the actual message');
  assert.equal(main, plain);
});

test('a first message has nothing to split and is returned untouched', () => {
  const first = '<p>We would like a quotation for ISO 45001.</p>';
  assert.deepEqual(splitQuoted(first), { main: first, quoted: '', hasQuoted: false });
});

test('an empty body does not throw', () => {
  for (const empty of [null, undefined, '']) {
    assert.deepEqual(splitQuoted(empty), { main: '', quoted: '', hasQuoted: false });
  }
});

test('the preview is the reply, not the thread it is replying to', () => {
  assert.equal(snippet(cleanHtml(gmail)), 'Yes, the 14th works for us.');
  assert.equal(snippet(cleanHtml(outlook)), 'Approved, please proceed.');
});

/**
 * The generator runs at ingest and its result is a column, so fixing it
 * fixes nothing already synced — which, the day this ships, is every
 * thread in the inbox. These hold the read-time repair.
 */
test('a preview stored before the split still gets cut on the way out', () => {
  const stored = 'Yes, the 14th works for us. On Mon, 22 Sep 2026 at 09:12, R. Iyer <r.iyer@tatasteel.com> wrote: Could you confirm the audit window?';
  assert.equal(trimQuotedPreview(stored), 'Yes, the 14th works for us.');
});

test('a preview with nothing quoted is passed through unchanged', () => {
  const clean = 'We would like a quotation for ISO 45001 covering two sites.';
  assert.equal(trimQuotedPreview(clean), clean);
});

test('a preview that is nothing but history is shown rather than blanked', () => {
  const forwarded = 'On Mon, 22 Sep 2026 at 09:12, R. Iyer wrote: Could you confirm the audit window?';
  assert.equal(trimQuotedPreview(forwarded), forwarded, 'an empty row says less than a quoted one');
});

test('an absent preview stays absent', () => {
  for (const empty of [null, undefined, '']) assert.equal(trimQuotedPreview(empty), empty ?? '');
});

test('a preview still gets truncated when the new writing itself is long', () => {
  const long = `<p>${'word '.repeat(200)}</p>`;
  const preview = snippet(cleanHtml(long));
  assert.ok(preview.length <= 240, preview.length);
  assert.match(preview, /…$/);
});

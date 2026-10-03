import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameDoc, framePolicy, hasRemoteImage } from '../src/lib/mailFrame.js';

/**
 * The inbox's security boundary (#30).
 *
 * Every one of these is a rule somebody could quietly relax while making an
 * email look better, so each says what it is protecting rather than just
 * asserting a substring.
 */

test('a message that would fetch from the network is recognised', () => {
  assert.equal(hasRemoteImage('<p>hi</p><img src="https://tracker.example/p.gif?id=7">'), true);
  assert.equal(hasRemoteImage("<img src='http://a.example/x.png'>"), true);
  assert.equal(hasRemoteImage('<img   src = "https://a.example/x.png">'), true, 'whitespace around the attribute is legal HTML');
});

test('an embedded or attached image is not a remote one', () => {
  assert.equal(hasRemoteImage('<img src="data:image/png;base64,iVBOR">'), false);
  assert.equal(hasRemoteImage('<img src="cid:logo@cetizion">'), false, 'a cid: image travelled with the message');
  assert.equal(hasRemoteImage('<p>Plain text, no images at all.</p>'), false);
});

test('by default the policy lets through only what came with the message', () => {
  const p = framePolicy(false);
  assert.match(p, /img-src data: cid:(;|$)/, 'no https: in img-src is the whole point');
  assert.doesNotMatch(p, /img-src[^;]*https:/);
});

test('showing images widens img-src and nothing else', () => {
  const off = framePolicy(false).split('; ');
  const on = framePolicy(true).split('; ');
  assert.equal(off.length, on.length, 'showing images must not add or drop a directive');
  const changed = off.filter((d, i) => d !== on[i]);
  assert.deepEqual(changed, ['img-src data: cid:'], 'img-src is the only directive that may differ');
  assert.ok(on.includes('img-src data: cid: https:'));
});

test('the frame can neither run code nor reach back out, images shown or not', () => {
  for (const showImages of [false, true]) {
    const p = framePolicy(showImages);
    for (const directive of [
      "default-src 'none'",
      "script-src 'none'",   // the sanitiser's second answer, if it is ever wrong
      "frame-src 'none'",
      "object-src 'none'",
      "connect-src 'none'",  // no beacon home once the pixels are blocked
      "form-action 'none'",  // nowhere to post a fake sign-in to
      "base-uri 'none'",     // the email cannot repoint our own <base>
    ]) {
      assert.ok(p.split('; ').includes(directive), `${directive} missing when showImages=${showImages}`);
    }
  }
});

test('the document carries the policy and opens links outside the frame', () => {
  const doc = frameDoc('<p>Hello</p>', false);
  assert.match(doc, /^<!doctype html>/);
  assert.ok(doc.includes(`content="${framePolicy(false)}"`), 'the meta must carry the policy verbatim');
  assert.match(doc, /<base target="_blank" rel="noopener noreferrer">/);
  assert.ok(doc.includes('<p>Hello</p>'));
});

test('the policy never contains a double quote, which would break out of the meta attribute', () => {
  for (const showImages of [false, true]) {
    assert.doesNotMatch(framePolicy(showImages), /"/);
  }
});

test('a message with no body still produces a valid document', () => {
  for (const empty of [null, undefined, '']) {
    const doc = frameDoc(empty, false);
    // The body carries a class now, so this matches the shape rather than
    // the exact tag: what matters is that it is empty and that null and
    // undefined never reach the page as the words "null" and "undefined".
    assert.match(doc, /<body[^>]*><\/body><\/html>$/, `${String(empty)} should not print as text`);
    assert.doesNotMatch(doc, /null|undefined/, `${String(empty)} leaked into the document`);
  }
});

// --------------------------------------------------- inline images (docs/inbox-outlook-plan.md §3.3)
import { inlineBase, rewriteCid } from '../src/lib/mailFrame.js';

test('a cid: image is pointed at the message\'s own inline route, brackets and quoting notwithstanding', () => {
  const out = rewriteCid('<p><img src="cid:logo@acme"> <img src=\'cid:<sig@x>\'> <img alt="x" src=cid:plain></p>', 42);
  assert.ok(out.includes(`src="${inlineBase(42)}logo%40acme"`), out);
  assert.ok(out.includes(`src="${inlineBase(42)}sig%40x"`), 'the angle brackets some clients write are not part of the name');
  assert.ok(out.includes(`src="${inlineBase(42)}plain"`), 'an unquoted src is rewritten too');
  assert.doesNotMatch(out, /cid:/, 'nothing is left for the browser to fail on');
});

test('only an <img> src is rewritten; a cid: anywhere else stays for the policy to refuse', () => {
  const html = '<a href="cid:x">link</a><div style="background:url(cid:y)">t</div><img src="https://a.example/p.png">';
  assert.equal(rewriteCid(html, 7), html);
  assert.equal(rewriteCid('<img src="cid:a">', null), '<img src="cid:a">', 'no message id, no rewriting');
});

test('the policy opens the one inline path of that message, and nothing else of ours', () => {
  const p = framePolicy(false, 42);
  const img = p.split('; ').find((d) => d.startsWith('img-src'));
  assert.ok(img.includes(inlineBase(42)), img);
  assert.doesNotMatch(img, /'self'/, "'self' would open every route of ours to the message");
  assert.doesNotMatch(p, /"/);
  assert.equal(framePolicy(false), framePolicy(false, null), 'without a message id the policy is as before');
  const doc = frameDoc('<img src="cid:logo">', false, { messageId: 42 });
  assert.ok(doc.includes(`${inlineBase(42)}logo`), 'the document carries the rewritten src');
  assert.ok(doc.includes(`content="${framePolicy(false, 42)}"`));
});

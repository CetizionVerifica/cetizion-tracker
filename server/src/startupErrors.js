import { BootstrapConfigError } from './auth/bootstrap.js';

/**
 * What to print when a startup step fails, as lines ready for console.error.
 *
 * Split out of start.js for one reason: start.js runs its steps and calls
 * process.exit() as soon as it is imported, so the wording can only be
 * tested from somewhere else. Nothing else moved — start.js still decides
 * when to give up and with what exit code.
 */

/** Everything we are willing to say about a thrown value. */
const describe = (err) => {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.trim() === '' ? 'the error carried no message.' : message;
};

/**
 * Bootstrapping the first admin failed. There are two quite different
 * reasons it can, and telling an operator the wrong one sends them to
 * inspect variables that were never the problem:
 *
 *   BootstrapConfigError — the configuration itself cannot be used
 *     (half of it set, an address that is not one, a password that may not
 *     be used). Those messages name variables, so pointing at the
 *     BOOTSTRAP_ADMIN_* block is the right advice.
 *
 *   anything else — Postgres refused the connection, the query failed, the
 *     table was not there, something unexpected threw. The variables may be
 *     perfectly fine, so they are not mentioned at all; the actual error is.
 *
 * The type decides, not the text of the message: an error is what it is,
 * and matching on wording would quietly misclassify the day it changes.
 *
 * Only `message` is printed — never the stack, never a pg error's `detail`
 * or `query` — so nothing a variable holds can reach the log.
 *
 * @returns {string[]} lines to print, in order.
 */
export function bootstrapFailureLines(err) {
  const lines = [`[bootstrap] ${describe(err)}`];

  if (err instanceof BootstrapConfigError) {
    lines.push(
      '[bootstrap] The API was not started. The bootstrap configuration is invalid — ' +
        'fix the BOOTSTRAP_ADMIN_* variables and deploy again.'
    );
  } else {
    lines.push(
      '[bootstrap] The API was not started: creating the first admin failed before it could listen. ' +
        'Fix the error above and deploy again.'
    );
  }

  return lines;
}

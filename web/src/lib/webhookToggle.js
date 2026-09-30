/**
 * What turning a webhook endpoint back on actually did (#103 item 2).
 *
 * While an endpoint is off with "hold events", every delivery due for it is
 * kept as held rather than dropped. Switching it back on requeues all of them
 * at once, and PATCH /api/webhooks/:id reports how many in `released`. The
 * toast used to say "Turned on" either way, so an endpoint that had been off
 * for a week let n8n take the whole backlog with no warning it was coming.
 *
 * The count is worth saying only when there is one: a `released` of 0 — an
 * endpoint that was off with nothing waiting, or one that was set to drop
 * rather than hold — has nothing to announce. The guard also covers a missing
 * count, which matters because number() renders null and undefined as an em
 * dash: unguarded, "— held deliveries released" would read as a real answer.
 */
import { number } from './format.js';

/** The toast for switching an endpoint on, naming the backlog it just let go. */
export function turnedOnMessage(released) {
  if (!released) return 'Turned on';
  return `Turned on — ${number(released)} held deliver${released === 1 ? 'y' : 'ies'} released`;
}

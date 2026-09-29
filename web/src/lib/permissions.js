/**
 * Which resources the server lets only an administrator change (#85).
 *
 * The rules themselves live in server/src/lib/resources.js and are enforced
 * there; this is the same list written down once for the front end, so a
 * screen can avoid offering a button that would only come back 403. It is a
 * courtesy to the person using the app, never a security boundary — hiding
 * a control stops nobody from calling the route.
 *
 * Kept as two flat sets rather than a check scattered through the pages, so
 * that adding a rule on the server has exactly one place to match here.
 */

/** adminOnlyDeletes: anyone may add and correct, only an admin may remove. */
export const ADMIN_ONLY_DELETE = new Set([
  'companies',
  'contacts',
  'purchase-orders',
  'po-services',
  'payment-stages',
]);

/** adminOnlyWrites: an admin curates it, everybody reads it. Implies delete. */
export const ADMIN_ONLY_WRITE = new Set([
  'pipeline-stages',
  'payments',
  'project-costs',
  'payment-terms-templates',
  'payment-terms-template-lines',
  'onboarding-templates',
  'onboarding-template-lines',
  'lead-sources',
  'lost-reasons',
  'services',
  'travel-vendors',
  'expense-categories',
  'exchange-rates',
]);

export const mayWriteResource = (resource, isAdmin) => isAdmin || !ADMIN_ONLY_WRITE.has(resource);

export const mayDeleteResource = (resource, isAdmin) =>
  isAdmin || !(ADMIN_ONLY_WRITE.has(resource) || ADMIN_ONLY_DELETE.has(resource));

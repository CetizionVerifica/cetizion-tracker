/**
 * The Owner field on enquiries, deals and projects: a pick-list of the
 * active sales users on the platform (lookups.owners), never free text, so
 * a new record cannot start yet another spelling of somebody — and the name
 * picked is exactly the one that makes that user the record's owner
 * (server/src/lib/salespersonOwner.js).
 *
 * A record saved before this may carry a name that is nobody's account.
 * It stays on the list for that record only, marked "not on the list", so
 * opening the form does not quietly blank it; picking a user replaces it.
 */
export function ownerOptions(lookups) {
  // One entry per name: two accounts sharing a name are one choice here, and
  // the Owner email (filled in below) says which of them is meant.
  const names = [...new Set((lookups.owners ?? []).map((o) => o.name))];
  return (values) => {
    const current = values?.sales_person;
    if (!current || names.includes(current)) return names;
    return [...names, { value: current, label: `${current} (not on the list)` }];
  };
}

/**
 * For a form that also has the Owner email: picking an owner fills in their
 * email, and clearing the owner clears it. The server reads the email before
 * the name, so a stale email left behind would keep the record with whoever
 * it named before.
 */
export function ownerFills(lookups) {
  return (name) => ({ sales_person_email: (lookups.owners ?? []).find((o) => o.name === name)?.email ?? '' });
}

/**
 * The account name of the owner a piece of text names — a login email or a
 * name typed with other spacing or case — or '' when it names nobody on the
 * list. For prefilling an Owner from somewhere that is not a pick-list.
 */
export function ownerNamed(lookups, text) {
  const fold = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const wanted = fold(text);
  if (!wanted) return '';
  const matches = (lookups.owners ?? []).filter((o) => fold(o.name) === wanted || fold(o.email) === wanted);
  return matches.length === 1 ? matches[0].name : '';
}

export const OWNER_HINT = 'A sales user on the platform. The super admin adds people in the super admin portal.';

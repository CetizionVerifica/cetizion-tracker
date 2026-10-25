/**
 * The Owner field on enquiries, deals and projects: a pick-list of the
 * active sales users on the platform (lookups.owners), never free text, so
 * a new record cannot start yet another spelling of somebody — and the name
 * picked is exactly the one that makes that user the record's owner
 * (server/src/lib/salespersonOwner.js).
 *
 * A record saved before this may carry a name that is nobody's account.
 * It stays on the list for that record only, marked "not on the list", so opening the form
 * does not quietly blank it; picking a user replaces it.
 */
export function ownerOptions(lookups) {
  const names = (lookups.owners ?? []).map((o) => o.name);
  return (values) => {
    const current = values?.sales_person;
    if (!current || names.includes(current)) return names;
    return [...names, { value: current, label: `${current} (not on the list)` }];
  };
}

export const OWNER_HINT = 'A sales user on the platform. Add people in Settings → Users.';

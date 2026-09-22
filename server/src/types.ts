/**
 * The shapes the whole server agrees on.
 *
 * These are the four places a wrong guess has actually cost us something:
 * who the signed-in person is, what money is, what a resource definition
 * holds, and what an API answer looks like. Everything else can be typed
 * where it lives; these are worth stating once.
 */

/** Two roles, and nothing between them. Re-read from the row on every request. */
export type Role = 'admin' | 'sales';

/** Which lock the sign-in went through. `shared` is one account for everybody. */
export type AuthMode = 'shared' | 'database';

/**
 * The signed-in person, as `req.user` carries them.
 *
 * `username` is the key older routes read and write into audit columns. In
 * database mode it is the email address; in shared mode it is
 * AUTH_USERNAME. `name` is what the tracker records on records — a sales
 * person, a task's assignee — and the two are not interchangeable: a
 * notification addressed to one and read by the other is invisible, which
 * is exactly what happened in #59.
 */
export interface CurrentUser {
  mode: AuthMode;
  /** Null in shared mode: there is no row behind it. */
  id: number | null;
  username: string;
  name: string;
  email: string | null;
  role: Role;
  /** Epoch milliseconds, from the signed cookie. */
  expiresAt: number;
}

/** A currency the tracker converts from. INR is the currency it converts to. */
export type CurrencyCode = 'INR' | 'USD' | 'EUR' | 'GBP' | 'AED' | 'SGD';

/**
 * An amount with its currency, never one without the other.
 *
 * Reports convert at the rate in force on the record's own date, so an
 * amount alone is not a figure — it is half of one.
 */
export interface Money {
  amount: number;
  currency: CurrencyCode;
}

/** What every list endpoint answers with. */
export interface ListResponse<T> {
  data: T[];
  meta?: { total: number; limit: number; offset: number };
}

/** What every single-record endpoint answers with. */
export interface ItemResponse<T> {
  data: T;
}

/**
 * A rejection, as the API writes it. `fields` is what the form highlights,
 * keyed by the field it belongs to.
 */
export interface ApiErrorBody {
  error: {
    message: string;
    fields?: Record<string, string>;
  };
}

/**
 * How a resource decides who may write it.
 *
 * `adminOnlyWrites` implies `adminOnlyDeletes`: a list only an admin may
 * write is one only an admin may delete. Absent both, any signed-in user
 * may do the lot — which is the default, and the thing to think about
 * before adding a resource rather than after.
 */
export interface ResourceAccess {
  adminOnlyWrites?: true;
  adminOnlyDeletes?: true;
}

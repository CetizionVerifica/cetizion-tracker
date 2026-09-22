/**
 * Only the fields a request actually sent. An update validated with
 * schema.partial() must save just these: from zod 4, .partial() fills in
 * .default() values, so saving the whole result would reset fields nobody
 * touched.
 */
export function sentFields(data, body) {
  const sent = body && typeof body === 'object' ? body : {};
  return Object.fromEntries(Object.entries(data).filter(([key]) => Object.hasOwn(sent, key)));
}

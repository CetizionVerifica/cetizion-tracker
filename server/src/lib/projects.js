import { ApiError } from '../middleware/error.js';
import { normalizeName } from './names.ts';
import { QUOTATION_STATUS } from './statuses.js';

const WON = QUOTATION_STATUS.won;

/**
 * A project created straight from the Projects page, rather than through
 * "Register" on a won quotation, had no way to say which quotation it
 * fulfils — so the quotation kept showing no project. The link lives on
 * quotations.project_id, so it is written from here.
 *
 * Left blank, nothing changes: the field is empty when editing an existing
 * project, and an unrelated edit must not unlink anything.
 *
 * Runs inside the save's transaction, so a quotation that cannot be linked
 * takes the project save down with it rather than leaving the two out of step.
 */
export async function linkProjectQuotation(client, { after, input }) {
  const quotationNo = input?.quotation_no;
  if (!quotationNo) return undefined;

  const { rows } = await client.query(
    'SELECT quotation_no, status, project_id, client_name FROM quotations WHERE quotation_no = $1 FOR UPDATE',
    [quotationNo]
  );
  if (!rows.length) {
    throw new ApiError(422, 'Please check the highlighted fields', {
      fields: { quotation_no: 'No quotation with that number' },
    });
  }
  const quotation = rows[0];

  // Already registered elsewhere: silently re-pointing it would detach the
  // other project's revenue without anyone noticing.
  if (quotation.project_id && quotation.project_id !== after.project_id) {
    throw new ApiError(422, 'Please check the highlighted fields', {
      fields: { quotation_no: `That quotation is already registered as project ${quotation.project_id}` },
    });
  }
  if (quotation.project_id === after.project_id) return undefined;

  if (quotation.status !== WON) {
    throw new ApiError(422, 'Please check the highlighted fields', {
      fields: { quotation_no: `Only a quotation marked "${WON}" can be registered as a project` },
    });
  }

  // A project may carry more than one won quotation, the same as Register
  // allows (#8): each PO names the quotation it fulfils, so revenue stays
  // attributed per quotation.

  // Names are free text across the app, so they are compared the way the
  // reports group them: case and spacing ignored, anything else is a
  // different client and almost certainly the wrong quotation.
  if (normalizeName(quotation.client_name) !== normalizeName(after.client_name)) {
    throw new ApiError(422, 'Please check the highlighted fields', {
      fields: { quotation_no: `That quotation is for ${quotation.client_name}, but this project is for ${after.client_name}` },
    });
  }

  await client.query(
    'UPDATE quotations SET project_id = $1, po_received = true WHERE quotation_no = $2',
    [after.project_id, quotationNo]
  );
  return { quotation_linked: quotationNo };
}

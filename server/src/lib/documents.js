import { v2 as cloudinary } from 'cloudinary';
import { config } from '../config.js';
import { query, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { documentClause } from '../auth/ownership.js';

/**
 * The documents behind quotations and purchase orders.
 *
 * Each file is stored in Cloudinary as a private ("authenticated") raw asset:
 * any file type goes in untouched, and nobody can open it by guessing a URL.
 * Postgres keeps only the reference, and the API streams the file back to a
 * signed-in user.
 */

const { cloudName, apiKey, apiSecret, folder } = config.cloudinary;
const storageReady = Boolean(cloudName && apiKey && apiSecret);
if (storageReady) {
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
}

const ASSET = { resource_type: 'raw', type: 'authenticated' };

/** Record types that carry a document; each gets its own Cloudinary folder. */
const OWNERS = new Set(['quotations', 'purchase-orders', 'payment-stages']);
export const isDocumentOwner = (owner) => OWNERS.has(owner);

// A document may be attached, or deleted, only while no record points at it.
const UNATTACHED = `NOT EXISTS (SELECT 1 FROM quotations q WHERE q.document_id = d.id)
                AND NOT EXISTS (SELECT 1 FROM purchase_orders p WHERE p.document_id = d.id)
                AND NOT EXISTS (SELECT 1 FROM payment_stages ps WHERE ps.document_id = d.id)`;

// Browsers display these themselves, and none of them can run script here.
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain']);
export const isInlineType = (contentType) => INLINE_TYPES.has(contentType);

function requireStorage() {
  if (!storageReady) {
    throw new ApiError(503, 'Document storage is not set up — the server needs its Cloudinary settings');
  }
}

async function destroyStored(storageKey) {
  const { result } = await cloudinary.uploader.destroy(storageKey, { ...ASSET, invalidate: true });
  if (result !== 'ok' && result !== 'not found') throw new Error(`Cloudinary answered "${result}"`);
}

/** Store a file and record it. Returns the new document row. */
export async function uploadDocument({ buffer, fileName, contentType, owner }) {
  requireStorage();

  let stored;
  try {
    stored = await new Promise((resolve, reject) => {
      cloudinary.uploader
        .upload_stream({ ...ASSET, folder: `${folder}/${owner}` }, (error, result) =>
          error ? reject(error) : resolve(result)
        )
        .end(buffer);
    });
  } catch (err) {
    console.error('[documents] upload failed', err);
    throw new ApiError(502, `The file could not be stored: ${err.message || 'Cloudinary refused it'}`);
  }

  try {
    const { rows } = await query(
      `INSERT INTO documents (storage_key, file_name, content_type, size_bytes)
       VALUES ($1, $2, $3, $4)
       RETURNING id, file_name, content_type, size_bytes, created_at`,
      [stored.public_id, fileName, contentType, buffer.length]
    );
    return rows[0];
  } catch (err) {
    // Without its row nothing would ever point at the file, so remove it now.
    await destroyStored(stored.public_id).catch(() => {});
    throw err;
  }
}

/**
 * Lock a document for attaching and say whether it may be attached: it must
 * exist, not be on its way out, and not be used by any quotation or PO.
 * Call it inside the transaction that writes the record, so the lock holds
 * until that commits — a second save, or a purge, waits and then sees it.
 */
export async function lockAttachableDocument(client, id) {
  const { rowCount: available } = await client.query(
    'SELECT 1 FROM documents WHERE id = $1 AND purging_at IS NULL FOR UPDATE',
    [id]
  );
  if (!available) return false;
  const { rowCount } = await client.query(`SELECT 1 FROM documents d WHERE d.id = $1 AND ${UNATTACHED}`, [id]);
  return rowCount > 0;
}

/**
 * Which document a save should end up pointing at, claimed under lock.
 *
 * `requested` is what the save asked for: a blank one — absent or null —
 * never clears the document already attached, it keeps it, so nothing is
 * claimed and nothing is replaced. Only a different document is locked, and
 * only then is the one it displaces returned, for the caller to purge once
 * the save has committed.
 *
 * Call it inside the transaction that writes the record, after that record's
 * row is locked. Everything else — finding the row, its 404, writing the
 * column and purging afterwards — belongs to the caller.
 */
export async function claimAttachment(client, { current, requested }) {
  const next = requested ?? current;
  if (next !== current && !(await lockAttachableDocument(client, next))) {
    throw new ApiError(422, 'Please check the highlighted fields', {
      fields: { document_id: 'That upload has expired or is already in use — choose the file again' },
    });
  }
  return { documentId: next, replaced: next !== current ? current : null };
}

/**
 * Remove a document nothing points at any more. Only ever called once the
 * save that released it has committed: a failure here leaves the record
 * saved and the file for the orphan sweep, never the other way round.
 */
export const purgeAfterCommit = (id) =>
  purgeDocument(id).catch((err) => console.error('[documents]', err));

/** The document row and its bytes, fetched through a signed Cloudinary URL. */
/**
 * Refuse a document this request may not read (#18 Phase 2C).
 *
 * 404, not 403: the same answer as an id that does not exist, so nobody
 * learns which ids are real by asking for them one at a time.
 */
export async function assertDocumentReadable(scope, id) {
  const params = [id];
  const clause = documentClause(scope, params, { alias: 'd' });
  if (!clause) return;
  const { rowCount } = await query(
    `SELECT 1 FROM documents d WHERE d.id = $1 AND ${clause}`,
    params
  );
  if (!rowCount) throw new ApiError(404, 'Document not found');
}

export async function fetchDocument(id) {
  requireStorage();
  const { rows } = await query('SELECT * FROM documents WHERE id = $1', [id]);
  if (!rows.length) throw new ApiError(404, 'Document not found');

  const document = rows[0];
  let response;
  try {
    response = await fetch(cloudinary.url(document.storage_key, { ...ASSET, sign_url: true }), {
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.error(`[documents] fetching ${document.storage_key} failed`, err.message);
    throw new ApiError(502, 'The file could not be fetched from storage');
  }
  if (!response.ok) {
    console.error(`[documents] fetching ${document.storage_key} returned ${response.status}`);
    throw new ApiError(502, 'The file could not be fetched from storage');
  }
  return { document, body: Buffer.from(await response.arrayBuffer()) };
}

/**
 * Remove a document nothing uses any more. It is first marked for removal,
 * under the same row lock an attaching save takes, so from that commit on
 * nothing can attach it. Only then is its file deleted from Cloudinary, and
 * last its row. If Cloudinary cannot be reached the marked row stays and the
 * orphan sweep tries again; no record can point at it meanwhile.
 */
export async function purgeDocument(id) {
  if (!storageReady) return;

  const storageKey = await transaction(async (client) => {
    const { rows } = await client.query('SELECT storage_key FROM documents WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length) return null;
    const { rowCount: unattached } = await client.query(
      `SELECT 1 FROM documents d WHERE d.id = $1 AND ${UNATTACHED}`,
      [id]
    );
    if (!unattached) return null;
    await client.query('UPDATE documents SET purging_at = COALESCE(purging_at, now()) WHERE id = $1', [id]);
    return rows[0].storage_key;
  });
  if (!storageKey) return;

  try {
    await destroyStored(storageKey);
  } catch (err) {
    console.error(`[documents] could not delete ${storageKey}; will retry`, err.message ?? err);
    return;
  }
  await query('DELETE FROM documents WHERE id = $1 AND purging_at IS NOT NULL', [id]);
}

/**
 * Finish removals that were interrupted, and clear out uploads whose form
 * was never saved once they are a day old.
 */
export async function purgeOrphanedDocuments() {
  const { rows } = await query(
    `SELECT id FROM documents d
      WHERE d.purging_at IS NOT NULL
         OR (d.created_at < now() - interval '1 day' AND ${UNATTACHED})`
  );
  // One document Cloudinary still refuses must not stop the rest, and the
  // scheduled run records this result, so the failures are counted not thrown.
  let purged = 0;
  const failed = [];
  for (const { id } of rows) {
    try {
      await purgeDocument(id);
      purged += 1;
    } catch (err) {
      failed.push({ id, error: err.message });
    }
  }
  return { found: rows.length, purged, failed };
}

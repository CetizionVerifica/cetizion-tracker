import { v2 as cloudinary } from 'cloudinary';
import { config } from '../config.js';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';

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
const OWNERS = new Set(['quotations', 'purchase-orders']);
export const isDocumentOwner = (owner) => OWNERS.has(owner);

// A document may be attached, or deleted, only while no record points at it.
const UNATTACHED = `NOT EXISTS (SELECT 1 FROM quotations q WHERE q.document_id = d.id)
                AND NOT EXISTS (SELECT 1 FROM purchase_orders p WHERE p.document_id = d.id)`;

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

/** True when the document exists and no quotation or PO uses it yet. */
export async function isAttachableDocument(id) {
  const { rowCount } = await query(`SELECT 1 FROM documents d WHERE d.id = $1 AND ${UNATTACHED}`, [id]);
  return rowCount > 0;
}

/** The document row and its bytes, fetched through a signed Cloudinary URL. */
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
 * Remove a document nothing uses any more: from Cloudinary first, then its
 * row. If Cloudinary cannot be reached the row stays, still unattached, and
 * the orphan sweep tries again later.
 */
export async function purgeDocument(id) {
  if (!storageReady) return;
  const { rows } = await query(`SELECT storage_key FROM documents d WHERE d.id = $1 AND ${UNATTACHED}`, [id]);
  if (!rows.length) return;

  try {
    await destroyStored(rows[0].storage_key);
  } catch (err) {
    console.error(`[documents] could not delete ${rows[0].storage_key}; will retry`, err.message ?? err);
    return;
  }
  await query(`DELETE FROM documents d WHERE d.id = $1 AND ${UNATTACHED}`, [id]);
}

/** Clear out uploads whose form was never saved, once they are a day old. */
export async function purgeOrphanedDocuments() {
  const { rows } = await query(
    `SELECT id FROM documents d WHERE d.created_at < now() - interval '1 day' AND ${UNATTACHED}`
  );
  for (const { id } of rows) await purgeDocument(id);
}

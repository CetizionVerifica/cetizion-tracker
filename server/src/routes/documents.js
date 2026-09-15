import express, { Router } from 'express';
import { config } from '../config.js';
import {
  fetchDocument, isDocumentOwner, isInlineType, purgeOrphanedDocuments, uploadDocument,
} from '../lib/documents.js';
import { ApiError } from '../middleware/error.js';

export const documentRouter = Router();

const readBody = express.raw({ type: 'application/octet-stream', limit: config.documentMaxBytes });
const limitLabel = `${Number((config.documentMaxBytes / 1024 / 1024).toFixed(2))} MB`;

/** The raw file body, with the size limit reported as something a person can act on. */
function receiveFile(req, res, next) {
  readBody(req, res, (err) => {
    if (err?.type === 'entity.too.large') {
      return next(new ApiError(413, `The file is larger than the ${limitLabel} limit`));
    }
    next(err);
  });
}

function cleanFileName(header) {
  let name;
  try {
    name = decodeURIComponent(header ?? '');
  } catch {
    name = String(header ?? '');
  }
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  name = name.replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(-200);
  return name || 'document';
}

function cleanContentType(header) {
  const type = String(header ?? '').trim().toLowerCase();
  return type.length <= 120 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)
    ? type
    : 'application/octet-stream';
}

/** RFC 5987 encoding for filename*=, which also escapes ' ( ) *. */
const encodeHeaderValue = (value) =>
  encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Upload one file. The browser sends the bytes as the request body, with the
 * original name and type in headers, and ?for= naming the kind of record it
 * belongs to. The record is saved afterwards, with the id this returns.
 */
documentRouter.post('/', receiveFile, async (req, res) => {
  const owner = String(req.query.for ?? '');
  if (!isDocumentOwner(owner)) {
    throw new ApiError(422, 'Documents can only be attached to quotations and purchase orders');
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    throw new ApiError(422, 'Choose a file to upload');
  }

  const document = await uploadDocument({
    buffer: req.body,
    fileName: cleanFileName(req.get('X-File-Name')),
    contentType: cleanContentType(req.get('X-File-Type')),
    owner,
  });
  res.status(201).json({ data: document });

  purgeOrphanedDocuments().catch((err) => console.error('[documents] orphan sweep failed', err));
});

/**
 * Send a document back. PDFs, images and plain text open in the browser;
 * anything else downloads, so an uploaded web page can never run as part of
 * this app.
 */
documentRouter.get('/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw new ApiError(404, 'Document not found');

  const { document, body } = await fetchDocument(Number(req.params.id));
  const inline = isInlineType(document.content_type);
  const asciiName = document.file_name.replace(/[^\x20-\x7e]|["\\]/g, '_');

  res.setHeader('Content-Type', inline ? document.content_type : 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeHeaderValue(document.file_name)}`
  );
  res.setHeader('Cache-Control', 'private, no-store');
  // helmet's object-src 'none' stops Chrome's PDF viewer from drawing the
  // file, and none of the inline types can run script on this origin.
  if (inline) res.removeHeader('Content-Security-Policy');
  res.send(body);
});

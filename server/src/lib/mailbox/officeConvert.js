/**
 * PowerPoint and the older Office formats, turned into a PDF for the
 * tracker's viewer (docs/inbox-attachments-plan.md §7, step 3).
 *
 * The tracker does not run LibreOffice itself: a Gotenberg container does
 * (https://gotenberg.dev, LibreOffice behind an HTTP API), on the private
 * network next to the API and with no way out to the internet, so a file
 * that tries to reach a server gets nowhere. DOC_CONVERTER_URL is its
 * address, e.g. http://gotenberg:3000; a user:password in it is sent as
 * basic auth, for a Gotenberg started with --api-enable-basic-auth. Unset,
 * these files are listed but not viewable, as before.
 *
 * Nothing is kept: the file goes in, the PDF comes back and is sent to the
 * viewer, and both are dropped.
 */

/** The longest a conversion may take before the viewer is told to use Outlook. */
export const CONVERT_TIMEOUT_MS = 60_000;
/** The largest PDF accepted back: a 25 MB deck full of pictures can grow. */
export const CONVERTED_MAX_BYTES = 60 * 1024 * 1024;

export const converterConfigured = () => Boolean(process.env.DOC_CONVERTER_URL);

/** The converter's address and, when its URL carries them, its basic-auth header. */
function converter() {
  const url = new URL('/forms/libreoffice/convert', process.env.DOC_CONVERTER_URL);
  const headers = {};
  if (url.username || url.password) {
    headers.Authorization = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`;
    url.username = '';
    url.password = '';
  }
  return { url: url.toString(), headers };
}

/**
 * One file as a PDF. LibreOffice reads the format from the file's
 * extension, so the file is sent under a plain name with the one its type
 * gives (`ext`), never the sender's own name. Throws when the converter is
 * unreachable, refuses the file, takes too long or answers with something
 * that is not a PDF.
 */
export async function toPdf(buffer, ext, { fetchImpl = fetch } = {}) {
  const { url, headers } = converter();
  const form = new FormData();
  form.append('files', new Blob([buffer]), `attachment.${ext}`);
  const res = await fetchImpl(url, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(CONVERT_TIMEOUT_MS) });
  if (!res.ok) throw Object.assign(new Error(`converter answered ${res.status}`), { status: res.status });
  const length = Number(res.headers.get('content-length')) || 0;
  if (length > CONVERTED_MAX_BYTES) throw new Error('converted file over the cap');
  const pdf = Buffer.from(await res.arrayBuffer());
  if (pdf.length > CONVERTED_MAX_BYTES) throw new Error('converted file over the cap');
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('converter did not return a PDF');
  return pdf;
}

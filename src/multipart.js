// Just enough multipart/form-data parsing to accept the request AssemblyAI's Dictation
// endpoint accepts: an `audio` file part. A raw (non-multipart) body is taken as the
// audio itself. No dependencies.

export function extractAudio(body, contentType = '') {
  if (!String(contentType).toLowerCase().startsWith('multipart/form-data')) {
    return body.length ? body : null;
  }
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!m) return null;
  const boundary = Buffer.from('--' + (m[1] || m[2]));

  let fallback = null; // first file part, if nothing is named "audio"
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (body.subarray(start, start + 2).toString() === '--') break; // closing boundary
    const headerEnd = body.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const headers = body.subarray(start, headerEnd).toString('utf8');
    const next = body.indexOf(boundary, headerEnd + 4);
    if (next === -1) break;
    const content = body.subarray(headerEnd + 4, next - 2); // drop the CRLF before the boundary
    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    if (name === 'audio') return content;
    if (!fallback && /filename=/i.test(headers)) fallback = content;
    pos = next;
  }
  return fallback;
}

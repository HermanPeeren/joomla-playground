// The playground's inbox: the mails Joomla (or any PHP code) sends are caught by the PHP worker (a sendmail
// stand-in) and shown here instead of being delivered.

/**
 * Reads a raw mail (RFC 5322, as sendmail gets it) into headers, a text body and an HTML body.
 *
 * @returns {{headers: Object<string, string>, subject: string, from: string, to: string, date: string, text: string|null, html: string|null}}
 */
export function parseMail(raw) {
  const { headers, body } = splitHeaders(raw);
  const parts = { text: null, html: null };

  collectParts(headers, body, parts);

  return {
    headers,
    subject: decodeWords(headers['subject'] ?? '(no subject)'),
    from: decodeWords(headers['from'] ?? ''),
    to: decodeWords(headers['to'] ?? ''),
    date: headers['date'] ?? '',
    text: parts.text,
    html: parts.html,
  };
}

function splitHeaders(raw) {
  const normalized = raw.replace(/\r\n/g, '\n');
  const end = normalized.indexOf('\n\n');
  const head = end === -1 ? normalized : normalized.slice(0, end);
  const body = end === -1 ? '' : normalized.slice(end + 2);
  const headers = {};

  // Folded header lines continue with whitespace.
  for (const line of head.replace(/\n[ \t]+/g, ' ').split('\n')) {
    const colon = line.indexOf(':');

    if (colon > 0) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  }

  return { headers, body };
}

function collectParts(headers, body, parts) {
  const type = (headers['content-type'] ?? 'text/plain').toLowerCase();
  const boundary = (headers['content-type'] ?? '').match(/boundary="?([^";]+)"?/i)?.[1];

  if (type.startsWith('multipart/') && boundary) {
    for (const section of body.split(`--${boundary}`).slice(1)) {
      if (section.startsWith('--')) {
        break;
      }

      const part = splitHeaders(section.replace(/^\n/, ''));

      collectParts(part.headers, part.body, parts);
    }

    return;
  }

  const charset = type.match(/charset="?([^";]+)"?/)?.[1] ?? 'utf-8';
  const text = decodeBody(body, headers['content-transfer-encoding'], charset);

  if (type.startsWith('text/html')) {
    parts.html ??= text;
  } else if (type.startsWith('text/')) {
    parts.text ??= text;
  }
}

function decodeBody(body, encoding = '', charset = 'utf-8') {
  encoding = encoding.toLowerCase();

  if (encoding === 'base64') {
    return decodeBytes(Uint8Array.from(atob(body.replace(/\s+/g, '')), (char) => char.charCodeAt(0)), charset);
  }

  if (encoding === 'quoted-printable') {
    const binary = body.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));

    return decodeBytes(Uint8Array.from(binary, (char) => char.charCodeAt(0) & 0xff), charset);
  }

  return body;
}

function decodeBytes(bytes, charset) {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/**
 * Decodes encoded words in headers: =?UTF-8?B?...?= and =?UTF-8?Q?...?=.
 */
function decodeWords(value) {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (match, charset, encoding, text) =>
      encoding.toUpperCase() === 'B'
        ? decodeBody(text, 'base64', charset)
        : decodeBody(text.replace(/_/g, ' '), 'quoted-printable', charset)
    );
}

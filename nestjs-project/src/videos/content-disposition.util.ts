const FALLBACK_FILENAME = 'video';

/**
 * `Content-Disposition: attachment` com o nome original. O `filename` leva um
 * fallback só ASCII; quando o nome tem caracteres fora de ASCII, entra também
 * `filename*=UTF-8''...` (RFC 6266 / RFC 8187), que os navegadores preferem.
 */
export function attachmentDisposition(filename: string): string {
  const cleaned = filename.replace(/["\\\r\n]/g, '').trim();

  const isAscii = /^[\x20-\x7e]*$/.test(cleaned);
  const asciiFallback =
    cleaned.replace(/[^\x20-\x7e]/g, '_') || FALLBACK_FILENAME;

  const disposition = `attachment; filename="${asciiFallback}"`;
  if (isAscii) {
    return disposition;
  }
  return `${disposition}; filename*=UTF-8''${encodeRfc8187(cleaned)}`;
}

/** `encodeURIComponent` deixa `'()*!` sem escapar, mas a RFC 8187 exige. */
function encodeRfc8187(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*!]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

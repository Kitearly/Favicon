/**
 * Content type sniffing.
 *
 * Servers regularly serve icons with a wrong or generic content type
 * (`application/octet-stream` for `.ico` is the classic one), so the real type
 * is derived from the magic bytes instead of trusting the header.
 */

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length && offset + i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[offset + i]!);
  }
  return out;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Determine the image type of a payload from its magic bytes.
 *
 * Returns `null` when the payload is not an image at all — that is how an
 * upstream that answers with an HTML error page is detected.
 */
export function sniffImageType(bytes: Uint8Array, declaredType?: string | null): string | null {
  if (bytes.length === 0) return null;

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp";
  // ICO (00 00 01 00) and cursor files (00 00 02 00).
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (startsWith(bytes, [0x00, 0x00, 0x02, 0x00])) return "image/x-icon";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";

  // SVG is text based, so it needs a slightly different check.
  const head = decodeText(bytes.subarray(0, Math.min(bytes.length, 4096)))
    .trim()
    .toLowerCase();
  if (head.startsWith("<svg")) return "image/svg+xml";
  if (head.startsWith("<?xml") && head.includes("<svg")) return "image/svg+xml";

  // Fall back to the declared type when it claims SVG but the markup only
  // appears further down the document.
  const declared = (declaredType ?? "").toLowerCase();
  if (declared.includes("svg") && decodeText(bytes).toLowerCase().includes("<svg")) {
    return "image/svg+xml";
  }

  return null;
}

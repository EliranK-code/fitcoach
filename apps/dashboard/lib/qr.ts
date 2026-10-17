import { toDataURL } from "qrcode";

/** A QR code as a data URL, generated locally (an otpauth:// secret must never go to an outside QR service). */
export function qrDataUrl(text: string): Promise<string> {
  return toDataURL(text, { margin: 1, width: 220, errorCorrectionLevel: "M" });
}

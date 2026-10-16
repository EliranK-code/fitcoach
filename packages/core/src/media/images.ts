import sharp from "sharp";

// Photos from clients (meals, gym, progress) are normalized before they reach Claude: rotated upright,
// scaled so the long edge fits Claude's recommended 1568px, re-encoded as JPEG, and stripped of all
// metadata (EXIF can carry GPS location). The result is sent as base64, never as a URL, so the stored
// conversation stays byte-identical when it's replayed.

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_EDGE = 1568;

export class ImageError extends Error {}

export interface PreparedImage {
  /** Base64 of the JPEG. */
  data: string;
  mediaType: "image/jpeg";
  width: number;
  height: number;
}

export async function prepareImage(input: Buffer): Promise<PreparedImage> {
  if (input.length > MAX_IMAGE_BYTES) throw new ImageError("התמונה גדולה מדי");
  try {
    const { data, info } = await sharp(input, { failOn: "error" })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    return { data: data.toString("base64"), mediaType: "image/jpeg", width: info.width, height: info.height };
  } catch (err) {
    throw new ImageError(`לא הצלחתי לקרוא את התמונה: ${err instanceof Error ? err.message : String(err)}`);
  }
}

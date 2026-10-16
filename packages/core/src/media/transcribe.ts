import OpenAI, { toFile } from "openai";
import type { AppConfig } from "../config";

// Voice messages are transcribed, then handled like text. WhatsApp voice notes are OGG/Opus.

export interface Transcriber {
  readonly model: string;
  transcribe(audio: Buffer, mimeType: string): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}

export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "m4a",
  "audio/amr": "amr",
  "audio/wav": "wav",
  "audio/webm": "webm",
};

/** OpenAI transcription; null without OPENAI_API_KEY (voice messages then get a "please write" reply). */
export function createTranscriber(cfg: AppConfig): Transcriber | null {
  if (!cfg.OPENAI_API_KEY) return null;
  const client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });
  const model = cfg.OPENAI_TRANSCRIBE_MODEL;
  return {
    model,
    async transcribe(audio, mimeType) {
      if (audio.length > MAX_AUDIO_BYTES) throw new Error("Voice message too large to transcribe");
      const base = mimeType.split(";")[0]!.trim().toLowerCase();
      const file = await toFile(audio, `voice.${EXTENSIONS[base] ?? "ogg"}`, { type: base });
      const res = await client.audio.transcriptions.create({ file, model });
      const usage = (res as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      return { text: res.text.trim(), inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 };
    },
  };
}

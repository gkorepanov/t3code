import { Buffer } from "node:buffer";

import type {
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "@t3tools/contracts";
import type { ServerSettings } from "@t3tools/contracts/settings";

const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_DURATION_MS = 120_000;

export async function transcribeVoiceWithOpenAI(input: {
  readonly request: ServerVoiceTranscriptionInput;
  readonly settings: ServerSettings;
  readonly fetchImpl?: typeof fetch;
  readonly transcriptionUrl?: string;
  readonly model?: string;
}): Promise<ServerVoiceTranscriptionResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Voice transcription is unavailable in this runtime.");
  }

  const apiKey = input.settings.voiceTranscription.openaiApiKey.trim();
  if (!apiKey) {
    throw new Error("Add an OpenAI API key in Settings to use voice transcription.");
  }

  const audioBuffer = decodeVoiceAudio(input.request);
  const response = await requestTranscription({
    fetchImpl,
    audioBuffer,
    mimeType: input.request.mimeType,
    apiKey,
    transcriptionUrl: input.transcriptionUrl ?? OPENAI_TRANSCRIPTIONS_URL,
    model: input.model ?? OPENAI_TRANSCRIPTION_MODEL,
  });

  if (!response.ok) {
    throw new Error(await readTranscriptionErrorMessage(response));
  }

  const payload = (await response.json().catch(() => null)) as { text?: unknown } | null;
  const text = readNonEmptyString(payload?.text);
  if (!text) {
    throw new Error("The transcription response did not include any text.");
  }

  return { text };
}

function decodeVoiceAudio(input: ServerVoiceTranscriptionInput): Buffer {
  if (input.provider !== "codex") {
    throw new Error("Voice transcription is only enabled for Codex threads.");
  }
  if (input.mimeType !== "audio/wav") {
    throw new Error("Only WAV audio is supported for voice transcription.");
  }
  if (input.sampleRateHz !== 24_000) {
    throw new Error("Voice transcription requires 24 kHz mono WAV audio.");
  }
  if (input.durationMs <= 0) {
    throw new Error("Voice messages must include a positive duration.");
  }
  if (input.durationMs > MAX_DURATION_MS) {
    throw new Error("Voice messages are limited to 120 seconds.");
  }

  const normalizedBase64 = input.audioBase64.trim().replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalizedBase64)) {
    throw new Error("The recorded audio could not be decoded.");
  }

  const audioBuffer = Buffer.from(normalizedBase64, "base64");
  if (!audioBuffer.length || audioBuffer.toString("base64") !== normalizedBase64) {
    throw new Error("The recorded audio could not be decoded.");
  }
  if (audioBuffer.length > MAX_AUDIO_BYTES) {
    throw new Error("Voice messages are limited to 10 MB.");
  }
  if (
    audioBuffer.length < 12 ||
    audioBuffer.toString("ascii", 0, 4) !== "RIFF" ||
    audioBuffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("The recorded audio is not a valid WAV file.");
  }

  return audioBuffer;
}

async function requestTranscription(input: {
  readonly fetchImpl: typeof fetch;
  readonly audioBuffer: Buffer;
  readonly mimeType: string;
  readonly apiKey: string;
  readonly transcriptionUrl: string;
  readonly model: string;
}): Promise<Response> {
  const formData = new FormData();
  formData.append("model", input.model);
  formData.append("response_format", "json");
  formData.append(
    "file",
    new Blob([new Uint8Array(input.audioBuffer)], { type: input.mimeType }),
    "voice.wav",
  );

  return input.fetchImpl(input.transcriptionUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: formData,
  });
}

async function readTranscriptionErrorMessage(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: unknown };
    message?: unknown;
  } | null;
  return (
    readNonEmptyString(payload?.error?.message) ??
    readNonEmptyString(payload?.message) ??
    `Transcription failed with status ${response.status}.`
  );
}

function readNonEmptyString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

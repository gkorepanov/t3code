import { memo, useCallback, useMemo, useRef, useState } from "react";
import { CheckIcon, Loader2Icon, MicIcon } from "lucide-react";

import { formatVoiceRecordingDuration, useVoiceRecorder } from "../../lib/voiceRecorder";
import type { EnvironmentId } from "@t3tools/contracts";

import { readEnvironmentApi } from "../../environmentApi";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

interface ComposerVoiceControlProps {
  environmentId: EnvironmentId;
  cwd: string | null;
  disabled: boolean;
  voiceTranscriptionConfigured: boolean;
  onTranscriptReady: (transcript: string) => void;
}

const BAR_WIDTH_PX = 2;
const BAR_GAP_PX = 2;

export const ComposerVoiceControl = memo(function ComposerVoiceControl({
  environmentId,
  cwd,
  disabled,
  voiceTranscriptionConfigured,
  onTranscriptReady,
}: ComposerVoiceControlProps) {
  const {
    isRecording,
    durationMs,
    waveformLevels,
    startRecording,
    stopRecording,
    cancelRecording,
  } = useVoiceRecorder();
  const [isTranscribing, setIsTranscribing] = useState(false);
  const requestIdRef = useRef(0);
  const durationLabel = useMemo(() => formatVoiceRecordingDuration(durationMs), [durationMs]);
  const visibleWaveformLevels = useMemo(
    () =>
      waveformLevels.slice(-42).map((level, index) => ({
        id: waveformLevels.length - 42 + index,
        level,
      })),
    [waveformLevels],
  );
  const isBusy = isRecording || isTranscribing;

  const start = useCallback(async () => {
    if (!cwd || disabled || isBusy) return;
    if (!voiceTranscriptionConfigured) {
      toastManager.add({
        type: "warning",
        title: "OpenAI API key required",
        description: "Add an API key in Settings to use voice input.",
      });
      return;
    }
    try {
      await startRecording();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not start recording",
        description: describeRecordingStartError(error),
      });
    }
  }, [cwd, disabled, isBusy, startRecording, voiceTranscriptionConfigured]);

  const submit = useCallback(async () => {
    if (!cwd || !isRecording) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      toastManager.add({ type: "error", title: "Voice transcription is unavailable." });
      void cancelRecording();
      return;
    }

    setIsTranscribing(true);
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const isCurrentRequest = () => requestIdRef.current === requestId;

    try {
      const payload = await stopRecording();
      if (!isCurrentRequest()) return;
      if (!payload) {
        toastManager.add({ type: "warning", title: "No audio was captured." });
        return;
      }
      const result = await api.server.transcribeVoice({
        provider: "codex",
        cwd,
        ...payload,
      });
      if (!isCurrentRequest()) return;
      onTranscriptReady(result.text);
    } catch (error) {
      if (!isCurrentRequest()) return;
      toastManager.add({
        type: "error",
        title: "Voice transcription failed",
        description: sanitizeVoiceError(error),
      });
    } finally {
      if (isCurrentRequest()) {
        setIsTranscribing(false);
      }
    }
  }, [cancelRecording, cwd, environmentId, isRecording, onTranscriptReady, stopRecording]);

  if (!isRecording && !isTranscribing) {
    return (
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="shrink-0 rounded-full text-muted-foreground/70 hover:text-foreground"
        disabled={disabled || !cwd}
        aria-label="Record voice note"
        title="Record voice note"
        onClick={start}
      >
        <MicIcon className="size-4" />
      </Button>
    );
  }

  return (
    <div className="flex h-9 min-w-0 items-center gap-2 rounded-full border border-border bg-background/80 px-2 shadow-sm sm:h-8">
      <div className="flex h-5 w-28 min-w-0 items-center justify-end overflow-hidden sm:w-36">
        <div className="flex items-center" style={{ gap: `${BAR_GAP_PX}px` }}>
          {visibleWaveformLevels.map(({ id, level }) => {
            const height = 3 + Math.round(Math.max(0.04, Math.min(1, level)) * 15);
            return (
              <span
                key={id}
                className={cn(
                  "shrink-0 rounded-[1px] bg-foreground",
                  isTranscribing && "opacity-45",
                )}
                style={{ width: `${BAR_WIDTH_PX}px`, height }}
              />
            );
          })}
        </div>
      </div>
      <span className="w-9 shrink-0 text-xs tabular-nums text-muted-foreground">
        {durationLabel}
      </span>
      <button
        type="button"
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform hover:scale-105 disabled:opacity-50 disabled:hover:scale-100"
        disabled={isTranscribing}
        aria-label="Transcribe voice note"
        onClick={submit}
      >
        {isTranscribing ? (
          <Loader2Icon className="size-3 animate-spin" />
        ) : (
          <CheckIcon className="size-3.5" />
        )}
      </button>
    </div>
  );
});

function describeRecordingStartError(error: unknown): string {
  if (!(error instanceof Error)) return "The microphone could not be opened.";
  if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
    return "Microphone access was denied. Enable it in system settings and try again.";
  }
  if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
    return "No microphone was found.";
  }
  if (error.name === "NotReadableError" || error.name === "TrackStartError") {
    return "The microphone is busy or unavailable right now.";
  }
  return sanitizeVoiceError(error);
}

function sanitizeVoiceError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "The voice note could not be transcribed.";
  const firstLine = message.trim().split("\n")[0]?.trim() ?? "";
  const withoutRemotePrefix = firstLine.replace(
    /^Error invoking remote method ['"][^'"]+['"]:\s*/i,
    "",
  );
  const normalized = withoutRemotePrefix.replace(/^(Error:\s*)+/i, "").trim();
  return normalized || "The voice note could not be transcribed.";
}

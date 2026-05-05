import { useId } from "react";
import { ComposerChoicePanel, DevOptionsPanel } from "./composer-choice-panel";
import type { ComposerQuestion } from "@/lib/home-agent/types";
import { cn } from "@/lib/utils";
import type { VideoGenerationMode, VideoImageGenerationPrefs } from "@/types/project";

export interface ComposerWorkflowProgress {
  title: string;
  description: string;
  /** Completed progress floor, used as the lower bound of the progress bar. */
  floorPercent: number;
  /** Progress ceiling including the currently processing batch. */
  ceilPercent: number;
  /** Whether there is a batch currently processing. */
  hasProcessing: boolean;
  statusLabel: string;
  detailLabel?: string;
  currentBatchLabel?: string;
  onStop?: () => void;
  onRegenerate?: () => void;
}

interface ComposerChoiceModalProps {
  question: ComposerQuestion | null;
  progress?: ComposerWorkflowProgress | null;
  onSelect: (value: string, label: string) => void;
  onConfirm?: () => void;
  onBack?: () => void;
  onDismiss?: () => void;
  canConfirm?: boolean;
  tone?: "light" | "dark";
  devMode?: boolean;
  devVideoGenerationMode?: VideoGenerationMode;
  devImageViewMode?: VideoImageGenerationPrefs["viewMode"];
  onDevVideoGenerationModeChange?: (mode: VideoGenerationMode) => void;
  onDevImageViewModeChange?: (
    mode: NonNullable<VideoImageGenerationPrefs["viewMode"]>,
  ) => void;
}

/**
 * Composer-anchored, non-blocking choice window for structured AskUserQuestion.
 * The panel is positioned directly above the composer so they stay visually connected.
 * Progress is now rendered inline in the conversation message stream (OutlineProgressInline).
 */
export default function ComposerChoiceModal({
  question,
  progress = null,
  onSelect,
  onConfirm,
  onBack,
  onDismiss,
  canConfirm = false,
  tone = "dark",
  devMode = false,
  devVideoGenerationMode,
  devImageViewMode,
  onDevVideoGenerationModeChange,
  onDevImageViewModeChange,
}: ComposerChoiceModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  // In dev mode, render the global backtrack actions even when there is no question.
  if (!question && !progress) {
    if (!devMode) return null;
    return (
      <div className="pointer-events-auto absolute bottom-[calc(100%+6px)] left-0 z-[60] w-[min(96vw,540px)] overflow-visible">
        <div className="rounded-[16px] border border-amber-400/20 bg-[#0f1117]/95 p-3 shadow-[0_8px_32px_rgba(0,0,0,0.4)] backdrop-blur-sm">
          <DevOptionsPanel
            devOptions={[]}
            onSelect={onSelect}
            devVideoGenerationMode={devVideoGenerationMode}
            devImageViewMode={devImageViewMode}
            onDevVideoGenerationModeChange={onDevVideoGenerationModeChange}
            onDevImageViewModeChange={onDevImageViewModeChange}
          />
        </div>
      </div>
    );
  }

  if (!question) return null;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className={cn(
        "pointer-events-auto absolute bottom-[calc(100%+6px)] left-0 z-[60] w-[min(96vw,540px)] overflow-visible border-0 bg-transparent p-0 shadow-none outline-none",
      )}
    >
      <div id={titleId} className="sr-only">
        {question.title}
      </div>
      <div id={descriptionId} className="sr-only">
        {question.description ?? "Choose an option to continue."}
      </div>
      <div className="origin-bottom-left">
        <ComposerChoicePanel
          question={question}
          onSelect={onSelect}
          onConfirm={onConfirm}
          onBack={onBack}
          onDismiss={onDismiss}
          canConfirm={canConfirm}
          tone={tone}
          devMode={devMode}
          devVideoGenerationMode={devVideoGenerationMode}
          devImageViewMode={devImageViewMode}
          onDevVideoGenerationModeChange={onDevVideoGenerationModeChange}
          onDevImageViewModeChange={onDevImageViewModeChange}
        />
      </div>
    </div>
  );
}


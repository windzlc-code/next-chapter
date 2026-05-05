import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { CreationGuideDimensionId, CreationGuidePresetOption } from "@/lib/home-agent/creation-guide-presets";
import {
  CREATION_GUIDE_DIMENSION_META,
  CREATION_GUIDE_PRESETS,
} from "@/lib/home-agent/creation-guide-presets";
import { cn } from "@/lib/utils";

export interface GuidePresetPickerModalProps {
  dimension: CreationGuideDimensionId | null;
  onClose: () => void;
  onPick: (dimension: CreationGuideDimensionId, value: string, label: string) => void;
}

export default function GuidePresetPickerModal({ dimension, onClose, onPick }: GuidePresetPickerModalProps) {
  const open = Boolean(dimension);
  const meta = dimension ? CREATION_GUIDE_DIMENSION_META[dimension] : null;
  const options: CreationGuidePresetOption[] = dimension ? CREATION_GUIDE_PRESETS[dimension] : [];

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-[100] bg-black/75 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-[50%] top-[50%] z-[100] max-h-[min(86vh,720px)] w-[min(94vw,520px)] translate-x-[-50%] translate-y-[-50%] overflow-hidden rounded-[20px] border border-border bg-card p-0 shadow-[0_24px_64px_rgba(0,0,0,0.35)] outline-none backdrop-blur-xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
        >
          {dimension && meta ? (
            <>
              <div className="border-b border-border px-4 py-3.5 sm:px-5">
                <DialogPrimitive.Title className="text-[15px] font-medium tracking-[0.02em] text-foreground">
                  {meta.title}
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="mt-1 text-[12px] leading-[1.55] text-muted-foreground">
                  {meta.description}
                </DialogPrimitive.Description>
              </div>
              <div className="max-h-[min(58vh,480px)] space-y-1.5 overflow-y-auto px-3 py-3 sm:px-4 sm:py-3.5 scrollbar-none">
                {options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className="block w-full rounded-[16px] border border-border bg-muted/20 px-3.5 py-2.5 text-left transition hover:border-primary/25 hover:bg-muted/40"
                    onClick={() => {
                      onPick(dimension, option.value, option.label);
                      onClose();
                    }}
                  >
                    <div className="text-[13px] font-medium text-foreground">{option.label}</div>
                    {option.description ? (
                      <div className="mt-0.5 text-[11px] leading-[1.5] text-muted-foreground">{option.description}</div>
                    ) : null}
                  </button>
                ))}
              </div>
              <div className="border-t border-border px-4 py-2.5 sm:px-5">
                <p className="text-center text-[10.5px] text-muted-foreground/60">也可关闭弹窗后在底部输入框用一句话描述你的选择</p>
              </div>
            </>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

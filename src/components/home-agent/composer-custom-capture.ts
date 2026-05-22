import { isSupportedImageFile } from "@/lib/home-agent/image-style-analysis";
import type {
  ComposerQuestion,
  ComposerQuestionOption,
} from "@/lib/home-agent/types";

type ChildInputConfig = NonNullable<ComposerQuestionOption["childInput"]>;

type ComposerQuestionChoice = {
  value: string;
  label: string;
};

type BaseDescriptor = {
  hiddenOptionIds: string[];
  placeholder: string;
  panelHint: string;
  reminder: string;
};

export type ComposerCustomCaptureDescriptor =
  | (BaseDescriptor & {
      kind: "question-custom";
      inputConfig: ChildInputConfig;
      labelSource: string;
    })
  | (BaseDescriptor & {
      kind: "video-style";
      imageChoice: ComposerQuestionChoice;
    });

export type ComposerCustomCaptureAction = "upload" | "send";

function isVideoStyleAnswerKey(answerKey?: string | null): boolean {
  return (
    answerKey === "video-kickoff-prefs-style" ||
    answerKey === "full-auto-preflight:videoStyle"
  );
}

function isCustomishValue(value: string | undefined): boolean {
  if (!value) return false;
  return /(^|[:_-])custom($|[:_-])/i.test(value);
}

function isCustomishLabel(label: string | undefined): boolean {
  if (!label) return false;
  return /自定义|custom/i.test(label);
}

function isCustomishOption(option: ComposerQuestionOption): boolean {
  return (
    isCustomishLabel(option.label) ||
    isCustomishValue(option.id) ||
    isCustomishValue(option.value) ||
    isCustomishValue(option.childInput?.actionPrefix)
  );
}

function buildCustomInputReminder(inputConfig: ChildInputConfig): string {
  if (inputConfig.type === "number") {
    const rangeParts: string[] = [];
    if (typeof inputConfig.min === "number") {
      rangeParts.push(String(inputConfig.min));
    }
    if (typeof inputConfig.max === "number") {
      rangeParts.push(String(inputConfig.max));
    }
    const range = rangeParts.join(" - ");
    const suffix = inputConfig.suffix?.trim() ?? "";
    return range
      ? `当前这一步需要在底部输入框填写 ${range}${suffix} 的数值后发送。`
      : "当前这一步需要在底部输入框填写数值后发送。";
  }

  const bounds: string[] = [];
  if (typeof inputConfig.minLength === "number") {
    bounds.push(`至少 ${inputConfig.minLength} 个字`);
  }
  if (typeof inputConfig.maxLength === "number") {
    bounds.push(`不超过 ${inputConfig.maxLength} 个字`);
  }
  return bounds.length
    ? `当前这一步需要在底部输入框填写${bounds.join("，")}的自定义内容后发送。`
    : "当前这一步需要在底部输入框填写自定义内容后发送。";
}

function buildQuestionCustomDescriptor(params: {
  inputConfig: ChildInputConfig;
  labelSource: string;
  hiddenOptionIds: string[];
}): Extract<ComposerCustomCaptureDescriptor, { kind: "question-custom" }> {
  const { inputConfig, labelSource, hiddenOptionIds } = params;
  return {
    kind: "question-custom",
    hiddenOptionIds,
    placeholder:
      inputConfig.placeholder ??
      (inputConfig.type === "number"
        ? "输入自定义数值后发送"
        : "输入自定义内容后发送"),
    panelHint:
      inputConfig.type === "number"
        ? "也可在底部输入框直接填写自定义数值后发送。"
        : "也可在底部输入框直接填写自定义内容后发送。",
    reminder: buildCustomInputReminder(inputConfig),
    inputConfig,
    labelSource,
  };
}

function findCustomChildInputDescriptor(
  question: ComposerQuestion,
): ComposerCustomCaptureDescriptor | null {
  for (const option of question.options) {
    if (option.devOnly) continue;

    if (option.childInput && isCustomishOption(option)) {
      return buildQuestionCustomDescriptor({
        inputConfig: option.childInput,
        labelSource: option.label,
        hiddenOptionIds: [option.id],
      });
    }

    const customChild = option.children?.find(
      (child) => !child.devOnly && child.childInput && isCustomishOption(child),
    );
    if (!customChild?.childInput) continue;

    const shouldHideParent =
      isCustomishOption(option) &&
      Boolean(option.children?.length) &&
      option.children.every((child) => isCustomishOption(child));

    return buildQuestionCustomDescriptor({
      inputConfig: customChild.childInput,
      labelSource: customChild.label,
      hiddenOptionIds: [shouldHideParent ? option.id : customChild.id],
    });
  }

  return null;
}

export function getComposerCustomCaptureDescriptor(
  question: ComposerQuestion | null | undefined,
): ComposerCustomCaptureDescriptor | null {
  if (!question) return null;

  if (isVideoStyleAnswerKey(question.answerKey)) {
    return {
      kind: "video-style",
      hiddenOptionIds: question.options
        .filter((option) => isCustomishOption(option))
        .map((option) => option.id),
      placeholder:
        "输入自定义风格说明，或上传参考图后发送；我会直接写入风格或识别参考图。",
      panelHint:
        "也可在底部输入框填写自定义风格说明，或上传参考图后发送。",
      reminder:
        "当前这一步支持直接在底部输入自定义风格说明，或上传参考图后发送。",
      imageChoice: {
        value: "video:kickoff:prefs:style-reference",
        label: "识别已上传参考图",
      },
    };
  }

  return findCustomChildInputDescriptor(question);
}

export function filterComposerQuestionOptions(
  options: ComposerQuestionOption[],
  hiddenOptionIds: string[],
): ComposerQuestionOption[] {
  if (!hiddenOptionIds.length) return options;
  const hiddenIds = new Set(hiddenOptionIds);
  return options.flatMap((option) => {
    if (hiddenIds.has(option.id)) return [];
    return [
      {
        ...option,
        children: option.children
          ? filterComposerQuestionOptions(option.children, hiddenOptionIds)
          : option.children,
      },
    ];
  });
}

function buildCustomInputChoice(
  descriptor: Extract<ComposerCustomCaptureDescriptor, { kind: "question-custom" }>,
  draft: string,
): ComposerQuestionChoice | null {
  const trimmedDraft = draft.trim();
  if (!trimmedDraft) return null;

  if (descriptor.inputConfig.type === "number") {
    const parsed = Number(trimmedDraft);
    const normalized = Number.isFinite(parsed) ? Math.round(parsed) : NaN;
    if (!Number.isFinite(normalized)) return null;
    if (
      (descriptor.inputConfig.min != null &&
        normalized < descriptor.inputConfig.min) ||
      (descriptor.inputConfig.max != null &&
        normalized > descriptor.inputConfig.max)
    ) {
      return null;
    }

    const displayValue = String(normalized);
    const label =
      descriptor.inputConfig.labelTemplate?.replace("{value}", displayValue) ??
      `${descriptor.labelSource} ${displayValue}${descriptor.inputConfig.suffix ?? ""}`;
    return {
      value: `${descriptor.inputConfig.actionPrefix}${displayValue}`,
      label: label.trim(),
    };
  }

  if (
    (descriptor.inputConfig.minLength != null &&
      trimmedDraft.length < descriptor.inputConfig.minLength) ||
    (descriptor.inputConfig.maxLength != null &&
      trimmedDraft.length > descriptor.inputConfig.maxLength)
  ) {
    return null;
  }
  if (
    descriptor.inputConfig.pattern &&
    !new RegExp(descriptor.inputConfig.pattern).test(trimmedDraft)
  ) {
    return null;
  }

  const label =
    descriptor.inputConfig.labelTemplate?.replace("{value}", trimmedDraft) ??
    `${descriptor.labelSource} ${trimmedDraft}${descriptor.inputConfig.suffix ?? ""}`;
  return {
    value: `${descriptor.inputConfig.actionPrefix}${encodeURIComponent(trimmedDraft)}`,
    label: label.trim(),
  };
}

export function resolveComposerCustomCaptureChoice(params: {
  question: ComposerQuestion | null;
  draft: string;
  attachedFiles?: File[];
}): ComposerQuestionChoice | null {
  const descriptor = getComposerCustomCaptureDescriptor(params.question);
  if (!descriptor) return null;

  if (descriptor.kind === "video-style") {
    const trimmedDraft = params.draft.trim();
    if (trimmedDraft) {
      return {
        value: `video:kickoff:prefs:custom-style:${encodeURIComponent(trimmedDraft)}`,
        label: trimmedDraft,
      };
    }

    const imageFiles = (params.attachedFiles ?? []).filter((file) =>
      isSupportedImageFile(file),
    );
    if (!imageFiles.length) return null;
    return descriptor.imageChoice;
  }

  return buildCustomInputChoice(descriptor, params.draft);
}

export function resolveComposerCustomCaptureAction(params: {
  question: ComposerQuestion | null;
  draft: string;
  attachedFiles?: File[];
  isAwaitingWorkflowDocumentUpload?: boolean;
}): ComposerCustomCaptureAction | null {
  const attachedFiles = params.attachedFiles ?? [];
  if (params.isAwaitingWorkflowDocumentUpload) {
    return attachedFiles.length > 0 || params.draft.trim().length > 0 ? "send" : "upload";
  }

  const descriptor = getComposerCustomCaptureDescriptor(params.question);
  if (!descriptor) return null;

  const choice = resolveComposerCustomCaptureChoice({
    question: params.question,
    draft: params.draft,
    attachedFiles,
  });

  if (descriptor.kind === "video-style") {
    return choice ? "send" : "upload";
  }

  return choice ? "send" : null;
}

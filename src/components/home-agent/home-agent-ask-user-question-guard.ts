import type { AskUserQuestionRequest } from "@/lib/agent/tools/ask-user-question";
import { buildAdaptationWorkflowKickoffRequest } from "@/lib/home-agent/adaptation-workflow-kickoff";
import {
  buildOriginalScriptKickoffBlueprintRequests,
  buildOriginalScriptKickoffRequest,
} from "@/lib/home-agent/original-script-kickoff";
import type { ComposerQuestion, StudioRuntimeState } from "@/lib/home-agent/types";
import { buildVideoWorkflowKickoffRequest } from "@/lib/home-agent/video-workflow-kickoff";
import {
  buildEpisodeWorkflowQuestion,
  buildOutlinesWorkflowQuestion,
  buildVideoContinuationQuestion,
  recQuestion,
} from "./home-agent-project-questions";

type FlatWorkflowOption = {
  key: string;
  label: string;
  value: string;
  description?: string;
  rationale?: string;
};

type WorkflowQuestionCandidate = {
  question: ComposerQuestion;
  score: number;
};

function normalizeWorkflowText(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function collectRequestText(request: AskUserQuestionRequest): string {
  return [
    request.title,
    request.description,
    ...request.questions.flatMap((question) => [
      question.header,
      question.question,
      ...question.options.flatMap((option) => [
        option.label,
        option.value,
        option.description,
        option.rationale,
      ]),
    ]),
  ]
    .filter(Boolean)
    .join("\n");
}

function cloneRequestWithId(
  request: AskUserQuestionRequest,
  requestId: string,
): AskUserQuestionRequest {
  return {
    ...request,
    id: requestId,
    questions: request.questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({ ...option })),
    })),
  };
}

function cloneRequestPreservingId(request: AskUserQuestionRequest): AskUserQuestionRequest {
  return cloneRequestWithId(request, request.id);
}

function scoreAskUserCandidate(
  request: AskUserQuestionRequest,
  candidate: AskUserQuestionRequest,
): number {
  const requestTokens = new Set(
    collectRequestText(request)
      .split(/\s+/)
      .map((token) => normalizeWorkflowText(token))
      .filter(Boolean),
  );
  if (!requestTokens.size) return 0;

  const candidateOptions = candidate.questions.flatMap((question) => question.options);
  const requestOptions = request.questions.flatMap((question) => question.options);
  let score = 0;

  for (const option of candidateOptions) {
    const labelKey = normalizeWorkflowText(option.label);
    const valueKey = normalizeWorkflowText(option.value);
    if (labelKey && requestTokens.has(labelKey)) score += 3;
    if (valueKey && requestTokens.has(valueKey)) score += 2;
  }

  for (const option of requestOptions) {
    const labelKey = normalizeWorkflowText(option.label);
    const valueKey = normalizeWorkflowText(option.value);
    const matched = candidateOptions.some((candidateOption) => {
      const candidateLabelKey = normalizeWorkflowText(candidateOption.label);
      const candidateValueKey = normalizeWorkflowText(candidateOption.value);
      return (
        (labelKey && (labelKey === candidateLabelKey || labelKey === candidateValueKey)) ||
        (valueKey && (valueKey === candidateLabelKey || valueKey === candidateValueKey))
      );
    });
    if (matched) score += 4;
  }

  const candidateQuestionTokens = [
    candidate.title,
    candidate.description,
    ...candidate.questions.map((question) => question.question),
  ]
    .filter(Boolean)
    .map((token) => normalizeWorkflowText(token));
  for (const token of candidateQuestionTokens) {
    if (token && requestTokens.has(token)) {
      score += 2;
    }
  }

  return score;
}

function detectKickoffWorkflowFamily(
  request: AskUserQuestionRequest,
): "video" | "adaptation" | "script" | null {
  const normalized = normalizeWorkflowText(collectRequestText(request));
  if (!normalized) return null;

  if (
    /(视频|videoworkflow|视频工作流|剧本来源|上传剧本|usecurrentproject|uploaddocument|startfresh)/u.test(
      normalized,
    )
  ) {
    return "video";
  }

  if (
    /(改编|adaptation|参考剧本|参考文本|startdialog)/u.test(normalized)
  ) {
    return "adaptation";
  }

  if (
    /(原创|script|创作方式|目标市场|题材|创意输入|setupmode|targetmarket|genres)/u.test(
      normalized,
    )
  ) {
    return "script";
  }

  return null;
}

function flattenWorkflowQuestionOptions(
  options: ComposerQuestion["options"],
  target: FlatWorkflowOption[],
): void {
  for (const option of options) {
    target.push({
      key: normalizeWorkflowText(option.value || option.label),
      label: option.label,
      value: option.value,
      description: option.childInput?.placeholder,
      rationale: option.rationale,
    });
    if (option.children?.length) {
      flattenWorkflowQuestionOptions(option.children, target);
    }
  }
}

function listWorkflowOwnedQuestions(runtime: StudioRuntimeState): ComposerQuestion[] {
  const snapshot = runtime.currentProjectSnapshot;
  if (!snapshot) return [];

  const candidates = [
    recQuestion(snapshot, runtime.currentVideoProject),
    snapshot.projectKind !== "video" ? buildOutlinesWorkflowQuestion(snapshot) : null,
    snapshot.projectKind !== "video" ? buildEpisodeWorkflowQuestion(snapshot) : null,
    snapshot.projectKind === "video"
      ? buildVideoContinuationQuestion(snapshot, runtime.currentVideoProject)
      : null,
  ].filter((question): question is ComposerQuestion => Boolean(question));

  const seen = new Set<string>();
  return candidates.filter((question) => {
    if (seen.has(question.id)) return false;
    seen.add(question.id);
    return true;
  });
}

function scoreWorkflowQuestionCandidate(
  request: AskUserQuestionRequest,
  candidate: ComposerQuestion,
): number {
  const requestTokens = new Set(
    collectRequestText(request)
      .split(/\s+/)
      .map((token) => normalizeWorkflowText(token))
      .filter(Boolean),
  );
  if (!requestTokens.size) return 0;

  const candidateOptions: FlatWorkflowOption[] = [];
  flattenWorkflowQuestionOptions(candidate.options, candidateOptions);
  let score = 0;

  for (const option of candidateOptions) {
    if (option.key && requestTokens.has(option.key)) score += 3;
    const labelKey = normalizeWorkflowText(option.label);
    const valueKey = normalizeWorkflowText(option.value);
    if (labelKey && requestTokens.has(labelKey)) score += 3;
    if (valueKey && requestTokens.has(valueKey)) score += 2;
  }

  for (const option of request.questions.flatMap((question) => question.options)) {
    const labelKey = normalizeWorkflowText(option.label);
    const valueKey = normalizeWorkflowText(option.value);
    const matched = candidateOptions.some((candidateOption) =>
      Boolean(
        (labelKey &&
          (labelKey === normalizeWorkflowText(candidateOption.label) ||
            labelKey === normalizeWorkflowText(candidateOption.value) ||
            labelKey === candidateOption.key)) ||
          (valueKey &&
            (valueKey === normalizeWorkflowText(candidateOption.label) ||
              valueKey === normalizeWorkflowText(candidateOption.value) ||
              valueKey === candidateOption.key)),
      ),
    );
    if (matched) score += 4;
  }

  const candidateTextKeys = [
    candidate.answerKey,
    candidate.title,
    candidate.description,
  ]
    .filter(Boolean)
    .map((token) => normalizeWorkflowText(token));
  for (const token of candidateTextKeys) {
    if (token && requestTokens.has(token)) {
      score += 2;
    }
  }

  return score;
}

function buildWorkflowQuestionRequest(
  question: ComposerQuestion,
  request: AskUserQuestionRequest,
): AskUserQuestionRequest {
  const allowedOptions: FlatWorkflowOption[] = [];
  flattenWorkflowQuestionOptions(question.options, allowedOptions);

  const fallbackQuestion = request.questions[0];
  return {
    id: request.id,
    title: question.title,
    description: question.description,
    allowCustomInput: question.allowCustomInput,
    submissionMode: question.submissionMode,
    questions: [
      {
        header:
          fallbackQuestion?.header?.trim() ||
          question.answerKey?.slice(0, 12) ||
          question.title.slice(0, 12),
        question: question.title,
        multiSelect: question.multiSelect,
        options: allowedOptions.slice(0, Math.min(12, allowedOptions.length)).map((option) => ({
          label: option.label,
          value: option.value,
          description: option.description,
          rationale: option.rationale,
        })),
      },
    ],
  };
}

export function resolveWorkflowBoundComposerQuestion(
  request: AskUserQuestionRequest,
  runtime: StudioRuntimeState,
): ComposerQuestion | null {
  const workflowQuestions = listWorkflowOwnedQuestions(runtime);
  if (!workflowQuestions.length) return null;

  const rankedCandidates = workflowQuestions
    .map<WorkflowQuestionCandidate>((question) => ({
      question,
      score: scoreWorkflowQuestionCandidate(request, question),
    }))
    .sort((left, right) => right.score - left.score);

  if ((rankedCandidates[0]?.score ?? 0) > 0) {
    return rankedCandidates[0]?.question ?? null;
  }

  return workflowQuestions[0] ?? null;
}

function normalizeKickoffRequest(
  request: AskUserQuestionRequest,
  runtime: StudioRuntimeState,
): AskUserQuestionRequest {
  const family = detectKickoffWorkflowFamily(request);

  if (family === "video") {
    return cloneRequestPreservingId(
      buildVideoWorkflowKickoffRequest(false),
    );
  }

  if (family === "adaptation") {
    return cloneRequestPreservingId(buildAdaptationWorkflowKickoffRequest());
  }

  const originalScriptCandidates = buildOriginalScriptKickoffBlueprintRequests();
  if (family === "script") {
    const bestMatch =
      originalScriptCandidates.reduce<AskUserQuestionRequest | null>((best, candidate) => {
        if (!best) return candidate;
        return scoreAskUserCandidate(request, candidate) > scoreAskUserCandidate(request, best)
          ? candidate
          : best;
      }, null) ?? buildOriginalScriptKickoffRequest();
    return cloneRequestPreservingId(bestMatch);
  }

  const allCandidates = [
    ...originalScriptCandidates,
    buildVideoWorkflowKickoffRequest(false),
    buildAdaptationWorkflowKickoffRequest(),
  ];
  const ranked = allCandidates
    .map((candidate) => ({ candidate, score: scoreAskUserCandidate(request, candidate) }))
    .sort((left, right) => right.score - left.score);

  if ((ranked[0]?.score ?? 0) <= 0) {
    return request;
  }

  return cloneRequestPreservingId(ranked[0].candidate);
}

export function normalizeWorkflowBoundAskUserQuestionRequest(
  request: AskUserQuestionRequest,
  runtime: StudioRuntimeState,
): AskUserQuestionRequest {
  const snapshot = runtime.currentProjectSnapshot;
  if (snapshot) {
    const workflowQuestion = resolveWorkflowBoundComposerQuestion(request, runtime);
    return workflowQuestion ? buildWorkflowQuestionRequest(workflowQuestion, request) : request;
  }
  return normalizeKickoffRequest(request, runtime);
}

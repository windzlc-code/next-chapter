import type { Task } from "@/lib/agent/tools/task-tools";

export function summarizeBridgeResearchValue(output: string): string {
  const normalized = output
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/^[-*•\d.\s]+/, "").trim())
    .find(Boolean);

  if (!normalized) return "";

  const matched =
    normalized.match(/(?:目标平台|发布平台|平台|镜头风格|风格|视觉方向|出片目标|产出目标|目标)[:：]\s*(.+)$/) ??
    normalized.match(/^建议[:：]\s*(.+)$/);

  return matched?.[1]?.trim() ?? normalized;
}

export function buildVideoBridgeResearchInput(params: {
  tasks: Array<Pick<Task, "prompt" | "output">>;
  parseTaskHeading: (prompt: string) => string | null;
}): {
  targetPlatform: string;
  shotStyle: string;
  outputGoal: string;
  productionNotes: string;
} {
  const { tasks, parseTaskHeading } = params;
  let targetPlatform = "";
  let shotStyle = "";
  let outputGoal = "";

  const notes = tasks
    .map((task) => {
      const heading = parseTaskHeading(task.prompt) || "研究结论";
      const output = (task.output ?? "").trim();
      if (!output) return null;

      if (!targetPlatform && /平台/.test(heading)) {
        targetPlatform = summarizeBridgeResearchValue(output);
      } else if (!shotStyle && /(视觉|风格|镜头)/.test(heading)) {
        shotStyle = summarizeBridgeResearchValue(output);
      } else if (!outputGoal && /(出片|策略|目标)/.test(heading)) {
        outputGoal = summarizeBridgeResearchValue(output);
      }

      return `【${heading}】\n${output}`;
    })
    .filter((value): value is string => Boolean(value));

  return {
    targetPlatform,
    shotStyle,
    outputGoal,
    productionNotes: notes.join("\n\n"),
  };
}

export function buildVideoBridgeResearchMessage(params: {
  targetPlatform: string;
  shotStyle: string;
  outputGoal: string;
  productionNotes: string;
}): string {
  const detailLines = [
    params.targetPlatform ? `目标平台：${params.targetPlatform}` : null,
    params.shotStyle ? `镜头风格：${params.shotStyle}` : null,
    params.outputGoal ? `出片目标：${params.outputGoal}` : null,
  ].filter(Boolean);

  if (detailLines.length) {
    return `平台与镜头偏好已写入：${detailLines.join("；")}。进入视频工作流。`;
  }

  return params.productionNotes.trim()
    ? "前置参数已写入，进入视频工作流。"
    : "进入视频工作流。";
}

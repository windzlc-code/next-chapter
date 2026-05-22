import { describe, expect, it } from "vitest";
import { buildAutoResearchPlan } from "./auto-research";

const scriptSnapshot = {
  projectId: "script-project-1",
  projectKind: "script" as const,
  title: "测试剧本",
  currentObjective: "继续梳理创作方向",
  derivedStage: "原创剧本立项",
  agentSummary: "等待补充创作偏好",
  recommendedActions: [],
  artifacts: [],
};

describe("buildAutoResearchPlan", () => {
  it("keeps natural-language option guidance in the normal chat lane", () => {
    expect(
      buildAutoResearchPlan(
        "先别急着让我点选，先用自然语言比较一下这两种开始方式各自适合什么情况。",
        null,
      ),
    ).toBeNull();
  });

  it("keeps homepage kickoff guidance prompts out of auto research", () => {
    expect(
      buildAutoResearchPlan(
        "我想开启一个原创剧本项目。请先分析我的目标，再一步一步追问目标市场、风格类型、受众和创作方向，最终带我完成创作。",
        null,
      ),
    ).toBeNull();
  });

  it("still launches when the user explicitly asks for background research directions", () => {
    const plan = buildAutoResearchPlan(
      "请先并行研究 3 个方向：目标市场、风格路线、卖点结构。",
      scriptSnapshot,
    );

    expect(plan?.reason).toBe("script-research");
    expect(plan?.tasks.map((task) => task.title)).toEqual([
      "目标市场",
      "风格路线",
      "卖点结构",
    ]);
  });
});

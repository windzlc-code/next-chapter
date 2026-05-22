import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeFunction = vi.hoisted(() => vi.fn());

vi.mock("@/lib/invoke-with-key", () => ({
  invokeFunction,
}));

import {
  buildVideoWorkflowKickoffRequest,
  buildVideoWorkflowStartPrompt,
  buildVideoUploadExtractionSummary,
  countEpisodes,
  extractVideoWorkflowUploadScript,
  hasEpisodeScriptBody,
  recognizeVideoWorkflowUploadScript,
  trimToLikelyEpisodeScriptBody,
} from "./video-workflow-kickoff";

describe("extractVideoWorkflowUploadScript", () => {
  beforeEach(() => {
    invokeFunction.mockReset();
  });

  it("extracts a normalized script and title from a single uploaded document", () => {
    const payload = extractVideoWorkflowUploadScript([
      {
        fileName: "contract-marriage.docx",
        kind: "document",
        extractedText: "  第一场：雨夜重逢。  ",
      },
    ]);

    expect(payload).toEqual({
      script: "第一场：雨夜重逢。",
      title: "contract-marriage",
      fileNames: ["contract-marriage.docx"],
    });
  });

  it("merges multiple extracted files into one workflow script with file labels", () => {
    const payload = extractVideoWorkflowUploadScript([
      {
        fileName: "episode-01.txt",
        kind: "text",
        extractedText: "第一幕",
      },
      {
        fileName: "moodboard.png",
        kind: "image",
        extractedText: "should be ignored",
      },
      {
        fileName: "episode-02.pdf",
        kind: "document",
        extractedText: "第二幕",
      },
    ]);

    expect(payload).toEqual({
      script: "【episode-01.txt】\n第一幕\n\n【episode-02.pdf】\n第二幕",
      title: "episode-01",
      fileNames: ["episode-01.txt", "episode-02.pdf"],
    });
  });

  it("returns null when no usable extracted script text is available", () => {
    expect(
      extractVideoWorkflowUploadScript([
        {
          fileName: "shot-list.xlsx",
          kind: "document",
          extractedText: "   ",
        },
        {
          fileName: "moodboard.png",
          kind: "image",
          extractedText: "角色站位",
        },
      ]),
    ).toBeNull();
  });

  it("recognizes uploaded episode script bodies", () => {
    expect(
      hasEpisodeScriptBody(
        [
          "第1集：雨夜重逢",
          "1-1 夜 外 街道",
          "林晓晓：你终于来了。",
          "旁白：雨越下越大。",
        ].join("\n"),
      ),
    ).toBe(true);
  });

  it("rejects creative-plan style uploads without episode bodies", () => {
    expect(
      hasEpisodeScriptBody(
        [
          "创意方案",
          "题材：都市情感",
          "核心看点：契约婚姻反转为双向救赎。",
        ].join("\n"),
      ),
    ).toBe(false);
    expect(
      hasEpisodeScriptBody(
        [
          "第1集：签下契约——女主被迫结婚。",
          "第2集：关系升级——两人继续试探。",
        ].join("\n"),
      ),
    ).toBe(false);
  });

  it("trims creative-plan notes and keeps only the real episode body", async () => {
    invokeFunction.mockResolvedValue({
      data: {
        script: "不应使用这个短摘要",
        title: "错误标题",
        summary: "不应显示这个摘要。",
      },
      error: null,
    });

    const raw = [
      "创作方案",
      "总集数：40",
      "已完成：1 集",
      "第2集：第一次冲突场景",
      "第28集：身份揭露场景",
      "第32集：感情转折场景",
      "第39集：终极对决场景",
      "第1集：命运序章",
      "字数：1,072",
      "第1集",
      "1-1 夜 内 医院走廊",
      "林晓晓：我只是来履行契约。",
      "1-2 夜 内 陆家老宅大厅",
      "陆寒沉：从今晚开始，你就是陆太太。",
    ].join("\n");

    const payload = await recognizeVideoWorkflowUploadScript({
      script: raw,
      title: "烟火人间不及你",
      fileNames: ["烟火人间不及你.docx"],
    });

    expect(payload.script).toBe(trimToLikelyEpisodeScriptBody(raw));
    expect(payload.script).toContain("1-1 夜 内 医院走廊");
    expect(payload.script).toContain("1-2 夜 内 陆家老宅大厅");
    expect(payload.script).not.toContain("第28集");
    expect(countEpisodes(payload.script)).toBe(1);
    expect(hasEpisodeScriptBody(payload.script)).toBe(true);
    expect(invokeFunction).not.toHaveBeenCalled();
  });

  it("trims another screenplay format with multiple first-episode scenes", () => {
    const raw = [
      "女频、甜宠、美食治愈、职场逆袭",
      "第15集：好感初生",
      "第22集：男主掉马",
      "1-10集",
      "11-30集",
      "第1集：命运交汇",
      "1-1 日 内 咖啡厅",
      "夏初一：（小声）这杯咖啡多少钱？",
      "1-2 日 内 咖啡厅另一角",
      "陆寒霆：（抬眸）我请。",
      "1-3 日 内 咖啡厅走廊",
      "夏初一撞见前男友。",
    ].join("\n");

    const trimmed = trimToLikelyEpisodeScriptBody(raw);

    expect(trimmed).toContain("1-1 日 内 咖啡厅");
    expect(trimmed).toContain("1-3 日 内 咖啡厅走廊");
    expect(trimmed).not.toContain("第22集");
    expect(countEpisodes(trimmed)).toBe(1);
    expect(hasEpisodeScriptBody(trimmed)).toBe(true);
  });

  it("rejects truncated creative-plan text that has episode labels but no scene body", () => {
    const truncated = [
      "创作方案",
      "总集数：60",
      "第15集：好感初生",
      "第22集：男主掉马",
      "第35集：感情升温",
      "1-10集",
      "11-30集",
      "第45集：危机共担",
    ].join("\n");

    expect(hasEpisodeScriptBody(truncated)).toBe(false);
  });
});

describe("countEpisodes", () => {
  it("counts episode headers in a standard script", () => {
    const script = [
      "第1集：雨夜重逢",
      "1-1 夜 外 街道",
      "林晓晓：你终于来了。",
      "第2集：契约签订",
      "2-1 日 内 办公室",
      "旁白：命运的齿轮开始转动。",
    ].join("\n");
    expect(countEpisodes(script)).toBe(2);
  });

  it("counts EP-style headers", () => {
    const script = "EP01：开篇\n内容\nEP02：转折\n内容\nEP03：高潮\n内容";
    expect(countEpisodes(script)).toBe(3);
  });

  it("returns 0 for scripts without episode headers", () => {
    expect(countEpisodes("这是一段没有集数标题的文本。")).toBe(0);
    expect(countEpisodes("")).toBe(0);
  });
});

describe("buildVideoUploadExtractionSummary", () => {
  it("includes title, episode count, and char count for a single file", () => {
    const script = [
      "第1集：雨夜重逢",
      "△林晓晓背靠着冰冷的白墙，手里死死攥着一张五十万的欠费催收单。",
      "第2集：契约签订",
      "△命运的齿轮开始转动，林晓晓抬起头，清冷的月光照在她苍白绝美的脸上。",
    ].join("\n");

    const summary = buildVideoUploadExtractionSummary({
      script,
      title: "烟火人间不及你",
      fileNames: ["烟火人间不及你.docx"],
    });

    expect(summary).toContain("《烟火人间不及你》");
    expect(summary).toContain("识别到 2 集");
    expect(summary).toContain("正在进入视频工作流");
  });

  it("falls back to filename when title is absent", () => {
    const summary = buildVideoUploadExtractionSummary({
      script: "第1集：开篇\n内容内容内容",
      fileNames: ["contract-marriage.docx"],
    });
    expect(summary).toContain("《contract-marriage》");
  });

  it("uses file count label for multiple files", () => {
    const summary = buildVideoUploadExtractionSummary({
      script: "第1集：开篇\n内容",
      fileNames: ["ep01.txt", "ep02.txt", "ep03.txt"],
    });
    expect(summary).toContain("3 个文件");
  });

  it("omits episode count when none are detected", () => {
    const summary = buildVideoUploadExtractionSummary({
      script: "这是一段没有集数标题的文本内容。",
      title: "测试",
      fileNames: ["test.txt"],
    });
    expect(summary).not.toContain("识别到");
    expect(summary).toContain("正在进入视频工作流");
  });
});

describe("buildVideoWorkflowStartPrompt", () => {
  it("offers only document upload kickoff when there is no current script project", () => {
    const request = buildVideoWorkflowKickoffRequest(false);

    expect(request.questions[0]?.options.map((option) => option.value)).toEqual([
      "upload-document",
    ]);
  });

  it("requires zero-based guidance before entering the workflow for fresh starts", () => {
    const prompt = buildVideoWorkflowStartPrompt("start-fresh");

    expect(prompt).toContain("请从零开始引导");
    expect(prompt).toContain("不要默认我已经准备好剧本、素材或熟悉流程");
    expect(prompt).toContain("当前进入了哪个工作流步骤");
  });
});

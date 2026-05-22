import { beforeEach, describe, expect, it, vi } from "vitest";

import * as geminiClient from "./gemini-client";
import { saveApiConfig } from "./api-config";
import { writeStoredHomeAgentTextModelKey } from "./home-agent/text-models";
import {
  __setInvokeWithKeyMediaSubmissionGuardDelayForTests,
  buildDecomposeExecutionPlan,
  buildIncompleteDecomposeError,
  formatDetailedSegmentPrompt,
  invokeFunction,
  normalizeDecomposeScenes,
  normalizeEpisodeSegmentLabel,
  resolveDecomposeParallelism,
  resolveDecomposeRetryDelayMs,
  validateDecomposeSceneCounts,
} from "./invoke-with-key";

describe("invoke-with-key video transport", () => {
  beforeEach(() => {
    __setInvokeWithKeyMediaSubmissionGuardDelayForTests(null);
    localStorage.clear();
    window.electronAPI = {
      runtime: {
        builtinApiBundle: null,
        builtinApiBundlePath: "",
        verifyBuiltinApiAdminPassword: async () => true,
      },
    } as typeof window.electronAPI;

    saveApiConfig({
      jimengEndpoint: "https://api.tu-zi.com/v1beta",
      jimengKey: "test-jimeng-key",
      jimengExecutionMode: "api",
      geminiEndpoint: "https://api.tu-zi.com/v1beta",
      geminiKey: "test-gemini-key",
    });
  });

  function buildDetailedSegmentPrompt(seed = "当前片段"): string {
    return [
      "全局风格：电影感，15秒，压迫感明确。",
      `视觉锚点：${seed}的角色、场景与光线保持一致。`,
      "起始衔接：从上一镜头停点直接接入当前片段。",
      "衔接原则：严格按已拆分镜头顺序推进。",
      "镜头推进：",
      `分镜1（0-5秒）：${seed}从开场动作直接切入。`,
      `分镜2（5-10秒）：${seed}延续动作并推进焦点变化。`,
      `分镜3（10-15秒）：${seed}落到收尾动作并保留下一拍悬念。`,
      `环境细节：${seed}的空间、光线与环境动态连续清晰。`,
      "结尾钩子：最后一镜停在动作未收尽的瞬间。",
      "通用后缀：无字幕、无水印、无屏幕文字",
    ].join("\n");
  }

  it("waits inside the backend video submit path before sending the real generate-video request", async () => {
    vi.useFakeTimers();
    __setInvokeWithKeyMediaSubmissionGuardDelayForTests(3000);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "video-task-guarded",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const pending = invokeFunction("generate-video", {
      prompt: "guarded backend video prompt",
      duration: 4,
      aspectRatio: "16:9",
      resolution: "1080p",
      model: "doubao-seedance-1-5-pro_1080p",
      provider: "jimeng",
    });

    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("waits inside the backend image submit path and does not print the full image prompt", async () => {
    vi.useFakeTimers();
    __setInvokeWithKeyMediaSubmissionGuardDelayForTests(3000);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ b64_json: "U0NFTkU=", mime_type: "image/png" }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const prompt =
      'Create a detailed, high-quality background/environment concept art for a scene called "意念空间".';
    const pending = invokeFunction("generate-scene", {
      name: "意念空间",
      description: "一片纯白且虚无的广阔空间",
      style: "live-action",
      model: "gpt-image-2",
    });

    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();

    const logLines = consoleLogSpy.mock.calls.map((call) => call.map(String).join(" "));
    expect(logLines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[image] pending submit"),
        expect.stringContaining("已进入 3 秒防误触保护"),
      ]),
    );
    expect(logLines.some((line) => line.includes(prompt))).toBe(false);

    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(
      consoleLogSpy.mock.calls.some((call) =>
        call.map(String).join(" ").includes("防误触保护已结束，开始提交生图请求"),
      ),
    ).toBe(true);

    consoleLogSpy.mockRestore();
    vi.useRealTimers();
  });

  it("really waits about 3 seconds before sending the backend image submit", async () => {
    vi.useRealTimers();
    __setInvokeWithKeyMediaSubmissionGuardDelayForTests(3000);

    const events: Array<{ label: string; at: number; line: string }> = [];
    let fetchAt: number | null = null;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      fetchAt = Date.now();
      events.push({
        label: "fetch",
        at: fetchAt,
        line: "[fetch] /v1/images/generations",
      });
      return new Response(
        JSON.stringify({
          data: [{ b64_json: "U0NFTkU=", mime_type: "image/png" }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      const line = args.map(String).join(" ");
      if (
        line.includes("[image] pending submit")
        || line.includes("3 秒防误触保护")
        || line.includes("开始提交生图请求")
      ) {
        events.push({ label: "log", at: Date.now(), line });
      }
    });
    const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation((...args) => {
      const line = args.map(String).join(" ");
      if (line.includes("[image-generation] submitting /v1/images/generations")) {
        events.push({ label: "upstream", at: Date.now(), line });
      }
    });

    try {
      const startedAt = Date.now();
      const result = await invokeFunction("generate-scene", {
        name: "Delay Test Scene",
        description: "A bright empty studio hall with a single spotlight.",
        style: "live-action",
        model: "gpt-image-2",
      });

      expect(result.error).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchAt).not.toBeNull();
      expect(fetchAt! - startedAt).toBeGreaterThanOrEqual(2900);

      const timeline = events.map((event) => event.line);
      const pendingIndex = timeline.findIndex((line) => line.includes("[image] pending submit"));
      const guardIndex = timeline.findIndex((line) => line.includes("3 秒防误触保护"));
      const releaseIndex = timeline.findIndex((line) => line.includes("开始提交生图请求"));
      const upstreamIndex = timeline.findIndex((line) =>
        line.includes("[image-generation] submitting /v1/images/generations"),
      );
      const fetchIndex = timeline.findIndex((line) => line.includes("[fetch] /v1/images/generations"));

      expect(pendingIndex).toBeGreaterThanOrEqual(0);
      expect(guardIndex).toBeGreaterThan(pendingIndex);
      expect(releaseIndex).toBeGreaterThan(guardIndex);
      expect(upstreamIndex).toBeGreaterThan(releaseIndex);
      expect(fetchIndex).toBeGreaterThan(upstreamIndex);
      expect(timeline.some((line) => line.includes("[image] prompt begin"))).toBe(false);
    } finally {
      consoleInfoSpy.mockRestore();
      consoleLogSpy.mockRestore();
      fetchSpy.mockRestore();
      __setInvokeWithKeyMediaSubmissionGuardDelayForTests(null);
      vi.useRealTimers();
    }
  }, 15000);

  it("dedupes extracted characters and scenes before returning the raw extraction output", async () => {
    const originalAbortTimeout = (AbortSignal as typeof AbortSignal & { timeout?: typeof AbortSignal.timeout }).timeout;
    (AbortSignal as typeof AbortSignal & { timeout?: (ms: number) => AbortSignal }).timeout = () =>
      new AbortController().signal;
    const geminiSpy = vi.spyOn(geminiClient, "callGemini").mockResolvedValue({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              characters: [
                {
                  name: "苏浅浅",
                  description: "Updated lead description",
                  costumes: [
                    { label: "婚纱", description: "白色婚纱" },
                    { label: "常态", description: "默认形象" },
                  ],
                },
                {
                  name: "苏浅浅",
                  description: "Updated lead description with pearl veil",
                  costumes: [
                    { label: "廉价婚纱", description: "带珍珠头纱的完整婚纱版本" },
                    { label: "初始状态", description: "不应作为变体保留" },
                  ],
                },
              ],
              sceneSettings: [
                {
                  name: "苏家客厅",
                  description: "Updated living room description",
                  timeVariants: [
                    { label: "雨夜", description: "夜间落雨的客厅" },
                    { label: "日常", description: "默认客厅状态" },
                  ],
                },
                {
                  name: "苏家客厅",
                  description: "Updated living room description with shattered window",
                  timeVariants: [
                    { label: "雷雨夜", description: "窗外电闪雷鸣，碎玻璃反光" },
                  ],
                },
              ],
              characterNameList: ["苏浅浅"],
            }),
          }],
        },
      }],
    } as any);

    try {
      const result = await invokeFunction("extract-characters-scenes", {
        script: "苏浅浅走进苏家客厅。",
        model: "gemini-2.0-flash",
      });

      expect(result.error).toBeNull();
      expect(result.data).toEqual({
        characters: [
          {
            name: "苏浅浅",
            description: "Updated lead description with pearl veil",
            costumes: [
              { label: "婚纱", description: "带珍珠头纱的完整婚纱版本" },
            ],
          },
        ],
        sceneSettings: [
          {
            name: "苏家客厅",
            description: "Updated living room description with shattered window",
            timeVariants: [
              { label: "雨夜", description: "窗外电闪雷鸣，碎玻璃反光" },
            ],
          },
        ],
      });
    } finally {
      if (originalAbortTimeout) {
        (AbortSignal as typeof AbortSignal & { timeout?: typeof AbortSignal.timeout }).timeout = originalAbortTimeout;
      } else {
        delete (AbortSignal as typeof AbortSignal & { timeout?: typeof AbortSignal.timeout }).timeout;
      }
      geminiSpy.mockRestore();
    }
  });

  it("filters weakly distinct extracted variants before they enter the workflow", async () => {
    const originalAbortTimeout = (AbortSignal as typeof AbortSignal & { timeout?: typeof AbortSignal.timeout }).timeout;
    (AbortSignal as typeof AbortSignal & { timeout?: (ms: number) => AbortSignal }).timeout = () =>
      new AbortController().signal;
    const geminiSpy = vi.spyOn(geminiClient, "callGemini")
      .mockResolvedValueOnce({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                characters: [
                  {
                    name: "林霄",
                    description: "黑色长风衣、短发、冷峻面部锚点",
                    costumes: [
                      { label: "夜行黑衣", description: "仍是黑色长风衣，只是光线更冷，整体造型几乎不变" },
                      { label: "染血战损版", description: "胸口和袖口被鲜血浸透，左肩撕裂，风衣下摆破损" },
                    ],
                  },
                ],
                sceneSettings: [
                  {
                    name: "旧仓库",
                    description: "冷色工业仓库，白天自然光，铁架与反光水泥地",
                    timeVariants: [
                      { label: "阴天版", description: "仍是白天仓库，只是天光略阴，整体空间与地面状态几乎不变" },
                      { label: "雷雨夜", description: "外部闪电照亮入口，地面积水反射冷蓝色光，仓库断续停电" },
                    ],
                  },
                ],
              }),
            }],
          },
        }],
      } as any)
      .mockResolvedValueOnce({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                characters: [
                  { name: "林霄", keepCostumeLabels: ["染血战损版"] },
                ],
                sceneSettings: [
                  { name: "旧仓库", keepTimeVariantLabels: ["雷雨夜"] },
                ],
              }),
            }],
          },
        }],
      } as any);

    try {
      const result = await invokeFunction("extract-characters-scenes", {
        script: "林霄走进旧仓库，身上带伤。夜里暴雨砸在卷帘门上，闪电照亮积水。",
        model: "gemini-2.0-flash",
      });

      expect(result.error).toBeNull();
      expect(result.data).toEqual({
        characters: [
          {
            name: "林霄",
            description: "黑色长风衣、短发、冷峻面部锚点",
            costumes: [
              { label: "染血战损版", description: "胸口和袖口被鲜血浸透，左肩撕裂，风衣下摆破损" },
            ],
          },
        ],
        sceneSettings: [
          {
            name: "旧仓库",
            description: "冷色工业仓库，白天自然光，铁架与反光水泥地",
            timeVariants: [
              { label: "雷雨夜", description: "外部闪电照亮入口，地面积水反射冷蓝色光，仓库断续停电" },
            ],
          },
        ],
      });

      const qaPromptText = String(
        (geminiSpy.mock.calls[1]?.[1] as Array<{ parts?: Array<{ text?: string }> }> | undefined)?.[0]?.parts?.[0]
          ?.text || "",
      );
      expect(qaPromptText).toContain("looks almost the same as the base/main image");
      expect(qaPromptText).toContain("Strong variants can continue to downstream image QA later");
    } finally {
      if (originalAbortTimeout) {
        (AbortSignal as typeof AbortSignal & { timeout?: typeof AbortSignal.timeout }).timeout = originalAbortTimeout;
      } else {
        delete (AbortSignal as typeof AbortSignal & { timeout?: typeof AbortSignal.timeout }).timeout;
      }
      geminiSpy.mockRestore();
    }
  });

  it("filters narration-only entities and tells extraction to use written body content only", async () => {
    const originalAbortTimeout = (AbortSignal as typeof AbortSignal & { timeout?: typeof AbortSignal.timeout }).timeout;
    (AbortSignal as typeof AbortSignal & { timeout?: (ms: number) => AbortSignal }).timeout = () =>
      new AbortController().signal;
    const geminiSpy = vi.spyOn(geminiClient, "callGemini").mockResolvedValue({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              characters: [
                { name: "旁白", description: "不应被识别为角色" },
                { name: "林霄", description: "已经正式出场的主角" },
              ],
              sceneSettings: [
                { name: "天台", description: "正文里已经写出的天台场景" },
              ],
              characterNameList: ["旁白", "林霄"],
            }),
          }],
        },
      }],
    } as any);

    try {
      const result = await invokeFunction("extract-characters-scenes", {
        script: "旁白：林霄站在天台边缘。\n林霄抬头看向远处的城市灯海。",
        model: "gemini-2.0-flash",
      });

      expect(result.error).toBeNull();
      expect(result.data).toEqual({
        characters: [
          {
            name: "林霄",
            description: "已经正式出场的主角",
          },
        ],
        sceneSettings: [
          {
            name: "天台",
            description: "正文里已经写出的天台场景",
          },
        ],
      });

      const promptText = String(
        (geminiSpy.mock.calls[0]?.[1] as Array<{ parts?: Array<{ text?: string }> }> | undefined)?.[0]?.parts?.[0]
          ?.text || "",
      );
      expect(promptText).toContain("只根据**已经写出的剧本正文内容**提取角色与场景");
      expect(promptText).toContain("“旁白”“画外音”“解说”“VO”“OS”等只是语言层标记");
      expect(promptText).toContain("不要提取为当前角色与场景资产");
    } finally {
      if (originalAbortTimeout) {
        (AbortSignal as typeof AbortSignal & { timeout?: typeof AbortSignal.timeout }).timeout = originalAbortTimeout;
      } else {
        delete (AbortSignal as typeof AbortSignal & { timeout?: typeof AbortSignal.timeout }).timeout;
      }
      geminiSpy.mockRestore();
    }
  });

  it("uses the pure text-to-video prompt strategy when no reference visuals are attached", async () => {
    const geminiSpy = vi.spyOn(geminiClient, "callGemini").mockResolvedValue({
      candidates: [{ content: { parts: [{ text: "{\"enhanced\":\"pure text prompt\",\"duration\":5}" }] } }],
    } as any);

    try {
      const result = await invokeFunction("enhance-video-prompt", {
        description: "林晓晓推门走进医院走廊",
        sceneName: "医院走廊",
        characters: ["林晓晓"],
        sceneDescription: "冷白灯医院走廊，金属门与反光地面",
        videoMode: "text-to-video",
      });

      expect(result.error).toBeNull();
      const promptText = String(
        (geminiSpy.mock.calls[0]?.[1] as Array<{ parts?: Array<{ text?: string }> }> | undefined)?.[0]?.parts?.[0]
          ?.text || "",
      );
      expect(promptText).toContain("当前为纯文生视频，没有可用参考图");
      expect(promptText).not.toContain("当前为文生视频，但已附参考图");
    } finally {
      geminiSpy.mockRestore();
    }
  });

  it("uses the reference-guided text-to-video prompt strategy when reference visuals are attached", async () => {
    const geminiSpy = vi.spyOn(geminiClient, "callGemini").mockResolvedValue({
      candidates: [{ content: { parts: [{ text: "{\"enhanced\":\"reference guided prompt\",\"duration\":5}" }] } }],
    } as any);

    try {
      const result = await invokeFunction("enhance-video-prompt", {
        description: "林晓晓快步穿过医院走廊，回头寻找声音来源",
        sceneName: "医院走廊",
        characters: ["林晓晓"],
        sceneDescription: "冷白灯医院走廊，尽头有安全门",
        videoMode: "text-to-video",
        referenceImageUrl: "data:image/png;base64,AQID",
        hasRefImage: true,
        characterImages: [
          { name: "林晓晓", imageUrl: "data:image/png;base64,BAUG" },
        ],
      });

      expect(result.error).toBeNull();
      const promptParts =
        (geminiSpy.mock.calls[0]?.[1] as Array<{ parts?: Array<{ text?: string; inlineData?: unknown }> }> | undefined)
          ?.[0]?.parts || [];
      const promptText = String(promptParts[0]?.text || "");
      expect(promptText).toContain("当前为文生视频，但已附参考图");
      expect(promptText).toContain("不要重新发明、覆盖或改写参考图里已经明确可见的视觉事实");
      expect(promptText).not.toContain("当前为纯文生视频，没有可用参考图");
      expect(promptParts.some((part) => "inlineData" in part)).toBe(true);
    } finally {
      geminiSpy.mockRestore();
    }
  });

  it("keeps segment prompt enhancement on the single canonical detailed contract when reference images are present", async () => {
    const geminiSpy = vi.spyOn(geminiClient, "callGemini").mockResolvedValue({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ prompt: buildDetailedSegmentPrompt("医院走廊"), duration: 15 }) }] } }],
    } as any);

    try {
      const result = await invokeFunction("enhance-video-prompt", {
        mode: "segment",
        videoMode: "text-to-video",
        segmentLabel: "1-1",
        shots: [
          {
            index: 1,
            prompt: "林晓晓停在门口，警惕地看向走廊深处",
            rawDescription: "林晓晓停在门口，警惕地看向走廊深处",
            promptSource: "enhanced",
            prevDescription: "",
            nextDescription: "",
            previousAnchor: "上一镜停在林晓晓冲到门口急停",
            startState: "林晓晓停在门口，肩线绷紧，视线扫向走廊深处",
            endState: "她手扶门框停住，呼吸压低，视线锁定前方",
            nextAnchor: "下一镜从她扶门框停住后继续前压",
            duration: 5,
            sceneName: "医院走廊",
            cameraDirection: "中景推进",
            dialogue: "",
          },
        ],
        targetDuration: 15,
        maxDuration: 15,
        currentSegmentScriptSource: "第1集：医院追踪\n林晓晓停在医院走廊门口，警惕地看向走廊深处。",
        currentSegmentScriptSkeleton: "分镜1｜5秒｜场景：医院走廊｜剧情：林晓晓停在门口，警惕地看向走廊深处",
        currentSegmentShotRelayPlan: "分镜1｜开场：林晓晓停在门口并警惕回头｜推进：她压低呼吸看向走廊深处｜收尾：手扶门框停住｜下一接拍：从她锁定前方继续前压",
        referenceImageUrl: "data:image/png;base64,AQID",
        hasRefImage: true,
        characterImages: [
          { name: "林晓晓", imageUrl: "data:image/png;base64,BAUG" },
        ],
        sceneImages: [
          { imageUrl: "data:image/png;base64,BwgJ" },
        ],
      });

      expect(result.error).toBeNull();
      const promptText = String(
        (geminiSpy.mock.calls[0]?.[1] as Array<{ parts?: Array<{ text?: string }> }> | undefined)?.[0]?.parts?.[0]
          ?.text || "",
      );
      expect(promptText).toContain("当前为附参考图的文生视频");
      expect(promptText).toContain("参考图锁定静态视觉事实");
      expect(promptText).toContain("文字只补动作、表演、情绪推进、镜头运动和衔接结果");
      expect(promptText).toContain("[当前片段分镜拆解骨架]");
      expect(promptText).toContain("[对应剧本补全参考]");
      expect(promptText).toContain("[拆解结果继承原则]");
      expect(promptText).toContain("[跨片段剧情兜底]");
      expect(promptText).toContain("[剧情扩写边界]");
      expect(promptText).toContain("先严格按当前片段已拆解分镜的顺序、时长和基础动作逐镜扩写");
      expect(promptText).toContain("后续所有分镜扩写、参考图解读和最终提交都必须以当前片段分镜拆解骨架与对应剧本补全参考为最高优先级剧情事实");
      expect(promptText).toContain("[当前片段镜头接力骨架]");
      expect(promptText).toContain("【上一停点】");
      expect(promptText).toContain("【开场承接】");
      expect(promptText).toContain("【收尾停点】");
      expect(promptText).toContain("【下一接拍】");
    } finally {
      geminiSpy.mockRestore();
    }
  });

  it("passes abort signals through segment prompt enhancement", async () => {
    const controller = new AbortController();
    const geminiSpy = vi.spyOn(geminiClient, "callGemini").mockResolvedValue({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ prompt: buildDetailedSegmentPrompt("测试片段"), duration: 15 }) }] } }],
    } as any);

    try {
      const result = await invokeFunction(
        "enhance-video-prompt",
        {
          mode: "segment",
          videoMode: "text-to-video",
          segmentLabel: "1-1",
          shots: [
            {
              index: 1,
              prompt: "镜头提示词",
              rawDescription: "镜头提示词",
              promptSource: "enhanced",
              prevDescription: "",
              nextDescription: "",
              duration: 5,
              sceneName: "医院走廊",
              cameraDirection: "中景推进",
              dialogue: "",
            },
          ],
          targetDuration: 15,
          maxDuration: 15,
        },
        { abortSignal: controller.signal },
      );

      expect(result.error).toBeNull();
      expect(geminiSpy.mock.calls[0]?.[3]).toBe(controller.signal);
    } finally {
      geminiSpy.mockRestore();
    }
  });

  it("uses the explicitly requested text model for segment prompt enhancement", async () => {
    const geminiSpy = vi.spyOn(geminiClient, "callGemini").mockResolvedValue({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ prompt: buildDetailedSegmentPrompt("显式模型"), duration: 15 }) }] } }],
    } as any);

    try {
      const result = await invokeFunction("enhance-video-prompt", {
        mode: "segment",
        videoMode: "text-to-video",
        segmentLabel: "1-1",
        textModel: "claude-sonnet-4-6",
        shots: [
          {
            index: 1,
            prompt: "镜头提示词",
            rawDescription: "镜头提示词",
            promptSource: "enhanced",
            prevDescription: "",
            nextDescription: "",
            duration: 5,
            sceneName: "医院走廊",
            cameraDirection: "中景推进",
            dialogue: "",
          },
        ],
        targetDuration: 15,
        maxDuration: 15,
      });

      expect(result.error).toBeNull();
      expect(geminiSpy.mock.calls[0]?.[0]).toBe("claude-sonnet-4-6");
    } finally {
      geminiSpy.mockRestore();
    }
  });

  it("uses the stored home-agent text model for segment prompt enhancement when no explicit text model is provided", async () => {
    saveApiConfig({
      jimengEndpoint: "https://api.tu-zi.com/v1beta",
      jimengKey: "test-jimeng-key",
      jimengExecutionMode: "api",
      geminiEndpoint: "https://api.tu-zi.com/v1beta",
      geminiKey: "test-gemini-key",
      claudeEndpoint: "https://api.tu-zi.com/v1",
      claudeKey: "test-claude-key",
    });
    writeStoredHomeAgentTextModelKey("claude-sonnet-4-6");

    const geminiSpy = vi.spyOn(geminiClient, "callGemini").mockResolvedValue({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ prompt: buildDetailedSegmentPrompt("存储模型"), duration: 15 }) }] } }],
    } as any);

    try {
      const result = await invokeFunction("enhance-video-prompt", {
        mode: "segment",
        videoMode: "text-to-video",
        segmentLabel: "1-1",
        shots: [
          {
            index: 1,
            prompt: "镜头提示词",
            rawDescription: "镜头提示词",
            promptSource: "enhanced",
            prevDescription: "",
            nextDescription: "",
            duration: 5,
            sceneName: "医院走廊",
            cameraDirection: "中景推进",
            dialogue: "",
          },
        ],
        targetDuration: 15,
        maxDuration: 15,
      });

      expect(result.error).toBeNull();
      expect(geminiSpy.mock.calls[0]?.[0]).toBe("claude-sonnet-4-6");
    } finally {
      geminiSpy.mockRestore();
    }
  });

  it("normalizes detailed segment prompts into the stable line-broken layout", async () => {
    const geminiSpy = vi.spyOn(geminiClient, "callGemini").mockResolvedValue({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              prompt: [
                "全局风格：15秒，冷白压迫感明确，医院追逃的冷色高反差镜头质感，no subtitles, no watermark。",
                "角色设定：林晓晓蓝色外套，医院走廊冷白灯，金属门和反光地面保持一致。",
                "起始衔接：第1张参考图作为首镜起拍基准，上一片段结尾停点是林晓晓扶墙急喘，本片段开场画面目标是她猛然推门前冲，第一镜直接接上一片段末帧，不重起铺垫，不重演上一段动作。",
                "衔接原则：全段按同一条长片时间线拍，遵循承接 -> 推进 -> 留停点。先按已拆解分镜的顺序、时长和基础动作推进；缺口只补剧本里明确存在的承接动作、反应或状态变化。各分镜按上一结果 -> 当前动作 -> 下一停点接力，保持朝向、轴线、光向和空间关系连续。",
                "时间戳分镜法：",
                "[00:00-00:03] 镜头 1：中景推进，林晓晓快步穿过走廊，右手推门，回头看向左后方。",
                "[00:03-00:06] 镜头 2：跟拍横移，她停步侧身闪让，抬手扶墙，视线追向前方。",
                "环境细节：冷白灯在金属门上跳闪，地面反光跟着脚步晃动。",
                "声音设计：急促呼吸，鞋底摩擦回响，远处门轴轻响。",
                "转场与节奏：动作承接切到下镜头，保持方向一致。",
                "结尾钩子：她半转身停在门边，呼吸急促，给下一镜头留下继续前冲的动作。",
                "台词：无台词。",
              ].join("\n"),
              duration: 15,
            }),
          }],
        },
      }],
    } as any);

    try {
      const result = await invokeFunction("enhance-video-prompt", {
        mode: "segment",
        videoMode: "text-to-video",
        segmentLabel: "1-1",
        shots: [
          {
            index: 1,
            prompt: "林晓晓快步穿过医院走廊，右手推门，回头查看身后",
            rawDescription: "林晓晓快步穿过医院走廊，右手推门，回头查看身后",
            promptSource: "enhanced",
            prevDescription: "",
            nextDescription: "",
            duration: 5,
            sceneName: "医院走廊",
            cameraDirection: "中景推进",
            dialogue: "",
          },
        ],
        targetDuration: 15,
        maxDuration: 15,
      });

      expect(result.error).toBeNull();
      const promptText = String(result.data && "prompt" in result.data ? result.data.prompt : "");
      expect(promptText).toContain("全局风格：15秒，冷白压迫感");
      expect(promptText).toContain("环境细节：");
      expect(promptText).toContain("结尾钩子：");
      expect(promptText).toContain("通用后缀：无字幕、无水印、无屏幕文字");
      expect(promptText).toContain("分镜1（0-3秒）：");
      expect(promptText).toContain("分镜2（3-6秒）：");
      expect(promptText).toMatch(/分镜1（0-3秒）：(?:中景推进|镜头推进)/);
      expect(promptText).toMatch(/分镜2（3-6秒）：(?:跟拍横移|镜头横移|镜头跟拍)/);
      expect(promptText).not.toContain("视觉锚点：");
      expect(promptText).not.toContain("起始衔接：");
      expect(promptText).not.toContain("衔接原则：");
      expect(promptText).not.toContain("镜头推进：");
      expect(promptText).not.toContain("声音氛围：");
      expect(promptText).not.toContain("台词：");
      expect(promptText).not.toContain("总目标：");
      expect(promptText).not.toContain("镜头1：");
      expect(promptText).not.toContain("\n\n");
      expect(promptText).not.toContain("no subtitles");
      expect(promptText).not.toContain("no watermark");
    } finally {
      geminiSpy.mockRestore();
    }
  });

  it("preserves all storyboard beats in the detailed segment layout", async () => {
    const geminiSpy = vi.spyOn(geminiClient, "callGemini").mockResolvedValue({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              prompt: [
                "全局风格：电影化短剧质感，15秒，氛围压抑凌厉，冷色主光与强烈呼吸感并存，无限副本追杀风格。",
                "视觉锚点：角色 林萧：年轻，眼神坚毅且深藏杀意，身穿洗得发白的灰色外门弟子服；系统音：无形的存在，以冰冷、机械的电子音形式出现，代表无限回档系统的意志；场景 副本第一层：昏暗石壁、血色巨眼、潮湿反光地面、摇晃火把、漂浮尘屑全部保持一致。",
                "起始衔接：参考顺序：第1张参考图作为首镜起拍基准，直接承接上一片段末帧。第2-5张参考图延续动作、站位、轴线和光向。第6张参考图只补身份与场景锚点，不改变镜起拍关系。上一停点：最后一帧停在副本第一层里人物动作未收完、视线已经锁定的瞬间，下一段从这里继续。",
                "衔接原则：全段按同一条长片时间线拍，遵循承接 -> 推进 -> 留停点。拆解骨架与剧本补全参考优先，不吞关键动作、反应和结果。先按已拆解分镜的顺序、时长和基础动作推进；缺口只补剧本里明确存在的承接动作、反应或状态变化。各分镜按上一结果 -> 当前动作 -> 下一停点接力，保持朝向、轴线、光向和空间连续。",
                "镜头推进：",
                "0-3秒：林萧猛地抬头，额头鲜血顺着眼角滴下，双眼因极度杀意透出微弱红光，呼吸沉重且急促，副本第一层里黑暗墙体裂开，无数幽蓝寒光的长剑破空而出。",
                "3-6秒：赵峰面露惊恐，身体因恐惧而颤抖，万千剑影调转方向，齐刷刷指向跪伏在地的赵峰。",
                "6-9秒：林萧眼神冷冽，直视镜头，背景黑暗中睁开一只血色巨眼，系统音低沉回响。",
                "9-12秒：剑阵向前推进半步，赵峰踉跄后退，地面碎石被气流推开，副本墙面裂纹继续扩散。",
                "环境细节：冷风卷起灰屑，墙缝渗出蓝雾，碎石摩擦地面，脚步回声被系统低鸣吞没。",
                "声音氛围：呼吸、低鸣、电流脉冲与金属震颤层层叠加。",
                "结尾钩子：最后一帧停在赵峰瞳孔骤缩、林萧视线完全锁死他的瞬间。",
              ].join("\n"),
              duration: 15,
            }),
          }],
        },
      }],
    } as any);

    try {
      const result = await invokeFunction("enhance-video-prompt", {
        mode: "segment",
        videoMode: "text-to-video",
        segmentLabel: "1-2",
        shots: [
          { index: 1, prompt: "林萧猛地抬头。", rawDescription: "林萧猛地抬头。", promptSource: "enhanced", prevDescription: "", nextDescription: "", duration: 3, sceneName: "副本第一层", cameraDirection: "近景", dialogue: "" },
          { index: 2, prompt: "万千剑影齐刷刷指向赵峰。", rawDescription: "万千剑影齐刷刷指向赵峰。", promptSource: "enhanced", prevDescription: "", nextDescription: "", duration: 3, sceneName: "副本第一层", cameraDirection: "中景", dialogue: "" },
          { index: 3, prompt: "林萧眼神冷冽直视镜头。", rawDescription: "林萧眼神冷冽直视镜头。", promptSource: "enhanced", prevDescription: "", nextDescription: "", duration: 3, sceneName: "副本第一层", cameraDirection: "正面近景", dialogue: "" },
          { index: 4, prompt: "剑阵继续推进，赵峰后退。", rawDescription: "剑阵继续推进，赵峰后退。", promptSource: "enhanced", prevDescription: "", nextDescription: "", duration: 3, sceneName: "副本第一层", cameraDirection: "横移", dialogue: "" },
        ],
        targetDuration: 15,
        maxDuration: 15,
      });

      expect(result.error).toBeNull();
      const promptText = String(result.data && "prompt" in result.data ? result.data.prompt : "");
      expect(promptText).toContain("全局风格：电影化短剧质感，15秒，氛围压抑凌厉，冷色主光与强烈呼吸感并存，无限副本追杀风格");
      expect(promptText).not.toContain("镜头推进：");
      expect(promptText).toContain("分镜1（0-3秒）：");
      expect(promptText).toContain("分镜2（3-6秒）：");
      expect(promptText).toContain("分镜3（6-9秒）：");
      expect(promptText).toContain("分镜4（9-12秒）：");
      expect(promptText).toContain("环境细节：冷风卷起灰屑");
      expect(promptText).not.toContain("声音氛围：");
      expect(promptText).toContain("结尾钩子：");
    } finally {
      geminiSpy.mockRestore();
    }
  });

  it("tells the segment enhancer that a continuity grid explains how the previous segment moves into this one", async () => {
    const geminiSpy = vi.spyOn(geminiClient, "callGemini").mockResolvedValue({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              prompt: [
                "全局风格：电影级古装玄幻短剧质感，15秒，烈日灼烧下的压抑肃杀氛围与冷调高反差并存。",
                "视觉锚点：陆沉满身血迹被粗重玄铁锁链贯穿钉在刑台铜柱上，蒋家执事持剔骨尖刀逼近，青石刑台与粗粝石壁保持一致。",
                "起始衔接：从上一片段刑台死寂的停点直接接入，镜头一落地就锁住陆沉垂头喘息后的再度抬眼。",
                "衔接原则：全段沿同一条长片时间线推进，按已拆解分镜顺序逐镜接力，保持人物朝向、镜头轴线、主光方向和刑台空间关系连续。",
                "镜头推进：",
                "分镜1（0-5秒）：烈日白火压着刑台青石反光，镜头从低角度缓慢推近陆沉胸前交错的锁链与伤口，血迹顺着锁链纹理往下滑落。",
                "分镜2（5-10秒）：蒋家执事半步踏上刑台，剔骨尖刀带着寒光逼近陆沉喉前，刀锋映出他扭曲却兴奋的笑意。",
                "分镜3（10-15秒）：镜头压到极近特写，陆沉强撑抬眼直视对方，眼神里闪出一丝反扑前的寒芒。",
                "环境细节：烈日热浪压得空气轻微扭曲，青石地面蒸腾白光，锁链金属摩擦与远处低笑混在一起持续回响。",
                "结尾钩子：最后一镜停在刀尖逼近伤口而陆沉忽然抬眼的瞬间，让下一片段直接接上他的反扑起势。",
                "通用后缀：无字幕、无水印、无屏幕文字",
              ].join("\n"),
              duration: 15,
            }),
          }],
        },
      }],
    } as any);

    try {
      const result = await invokeFunction("enhance-video-prompt", {
        mode: "segment",
        videoMode: "text-to-video",
        segmentLabel: "1-2",
        shots: [
          {
            index: 1,
            prompt: "陆沉抬眼。",
            rawDescription: "陆沉抬眼。",
            promptSource: "enhanced",
            prevDescription: "",
            nextDescription: "",
            duration: 5,
            sceneName: "蒋家刑台",
            cameraDirection: "低机位推进",
            dialogue: "",
          },
        ],
        targetDuration: 15,
        maxDuration: 15,
        continuityReferenceImageUrl: "https://media.storyforge.test/segment-1-1-grid.jpg",
        continuityReferenceUsageText:
          "图片 1：上传的六宫格图片为上一段视频的连续时间参考。六张画面按照：左→右、上→下 进行时间推进排列。第1格为上一段镜头开始状态，第6格为上一段视频最终结束画面。本段视频必须从六宫格最后一格尾帧画面状态直接开始，保持完全一致的人物状态、镜头运动、动作惯性、烟尘漂浮与光影氛围，并把上一段“从跪地蓄力推进到抬眼反击”所形成的剧情余势、人物压迫关系与情绪方向直接接到本段首镜，保持电影级时间连续性。",
      });

      expect(result.error).toBeNull();
      const submittedPrompt = String(
        geminiSpy.mock.calls[0]?.[1]?.[0]?.parts?.[0]?.text || "",
      );
      expect(submittedPrompt).toContain("[图片参考优先级与用途]");
      expect(submittedPrompt).toContain("图片 1：上传的六宫格图片为上一段视频的连续时间参考。");
      expect(submittedPrompt).toContain("第1格为上一段镜头开始状态，第6格为上一段视频最终结束画面。");
      expect(submittedPrompt).toContain("本段视频必须从六宫格最后一格尾帧画面状态直接开始");
      expect(submittedPrompt).not.toContain("涓婁竴鐗囨");
    } finally {
      geminiSpy.mockRestore();
    }
  });

  it("forces only the first storyboard beat to directly continue the last six-grid frame while preserving later beat wording", () => {
    const promptText = formatDetailedSegmentPrompt(
      [
        "全局风格：电影化短剧质感，15秒，冷峻空灵氛围，高对比度光影，写实材质，镜头语言流畅且具有叙事张力。",
        "分镜1（0-3秒）：纯白虚无空间中无数断剑悬浮，陆沉的神魂在静止压迫感里缓缓显形。",
        "分镜2（3-6秒）：陆沉猛然睁开双眼，瞳孔深处闪过一抹凌厉的金色剑芒。",
        "分镜3（6-9秒）：小灵怀抱锈蚀断剑冲到陆沉面前，神色焦急地向前逼近。",
        "环境细节：空间里漂浮微尘，断剑低鸣震颤，金色符文流光若隐若现，空气轻微扭曲。",
        "结尾钩子：画面停在小灵贴近陆沉的瞬间，保留下一镜能量爆发前的压缩势能。",
        "通用后缀：无字幕、无水印、无屏幕文字",
      ].join("\n"),
      {
        referenceUsageText:
          "图片 1：上传的六宫格图片为上一段视频的连续时间参考。六张画面按照：左→右、上→下 进行时间推进排列。第1格为上一段镜头开始状态，第6格为上一段视频最终结束画面。本段视频必须从六宫格最后一格尾帧画面状态直接开始，保持完全一致的人物状态、镜头运动、动作惯性、烟尘漂浮与光影氛围，并把上一段“从跪地蓄力推进到抬眼反击”所形成的剧情余势、人物压迫关系与情绪方向直接接到本段首镜，保持电影级时间连续性。",
      },
    );

    const beatLines = promptText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^分镜\d+/.test(line));

    expect(beatLines[0]).toMatch(/^分镜1（0-3秒）：镜头直接承接上一段最后尾帧画面，/);
    expect(beatLines[1]).toMatch(/^分镜2（3-6秒）：[^，]+，陆沉猛然睁开双眼，瞳孔深处闪过一抹凌厉的金色剑芒。$/);
    expect(beatLines[2]).toMatch(/^分镜3（6-9秒）：[^，]+，小灵怀抱锈蚀断剑冲到陆沉面前，神色焦急地向前逼近。$/);
  });

  it("strips the stock direct-continuation opening from beat 1 when no six-grid reference exists", () => {
    const promptText = formatDetailedSegmentPrompt(
      [
        "全局风格：电影化短剧质感，15秒，冷峻空灵氛围，高对比度光影，写实材质，镜头语言流畅且具有叙事张力。",
        "分镜1（0-3秒）：镜头直接承接上一段最后尾帧画面，萧家执事手持剔骨尖刀，带着残忍而贪婪的笑容，一步步逼近铜柱上的陆沉。",
        "分镜2（3-6秒）：镜头缓慢拉近至正面部特写，陆沉浑身是血，被四根粗壮的玄铁锁链死死钉在铜柱上，他低垂着头，黑发遮挡住面容。",
        "环境细节：刑台上浮尘翻卷，玄铁锁链轻微摇晃，远处围观人群窃窃私语。",
        "结尾钩子：画面停在陆沉微微抬头的瞬间，保留反击前压到极致的沉默势能。",
        "通用后缀：无字幕、无水印、无屏幕文字",
      ].join("\n"),
      {
        referenceUsageText: [
          "图片 1：场景资产图（陆家演武场），只补场景锚点，不改首镜起拍关系。",
          "图片 2：角色资产图（陆沉），只补角色身份锚点，不改首镜起拍关系。",
          "图片 3：角色资产图（萧家执事），只补角色身份锚点，不改首镜起拍关系。",
        ].join("\n"),
      },
    );

    const beatLines = promptText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^分镜\d+/.test(line));

    expect(beatLines[0]).toMatch(
      /^分镜1（0-3秒）：[^，]+，萧家执事手持剔骨尖刀，带着残忍而贪婪的笑容，一步步逼近铜柱上的陆沉。$/,
    );
    expect(promptText).not.toContain("镜头直接承接上一段最后尾帧画面");
  });

  it("extracts inline audio dialogue from storyboard beats without truncating the detailed visual descriptions", () => {
    const promptText = formatDetailedSegmentPrompt(
      [
        "全局风格：电影级CG质感，15秒，极速转场与爆发式动作作画。",
        "视觉锚点：黑衣剑修苏辰、神殿禁地、水晶囚笼与幽暗石殿。",
        "起始衔接：从神殿禁地上一镜头的爆裂停点直接切入。",
        "衔接原则：严格按已拆分镜头顺序推进，保持刑台空间、人物朝向和动作接力连续。",
        [
          "镜头推进：",
          "镜头1：镜头手持快速取拍，苏辰身影化作黑色残影瞬移至水晶囚笼前，手中木剑裹挟暗金剑气，如闪电般劈断囚笼锁链，碎冰飞溅，音频：大长老：“苏辰快走，这是大长老化身。”",
          "镜头2：镜头猛然推进至苏辰面部特写，他将林清雪的残魂光影强行压入木剑，剑身震颤，苏辰眼中血色弥漫，杀意狂暴，嘴角勾起决绝狂笑，音频：苏辰：“本体又如何？我迟早找了它！”",
          "镜头3：镜头拉升至远景，苏辰重剑轰然劈开神殿广场，大地崩裂现出万丈深渊，他紧握木剑，身影带着残魂光芒决绝坠入深渊，音频：旁白：“屠神之路，刚刚拉开序幕。”",
        ].join("；"),
        "环境细节：空间剧烈震动，冰晶碎裂声、暗金能量与清冷白光剧烈对撞，尘土与碎石在空中翻涌。",
        "结尾钩子：坠落中苏辰身形在空中扭转，目光如炬直视深渊上方，手中剑意直指天际。",
        "通用后缀：无字幕、无水印、无屏幕文字",
      ].join("\n"),
    );

    expect(promptText).toContain(
      "镜头手持快速取拍，苏辰身影化作黑色残影瞬移至水晶囚笼前，手中木剑裹挟暗金剑气，如闪电般劈断囚笼锁链，碎冰飞溅",
    );
    expect(promptText).toContain(
      "分镜2：镜头猛然推进至苏辰面部特写，他将林清雪的残魂光影强行压入木剑，剑身震颤，苏辰眼中血色弥漫，杀意狂暴，嘴角勾起决绝狂笑",
    );
    expect(promptText).toContain(
      "分镜3：镜头拉升至远景，苏辰重剑轰然劈开神殿广场，大地崩裂现出万丈深渊，他紧握木剑，身影带着残魂光芒决绝坠入深渊",
    );
    expect(promptText).toContain("\n大长老：苏辰快走，这是大长老化身。");
    expect(promptText).toContain("\n苏辰：本体又如何？我迟早找了它！");
    expect(promptText).toContain("\n旁白：屠神之路，刚刚拉开序幕。");
    expect(promptText).not.toContain("音频：");
    expect(promptText).not.toContain("“");
    expect(promptText.match(/苏辰快走，这是大长老化身/g)?.length).toBe(1);
    expect(promptText.match(/本体又如何？我迟早找了它/g)?.length).toBe(1);
    expect(promptText.match(/屠神之路，刚刚拉开序幕/g)?.length).toBe(1);
  });

  it("does not misclassify camera-language labels as detached dialogue lines", () => {
    const promptText = formatDetailedSegmentPrompt(
      [
        "全局风格：电影化短剧质感，15秒，冷峻肃杀氛围，高反差硬光，写实材质。",
        "镜头推进：",
        "分镜1（0-3秒）：特写：陆沉浑身血迹斑斑，四肢被玄铁锁链死死钉在铜柱上，他低垂着头，胸口起伏微弱；推进：镜头压近至他被血浸透的胸口伤处，血珠顺着锁链纹理缓慢滑落。",
        "分镜2（3-6秒）：中景：蒋家执事带着冷笑半步踏上刑台；切至：刀锋逼近陆沉喉前，寒光映出他扭曲兴奋的笑意。",
        "环境细节：烈日烘烤青石地面，浮尘翻卷，锁链轻微震颤。",
        "结尾钩子：画面停在刀锋贴近陆沉喉前的瞬间，保留下一镜反扑前的压迫势能。",
        "通用后缀：无字幕、无水印、无屏幕文字",
      ].join("\n"),
    );

    expect(promptText).toContain(
      "分镜1（0-3秒）：特写推进，陆沉浑身血迹斑斑，四肢被玄铁锁链死死钉在铜柱上，他低垂着头，胸口起伏微弱；推进：镜头压近至他被血浸透的胸口伤处，血珠顺着锁链纹理缓慢滑落。",
    );
    expect(promptText).toContain(
      "分镜2（3-6秒）：中景切至，蒋家执事带着冷笑半步踏上刑台；切至：刀锋逼近陆沉喉前，寒光映出他扭曲兴奋的笑意。",
    );
    expect(promptText).not.toContain("\n特写：");
    expect(promptText).not.toContain("\n推进：");
    expect(promptText).not.toContain("\n中景：");
    expect(promptText).not.toContain("\n切至：");
  });

  it("anchors detached dialogue lines under the hinted storyboard beats", () => {
    const promptText = formatDetailedSegmentPrompt(
      [
        "全局风格：电影级古装玄幻短剧质感，9秒，烈日灼烧下的压抑肃杀氛围与冷调高反差并存。",
        "视觉锚点：陆沉满身血迹被粗重玄铁锁链贯穿钉在刑台铜柱上，蒋家执事持剔骨尖刀逼近，青石刑台与粗粝石壁保持一致。",
        "起始衔接：从上一片段刑台死寂的停点直接接入，镜头一落地就锁住陆沉垂头喘息后的再度抬眼。",
        "衔接原则：全段沿同一条长片时间线推进，按已拆解分镜顺序逐镜接力，保持人物朝向、镜头轴线、主光方向和刑台空间关系连续。",
        [
          "镜头推进：",
          "分镜1（0-3秒）：烈日白火压着刑台青石反光，镜头从低角度缓慢推近陆沉胸前交错的锁链与伤口，血迹顺着锁链纹理往下滑落。",
          "分镜2（3-6秒）：蒋家执事半步踏上刑台，剔骨尖刀带着寒光逼近陆沉喉前，刀锋映出他扭曲却兴奋的笑意。",
          "分镜3（6-9秒）：镜头压到极近特写，陆沉强撑抬眼直视对方，眼神里闪出一丝反扑前的寒芒。",
        ].join("\n"),
        "台词：\n陆沉：想杀我？先问过我的剑。\n蒋家执事：陆沉，今天你这废柴就彻底消失吧！",
        "环境细节：烈日热浪压得空气轻微扭曲，青石地面蒸腾白光，锁链金属摩擦与远处低笑混在一起持续回响。",
        "结尾钩子：最后一镜停在刀尖逼近伤口而陆沉忽然抬眼的瞬间，让下一片段直接接上他的反扑起势。",
        "通用后缀：无字幕、无水印、无屏幕文字",
      ].join("\n"),
      {
        shotDialogueGroups: [
          "",
          "蒋家执事：陆沉，今天你这废柴就彻底消失吧！",
          "陆沉：想杀我？先问过我的剑。",
        ],
      },
    );

    const shot2Index = promptText.indexOf("分镜2（3-6秒）：");
    const shot3Index = promptText.indexOf("分镜3（6-9秒）：");
    const dialogue1Index = promptText.indexOf("\n蒋家执事：陆沉，今天你这废柴就彻底消失吧！");
    const dialogue2Index = promptText.indexOf("\n陆沉：想杀我？先问过我的剑。");

    expect(dialogue1Index).toBeGreaterThan(shot2Index);
    expect(dialogue1Index).toBeLessThan(shot3Index);
    expect(dialogue2Index).toBeGreaterThan(shot3Index);
    expect(promptText).not.toContain("台词：");
    expect(promptText.match(/蒋家执事：陆沉，今天你这废柴就彻底消失吧！/g)?.length).toBe(1);
    expect(promptText.match(/陆沉：想杀我？先问过我的剑。/g)?.length).toBe(1);
  });

  it("removes quoted inline speech when the same dialogue is already anchored under the beat", () => {
    const promptText = formatDetailedSegmentPrompt(
      [
        "全局风格：电影级古装玄幻短剧质感，12秒，烈日灼烧下的压抑肃杀氛围与冷调高反差并存。",
        "视觉锚点：陆沉满身血迹被粗重玄铁锁链贯穿钉在刑台铜柱上，蒋家执事持剔骨尖刀逼近，双马尾剑灵小灵抱着锈蚀断剑悬停半空。",
        "起始衔接：从上一片段刑台死寂的停点直接接入，镜头一落地就锁住陆沉垂头喘息后的再度抬眼。",
        "衔接原则：全段沿同一条长片时间线推进，按已拆解分镜顺序逐镜接力，保持人物朝向、镜头轴线、主光方向和刑台空间关系连续。",
        [
          "镜头推进：",
          "分镜1（0-3秒）：烈日白火压着刑台青石反光，镜头从低角度缓慢推近陆沉胸前交错的锁链与伤口，血迹顺着锁链纹理往下滑落。",
          "分镜2（3-6秒）：扎着双马尾的剑灵小灵凭空显现，怀里紧紧抱着一把巨大的锈蚀断剑，神色焦急地飘到陆沉面前，周身碎蓝灵火不断闪烁，口中急促呼喊：“宿主！身体要凉了！快激活系统，觉醒满级剑意！”",
          "分镜3（6-9秒）：陆沉嘴角勾起一抹冷酷的弧度，右手指节在锁链上慢慢收紧，眼中杀意重新聚焦，低沉回应：“小灵，好久不见。拿回我的剑，宰判这群蝼蚁。”",
        ].join("\n"),
        "台词：\n小灵：宿主！身体要凉了！快激活系统，觉醒满级剑意！\n陆沉：小灵，好久不见。拿回我的剑，宰判这群蝼蚁。",
        "环境细节：烈日热浪压得空气轻微扭曲，青石地面蒸腾白光，锁链金属摩擦与远处低笑混在一起持续回响。",
        "结尾钩子：最后一镜停在陆沉眼底杀意重新翻起的瞬间，让下一片段直接接上他的反扑起势。",
        "通用后缀：无字幕、无水印、无屏幕文字",
      ].join("\n"),
      {
        shotDialogueGroups: [
          "",
          "小灵：宿主！身体要凉了！快激活系统，觉醒满级剑意！",
          "陆沉：小灵，好久不见。拿回我的剑，宰判这群蝼蚁。",
        ],
      },
    );

    expect(promptText).toContain(
      "分镜2（3-6秒）：扎着双马尾的剑灵小灵凭空显现，怀里紧紧抱着一把巨大的锈蚀断剑，神色焦急地飘到陆沉面前",
    );
    expect(promptText).toContain(
      "分镜3（6-9秒）：陆沉嘴角勾起一抹冷酷的弧度",
    );
    expect(promptText).toContain("\n小灵：宿主！身体要凉了！快激活系统，觉醒满级剑意！");
    expect(promptText).toContain("\n陆沉：小灵，好久不见。拿回我的剑，宰判这群蝼蚁。");
    expect(promptText).not.toContain("口中急促呼喊：“宿主！身体要凉了！快激活系统，觉醒满级剑意！”");
    expect(promptText).not.toContain("低沉回应：“小灵，好久不见。拿回我的剑，宰判这群蝼蚁。”");
    expect(promptText.match(/宿主！身体要凉了！快激活系统，觉醒满级剑意/g)?.length).toBe(1);
    expect(promptText.match(/小灵，好久不见。拿回我的剑，宰判这群蝼蚁/g)?.length).toBe(1);
  });

  it("drops orphaned speaker labels after moving matched inline dialogue onto dedicated lines", () => {
    const promptText = formatDetailedSegmentPrompt(
      [
        "全局风格：电影级古装玄幻短剧质感，12秒，烈日灼烧下的压抑肃杀氛围与冷调高反差并存。",
        "视觉锚点：陆沉满身血迹被粗重玄铁锁链贯穿钉在刑台铜柱上，双马尾剑灵小灵抱着锈蚀断剑悬停半空，蒋家执事持剔骨尖刀逼近。",
        "起始衔接：从上一片段刑台死寂的停点直接接入，镜头一落地就锁住陆沉垂头喘息后的再度抬眼。",
        "衔接原则：全段沿同一条长片时间线推进，按已拆解分镜顺序逐镜接力，保持人物朝向、镜头轴线、主光方向和刑台空间关系连续。",
        [
          "镜头推进：",
          "分镜1（0-3秒）：烈日白火压着刑台青石反光，镜头从低角度缓慢推近陆沉胸前交错的锁链与伤口，血迹顺着锁链纹理往下滑落。",
          "分镜2（3-6秒）：扎着双马尾的剑灵小灵凭空显现，怀里紧紧抱着一把巨大的锈蚀断剑，神色焦急地飘到陆沉面前；小灵：宿主！身体要凉了！快激活系统，觉醒满级剑意！",
          "分镜3（6-9秒）：陆沉嘴角勾起一抹冷酷的弧度，右手朝着虚空猛然一握，眼神中透露出无情的杀意；陆沉：小灵，好久不见。拿回我的剑，审判这群蝼蚁。",
        ].join("\n"),
        "台词：\n小灵：宿主！身体要凉了！快激活系统，觉醒满级剑意！\n陆沉：小灵，好久不见。拿回我的剑，审判这群蝼蚁。",
        "环境细节：烈日热浪压得空气轻微扭曲，青石地面蒸腾白光，锁链金属摩擦与远处低笑混在一起持续回响。",
        "结尾钩子：最后一镜停在陆沉眼底杀意重新翻起的瞬间，让下一片段直接接上他的反扑起势。",
        "通用后缀：无字幕、无水印、无屏幕文字",
      ].join("\n"),
      {
        shotDialogueGroups: [
          "",
          "小灵：宿主！身体要凉了！快激活系统，觉醒满级剑意！",
          "陆沉：小灵，好久不见。拿回我的剑，审判这群蝼蚁。",
        ],
      },
    );

    expect(promptText).toContain("分镜2（3-6秒）：扎着双马尾的剑灵小灵凭空显现，怀里紧紧抱着一把巨大的锈蚀断剑，神色焦急地飘到陆沉面前");
    expect(promptText).toContain("分镜3（6-9秒）：陆沉嘴角勾起一抹冷酷的弧度，右手朝着虚空猛然一握，眼神中透露出无情的杀意");
    expect(promptText).toContain("\n小灵：宿主！身体要凉了！快激活系统，觉醒满级剑意！");
    expect(promptText).toContain("\n陆沉：小灵，好久不见。拿回我的剑，审判这群蝼蚁。");
    expect(promptText).not.toContain("面前；小灵");
    expect(promptText).not.toContain("杀意；陆沉");
    expect(promptText.match(/小灵：宿主！身体要凉了！快激活系统，觉醒满级剑意！/g)?.length).toBe(1);
    expect(promptText.match(/陆沉：小灵，好久不见。拿回我的剑，审判这群蝼蚁。/g)?.length).toBe(1);
  });

  it("keeps the canonical detailed segment prompt stable when normalized twice", () => {
    const rawPrompt = [
      "全局风格：电影级古装玄幻短剧质感，15秒，烈日灼烧下的压抑肃杀氛围与冷调高反差并存。",
      "视觉锚点：陆沉满身血迹被粗重玄铁锁链贯穿钉在刑台铜柱上，蒋家执事持剔骨尖刀逼近，青石刑台与粗粝石壁保持一致。",
      "起始衔接：从上一片段刑台死寂的停点直接接入，镜头一落地就锁住陆沉垂头喘息后的再度抬眼，不重演上一段受刑过程。",
      "衔接原则：全段沿同一条长片时间线推进，按已拆解分镜顺序逐镜接力，保持人物朝向、镜头轴线、主光方向和刑台空间关系连续。",
      [
        "镜头推进：",
        "分镜1（0-3秒）：烈日白火压着刑台青石反光，镜头从低角度缓慢推近陆沉胸前交错的锁链与伤口，血迹顺着锁链纹理往下滑落。",
        "分镜2（3-6秒）：镜头贴近陆沉侧脸，他低垂着头艰难抬眼，黑发遮住半张脸，呼吸沉重，眼底压着尚未熄灭的狠意。",
        "分镜3（6-9秒）：蒋家执事半步踏上刑台，剔骨尖刀带着寒光逼近陆沉喉前，刀锋映出他扭曲却兴奋的笑意，音频：蒋家执事：“陆沉，今天你这废柴就彻底消失吧！”",
        "分镜4（9-12秒）：镜头微微横移到围观者与刑台边缘，旁侧围观人群神色冷漠，有人嘴角带笑，空气里混着热浪、灰屑与低声讥笑。",
        "分镜5（12-15秒）：镜头压到极近特写，剔骨尖刀几乎贴上陆沉胸口血洞，陆沉忽然强撑抬眼直视对方，眼神里闪出一丝反扑前的寒芒。",
      ].join("\n"),
      "环境细节：烈日热浪压得空气轻微扭曲，青石地面蒸腾白光，锁链金属摩擦、血滴落地与远处低笑混在一起持续回响。",
      "结尾钩子：最后一镜停在刀尖逼近伤口而陆沉忽然抬眼的瞬间，让下一片段直接接上他的反扑起势。",
      "通用后缀：无字幕、无水印、无屏幕文字",
    ].join("\n");
    const promptText = formatDetailedSegmentPrompt(
      rawPrompt,
    );

    expect(promptText).not.toContain("视觉锚点：");
    expect(promptText).not.toContain("起始衔接：");
    expect(promptText).not.toContain("衔接原则：");
    expect(promptText).not.toContain("镜头推进：");
    expect(formatDetailedSegmentPrompt(promptText)).toBe(promptText);
  });

  it("rejects segment prompts whose named sections are present but still too terse", () => {
    expect(() =>
      formatDetailedSegmentPrompt(
        [
          "全局风格：压迫感。",
          "视觉锚点：刑台。",
          "起始衔接：直接接上。",
          "衔接原则：顺拍。",
          "镜头推进：",
          "分镜1（0-3秒）：陆沉抬头。",
          "环境细节：有风。",
          "结尾钩子：他看人。",
          "通用后缀：无字幕、无水印、无屏幕文字",
        ].join("\n"),
      ),
    ).toThrow("segment prompt sections too terse");
  });

  it("submits HappyHorse text-to-video through the Aliyun DashScope async task contract", async () => {
    saveApiConfig({
      aliyunEndpoint:
        "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
      aliyunKey: "test-aliyun-key",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: {
            task_id: "happyhorse-task-t2v",
            task_status: "PENDING",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "happyhorse text-to-video prompt",
      duration: 3,
      aspectRatio: "16:9",
      resolution: "1080p",
      model: "happyhorse-1.0",
      provider: "aliyun",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      task_id: "happyhorse-task-t2v",
      status: "PENDING",
      provider: "aliyun",
    });

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
    );
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer test-aliyun-key",
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
      }),
    );
    const payload = JSON.parse(String(request.body));
    expect(payload).toEqual(
      expect.objectContaining({
        model: "happyhorse-1.0-t2v",
        input: {
          prompt: "happyhorse text-to-video prompt",
        },
        parameters: expect.objectContaining({
          resolution: "1080P",
          duration: 3,
          ratio: "16:9",
        }),
      }),
    );
  });

  it("routes a single HappyHorse reference image through i2v while keeping one visible model alias", async () => {
    saveApiConfig({
      aliyunEndpoint:
        "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
      aliyunKey: "test-aliyun-key",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: {
            task_id: "happyhorse-task-i2v",
            task_status: "RUNNING",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "happyhorse image-to-video prompt",
      duration: 4,
      aspectRatio: "9:16",
      resolution: "720p",
      model: "happyhorse-1.0",
      provider: "aliyun",
      imageUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3X8AAAAASUVORK5CYII=",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      task_id: "happyhorse-task-i2v",
      status: "RUNNING",
      provider: "aliyun",
    });
    const payload = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
    expect(payload.model).toBe("happyhorse-1.0-i2v");
    expect(payload.input.media).toEqual([
      expect.objectContaining({
        type: "first_frame",
        url: expect.stringMatching(/^data:image\/png;base64,/),
      }),
    ]);
    expect(payload.parameters).toEqual(
      expect.objectContaining({
        resolution: "720P",
        duration: 4,
      }),
    );
    expect(payload.parameters).not.toHaveProperty("ratio");
  });

  it("prefers HappyHorse reference-to-video when multiple reference images are available", async () => {
    saveApiConfig({
      aliyunEndpoint:
        "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
      aliyunKey: "test-aliyun-key",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: {
            task_id: "happyhorse-task-r2v",
            task_status: "QUEUED",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "happyhorse reference-to-video prompt",
      duration: 5,
      aspectRatio: "4:5",
      resolution: "720p",
      model: "happyhorse-1.0",
      provider: "aliyun",
      referenceImageUrls: [
        "https://example.com/ref-1.jpg",
        "https://example.com/ref-2.jpg",
        "https://example.com/ref-3.jpg",
      ],
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      task_id: "happyhorse-task-r2v",
      status: "QUEUED",
      provider: "aliyun",
    });
    const payload = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
    expect(payload.model).toBe("happyhorse-1.0-r2v");
    expect(payload.input.media).toEqual([
      { type: "reference_image", url: "https://example.com/ref-1.jpg" },
      { type: "reference_image", url: "https://example.com/ref-2.jpg" },
      { type: "reference_image", url: "https://example.com/ref-3.jpg" },
    ]);
    expect(payload.parameters).toEqual(
      expect.objectContaining({
        resolution: "720P",
        duration: 5,
        ratio: "4:5",
      }),
    );
  });

  it("logs the submitted HappyHorse prompt text for multi-reference requests", async () => {
    saveApiConfig({
      aliyunEndpoint:
        "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
      aliyunKey: "test-aliyun-key",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: {
            task_id: "happyhorse-task-r2v-log",
            task_status: "QUEUED",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await invokeFunction("generate-video", {
        prompt: "happyhorse prompt logging sample",
        duration: 5,
        aspectRatio: "16:9",
        resolution: "720p",
        model: "happyhorse-1.0",
        provider: "aliyun",
        referenceImageUrls: [
          "https://example.com/ref-1.jpg",
          "https://example.com/ref-2.jpg",
        ],
      });

      expect(result.error).toBeNull();
      const logOutput = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logOutput).toContain("provider=aliyun");
      expect(logOutput).toContain("model=happyhorse-1.0-r2v");
      expect(logOutput).toContain("[video] prompt begin");
      expect(logOutput).toContain("happyhorse prompt logging sample");
      expect(logOutput).toContain("[video] prompt end");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("logs the exact normalized Seedance prompt that is actually submitted", async () => {
    saveApiConfig({
      jimengEndpoint: "https://seedance.example.com/v1beta",
      jimengKey: "test-jimeng-key",
      jimengExecutionMode: "api",
      geminiEndpoint: "https://seedance.example.com/v1beta",
      geminiKey: "test-gemini-key",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          task_id: "seedance-task-log",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await invokeFunction("generate-video", {
        prompt: "电影级追击风格，5秒，女主在雨夜巷道里回头搜寻追兵。",
        duration: 5,
        aspectRatio: "16:9",
        resolution: "720p",
        model: "doubao-seedance-1-5-pro_720p",
        provider: "jimeng",
      });

      expect(result.error).toBeNull();
      const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      const formData = request.body as FormData;
      const submittedPrompt = String(formData.get("prompt") || "");
      const logOutput = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      const loggedPrompt = logOutput.match(/\[video\] prompt begin\n([\s\S]*?)\n\[video\] prompt end/)?.[1] || "";

      expect(loggedPrompt).toBe(submittedPrompt);
      expect(submittedPrompt).toContain("4秒");
      expect(submittedPrompt).not.toContain("5秒");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("logs the final submitted prompt even when a dedicated log prompt is provided", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.example.com/api/v3/contents/generations/tasks",
      jimengKey: "test-jimeng-key",
      jimengExecutionMode: "api",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ark-log-prompt-task",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const submittedPrompt = [
        "电影级真人武侠奇幻风格，10秒，氛围压抑粗粝。",
        "",
        "烈日笼罩下的青云宗演武场，苏辰血脸破碎黑袍，叶昊白袍金色灵剑。",
        "",
        "分镜1（0-5秒）：",
        "电影感广角镜头缓缓推进，苏辰虚弱地躺在巨大深坑中。",
        "",
        "通用后缀： 无字幕、无水印、无屏幕文字",
      ].join("\n");
      const logPrompt = [
        "电影级真人武侠奇幻风格，10秒，氛围压抑粗粝。",
        "视觉锚点：烈日笼罩下的青云宗演武场，苏辰血脸破碎黑袍，叶昊白袍金色灵剑。",
        "分镜1（0-5秒）：电影感广角镜头缓缓推进，苏辰虚弱地躺在巨大深坑中。",
        "通用后缀： 无字幕、无水印、无屏幕文字",
      ].join("\n");

      const result = await invokeFunction("generate-video", {
        prompt: submittedPrompt,
        logPrompt,
        duration: 10,
        aspectRatio: "16:9",
        resolution: "720p",
        model: "doubao-seedance-1-5-pro_720p",
        provider: "jimeng",
      });

      expect(result.error).toBeNull();
      const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      const payload = JSON.parse(String(request.body || "{}"));
      const submittedText = String(payload?.content?.[0]?.text || "");
      const logOutput = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      const loggedPrompt = logOutput.match(/\[video\] prompt begin\n([\s\S]*?)\n\[video\] prompt end/)?.[1] || "";

      expect(submittedText).toBe(submittedPrompt);
      expect(loggedPrompt).toBe(submittedText);
      expect(loggedPrompt).not.toBe(logPrompt);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("polls HappyHorse task status from the DashScope task endpoint", async () => {
    saveApiConfig({
      aliyunEndpoint:
        "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
      aliyunKey: "test-aliyun-key",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: {
            task_status: "SUCCEEDED",
            results: [{ url: "https://cdn.example.com/happyhorse.mp4" }],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      action: "status",
      taskId: "happyhorse-task-status",
      provider: "aliyun",
      model: "happyhorse-1.0",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      status: "succeeded",
      video_url: "https://cdn.example.com/happyhorse.mp4",
      state: "SUCCEEDED",
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://dashscope.aliyuncs.com/api/v1/tasks/happyhorse-task-status",
    );
  });

  it("logs HappyHorse status updates while polling tasks", async () => {
    saveApiConfig({
      aliyunEndpoint:
        "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
      aliyunKey: "test-aliyun-key",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: {
            task_status: "PENDING",
            prompt_tips: "Keep the reference character identity stable.",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await invokeFunction("generate-video", {
        action: "status",
        taskId: "happyhorse-task-progress",
        provider: "aliyun",
        model: "happyhorse-1.0",
      });

      expect(result.error).toBeNull();
      expect(result.data).toEqual({
        status: "queued",
        state: "PENDING",
        prompt_tips: "Keep the reference character identity stable.",
      });
      const logOutput = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logOutput).toContain("taskId=happyhorse-task-progress");
      expect(logOutput).toContain("provider=aliyun");
      expect(logOutput).toContain("status=queued");
      expect(logOutput).toContain("promptTips=Keep the reference character identity stable.");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("cancels HappyHorse tasks through the DashScope cancel endpoint", async () => {
    saveApiConfig({
      aliyunEndpoint:
        "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
      aliyunKey: "test-aliyun-key",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: {
            task_id: "happyhorse-task-cancel",
            task_status: "CANCELED",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      action: "cancel",
      taskId: "happyhorse-task-cancel",
      provider: "aliyun",
      model: "happyhorse-1.0",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      task_id: "happyhorse-task-cancel",
      status: "cancelled",
      provider: "aliyun",
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://dashscope.aliyuncs.com/api/v1/tasks/happyhorse-task-cancel/cancel",
    );
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit).method).toBe("POST");
  });

  it("falls back from the RunningHub HappyHorse route to the official Aliyun route when submission fails", async () => {
    saveApiConfig({
      aliyunEndpoint:
        "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
      aliyunKey: "test-aliyun-key",
      runninghubEndpoint: "https://www.runninghub.cn",
      runninghubKey: "test-runninghub-key",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errorCode: "QuotaExceeded",
            errorMessage: "RunningHub HappyHorse capacity is temporarily exhausted.",
          }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              task_id: "happyhorse-task-official-fallback",
              task_status: "PENDING",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    const result = await invokeFunction("generate-video", {
      prompt: "happyhorse moderation fallback prompt",
      duration: 3,
      aspectRatio: "9:16",
      resolution: "1080p",
      model: "happyhorse-1.0",
      provider: "runninghub-happyhorse",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      task_id: "happyhorse-task-official-fallback",
      status: "PENDING",
      provider: "aliyun",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://www.runninghub.cn/openapi/v2/alibaba/happyhorse-1.0/text-to-video",
    );
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
    );
    const primaryRequest = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(primaryRequest.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer test-runninghub-key",
        "Content-Type": "application/json",
      }),
    );
    const primaryPayload = JSON.parse(String(primaryRequest.body));
    expect(primaryPayload).toEqual(
      expect.objectContaining({
        prompt: expect.stringContaining("happyhorse moderation fallback prompt"),
        resolution: "1080p",
        duration: 3,
        aspectRatio: "9:16",
      }),
    );
    const fallbackRequest = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    expect(fallbackRequest.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer test-aliyun-key",
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
      }),
    );
  });

  it("submits Tuzi-backed Jimeng video generation through the Ark task contract", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "video-task-123",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "测试视频提示词",
      aspectRatio: "16:9",
      resolution: "1080p",
      model: "doubao-seedance-1-5-pro_1080p",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      task_id: "video-task-123",
      status: "queued",
      progress: 0,
      provider: "jimeng",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://api.tu-zi.com/doubao/api/v3/contents/generations/tasks",
    );

    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe("POST");
    expect(request.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer test-jimeng-key",
        "Content-Type": "application/json",
      }),
    );

    const payload = JSON.parse(String(request.body));
    expect(payload).toEqual(
      expect.objectContaining({
        model: "ep-m-20260414192742-59w88",
        resolution: "1080p",
        duration: 5,
        ratio: "16:9",
        watermark: false,
      }),
    );
    expect(payload.content).toEqual([
      {
        type: "text",
        text: "测试视频提示词",
      },
    ]);
  });

  it("keeps the selected 480p Ark model mapping when the Tuzi-backed Jimeng route is used", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "video-task-480p",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "Keep the cinematic chase energy across the full 4-second beat.",
      duration: 4,
      aspectRatio: "16:9",
      resolution: "480p",
      model: "doubao-seedance-1-5-pro_480p",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.model).toBe("ep-m-20260414192742-59w88");
    expect(payload.resolution).toBe("480p");
    expect(payload.duration).toBe(5);
    expect(payload.content).toEqual([
      {
        type: "text",
        text: "Keep the cinematic chase energy across the full 5-second beat.",
      },
    ]);
  });

  it("keeps the legacy /v1/videos multipart contract for non-Ark custom Jimeng gateways", async () => {
    saveApiConfig({
      jimengEndpoint: "https://seedance.example.com/v1beta",
      jimengKey: "test-jimeng-key",
      jimengExecutionMode: "api",
      geminiEndpoint: "https://seedance.example.com/v1beta",
      geminiKey: "test-gemini-key",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "video-task-duration-rewrite",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "Keep the cinematic chase energy across the full 4-second beat.",
      duration: 4,
      aspectRatio: "16:9",
      resolution: "480p",
      model: "doubao-seedance-1-5-pro_480p",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://seedance.example.com/v1/videos");
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = request.body as FormData;
    expect(body.get("model")).toBe("doubao-seedance-1-5-pro_480p");
    expect(body.get("size")).toBe("854x480");
    expect(body.get("seconds")).toBe("4");
    expect(body.get("prompt")).toBe(
      "Keep the cinematic chase energy across the full 4-second beat.",
    );
  });

  it("accepts camelCase taskId from the legacy Seedance gateway submit response", async () => {
    saveApiConfig({
      jimengEndpoint: "https://seedance.example.com/v1beta",
      jimengKey: "test-jimeng-key",
      jimengExecutionMode: "api",
      geminiEndpoint: "https://seedance.example.com/v1beta",
      geminiKey: "test-gemini-key",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          taskId: "legacy-camel-task-id",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "legacy seedance camel task id prompt",
      duration: 4,
      aspectRatio: "16:9",
      resolution: "480p",
      model: "doubao-seedance-1-5-pro_480p",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      task_id: "legacy-camel-task-id",
      status: "queued",
      progress: 0,
      provider: "jimeng",
    });
  });

  it("routes Seedance 2.0 2K requests directly to the RunningHub full model while keeping the existing params", async () => {
    saveApiConfig({
      runninghubEndpoint: "https://www.runninghub.cn",
      runninghubKey: "test-runninghub-key",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          taskId: "runninghub-seedance-2k-task",
          status: "QUEUED",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "runninghub seedance 2k prompt",
      duration: 4,
      aspectRatio: "4:5",
      resolution: "2k",
      model: "doubao-seedance-2-0-260128",
      videoMode: "text-to-video",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      task_id: "runninghub-seedance-2k-task",
      status: "QUEUED",
      provider: "runninghub-seedance",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://www.runninghub.cn/openapi/v2/rhart-video/sparkvideo-2.0/multimodal-video",
    );
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer test-runninghub-key",
        "Content-Type": "application/json",
      }),
    );
    const payload = JSON.parse(String(request.body));
    expect(payload).toEqual(
      expect.objectContaining({
        prompt: expect.stringContaining("runninghub seedance 2k prompt"),
        resolution: "2k",
        duration: 4,
        ratio: "3:4",
        realPersonMode: true,
      }),
    );
  });

  it("logs the exact RunningHub prompt that is actually submitted", async () => {
    saveApiConfig({
      runninghubEndpoint: "https://www.runninghub.cn",
      runninghubKey: "test-runninghub-key",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          taskId: "runninghub-prompt-log-task",
          status: "QUEUED",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await invokeFunction("generate-video", {
        prompt: "电影级真人动作风格，4秒，主角在走廊尽头回头确认追兵位置。",
        duration: 4,
        aspectRatio: "16:9",
        resolution: "2k",
        model: "doubao-seedance-2-0-260128",
        provider: "runninghub-seedance",
      });

      expect(result.error).toBeNull();
      const payload = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body || "{}"));
      const logOutput = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      const loggedPrompt = logOutput.match(/\[video\] prompt begin\n([\s\S]*?)\n\[video\] prompt end/)?.[1] || "";

      expect(loggedPrompt).toBe(String(payload.prompt || ""));
      expect(loggedPrompt).toContain("电影级真人动作风格");
      expect(logOutput).toContain("provider=runninghub-seedance");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("forwards the documented RunningHub multimodal params for Seedance 2.0 when they are provided", async () => {
    saveApiConfig({
      runninghubEndpoint: "https://www.runninghub.cn",
      runninghubKey: "test-runninghub-key",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          taskId: "runninghub-seedance-multimodal-task",
          status: "QUEUED",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "runninghub multimodal prompt",
      duration: 8,
      aspectRatio: "21:9",
      resolution: "2k",
      model: "doubao-seedance-2-0-260128",
      videoMode: "text-to-video",
      videoUrls: ["https://media.example.com/reference-video.mp4"],
      audioUrls: ["https://media.example.com/reference-audio.mp3"],
      generateAudio: false,
      realPersonMode: true,
      conversionSlots: ["image1", "video1"],
      returnLastFrame: true,
      seed: 42,
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      task_id: "runninghub-seedance-multimodal-task",
      status: "QUEUED",
      provider: "runninghub-seedance",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
    expect(payload).toEqual(
      expect.objectContaining({
        prompt: expect.stringContaining("runninghub multimodal prompt"),
        resolution: "2k",
        duration: 8,
        ratio: "21:9",
        generateAudio: false,
        realPersonMode: true,
        videoUrls: ["https://media.example.com/reference-video.mp4"],
        audioUrls: ["https://media.example.com/reference-audio.mp3"],
        conversionSlots: ["image1", "video1"],
        returnLastFrame: true,
        seed: 42,
      }),
    );
  });

  it("falls back from legacy Seedance moderation failures to the RunningHub full model", async () => {
    saveApiConfig({
      jimengEndpoint: "https://seedance.example.com/v1beta",
      jimengKey: "test-jimeng-key",
      jimengExecutionMode: "api",
      geminiEndpoint: "https://seedance.example.com/v1beta",
      geminiKey: "test-gemini-key",
      runninghubEndpoint: "https://www.runninghub.cn",
      runninghubKey: "test-runninghub-key",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errorCode: "SensitiveContentDetected",
            errorMessage: "Sensitive real person content failed moderation.",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "runninghub-legacy-seedance-task",
            status: "QUEUED",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    const result = await invokeFunction("generate-video", {
      prompt: "legacy seedance moderation fallback prompt",
      duration: 4,
      aspectRatio: "16:9",
      resolution: "1080p",
      model: "doubao-seedance-2-0-260128",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      task_id: "runninghub-legacy-seedance-task",
      status: "QUEUED",
      provider: "runninghub-seedance",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://seedance.example.com/v1/videos");
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(
      "https://www.runninghub.cn/openapi/v2/rhart-video/sparkvideo-2.0/multimodal-video",
    );
    const fallbackPayload = JSON.parse(String((fetchSpy.mock.calls[1]?.[1] as RequestInit).body));
    expect(fallbackPayload).toEqual(
      expect.objectContaining({
        prompt: expect.stringContaining("legacy seedance moderation fallback prompt"),
        resolution: "1080p",
        duration: 4,
        ratio: "16:9",
      }),
    );
  });

  it("uploads non-public RunningHub fallback references before submitting the full Seedance task", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
      modelMappings: {},
      runninghubEndpoint: "https://www.runninghub.cn",
      runninghubKey: "test-runninghub-key",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errorCode: "InputImageSensitiveContentDetected.PrivacyInformation",
            errorMessage: "Real person moderation blocked the official channel.",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 200,
            data: {
              download_url: "https://www.runninghub.cn/view?filename=ref-1.png&type=input",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 200,
            data: {
              download_url: "https://www.runninghub.cn/view?filename=ref-2.jpg&type=input",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "runninghub-uploaded-reference-task",
            status: "QUEUED",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    const result = await invokeFunction("generate-video", {
      prompt: "runninghub uploaded reference fallback prompt",
      imageUrl: "data:image/png;base64,AQID",
      referenceImageUrls: ["data:image/jpeg;base64,BAUG"],
      duration: 4,
      aspectRatio: "16:9",
      resolution: "1080p",
      model: "doubao-seedance-2-0-260128",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      task_id: "runninghub-uploaded-reference-task",
      status: "QUEUED",
      provider: "runninghub-seedance",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://www.runninghub.cn/openapi/v2/media/upload/binary");
    expect(fetchSpy.mock.calls[2]?.[0]).toBe("https://www.runninghub.cn/openapi/v2/media/upload/binary");
    const firstUploadRequest = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    const secondUploadRequest = fetchSpy.mock.calls[2]?.[1] as RequestInit;
    expect(firstUploadRequest.method).toBe("POST");
    expect(secondUploadRequest.method).toBe("POST");
    expect(firstUploadRequest.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer test-runninghub-key",
      }),
    );
    expect(secondUploadRequest.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer test-runninghub-key",
      }),
    );
    expect(firstUploadRequest.body).toBeInstanceOf(FormData);
    expect(secondUploadRequest.body).toBeInstanceOf(FormData);
    const fallbackPayload = JSON.parse(String((fetchSpy.mock.calls[3]?.[1] as RequestInit).body));
    expect(fallbackPayload).toEqual(
      expect.objectContaining({
        prompt: expect.stringContaining("runninghub uploaded reference fallback prompt"),
        resolution: "1080p",
        duration: 4,
        ratio: "16:9",
        realPersonMode: true,
        imageUrls: [
          "https://www.runninghub.cn/view?filename=ref-1.png&type=input",
          "https://www.runninghub.cn/view?filename=ref-2.jpg&type=input",
        ],
      }),
    );
  });

  it("surfaces a RunningHub response message when the task submission response still has no task id", async () => {
    saveApiConfig({
      runninghubEndpoint: "https://www.runninghub.cn",
      runninghubKey: "test-runninghub-key",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 4001,
          message: "imageUrls must be publicly accessible",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "runninghub malformed response prompt",
      duration: 4,
      aspectRatio: "16:9",
      resolution: "2k",
      model: "doubao-seedance-2-0-260128",
      videoMode: "text-to-video",
    });

    expect(result.data).toBeNull();
    expect(String(result.error?.message || "")).toContain(
      "RunningHub 视频任务提交失败：imageUrls must be publicly accessible",
    );
  });

  it("polls RunningHub video task status through the shared query endpoint", async () => {
    saveApiConfig({
      runninghubEndpoint: "https://www.runninghub.cn",
      runninghubKey: "test-runninghub-key",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "SUCCESS",
          results: [
            { type: "video", url: "https://cdn.example.com/runninghub-video.mp4" },
            { type: "image", url: "https://cdn.example.com/runninghub-last-frame.jpg" },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      action: "status",
      taskId: "runninghub-task-status",
      provider: "runninghub-seedance",
      model: "doubao-seedance-2-0-260128",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      status: "succeeded",
      video_url: "https://cdn.example.com/runninghub-video.mp4",
      last_frame_url: "https://cdn.example.com/runninghub-last-frame.jpg",
      state: "SUCCESS",
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://www.runninghub.cn/openapi/v2/query");
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit).method).toBe("POST");
  });

  it("returns RunningHub failure details during status polling", async () => {
    saveApiConfig({
      runninghubEndpoint: "https://www.runninghub.cn",
      runninghubKey: "test-runninghub-key",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "FAILED",
          errorCode: "1505",
          errorMessage: "Current mode does not support real-person content. To enable it, set realPersonMode to true",
          promptTips: "Use the real-person mode for portrait references.",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      action: "status",
      taskId: "runninghub-task-failed",
      provider: "runninghub-seedance",
      model: "doubao-seedance-2-0-260128",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      status: "failed",
      state: "FAILED",
      error_code: "1505",
      error_message:
        "Current mode does not support real-person content. To enable it, set realPersonMode to true",
      prompt_tips: "Use the real-person mode for portrait references.",
    });
  });

  it("submits a storyboard frame as first_frame content when image-to-video input is provided", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "video-task-789",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "text-only storyboard derived video prompt",
      imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3X8AAAAASUVORK5CYII=",
      aspectRatio: "16:9",
      resolution: "1080p",
      model: "doubao-seedance-1-5-pro_1080p",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.content[0]).toEqual({
      type: "text",
      text: "text-only storyboard derived video prompt",
    });
    expect(payload.content[1]).toEqual(
      expect.objectContaining({
        type: "image_url",
        role: "first_frame",
      }),
    );
  });

  it("submits Ark video generation tasks when the Jimeng endpoint points to contents/generations/tasks", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
      modelMappings: {
        "doubao-seedance-1-5-pro_1080p": "doubao-seedance-1-5-pro-251215",
      },
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ark-task-123",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "ark text to video prompt",
      resolution: "1080p",
      duration: 4,
      aspectRatio: "16:9",
      model: "doubao-seedance-1-5-pro_1080p",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks");

    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe("POST");
    expect(request.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer test-ark-key",
        "Content-Type": "application/json",
      }),
    );

    const payload = JSON.parse(String(request.body));
    expect(payload).toEqual(
      expect.objectContaining({
        model: "doubao-seedance-1-5-pro-251215",
        resolution: "1080p",
        duration: 5,
        ratio: "16:9",
        watermark: false,
      }),
    );
    expect(payload.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("ark text to video prompt"),
      },
    ]);
  });

  it("accepts camelCase taskId from the Ark submit response", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
      modelMappings: {
        "doubao-seedance-1-5-pro_1080p": "doubao-seedance-1-5-pro-251215",
      },
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          taskId: "ark-camel-task-id",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "ark camel task id prompt",
      resolution: "1080p",
      duration: 4,
      aspectRatio: "16:9",
      model: "doubao-seedance-1-5-pro_1080p",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      task_id: "ark-camel-task-id",
      status: "queued",
      progress: 0,
      provider: "jimeng",
    });
  });

  it("normalizes short Ark video durations up to the Seedance minimum", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
      modelMappings: {
        "doubao-seedance-1-5-pro_480p": "ep-m-20260414192742-59w88",
      },
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ark-task-min-duration",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "ark short duration prompt",
      resolution: "480p",
      duration: 4,
      aspectRatio: "16:9",
      model: "doubao-seedance-1-5-pro_480p",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.duration).toBe(5);
  });

  it("passes the official Seedance 2.0 model id through the Ark contract and keeps the 15-second max", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
      modelMappings: {},
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ark-task-seedance-2-0",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "ark seedance 2.0 prompt",
      resolution: "1080p",
      duration: 15,
      aspectRatio: "16:9",
      model: "doubao-seedance-2-0-260128",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload).toEqual(
      expect.objectContaining({
        model: "doubao-seedance-2-0-260128",
        resolution: "1080p",
        duration: 15,
        ratio: "16:9",
      }),
    );
  });

  it("passes the official Seedance 2.0 Fast model id through the Ark contract", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
      modelMappings: {},
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ark-task-seedance-2-0-fast",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "ark seedance 2.0 fast prompt",
      resolution: "720p",
      duration: 4,
      aspectRatio: "9:16",
      model: "doubao-seedance-2-0-fast-260128",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload).toEqual(
      expect.objectContaining({
        model: "doubao-seedance-2-0-fast-260128",
        resolution: "720p",
        duration: 4,
        ratio: "9:16",
      }),
    );
  });

  it("uses the Ark reference-image contract for Seedance 2.0 when multiple reference images are available", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
      modelMappings: {},
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ark-task-seedance-2-0-multi-ref",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "ark seedance 2.0 multi reference prompt",
      imageUrl: "https://example.com/ref-1.jpg",
      referenceImageUrls: [
        "https://example.com/ref-1.jpg",
        "https://example.com/ref-2.jpg",
        "https://example.com/ref-3.jpg",
      ],
      resolution: "720p",
      duration: 4,
      aspectRatio: "16:9",
      model: "doubao-seedance-2-0-260128",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("ark seedance 2.0 multi reference prompt"),
      },
      {
        type: "image_url",
        role: "reference_image",
        image_url: { url: "https://example.com/ref-1.jpg" },
      },
      {
        type: "image_url",
        role: "reference_image",
        image_url: { url: "https://example.com/ref-2.jpg" },
      },
      {
        type: "image_url",
        role: "reference_image",
        image_url: { url: "https://example.com/ref-3.jpg" },
      },
    ]);
  });

  it("uses the Ark first-frame role for the first multi-reference image when the workflow marks it as a continuity frame", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
      modelMappings: {},
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ark-task-seedance-2-0-continuity-first-frame",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "ark seedance 2.0 continuity prompt",
      imageUrl: "https://example.com/continuity-frame.jpg",
      referenceImageUrls: [
        "https://example.com/continuity-frame.jpg",
        "https://example.com/ref-2.jpg",
        "https://example.com/ref-3.jpg",
      ],
      preferFirstFrameReference: true,
      resolution: "720p",
      duration: 4,
      aspectRatio: "16:9",
      model: "doubao-seedance-2-0-260128",
      provider: "jimeng",
    });

    expect(result.error).toBeInstanceOf(Error);
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("ark seedance 2.0 continuity prompt"),
      },
      {
        type: "image_url",
        role: "first_frame",
        image_url: { url: "https://example.com/continuity-frame.jpg" },
      },
      {
        type: "image_url",
        role: "reference_image",
        image_url: { url: "https://example.com/ref-2.jpg" },
      },
      {
        type: "image_url",
        role: "reference_image",
        image_url: { url: "https://example.com/ref-3.jpg" },
      },
    ]);
  });

  it("logs reference asset labels when provided by the workflow", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
      modelMappings: {},
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ark-task-seedance-2-0-debug-labels",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await invokeFunction("generate-video", {
        prompt: "ark seedance reference label prompt",
        imageUrl: "https://example.com/ref-1.jpg",
        referenceImageUrls: [
          "https://example.com/ref-1.jpg",
          "https://example.com/ref-2.jpg",
        ],
        referenceImageDebugInfo: [
          {
            url: "https://example.com/ref-1.jpg",
            label: "场景主图 · 医院走廊",
            kind: "scene-primary",
            entityName: "医院走廊",
            sceneName: "医院走廊",
            sceneNumbers: [1],
          },
          {
            url: "https://example.com/ref-2.jpg",
            label: "角色主图 · 林晓晓",
            kind: "character-primary",
            entityName: "林晓晓",
            sceneName: "医院走廊",
            sceneNumbers: [1],
          },
        ],
        resolution: "720p",
        duration: 4,
        aspectRatio: "16:9",
        model: "doubao-seedance-2-0-260128",
        provider: "jimeng",
      });

      expect(result.error).toBeNull();
      const logOutput = consoleSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logOutput).toContain("\"referenceAssets\":\"（场景主图 · 医院走廊、角色主图 · 林晓晓）\"");
      expect(logOutput).toContain("\"submittedReferenceAssets\":\"（场景主图 · 医院走廊、角色主图 · 林晓晓）\"");
      expect(logOutput).not.toContain("\"fileName\":");
      expect(logOutput).not.toContain("\"url\":");
      expect(logOutput).not.toContain("\"kind\":");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("falls back from Seedance 2.0 Fast to Seedance 2.0 after an Ark unavailable-channel response", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
      modelMappings: {},
      retryCount: 0,
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: "所有令牌分组 Geminicli,default 下对于模型 doubao-seedance-2-0-fast-260128 均无可用渠道",
          }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "ark-task-seedance-2-0-fallback",
            status: "queued",
            progress: 0,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    const result = await invokeFunction("generate-video", {
      prompt: "ark seedance fallback prompt",
      resolution: "720p",
      duration: 4,
      aspectRatio: "16:9",
      model: "doubao-seedance-2-0-fast-260128",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstPayload = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
    const secondPayload = JSON.parse(String((fetchSpy.mock.calls[1]?.[1] as RequestInit).body));
    expect(firstPayload.model).toBe("doubao-seedance-2-0-fast-260128");
    expect(secondPayload.model).toBe("doubao-seedance-2-0-260128");
  });

  it("falls back from Ark Seedance 2.0 Fast moderation failures to the RunningHub fast route", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
      modelMappings: {},
      runninghubEndpoint: "https://www.runninghub.cn",
      runninghubKey: "test-runninghub-key",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errorCode: "InputImageSensitiveContentDetected",
            errorMessage: "Sensitive real person content failed moderation.",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            taskId: "runninghub-ark-fast-task",
            status: "QUEUED",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    const result = await invokeFunction("generate-video", {
      prompt: "ark moderation fallback prompt",
      resolution: "720p",
      duration: 4,
      aspectRatio: "9:16",
      model: "doubao-seedance-2-0-fast-260128",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      task_id: "runninghub-ark-fast-task",
      status: "QUEUED",
      provider: "runninghub-seedance-fast",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
    );
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(
      "https://www.runninghub.cn/openapi/v2/bytedance/seedance-2.0-global-fast/multimodal-video",
    );
    const fallbackPayload = JSON.parse(String((fetchSpy.mock.calls[1]?.[1] as RequestInit).body));
    expect(fallbackPayload).toEqual(
      expect.objectContaining({
        prompt: expect.stringContaining("ark moderation fallback prompt"),
        resolution: "720p",
        duration: 4,
        ratio: "9:16",
      }),
    );
  });

  it("keeps Seedance 1.5 Pro on the single first-frame Ark contract even if extra references are supplied", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
      modelMappings: {},
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ark-task-seedance-1-5-single-ref",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "ark seedance 1.5 fallback prompt",
      imageUrl: "https://example.com/ref-1.jpg",
      referenceImageUrls: [
        "https://example.com/ref-1.jpg",
        "https://example.com/ref-2.jpg",
      ],
      resolution: "720p",
      duration: 5,
      aspectRatio: "16:9",
      model: "doubao-seedance-1-5-pro_720p",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("ark seedance 1.5 fallback prompt"),
      },
      {
        type: "image_url",
        role: "first_frame",
        image_url: { url: "https://example.com/ref-1.jpg" },
      },
    ]);
  });

  it("surfaces actionable Ark permission details when video task creation is forbidden", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
      modelMappings: {
        "doubao-seedance-1-5-pro_1080p": "ep-m-20260414192742-59w88",
      },
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: "OperationDenied.ServiceNotOpen",
          message: "service not open",
          request_id: "req-ark-403",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "ark forbidden prompt",
      resolution: "1080p",
      duration: 4,
      aspectRatio: "16:9",
      model: "doubao-seedance-1-5-pro_1080p",
      provider: "jimeng",
    });

    expect(result.data).toBeNull();
    expect(result.error?.message).toContain("Ark 视频生成任务创建失败 (403)");
    expect(result.error?.message).toContain("OperationDenied.ServiceNotOpen");
    expect(result.error?.message).toContain("当前 Ark 账号或 API Key 尚未开通该视频能力");
    expect(result.error?.message).toContain("request_id: req-ark-403");
  });

  it("converts local storyboard file paths into data URLs before submitting Ark image-to-video tasks", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
    });

    window.electronAPI = {
      runtime: {
        builtinApiBundle: null,
        builtinApiBundlePath: "",
        verifyBuiltinApiAdminPassword: async () => true,
      },
      storage: {
        readBase64: async () => ({
          ok: true,
          exists: true,
          base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3X8AAAAASUVORK5CYII=",
          mimeType: "image/png",
        }),
      },
    } as typeof window.electronAPI;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ark-task-i2v-123",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "ark image to video prompt",
      imageUrl: "C:\\temp\\storyboard-frame.png",
      resolution: "720p",
      duration: 4,
      aspectRatio: "16:9",
      model: "doubao-seedance-1-5-pro_720p",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("ark image to video prompt"),
      },
      expect.objectContaining({
        type: "image_url",
        role: "first_frame",
        image_url: expect.objectContaining({
          url: expect.stringMatching(/^data:image\/png;base64,/),
        }),
      }),
    ]);
  });

  it("falls back to the bundled Ark endpoint id when no local model mapping is stored", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
      modelMappings: {},
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ark-task-fallback-123",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "ark fallback mapping prompt",
      resolution: "1080p",
      duration: 4,
      aspectRatio: "16:9",
      model: "doubao-seedance-1-5-pro_1080p",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.model).toBe("ep-m-20260414192742-59w88");
  });

  it("also falls back to the bundled Ark endpoint id for 480p requests", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
      modelMappings: {},
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "ark-task-fallback-480p",
          status: "queued",
          progress: 0,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      prompt: "ark fallback mapping 480p prompt",
      resolution: "480p",
      duration: 4,
      aspectRatio: "16:9",
      model: "doubao-seedance-1-5-pro_480p",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload.model).toBe("ep-m-20260414192742-59w88");
    expect(payload.resolution).toBe("480p");
  });

  it("polls Ark video task status from contents/generations/tasks/{taskId}", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "completed",
          content: {
            video_url: "https://cdn.example.com/ark-video.mp4",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      action: "status",
      taskId: "ark-task-456",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      status: "succeeded",
      video_url: "https://cdn.example.com/ark-video.mp4",
      state: "completed",
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/ark-task-456",
    );
  });

  it("polls Tuzi-backed Jimeng video status from the Ark task route", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "completed",
          progress: 100,
          video_url: "https://cdn.example.com/video.mp4",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      action: "status",
      taskId: "video-task-456",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      status: "succeeded",
      video_url: "https://cdn.example.com/video.mp4",
      state: "completed",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://api.tu-zi.com/doubao/api/v3/contents/generations/tasks/video-task-456",
    );

    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe("GET");
    expect(request.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer test-jimeng-key",
      }),
    );
  });

  it("normalizes nested Ark video urls during status polling", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
        status: "completed",
        output: {
          videos: [{ url: "https://cdn.example.com/video-nested.mp4" }],
        },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      action: "status",
      taskId: "video-task-nested-456",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual(
      expect.objectContaining({
        status: "succeeded",
        video_url: "https://cdn.example.com/video-nested.mp4",
      }),
    );
  });

  it("polls legacy Seedance video status from /v1/videos/{taskId} for custom gateways", async () => {
    saveApiConfig({
      jimengEndpoint: "https://seedance.example.com/v1beta",
      jimengKey: "test-jimeng-key",
      jimengExecutionMode: "api",
      geminiEndpoint: "https://seedance.example.com/v1beta",
      geminiKey: "test-gemini-key",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "completed",
          progress: 100,
          video_url: "https://cdn.example.com/video-legacy.mp4",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-video", {
      action: "status",
      taskId: "legacy-video-task-456",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      status: "completed",
      progress: 100,
      video_url: "https://cdn.example.com/video-legacy.mp4",
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://seedance.example.com/v1/videos/legacy-video-task-456",
    );
  });

  it("cancels Ark video tasks through contents/generations/tasks/{taskId}", async () => {
    saveApiConfig({
      jimengEndpoint: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
      jimengKey: "test-ark-key",
      jimengExecutionMode: "api",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 204,
      }),
    );

    const result = await invokeFunction("generate-video", {
      action: "cancel",
      taskId: "ark-task-789",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      task_id: "ark-task-789",
      status: "cancelled",
      provider: "jimeng",
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/ark-task-789",
    );
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit)?.method).toBe("DELETE");
  });

  it("cancels Tuzi-backed Jimeng video tasks through the Ark task route", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 204,
      }),
    );

    const result = await invokeFunction("generate-video", {
      action: "cancel",
      taskId: "video-task-999",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      task_id: "video-task-999",
      status: "cancelled",
      provider: "jimeng",
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://api.tu-zi.com/doubao/api/v3/contents/generations/tasks/video-task-999",
    );
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit)?.method).toBe("DELETE");
  });

  it("cancels legacy Seedance video tasks through /v1/videos/{taskId} for custom gateways", async () => {
    saveApiConfig({
      jimengEndpoint: "https://seedance.example.com/v1beta",
      jimengKey: "test-jimeng-key",
      jimengExecutionMode: "api",
      geminiEndpoint: "https://seedance.example.com/v1beta",
      geminiKey: "test-gemini-key",
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 204,
      }),
    );

    const result = await invokeFunction("generate-video", {
      action: "cancel",
      taskId: "legacy-video-task-999",
      provider: "jimeng",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      task_id: "legacy-video-task-999",
      status: "cancelled",
      provider: "jimeng",
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://seedance.example.com/v1/videos/legacy-video-task-999",
    );
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit)?.method).toBe("DELETE");
  });

  it.skip("rejects decompositions that exceed the prompt shot ceiling", () => {
    expect(() =>
      validateDecomposeSceneCounts(
        [
          { segmentLabel: "1-1", description: "a" },
          { segmentLabel: "1-1", description: "b" },
          { segmentLabel: "1-1", description: "c" },
          { segmentLabel: "1-1", description: "d" },
          { segmentLabel: "1-1", description: "e" },
          { segmentLabel: "1-1", description: "f" },
          { segmentLabel: "1-2", description: "g" },
          { segmentLabel: "1-2", description: "h" },
          { segmentLabel: "1-2", description: "i" },
          { segmentLabel: "1-3", description: "j" },
          { segmentLabel: "1-3", description: "k" },
          { segmentLabel: "1-3", description: "l" },
          { segmentLabel: "1-4", description: "m" },
          { segmentLabel: "1-4", description: "n" },
          { segmentLabel: "1-4", description: "o" },
          { segmentLabel: "1-5", description: "p" },
          { segmentLabel: "1-5", description: "q" },
          { segmentLabel: "1-5", description: "r" },
        ],
        { segmentsTarget: 5, videoPace: "medium" },
      ),
    ).toThrow(/涓婇檺/);
  });

  it.skip("rejects decompositions that keep dialogue inside description", () => {
    expect(() =>
      validateDecomposeSceneCounts(
        [
          { segmentLabel: "1-1", description: "沈棠：你终于来了" },
          { segmentLabel: "1-1", description: "中景：雨水打在伞面" },
          { segmentLabel: "1-1", description: "特写：手指攥紧伞柄" },
          { segmentLabel: "1-2", description: "中景：巷口有人影逼近" },
          { segmentLabel: "1-2", description: "近景：[顾临]抬眼" },
          { segmentLabel: "1-2", description: "特写：鞋跟踩过积水" },
          { segmentLabel: "1-3", description: "中景：两人隔雨对峙" },
          { segmentLabel: "1-3", description: "近景：[沈棠]向后退半步" },
          { segmentLabel: "1-3", description: "特写：雨珠挂在睫毛上" },
          { segmentLabel: "1-4", description: "中景：[顾临]停在路灯下" },
          { segmentLabel: "1-4", description: "近景：风吹起衣角" },
          { segmentLabel: "1-4", description: "特写：路灯闪烁" },
          { segmentLabel: "1-5", description: "中景：两人沉默对望" },
          { segmentLabel: "1-5", description: "近景：呼吸在雨夜里起雾" },
          { segmentLabel: "1-5", description: "特写：指节泛白" },
        ],
        { segmentsTarget: 5, videoPace: "medium" },
      ),
    ).toThrow(/description/);
  });

  it("passes reference images to Seedream when generating character variants", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(Uint8Array.from([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ b64_json: "R0VO", mime_type: "image/png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    const result = await invokeFunction("generate-character", {
      name: "陆姜沉",
      description: "黑色西装，战损版本",
      style: "live-action",
      model: "doubao-seedream-5-0-260128",
      referenceImageUrl: "https://example.com/character-base.png",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      imageUrl: "data:image/png;base64,R0VO",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://example.com/character-base.png");
    const submitInit = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(submitInit.body))).toEqual(
      expect.objectContaining({
        image: ["data:image/png;base64,AQID"],
      }),
    );
  });

  it("passes reference images to Seedream when generating scene variants", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(Uint8Array.from([4, 5, 6]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ b64_json: "U0NFTkU=", mime_type: "image/png" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    const result = await invokeFunction("generate-scene", {
      name: "医院走廊",
      description: "雨夜版本，冷色灯光",
      style: "live-action",
      model: "doubao-seedream-5-0-260128",
      referenceImageUrl: "https://example.com/scene-base.png",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      imageUrl: "data:image/png;base64,U0NFTkU=",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://example.com/scene-base.png");
    const submitInit = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(submitInit.body))).toEqual(
      expect.objectContaining({
        image: ["data:image/png;base64,BAUG"],
      }),
    );
  });

  it("respects supported single-view aspect ratios for character generation instead of forcing 9:16", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ b64_json: "U0lOR0xF", mime_type: "image/png" }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await invokeFunction("generate-character", {
      name: "林晓晓",
      description: "白色长裙，正面角色单图",
      style: "live-action",
      model: "doubao-seedream-5-0-260128",
      viewMode: "single",
      aspectRatio: "2:3",
    });

    expect(result.error).toBeNull();
    expect(result.data).toEqual({
      imageUrl: "data:image/png;base64,U0lOR0xF",
    });

    const submitInit = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(submitInit.body))).toEqual(
      expect.objectContaining({
        size: "1536x2304",
      }),
    );
  });
});

describe("validateDecomposeSceneCounts", () => {
  it("normalizes dialogue lines out of description before validation", () => {
    expect(
      normalizeDecomposeScenes([
        {
          sceneNumber: 1,
          segmentLabel: "1-1",
          sceneName: "Rainy Alley",
          description: "中景：雨夜长街里，[沈棠]回头 | 沈棠：你终于来了",
          dialogue: "",
          characters: ["沈棠"],
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        description: "中景：雨夜长街里，[沈棠]回头",
        dialogue: "沈棠：你终于来了",
        characters: ["沈棠"],
      }),
    ]);
  });

  it("removes narration labels from characters and rebalances segment durations", () => {
    expect(
      normalizeDecomposeScenes([
        {
          sceneNumber: 1,
          segmentLabel: "1-1",
          sceneName: "Rainy Alley",
          description: "涓櫙锛氶洦澶滈暱琛楅噷",
          dialogue: "鏃佺櫧锛氶洦姘存部鐫€浼炴獝娣屼笅",
          characters: ["鏃佺櫧", "娌堟"],
          duration: 15,
        },
        {
          sceneNumber: 2,
          segmentLabel: "1-1",
          sceneName: "Rainy Alley",
          description: "杩戞櫙锛孾娌堟]鎶€澶?",
          dialogue: "",
          characters: ["娌堟"],
          duration: 15,
        },
        {
          sceneNumber: 3,
          segmentLabel: "1-1",
          sceneName: "Rainy Alley",
          description: "鐗瑰啓锛氶洦婊存粦杩囨墜鑳?",
          dialogue: "",
          characters: [],
          duration: 15,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        characters: ["娌堟"],
        duration: 5,
      }),
      expect.objectContaining({
        duration: 5,
      }),
      expect.objectContaining({
        duration: 5,
      }),
    ]);
  });

  it("accepts scene counts that satisfy the prompt floor", () => {
    expect(() =>
      validateDecomposeSceneCounts(
        [
          { segmentLabel: "1-1", description: "a" },
          { segmentLabel: "1-1", description: "b" },
          { segmentLabel: "1-1", description: "c" },
          { segmentLabel: "1-2", description: "d" },
          { segmentLabel: "1-2", description: "e" },
          { segmentLabel: "1-2", description: "f" },
          { segmentLabel: "1-3", description: "g" },
          { segmentLabel: "1-3", description: "h" },
          { segmentLabel: "1-3", description: "i" },
          { segmentLabel: "1-4", description: "j" },
          { segmentLabel: "1-4", description: "k" },
          { segmentLabel: "1-4", description: "l" },
          { segmentLabel: "1-5", description: "m" },
          { segmentLabel: "1-5", description: "n" },
          { segmentLabel: "1-5", description: "o" },
        ],
        { segmentsTarget: 5, videoPace: "medium" },
      ),
    ).not.toThrow();
  });

  it("rejects decompositions that underfill required segments", () => {
    expect(() =>
      validateDecomposeSceneCounts(
        [
          { segmentLabel: "1-1", description: "a" },
          { segmentLabel: "1-1", description: "b" },
          { segmentLabel: "1-1", description: "c" },
          { segmentLabel: "1-2", description: "d" },
          { segmentLabel: "1-2", description: "e" },
          { segmentLabel: "1-2", description: "f" },
        ],
        { segmentsTarget: 5, videoPace: "medium" },
      ),
    ).toThrow(/片段数不足/);
  });

  it("rejects decompositions that underfill required shots per segment", () => {
    expect(() =>
      validateDecomposeSceneCounts(
        [
          { segmentLabel: "1-1", description: "a" },
          { segmentLabel: "1-1", description: "b" },
          { segmentLabel: "1-2", description: "c" },
          { segmentLabel: "1-2", description: "d" },
          { segmentLabel: "1-2", description: "e" },
          { segmentLabel: "1-3", description: "f" },
          { segmentLabel: "1-3", description: "g" },
          { segmentLabel: "1-3", description: "h" },
          { segmentLabel: "1-4", description: "i" },
          { segmentLabel: "1-4", description: "j" },
          { segmentLabel: "1-4", description: "k" },
          { segmentLabel: "1-5", description: "l" },
          { segmentLabel: "1-5", description: "m" },
          { segmentLabel: "1-5", description: "n" },
        ],
        { segmentsTarget: 5, videoPace: "medium" },
      ),
    ).toThrow(/分镜数不足/);
  });
  it("scales script-decompose parallelism based on chunk shape", () => {
    expect(
      resolveDecomposeParallelism({
        totalChunks: 2,
        targetChunks: 2,
        isRealEpisodes: true,
        averageChunkChars: 3200,
      }),
    ).toBe(2);

    expect(
      resolveDecomposeParallelism({
        totalChunks: 8,
        targetChunks: 8,
        isRealEpisodes: true,
        averageChunkChars: 4200,
      }),
    ).toBe(5);

    expect(
      resolveDecomposeParallelism({
        totalChunks: 12,
        targetChunks: 12,
        isRealEpisodes: true,
        averageChunkChars: 4200,
      }),
    ).toBe(6);

    expect(
      resolveDecomposeParallelism({
        totalChunks: 12,
        targetChunks: 12,
        isRealEpisodes: false,
        averageChunkChars: 4200,
      }),
    ).toBe(4);

    expect(
      resolveDecomposeParallelism({
        totalChunks: 12,
        targetChunks: 12,
        isRealEpisodes: true,
        averageChunkChars: 9800,
      }),
    ).toBe(3);
  });

  it("uses a lighter retry delay for script-decompose self-heal retries", () => {
    expect(resolveDecomposeRetryDelayMs(800)).toBe(400);
    expect(resolveDecomposeRetryDelayMs(200)).toBe(150);
    expect(resolveDecomposeRetryDelayMs(10000)).toBe(1200);
  });
});

describe("multi-episode script decomposition guards", () => {
  it("normalizes per-episode segment labels emitted with the wrong episode prefix", () => {
    expect(normalizeEpisodeSegmentLabel("1-1", 2)).toBe("2-1");
    expect(normalizeEpisodeSegmentLabel("2-1", 2)).toBe("2-1");
    expect(normalizeEpisodeSegmentLabel("2-1-1", 2)).toBe("2-1");
    expect(normalizeEpisodeSegmentLabel("片段4", 7)).toBe("7-4");
  });

  it("builds a blocking error when any episode chunk fails", () => {
    expect(buildIncompleteDecomposeError([0, 3, 6], 7).message).toBe(
      "剧本拆解未完成：第 1 集、第 4 集、第 7 集 拆解失败，仅完成 4/7 集。请重试剧本拆解，避免保存不完整分镜。",
    );
  });
});

describe("script decompose coverage guards", () => {
  it("rejects empty dialogue output when the source script contains explicit dialogue anchors", () => {
    expect(() =>
      validateDecomposeSceneCounts(
        [
          {
            sceneNumber: 1,
            segmentLabel: "1-1",
            sceneName: "Hall",
            description: "Alice waits at the far end of the hall.",
            characters: ["ALICE"],
            dialogue: "",
            cameraDirection: "no subtitles",
            duration: 7,
          },
          {
            sceneNumber: 2,
            segmentLabel: "1-1",
            sceneName: "Hall",
            description: "Bob steps closer under the light.",
            characters: ["ALICE", "BOB"],
            dialogue: "",
            cameraDirection: "no subtitles",
            duration: 8,
          },
        ],
        {
          segmentsTarget: 1,
          videoPace: "slow",
          sourceScript: "ALICE: Stay here.\nBOB: I'm right behind you.",
        },
      ),
    ).toThrow(/dialogue/i);
  });
});

describe("script decompose self-healing", () => {
  beforeEach(() => {
    localStorage.clear();
    if (typeof AbortSignal.timeout !== "function") {
      Object.defineProperty(AbortSignal, "timeout", {
        configurable: true,
        value: (ms: number) => {
          const controller = new AbortController();
          setTimeout(() => controller.abort(new Error(`timeout ${ms}`)), ms);
          return controller.signal;
        },
      });
    }
    window.electronAPI = {
      runtime: {
        builtinApiBundle: null,
        builtinApiBundlePath: "",
        verifyBuiltinApiAdminPassword: async () => true,
      },
    } as typeof window.electronAPI;

    saveApiConfig({
      geminiEndpoint: "https://api.tu-zi.com/v1beta",
      geminiKey: "test-gemini-key",
      retryCount: 0,
      retryDelayMs: 500,
    });
  });

  it("repairs a lightly malformed decomposition JSON locally before spending a retry", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: '{"scenes":[{"sceneNumber":1,"segmentLabel":"1-1","sceneName":"走廊","description":"女主停在走廊尽头""characters":["女主"],"dialogue":"","cameraDirection":"无字幕、无水印、无背景音","duration":7},{"sceneNumber":2,"segmentLabel":"1-1","sceneName":"走廊","description":"男主从走廊另一端靠近。","characters":["女主","男主"],"dialogue":"","cameraDirection":"无字幕、无水印、无背景音","duration":8}]}',
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await invokeFunction("script-decompose", {
      script: "第1集\n女主停在走廊尽头回头，看见男主走近。",
      segmentsPerEpisode: 1,
      videoPace: "slow",
    });

    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      scenes: expect.arrayContaining([
        expect.objectContaining({ segmentLabel: "1-1", sceneName: "走廊" }),
      ]),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const firstPayload = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
    expect(firstPayload.generationConfig?.temperature).toBe(0.3);
    expect(firstPayload.generationConfig?.maxOutputTokens).toBe(16384);
    expect(firstPayload.generationConfig?.responseSchema).toBeUndefined();
  });

  it("injects source-script anchors into the legacy decomposition prompt to reduce omissions", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      scenes: [
                        {
                          sceneNumber: 1,
                          segmentLabel: "1-1",
                          sceneName: "Hall",
                          description: "Alice waits at the far end of the hall.",
                          characters: ["ALICE"],
                          dialogue: "ALICE: Stay here.",
                          cameraDirection: "no subtitles",
                          duration: 7,
                        },
                        {
                          sceneNumber: 2,
                          segmentLabel: "1-1",
                          sceneName: "Hall",
                          description: "Bob closes in under the light.",
                          characters: ["BOB"],
                          dialogue: "BOB: I'm right behind you.",
                          cameraDirection: "no subtitles",
                          duration: 8,
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await invokeFunction("script-decompose", {
      script: "ALICE: Stay here.\nBOB: I'm right behind you.",
      segmentsPerEpisode: 1,
      videoPace: "slow",
    });

    expect(result.error).toBeNull();
    const payload = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
    const promptText = payload.contents?.[0]?.parts?.[0]?.text ?? "";
    expect(promptText).toContain("ALICE: Stay here.");
    expect(promptText).toContain("BOB: I'm right behind you.");
  });

  it("injects extracted costume and scene-variant assets into the decomposition prompt", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      scenes: [
                        {
                          sceneNumber: 1,
                          segmentLabel: "1-1",
                          sceneName: "天台",
                          description: "林霄站在雨夜天台边缘。",
                          characters: ["林霄"],
                          dialogue: "",
                          cameraDirection: "no subtitles",
                          duration: 15,
                          characterCostumes: { 林霄: "战损黑衣" },
                          sceneTimeVariantId: "暴雨夜",
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await invokeFunction("script-decompose", {
      script: "林霄站在天台边缘，暴雨砸在肩上。",
      segmentsPerEpisode: 1,
      videoPace: "slow",
      costumeInfo: [
        {
          name: "林霄",
          costumes: [{ label: "战损黑衣", description: "黑衣破损，肩部有血迹" }],
        },
      ],
      sceneSettingInfo: [
        {
          name: "天台",
          timeVariants: [{ label: "暴雨夜", description: "强降雨伴随冷蓝夜光" }],
        },
      ],
    });

    expect(result.error).toBeInstanceOf(Error);
    const payload = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
    const promptText = payload.contents?.[0]?.parts?.[0]?.text ?? "";
    expect(promptText).toContain("以下是阶段一识别到的角色服装变体信息");
    expect(promptText).toContain("战损黑衣");
    expect(promptText).toContain("以下是阶段一识别到的场景时间/天气/环境变体信息");
    expect(promptText).toContain("暴雨夜");
    expect(promptText).toContain("sceneTimeVariantId");
  });

  it("prioritizes complete plot coverage in the legacy decomposition prompt", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      scenes: [
                        {
                          sceneNumber: 1,
                          segmentLabel: "1-1",
                          sceneName: "Hall",
                          description: "Alice freezes at the far end of the hall.",
                          characters: ["ALICE"],
                          dialogue: "",
                          cameraDirection: "no subtitles",
                          duration: 7,
                        },
                        {
                          sceneNumber: 2,
                          segmentLabel: "1-1",
                          sceneName: "Hall",
                          description: "Bob closes in under the light.",
                          characters: ["BOB"],
                          dialogue: "",
                          cameraDirection: "no subtitles",
                          duration: 8,
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await invokeFunction("script-decompose", {
      script: "第1集\nAlice先后退一步，看到Bob靠近后强装镇定，但手已经开始发抖。",
      segmentsPerEpisode: 1,
      videoPace: "slow",
      episodeDurationSeconds: 15,
    });

    expect(result.error).toBeNull();
    const payload = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
    const promptText = payload.contents?.[0]?.parts?.[0]?.text ?? "";
    expect(promptText).toContain("剧情完整性优先");
    expect(promptText).toContain("宁可适当增加 description 字数");
    expect(promptText).toContain("不要为了简短而省略会影响后续理解的剧情细节");
    expect(promptText).toContain("优先把“谁在做什么、发生了什么、造成什么结果/承接”写完整");
  });

  it.skip("retries malformed decomposition JSON internally until a valid result is produced", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: '{"scenes":[{"sceneNumber":1,"segmentLabel":"1-1","sceneName":"走廊","description":"女主停在走廊尽头""characters":["女主"],"dialogue":"","cameraDirection":"无字幕、无水印、无背景音","duration":7}]}',
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        scenes: [
                          {
                            sceneNumber: 1,
                            segmentLabel: "1-1",
                            sceneName: "走廊",
                            description: "女主停在走廊尽头，回头看向身后。",
                            characters: ["女主"],
                            dialogue: "",
                            cameraDirection: "无字幕、无水印、无背景音",
                            duration: 7,
                          },
                          {
                            sceneNumber: 2,
                            segmentLabel: "1-1",
                            sceneName: "走廊",
                            description: "男主从拐角处走近，停在灯影里。",
                            characters: ["女主", "男主"],
                            dialogue: "男主：现在跟我走。",
                            cameraDirection: "无字幕、无水印、无背景音",
                            duration: 8,
                          },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const result = await invokeFunction("script-decompose", {
      script: "第1集\n女主在走廊尽头回头，看见男主走近。",
      segmentsPerEpisode: 1,
      videoPace: "slow",
    });

    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      scenes: expect.arrayContaining([
        expect.objectContaining({ segmentLabel: "1-1", sceneName: "走廊" }),
      ]),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const firstPayload = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
    expect(firstPayload.generationConfig?.responseMimeType).toBe("application/json");
    expect(firstPayload.generationConfig?.responseSchema?.properties?.scenes?.type).toBe("ARRAY");

    const secondPayload = JSON.parse(String((fetchSpy.mock.calls[1]?.[1] as RequestInit).body));
    const secondPrompt = secondPayload.contents?.[0]?.parts?.[0]?.text ?? "";
    expect(secondPrompt).toContain("上一次输出存在的问题");
    expect(secondPrompt).toContain("拆解结果分镜数不足");
    expect(secondPrompt).toContain("以下片段分镜数偏少");
    expect(secondPrompt).toContain("请重新生成完整、合法的 JSON");
  });

  it.skip("retries a structurally valid decomposition when explicit source dialogue was dropped", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        scenes: [
                          {
                            sceneNumber: 1,
                            segmentLabel: "1-1",
                            sceneName: "Hall",
                            description: "Alice freezes at the end of the hall.",
                            characters: ["ALICE"],
                            dialogue: "",
                            cameraDirection: "no subtitles",
                            duration: 7,
                          },
                          {
                            sceneNumber: 2,
                            segmentLabel: "1-1",
                            sceneName: "Hall",
                            description: "Bob closes in from the shadows.",
                            characters: ["BOB"],
                            dialogue: "",
                            cameraDirection: "no subtitles",
                            duration: 8,
                          },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        scenes: [
                          {
                            sceneNumber: 1,
                            segmentLabel: "1-1",
                            sceneName: "Hall",
                            description: "Alice freezes at the end of the hall and turns back.",
                            characters: ["ALICE"],
                            dialogue: "ALICE: Stay here.",
                            cameraDirection: "no subtitles",
                            duration: 7,
                          },
                          {
                            sceneNumber: 2,
                            segmentLabel: "1-1",
                            sceneName: "Hall",
                            description: "Bob closes in from the shadows and lifts his hand.",
                            characters: ["BOB"],
                            dialogue: "BOB: I'm right behind you.",
                            cameraDirection: "no subtitles",
                            duration: 8,
                          },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const result = await invokeFunction("script-decompose", {
      script: "第1集\nALICE: Stay here.\nBOB: I'm right behind you.",
      segmentsPerEpisode: 1,
      videoPace: "slow",
    });

    expect(result.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondPayload = JSON.parse(String((fetchSpy.mock.calls[1]?.[1] as RequestInit).body));
    const secondPrompt = secondPayload.contents?.[0]?.parts?.[0]?.text ?? "";
    expect(secondPrompt).toContain("显式对白");
    expect(secondPrompt).toContain("dialogue");
  });

  it.skip("injects deterministic adjacent raw-script context for multi-episode prompts", async () => {
    const requestTexts: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const payload = JSON.parse(String((init as RequestInit).body));
      const promptText =
        payload.contents?.[payload.contents.length - 1]?.parts?.[0]?.text ??
        payload.messages?.map((message: { content?: string }) => message.content || "").join("\n\n") ??
        "";
      requestTexts.push(promptText);
      const isEpisode1 = promptText.includes("SELF_ONLY_E1");
      const segmentLabel = isEpisode1 ? "1-1" : "2-1";
      const sceneName = isEpisode1 ? "Bridge" : "Doorway";
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      scenes: [
                        {
                          sceneNumber: 1,
                          segmentLabel,
                          sceneName,
                          description: `${sceneName} wide shot.`,
                          characters: [],
                          dialogue: "",
                          cameraDirection: "no subtitles",
                          duration: 7,
                        },
                        {
                          sceneNumber: 2,
                          segmentLabel,
                          sceneName,
                          description: `${sceneName} close shot.`,
                          characters: [],
                          dialogue: "",
                          cameraDirection: "no subtitles",
                          duration: 8,
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await invokeFunction("script-decompose", {
      script: [
        "第1集",
        "E1_HEAD_A",
        "E1_HEAD_B",
        "E1_HEAD_C",
        "SELF_ONLY_E1",
        "E1_TAIL_A",
        "E1_TAIL_B",
        "TAIL_E1",
        "",
        "第2集",
        "HEAD_E2",
        "E2_HEAD_B",
        "E2_HEAD_C",
        "SELF_ONLY_E2",
        "E2_TAIL_A",
        "E2_TAIL_B",
        "E2_TAIL_C",
      ].join("\n"),
      segmentsPerEpisode: 1,
      videoPace: "slow",
    });

    expect(result.error).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const episode1Prompt = requestTexts.find((text) => text.includes("SELF_ONLY_E1")) || "";
    const episode2Prompt = requestTexts.find((text) => text.includes("SELF_ONLY_E2")) || "";

    expect(episode1Prompt).toContain("HEAD_E2");
    expect(episode2Prompt).toContain("TAIL_E1");
  });

  it("surfaces a readable failure reason after repeated malformed JSON responses", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: '{"scenes":[{"sceneNumber":1,"segmentLabel":"1-1","sceneName":"走廊","description":"女主停在走廊尽头""characters":["女主"]}]}',
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await invokeFunction("script-decompose", {
      script: "第1集\n女主在走廊尽头回头。",
      segmentsPerEpisode: 1,
      videoPace: "slow",
    });

    expect(result.data).toBeNull();
    expect(result.error?.message).toContain("拆解结果分镜数不足");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("pre-splits oversized real episodes in single-pass mode before they hit the output cap", () => {
    const plan = buildDecomposeExecutionPlan({
      splitResult: {
        chunks: [
          ["第1集", `EP1_PART_A\n${"\u957f".repeat(6500)}`, "", `EP1_PART_B\n${"\u591c".repeat(6500)}`].join("\n\n"),
          "第2集\n\nEP2_MARKER\n\n第二集推进",
        ],
        isRealEpisodes: true,
        originallyEpisodes: true,
      },
      segmentsPerEpisode: 2,
      singlePass: true,
    });

    expect(plan.units).toHaveLength(3);
    expect(plan.chunkSegmentCounts).toEqual([1, 1, 2]);
    expect(plan.isRealEpisodes).toBe(false);
    expect(plan.originallyEpisodes).toBe(true);
    expect(plan.units.map((unit) => `${unit.episodeNumber}:${unit.partIndex}/${unit.partCount}:${unit.segmentStart}-${unit.segmentsTarget}`)).toEqual([
      "1:1/2:1-1",
      "1:2/2:2-1",
      "2:1/1:1-2",
    ]);
    expect(plan.units[0]?.script.includes("EP1_PART_A")).toBe(true);
    expect(plan.units[0]?.script.includes("EP1_PART_B")).toBe(false);
    expect(plan.units[1]?.script.includes("EP1_PART_B")).toBe(true);
  });

  it("pre-splits oversized single-chunk scripts in single-pass mode even without episode markers", () => {
    const plan = buildDecomposeExecutionPlan({
      splitResult: {
        chunks: [[`单集长剧本\n${"\u68a6".repeat(6500)}`, "", `转场\n${"\u96e8".repeat(6500)}`].join("\n\n")],
        isRealEpisodes: false,
        originallyEpisodes: false,
      },
      segmentsPerEpisode: 1,
      singlePass: true,
    });

    expect(plan.units).toHaveLength(2);
    expect(plan.chunkSegmentCounts).toEqual([1, 1]);
    expect(plan.units.map((unit) => `${unit.partIndex}/${unit.partCount}:${unit.segmentStart}-${unit.segmentsTarget}`)).toEqual([
      "1/2:1-1",
      "2/2:2-1",
    ]);
  });

  it("repairs truncated decomposition json that ends inside a string before validating scenes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: '{"scenes":[{"sceneNumber":1,"segmentLabel":"1-1","sceneName":"走廊","description":"女主停在走廊尽头","characters":["女主"],"dialogue":"","cameraDirection":"无字幕、无水印、无背景音","duration":7},{"sceneNumber":2,"segmentLabel":"1-1","sceneName":"走廊","description":"男主从拐角处靠近',
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await invokeFunction("script-decompose", {
      script: "第1集\n女主停在走廊尽头，男主从拐角处靠近。",
      segmentsPerEpisode: 1,
      videoPace: "slow",
    });

    expect(result.error).toBeNull();
    expect(result.data?.scenes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          segmentLabel: "1-1",
          sceneName: "走廊",
        }),
      ]),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.skip("includes the supplied system prompt in script-decompose requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      scenes: [
                        {
                          sceneNumber: 1,
                          segmentLabel: "1-1",
                          sceneName: "走廊",
                          description: "女主停在走廊尽头回头。",
                          characters: ["女主"],
                          dialogue: "",
                          cameraDirection: "无字幕、无水印、无背景音",
                          duration: 7,
                        },
                        {
                          sceneNumber: 2,
                          segmentLabel: "1-1",
                          sceneName: "走廊",
                          description: "男主从走廊另一端靠近。",
                          characters: ["女主", "男主"],
                          dialogue: "",
                          cameraDirection: "无字幕、无水印、无背景音",
                          duration: 8,
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await invokeFunction("script-decompose", {
      script: "第1集\n女主停在走廊尽头回头。",
      segmentsPerEpisode: 1,
      videoPace: "slow",
      systemPrompt: "【补充要求】若对白超限，必须拆到下一个 segmentLabel。",
    });

    expect(result.error).toBeNull();
    const payload = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
    expect(payload.systemInstruction?.parts?.[0]?.text ?? "").toContain(
      "銆愯ˉ鍏呰姹傘€戣嫢瀵圭櫧瓒呴檺锛屽繀椤绘媶鍒颁笅涓€涓?segmentLabel銆?",
    );
    const promptText = payload.contents?.[0]?.parts?.[0]?.text ?? "";
    expect(promptText).toContain("【补充要求】若对白超限，必须拆到下一个 segmentLabel。");
  });

  it("keeps non-json decomposition failures on the shared three-attempt budget", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{}],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await invokeFunction("script-decompose", {
      script: "Episode 1\nHero looks back in the hallway.",
      segmentsPerEpisode: 1,
      videoPace: "slow",
    });

    expect(result.data).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

});


import { ToolBase, type CanUseToolFn, type ToolUseContext } from "../tool";
import type { AssistantMessage, ToolResult } from "../types";
import { runWorkflowAction } from "@/lib/home-agent/workflow-actions";
import type { ConversationProjectSnapshot, StudioRuntimeState } from "@/lib/home-agent/types";
import { emitHomeAgentWorkflowRuntimeDelta } from "@/lib/home-agent/workflow-runtime-events";
import { buildMediaContentSummary } from "@/lib/home-agent/media-generation-copy";

type RuntimeDelta = NonNullable<Awaited<ReturnType<typeof runWorkflowAction>>["data"]>;
type WorkflowProgressStatus = "start" | "progress" | "complete" | "error";

function buildWorkflowProgressLabel(actionName: string): string {
  const labels: Record<string, string> = {
    export_video_asset_bundle: "导出视频素材归档",
    continue_project: "继续当前项目",
    continue_drama_step: "继续剧本创作",
    save_setup: "写入立项信息",
    analyze_reference_script: "分析参考内容",
    generate_creative_plan: "生成创意方案",
    generate_structure_transform: "生成结构转译",
    generate_characters: "生成角色设定",
    generate_character_transform: "生成角色转译方案",
    generate_directory: "生成分集目录",
    generate_outlines: "生成单集细纲",
    generate_episode: "生成分集正文",
    run_compliance_review: "执行合规审查",
    lock_character_cards: "锁定角色状态卡",
    lock_story_beats: "锁定剧情 beat",
    resolve_compliance_revisions: "标记修订已处理",
    reopen_compliance_revisions: "重新打开修订项",
    prepare_video_generation: "接管视频项目",
    advance_video_workflow: "继续视频工作流",
    advance_video_workflow_round: "连续推进视频一轮",
    analyze_script_for_video: "拆解视频脚本",
    extract_video_entities: "整理角色与场景",
    export_storyboard_xlsx: "导出分镜 xlsx",
    prepare_storyboard_batch: "整理分镜批次",
    compile_video_shot_packets: "编译镜头指令包",
    prepare_video_prompt_batch: "生成视频提示词批次",
    generate_video_reference_assets: "生成角色与场景参考图",
    generate_storyboard_frames: "生成分镜图",
    generate_project_image: "生成图片",
    generate_video_assets: "提交视频出片",
    continue_video_step: "定位视频阶段",
    create_video_bridge_artifact: "整理视频桥接摘要",
    export_project: "整理导出文档",
    create_skill_draft: "写入技能草案",
    export_approved_skill_drafts: "导出已批准技能候选",
    export_approved_skill_draft_bundle: "生成技能 Bundle 草案",
    export_approved_skill_install_candidates: "生成正式 Skill 安装候选",
    export_video_production_bundle: "导出视频生产状态包",
    preview_video_production_bundle: "预览视频生产状态摘要",
    open_video_production_bundle_directory: "打开视频生产状态目录",
    run_maintenance: "执行维护整理",
    query_asset_status: "查询素材状态",
  };

  return labels[actionName] || actionName;
}

function emitWorkflowProgress(
  id: string,
  status: WorkflowProgressStatus,
  content: string,
  onProgress?: (data: unknown) => void,
) {
  const detail = { id, status, content };
  onProgress?.(detail);

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("agent:workflow-progress", {
        detail,
      }),
    );
  }
}

function upsertRecentProject(
  recentProjects: ConversationProjectSnapshot[],
  snapshot: ConversationProjectSnapshot,
): ConversationProjectSnapshot[] {
  return [snapshot, ...recentProjects.filter((item) => item.projectId !== snapshot.projectId)].slice(0, 8);
}

function mergeRuntimeState(previous: StudioRuntimeState, delta?: RuntimeDelta): StudioRuntimeState {
  if (!delta) return previous;

  const nextProjectSnapshot = delta.projectSnapshot ?? previous.currentProjectSnapshot;
  const nextSkillDrafts = delta.skillDrafts ?? previous.skillDrafts;
  const nextReports = delta.maintenanceReports ?? previous.maintenanceReports;
  const nextRecentProjects = nextProjectSnapshot
    ? upsertRecentProject(previous.recentProjects, nextProjectSnapshot)
    : previous.recentProjects;

  return {
    ...previous,
    currentDramaProject: delta.dramaProject === undefined ? previous.currentDramaProject : delta.dramaProject,
    currentVideoProject: delta.videoProject === undefined ? previous.currentVideoProject : delta.videoProject,
    currentProjectSnapshot: nextProjectSnapshot,
    skillDrafts: nextSkillDrafts,
    maintenanceReports: nextReports,
    recentProjects: nextRecentProjects,
    recentMessageSummary:
      delta.recentMessageSummary === undefined ? previous.recentMessageSummary : delta.recentMessageSummary,
  };
}

export class StudioWorkflowTool extends ToolBase {
  readonly name = "HomeStudioWorkflow";
  readonly searchHint = "Execute InFinio homepage workflow actions: project creation, script generation, video production, image generation (generate_project_image), character/scene reference assets, storyboard frames, compliance review, export, and maintenance. Use this tool to advance any creative or video workflow step.";

  inputSchema() {
    return {
      type: "object",
      properties: {
        action: {
          type: "string",
          description:
            "Workflow action: get_context, save_setup, continue_project, continue_drama_step, analyze_reference_script, generate_creative_plan, generate_structure_transform, generate_characters, generate_character_transform, generate_directory, generate_outlines, generate_episode, run_compliance_review, lock_character_cards, lock_story_beats, resolve_compliance_revisions, reopen_compliance_revisions, prepare_video_generation, advance_video_workflow, advance_video_workflow_round, analyze_script_for_video, extract_video_entities, generate_video_reference_assets, export_storyboard_xlsx, prepare_storyboard_batch, generate_storyboard_frames, compile_video_shot_packets, prepare_video_prompt_batch, generate_video_assets, continue_video_step, create_video_bridge_artifact, export_project, create_skill_draft, export_approved_skill_drafts, export_approved_skill_draft_bundle, export_approved_skill_install_candidates, export_video_asset_bundle, export_video_production_bundle, preview_video_production_bundle, open_video_production_bundle_directory, run_maintenance, generate_project_image, query_asset_status. Use query_asset_status to check the real asset library (素材库) state from assetManifest. assetManifest already includes assets generated inside the current project workflow as well as manually added assets; do not infer directly from raw project fields. Returns a table of image and video assets with real disk-existence verification. Use generate_project_image to generate a single image on demand from a text description — pass imagePrompt with the visual description. Use export_storyboard_xlsx to export the current shot list as an xlsx storyboard sheet once scenes are available. When the user asks to generate video, first call query_asset_status to verify required assets exist in the library, then call generate_video_assets once storyboard/reference assets are confirmed ready. Use generate_video_reference_assets to directly generate character and scene reference images. Use generate_storyboard_frames to directly generate storyboard frames for scenes. IMPORTANT: generate_video_reference_assets, generate_storyboard_frames, and generate_project_image are asset-creation actions, so do NOT call query_asset_status before them.",
        },
        projectKind: {
          type: "string",
          description: "script, adaptation, or video when relevant",
        },
        title: {
          type: "string",
          description: "Project title if known",
        },
        genres: {
          type: "array",
          items: { type: "string" },
          description: "Genre tags chosen for the project",
        },
        audience: {
          type: "string",
          description: "Audience label such as 女频, 男频, 全龄",
        },
        tone: {
          type: "string",
          description: "Tone label such as 甜, 虐, 爽, 燃",
        },
        ending: {
          type: "string",
          description: "HE, BE, or OE",
        },
        totalEpisodes: {
          type: "number",
          description: "Target episode count",
        },
        targetMarket: {
          type: "string",
          description: "cn, jp, west, kr, sea",
        },
        customTopic: {
          type: "string",
          description: "Extra user note about the topic",
        },
        setupMode: {
          type: "string",
          description: "creative or topic",
        },
        creativeInput: {
          type: "string",
          description: "Original free-form concept from the user",
        },
        referenceScript: {
          type: "string",
          description: "Reference script content for adaptation",
        },
        script: {
          type: "string",
          description: "Video script, episode text, or any source text to continue video production",
        },
        frameworkStyle: {
          type: "string",
          description: "Style mapping for adaptation structure",
        },
        creativePlan: {
          type: "string",
          description: "Creative plan content override when needed",
        },
        characters: {
          type: "string",
          description: "Character sheet override when needed",
        },
        structureTransform: {
          type: "string",
          description: "Structure transform override when needed",
        },
        rangeStart: {
          type: "number",
          description: "Start episode for outline generation",
        },
        rangeEnd: {
          type: "number",
          description: "End episode for outline generation",
        },
        episodeNumber: {
          type: "number",
          description: "Single episode number to generate",
        },
        durationSeconds: {
          type: "number",
          description: "Optional target duration for a single episode",
        },
        projectId: {
          type: "string",
          description: "Existing project id when resuming a saved video session",
        },
        model: {
          type: "string",
          description: "Optional model override for generation tools",
        },
        artStyle: {
          type: "string",
          description: "Video visual style such as live-action, anime-3d, retro-comic, or custom",
        },
        systemPrompt: {
          type: "string",
          description: "Optional system prompt override for decomposition or video generation helpers",
        },
        targetPlatform: {
          type: "string",
          description: "Primary target platform such as 抖音, TikTok, 小红书, B站, or multi-platform",
        },
        shotStyle: {
          type: "string",
          description: "Preferred shot language such as documentary, cinematic, ad-like, or hybrid",
        },
        outputGoal: {
          type: "string",
          description: "Desired output goal such as teaser, trailer, ads, or proof-of-concept",
        },
        productionNotes: {
          type: "string",
          description: "Extra production constraints or notes to keep with the video project",
        },
        videoPace: {
          type: "string",
          description: "slow, medium, or fast pacing for script decomposition",
        },
        segmentsPerEpisode: {
          type: "number",
          description: "Target segment count when decomposing script into shots",
        },
        sceneStart: {
          type: "number",
          description: "Start scene number for storyboard or prompt batch preparation",
        },
        sceneEnd: {
          type: "number",
          description: "End scene number for storyboard or prompt batch preparation",
        },
        batchSize: {
          type: "number",
          description: "How many scenes to submit in one homepage generation batch",
        },
        maxSteps: {
          type: "number",
          description: "Maximum steps to auto-run when using advance_video_workflow_round",
        },
        resolution: {
          type: "string",
          description: "Target video resolution, usually 720p or 1080p",
        },
        videoModelKey: {
          type: "string",
          description: "Optional video model key override, currently doubao-seedance-1-5-pro.",
        },
        selectedVideoModelKey: {
          type: "string",
          description: "Current UI-selected video model key; omit to use homepage defaults.",
        },
        videoGenerationPrefs: {
          type: "object",
          description:
            "Optional video generation preferences. Currently supports { modelKey: 'doubao-seedance-1-5-pro', resolution: '1080p' } and resolves to doubao-seedance-1-5-pro_1080p.",
          properties: {
            modelKey: { type: "string" },
            resolution: { type: "string" },
          },
        },
        aspectRatio: {
          type: "string",
          description: "Target video aspect ratio such as 16:9, 9:16, or 1:1",
        },
        provider: {
          type: "string",
          description: "Optional provider override such as dreamina-cli, jimeng, or tuzi",
        },
        forceRegenerate: {
          type: "boolean",
          description: "When true, resubmit scenes even if they already have video outputs",
        },
        targetStep: {
          type: "number",
          description: "Target video stage number when explicitly repositioning a video project",
        },
        customInstruction: {
          type: "string",
          description: "Extra instruction for rewriting or generation",
        },
        imagePrompt: {
          type: "string",
          description: "Visual description for generate_project_image — describe the scene, characters, style, and mood in detail",
        },
        imageKind: {
          type: "string",
          description: "For generate_project_image: pass 'character' to generate a character portrait, 'scene' (default) to generate a scene/environment image. Use 'character' whenever the user wants a character image, portrait, or person illustration.",
        },
        targetId: {
          type: "string",
          description: "Single asset, review, or shot packet id to approve or redo",
        },
        targetIds: {
          type: "array",
          items: { type: "string" },
          description: "Multiple asset, review, or shot packet ids to approve or redo",
        },
        proposedSkillName: {
          type: "string",
          description: "Skill draft name for controlled evolution",
        },
        proposedContent: {
          type: "string",
          description: "Skill draft content markdown",
        },
        reason: {
          type: "string",
          description: "Why the skill draft or maintenance action exists",
        },
        sourceConversationIds: {
          type: "array",
          items: { type: "string" },
          description: "Conversation ids linked to the skill draft",
        },
      },
      required: ["action"],
    };
  }

  async call(
    args: Record<string, unknown>,
    context: ToolUseContext,
    _canUseTool: CanUseToolFn,
    _parentMessage: AssistantMessage,
    onProgress?: (data: unknown) => void,
  ): Promise<ToolResult> {
    const runtime = context.getAppState?.() as StudioRuntimeState | undefined;
    if (!runtime) {
      throw new Error("Home studio runtime is unavailable.");
    }

    const actionName = typeof args.action === "string" ? args.action : "";
    if (!actionName) {
      throw new Error("Workflow action is required.");
    }

    console.log(`[DEV] HomeStudioWorkflow 被调用 — action: ${actionName}`, args);

    const progressId = crypto.randomUUID();
    let actionLabel = buildWorkflowProgressLabel(actionName);
    // 分集撰写/细纲生成时附加集号，方便在任务框实时查看进度
    if (actionName === "generate_episode" && typeof args.episodeNumber === "number") {
      actionLabel = `撰写第 ${args.episodeNumber} 集正文`;
    } else if (actionName === "generate_outlines") {
      if (Array.isArray(args.episodeNumbers) && args.episodeNumbers.length > 0) {
        const nums = args.episodeNumbers as number[];
        actionLabel = nums.length === 1
          ? `生成第 ${nums[0]} 集细纲`
          : `生成第 ${nums[0]}–${nums[nums.length - 1]} 集细纲`;
      } else if (typeof args.targetStart === "number" && typeof args.targetEnd === "number") {
        actionLabel = args.targetStart === args.targetEnd
          ? `生成第 ${args.targetStart} 集细纲`
          : `生成第 ${args.targetStart}–${args.targetEnd} 集细纲`;
      }
    }
    emitWorkflowProgress(progressId, "start", `Agent 正在执行：${actionLabel}`, onProgress);

    // 图片生成动作：提前派发占位符事件，让聊天框显示转圈占位符
    const IMAGE_GENERATING_ACTIONS = new Set([
      "generate_project_image",
      "generate_video_reference_assets",
      "generate_storyboard_frames",
    ]);
    const VIDEO_GENERATING_ACTIONS = new Set([
      "generate_video_assets",
    ]);
    const targetIds = Array.isArray(args.targetIds) ? args.targetIds.map(String) : undefined;
    const imageContentSummary = buildMediaContentSummary({
      action: actionName,
      promptText: String(args.imagePrompt || args.prompt || ""),
      imageKind: String(args.imageKind || ""),
      runtime,
      targetIds,
    });
    const videoContentSummary = buildMediaContentSummary({
      action: actionName,
      promptText: String(args.prompt || args.userBubble || ""),
      runtime,
      targetIds,
    });
    if (IMAGE_GENERATING_ACTIONS.has(actionName) && typeof window !== "undefined") {
      // 估算图片数量：generate_project_image 固定 1 张，其余默认 1 张（实际数量未知）
      const estimatedCount = actionName === "generate_project_image" ? 1 : 1;
      window.dispatchEvent(
        new CustomEvent("agent:image-generating-start", {
          detail: {
            count: estimatedCount,
            action: actionName,
            modelFamily: String(args.selectedImageModelFamily || args.modelFamily || ""),
            resolution:
              typeof args.resolution === "string"
                ? args.resolution
                : typeof args.imageGenerationPrefs === "object" &&
                    args.imageGenerationPrefs &&
                    "resolution" in args.imageGenerationPrefs
                  ? String(args.imageGenerationPrefs.resolution || "")
                  : "",
            aspectRatio:
              typeof args.aspectRatio === "string"
                ? args.aspectRatio
                : typeof args.imageGenerationPrefs === "object" &&
                    args.imageGenerationPrefs &&
                    "aspectRatio" in args.imageGenerationPrefs
                  ? String(args.imageGenerationPrefs.aspectRatio || "")
                  : "",
            contentSummary: imageContentSummary,
          },
        }),
      );
    }
    if (VIDEO_GENERATING_ACTIONS.has(actionName) && typeof window !== "undefined") {
      const estimatedCount =
        Array.isArray(args.targetIds) && args.targetIds.length ? args.targetIds.length : 1;
      window.dispatchEvent(
        new CustomEvent("agent:video-generating-start", {
          detail: {
            count: estimatedCount,
            sceneCount: estimatedCount,
            action: actionName,
            model:
              typeof args.selectedVideoModelKey === "string"
                ? args.selectedVideoModelKey
                : typeof args.videoModelKey === "string"
                  ? args.videoModelKey
                  : typeof args.videoGenerationPrefs === "object" &&
                      args.videoGenerationPrefs &&
                      "modelKey" in args.videoGenerationPrefs
                    ? String(args.videoGenerationPrefs.modelKey || "")
                    : "",
            resolution:
              typeof args.videoGenerationPrefs === "object" &&
              args.videoGenerationPrefs &&
              "resolution" in args.videoGenerationPrefs
                ? String(args.videoGenerationPrefs.resolution || "")
                : "",
            mode:
              typeof args.videoGenerationPrefs === "object" &&
              args.videoGenerationPrefs &&
              "mode" in args.videoGenerationPrefs
                ? String(args.videoGenerationPrefs.mode || "")
                : "",
            provider:
              typeof args.videoGenerationPrefs === "object" &&
              args.videoGenerationPrefs &&
              "provider" in args.videoGenerationPrefs
                ? String((args.videoGenerationPrefs as { provider?: string }).provider || "")
                : "",
            aspectRatio:
              typeof args.aspectRatio === "string"
                ? args.aspectRatio
                : typeof args.videoGenerationPrefs === "object" &&
                    args.videoGenerationPrefs &&
                    "aspectRatio" in args.videoGenerationPrefs
                  ? String((args.videoGenerationPrefs as { aspectRatio?: string }).aspectRatio || "")
                  : "",
            contentSummary: videoContentSummary,
          },
        }),
      );
    }

    let result: Awaited<ReturnType<typeof runWorkflowAction>>;
    try {
      result = await runWorkflowAction(actionName, args, runtime, (partial) => {
        if (partial.summary?.trim()) {
          emitWorkflowProgress(progressId, "progress", partial.summary.trim(), onProgress);
        }
      });
    } catch (error) {
      emitWorkflowProgress(
        progressId,
        "error",
        `执行失败：${actionLabel}${error instanceof Error ? ` · ${error.message}` : ""}`,
        onProgress,
      );
      throw error;
    }

    context.setAppState?.((previous) => mergeRuntimeState(previous as StudioRuntimeState, result.data));

    // 当 LLM agent 通过工具创建或更新项目时，派发运行时 delta 事件
    // 确保 activeProjectId 被设置，使会话能够正常保存（参考改编/视频工作流入口依赖此机制）
    const deltaSnapshot = result.data?.projectSnapshot ?? result.projectSnapshot ?? null;
    if (deltaSnapshot && result.data) {
      emitHomeAgentWorkflowRuntimeDelta({
        action: actionName,
        projectId: deltaSnapshot.projectId,
        summary: result.summary,
        data: result.data,
      });
    }

    emitWorkflowProgress(progressId, "complete", `已完成：${result.summary}`, onProgress);

    // 如果 action 返回了图片 URL，派发事件让聊天框注入图片消息
    if (result.imageUrls?.length && typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("agent:image-generated", {
          detail: {
            imageUrls: result.imageUrls,
            imageLabels: result.imageLabels,
            actionLabel,
            action: actionName,
            count: result.imageUrls.length,
            modelFamily: String(args.selectedImageModelFamily || args.modelFamily || ""),
            resolution:
              typeof args.resolution === "string"
                ? args.resolution
                : typeof args.imageGenerationPrefs === "object" &&
                    args.imageGenerationPrefs &&
                    "resolution" in args.imageGenerationPrefs
                  ? String(args.imageGenerationPrefs.resolution || "")
                  : "",
            aspectRatio:
              typeof args.aspectRatio === "string"
                ? args.aspectRatio
                : typeof args.imageGenerationPrefs === "object" &&
                    args.imageGenerationPrefs &&
                    "aspectRatio" in args.imageGenerationPrefs
                  ? String(args.imageGenerationPrefs.aspectRatio || "")
                  : "",
            contentSummary: imageContentSummary,
          },
        }),
      );
    }

    if (result.videoUrls?.length && typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("agent:video-generated", {
          detail: {
            videoUrls: result.videoUrls,
            action: actionName,
            count: result.videoUrls.length,
            model:
              typeof args.selectedVideoModelKey === "string"
                ? args.selectedVideoModelKey
                : typeof args.videoModelKey === "string"
                  ? args.videoModelKey
                  : typeof args.videoGenerationPrefs === "object" &&
                      args.videoGenerationPrefs &&
                      "modelKey" in args.videoGenerationPrefs
                    ? String(args.videoGenerationPrefs.modelKey || "")
                    : "",
            resolution:
              typeof args.videoGenerationPrefs === "object" &&
              args.videoGenerationPrefs &&
              "resolution" in args.videoGenerationPrefs
                ? String(args.videoGenerationPrefs.resolution || "")
                : "",
            mode:
              typeof args.videoGenerationPrefs === "object" &&
              args.videoGenerationPrefs &&
              "mode" in args.videoGenerationPrefs
                ? String(args.videoGenerationPrefs.mode || "")
                : "",
            provider:
              typeof args.videoGenerationPrefs === "object" &&
              args.videoGenerationPrefs &&
              "provider" in args.videoGenerationPrefs
                ? String((args.videoGenerationPrefs as { provider?: string }).provider || "")
                : "",
            contentSummary: videoContentSummary,
          },
        }),
      );
    }

    return {
      data: JSON.stringify(
        {
          summary: result.summary,
          recommendedActions: result.recommendedActions ?? result.projectSnapshot?.recommendedActions ?? [],
          projectSnapshot: result.projectSnapshot ?? result.data?.projectSnapshot ?? null,
          ...(result.imageUrls?.length ? { imageUrls: result.imageUrls } : {}),
          ...(result.videoUrls?.length ? { videoUrls: result.videoUrls } : {}),
        },
        null,
        2,
      ),
    };
  }
}

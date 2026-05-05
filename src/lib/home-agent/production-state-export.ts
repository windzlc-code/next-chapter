import { getResolvedFilesStoragePath } from "@/lib/storage-path";
import type { PersistedVideoProject } from "@/hooks/use-local-persistence";
import { synchronizeVideoProductionState } from "./video-production-memory";

const EXPORT_SUBDIR = "home-agent/production-state";

function safeSegment(value: string): string {
  const normalized = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-");
  const compact = normalized.replace(/\s+/g, "-");
  return compact.slice(0, 80) || "project";
}

function joinPath(base: string, ...segments: string[]): string {
  const trimmedBase = base.replace(/[\\/]+$/g, "");
  const trimmedSegments = segments.map((segment) => segment.replace(/^[\\/]+|[\\/]+$/g, ""));
  return [trimmedBase, ...trimmedSegments].join("/");
}

function stringify(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export interface VideoProductionBundleExportResult {
  directoryPath: string;
  overviewPath: string;
  filePaths: string[];
  exportedCount: number;
}

export function buildVideoProductionBundlePreviewMessage(project: PersistedVideoProject): string {
  const synced = synchronizeVideoProductionState(project);
  return [
    `当前《${synced.title || synced.id}》的生产状态包摘要如下：`,
    "",
    `- 项目 ID：${synced.id}`,
    `- 当前步骤：${synced.currentStep}`,
    `- 目标平台：${synced.targetPlatform || "未设置"}`,
    `- 镜头风格：${synced.shotStyle || "未设置"}`,
    `- 产出目标：${synced.outputGoal || "未设置"}`,
    `- 场景数：${synced.scenes.length}`,
    `- 角色数：${synced.characters.length}`,
    `- 场景设定数：${synced.sceneSettings.length}`,
    `- 资产清单：${synced.assetManifest?.items.length ?? 0} 项`,
    `- 镜头指令包：${synced.shotPackets?.length ?? 0} 个`,
    "",
    "导出内容会包含：overview / style-lock / world-model / asset-manifest / shot-packets / README。",
    "这份摘要只用于首页内预览，不会改动当前项目运行态。",
  ].join("\n");
}

export function buildVideoProductionBundleDirectory(rootPath: string, project: PersistedVideoProject): string {
  const folderName = `${safeSegment(project.title || project.id)}-${safeSegment(project.id)}`;
  return joinPath(rootPath, EXPORT_SUBDIR, folderName);
}

export async function resolveVideoProductionBundleDirectory(
  project: PersistedVideoProject,
): Promise<string> {
  const rootPath = await getResolvedFilesStoragePath();
  if (!rootPath) {
    throw new Error("当前环境无法获取本地文件目录，无法定位生产状态包目录。");
  }

  return buildVideoProductionBundleDirectory(rootPath, synchronizeVideoProductionState(project));
}

export async function exportVideoProductionBundle(
  project: PersistedVideoProject,
): Promise<VideoProductionBundleExportResult> {
  const rootPath = await getResolvedFilesStoragePath();
  if (!rootPath) {
    throw new Error("当前环境无法获取本地文件目录，无法导出生产状态包。");
  }

  const writer = window.electronAPI?.storage?.writeText;
  if (!writer) {
    throw new Error("当前环境不支持本地文件导出。");
  }

  const synced = synchronizeVideoProductionState(project);
  const directoryPath = buildVideoProductionBundleDirectory(rootPath, synced);
  const files: Array<{ name: string; content: string }> = [
    {
      name: "overview.json",
      content: stringify({
        projectId: synced.id,
        title: synced.title,
        updatedAt: synced.updatedAt,
        currentStep: synced.currentStep,
        targetPlatform: synced.targetPlatform,
        shotStyle: synced.shotStyle,
        outputGoal: synced.outputGoal,
        artStyle: synced.artStyle,
        counts: {
          scenes: synced.scenes.length,
          characters: synced.characters.length,
          sceneSettings: synced.sceneSettings.length,
          assetManifestItems: synced.assetManifest?.items.length ?? 0,
          shotPackets: synced.shotPackets?.length ?? 0,
        },
      }),
    },
    {
      name: "style-lock.json",
      content: stringify(synced.styleLock ?? null),
    },
    {
      name: "world-model.json",
      content: stringify(synced.worldModel ?? null),
    },
    {
      name: "asset-manifest.json",
      content: stringify(synced.assetManifest ?? null),
    },
    {
      name: "shot-packets.json",
      content: stringify(synced.shotPackets ?? []),
    },
  ];

  const filePaths: string[] = [];
  for (const file of files) {
    const filePath = joinPath(directoryPath, file.name);
    const result = await writer(filePath, file.content);
    if (!result.ok) {
      throw new Error(result.error || `导出 ${file.name} 失败。`);
    }
    filePaths.push(filePath);
  }

  const overviewPath = joinPath(directoryPath, "README.md");
  const readme = [
    "# Video Production State Bundle",
    "",
    `项目：${synced.title || synced.id}`,
    `项目 ID：${synced.id}`,
    `导出时间：${new Date().toISOString()}`,
    "",
    "## Included Files",
    "- overview.json",
    "- style-lock.json",
    "- world-model.json",
    "- asset-manifest.json",
    "- shot-packets.json",
    "- review-queue.json",
    "",
    "这是一份受控导出的生产状态包，用于审计、复盘或迁移，不会改变当前项目运行态。",
    "",
  ].join("\n");
  const overviewResult = await writer(overviewPath, readme);
  if (!overviewResult.ok) {
    throw new Error(overviewResult.error || "导出生产状态包说明文件失败。");
  }

  return {
    directoryPath,
    overviewPath,
    filePaths,
    exportedCount: files.length + 1,
  };
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedVideoProject } from "./use-local-persistence";

let diskProjects: PersistedVideoProject[] = [];

const mockGetProjectsFilePath = vi.fn(async () => "mock-projects.json");
const mockReadJsonFile = vi.fn(async () => structuredClone(diskProjects));
const mockWriteJsonFile = vi.fn(async (_path: string, data: PersistedVideoProject[]) => {
  diskProjects = structuredClone(data);
  return true;
});

vi.mock("@/lib/file-cache", () => ({
  getProjectsFilePath: mockGetProjectsFilePath,
  readJsonFile: mockReadJsonFile,
  writeJsonFile: mockWriteJsonFile,
  scanProjectDirectoryIds: vi.fn(async () => []),
  readProjectManifest: vi.fn(async () => null),
  remapLocalPathToCurrentRoot: vi.fn(async (value: string) => value),
}));

vi.mock("@/lib/home-agent/conversation-archive", () => ({
  writeConversationArchiveProject: vi.fn(),
}));

function createProject(
  overrides: Partial<PersistedVideoProject> = {},
): PersistedVideoProject {
  return {
    id: "video-project-1",
    title: "Video Project",
    script: "script body",
    targetPlatform: "",
    shotStyle: "",
    outputGoal: "",
    productionNotes: "",
    scenes: [],
    characters: [],
    sceneSettings: [],
    artStyle: "live-action",
    currentStep: 1,
    systemPrompt: "",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  } as PersistedVideoProject;
}

describe("deleteStoredVideoProjectById", () => {
  beforeEach(async () => {
    diskProjects = [];
    localStorage.clear();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("keeps the localStorage mirror in sync when deleting a file-backed video project", async () => {
    const target = createProject({ id: "video-project-delete" });
    const sibling = createProject({ id: "video-project-keep", title: "Keep Project" });
    diskProjects = [target, sibling];
    localStorage.setItem("storyforge_projects", JSON.stringify([target, sibling]));

    const persistence = await import("./use-local-persistence");

    await persistence.deleteStoredVideoProjectById(target.id);

    expect(diskProjects.map((project) => project.id)).toEqual([sibling.id]);
    expect(
      JSON.parse(localStorage.getItem("storyforge_projects") || "[]").map((project: PersistedVideoProject) => project.id),
    ).toEqual([sibling.id]);
    await expect(persistence.loadStoredVideoProjectById(target.id)).resolves.toBeNull();
    await expect(persistence.listStoredVideoProjects({ fast: true })).resolves.toEqual([
      expect.objectContaining({ id: sibling.id }),
    ]);
  });
});

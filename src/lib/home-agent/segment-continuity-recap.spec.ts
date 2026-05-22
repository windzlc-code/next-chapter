import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { PersistedVideoProject } from "@/hooks/use-local-persistence";

import {
  buildSegmentContinuityRecapText,
  formatSegmentContinuityRecapDisplayText,
  resolveSegmentContinuityRecapText,
} from "./segment-continuity-recap";

function loadProject(projectId: string): PersistedVideoProject {
  const projects = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "files", "projects", "projects.json"), "utf8"),
  ) as PersistedVideoProject[];
  const project = projects.find((entry) => entry.id === projectId);
  if (!project) {
    throw new Error(`missing project fixture: ${projectId}`);
  }
  return project;
}

describe("segment-continuity-recap", () => {
  it("builds a natural-language recap that covers state, scene, action, and event", () => {
    const project = loadProject("mpc72nnakuy1a82irno");

    const recap = buildSegmentContinuityRecapText(project, "1-1");

    expect(recap).not.toContain("人物状态：");
    expect(recap).not.toContain("场景描述：");
    expect(recap).not.toContain("人物动作：");
    expect(recap).not.toContain("发生事件：");
    expect(recap).not.toContain("前情提要");
    expect(recap).toContain("烈日如火");
    expect(recap).toContain("陆家演武场");
    expect(recap).toContain("陆沉");
    expect(recap).toContain("萧家执事");
    expect(recap).toContain("尖刀");
  });

  it("upgrades fixed-label recap text back to natural language", () => {
    const project = loadProject("mpc72nnakuy1a82irno");
    const stored =
      "人物状态：陆沉被锁在铜柱上。场景描述：场景位于陆家演武场。人物动作：萧家执事举起尖刀。发生事件：刀刃即将刺下。";

    const recap = resolveSegmentContinuityRecapText(project, "1-1", stored);

    expect(recap).toBe(buildSegmentContinuityRecapText(project, "1-1"));
    expect(recap).not.toContain("人物状态：");
    expect(recap).not.toBe(stored);
  });

  it("adds a fixed display prefix without duplicating it", () => {
    expect(formatSegmentContinuityRecapDisplayText("苏辰倒地。")).toBe("前情提要：苏辰倒地。");
    expect(formatSegmentContinuityRecapDisplayText("前情提要：苏辰倒地。")).toBe("前情提要：苏辰倒地。");
  });
});

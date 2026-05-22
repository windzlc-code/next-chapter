import { describe, expect, it } from "vitest";
import {
  extractDetailedMermaidCode,
  extractMermaidCode,
  parseDramaDirectoryText,
  repairDramaDirectoryFromRaw,
  stripMermaidCodeBlocks,
} from "./script-artifact-helpers";

describe("script-artifact-helpers mermaid extraction", () => {
  it("detects the detailed diagram from heading context when both fences use mermaid", () => {
    const text = [
      "角色说明",
      "",
      "**简单关系图**",
      "```mermaid",
      "graph TD",
      "    A[陆沉] --> B[苏清月]",
      "```",
      "",
      "**详细关系图**（含 NPC/配角）",
      "```mermaid",
      "graph TD",
      "    A[陆沉] --> B[苏清月]",
      "    C[大皇子] --> A",
      "    D[管家] --> B",
      "```",
    ].join("\n");

    expect(extractMermaidCode(text)).toContain("A[陆沉] --> B[苏清月]");
    expect(extractDetailedMermaidCode(text)).toContain("D[管家] --> B");
  });

  it("strips mermaid blocks even when the fence info contains extra qualifiers", () => {
    const text = [
      "角色正文",
      "",
      "```mermaid detailed",
      "graph TD",
      "    A --> B",
      "```",
      "",
      "结尾说明",
    ].join("\n");

    expect(stripMermaidCodeBlocks(text)).toBe("角色正文\n\n结尾说明");
  });
});

describe("script-artifact-helpers directory repair", () => {
  it("ignores non-string raw directory payloads without crashing", () => {
    const existingDirectory = [
      {
        number: 1,
        title: "签下合约",
        summary: "女主被迫签下婚姻合约。",
        hookType: "悬念钩子",
        isKey: false,
        isClimax: false,
        isPaywall: false,
      },
    ];

    expect(parseDramaDirectoryText(undefined)).toEqual([]);
    expect(parseDramaDirectoryText({ broken: true })).toEqual([]);
    expect(repairDramaDirectoryFromRaw(undefined, existingDirectory)).toEqual(existingDirectory);
    expect(repairDramaDirectoryFromRaw({ broken: true }, existingDirectory)).toEqual(existingDirectory);
  });
});

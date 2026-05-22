import { describe, expect, it } from "vitest";
import {
  advanceAdaptationWorkflowUploadSuggestion,
  buildAdaptationWorkflowStartDialogPrompt,
  buildAdaptationWorkflowUploadSuggestionRequest,
} from "./adaptation-workflow-kickoff";

describe("buildAdaptationWorkflowStartDialogPrompt", () => {
  it("asks the llm to reply first with guidance before structured follow-up", () => {
    const prompt = buildAdaptationWorkflowStartDialogPrompt();

    expect(prompt).toContain("\u8bf7\u4ece\u96f6\u5f00\u59cb\u548c\u6211\u5bf9\u8bdd");
    expect(prompt).toContain("AskUserQuestion");
    expect(prompt).toContain("\u9996\u8f6e\u56de\u590d\u5148\u7528\u7b80\u77ed\u81ea\u7136\u8bed\u8a00");
    expect(prompt).toContain("\u4e0d\u8981\u7acb\u5373\u8c03\u7528 AskUserQuestion");
  });
});

describe("buildAdaptationWorkflowUploadSuggestionRequest", () => {
  it("provides a single upload-document shortcut after direct dialog starts", () => {
    const request = buildAdaptationWorkflowUploadSuggestionRequest();

    expect(request.id).toContain("adaptation-workflow-upload-suggestion");
    expect(request.title).toBe("\u4e0b\u4e00\u6b65\u5efa\u8bae");
    expect(request.questions[0]?.options).toEqual([
      expect.objectContaining({
        label: "\u4e0a\u4f20\u53c2\u8003\u6587\u6863",
        value: "upload-document",
      }),
    ]);
  });
});

describe("advanceAdaptationWorkflowUploadSuggestion", () => {
  it("maps the upload shortcut to an upload-document completion payload", () => {
    expect(
      advanceAdaptationWorkflowUploadSuggestion({
        value: "upload-document",
        label: "\u4e0a\u4f20\u53c2\u8003\u6587\u6863",
      }),
    ).toEqual({
      source: "upload-document",
      userBubble: "\u4e0b\u4e00\u6b65\u5efa\u8bae\uff1a\u4e0a\u4f20\u53c2\u8003\u6587\u6863",
    });
  });
});

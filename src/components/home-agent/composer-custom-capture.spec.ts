import { describe, expect, it } from "vitest";
import type { ComposerQuestion } from "@/lib/home-agent/types";
import { getComposerCustomCaptureDescriptor } from "./composer-custom-capture";

describe("getComposerCustomCaptureDescriptor", () => {
  it("ignores dev-only custom duration inputs in ordinary workflow questions", () => {
    const question: ComposerQuestion = {
      id: "script-episode-question",
      title: "正文撰写",
      description: "已生成预览，选择生成方式",
      answerKey: "script-episode",
      allowCustomInput: false,
      submissionMode: "immediate",
      options: [
        {
          id: "episode-duration",
          label: "设定单集时长",
          value: "script:episode-duration",
          devOnly: true,
          children: [
            {
              id: "episode-duration-60",
              label: "60 秒",
              value: "script:episode-duration:60",
            },
          ],
          childInput: {
            type: "number",
            actionPrefix: "script:episode-duration:custom:",
            buttonLabel: "设定自定义时长",
            labelTemplate: "自定义 {value} 秒",
            min: 30,
            max: 600,
            placeholder: "输入秒数",
            suffix: "秒",
          },
        },
        {
          id: "episode-batch",
          label: "自动批量补齐",
          value: "script:episode-generate-batch",
        },
      ],
    };

    expect(getComposerCustomCaptureDescriptor(question)).toBeNull();
  });
});

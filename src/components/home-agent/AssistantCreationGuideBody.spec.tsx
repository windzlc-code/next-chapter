import { fireEvent, render, screen } from "@testing-library/react";

import { AssistantCreationGuideBody } from "./AssistantCreationGuideBody";

describe("AssistantCreationGuideBody", () => {
  it("renders chinese-numbered major headings as collapsible sections", () => {
    render(
      <AssistantCreationGuideBody
        content={[
          "一. 项目基本信息",
          "- 项目类型：原创电视剧",
          "- 题材类型：都市言情",
          "",
          "二、项目定位",
          "1. 核心定位",
          "一句话定位内容。",
        ].join("\n")}
      />,
    );

    const firstToggle = screen.getByRole("button", { name: /一\. 项目基本信息/ });
    expect(screen.getByText((content) => content.includes("项目类型：原创电视剧"))).toBeInTheDocument();

    fireEvent.click(firstToggle);
    expect(screen.queryByText((content) => content.includes("项目类型：原创电视剧"))).not.toBeInTheDocument();

    fireEvent.click(firstToggle);
    expect(screen.getByText((content) => content.includes("项目类型：原创电视剧"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /二、项目定位/ })).toBeInTheDocument();
  });

  it("falls back to plain markdown rendering when no major sections exist", () => {
    render(<AssistantCreationGuideBody content={"普通说明文字\n\n- 第一条\n- 第二条"} />);

    expect(screen.queryByRole("button", { name: /项目基本信息/ })).not.toBeInTheDocument();
    expect(screen.getByText("普通说明文字")).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes("第一条"))).toBeInTheDocument();
  });

  it("does not render hidden think blocks", () => {
    render(
      <AssistantCreationGuideBody
        content={[
          "<think>",
          "Initiating Plan Generation",
          "Internal chain",
          "</think>",
          "",
          "最终给用户的中文结论。",
        ].join("\n")}
      />,
    );

    expect(screen.queryByText("Initiating Plan Generation")).not.toBeInTheDocument();
    expect(screen.getByText("最终给用户的中文结论。")).toBeInTheDocument();
  });

  it("collapses storyboard summary tables by clickable segment headings", () => {
    render(
      <AssistantCreationGuideBody
        content={[
          "当前可生成分镜图：2 / 4",
          "",
          "## 片段 1-1｜雨夜长街",
          "",
          "| 镜头编号 | 名称 | 分镜图状态 | 角色参考 | 场景参考 |",
          "| --- | --- | --- | --- | --- |",
          "| 镜头 1 | 雨夜追击 | 可生成 | 沈棠 | 雨夜长街 |",
          "",
          "## 片段 1-2｜办公室门口",
          "",
          "| 镜头编号 | 名称 | 分镜图状态 | 角色参考 | 场景参考 |",
          "| --- | --- | --- | --- | --- |",
          "| 镜头 3 | 办公室门口 | 已生成 | 沈棠、顾临 | 办公室门口 |",
        ].join("\n")}
      />,
    );

    const firstToggle = screen.getByRole("button", { name: /片段 1-1｜雨夜长街/ });
    expect(screen.getByText((content) => content.includes("雨夜追击"))).toBeInTheDocument();

    fireEvent.click(firstToggle);
    expect(screen.queryByText((content) => content.includes("雨夜追击"))).not.toBeInTheDocument();

    fireEvent.click(firstToggle);
    expect(screen.getByText((content) => content.includes("雨夜追击"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /片段 1-2｜办公室门口/ })).toBeInTheDocument();
  });

  it("collapses shot-packet summary tables by markdown headings", () => {
    render(
      <AssistantCreationGuideBody
        content={[
          "已为《测试项目》编译 2 个镜头指令包。",
          "",
          "## 镜头指令包摘要（2）",
          "",
          "| 镜头 | 标题 | 时长 | 模式 | 角色 | 场景 |",
          "| --- | --- | --- | --- | --- | --- |",
          "| 镜头 1 | 雨夜追击 | 5s | img2video | 沈棠 | 雨夜长街 |",
          "| 镜头 2 | 追兵逼近 | 4s | text2video | 沈棠 | 巷口 |",
        ].join("\n")}
      />,
    );

    const toggle = screen.getByRole("button", { name: /镜头指令包摘要（2）/ });
    expect(screen.getByText((content) => content.includes("雨夜追击"))).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByText((content) => content.includes("雨夜追击"))).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByText((content) => content.includes("追兵逼近"))).toBeInTheDocument();
  });

  it("keeps generated video prompt lists collapsed by default", () => {
    render(
      <AssistantCreationGuideBody
        content={[
          "单批生成已完成：当前没有未覆盖的片段镜头。",
          "",
          "## 第 1 集",
          "",
          "**片段 1-1（12s）｜仙界断魂崖（已覆盖 2 / 待生成 0 / 总数 2）**",
          "  镜头 1 — 5s（已覆盖）",
          "  镜头 2 — 7s（已覆盖）",
          "",
          "## 当前批次资产状态（文生视频模式）",
          "",
          "角色参考：",
          "叶灵汐 — [缺失]",
        ].join("\n")}
      />,
    );

    const episodeToggle = screen.getByRole("button", { name: /第 1 集/ });
    const assetToggle = screen.getByRole("button", { name: /当前批次资产状态/ });

    expect(episodeToggle).toHaveAttribute("aria-expanded", "false");
    expect(assetToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText((content) => content.includes("镜头 1"))).not.toBeInTheDocument();
    expect(screen.queryByText((content) => content.includes("叶灵汐"))).not.toBeInTheDocument();

    fireEvent.click(episodeToggle);
    expect(episodeToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /片段 1-1/ })).toBeInTheDocument();

    fireEvent.click(assetToggle);
    expect(assetToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText((content) => content.includes("叶灵汐"))).toBeInTheDocument();
  });

  it("renders storyboard breakdown blocks with the lead shot description intact", () => {
    const breakdown = {
      summary: {
        total_episodes: 1,
        total_clips: 1,
        total_duration: "60s",
      },
      episodes: [
        {
          episode: "第1集",
          summary: {
            clips_count: 1,
            total_duration: "60s",
          },
          clips: [
            {
              id: "segment-1",
              title: "片段 1-1",
              duration: "60s",
              tags: ["星澜传媒办公室", "夏初", "王文", "\\u6dfb\\u52a0\\u6807\\u7b7e"],
              shots: [
                {
                  index: 1,
                  content:
                    "全景：深夜的办公室灯火通明，[夏初]独自坐在工位前 | Dialogue: 王文，我要现在看到方案 | Role: [夏初] [王文] | Camera: 无字幕、无水印、无背景音",
                  links: 0,
                },
                {
                  index: 2,
                  content:
                    "特写：[夏初]疲惫地按着太阳穴，手腕上的沉香珠陪着她熬夜 | Role: [夏初] | Camera: 无字幕、无水印、无背景音",
                  links: 0,
                },
              ],
              footer_info: "无字幕、无水印、无背景音",
            },
          ],
        },
      ],
    };

    render(
      <AssistantCreationGuideBody
        content={["拆镜结果如下：", "", "```json", JSON.stringify(breakdown, null, 2), "```"].join("\n")}
      />,
    );

    expect(screen.getByText("第1集")).toBeInTheDocument();
    expect(screen.getByText("片段1-1")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue(
        "全景：深夜的办公室灯火通明，[夏初]独自坐在工位前",
      ),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("王文，我要现在看到方案")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue(
        "特写：[夏初]疲惫地按着太阳穴，手腕上的沉香珠陪着她熬夜",
      ),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("添加场景标签")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("添加人物标签")).toBeInTheDocument();
    expect(screen.queryByText("[添加标签]")).not.toBeInTheDocument();
  });
});

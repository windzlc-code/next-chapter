type HomeStudioStartupFallbackProps = {
  title?: string;
  description?: string;
  dataAttribute?: string;
};

const DEFAULT_TITLE = "正在恢复首页工作台";
const DEFAULT_DESCRIPTION =
  "正在加载工作台、最近项目和会话恢复状态。";

export default function HomeStudioStartupFallback({
  title = DEFAULT_TITLE,
  description = DEFAULT_DESCRIPTION,
  dataAttribute = "data-home-studio-startup-fallback",
}: HomeStudioStartupFallbackProps) {
  return (
    <div
      {...{
        [dataAttribute]: "true",
      }}
      className="flex min-h-screen items-center justify-center bg-[#090b11] px-6 text-slate-100"
    >
      <div className="w-full max-w-[420px] rounded-[28px] border border-white/[0.08] bg-white/[0.03] px-7 py-8 shadow-[0_24px_80px_rgba(0,0,0,0.32)] backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <div className="h-3 w-3 animate-pulse rounded-full bg-[#7c92ff]" />
          <div className="text-[15px] font-semibold tracking-[0.22em] text-slate-200/92">INFINIO</div>
        </div>
        <div className="mt-5 text-[26px] font-semibold leading-tight text-white">{title}</div>
        <p className="mt-3 text-[14px] leading-7 text-slate-300">{description}</p>
        <div className="mt-6 h-[2px] overflow-hidden rounded-full bg-white/[0.08]">
          <div className="h-full w-1/3 animate-[pulse_1.8s_ease-in-out_infinite] rounded-full bg-[#7c92ff]" />
        </div>
      </div>
    </div>
  );
}

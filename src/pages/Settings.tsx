import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTheme } from "next-themes";
import {
  ArrowLeft,
  FolderCog,
  FolderOpen,
  Globe,
  Key,
  Loader2,
  Moon,
  Save,
  Sparkles,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import {
  API_CONFIG_UPDATED_EVENT,
  clearApiConfig,
  DEFAULT_API_CONFIG,
  getStoredApiConfig,
  loadBuiltinApiBundleFromDisk,
  saveBuiltinApiBundle,
  saveApiConfig,
  syncApiConfigToServerProxy,
  type BuiltinApiBundle,
  type ApiConfig,
} from "@/lib/api-config";
import { readHomeAgentLaunchReadiness, type HomeAgentLaunchReadiness } from "@/lib/home-agent/launch-readiness";
import { readStoredAutomationMode, writeStoredAutomationMode } from "@/lib/home-agent/automation-mode";
import type { AutomationMode } from "@/lib/home-agent/types";
import { cn } from "@/lib/utils";

type ProviderId =
  | "gemini"
  | "gpt"
  | "claude"
  | "grok"
  | "seedream"
  | "jimeng"
  | "aliyun"
  | "runninghub"
  | "tuzi";

const API_ROWS: Array<{
  id: ProviderId;
  title: string;
  endpointPlaceholder: string;
  endpointHint: string;
  keyHint: string;
  models: string;
}> = [
  {
    id: "gemini",
    title: "Gemini API",
    endpointPlaceholder: "默认：https://api.tu-zi.com/v1beta",
    endpointHint: "Gemini 模型的 API 根地址。留空使用默认值。其他模型留空时会回退到此地址。",
    keyHint: "Gemini API Key。其他模型留空时会回退到此 Key。",
    models: "gemini-3-pro, gemini-3-pro-thinking, gemini-3-flash-preview, nano-banana-pro, nano-banana 2, nano-banana 2-async",
  },
  {
    id: "gpt",
    title: "GPT API",
    endpointPlaceholder: "默认：https://api.tu-zi.com/v1",
    endpointHint: "GPT 模型的 API 根地址。留空时复用 Gemini API 端点。",
    keyHint: "GPT API Key。留空时复用 Gemini API Key。",
    models: "gpt-5.4, gpt-5.4-mini, gpt-image-2",
  },
  {
    id: "claude",
    title: "Claude API",
    endpointPlaceholder: "默认：https://api.tu-zi.com/v1",
    endpointHint: "Claude 模型的 API 根地址。留空使用默认值。",
    keyHint: "Claude API Key。留空时复用 Gemini API Key。",
    models: "claude-sonnet-4-6, claude-sonnet-4-6-thinking, claude-opus-4-6",
  },
  {
    id: "grok",
    title: "Grok API",
    endpointPlaceholder: "默认：https://api.tu-zi.com/v1",
    endpointHint: "Grok 模型的 API 根地址。留空时复用 Gemini API 端点。",
    keyHint: "Grok API Key。留空时复用 Gemini API Key。",
    models: "grok-4.1",
  },
  {
    id: "seedream",
    title: "Seedream API",
    endpointPlaceholder: "默认：https://api.tu-zi.com/v1beta",
    endpointHint: "Seedream 图片 API 地址。留空复用 Gemini API 地址。",
    keyHint: "Seedream API Key。填写后点击保存设置生效；留空复用 Gemini API Key，未配置 Gemini 时当前未生效。",
    models: "doubao-seedream-5-0-260128",
  },
  {
    id: "aliyun",
    title: "Aliyun HappyHorse API",
    endpointPlaceholder: "默认：https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
    endpointHint: "Aliyun HappyHorse 视频 API 地址。留空使用默认值。",
    keyHint: "Aliyun API Key。填写后点击保存设置生效；未填写则当前未生效。",
    models: "happyhorse-1.0（底层自动切换 happyhorse-1.0-t2v / happyhorse-1.0-i2v / happyhorse-1.0-r2v）",
  },
  {
    id: "runninghub",
    title: "RunningHub Fallback API",
    endpointPlaceholder: "榛樿锛歨ttps://www.runninghub.cn",
    endpointHint: "RunningHub 鍏滃簳瑙嗛 API 鍦板潃銆傜暀绌轰娇鐢ㄩ粯璁ゅ€笺€?",
    keyHint: "RunningHub API Key銆傚～鍐欏悗鍙敤浜?Seedance 2.0 / Seedance 2.0 Fast / HappyHorse 瀹℃牳鍏滃簳锛屼互鍙?Seedance 2.0 2K/4K 鐩磋繛銆?",
    models: "seedance-2.0 fallback, seedance-2.0-fast fallback, happyhorse-1.0 fallback",
  },
  {
    id: "jimeng",
    title: "Seedance API",
    endpointPlaceholder: "默认：https://api.tu-zi.com/v1beta",
    endpointHint: "Seedance 视频 API 地址。留空复用 Gemini API 地址。",
    keyHint: "Seedance API Key。填写后点击保存设置生效；留空复用 Gemini API Key，未配置 Gemini 时当前未生效。",
    models: "doubao-seedance-1-5-pro_480p, doubao-seedance-1-5-pro_720p, doubao-seedance-1-5-pro_1080p, doubao-seedance-2-0-260128, doubao-seedance-2-0-fast-260128",
  },
  {
    id: "tuzi",
    title: "Sora API",
    endpointPlaceholder: "默认：https://api.tuziapi.com",
    endpointHint: "Sora 视频 API 地址。留空使用默认值。",
    keyHint: "Sora API Key。填写后点击保存设置生效；未填写则当前未生效。",
    models: "sora-2, sora-2-pro",
  },
];

const ENDPOINT_FIELD_MAP = {
  gemini: "geminiEndpoint",
  gpt: "gptEndpoint",
  claude: "claudeEndpoint",
  grok: "grokEndpoint",
  seedream: "seedreamEndpoint",
  aliyun: "aliyunEndpoint",
  runninghub: "runninghubEndpoint",
  jimeng: "jimengEndpoint",
  tuzi: "tuziEndpoint",
} as const;

const KEY_FIELD_MAP = {
  gemini: "geminiKey",
  gpt: "gptKey",
  claude: "claudeKey",
  grok: "grokKey",
  seedream: "seedreamKey",
  aliyun: "aliyunKey",
  runninghub: "runninghubKey",
  jimeng: "jimengKey",
  tuzi: "tuziKey",
} as const;

type SettingsProps = {
  embedded?: boolean;
  onClose?: () => void;
  onSaved?: () => void;
};

const SETTINGS_BLUE_VIOLET_TEXT = "text-[rgb(156,174,255)]";
const SETTINGS_BLUE_VIOLET_TEXT_SOFT = "text-[rgba(156,174,255,0.78)]";
const SETTINGS_BLUE_VIOLET_BG = "bg-[rgba(108,126,210,0.16)]";
const SETTINGS_BLUE_VIOLET_BG_HOVER = "hover:bg-[rgba(108,126,210,0.12)]";
const SETTINGS_BLUE_VIOLET_BORDER = "border-[rgba(132,150,236,0.24)]";
const SETTINGS_BLUE_VIOLET_SWITCH = "data-[state=checked]:bg-[rgb(128,108,232)]";

export default function Settings({ embedded = false, onClose, onSaved }: SettingsProps) {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const [config, setConfig] = useState<ApiConfig>(() => getStoredApiConfig());
  const [automationMode, setAutomationMode] = useState<AutomationMode>(() => readStoredAutomationMode());
  const [defaultStoragePath, setDefaultStoragePath] = useState("");
  const [adminPasswordDialogOpen, setAdminPasswordDialogOpen] = useState(false);
  const [builtinEditorOpen, setBuiltinEditorOpen] = useState(false);
  const [adminPassword, setAdminPassword] = useState("");
  const [builtinDraft, setBuiltinDraft] = useState<BuiltinApiBundle>({
    geminiEndpoint: "",
    geminiKey: "",
    gptEndpoint: "",
    gptKey: "",
    claudeEndpoint: "",
    claudeKey: "",
    grokEndpoint: "",
    grokKey: "",
    seedreamEndpoint: "",
    seedreamKey: "",
    aliyunEndpoint: "",
    aliyunKey: "",
    runninghubEndpoint: "",
    runninghubKey: "",
    jimengEndpoint: "",
    jimengKey: "",
    tuziEndpoint: "",
    tuziKey: "",
    modelMappings: {},
  });
  const [builtinSaving, setBuiltinSaving] = useState(false);
  const [launchReadiness, setLaunchReadiness] = useState<HomeAgentLaunchReadiness | null>(null);

  useEffect(() => {
    const loadDefaultPath = async () => {
      if (!window.electronAPI?.storage?.getDefaultPath) return;
      try {
        const paths = await window.electronAPI.storage.getDefaultPath();
        setDefaultStoragePath(paths.files);
      } catch (error) {
        console.error("加载默认路径失败:", error);
      }
    };
    void loadDefaultPath();
  }, []);

  const refreshLaunchReadiness = useCallback(async () => {
    try {
      setLaunchReadiness(await readHomeAgentLaunchReadiness());
    } catch (error) {
      setLaunchReadiness({
        checkedAt: new Date().toISOString(),
        textReady: false,
        textMessage: error instanceof Error ? error.message : "运行前检查失败",
        image: {
          ready: false,
          label: "图像生成待配置",
          detail: error instanceof Error ? error.message : "运行前检查失败",
          tone: "warning",
        },
        video: {
          mode: "api",
          ready: false,
          label: "当前默认走 API",
          detail: "运行前检查失败",
          tone: "warning",
        },
        notice: {
          level: "critical",
          title: "首发运行前检查失败",
          description: error instanceof Error ? error.message : "请先检查设置或稍后再试。",
          actions: [{ id: "open_settings", label: "检查设置" }],
        },
      });
    }
  }, []);

  useEffect(() => {
    void refreshLaunchReadiness();
  }, [refreshLaunchReadiness]);

  useEffect(() => {
    const handleConfigUpdate = () => {
      void refreshLaunchReadiness();
    };
    window.addEventListener(API_CONFIG_UPDATED_EVENT, handleConfigUpdate);
    return () => window.removeEventListener(API_CONFIG_UPDATED_EVENT, handleConfigUpdate);
  }, [refreshLaunchReadiness]);

  const handleSave = async () => {
    saveApiConfig(config);
    let proxySyncWarning = "";
    try {
      await syncApiConfigToServerProxy(config);
    } catch (error) {
      proxySyncWarning = error instanceof Error ? error.message : String(error);
      console.warn("API config saved locally, but local proxy sync failed:", error);
    }
    writeStoredAutomationMode(automationMode);
    setConfig(getStoredApiConfig());
    void refreshLaunchReadiness();
    onSaved?.();
    toast({
      title: "已保存",
      description: proxySyncWarning
        ? `设置已保存到本地，但同步到本地代理失败：${proxySyncWarning}`
        : "设置已保存到本地，并已同步到本地代理。",
      variant: proxySyncWarning ? "destructive" : undefined,
    });
  };

  const handleAutomationModeChange = (mode: AutomationMode) => {
    const normalized = writeStoredAutomationMode(mode);
    setAutomationMode(normalized);
    onSaved?.();
  };

  const handleOpenBuiltinAdminDialog = async () => {
    try {
      const latest = await loadBuiltinApiBundleFromDisk();
      if (latest) {
        setBuiltinDraft(latest);
      }
      setAdminPassword("");
      setAdminPasswordDialogOpen(true);
    } catch (error) {
      toast({
        title: "读取失败",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  };

  const handleVerifyBuiltinAdminPassword = async () => {
    const verify = window.electronAPI?.runtime?.verifyBuiltinApiAdminPassword;
    if (!verify) {
      toast({
        title: "当前环境不支持",
        description: "仅桌面端可验证管理员密码。",
        variant: "destructive",
      });
      return;
    }
    const isValid = await verify(adminPassword);
    if (!isValid) {
      toast({
        title: "管理员密码错误",
        description: "请输入正确的管理员密码后再修改内置 API。",
        variant: "destructive",
      });
      return;
    }
    setAdminPassword("");
    setAdminPasswordDialogOpen(false);
    setBuiltinEditorOpen(true);
  };

  const setBuiltinField = (
    field: Exclude<keyof BuiltinApiBundle, "modelMappings">,
    value: string,
  ) => {
    setBuiltinDraft((prev) => ({ ...prev, [field]: value }));
  };

  const handleSaveBuiltinApi = async () => {
    setBuiltinSaving(true);
    try {
      await saveBuiltinApiBundle({
        ...builtinDraft,
        modelMappings: builtinDraft.modelMappings || {},
      });
      setBuiltinEditorOpen(false);
      await refreshLaunchReadiness();
      onSaved?.();
      toast({
        title: "内置 API 已更新",
        description: "新的 API Key 已写入内置配置，当前运行可立即生效。",
      });
    } catch (error) {
      toast({
        title: "保存失败",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setBuiltinSaving(false);
    }
  };

  const handleClear = () => {
    clearApiConfig();
    setConfig({ ...DEFAULT_API_CONFIG });
    void refreshLaunchReadiness();
    onSaved?.();
    toast({ title: "已清除", description: "所有设置已恢复默认值。" });
  };

  const handleSelectStoragePath = async () => {
    if (!window.electronAPI?.storage?.selectFolder) return;
    try {
      const folderPath = await window.electronAPI.storage.selectFolder();
      if (!folderPath) return;
      saveApiConfig({ storagePath: folderPath });
      setConfig((prev) => ({ ...prev, storagePath: folderPath }));
      onSaved?.();
      toast({ title: "已保存", description: `存储路径：${folderPath}` });
    } catch (error) {
      toast({ title: "选择失败", description: String(error), variant: "destructive" });
    }
  };

  const handleResetStoragePath = () => {
    saveApiConfig({ storagePath: "" });
    setConfig((prev) => ({ ...prev, storagePath: "" }));
    onSaved?.();
    toast({ title: "已重置", description: "存储路径已恢复默认值。" });
  };

  const sectionTitleClass = embedded
    ? "flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground"
    : "text-sm font-medium flex items-center gap-2";
  const cardClass = embedded
    ? "rounded-[20px] border border-border bg-card shadow-none"
    : "";
  const cardContentClass = embedded ? "pt-4 space-y-3" : "pt-6 space-y-4";
  const compactInputClass = embedded
    ? "h-9 font-mono text-[12px] shadow-none"
    : "font-mono text-sm";
  const gridClass = embedded ? "grid grid-cols-1 gap-3" : "grid grid-cols-1 md:grid-cols-2 gap-6";
  const embeddedOutlineButtonClass = embedded
    ? "h-8.5 rounded-full border-border px-3 text-[12px] font-medium hover:bg-accent hover:text-accent-foreground disabled:opacity-40 disabled:cursor-not-allowed"
    : "";
  const embeddedGhostTextButtonClass = embedded
    ? "px-0 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground disabled:opacity-40"
    : "text-xs";
  const embeddedTitleTextClass = embedded ? "text-sm font-medium text-foreground" : "text-sm font-medium text-foreground";
  const embeddedLabelTextClass = embedded ? "text-sm font-medium text-foreground" : "text-sm font-medium";
  const embeddedMutedTextClass = embedded ? "text-xs leading-5 text-muted-foreground" : "text-xs leading-5 text-muted-foreground";
  const embeddedMonoMutedTextClass = embedded
    ? "mt-1.5 break-all font-mono text-[11.5px] text-muted-foreground"
    : "mt-1.5 break-all font-mono text-[11.5px] text-muted-foreground";
  const launchTextBadgeClass = launchReadiness?.textReady
    ? "border border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
    : "border border-rose-500/40 bg-rose-500/10 text-rose-400";
  const launchImageBadgeClass = launchReadiness?.image.ready
    ? "border border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
    : "border border-amber-500/40 bg-amber-500/10 text-amber-400";
  const launchVideoBadgeClass = launchReadiness?.video.ready
    ? "border border-sky-500/40 bg-sky-500/10 text-sky-400"
    : "border border-amber-500/40 bg-amber-500/10 text-amber-400";
  const uniqueModeBadgeClass = "border border-border bg-muted text-muted-foreground";

  return (
    <div
        className={cn(
          embedded
          ? "flex h-full min-h-0 flex-col bg-transparent text-foreground"
          : "min-h-screen bg-background",
        )}
      >
      {!embedded && (
        <header className="flex items-center gap-3 px-6 py-4 border-b border-border/50">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-lg font-semibold font-[Space_Grotesk]">设置</h1>
        </header>
      )}

      {embedded && (
        <div className="flex items-center justify-between border-b border-border px-4 py-3.5">
          <div>
            <h1 className="text-[1.18rem] font-semibold tracking-[-0.035em] text-foreground">设置</h1>
            <p className="mt-0.5 text-[12px] text-muted-foreground">在首页内调整模型、路径与界面行为。</p>
          </div>
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full border border-border text-muted-foreground hover:text-foreground"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}

      <main
        className={embedded ? "settings-scrollbar flex-1 overflow-y-auto px-4 py-4 space-y-4" : "max-w-3xl mx-auto px-6 py-6 space-y-6"}
      >
        <div className="space-y-2.5">
          <h2 className={sectionTitleClass}>
            <Sparkles className="h-4 w-4" />
            工作模式
          </h2>
          <Card className={cardClass}>
            <CardContent className={cardContentClass}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <h3 className={embeddedTitleTextClass}>首页 Agent 模式</h3>
                  <p className={cn("mt-0.5", embeddedMutedTextClass)}>
                    普通模式和全自动模式的入口、会话历史与项目状态会分开保存。
                  </p>
                </div>
                <div className={cn("inline-flex shrink-0 rounded-[10px] border bg-muted/30 p-0.5", SETTINGS_BLUE_VIOLET_BORDER)}>
                  {([
                    ["manual", "普通模式"],
                    ["full-auto", "全自动模式"],
                  ] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => handleAutomationModeChange(mode)}
                      className={cn(
                        "h-8 rounded-[8px] px-3 text-[12px] font-medium transition-colors",
                        automationMode === mode
                          ? `${SETTINGS_BLUE_VIOLET_BG} ${SETTINGS_BLUE_VIOLET_TEXT} font-semibold shadow-sm`
                          : `${SETTINGS_BLUE_VIOLET_TEXT_SOFT} ${SETTINGS_BLUE_VIOLET_BG_HOVER} hover:text-[rgb(156,174,255)]`,
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-2.5">
          <h2 className={sectionTitleClass}>
            <Sparkles className="h-4 w-4" />
            首发运行前检查
          </h2>
          <Card className={cardClass}>
            <CardContent className={cardContentClass}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={launchTextBadgeClass}>
                  {launchReadiness?.textReady ? "主会话已就绪" : "主会话待配置"}
                </Badge>
                <Badge className={launchImageBadgeClass}>
                  {launchReadiness?.image.ready ? "图像已就绪" : "图像待配置"}
                </Badge>
                <Badge className={launchVideoBadgeClass}>
                  视频通道：{launchReadiness?.video.mode === "cli" ? "CLI" : "API"}
                </Badge>
              </div>
              <div className="space-y-1">
                <p className={embeddedTitleTextClass}>
                  {launchReadiness?.notice?.title || "当前首页已具备最小可用配置。"}
                </p>
                <p className={embeddedMutedTextClass}>
                  {launchReadiness?.notice?.description ||
                    `${launchReadiness?.textMessage || "主对话模型已就绪"}；${launchReadiness?.image.label || "图像生成已就绪"}：${launchReadiness?.image.detail || "可继续参考图与分镜图生成"}；${launchReadiness?.video.label || "当前默认走 API"}：${launchReadiness?.video.detail || "可直接继续工作流"}`}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-2.5">
          <h2 className={sectionTitleClass}>
            <Globe className="h-4 w-4" />
            API 设置
          </h2>

          <Card className={cardClass}>
            <CardContent className={cardContentClass}>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className={embeddedTitleTextClass}>内置 API</h3>
                  <Badge className={uniqueModeBadgeClass}>唯一模式</Badge>
                </div>
                <p className={cn("mt-0.5", embeddedMutedTextClass)}>
                  当前版本已移除自定义 API 选项，程序运行时始终使用内置 API 配置。旧的本地自定义配置会自动忽略。
                </p>
              </div>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn("gap-1.5", embeddedOutlineButtonClass)}
                  onClick={() => void handleOpenBuiltinAdminDialog()}
                  disabled={!window.electronAPI?.storage?.writeText}
                >
                  <Key className="h-4 w-4" />
                  修改内置 API
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className={cardClass}>
            <CardContent className={cardContentClass}>
              <div className="space-y-1">
                <h3 className={embeddedTitleTextClass}>Seedance 视频通道</h3>
                <p className={embeddedMutedTextClass}>
                  Dreamina CLI 已从项目配置中移除，当前仅保留 Seedance API 通道。
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        <Dialog open={adminPasswordDialogOpen} onOpenChange={setAdminPasswordDialogOpen}>
          <DialogContent data-settings-floating-root="true">
            <DialogHeader>
              <DialogTitle>输入管理员密码</DialogTitle>
              <DialogDescription>验证通过后，才可以直接在程序内修改内置 API Key。</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">管理员密码</Label>
              <Input
                type="password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void handleVerifyBuiltinAdminPassword();
                  }
                }}
                placeholder="请输入管理员密码"
                className="font-mono text-sm"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAdminPasswordDialogOpen(false)}>
                取消
              </Button>
              <Button type="button" onClick={() => void handleVerifyBuiltinAdminPassword()}>
                验证
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={builtinEditorOpen} onOpenChange={setBuiltinEditorOpen}>
          <DialogContent data-settings-floating-root="true" className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>修改内置 API</DialogTitle>
              <DialogDescription>
                填写后点击保存设置生效。API 地址留空将使用默认值；未填写的 API Key 当前未生效。
              </DialogDescription>
            </DialogHeader>
            <div className="settings-scrollbar space-y-4 max-h-[70vh] overflow-y-auto pr-1">
              {API_ROWS.map((row) => {
                const endpointField = ENDPOINT_FIELD_MAP[row.id];
                const keyField = KEY_FIELD_MAP[row.id];
                return (
                  <div key={row.id} className="rounded-md border border-border/50 p-4 space-y-3">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{row.title}</span>
                        <Badge variant="outline">{row.id}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium">支持的模型：</span>{row.models}
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-sm font-medium">API 地址</Label>
                      <Input
                        value={String(builtinDraft[endpointField] ?? "")}
                        onChange={(e) => setBuiltinField(endpointField, e.target.value)}
                        placeholder={row.endpointPlaceholder}
                        className="font-mono text-sm"
                      />
                      <p className="text-xs text-muted-foreground">{row.endpointHint}</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-sm font-medium">API Key</Label>
                      <Input
                        type="password"
                        autoComplete="new-password"
                        data-testid={`builtin-api-key-${row.id}`}
                        name={`${row.id}-api-key`}
                        value={String(builtinDraft[keyField] ?? "")}
                        onChange={(e) => setBuiltinField(keyField, e.target.value)}
                        placeholder="请输入 API Key"
                        className="font-mono text-sm"
                      />
                      <p className="text-xs text-muted-foreground">{row.keyHint}</p>
                    </div>
                  </div>
                );
              })}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setBuiltinEditorOpen(false)}>
                取消
              </Button>
              <Button type="button" onClick={() => void handleSaveBuiltinApi()} disabled={builtinSaving}>
                {builtinSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                保存设置
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <div className="space-y-2.5">
          <h2 className={sectionTitleClass}>
            {theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            外观设置
          </h2>
          <Card className={cardClass}>
            <CardContent className={embedded ? "pt-5" : "pt-6"}>
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label className={embeddedLabelTextClass}>深色模式</Label>
                  <p className={embeddedMutedTextClass}>切换亮色 / 深色界面主题。</p>
                </div>
                <Switch
                  checked={theme === "dark"}
                  onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
                  className={SETTINGS_BLUE_VIOLET_SWITCH}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="hidden">
          <h2 className={sectionTitleClass}>
            <FolderOpen className="h-4 w-4" />
            存储位置
          </h2>
          <Card className={cardClass}>
            <CardContent className={cardContentClass}>
              <div>
                <Label className={embeddedLabelTextClass}>缓存存储路径</Label>
                <div className={embedded ? "mt-1.5 space-y-2" : "mt-1.5 space-y-2"}>
                  <Input
                    value={
                      defaultStoragePath ||
                      (window.electronAPI?.storage ? "正在获取路径..." : "仅桌面端可显示本地路径")
                    }
                    readOnly
                    className={compactInputClass}
                  />
                  <Button
                    variant="outline"
                    className={cn(
                      embedded
                        ? `${embeddedOutlineButtonClass} w-full justify-center gap-1.5`
                        : "shrink-0 gap-1.5",
                    )}
                    onClick={handleSelectStoragePath}
                    disabled
                  >
                    <FolderCog className="h-4 w-4" />
                    设置路径
                  </Button>
                </div>
                <p className={cn("mt-2 text-xs text-muted-foreground", embedded && "mt-1")}>
                  Fixed to the app root directory. External storage overrides are ignored.
                </p>
                {config.storagePath ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn("mt-2", embeddedGhostTextButtonClass)}
                    onClick={handleResetStoragePath}
                  >
                    恢复默认
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="hidden">
          <h2 className={sectionTitleClass}>首帧图片压缩</h2>
          <Card className={cardClass}>
            <CardContent className={embedded ? "pt-5" : "pt-6"}>
              <div className={gridClass}>
                <div>
                  <Label className={embeddedLabelTextClass}>最大尺寸</Label>
                  <Input
                    type="number"
                    min={256}
                    max={2048}
                    step={64}
                    value={config.firstFrameMaxDim ?? 2048}
                    onChange={(e) => setConfig((prev) => ({ ...prev, firstFrameMaxDim: Number(e.target.value) || 2048 }))}
                    className={cn(compactInputClass, "mt-1")}
                  />
                </div>
                <div>
                  <Label className={embeddedLabelTextClass}>最大文件大小（KB）</Label>
                  <Input
                    type="number"
                    min={100}
                    max={5000}
                    step={100}
                    value={config.firstFrameMaxKB ?? 1024}
                    onChange={(e) => setConfig((prev) => ({ ...prev, firstFrameMaxKB: Number(e.target.value) || 1024 }))}
                    className={cn(compactInputClass, "mt-1")}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="hidden">
          <h2 className={sectionTitleClass}>网络重试</h2>
          <Card className={cardClass}>
            <CardContent className={embedded ? "pt-5" : "pt-6"}>
              <div className={gridClass}>
                <div>
                  <Label className={embeddedLabelTextClass}>最大重试次数</Label>
                  <Input
                    type="number"
                    min={0}
                    max={5}
                    step={1}
                    value={config.retryCount ?? 1}
                    onChange={(e) => setConfig((prev) => ({ ...prev, retryCount: Number(e.target.value) || 0 }))}
                    className={cn(compactInputClass, "mt-1")}
                  />
                </div>
                <div>
                  <Label className={embeddedLabelTextClass}>重试间隔（毫秒）</Label>
                  <Input
                    type="number"
                    min={500}
                    max={30000}
                    step={500}
                    value={config.retryDelayMs ?? 800}
                    onChange={(e) => setConfig((prev) => ({ ...prev, retryDelayMs: Number(e.target.value) || 800 }))}
                    className={cn(compactInputClass, "mt-1")}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className={cn("hidden", "bg-muted/50", embedded && "rounded-[20px] border border-border bg-muted/30 shadow-none")}>
          <CardContent className={embedded ? "pt-5" : "pt-6"}>
            <h3 className={cn("mb-2", embeddedTitleTextClass)}>说明</h3>
            <ul className={cn("space-y-1.5 text-[12.5px] leading-5", embedded ? "text-slate-500" : "text-muted-foreground")}>
              <li>设置页已移除自定义 API 选项，程序始终使用内置 API。</li>
              <li>历史版本遗留的自定义 API 本地配置会在读取和保存时自动清理。</li>
              <li>即梦 / Seedance 默认可复用 Gemini 网关与 Key，实际走 API 还是 CLI 由上方运行通道决定。</li>
            </ul>
          </CardContent>
        </Card>

        <div
          className={cn(
            embedded
              ? "sticky bottom-0 -mx-4 border-t border-border bg-background/96 px-4 pb-4 pt-3 backdrop-blur-md"
              : "",
          )}
        >
          <div className={cn(embedded ? "flex flex-col gap-1.5" : "flex gap-3")}>
          <Button
            onClick={handleSave}
            variant={embedded ? "outline" : "default"}
            className={cn("gap-2", embedded ? "h-10 w-full rounded-full border-border text-foreground hover:bg-muted hover:text-foreground" : "flex-1")}
          >
            <Save className="h-4 w-4" />
            保存设置
          </Button>
          <Button
            variant="ghost"
            className={cn("gap-2", embedded && "h-10 w-full rounded-full border border-destructive/30 text-destructive/70 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/50")}
            onClick={handleClear}
          >
            <Trash2 className="h-4 w-4" />
            清除本地缓存
          </Button>
          </div>
        </div>
      </main>
    </div>
  );
}

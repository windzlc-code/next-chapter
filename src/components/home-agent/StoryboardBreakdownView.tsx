import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, ChevronDown, Download, PencilLine, Plus, X } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const { memo, useCallback, useEffect, useMemo, useRef, useState } = React;

export interface StoryboardShot {
  index: number;
  content: string;
  links: number;
}

export interface StoryboardClip {
  id: string;
  title?: string;
  duration: string;
  tags: string[];
  shots: StoryboardShot[];
  footer_info?: string;
}

export interface StoryboardBreakdown {
  episode: string;
  summary: {
    clips_count: number;
    total_duration: string;
  };
  clips: StoryboardClip[];
}

export interface StoryboardBreakdownRoot {
  summary: {
    total_episodes: number;
    total_clips: number;
    total_duration: string;
  };
  episodes: StoryboardBreakdown[];
}

interface ParsedShotContent {
  hiddenLead: string;
  body: string;
  dialogue: string;
  role: string;
  hiddenCamera: string;
  extras: string[];
}

type TagKind = "scene" | "character";

interface TagEntry {
  index: number;
  label: string;
}

const SHOT_LEAD_RE =
  /^(全景|中景|近景|远景|特写|大全景|中近景|近特写|双人近景|双人中景|双人特写|空镜|俯拍|仰拍|跟拍|推进|拉远|拉近|侧拍|背拍|背影|正面|全身|半身|局部)[：:]\s*/;
const DIALOGUE_PREFIX_RE = /^(对白|台词|Dialogue)\s*[：:]\s*/i;
const ROLE_PREFIX_RE = /^(角色|人物|Role|Character)\s*[：:]\s*/i;
const CAMERA_PREFIX_RE = /^(镜头|机位|Camera)\s*[：:]\s*/i;
const INVALID_TAGS = new Set(["添加标签", "添加场景", "添加人物"]);

export function isStoryboardBreakdown(data: unknown): data is StoryboardBreakdown {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.episode === "string" &&
    d.summary !== null &&
    typeof d.summary === "object" &&
    Array.isArray(d.clips)
  );
}

export function isStoryboardBreakdownRoot(data: unknown): data is StoryboardBreakdownRoot {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return d.summary !== null && typeof d.summary === "object" && Array.isArray(d.episodes);
}

function decodeUnicodeEscapes(value: string): string {
  return String(value || "").replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanTagLabel(raw: string): string {
  return decodeUnicodeEscapes(String(raw || ""))
    .replace(/^[【\[]|[】\]]$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isValidTagLabel(value: string): boolean {
  return Boolean(value) && !INVALID_TAGS.has(value);
}

function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const tag of tags) {
    const label = cleanTagLabel(tag);
    if (!isValidTagLabel(label) || seen.has(label)) continue;
    seen.add(label);
    result.push(label);
  }

  return result;
}

function highlightTagMentions(content: string, tags: string[]): React.ReactNode {
  if (!content) return null;

  const normalizedTags = uniqueTags(tags);
  const bareTagPattern = normalizedTags
    .sort((left, right) => right.length - left.length)
    .map((tag) => escapeRegExp(tag))
    .join("|");

  const matcher = new RegExp(
    bareTagPattern ? `(\\[[^\\]]+\\]|【[^】]+】|${bareTagPattern})` : `(\\[[^\\]]+\\]|【[^】]+】)`,
    "g",
  );

  return content.split(matcher).map((part, index) => {
    if (!part) return null;

    const normalized = cleanTagLabel(part);
    const highlighted =
      (part.startsWith("[") && part.endsWith("]")) ||
      (part.startsWith("【") && part.endsWith("】")) ||
      normalizedTags.includes(normalized);

    return highlighted ? (
      <span key={index} className="font-medium text-primary/85">
        {part}
      </span>
    ) : (
      <span key={index}>{part}</span>
    );
  });
}

function parseShotContent(content: string): ParsedShotContent {
  const segments = String(content || "")
    .split(/\s*\|\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const description = segments.shift() || "";
  const leadMatch = description.match(SHOT_LEAD_RE);
  const hiddenLead = leadMatch?.[1] || "";
  const body = leadMatch ? description.replace(SHOT_LEAD_RE, "").trim() : description;

  let dialogue = "";
  let role = "";
  let hiddenCamera = "";
  const extras: string[] = [];

  segments.forEach((segment) => {
    if (DIALOGUE_PREFIX_RE.test(segment)) {
      dialogue = segment.replace(DIALOGUE_PREFIX_RE, "").trim();
      return;
    }
    if (ROLE_PREFIX_RE.test(segment)) {
      role = segment.replace(ROLE_PREFIX_RE, "").trim();
      return;
    }
    if (CAMERA_PREFIX_RE.test(segment)) {
      hiddenCamera = segment.replace(CAMERA_PREFIX_RE, "").trim();
      return;
    }
    extras.push(segment);
  });

  return {
    hiddenLead,
    body,
    dialogue,
    role,
    hiddenCamera,
    extras,
  };
}

function serializeShotContent(parsed: ParsedShotContent): string {
  const segments: string[] = [];
  const main = parsed.body.trim();

  if (parsed.hiddenLead) {
    segments.push(main ? `${parsed.hiddenLead}：${main}` : `${parsed.hiddenLead}：`);
  } else if (main) {
    segments.push(main);
  }

  parsed.extras
    .map((segment) => segment.trim())
    .filter(Boolean)
    .forEach((segment) => segments.push(segment));

  if (parsed.dialogue.trim()) {
    segments.push(`对白：${parsed.dialogue.trim()}`);
  }
  if (parsed.role.trim()) {
    segments.push(`角色：${parsed.role.trim()}`);
  }
  if (parsed.hiddenCamera.trim()) {
    segments.push(`镜头：${parsed.hiddenCamera.trim()}`);
  }

  return segments.join(" | ");
}

function buildVisibleShotText(parsed: ParsedShotContent): string {
  const segments: string[] = [];
  const main = parsed.body.trim();

  if (parsed.hiddenLead) {
    segments.push(main ? `${parsed.hiddenLead}：${main}` : `${parsed.hiddenLead}：`);
  } else if (main) {
    segments.push(main);
  }

  parsed.extras
    .map((segment) => segment.trim())
    .filter(Boolean)
    .forEach((segment) => segments.push(segment));

  return segments.join(" | ");
}

function parseVisibleShotText(value: string, base: ParsedShotContent): ParsedShotContent {
  const segments = String(value || "")
    .split(/\s*\|\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const description = segments.shift() || "";
  const leadMatch = description.match(SHOT_LEAD_RE);
  const hiddenLead = leadMatch?.[1] || "";
  const body = leadMatch ? description.replace(SHOT_LEAD_RE, "").trim() : description;
  const extras: string[] = [];

  segments.forEach((segment) => {
    extras.push(segment);
  });

  return {
    ...base,
    hiddenLead,
    body,
    extras,
  };
}

function resolveTextareaRows(value: string, minimum = 1): number {
  const normalized = String(value || "");
  const lines = normalized.split("\n").length;
  const estimated = Math.ceil(Math.max(normalized.length, 1) / 76);
  return Math.max(minimum, lines, estimated);
}

function AutoGrowTextarea({
  value,
  className,
  minimumRows = 1,
  onChange,
}: {
  value: string;
  className: string;
  minimumRows?: number;
  onChange: React.ChangeEventHandler<HTMLTextAreaElement>;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;

    element.style.height = "0px";
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={textareaRef}
      className={className}
      value={value}
      rows={resolveTextareaRows(value, minimumRows)}
      onChange={onChange}
    />
  );
}

function normalizeClipTitle(title?: string, fallbackId?: string): string {
  const raw = String(title || fallbackId || "").trim();
  if (!raw) return "";
  return raw.replace(/^片段\s+(\d+(?:-\d+)+)$/u, "片段$1");
}

function extractRoleTags(roleContent: string): string[] {
  const matches = decodeUnicodeEscapes(String(roleContent || "")).match(
    /\[[^\]]+\]|【[^】]+】|[^\s,，、]+/g,
  );

  return uniqueTags(matches || []).filter(
    (tag) => !/^(旁白|画外音|内心独白|心声|独白|VO|V\.O\.|OS|O\.S\.)$/i.test(cleanTagLabel(tag)),
  );
}

function splitTagsByType(
  tags: string[],
  shots: StoryboardShot[],
  manualKinds: Map<string, TagKind>,
): { sceneTags: TagEntry[]; characterTags: TagEntry[] } {
  const characterSet = new Set<string>();

  shots.forEach((shot) => {
    extractRoleTags(parseShotContent(shot.content).role).forEach((tag) => characterSet.add(tag));
  });

  return tags.reduce(
    (result, rawTag, index) => {
      const label = cleanTagLabel(rawTag);
      if (!isValidTagLabel(label)) return result;

      const manualKind = manualKinds.get(label);
      const kind: TagKind = manualKind ?? (characterSet.has(label) ? "character" : "scene");

      if (kind === "character") {
        result.characterTags.push({ index, label });
      } else {
        result.sceneTags.push({ index, label });
      }

      return result;
    },
    { sceneTags: [] as TagEntry[], characterTags: [] as TagEntry[] },
  );
}

function TagGrid({
  tags,
  shots,
  editing,
  onRemove,
  onAdd,
}: {
  tags: string[];
  shots: StoryboardShot[];
  editing: boolean;
  onRemove: (index: number) => void;
  onAdd: (value: string, kind: TagKind) => void;
}) {
  const [sceneInput, setSceneInput] = useState("");
  const [characterInput, setCharacterInput] = useState("");
  const [manualKinds, setManualKinds] = useState<Map<string, TagKind>>(new Map());

  useEffect(() => {
    const activeLabels = new Set(uniqueTags(tags));
    setManualKinds((prev) => {
      const next = new Map<string, TagKind>();
      prev.forEach((kind, label) => {
        if (activeLabels.has(label)) {
          next.set(label, kind);
        }
      });
      return next;
    });
  }, [tags]);

  const { sceneTags, characterTags } = useMemo(
    () => splitTagsByType(tags, shots, manualKinds),
    [manualKinds, shots, tags],
  );

  const submitTag = useCallback(
    (kind: TagKind) => {
      const rawValue = kind === "scene" ? sceneInput : characterInput;
      const value = cleanTagLabel(rawValue);
      if (!isValidTagLabel(value)) return;
      if (uniqueTags(tags).includes(value)) {
        if (kind === "scene") {
          setSceneInput("");
        } else {
          setCharacterInput("");
        }
        return;
      }

      setManualKinds((prev) => {
        const next = new Map(prev);
        next.set(value, kind);
        return next;
      });
      onAdd(value, kind);

      if (kind === "scene") {
        setSceneInput("");
      } else {
        setCharacterInput("");
      }
    },
    [characterInput, onAdd, sceneInput, tags],
  );

  const removeTag = useCallback(
    (index: number, label: string) => {
      setManualKinds((prev) => {
        const next = new Map(prev);
        next.delete(label);
        return next;
      });
      onRemove(index);
    },
    [onRemove],
  );

  const renderTagRow = useCallback(
    (
      label: string,
      entries: TagEntry[],
      kind: TagKind,
      inputValue: string,
      setInputValue: React.Dispatch<React.SetStateAction<string>>,
      placeholder: string,
    ) => (
      <div className="flex items-start gap-2">
        <span className="w-8 shrink-0 pt-0.5 text-[12px] leading-5 text-muted-foreground/45">
          {label}
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-0.5">
          {entries.map((entry) => (
            <div
              key={`${entry.label}-${entry.index}`}
              className="inline-flex min-w-0 items-center gap-1 whitespace-nowrap text-[12.5px] leading-5 text-primary/85"
            >
              <span>{`[${entry.label}]`}</span>
              {editing ? (
                <button
                  type="button"
                  onClick={() => removeTag(entry.index, entry.label)}
                  className="shrink-0 text-primary/45 transition-colors hover:text-primary/80"
                  aria-label={`删除标签 ${entry.label}`}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              ) : null}
            </div>
          ))}
          {editing ? (
            <div className="inline-flex min-w-[132px] items-center gap-1.5 text-[12px] leading-5 text-primary/70">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitTag(kind);
                  }
                }}
                placeholder={placeholder}
                className="min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-[12.5px] text-foreground/78 placeholder:text-muted-foreground/35 focus:outline-none focus:ring-0"
              />
              <button
                type="button"
                onClick={() => submitTag(kind)}
                className="shrink-0 text-primary/70 transition-colors hover:text-primary"
                aria-label={placeholder}
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>
          ) : null}
        </div>
      </div>
    ),
    [editing, removeTag, submitTag],
  );

  return (
    <div className="pb-2 pt-0.5">
      <div className="mb-1 text-[12px] text-muted-foreground/55">场景/人物标签:</div>
      <div className="space-y-1">
        {renderTagRow("场景", sceneTags, "scene", sceneInput, setSceneInput, "添加场景标签")}
        {renderTagRow(
          "人物",
          characterTags,
          "character",
          characterInput,
          setCharacterInput,
          "添加人物标签",
        )}
      </div>
    </div>
  );
}

function ShotRow({
  shot,
  tags,
  editing,
  onChange,
}: {
  shot: StoryboardShot;
  tags: string[];
  editing: boolean;
  onChange: (updated: StoryboardShot) => void;
}) {
  const parsed = useMemo(() => parseShotContent(shot.content), [shot.content]);
  const visibleMainText = useMemo(() => buildVisibleShotText(parsed), [parsed]);

  const updateParsed = useCallback(
    (patch: Partial<ParsedShotContent>) => {
      onChange({
        ...shot,
        content: serializeShotContent({ ...parsed, ...patch }),
      });
    },
    [onChange, parsed, shot],
  );

  return (
    <div className="border-b border-border/10 py-2.5 last:border-b-0">
      <div className="flex items-start gap-2">
        <span className="w-[42px] shrink-0 pt-px text-[12.5px] leading-[1.8] text-muted-foreground/60">
          {`分镜 ${shot.index}:`}
        </span>
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-1.5">
              <AutoGrowTextarea
                className="w-full resize-none overflow-hidden border-0 bg-transparent px-0 py-0 text-[12.5px] leading-[1.7] text-foreground/84 focus:outline-none focus:ring-0"
                value={visibleMainText}
                minimumRows={1}
                onChange={(e) => updateParsed(parseVisibleShotText(e.target.value, parsed))}
              />
              {parsed.dialogue.trim() ? (
                <AutoGrowTextarea
                  className="w-full resize-none overflow-hidden border-0 bg-transparent px-0 py-0 text-[12.5px] leading-[1.7] text-foreground/84 focus:outline-none focus:ring-0"
                  value={parsed.dialogue}
                  minimumRows={1}
                  onChange={(e) => updateParsed({ dialogue: e.target.value })}
                />
              ) : null}
            </div>
          ) : (
            <div className="space-y-1.5">
              {visibleMainText ? (
                <p className="whitespace-pre-wrap text-[12.5px] leading-[1.7] text-foreground/84">
                  {highlightTagMentions(visibleMainText, tags)}
                </p>
              ) : null}
              {parsed.dialogue.trim() ? (
                <p className="whitespace-pre-wrap text-[12.5px] leading-[1.7] text-foreground/84">
                  {highlightTagMentions(parsed.dialogue, tags)}
                </p>
              ) : null}
            </div>
          )}
        </div>
        {shot.links > 0 ? (
          <span className="shrink-0 whitespace-nowrap pt-px text-[11.5px] tabular-nums text-muted-foreground/40">
            +{shot.links}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ClipCard({
  clip,
  editing,
  onClipChange,
}: {
  clip: StoryboardClip;
  editing: boolean;
  onClipChange: (updated: StoryboardClip) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const handleShotChange = useCallback(
    (idx: number, updated: StoryboardShot) => {
      onClipChange({
        ...clip,
        shots: clip.shots.map((item, itemIdx) => (itemIdx === idx ? updated : item)),
      });
    },
    [clip, onClipChange],
  );

  const handleFooterChange = useCallback(
    (footerInfo: string) => {
      onClipChange({ ...clip, footer_info: footerInfo });
    },
    [clip, onClipChange],
  );

  const handleTagRemove = useCallback(
    (tagIdx: number) => {
      onClipChange({
        ...clip,
        tags: clip.tags.filter((_, index) => index !== tagIdx),
      });
    },
    [clip, onClipChange],
  );

  const handleTagAdd = useCallback(
    (value: string) => {
      onClipChange({
        ...clip,
        tags: [...clip.tags, value],
      });
    },
    [clip, onClipChange],
  );

  const displayTitle = normalizeClipTitle(clip.title, clip.id);

  return (
    <div className="mb-4 last:mb-0">
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className="flex w-full items-start gap-2 py-1 text-left"
        aria-expanded={!collapsed}
      >
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-150",
            collapsed ? "-rotate-90" : "rotate-0",
          )}
        />
        <span className="min-w-0 flex-1 break-all text-[13.5px] font-semibold leading-5 text-foreground/92">
          {displayTitle}
          <span className="ml-2 text-[12px] font-normal text-muted-foreground/55">
            {`(时长: ${clip.duration})`}
          </span>
        </span>
        <span className="shrink-0 pt-0.5 text-[12px] text-muted-foreground/55">
          {`${clip.shots.length} 个分镜`}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {!collapsed ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="pb-2 pl-1 pr-0 pt-1 md:pl-2">
              <TagGrid
                tags={clip.tags}
                shots={clip.shots}
                editing={editing}
                onRemove={handleTagRemove}
                onAdd={handleTagAdd}
              />

              <p className="mb-1 text-[12px] text-muted-foreground/55">分镜脚本:</p>
              <div>
                {clip.shots.map((shot, index) => (
                  <ShotRow
                    key={`${clip.id}-shot-${shot.index}`}
                    shot={shot}
                    tags={clip.tags}
                    editing={editing}
                    onChange={(updated) => handleShotChange(index, updated)}
                  />
                ))}
              </div>

              <div className="pt-3">
                <p className="mb-1 text-[11.5px] text-muted-foreground/45">通用后缀:</p>
                {editing ? (
                  <AutoGrowTextarea
                    className="w-full resize-none overflow-hidden border-0 bg-transparent px-0 py-0 text-[11.5px] leading-[1.75] text-muted-foreground/75 focus:outline-none focus:ring-0"
                    value={clip.footer_info || ""}
                    minimumRows={1}
                    onChange={(e) => handleFooterChange(e.target.value)}
                  />
                ) : clip.footer_info ? (
                  <p className="whitespace-pre-wrap text-[11.5px] leading-[1.75] text-muted-foreground/75">
                    {clip.footer_info}
                  </p>
                ) : null}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export const StoryboardBreakdownView = memo(function StoryboardBreakdownView({
  data: initialData,
  editing: externalEditing,
  onDataChange,
}: {
  data: StoryboardBreakdown;
  editing?: boolean;
  onDataChange?: (updated: StoryboardBreakdown) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [localEditing, setLocalEditing] = useState(false);
  const [data, setData] = useState<StoryboardBreakdown>(initialData);

  useEffect(() => {
    setData(initialData);
  }, [initialData]);

  const editing = externalEditing ?? localEditing;
  const clipCount = data.clips.length;
  const totalShots = data.clips.reduce((sum, clip) => sum + clip.shots.length, 0);

  const handleClipChange = useCallback(
    (clipIdx: number, updated: StoryboardClip) => {
      setData((prev) => {
        const next = {
          ...prev,
          clips: prev.clips.map((clip, index) => (index === clipIdx ? updated : clip)),
        };
        onDataChange?.(next);
        return next;
      });
    },
    [onDataChange],
  );

  return (
    <div className="my-2">
      <div className="flex items-center gap-2 py-1.5">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="group flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={!collapsed}
        >
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-hover:text-muted-foreground",
              collapsed ? "-rotate-90" : "rotate-0",
            )}
          />
          <span className="text-[15px] font-bold text-foreground">{data.episode}</span>
          <span className="ml-1 text-[12.5px] text-muted-foreground/60">
            {`${clipCount} 个片段 · ${totalShots} 个分镜`}
          </span>
        </button>

        {externalEditing === undefined ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <PencilLine
              className={cn(
                "h-3.5 w-3.5 transition-colors",
                localEditing ? "text-primary/70" : "text-muted-foreground/40",
              )}
            />
            <Switch
              checked={localEditing}
              onCheckedChange={setLocalEditing}
              className="h-4 w-7 [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3"
              aria-label="切换编辑模式"
            />
          </div>
        ) : null}
      </div>

      <AnimatePresence initial={false}>
        {!collapsed ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-2 pt-1">
              {data.clips.map((clip, index) => (
                <ClipCard
                  key={clip.id}
                  clip={clip}
                  editing={editing}
                  onClipChange={(updated) => handleClipChange(index, updated)}
                />
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
});

export const StoryboardBreakdownRootView = memo(function StoryboardBreakdownRootView({
  data: initialData,
  onExport,
  onNext,
  allowEditing = true,
  editing: externalEditing,
}: {
  data: StoryboardBreakdownRoot;
  onExport?: () => void;
  onNext?: () => void;
  allowEditing?: boolean;
  editing?: boolean;
}) {
  const [localEditing, setLocalEditing] = useState(false);
  const [data, setData] = useState<StoryboardBreakdownRoot>(initialData);
  const editing = externalEditing ?? localEditing;

  useEffect(() => {
    setData(initialData);
  }, [initialData]);

  const totalClips = data.episodes.reduce((sum, episode) => sum + episode.clips.length, 0);
  const totalShots = data.episodes.reduce(
    (sum, episode) =>
      sum + episode.clips.reduce((clipSum, clip) => clipSum + clip.shots.length, 0),
    0,
  );

  const handleEpisodeChange = useCallback((epIdx: number, updated: StoryboardBreakdown) => {
    setData((prev) => ({
      ...prev,
      episodes: prev.episodes.map((episode, index) => (index === epIdx ? updated : episode)),
    }));
  }, []);

  return (
    <div className="my-2">
      <div className="flex items-center gap-3 py-1.5">
        <p className="min-w-0 flex-1 text-[13px] text-muted-foreground/80">
          {`共 ${totalClips} 个片段，${totalShots} 个分镜，${allowEditing ? "可编辑调整。" : "可直接查看。"}`}
        </p>

        <div className="flex shrink-0 items-center gap-2">
          {allowEditing && externalEditing === undefined ? (
            <div className="flex items-center gap-1.5">
              <PencilLine
                className={cn(
                  "h-3.5 w-3.5 transition-colors",
                  editing ? "text-primary/70" : "text-muted-foreground/40",
                )}
              />
              <Switch
                checked={editing}
                onCheckedChange={setLocalEditing}
                className="h-4 w-7 [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3"
                aria-label="切换编辑模式"
              />
            </div>
          ) : null}

          {onExport ? (
            <button
              type="button"
              onClick={onExport}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] text-muted-foreground/70 transition-colors hover:bg-muted/20 hover:text-foreground/80"
            >
              <Download className="h-3.5 w-3.5" />
              导出
            </button>
          ) : null}

          {onNext ? (
            <button
              type="button"
              onClick={onNext}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              下一步
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="space-y-2 pt-1">
        {data.episodes.map((episode, index) => (
          <StoryboardBreakdownView
            key={episode.episode}
            data={episode}
            editing={allowEditing ? editing : false}
            onDataChange={(updated) => handleEpisodeChange(index, updated)}
          />
        ))}
      </div>
    </div>
  );
});

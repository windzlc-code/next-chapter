import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Check, ChevronDown, ChevronLeft, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  ComposerQuestion,
  ComposerQuestionOption,
} from "@/lib/home-agent/types";
import type { VideoGenerationMode, VideoImageGenerationPrefs } from "@/types/project";
import { GENRES } from "@/types/drama";

export interface ComposerChoicePanelProps {
  question: ComposerQuestion;
  onSelect: (value: string, label: string) => void;
  onConfirm?: () => void;
  onBack?: () => void;
  onDismiss?: () => void;
  canConfirm?: boolean;
  tone?: "light" | "dark";
  devMode?: boolean;
  devVideoGenerationMode?: VideoGenerationMode;
  devImageViewMode?: VideoImageGenerationPrefs["viewMode"];
  onDevVideoGenerationModeChange?: (mode: VideoGenerationMode) => void;
  onDevImageViewModeChange?: (
    mode: NonNullable<VideoImageGenerationPrefs["viewMode"]>,
  ) => void;
}

/** 全局固定的开发者回退按钮，始终显示在 dev 区（不依赖当前步骤选项） */
export const DEV_GLOBAL_ACTIONS = [
  {
    id: "dev-global-outlines",
    label: "回退到《单集细纲》",
    value: "script:step-enter-outlines",
  },
  {
    id: "dev-global-episodes",
    label: "回退到《分集撰写》",
    value: "script:step-enter-episodes",
  },
];

const NESTED_DESKTOP_GAP_PX = 6;
const NESTED_DESKTOP_EDGE_PADDING_PX = 16;
const SECONDARY_PANEL_DESKTOP_WIDTH_PX = 220;
const SECONDARY_PANEL_MIN_WIDTH_PX = 172;
const TERTIARY_LIST_PANEL_DESKTOP_WIDTH_PX = 204;
const TERTIARY_LIST_PANEL_MIN_WIDTH_PX = 164;
const TERTIARY_INPUT_PANEL_DESKTOP_WIDTH_PX = 272;
const TERTIARY_INPUT_PANEL_MIN_WIDTH_PX = 224;
const QUATERNARY_PANEL_DESKTOP_WIDTH_PX = 188;
const QUATERNARY_PANEL_MIN_WIDTH_PX = 156;
const NESTED_PANEL_FRAME_CLASS = "overflow-hidden rounded-[14px] border";
const NESTED_PANEL_HEADER_CLASS = "px-3 pb-1.5 pt-2 text-[11px] font-medium";
const NESTED_PANEL_LIST_CLASS = "flex flex-col gap-1 px-2 pb-2";
const NESTED_PANEL_SCROLL_LIST_CLASS = `${NESTED_PANEL_LIST_CLASS} max-h-[340px] overflow-y-auto scrollbar-none`;
const NESTED_PANEL_OPTION_CLASS =
  "w-full min-h-[50px] rounded-[12px] border px-3 py-2.5 text-left transition-colors";
const NESTED_PANEL_HEADER_ESTIMATED_HEIGHT_PX = 30;
const NESTED_PANEL_ITEM_ESTIMATED_HEIGHT_PX = 58;
const NESTED_PANEL_BOTTOM_PADDING_ESTIMATED_PX = 16;
const NESTED_PANEL_SCROLL_MAX_HEIGHT_PX = 340;

function localizeDevVideoGenerationMode(mode: VideoGenerationMode): string {
  return mode === "image-to-video" ? "图生视频" : "文生视频";
}

function localizeDevImageViewMode(
  mode: NonNullable<VideoImageGenerationPrefs["viewMode"]>,
): string {
  return mode === "single" ? "单图" : "三视图";
}

function DevOptionToggleGroup<T extends string>({
  value,
  options,
  onChange,
  testId,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange?: (value: T) => void;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className="inline-flex shrink-0 rounded-full border border-white/[0.08] bg-black/20 p-0.5"
    >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange?.(option.value)}
              className={`rounded-full px-2.5 py-1 text-[10px] transition-colors ${
                selected
                  ? "bg-[#0f62fe] text-white shadow-[0_4px_12px_rgba(15,98,254,0.22)]"
                  : "text-white/54 hover:text-white/78"
              }`}
            >
              {option.label}
            </button>
          );
        })}
    </div>
  );
}

export function DevOptionsPanel({
  devOptions,
  onSelect,
  devVideoGenerationMode,
  devImageViewMode,
  onDevVideoGenerationModeChange,
  onDevImageViewModeChange,
}: {
  devOptions: ComposerQuestionOption[];
  onSelect: (value: string, label: string) => void;
  devVideoGenerationMode?: VideoGenerationMode;
  devImageViewMode?: VideoImageGenerationPrefs["viewMode"];
  onDevVideoGenerationModeChange?: (mode: VideoGenerationMode) => void;
  onDevImageViewModeChange?: (
    mode: NonNullable<VideoImageGenerationPrefs["viewMode"]>,
  ) => void;
}) {
  const resolvedVideoMode = devVideoGenerationMode ?? "text-to-video";
  const resolvedImageViewMode = devImageViewMode ?? "three";
  const hasToggles = Boolean(
    onDevVideoGenerationModeChange || onDevImageViewModeChange,
  );

  if (!hasToggles && devOptions.length === 0 && DEV_GLOBAL_ACTIONS.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 border-t border-dashed border-amber-400/20 pt-2">
      <div className="mb-1 text-[9.5px] font-medium uppercase tracking-[0.16em] text-amber-400/55">
        开发者选项
      </div>
      {hasToggles ? (
        <div className="sr-only">
          <span>{`当前 ${localizeDevVideoGenerationMode(resolvedVideoMode)}，默认文生视频`}</span>
          <span>{`当前 ${localizeDevImageViewMode(resolvedImageViewMode)}，默认三视图`}</span>
        </div>
      ) : null}
      {devOptions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          {devOptions.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => onSelect(opt.value, opt.label)}
              className="rounded-full border border-amber-400/20 bg-amber-400/[0.06] px-2.5 py-1 text-[10.5px] text-amber-300/70 transition hover:bg-amber-400/[0.12] hover:text-amber-300"
            >
              ↩ {opt.label}
            </button>
          ))}
        </div>
      ) : null}
      {DEV_GLOBAL_ACTIONS.length > 0 || hasToggles ? (
        <div className="flex flex-wrap items-center gap-1">
          {DEV_GLOBAL_ACTIONS.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {DEV_GLOBAL_ACTIONS.map((act) => (
                <button
                  key={act.id}
                  type="button"
                  onClick={() => onSelect(act.value, act.label)}
                  className="rounded-full border border-sky-400/20 bg-sky-400/[0.06] px-2.5 py-1 text-[10.5px] text-sky-300/60 transition hover:bg-sky-400/[0.12] hover:text-sky-300"
                >
                  ↩ {act.label}
                </button>
              ))}
            </div>
          ) : null}
          {hasToggles ? (
            <div className="ml-auto flex items-center gap-1">
              <DevOptionToggleGroup
                value={resolvedVideoMode}
                options={[
                  { value: "text-to-video", label: "文生视频" },
                  { value: "image-to-video", label: "图生视频" },
                ]}
                onChange={onDevVideoGenerationModeChange}
                testId="dev-video-generation-mode-toggle"
              />
              <DevOptionToggleGroup
                value={resolvedImageViewMode}
                options={[
                  { value: "three", label: "三视图" },
                  { value: "single", label: "单图" },
                ]}
                onChange={onDevImageViewModeChange}
                testId="dev-image-view-mode-toggle"
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function shouldTopAlignNestedChildPanel(option: ComposerQuestionOption | null): boolean {
  return option?.value === "video:panel:review-stage-panel-export";
}

function estimateNestedListPanelHeight(optionCount: number): number {
  const estimatedListHeight = Math.min(
    NESTED_PANEL_SCROLL_MAX_HEIGHT_PX,
    Math.max(1, optionCount) * NESTED_PANEL_ITEM_ESTIMATED_HEIGHT_PX,
  );
  return (
    NESTED_PANEL_HEADER_ESTIMATED_HEIGHT_PX +
    estimatedListHeight +
    NESTED_PANEL_BOTTOM_PADDING_ESTIMATED_PX
  );
}

function toDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function ensureUniqueNestedOptionIds(
  options: ComposerQuestionOption[],
): ComposerQuestionOption[] {
  const seenIds = new Map<string, number>();

  return options.map((option, index) => {
    const baseId = option.id?.trim() || `option-${index + 1}`;
    const duplicateCount = seenIds.get(baseId) ?? 0;
    seenIds.set(baseId, duplicateCount + 1);

    const nextId =
      duplicateCount === 0 ? baseId : `${baseId}--dup-${duplicateCount + 1}`;
    const nextChildren = option.children?.length
      ? ensureUniqueNestedOptionIds(option.children)
      : option.children;

    if (nextId === option.id && nextChildren === option.children) {
      return option;
    }

    return {
      ...option,
      id: nextId,
      ...(nextChildren
        ? { children: nextChildren }
        : option.children
          ? { children: nextChildren }
          : {}),
    };
  });
}

function resolveNestedDesktopPanelWidths(params: {
  availableWidth: number;
  hasTertiary: boolean;
  hasQuaternary: boolean;
  tertiaryIsInput: boolean;
}) {
  const panels = [
    {
      key: "secondary",
      desired: SECONDARY_PANEL_DESKTOP_WIDTH_PX,
      min: SECONDARY_PANEL_MIN_WIDTH_PX,
    },
    ...(params.hasTertiary
      ? [
          {
            key: "tertiary",
            desired: params.tertiaryIsInput
              ? TERTIARY_INPUT_PANEL_DESKTOP_WIDTH_PX
              : TERTIARY_LIST_PANEL_DESKTOP_WIDTH_PX,
            min: params.tertiaryIsInput
              ? TERTIARY_INPUT_PANEL_MIN_WIDTH_PX
              : TERTIARY_LIST_PANEL_MIN_WIDTH_PX,
          },
        ]
      : []),
    ...(params.hasQuaternary
      ? [
          {
            key: "quaternary",
            desired: QUATERNARY_PANEL_DESKTOP_WIDTH_PX,
            min: QUATERNARY_PANEL_MIN_WIDTH_PX,
          },
        ]
      : []),
  ];

  const gapBudget = Math.max(0, panels.length - 1) * NESTED_DESKTOP_GAP_PX;
  const usableWidth = Math.max(0, params.availableWidth - gapBudget);
  const minimumWidth = panels.reduce((sum, panel) => sum + panel.min, 0);
  const desiredWidth = panels.reduce((sum, panel) => sum + panel.desired, 0);

  if (!panels.length) {
    return {
      secondary: undefined,
      tertiary: undefined,
      quaternary: undefined,
    } as const;
  }

  if (usableWidth <= minimumWidth) {
    return {
      secondary: panels.find((panel) => panel.key === "secondary")?.min,
      tertiary: panels.find((panel) => panel.key === "tertiary")?.min,
      quaternary: panels.find((panel) => panel.key === "quaternary")?.min,
    } as const;
  }

  if (usableWidth >= desiredWidth) {
    return {
      secondary: panels.find((panel) => panel.key === "secondary")?.desired,
      tertiary: panels.find((panel) => panel.key === "tertiary")?.desired,
      quaternary: panels.find((panel) => panel.key === "quaternary")?.desired,
    } as const;
  }

  const deficit = desiredWidth - usableWidth;
  const shrinkCapacity = panels.reduce(
    (sum, panel) => sum + (panel.desired - panel.min),
    0,
  );

  if (shrinkCapacity <= 0) {
    return {
      secondary: panels.find((panel) => panel.key === "secondary")?.desired,
      tertiary: panels.find((panel) => panel.key === "tertiary")?.desired,
      quaternary: panels.find((panel) => panel.key === "quaternary")?.desired,
    } as const;
  }

  const resolved = panels.map((panel) => {
    const capacity = panel.desired - panel.min;
    const width = panel.desired - (deficit * capacity) / shrinkCapacity;
    return {
      key: panel.key,
      width: Math.max(panel.min, Math.min(panel.desired, Math.round(width))),
    };
  });

  return {
    secondary: resolved.find((panel) => panel.key === "secondary")?.width,
    tertiary: resolved.find((panel) => panel.key === "tertiary")?.width,
    quaternary: resolved.find((panel) => panel.key === "quaternary")?.width,
  } as const;
}

/** Two-level genre picker: left column = categories, right panel = genres in selected category */
function GenreCategoryPicker({
  question,
  onSelect,
  dark,
  registerEscapeHandler,
}: {
  question: ComposerQuestion;
  onSelect: (value: string, label: string) => void;
  dark: boolean;
  registerEscapeHandler?: (handler: (() => boolean) | null) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const panelListRef = useRef<HTMLDivElement | null>(null);
  const categoryButtonRefs = useRef<Record<string, HTMLButtonElement | null>>(
    {},
  );
  const [rootTop, setRootTop] = useState(0);
  const [listHeight, setListHeight] = useState(0);
  const [parentHeight, setParentHeight] = useState(0);
  const [panelContentHeight, setPanelContentHeight] = useState(0);
  const selectedValues = useMemo(
    () =>
      new Set(question.options.filter((o) => o.selected).map((o) => o.value)),
    [question.options],
  );

  const allowedValues = useMemo(
    () => new Set(question.options.map((o) => o.value)),
    [question.options],
  );

  const groupedGenres = useMemo(() => {
    const groups = new Map<string, Array<(typeof GENRES)[number]>>();
    for (const genre of GENRES) {
      if (!allowedValues.has(genre.value)) continue;
      const list = groups.get(genre.category) ?? [];
      list.push(genre);
      groups.set(genre.category, list);
    }
    return Array.from(groups.entries());
  }, [allowedValues]);

  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const genrePanelId = `genre-secondary-panel-${toDomId(question.id)}`;

  const activeGenres = useMemo(
    () => groupedGenres.find(([cat]) => cat === activeCategory)?.[1] ?? [],
    [groupedGenres, activeCategory],
  );
  const restoreCategoryFocus = (category: string | null) => {
    if (!category) return;
    window.setTimeout(() => categoryButtonRefs.current[category]?.focus(), 0);
  };

  useEffect(() => {
    setActiveCategory(null);
  }, [question.id]);

  useEffect(() => {
    const rootNode = rootRef.current;
    const listNode = listRef.current;
    if (!rootNode || !listNode) return;

    const measure = () => {
      setRootTop(rootNode.offsetTop);
      setListHeight(listNode.offsetHeight);
      setParentHeight(rootNode.parentElement?.offsetHeight ?? 0);
      setPanelContentHeight(panelListRef.current?.scrollHeight ?? 0);
    };
    measure();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(rootNode);
      observer.observe(listNode);
      if (panelListRef.current) observer.observe(panelListRef.current);
      if (rootNode.parentElement) observer.observe(rootNode.parentElement);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [activeGenres.length]);

  useEffect(() => {
    if (!registerEscapeHandler) return;
    registerEscapeHandler(() => {
      if (!activeCategory) return false;
      const previousCategory = activeCategory;
      setActiveCategory(null);
      restoreCategoryFocus(previousCategory);
      return true;
    });
    return () => registerEscapeHandler(null);
  }, [registerEscapeHandler, activeCategory]);

  const genrePanelMaxHeight =
    parentHeight > 0 ? parentHeight : rootTop + listHeight || 260;
  const genrePanelChromeHeight = 4;
  const genrePanelListMaxHeight = Math.max(
    180,
    genrePanelMaxHeight - genrePanelChromeHeight,
  );
  const genrePanelListHeight =
    panelContentHeight > 0
      ? Math.min(panelContentHeight, genrePanelListMaxHeight)
      : undefined;
  const genrePanelHeight =
    genrePanelListHeight !== undefined
      ? Math.min(
          genrePanelListHeight + genrePanelChromeHeight,
          genrePanelMaxHeight,
        )
      : undefined;
  const genrePanelTop = -rootTop;

  return (
    <div ref={rootRef} data-testid="genre-picker-root" className="relative">
      {/* Level 1: category list 闂?same width as the panel */}
      <div
        ref={listRef}
        data-testid="genre-primary-list"
        className="flex flex-col gap-1.5"
      >
        {groupedGenres.map(([category]) => {
          const isActive = activeCategory === category;
          const selectedInCategory =
            groupedGenres
              .find(([c]) => c === category)?.[1]
              .filter((g) => selectedValues.has(g.value)).length ?? 0;
          return (
            <button
              key={category}
              ref={(node) => {
                categoryButtonRefs.current[category] = node;
              }}
              type="button"
              onClick={() => setActiveCategory(isActive ? null : category)}
              aria-expanded={isActive}
              aria-controls={isActive ? genrePanelId : undefined}
              className={`flex min-h-[46px] w-full items-center justify-between rounded-[16px] border px-3.5 py-2.5 text-left transition-colors ${
                isActive
                  ? dark
                    ? "border-white/[0.14] bg-white/[0.1]"
                    : "border-slate-300 bg-slate-100"
                  : dark
                    ? "border-white/[0.06] bg-white/[0.04] hover:bg-white/[0.08]"
                    : "border-slate-200 bg-slate-50 hover:bg-white"
              }`}
            >
              <span
                className={`text-[13px] font-medium ${dark ? "text-slate-100" : "text-slate-900"}`}
              >
                {category}
              </span>
              {selectedInCategory > 0 && (
                <span className="ml-2 inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[#0f62fe] px-1 text-[9px] font-medium text-white">
                  {selectedInCategory}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Level 2: genre panel 闂?floats to the right of the main panel */}
      {activeCategory !== null && (
        <div
          id={genrePanelId}
          data-testid="genre-secondary-panel"
          className={`absolute left-[calc(100%+14px)] z-10 w-[224px] overflow-hidden rounded-[13px] border px-1 pb-1 pt-0 ${
            dark
              ? "border-white/[0.05] bg-[linear-gradient(180deg,rgba(25,26,29,0.92),rgba(21,22,25,0.95))] shadow-[0_8px_18px_rgba(0,0,0,0.16)] backdrop-blur-md"
              : "border-slate-200/85 bg-white/98 shadow-[0_6px_16px_rgba(148,163,184,0.12)]"
          }`}
          style={{
            top: `${genrePanelTop}px`,
            height: genrePanelHeight ? `${genrePanelHeight}px` : undefined,
            maxHeight: `${genrePanelMaxHeight}px`,
          }}
        >
          <div
            ref={panelListRef}
            data-testid="genre-secondary-list"
            className="flex flex-col gap-1.5 overflow-y-auto scrollbar-none"
            style={{
              height: genrePanelListHeight
                ? `${genrePanelListHeight}px`
                : undefined,
              maxHeight: `${genrePanelListMaxHeight}px`,
            }}
          >
            {activeGenres.map((genre) => {
              const isSelected = selectedValues.has(genre.value);
              return (
                <button
                  key={genre.value}
                  type="button"
                  onClick={() => onSelect(genre.value, genre.label)}
                  className={`w-full shrink-0 rounded-[10px] border px-2.5 py-1.5 text-left transition-colors ${
                    isSelected
                      ? "border-[#2a73ff]/34 bg-[#0f62fe]/14"
                      : dark
                        ? "border-white/[0.04] bg-white/[0.025] hover:bg-white/[0.055]"
                        : "border-slate-200/90 bg-slate-50/90 hover:bg-white"
                  } min-h-[66px]`}
                >
                  <div className="flex items-start justify-between gap-1.5">
                    <span
                      className={`line-clamp-1 text-[11.5px] font-medium leading-tight ${isSelected ? "text-white" : dark ? "text-slate-100" : "text-slate-900"}`}
                    >
                      {genre.label}
                    </span>
                    {isSelected && (
                      <Check className="mt-0.5 h-3 w-3 shrink-0 text-white" />
                    )}
                  </div>
                  <div
                    className={`mt-0.5 line-clamp-2 text-[9.5px] leading-[1.3] ${isSelected ? "text-white/62" : dark ? "text-slate-500" : "text-slate-500"}`}
                  >
                    {genre.desc}
                    <span
                      className={`ml-1 ${isSelected ? "text-white/42" : dark ? "text-slate-600" : "text-slate-400"}`}
                    >
                      {"\u53d7\u4f17\uff1a"}
                      {genre.audience}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function NestedOptionPicker({
  question,
  onSelect,
  onOpenConfirm,
  dark,
  registerEscapeHandler,
}: {
  question: ComposerQuestion;
  onSelect: (value: string, label: string) => void;
  onOpenConfirm: (option: ComposerQuestionOption) => void;
  dark: boolean;
  registerEscapeHandler?: (handler: (() => boolean) | null) => void;
}) {
  const normalizedOptions = useMemo(
    () => ensureUniqueNestedOptionIds(question.options),
    [question.options],
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const primaryListRef = useRef<HTMLDivElement | null>(null);
  const firstPrimaryOptionRef = useRef<HTMLButtonElement | null>(null);
  const secondaryPanelRef = useRef<HTMLDivElement | null>(null);
  const firstSecondaryOptionRef = useRef<HTMLButtonElement | null>(null);
  const tertiaryPanelRef = useRef<HTMLDivElement | null>(null);
  const firstTertiaryOptionRef = useRef<HTMLElement | null>(null);
  const quaternaryPanelRef = useRef<HTMLDivElement | null>(null);
  const firstQuaternaryOptionRef = useRef<HTMLButtonElement | null>(null);
  const [activeOptionId, setActiveOptionId] = useState<string | null>(null);
  const [customValue, setCustomValue] = useState("");
  const [activeChildId, setActiveChildId] = useState<string | null>(null);
  const [activeGrandchildId, setActiveGrandchildId] = useState<string | null>(
    null,
  );
  const [expandedQuaternaryGroupIds, setExpandedQuaternaryGroupIds] = useState<Set<string>>(new Set());
  const [childCustomValue, setChildCustomValue] = useState("");
  const [desktopNestedPanelWidths, setDesktopNestedPanelWidths] = useState<{
    secondary?: number;
    tertiary?: number;
    quaternary?: number;
  }>({});
  const [desktopNestedPanelOffsets, setDesktopNestedPanelOffsets] = useState<{
    secondaryTop?: number;
    tertiaryTop?: number;
    quaternaryTop?: number;
  }>({});
  const optionButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const childButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const grandchildButtonRefs = useRef<Record<string, HTMLButtonElement | null>>(
    {},
  );
  const nestedPanelId = `nested-panel-${toDomId(question.id)}`;

  const restoreOptionFocus = (optionId: string | null) => {
    if (!optionId) return;
    window.setTimeout(() => optionButtonRefs.current[optionId]?.focus(), 0);
  };

  const restoreChildFocus = (childId: string | null) => {
    if (!childId) return;
    window.setTimeout(() => childButtonRefs.current[childId]?.focus(), 0);
  };

  const restoreGrandchildFocus = (grandchildId: string | null) => {
    if (!grandchildId) return;
    window.setTimeout(
      () => grandchildButtonRefs.current[grandchildId]?.focus(),
      0,
    );
  };

  const collapseActiveGrandchild = () => {
    if (!activeGrandchildId) return false;
    const previousGrandchildId = activeGrandchildId;
    setActiveGrandchildId(null);
    restoreGrandchildFocus(previousGrandchildId);
    return true;
  };

  const collapseActiveChild = () => {
    if (!activeChildId) return false;
    const previousChildId = activeChildId;
    setActiveGrandchildId(null);
    setActiveChildId(null);
    setChildCustomValue("");
    restoreChildFocus(previousChildId);
    return true;
  };

  const collapseActiveOption = () => {
    if (!activeOptionId) return false;
    const previousOptionId = activeOptionId;
    setActiveOptionId(null);
    setCustomValue("");
    setActiveChildId(null);
    setActiveGrandchildId(null);
    setChildCustomValue("");
    restoreOptionFocus(previousOptionId);
    return true;
  };

  useEffect(() => {
    setActiveOptionId(null);
    setCustomValue("");
    setActiveChildId(null);
    setActiveGrandchildId(null);
    setChildCustomValue("");
  }, [question.id]);

  useEffect(() => {
    if (!registerEscapeHandler) return;
    registerEscapeHandler(() => {
      if (collapseActiveGrandchild()) return true;
      if (collapseActiveChild()) return true;
      if (collapseActiveOption()) return true;
      return false;
    });
    return () => registerEscapeHandler(null);
  }, [
    registerEscapeHandler,
    activeGrandchildId,
    activeChildId,
    activeOptionId,
  ]);

  const activeOption = useMemo(
    () =>
      normalizedOptions.find((option) => option.id === activeOptionId) ?? null,
    [activeOptionId, normalizedOptions],
  );

  const activeChild = useMemo(
    () =>
      activeOption?.children?.find((child) => child.id === activeChildId) ??
      null,
    [activeChildId, activeOption],
  );

  const activeGrandchild = useMemo(
    () =>
      activeChild?.children?.find((child) => child.id === activeGrandchildId) ??
      null,
    [activeChild, activeGrandchildId],
  );

  useEffect(() => {
    if (!activeOptionId || activeOption) return;
    setActiveOptionId(null);
    setCustomValue("");
    setActiveChildId(null);
    setActiveGrandchildId(null);
    setChildCustomValue("");
    setExpandedQuaternaryGroupIds(new Set());
  }, [activeOption, activeOptionId]);

  useEffect(() => {
    if (!activeChildId || activeChild) return;
    setActiveChildId(null);
    setActiveGrandchildId(null);
    setChildCustomValue("");
    setExpandedQuaternaryGroupIds(new Set());
  }, [activeChild, activeChildId]);

  useEffect(() => {
    if (!activeGrandchildId || activeGrandchild) return;
    setActiveGrandchildId(null);
    setExpandedQuaternaryGroupIds(new Set());
  }, [activeGrandchild, activeGrandchildId]);

  const hideDeepVideoWorkflowRationale =
    question.answerKey === "video-bridge-panel" ||
    question.answerKey === "video-generation-panel" ||
    question.answerKey === "video-refresh-panel";
  const topAlignActiveChildPanel = shouldTopAlignNestedChildPanel(activeChild);
  const useFloatingChildInputPanel =
    question.answerKey === "video-kickoff-prefs-style";
  const activeChildHasFloatingInput = Boolean(
    useFloatingChildInputPanel && activeChild?.childInput,
  );
  const hasTertiaryPanel = Boolean(
    activeChild?.children?.length || activeChildHasFloatingInput,
  );
  const hasQuaternaryPanel = Boolean(
    !activeChildHasFloatingInput && activeGrandchild?.children?.length,
  );

  useLayoutEffect(() => {
    if (typeof window === "undefined") return;

    const measure = () => {
      if (!rootRef.current || !activeOption) {
        setDesktopNestedPanelWidths({});
        setDesktopNestedPanelOffsets({});
        return;
      }

      if (window.innerWidth < 640) {
        setDesktopNestedPanelWidths({});
        setDesktopNestedPanelOffsets({});
        return;
      }

      const rootRect = rootRef.current.getBoundingClientRect();
      const availableWidth = Math.max(
        0,
        window.innerWidth - rootRect.right - NESTED_DESKTOP_EDGE_PADDING_PX,
      );
      setDesktopNestedPanelWidths(
        resolveNestedDesktopPanelWidths({
          availableWidth,
          hasTertiary: hasTertiaryPanel,
          hasQuaternary: hasQuaternaryPanel,
          tertiaryIsInput: activeChildHasFloatingInput,
        }),
      );

      const primaryListRect = primaryListRef.current?.getBoundingClientRect();
      const firstPrimaryOptionRect =
        firstPrimaryOptionRef.current?.getBoundingClientRect();
      const secondaryPanelRect =
        secondaryPanelRef.current?.getBoundingClientRect();
      const firstSecondaryOptionRect =
        firstSecondaryOptionRef.current?.getBoundingClientRect();
      const activeChildButtonRect = activeChildId
        ? childButtonRefs.current[activeChildId]?.getBoundingClientRect()
        : undefined;
      const tertiaryPanelRect =
        tertiaryPanelRef.current?.getBoundingClientRect();
      const firstTertiaryOptionRect =
        firstTertiaryOptionRef.current?.getBoundingClientRect();
      const quaternaryPanelRect =
        quaternaryPanelRef.current?.getBoundingClientRect();
      const firstQuaternaryOptionRect =
        firstQuaternaryOptionRef.current?.getBoundingClientRect();

      const secondaryAnchorTop =
        primaryListRect && firstPrimaryOptionRect
          ? firstPrimaryOptionRect.top - rootRect.top
          : 0;
      const secondaryFirstOptionOffset =
        secondaryPanelRect && firstSecondaryOptionRect
          ? firstSecondaryOptionRect.top - secondaryPanelRect.top
          : 0;
      const tertiaryAnchorTop =
        topAlignActiveChildPanel && secondaryPanelRect && activeChildButtonRect
          ? activeChildButtonRect.top - secondaryPanelRect.top
          : secondaryPanelRect && firstSecondaryOptionRect
            ? firstSecondaryOptionRect.top - secondaryPanelRect.top
          : 0;
      const tertiaryFirstOptionOffset =
        tertiaryPanelRect && firstTertiaryOptionRect
          ? firstTertiaryOptionRect.top - tertiaryPanelRect.top
          : 0;
      const quaternaryAnchorTop =
        tertiaryPanelRect && firstTertiaryOptionRect
          ? firstTertiaryOptionRect.top - tertiaryPanelRect.top
          : 0;
      const quaternaryFirstOptionOffset =
        quaternaryPanelRect && firstQuaternaryOptionRect
          ? firstQuaternaryOptionRect.top - quaternaryPanelRect.top
          : 0;

      let nextSecondaryTop = Math.round(
        secondaryAnchorTop - secondaryFirstOptionOffset,
      );
      const nextTertiaryTop = topAlignActiveChildPanel
        ? Math.round(tertiaryAnchorTop)
        : Math.round(tertiaryAnchorTop - tertiaryFirstOptionOffset);
      const nextQuaternaryTop = Math.round(
        quaternaryAnchorTop - quaternaryFirstOptionOffset,
      );

      const viewportTop = NESTED_DESKTOP_EDGE_PADDING_PX;
      const viewportHeight =
        window.innerHeight ||
        document.documentElement?.clientHeight ||
        rootRect.bottom + NESTED_DESKTOP_EDGE_PADDING_PX;
      const viewportBottom = viewportHeight - NESTED_DESKTOP_EDGE_PADDING_PX;
      const secondaryHeight = secondaryPanelRect?.height ?? 0;
      const tertiaryHeight =
        tertiaryPanelRect?.height ||
        (activeChild?.children?.length
          ? estimateNestedListPanelHeight(activeChild.children.length)
          : 0);
      const quaternaryHeight = quaternaryPanelRect?.height ?? 0;

      const candidateTops = [nextSecondaryTop];
      const candidateBottoms = [nextSecondaryTop + secondaryHeight];

      if (hasTertiaryPanel) {
        candidateTops.push(nextSecondaryTop + nextTertiaryTop);
        candidateBottoms.push(
          nextSecondaryTop + nextTertiaryTop + tertiaryHeight,
        );
      }

      if (hasQuaternaryPanel) {
        candidateTops.push(
          nextSecondaryTop + nextTertiaryTop + nextQuaternaryTop,
        );
        candidateBottoms.push(
          nextSecondaryTop +
            nextTertiaryTop +
            nextQuaternaryTop +
            quaternaryHeight,
        );
      }

      const clusterTop = Math.min(...candidateTops);
      const clusterBottom = Math.max(...candidateBottoms);
      const absoluteClusterTop = rootRect.top + clusterTop;
      const absoluteClusterBottom = rootRect.top + clusterBottom;

      if (absoluteClusterBottom > viewportBottom) {
        nextSecondaryTop -= Math.ceil(absoluteClusterBottom - viewportBottom);
      }

      if (absoluteClusterTop < viewportTop) {
        nextSecondaryTop += Math.ceil(viewportTop - absoluteClusterTop);
      }

      setDesktopNestedPanelOffsets({
        secondaryTop: nextSecondaryTop,
        tertiaryTop: nextTertiaryTop,
        quaternaryTop: nextQuaternaryTop,
      });
    };

    measure();
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
    };
  }, [
    activeChildId,
    activeChildHasFloatingInput,
    activeGrandchildId,
    activeOption,
    activeOptionId,
    hasQuaternaryPanel,
    hasTertiaryPanel,
    question.id,
    topAlignActiveChildPanel,
    desktopNestedPanelWidths.secondary,
    desktopNestedPanelWidths.tertiary,
    desktopNestedPanelWidths.quaternary,
  ]);

  const handleLeafSelection = (option: ComposerQuestionOption) => {
    if (option.disabled) return;
    if (option.confirmDialog) {
      onOpenConfirm(option);
      return;
    }

    onSelect(option.value, option.label);
  };

  const handlePrimaryClick = (option: ComposerQuestionOption) => {
    if (option.disabled) return;
    if (option.children?.length || option.childInput) {
      setActiveOptionId((current) =>
        current === option.id ? null : option.id,
      );
      setCustomValue("");
      setActiveChildId(null);
      setActiveGrandchildId(null);
      setChildCustomValue("");
      return;
    }

    handleLeafSelection(option);
  };

  const handleChildClick = (child: ComposerQuestionOption) => {
    if (child.disabled) return;
    if (child.children?.length) {
      setActiveChildId((current) => (current === child.id ? null : child.id));
      setActiveGrandchildId(null);
      setChildCustomValue("");
      return;
    }
    if (child.childInput) {
      setActiveChildId((current) => (current === child.id ? null : child.id));
      setActiveGrandchildId(null);
      setChildCustomValue("");
      return;
    }
    handleLeafSelection(child);
  };

  const handleGrandchildClick = (grandchild: ComposerQuestionOption) => {
    if (grandchild.disabled) return;
    if (grandchild.children?.length) {
      setActiveGrandchildId((current) =>
        current === grandchild.id ? null : grandchild.id,
      );
      setExpandedQuaternaryGroupIds(new Set());
      return;
    }
    handleLeafSelection(grandchild);
  };

  const toggleQuaternaryGroup = (id: string) => {
    setExpandedQuaternaryGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const customInputConfig = activeOption?.childInput;

  // Child input validation
  const childInputConfig = activeChild?.childInput;
  const isChildNumberInput = childInputConfig?.type === "number";
  const parsedChildCustomValue = Number(childCustomValue.trim());
  const normalizedChildCustomValue = Number.isFinite(parsedChildCustomValue)
    ? Math.round(parsedChildCustomValue)
    : NaN;
  const trimmedChildCustomValue = childCustomValue.trim();
  const childCustomValueMatchesPattern =
    !childInputConfig?.pattern ||
    new RegExp(childInputConfig.pattern).test(trimmedChildCustomValue);
  const childCustomValueInRange = isChildNumberInput
    ? Number.isFinite(normalizedChildCustomValue) &&
      (childInputConfig?.min == null ||
        normalizedChildCustomValue >= childInputConfig.min) &&
      (childInputConfig?.max == null ||
        normalizedChildCustomValue <= childInputConfig.max)
    : Boolean(trimmedChildCustomValue) &&
      (childInputConfig?.minLength == null ||
        trimmedChildCustomValue.length >= childInputConfig.minLength) &&
      (childInputConfig?.maxLength == null ||
        trimmedChildCustomValue.length <= childInputConfig.maxLength) &&
      childCustomValueMatchesPattern;

  const submitChildCustomValue = () => {
    if (!childInputConfig || !childCustomValueInRange) return;
    const submittedValue = isChildNumberInput
      ? String(normalizedChildCustomValue)
      : encodeURIComponent(trimmedChildCustomValue);
    const label =
      childInputConfig.labelTemplate?.replace(
        "{value}",
        isChildNumberInput
          ? String(normalizedChildCustomValue)
          : trimmedChildCustomValue,
      ) ??
      `${activeChild?.label ?? "自定义"} ${
        isChildNumberInput
          ? normalizedChildCustomValue
          : trimmedChildCustomValue
      }${childInputConfig.suffix ?? ""}`;
    onSelect(`${childInputConfig.actionPrefix}${submittedValue}`, label.trim());
  };
  const isNumberInput = customInputConfig?.type === "number";
  const parsedCustomValue = Number(customValue.trim());
  const normalizedCustomValue = Number.isFinite(parsedCustomValue)
    ? Math.round(parsedCustomValue)
    : NaN;
  const trimmedCustomValue = customValue.trim();
  const customValueMatchesPattern =
    !customInputConfig?.pattern ||
    new RegExp(customInputConfig.pattern).test(trimmedCustomValue);
  const customValueInRange = isNumberInput
    ? Number.isFinite(normalizedCustomValue) &&
      (customInputConfig?.min == null ||
        normalizedCustomValue >= customInputConfig.min) &&
      (customInputConfig?.max == null ||
        normalizedCustomValue <= customInputConfig.max)
    : Boolean(trimmedCustomValue) &&
      (customInputConfig?.minLength == null ||
        trimmedCustomValue.length >= customInputConfig.minLength) &&
      (customInputConfig?.maxLength == null ||
        trimmedCustomValue.length <= customInputConfig.maxLength) &&
      customValueMatchesPattern;

  const submitCustomValue = () => {
    if (!customInputConfig || !customValueInRange) return;

    const submittedValue = isNumberInput
      ? String(normalizedCustomValue)
      : encodeURIComponent(trimmedCustomValue);

    const label =
      customInputConfig.labelTemplate?.replace(
        "{value}",
        isNumberInput ? String(normalizedCustomValue) : trimmedCustomValue,
      ) ??
      `${activeOption?.label ?? "自定义"} ${
        isNumberInput ? normalizedCustomValue : trimmedCustomValue
      }${customInputConfig.suffix ?? ""}`;

    onSelect(
      `${customInputConfig.actionPrefix}${submittedValue}`,
      label.trim(),
    );
  };

  const renderDisabledRationale = (option: ComposerQuestionOption) => {
    if (!option.disabled || !option.rationale) return null;
    return (
      <div
        className={`mt-1.5 rounded-[10px] border px-2 py-1.5 text-[10px] leading-[1.45] ${
          dark
            ? "border-amber-400/20 bg-amber-500/10 text-amber-200"
            : "border-amber-200 bg-amber-50 text-amber-800"
        }`}
      >
        {option.rationale}
      </div>
    );
  };

  const shouldShowDeepNestedRationale = (option: ComposerQuestionOption) =>
    !option.disabled &&
    Boolean(option.rationale) &&
    !hideDeepVideoWorkflowRationale;
  const secondaryDesktopStyle = desktopNestedPanelWidths.secondary
    ? {
        width: `${desktopNestedPanelWidths.secondary}px`,
        minWidth: `${desktopNestedPanelWidths.secondary}px`,
        maxWidth: `${desktopNestedPanelWidths.secondary}px`,
      }
    : undefined;
  const tertiaryDesktopStyle = desktopNestedPanelWidths.tertiary
    ? {
        width: `${desktopNestedPanelWidths.tertiary}px`,
        minWidth: `${desktopNestedPanelWidths.tertiary}px`,
        maxWidth: `${desktopNestedPanelWidths.tertiary}px`,
      }
    : undefined;
  const quaternaryDesktopStyle = desktopNestedPanelWidths.quaternary
    ? {
        width: `${desktopNestedPanelWidths.quaternary}px`,
        minWidth: `${desktopNestedPanelWidths.quaternary}px`,
        maxWidth: `${desktopNestedPanelWidths.quaternary}px`,
      }
    : undefined;
  const secondaryPanelPositionStyle = {
    ...(secondaryDesktopStyle ?? {}),
    ...(desktopNestedPanelOffsets.secondaryTop != null
      ? { top: `${desktopNestedPanelOffsets.secondaryTop}px` }
      : {}),
  };
  const tertiaryPanelPositionStyle = {
    ...(tertiaryDesktopStyle ?? {}),
    ...(desktopNestedPanelOffsets.tertiaryTop != null
      ? { top: `${desktopNestedPanelOffsets.tertiaryTop}px` }
      : topAlignActiveChildPanel
        ? { top: "0px" }
        : {}),
  };
  const quaternaryPanelPositionStyle = {
    ...(quaternaryDesktopStyle ?? {}),
    ...(desktopNestedPanelOffsets.quaternaryTop != null
      ? { top: `${desktopNestedPanelOffsets.quaternaryTop}px` }
      : {}),
  };
  return (
    <div ref={rootRef} className="relative">
      <div ref={primaryListRef} className="flex flex-col gap-1.5">
        {normalizedOptions.map((option) => {
          const hasChildren = Boolean(
            option.children?.length || option.childInput,
          );
          const isActive = activeOptionId === option.id;

          return (
            <button
              key={option.id}
              ref={(node) => {
                optionButtonRefs.current[option.id] = node;
                if (normalizedOptions[0]?.id === option.id) {
                  firstPrimaryOptionRef.current = node;
                }
              }}
              type="button"
              disabled={option.disabled}
              onClick={() => handlePrimaryClick(option)}
              aria-expanded={hasChildren ? isActive : undefined}
              aria-controls={hasChildren ? nestedPanelId : undefined}
              className={`flex min-h-[54px] w-full items-start justify-between gap-3 rounded-[16px] border px-3.5 py-3 text-left transition-colors ${
                option.selected
                  ? "border-[#2a73ff]/40 bg-[#0f62fe]/16 text-white"
                  : option.disabled
                    ? dark
                      ? "cursor-not-allowed border-white/[0.05] bg-white/[0.025] text-slate-500 opacity-55"
                      : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400 opacity-70"
                    : dark
                      ? "border-white/[0.06] bg-white/[0.04] hover:bg-white/[0.08]"
                      : "border-slate-200 bg-slate-50 hover:bg-white"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div
                  className={`text-[12.5px] font-medium ${
                    option.selected
                      ? "text-white"
                      : option.disabled
                        ? dark
                          ? "text-slate-500"
                          : "text-slate-400"
                        : dark
                          ? "text-slate-100"
                          : "text-slate-900"
                  } line-clamp-1 pr-1 leading-[1.35]`}
                >
                  {option.label}
                </div>
                {option.rationale ? (
                  <div
                    className={`mt-1 line-clamp-1 text-[10px] leading-[1.45] ${
                      option.selected
                        ? "text-white/78"
                        : dark
                          ? "text-slate-500"
                          : "text-slate-500"
                    }`}
                  >
                    {option.rationale}
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-2 pt-0.5">
                {hasChildren ? (
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 transition-transform ${isActive ? "-rotate-90" : ""}`}
                  />
                ) : option.selected ? (
                  <Check className="h-4 w-4 shrink-0" />
                ) : null}
              </div>
            </button>
          );
        })}
      </div>

      {activeOption &&
      (activeOption.children?.length || activeOption.childInput) ? (
        <div
          className="sm:absolute sm:left-[calc(100%+14px)] relative mt-2 sm:mt-0"
          style={secondaryPanelPositionStyle}
        >
          <div
            ref={secondaryPanelRef}
            id={nestedPanelId}
            data-testid="nested-secondary-panel"
            className={`z-10 w-full ${NESTED_PANEL_FRAME_CLASS} sm:w-auto ${
              dark
                ? "border-white/[0.05] bg-[linear-gradient(180deg,rgba(25,26,29,0.94),rgba(21,22,25,0.97))] shadow-[0_8px_18px_rgba(0,0,0,0.16)] backdrop-blur-md"
                : "border-slate-200/85 bg-white/98 shadow-[0_6px_16px_rgba(148,163,184,0.12)]"
            }`}
          >
            <div className="flex flex-col">
              <div
                className={`${NESTED_PANEL_HEADER_CLASS} ${dark ? "text-slate-300" : "text-slate-700"}`}
              >
                {activeOption.label}
              </div>

              <div className={NESTED_PANEL_LIST_CLASS}>
                {activeOption.children?.map((child) => {
                  const childHasInput = Boolean(child.childInput);
                  const childHasChildren = Boolean(child.children?.length);
                  const isChildActive = activeChildId === child.id;
                  return (
                    <div key={child.id}>
                      <button
                        ref={(node) => {
                          childButtonRefs.current[child.id] = node;
                          if (activeOption.children?.[0]?.id === child.id) {
                            firstSecondaryOptionRef.current = node;
                          }
                        }}
                        type="button"
                        disabled={child.disabled}
                        onClick={() => handleChildClick(child)}
                        aria-expanded={
                          childHasInput || childHasChildren
                            ? isChildActive
                            : undefined
                        }
                        aria-controls={
                          childHasInput
                            ? `${nestedPanelId}-${toDomId(child.id)}-input`
                            : undefined
                        }
                        className={`${NESTED_PANEL_OPTION_CLASS} ${
                          child.selected
                            ? "border-[#2a73ff]/34 bg-[#0f62fe]/14"
                            : child.disabled
                              ? dark
                                ? "cursor-not-allowed border-white/[0.04] bg-white/[0.02] opacity-55"
                                : "cursor-not-allowed border-slate-200/90 bg-slate-100/90 opacity-70"
                              : dark
                                ? "border-white/[0.04] bg-white/[0.025] hover:bg-white/[0.055]"
                                : "border-slate-200/90 bg-slate-50/90 hover:bg-white"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-1.5">
                          <span
                            className={`line-clamp-1 text-[12px] font-medium ${
                              child.selected
                                ? "text-white"
                                : child.disabled
                                  ? dark
                                    ? "text-slate-500"
                                    : "text-slate-400"
                                  : dark
                                    ? "text-slate-100"
                                    : "text-slate-900"
                            }`}
                          >
                            {child.label}
                          </span>
                          {childHasChildren ? (
                            <ChevronDown
                              className={`mt-0.5 h-3 w-3 shrink-0 transition-transform ${isChildActive ? "-rotate-90" : ""} ${dark ? "text-slate-400" : "text-slate-500"}`}
                            />
                          ) : childHasInput ? (
                            <ChevronDown
                              className={`mt-0.5 h-3 w-3 shrink-0 transition-transform ${isChildActive ? "-rotate-90" : ""} ${dark ? "text-slate-400" : "text-slate-500"}`}
                            />
                          ) : child.selected ? (
                            <Check className="mt-0.5 h-3 w-3 shrink-0 text-white" />
                          ) : null}
                        </div>
                        {!child.disabled && child.rationale ? (
                          <div
                            className={`mt-1 line-clamp-1 text-[10px] leading-[1.4] ${
                              child.selected
                                ? "text-white/72"
                                : dark
                                  ? "text-slate-500"
                                  : "text-slate-500"
                            }`}
                          >
                            {child.rationale}
                          </div>
                        ) : null}
                        {renderDisabledRationale(child)}
                      </button>
                      {isChildActive &&
                      child.childInput &&
                      !useFloatingChildInputPanel ? (
                        <div
                          id={`${nestedPanelId}-${toDomId(child.id)}-input`}
                          className={`mt-1 space-y-2 rounded-[12px] border px-3 py-3 ${
                            dark
                              ? "border-white/[0.05] bg-white/[0.03]"
                              : "border-slate-200 bg-slate-50/80"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type={isChildNumberInput ? "number" : "text"}
                              min={
                                isChildNumberInput
                                  ? child.childInput.min
                                  : undefined
                              }
                              max={
                                isChildNumberInput
                                  ? child.childInput.max
                                  : undefined
                              }
                              minLength={
                                !isChildNumberInput
                                  ? child.childInput.minLength
                                  : undefined
                              }
                              maxLength={
                                !isChildNumberInput
                                  ? child.childInput.maxLength
                                  : undefined
                              }
                              pattern={
                                !isChildNumberInput
                                  ? child.childInput.pattern
                                  : undefined
                              }
                              value={childCustomValue}
                              onChange={(event) =>
                                setChildCustomValue(event.target.value)
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  submitChildCustomValue();
                                }
                              }}
                              placeholder={child.childInput.placeholder}
                              className={`h-9 min-w-0 flex-1 rounded-[10px] border px-3 text-[12px] outline-none transition-colors ${
                                dark
                                  ? "border-white/[0.08] bg-[#0f1115] text-slate-100 placeholder:text-slate-500 focus:border-[#2a73ff]/50"
                                  : "border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus:border-[#2a73ff]/50"
                              }`}
                            />
                            {child.childInput.suffix ? (
                              <span
                                className={`text-[11px] ${dark ? "text-slate-400" : "text-slate-500"}`}
                              >
                                {child.childInput.suffix}
                              </span>
                            ) : null}
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            className="h-8 w-full rounded-full bg-[#0f62fe] px-3.5 text-[12px] text-white shadow-[0_8px_16px_rgba(15,98,254,0.16)] hover:bg-[#1b6fff]"
                            onClick={submitChildCustomValue}
                            disabled={!childCustomValueInRange}
                          >
                            {child.childInput.buttonLabel ?? "确认"}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {customInputConfig ? (
                <div
                  className={`mx-2 mb-2 space-y-2 rounded-[12px] border px-3 py-3 ${
                    dark
                      ? "border-white/[0.05] bg-white/[0.03]"
                      : "border-slate-200 bg-slate-50/80"
                  }`}
                >
                  <div
                    className={`text-[11px] font-medium ${dark ? "text-slate-200" : "text-slate-800"}`}
                  >
                    自定义
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type={isNumberInput ? "number" : "text"}
                      min={isNumberInput ? customInputConfig.min : undefined}
                      max={isNumberInput ? customInputConfig.max : undefined}
                      minLength={
                        !isNumberInput ? customInputConfig.minLength : undefined
                      }
                      maxLength={
                        !isNumberInput ? customInputConfig.maxLength : undefined
                      }
                      pattern={
                        !isNumberInput ? customInputConfig.pattern : undefined
                      }
                      value={customValue}
                      onChange={(event) => setCustomValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          submitCustomValue();
                        }
                      }}
                      placeholder={customInputConfig.placeholder}
                      className={`h-9 min-w-0 flex-1 rounded-[10px] border px-3 text-[12px] outline-none transition-colors ${
                        dark
                          ? "border-white/[0.08] bg-[#0f1115] text-slate-100 placeholder:text-slate-500 focus:border-[#2a73ff]/50"
                          : "border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus:border-[#2a73ff]/50"
                      }`}
                    />
                    {customInputConfig.suffix ? (
                      <span
                        className={`text-[11px] ${dark ? "text-slate-400" : "text-slate-500"}`}
                      >
                        {customInputConfig.suffix}
                      </span>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 w-full rounded-full bg-[#0f62fe] px-3.5 text-[12px] text-white shadow-[0_8px_16px_rgba(15,98,254,0.16)] hover:bg-[#1b6fff]"
                    onClick={submitCustomValue}
                    disabled={!customValueInRange}
                  >
                    {customInputConfig.buttonLabel ?? "确认"}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>

          {/* 三级面板：当子选项有 children 时，在右侧弹出 */}
          {activeChild &&
          (activeChild.children?.length || activeChildHasFloatingInput) ? (
            <div
              ref={tertiaryPanelRef}
              data-testid={
                activeChildHasFloatingInput
                  ? "nested-child-input-panel"
                  : "nested-tertiary-panel"
              }
              className={`absolute left-[calc(100%+4px)] top-0 z-20 ${
                activeChildHasFloatingInput ? "w-[272px]" : "w-[204px]"
              } ${NESTED_PANEL_FRAME_CLASS} overflow-visible ${
                dark
                  ? "border-white/[0.05] bg-[linear-gradient(180deg,rgba(25,26,29,0.96),rgba(21,22,25,0.98))] shadow-[0_8px_18px_rgba(0,0,0,0.18)] backdrop-blur-md"
                  : "border-slate-200/85 bg-white/98 shadow-[0_6px_16px_rgba(148,163,184,0.12)]"
              }`}
              style={tertiaryPanelPositionStyle}
            >
              <div
                className={`${NESTED_PANEL_HEADER_CLASS} ${dark ? "text-slate-300" : "text-slate-700"}`}
              >
                {activeChild.label}
              </div>
              {activeChildHasFloatingInput && childInputConfig ? (
                <div
                  id={`${nestedPanelId}-${toDomId(activeChild.id)}-input`}
                  ref={(node) => {
                    firstTertiaryOptionRef.current = node;
                  }}
                  className="space-y-2 px-3 pb-3"
                >
                  <div
                    className={`text-[11px] leading-[1.55] ${dark ? "text-slate-300" : "text-slate-600"}`}
                  >
                    {activeChild.rationale ??
                      "补充你的自定义风格说明后会自动继续下一步。"}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type={isChildNumberInput ? "number" : "text"}
                      min={
                        isChildNumberInput ? childInputConfig.min : undefined
                      }
                      max={
                        isChildNumberInput ? childInputConfig.max : undefined
                      }
                      minLength={
                        !isChildNumberInput
                          ? childInputConfig.minLength
                          : undefined
                      }
                      maxLength={
                        !isChildNumberInput
                          ? childInputConfig.maxLength
                          : undefined
                      }
                      pattern={
                        !isChildNumberInput
                          ? childInputConfig.pattern
                          : undefined
                      }
                      value={childCustomValue}
                      onChange={(event) =>
                        setChildCustomValue(event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          submitChildCustomValue();
                        }
                      }}
                      placeholder={childInputConfig.placeholder}
                      className={`h-10 min-w-0 flex-1 rounded-[10px] border px-3 text-[12px] outline-none transition-colors ${
                        dark
                          ? "border-white/[0.08] bg-[#0f1115] text-slate-100 placeholder:text-slate-500 focus:border-[#2a73ff]/50"
                          : "border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus:border-[#2a73ff]/50"
                      }`}
                    />
                    {childInputConfig.suffix ? (
                      <span
                        className={`text-[11px] ${dark ? "text-slate-400" : "text-slate-500"}`}
                      >
                        {childInputConfig.suffix}
                      </span>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 w-full rounded-full bg-[#0f62fe] px-3.5 text-[12px] text-white shadow-[0_8px_16px_rgba(15,98,254,0.16)] hover:bg-[#1b6fff]"
                    onClick={submitChildCustomValue}
                    disabled={!childCustomValueInRange}
                  >
                    {childInputConfig.buttonLabel ?? "确认"}
                  </Button>
                </div>
              ) : (
                <div className={NESTED_PANEL_SCROLL_LIST_CLASS}>
                  {activeChild.children?.map((grandchild) => {
                    const grandchildHasChildren = Boolean(
                      grandchild.children?.length,
                    );
                    const isGrandchildActive =
                      activeGrandchildId === grandchild.id;
                    return (
                      <button
                        key={grandchild.id}
                        ref={(node) => {
                          grandchildButtonRefs.current[grandchild.id] = node;
                          if (activeChild.children?.[0]?.id === grandchild.id) {
                            firstTertiaryOptionRef.current = node;
                          }
                        }}
                        type="button"
                        disabled={grandchild.disabled}
                        onClick={() => handleGrandchildClick(grandchild)}
                        aria-expanded={
                          grandchildHasChildren ? isGrandchildActive : undefined
                        }
                        className={`${NESTED_PANEL_OPTION_CLASS} ${
                          grandchild.disabled
                            ? dark
                              ? "cursor-not-allowed border-white/[0.04] bg-white/[0.02] opacity-55"
                              : "cursor-not-allowed border-slate-200/90 bg-slate-100/90 opacity-70"
                            : isGrandchildActive
                              ? dark
                                ? "border-white/[0.08] bg-white/[0.08] text-white"
                                : "border-slate-300 bg-white text-slate-900"
                              : dark
                                ? "border-white/[0.04] bg-white/[0.025] text-slate-100 hover:bg-white/[0.07] hover:text-white"
                                : "border-slate-200/90 bg-slate-50/90 text-slate-900 hover:bg-white"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div
                            className={`line-clamp-1 text-[12px] font-medium ${grandchild.disabled ? (dark ? "text-slate-500" : "text-slate-400") : dark ? "text-slate-100" : "text-slate-900"}`}
                          >
                            {grandchild.label}
                          </div>
                          {grandchildHasChildren ? (
                            <ChevronDown
                              className={`mt-0.5 h-3 w-3 shrink-0 transition-transform ${isGrandchildActive ? "-rotate-90" : ""} ${dark ? "text-slate-400" : "text-slate-500"}`}
                            />
                          ) : null}
                        </div>
                        {shouldShowDeepNestedRationale(grandchild) ? (
                          <div
                            className={`mt-1 line-clamp-2 text-[10px] leading-[1.4] ${dark ? "text-slate-500" : "text-slate-500"}`}
                          >
                            {grandchild.rationale}
                          </div>
                        ) : null}
                        {renderDisabledRationale(grandchild)}
                      </button>
                    );
                  })}
                </div>
              )}

              {!activeChildHasFloatingInput &&
              activeGrandchild &&
              activeGrandchild.children?.length ? (
                <div
                  ref={quaternaryPanelRef}
                  data-testid="nested-quaternary-panel"
                  className={`absolute left-[calc(100%+4px)] top-0 z-30 w-[188px] ${NESTED_PANEL_FRAME_CLASS} overflow-visible ${
                    dark
                      ? "border-white/[0.05] bg-[linear-gradient(180deg,rgba(25,26,29,0.98),rgba(21,22,25,0.99))] shadow-[0_8px_18px_rgba(0,0,0,0.18)] backdrop-blur-md"
                      : "border-slate-200/85 bg-white/98 shadow-[0_6px_16px_rgba(148,163,184,0.12)]"
                  }`}
                  style={quaternaryPanelPositionStyle}
                >
                  <div
                    className={`${NESTED_PANEL_HEADER_CLASS} ${dark ? "text-slate-300" : "text-slate-700"}`}
                  >
                    {activeGrandchild.label}
                  </div>
                  <div className={NESTED_PANEL_SCROLL_LIST_CLASS}>
                    {activeGrandchild.children.map((leaf, leafIdx) => {
                      if (leaf.children?.length) {
                        const isGroupExpanded = expandedQuaternaryGroupIds.has(leaf.id);
                        return (
                          <div key={leaf.id} className="flex flex-col">
                            <button
                              ref={(node) => {
                                if (leafIdx === 0) firstQuaternaryOptionRef.current = node;
                              }}
                              type="button"
                              onClick={() => toggleQuaternaryGroup(leaf.id)}
                              className={`${NESTED_PANEL_OPTION_CLASS} ${
                                dark
                                  ? "border-white/[0.04] bg-white/[0.025] text-slate-100 hover:bg-white/[0.07] hover:text-white"
                                  : "border-slate-200/90 bg-slate-50/90 text-slate-900 hover:bg-white"
                              }`}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className={`text-[12px] font-medium ${dark ? "text-slate-100" : "text-slate-900"}`}>
                                  {leaf.label}
                                </div>
                                <ChevronDown
                                  className={`mt-0.5 h-3 w-3 shrink-0 transition-transform ${isGroupExpanded ? "rotate-180" : ""} ${dark ? "text-slate-400" : "text-slate-500"}`}
                                />
                              </div>
                              {shouldShowDeepNestedRationale(leaf) ? (
                                <div className={`mt-1 line-clamp-2 text-[10px] leading-[1.45] ${dark ? "text-slate-400" : "text-slate-500"}`}>
                                  {leaf.rationale}
                                </div>
                              ) : null}
                            </button>
                            {isGroupExpanded ? (
                              <div className="flex flex-col gap-1 pb-1 pl-2 pt-1">
                                {leaf.children.map((child) => (
                                  <button
                                    key={child.id}
                                    type="button"
                                    disabled={child.disabled}
                                    onClick={() => handleLeafSelection(child)}
                                    className={`${NESTED_PANEL_OPTION_CLASS} ${
                                      child.disabled
                                        ? dark
                                          ? "cursor-not-allowed border-white/[0.04] bg-white/[0.02] opacity-55"
                                          : "cursor-not-allowed border-slate-200/90 bg-slate-100/90 opacity-70"
                                        : dark
                                          ? "border-white/[0.04] bg-white/[0.025] hover:bg-white/[0.055]"
                                          : "border-slate-200/90 bg-slate-50/90 hover:bg-white"
                                    }`}
                                  >
                                    <div className={`text-[12px] font-medium ${
                                      child.disabled
                                        ? dark ? "text-slate-500" : "text-slate-400"
                                        : dark ? "text-slate-100" : "text-slate-900"
                                    }`}>
                                      {child.label}
                                    </div>
                                    {shouldShowDeepNestedRationale(child) ? (
                                      <div className={`mt-1 line-clamp-2 text-[10px] leading-[1.45] ${dark ? "text-slate-400" : "text-slate-500"}`}>
                                        {child.rationale}
                                      </div>
                                    ) : null}
                                    {renderDisabledRationale(child)}
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        );
                      }
                      return (
                        <button
                          key={leaf.id}
                          ref={(node) => {
                            if (leafIdx === 0) firstQuaternaryOptionRef.current = node;
                          }}
                          type="button"
                          disabled={leaf.disabled}
                          onClick={() => handleLeafSelection(leaf)}
                          className={`${NESTED_PANEL_OPTION_CLASS} ${
                            leaf.selected
                              ? "border-[#2a73ff]/34 bg-[#0f62fe]/14"
                              : leaf.disabled
                                ? dark
                                  ? "cursor-not-allowed border-white/[0.04] bg-white/[0.02] opacity-55"
                                  : "cursor-not-allowed border-slate-200/90 bg-slate-100/90 opacity-70"
                                : dark
                                  ? "border-white/[0.04] bg-white/[0.025] hover:bg-white/[0.055]"
                                  : "border-slate-200/90 bg-slate-50/90 hover:bg-white"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div
                              className={`text-[12px] font-medium ${
                                leaf.selected
                                  ? "text-white"
                                  : leaf.disabled
                                    ? dark ? "text-slate-500" : "text-slate-400"
                                    : dark ? "text-slate-100" : "text-slate-900"
                              }`}
                            >
                              {leaf.label}
                            </div>
                            {leaf.selected ? (
                              <Check className="mt-0.5 h-3 w-3 shrink-0 text-white" />
                            ) : null}
                          </div>
                          {shouldShowDeepNestedRationale(leaf) ? (
                            <div className={`mt-1 line-clamp-2 text-[10px] leading-[1.45] ${dark ? "text-slate-400" : "text-slate-500"}`}>
                              {leaf.rationale}
                            </div>
                          ) : null}
                          {renderDisabledRationale(leaf)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ComposerChoicePanel({
  question,
  onSelect,
  onConfirm,
  onBack,
  onDismiss,
  canConfirm = false,
  tone = "dark",
  devMode = false,
  devVideoGenerationMode,
  devImageViewMode,
  onDevVideoGenerationModeChange,
  onDevImageViewModeChange,
}: ComposerChoicePanelProps) {
  const dark = tone === "dark";
  const [collapsed, setCollapsed] = useState(false);
  const [inlineConfirm, setInlineConfirm] =
    useState<ComposerQuestionOption | null>(null);
  const collapsedButtonRef = useRef<HTMLButtonElement | null>(null);
  const nestedEscapeHandlerRef = useRef<(() => boolean) | null>(null);
  const panelBodyId = `composer-choice-panel-body-${toDomId(question.id)}`;

  // 分离主选项和 dev 专属选项
  const mainOptions = useMemo(
    () => question.options.filter((o) => !o.devOnly),
    [question.options],
  );
  const devOptions = useMemo(
    () => question.options.filter((o) => o.devOnly),
    [question.options],
  );
  // 用 mainOptions 替代 question.options 参与布局计算
  const visibleQuestion = useMemo(
    () => ({ ...question, options: mainOptions }),
    [question, mainOptions],
  );

  const isGenreQuestion =
    visibleQuestion.answerKey === "\u9898\u6750\u9009\u62e9";
  const hasNestedOptions = visibleQuestion.options.some(
    (option) => option.children?.length || option.childInput,
  );
  const showQuestionStepIndicator =
    question.totalSteps > 1 &&
    question.answerKey !== "video-kickoff-prefs-mode";
  const showVideoModeBadge =
    question.answerKey.startsWith("video-") &&
    question.answerKey !== "video-kickoff-prefs-mode" &&
    Boolean(devVideoGenerationMode);
  const autoCompactChoiceMode =
    !isGenreQuestion &&
    !hasNestedOptions &&
    !visibleQuestion.multiSelect &&
    visibleQuestion.submissionMode !== "confirm" &&
    visibleQuestion.options.length <= 4 &&
    visibleQuestion.options.every(
      (option) => !option.rationale && option.label.trim().length <= 18,
    );
  const compactChoiceMode =
    visibleQuestion.presentation === "chip"
      ? true
      : visibleQuestion.presentation === "card"
        ? false
        : autoCompactChoiceMode;
  const helperCopy = visibleQuestion.multiSelect
    ? "\u53ef\u591a\u9009\u3002\u5148\u70b9\u9009\u5efa\u8bae\uff0c\u518d\u8865\u5145\u8f93\u5165\u3002"
    : visibleQuestion.submissionMode === "confirm"
      ? visibleQuestion.options.length === 1
        ? "\u786e\u8ba4\u540e\u76f4\u63a5\u6267\u884c\u3002"
        : "\u5148\u9009\u4e00\u4e2a\u65b9\u5411\uff0c\u518d\u786e\u8ba4\u7ee7\u7eed\u3002"
      : "\u70b9\u4efb\u4e00\u5efa\u8bae\u5373\u53ef\u76f4\u63a5\u63d0\u4ea4\u3002";
  const bottomHint =
    visibleQuestion.submissionMode === "confirm" || visibleQuestion.multiSelect
      ? visibleQuestion.allowCustomInput
        ? "\u4e5f\u53ef\u5728\u5e95\u90e8\u8f93\u5165\u6846\u8865\u5145\u8bf4\u660e\u3002"
        : "\u5982\u679c\u4e0d\u9700\u8981\u8865\u5145\u8f93\u5165\uff0c\u53ef\u4ee5\u76f4\u63a5\u7ee7\u7eed\u3002"
      : visibleQuestion.allowCustomInput
        ? "\u4e5f\u53ef\u5728\u5e95\u90e8\u8f93\u5165\u6846\u586b\u5199\u81ea\u5b9a\u4e49\u7b54\u6848\uff0c\u4e0d\u5fc5\u53d7\u9884\u8bbe\u9009\u9879\u9650\u5236\u3002"
        : null;
  const isSingleActionCard =
    !compactChoiceMode &&
    !visibleQuestion.multiSelect &&
    visibleQuestion.submissionMode === "confirm" &&
    visibleQuestion.options.length === 1;
  const useRelaxedCardListHeight =
    !compactChoiceMode && visibleQuestion.options.length <= 2;
  const useRelaxedPanelSpacing =
    !compactChoiceMode && visibleQuestion.options.length <= 2;

  const handleBackAction = () => {
    if (!isGenreQuestion && nestedEscapeHandlerRef.current?.()) return;
    onBack?.();
  };

  useEffect(() => {
    setCollapsed(false);
    setInlineConfirm(null);
  }, [question.id]);

  useEffect(() => {
    if (!collapsed) return;
    window.setTimeout(() => collapsedButtonRef.current?.focus(), 0);
  }, [collapsed]);

  const handlePanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    if (nestedEscapeHandlerRef.current?.()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (inlineConfirm) {
      event.preventDefault();
      event.stopPropagation();
      setInlineConfirm(null);
      return;
    }
    if (!collapsed) {
      event.preventDefault();
      event.stopPropagation();
      setCollapsed(true);
      return;
    }
    if (onBack) {
      event.preventDefault();
      event.stopPropagation();
      onBack();
    }
  };

  return (
    <div
      onKeyDownCapture={handlePanelKeyDown}
      data-choice-mode={compactChoiceMode ? "chip" : "card"}
      className={`w-full max-w-[488px] rounded-[18px] border p-2 sm:p-2.5 ${
        dark
          ? "border-white/[0.05] bg-[linear-gradient(180deg,rgba(27,28,31,0.82),rgba(20,21,24,0.93))] shadow-[0_12px_30px_rgba(0,0,0,0.15)] backdrop-blur-xl"
          : "border-slate-200/80 bg-white/96 shadow-[0_10px_20px_rgba(148,163,184,0.11)]"
      } transition-[border-color,background-color,box-shadow] duration-150 ${
        collapsed
          ? ""
          : isGenreQuestion || hasNestedOptions
            ? ""
            : "max-h-[min(64vh,760px)] overflow-y-auto scrollbar-none"
      }`}
    >
      {collapsed ? (
        <button
          ref={collapsedButtonRef}
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          aria-controls={panelBodyId}
          className={`flex w-full items-center justify-between rounded-[14px] border px-3 py-2.5 text-left transition-colors ${
            dark
              ? "border-white/[0.06] bg-white/[0.04] hover:bg-white/[0.07]"
              : "border-slate-200 bg-slate-50 hover:bg-white"
          }`}
          aria-label={`展开选择窗：${question.title}`}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[12px] bg-[#0f62fe]/92 text-white shadow-[0_6px_14px_rgba(15,98,254,0.2)]">
              <Sparkles className="h-2.5 w-2.5" />
            </span>
            <span className="min-w-0">
              <span
                className={`block truncate text-[12.5px] font-medium ${dark ? "text-slate-100" : "text-slate-900"}`}
              >
                {question.title}
              </span>
              {showQuestionStepIndicator ? (
                <span
                  className={`mt-0.5 block text-[10px] ${dark ? "text-slate-500" : "text-slate-500"}`}
                >
                  {"\u7b2c "}
                  {question.stepIndex + 1}
                  {" / "}
                  {question.totalSteps}
                  {" \u6b65"}
                </span>
              ) : null}
            </span>
          </span>
          <span className="ml-3 inline-flex items-center gap-1 text-[10px] font-medium text-slate-400">
            展开
            <ChevronDown className="h-3.5 w-3.5" />
          </span>
        </button>
      ) : inlineConfirm?.confirmDialog ? (
        <div id={panelBodyId} className="flex flex-col gap-3 px-1 py-0.5">
          <div className="flex items-start gap-2.5">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[12px] bg-[#0f62fe]/92 text-white shadow-[0_6px_14px_rgba(15,98,254,0.2)]">
              <Sparkles className="h-2.5 w-2.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div
                className={`text-[12.5px] font-medium ${dark ? "text-slate-100" : "text-slate-900"}`}
              >
                {inlineConfirm.confirmDialog.title}
              </div>
              <div
                className={`mt-0.5 text-[11px] leading-[1.55] ${dark ? "text-slate-400" : "text-slate-600"}`}
              >
                {inlineConfirm.confirmDialog.description}
              </div>
            </div>
          </div>

          {inlineConfirm.confirmDialog.summaryRows &&
            inlineConfirm.confirmDialog.summaryRows.length > 0 && (
              <div
                className={`rounded-[12px] border px-3.5 py-3 ${dark ? "border-white/[0.06] bg-white/[0.04]" : "border-slate-200 bg-slate-50"}`}
              >
                <ul className="space-y-1.5">
                  {inlineConfirm.confirmDialog.summaryRows.map((row, i) => {
                    const colonIdx = row.indexOf("\uff1a");
                    const label = colonIdx >= 0 ? row.slice(0, colonIdx) : row;
                    const value = colonIdx >= 0 ? row.slice(colonIdx + 1) : "";
                    return (
                      <li
                        key={i}
                        className="flex items-baseline gap-2 text-[11.5px]"
                      >
                        <span
                          className={`w-[4.5em] shrink-0 ${dark ? "text-slate-500" : "text-slate-500"}`}
                        >
                          {label}
                        </span>
                        <span
                          className={dark ? "text-slate-200" : "text-slate-800"}
                        >
                          {value}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

          <div className="flex items-center justify-end gap-2 pt-0.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={`h-8 rounded-full px-3.5 text-[12px] ${dark ? "border-white/[0.1] bg-white/[0.06] text-slate-200 hover:bg-white/[0.1] hover:text-white" : "border-slate-200 text-slate-700 hover:bg-slate-100"}`}
              onClick={() => setInlineConfirm(null)}
            >
              {inlineConfirm.confirmDialog.cancelLabel ?? "\u53d6\u6d88"}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8 rounded-full bg-[#0f62fe] px-3.5 text-[12px] text-white shadow-[0_8px_16px_rgba(15,98,254,0.16)] hover:bg-[#1b6fff]"
              onClick={() => {
                onSelect(inlineConfirm.value, inlineConfirm.label);
                setInlineConfirm(null);
              }}
            >
              {inlineConfirm.confirmDialog.confirmLabel ?? "\u786e\u8ba4"}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div id={panelBodyId} className="mb-2 flex items-start gap-2.5">
            {onBack ? (
              <button
                type="button"
                onClick={handleBackAction}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-[12px] transition-colors ${
                  dark
                    ? "text-slate-400 hover:bg-white/[0.08] hover:text-slate-200"
                    : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                }`}
                aria-label={"\u8fd4\u56de\u4e0a\u4e00\u6b65"}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
            ) : (
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[12px] bg-[#0f62fe]/92 text-white shadow-[0_6px_14px_rgba(15,98,254,0.2)]">
                <Sparkles className="h-2.5 w-2.5" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2.5">
                <div
                  className={`min-h-[18px] text-[12.5px] font-medium ${dark ? "text-slate-100" : "text-slate-900"}`}
                >
                  {question.title}
                </div>
                {showQuestionStepIndicator ? (
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <div className="flex items-center gap-1.5">
                      {showVideoModeBadge ? (
                        <div
                          className={`rounded-full px-1.5 py-0.5 text-[9.5px] font-medium ${
                            devVideoGenerationMode === "image-to-video"
                              ? dark
                                ? "bg-violet-500/20 text-violet-300"
                                : "bg-violet-50 text-violet-600"
                              : dark
                                ? "bg-sky-500/20 text-sky-300"
                                : "bg-sky-50 text-sky-600"
                          }`}
                        >
                          {devVideoGenerationMode === "image-to-video" ? "\u56fe\u751f\u89c6\u9891" : "\u6587\u751f\u89c6\u9891"}
                        </div>
                      ) : null}
                      <div
                        className={`rounded-full px-1.5 py-0.5 text-[9.5px] ${
                          dark
                            ? "border border-white/[0.08] bg-white/[0.05] text-slate-400"
                            : "border border-slate-200 bg-slate-100 text-slate-500"
                        }`}
                      >
                        {"\u7b2c "}
                        {question.stepIndex + 1}
                        {" / "}
                        {question.totalSteps}
                        {" \u6b65"}
                      </div>
                      <button
                        type="button"
                        onClick={() => setCollapsed(true)}
                        aria-expanded={true}
                        aria-controls={panelBodyId}
                        className={`flex h-5 w-5 items-center justify-center rounded-full transition-colors ${
                          dark
                            ? "text-slate-500 hover:bg-white/[0.08] hover:text-slate-300"
                            : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                        }`}
                        aria-label={`收起选择窗：${question.title}`}
                      >
                        <ChevronDown className="h-3 w-3" />
                      </button>
                      {onDismiss ? (
                        <button
                          type="button"
                          onClick={onDismiss}
                          data-testid="composer-choice-dismiss"
                          className={`flex h-5 w-5 items-center justify-center rounded-full transition-colors ${
                            dark
                              ? "text-slate-500 hover:bg-white/[0.08] hover:text-slate-300"
                              : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                          }`}
                          aria-label="关闭选择窗"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      ) : null}
                    </div>
                    {question.statusBadges &&
                    question.statusBadges.length > 0 ? (
                      <div className="flex items-center gap-1">
                        {question.statusBadges.map((badge) => (
                          <span
                            key={badge.label}
                            className={`rounded px-1 py-0.5 text-[9px] font-medium ${
                              badge.tone === "danger"
                                ? dark
                                  ? "bg-red-500/15 text-red-400"
                                  : "bg-red-50 text-red-600"
                                : badge.tone === "warning"
                                  ? dark
                                    ? "bg-orange-500/15 text-orange-400"
                                    : "bg-orange-50 text-orange-600"
                                  : dark
                                    ? "bg-white/[0.06] text-slate-400"
                                    : "bg-slate-100 text-slate-500"
                            }`}
                          >
                            {badge.label} {badge.value}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => setCollapsed(true)}
                      aria-expanded={true}
                      aria-controls={panelBodyId}
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors ${
                        dark
                          ? "text-slate-500 hover:bg-white/[0.08] hover:text-slate-300"
                          : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                      }`}
                      aria-label={`收起选择窗：${question.title}`}
                    >
                      <ChevronDown className="h-3 w-3" />
                    </button>
                    {onDismiss ? (
                      <button
                        type="button"
                        onClick={onDismiss}
                        data-testid="composer-choice-dismiss"
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors ${
                          dark
                            ? "text-slate-500 hover:bg-white/[0.08] hover:text-slate-300"
                            : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                        }`}
                        aria-label="关闭选择窗"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
              <div className="mt-0.5">
                <div
                  className={`${useRelaxedPanelSpacing ? "min-h-[18px]" : "min-h-[34px]"} text-[11px] leading-[1.55] ${dark ? "text-slate-400" : "text-slate-600"}`}
                >
                  {question.description ?? ""}
                </div>
                <div
                  className={`mt-1 ${useRelaxedPanelSpacing ? "min-h-[12px]" : "min-h-[15px]"} text-[10px] ${dark ? "text-slate-500" : "text-slate-500"}`}
                >
                  {helperCopy}
                </div>
              </div>
            </div>
          </div>

          {isGenreQuestion ? (
            <GenreCategoryPicker
              question={visibleQuestion}
              onSelect={onSelect}
              dark={dark}
              registerEscapeHandler={(handler) => {
                nestedEscapeHandlerRef.current = handler;
              }}
            />
          ) : hasNestedOptions ? (
            <NestedOptionPicker
              question={visibleQuestion}
              onSelect={onSelect}
              onOpenConfirm={setInlineConfirm}
              dark={dark}
              registerEscapeHandler={(handler) => {
                nestedEscapeHandlerRef.current = handler;
              }}
            />
          ) : compactChoiceMode ? (
            <div className="flex min-h-[44px] flex-wrap gap-1.5">
              {visibleQuestion.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  disabled={option.disabled}
                  onClick={() => onSelect(option.value, option.label)}
                  className={`inline-flex min-h-9 items-center rounded-full border px-3 py-1.5 text-left text-[12px] font-medium transition-colors ${
                    option.selected
                      ? "border-[#2a73ff] bg-[#0f62fe]/18 text-white shadow-[0_8px_16px_rgba(15,98,254,0.12)]"
                      : option.disabled
                        ? dark
                          ? "cursor-not-allowed border-white/[0.06] bg-white/[0.03] text-slate-500 opacity-55"
                          : "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400 opacity-70"
                        : dark
                          ? "border-white/[0.08] bg-white/[0.04] text-slate-200 hover:bg-white/[0.07]"
                          : "border-slate-200 bg-slate-50 text-slate-900 hover:bg-white"
                  }`}
                >
                  <span className="truncate">{option.label}</span>
                </button>
              ))}
            </div>
          ) : (
            <div
              className={
                isSingleActionCard || useRelaxedCardListHeight
                  ? "space-y-1.5"
                  : "min-h-[156px] space-y-1.5"
              }
            >
              {visibleQuestion.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  disabled={option.disabled}
                  onClick={() => {
                    if (option.disabled) return;
                    if (option.confirmDialog) {
                      setInlineConfirm(option);
                    } else {
                      onSelect(option.value, option.label);
                    }
                  }}
                  className={`group w-full rounded-[16px] border px-3 py-2 text-left transition-colors ${
                    option.selected
                      ? "border-[#2a73ff]/40 bg-[#0f62fe]/16 text-white"
                      : option.disabled
                        ? dark
                          ? "cursor-not-allowed border-white/[0.05] bg-white/[0.025] opacity-55"
                          : "cursor-not-allowed border-slate-200 bg-slate-100 opacity-70"
                        : dark
                          ? "border-white/[0.06] bg-white/[0.04] hover:bg-white/[0.08]"
                          : "border-slate-200 bg-slate-50 hover:bg-white"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div
                      className={`text-[12.5px] font-medium ${
                        option.selected
                          ? "text-white"
                          : option.disabled
                            ? dark
                              ? "text-slate-500"
                              : "text-slate-400"
                            : dark
                              ? "text-slate-100"
                              : "text-slate-900"
                      }`}
                    >
                      {option.label}
                    </div>
                    {option.selected ? (
                      <Check className="mt-0.5 h-4 w-4 shrink-0" />
                    ) : null}
                  </div>
                  {option.rationale ? (
                    <div
                      className={`mt-0.5 line-clamp-1 text-[10px] leading-[1.45] ${
                        option.selected
                          ? "text-white/78"
                          : dark
                            ? "text-slate-500"
                            : "text-slate-500"
                      }`}
                    >
                      {option.rationale}
                    </div>
                  ) : null}
                </button>
              ))}
            </div>
          )}

          <div
            className={
              isSingleActionCard || useRelaxedPanelSpacing
                ? "mt-1.5"
                : "mt-2 min-h-[42px]"
            }
          >
            {(visibleQuestion.submissionMode === "confirm" ||
              visibleQuestion.multiSelect) &&
            onConfirm ? (
              <div className="flex items-center justify-between gap-2.5">
                <div
                  className={`text-[10px] ${dark ? "text-slate-500" : "text-slate-500"}`}
                >
                  {bottomHint}
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="h-8 rounded-full bg-[#0f62fe] px-3.5 text-[12px] text-white shadow-[0_8px_16px_rgba(15,98,254,0.16)] hover:bg-[#1b6fff]"
                  onClick={onConfirm}
                  disabled={!canConfirm}
                >
                  {visibleQuestion.options.length === 1 &&
                  !visibleQuestion.multiSelect
                    ? "\u786e\u8ba4\u6267\u884c"
                    : "\u7ee7\u7eed"}
                </Button>
              </div>
            ) : bottomHint ? (
              <div
                className={`pt-1 text-[10px] ${dark ? "text-slate-500" : "text-slate-500"}`}
              >
                {bottomHint}
              </div>
            ) : null}
          </div>
          {devMode ? (
            <DevOptionsPanel
              devOptions={devOptions}
              onSelect={onSelect}
              devVideoGenerationMode={devVideoGenerationMode}
              devImageViewMode={devImageViewMode}
              onDevVideoGenerationModeChange={onDevVideoGenerationModeChange}
              onDevImageViewModeChange={onDevImageViewModeChange}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * ToolCallBlock – collapsible tool call / result display.
 */

import { useState, useCallback } from 'react'
import { ChevronDown, ChevronRight, Wrench, CheckCircle2, XCircle, Loader2, Download, ImageIcon, Film } from 'lucide-react'
import type { ToolUseBlock, ToolResultBlock } from '@/lib/agent/types'

interface Props {
  toolUse: ToolUseBlock
  toolResult?: ToolResultBlock
}

const IMAGE_ACTIONS = new Set([
  'generate_video_reference_assets',
  'generate_storyboard_frames',
  'generate_project_image',
])

const VIDEO_ACTIONS = new Set([
  'generate_video_assets',
])

function isImageAction(toolUse: ToolUseBlock): boolean {
  return (
    toolUse.name === 'HomeStudioWorkflow' &&
    typeof toolUse.input.action === 'string' &&
    IMAGE_ACTIONS.has(toolUse.input.action)
  )
}

function isVideoAction(toolUse: ToolUseBlock): boolean {
  return (
    toolUse.name === 'HomeStudioWorkflow' &&
    typeof toolUse.input.action === 'string' &&
    VIDEO_ACTIONS.has(toolUse.input.action)
  )
}

function parseImageUrls(content: string): string[] {
  try {
    const parsed = JSON.parse(content)
    if (Array.isArray(parsed?.imageUrls)) {
      return parsed.imageUrls.filter((u: unknown) => typeof u === 'string' && u.trim())
    }
  } catch {
    // 非 JSON 内容，忽略
  }
  return []
}

async function downloadImage(url: string, index: number) {
  try {
    const res = await fetch(url)
    const blob = await res.blob()
    const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg'
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = `generated-image-${index + 1}.${ext}`
    a.click()
    URL.revokeObjectURL(objectUrl)
  } catch {
    window.open(url, '_blank')
  }
}

function ImageLoadingPlaceholder() {
  return (
    <div className="px-3 py-3 border-t">
      <div className="flex items-center gap-2 mb-2 text-muted-foreground">
        <ImageIcon className="w-3.5 h-3.5 animate-pulse" />
        <span className="animate-pulse">正在生成图片，请稍候…</span>
      </div>
      <div className="flex gap-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-32 w-32 rounded bg-muted animate-pulse"
            style={{ animationDelay: `${i * 150}ms` }}
          />
        ))}
      </div>
    </div>
  )
}

function VideoLoadingPlaceholder() {
  return (
    <div className="px-3 py-3 border-t">
      <div className="flex items-center gap-2 mb-2.5 text-muted-foreground">
        <Film className="w-3.5 h-3.5 animate-pulse" />
        <span className="animate-pulse">正在生成视频，请稍候…</span>
      </div>
      <div className="flex gap-3">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="relative overflow-hidden rounded-xl bg-muted/60 border border-border/30"
            style={{ width: 148, height: 148 }}
          >
            {/* 扫光层 */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 w-full animate-shimmer-sweep"
                style={{
                  background: "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.10) 50%, transparent 100%)",
                  animationDelay: `${i * 300}ms`,
                }}
              />
            </div>
            {/* 转圈 + 文字 */}
            <div className="flex h-full w-full flex-col items-center justify-center gap-2.5">
              <div className="relative h-9 w-9">
                <div className="absolute inset-0 rounded-full border-2 border-primary/15" />
                <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-primary/55" />
              </div>
              <span className="text-[11px] font-medium text-foreground/45">正在生成视频</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ToolCallBlock({ toolUse, toolResult }: Props) {
  const [open, setOpen] = useState(false)
  const isError = toolResult?.is_error
  const isPending = !toolResult
  const showImageLoading = isPending && isImageAction(toolUse)
  const showVideoLoading = isPending && isVideoAction(toolUse)
  const imageUrls = toolResult && !isError ? parseImageUrls(toolResult.content) : []

  const handleDownload = useCallback((url: string, i: number) => {
    downloadImage(url, i)
  }, [])

  return (
    <div className="border rounded-lg text-xs my-1 overflow-hidden bg-muted/30">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-muted/50 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        {isPending ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500 shrink-0" />
        ) : isError ? (
          <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
        ) : (
          <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
        )}
        <Wrench className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className="font-mono font-medium">{toolUse.name}</span>
        <span className="text-muted-foreground truncate">
          {Object.entries(toolUse.input)
            .slice(0, 2)
            .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 40)}`)
            .join(', ')}
        </span>
        <span className="ml-auto shrink-0">
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </span>
      </button>

      {/* 图片生成中：骨架屏占位 */}
      {showImageLoading && <ImageLoadingPlaceholder />}

      {/* 视频生成中：Gemini 风格扫光占位 */}
      {showVideoLoading && <VideoLoadingPlaceholder />}

      {/* 图片生成完毕：直接展示 + 下载按钮 */}
      {imageUrls.length > 0 && (
        <div className="px-3 py-2 border-t flex flex-wrap gap-3">
          {imageUrls.map((url, i) => (
            <div key={i} className="relative group">
              <img
                src={url}
                alt={`生成图片 ${i + 1}`}
                className="rounded max-h-48 object-contain border bg-muted"
                style={{ maxWidth: '100%' }}
              />
              <button
                onClick={() => handleDownload(url, i)}
                className="absolute bottom-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity bg-black/60 hover:bg-black/80 text-white rounded p-1"
                title="下载图片"
              >
                <Download className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="px-3 pb-3 space-y-2 border-t">
          <div>
            <p className="text-muted-foreground mt-2 mb-1 font-medium">Input</p>
            <pre className="bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(toolUse.input, null, 2)}
            </pre>
          </div>
          {toolResult && (
            <div>
              <p className={`mb-1 font-medium ${isError ? 'text-red-500' : 'text-muted-foreground'}`}>
                {isError ? 'Error' : 'Result'}
              </p>
              <pre className={`rounded p-2 overflow-x-auto whitespace-pre-wrap break-all ${
                isError ? 'bg-red-50 dark:bg-red-950' : 'bg-muted'
              }`}>
                {toolResult.content}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

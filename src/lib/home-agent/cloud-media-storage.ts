type WorkflowAssetResponse = {
  asset?: {
    url?: string;
    size?: number;
    mimeType?: string;
  };
};

function canUseCloudMediaStorage(): boolean {
  if (typeof window === "undefined") return false;
  if (window.location.protocol === "file:") return false;
  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    return false;
  }
  return typeof window.fetch === "function";
}

async function ensureWorkflowSession(): Promise<boolean> {
  const response = await fetch("/api/workflow/session", {
    method: "POST",
    headers: { accept: "application/json" },
  });
  return response.ok;
}

async function postWorkflowAsset(payload: Record<string, unknown>): Promise<WorkflowAssetResponse["asset"] | null> {
  if (!canUseCloudMediaStorage()) return null;

  await ensureWorkflowSession();
  const response = await fetch("/api/workflow/assets", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as WorkflowAssetResponse;
  return body.asset?.url ? body.asset : null;
}

export async function uploadBase64ToCloudMedia(params: {
  base64: string;
  mimeType: string;
  folder: string;
  fileName?: string;
}): Promise<string | null> {
  const asset = await postWorkflowAsset({
    base64: params.base64,
    mimeType: params.mimeType,
    folder: params.folder,
    fileName: params.fileName || "generated-image",
  });
  return asset?.url || null;
}

export async function cacheRemoteMediaToCloud(params: {
  sourceUrl: string;
  folder: string;
  fileName?: string;
  mimeType?: string;
}): Promise<{ url: string; size: number; mimeType: string } | null> {
  const asset = await postWorkflowAsset({
    sourceUrl: params.sourceUrl,
    mimeType: params.mimeType,
    folder: params.folder,
    fileName: params.fileName || "generated-media",
  });
  if (!asset?.url) return null;
  return {
    url: asset.url,
    size: Number(asset.size || 0),
    mimeType: asset.mimeType || params.mimeType || "application/octet-stream",
  };
}

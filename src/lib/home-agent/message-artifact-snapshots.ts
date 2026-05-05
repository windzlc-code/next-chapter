import type { ConversationArtifact, ConversationProjectSnapshot } from "./types";

function deepClone<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }

  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

export function cloneConversationArtifact(
  artifact: ConversationProjectSnapshot["artifacts"][number],
): ConversationArtifact {
  return {
    ...artifact,
    ...(artifact.actions ? { actions: deepClone(artifact.actions) } : {}),
    ...(artifact.editor ? { editor: deepClone(artifact.editor) } : {}),
    ...(artifact.payload ? { payload: deepClone(artifact.payload) } : {}),
  };
}

export function resolveArtifactSnapshots(
  snapshot: ConversationProjectSnapshot | null | undefined,
  artifactIds: string[] | undefined,
): ConversationArtifact[] {
  if (!snapshot?.artifacts?.length || !artifactIds?.length) {
    return [];
  }

  const artifactMap = new Map(snapshot.artifacts.map((artifact) => [artifact.id, artifact]));
  return [...new Set(artifactIds)]
    .map((artifactId) => artifactMap.get(artifactId))
    .filter((artifact): artifact is ConversationProjectSnapshot["artifacts"][number] => Boolean(artifact))
    .map(cloneConversationArtifact);
}

export function normalizeArtifactSnapshots(value: unknown): ConversationArtifact[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const normalized = value
    .filter((entry): entry is ConversationArtifact => {
      if (!entry || typeof entry !== "object") return false;
      const artifact = entry as Partial<ConversationArtifact>;
      return (
        typeof artifact.id === "string" &&
        typeof artifact.kind === "string" &&
        typeof artifact.label === "string" &&
        typeof artifact.summary === "string" &&
        typeof artifact.updatedAt === "string"
      );
    })
    .map(cloneConversationArtifact);

  return normalized.length ? normalized : undefined;
}

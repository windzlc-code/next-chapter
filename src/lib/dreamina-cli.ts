type DreaminaCliStatus = "processing" | "succeeded" | "failed";

type DreaminaCliActionResult = {
  ok: boolean;
  installed: boolean;
  loggedIn?: boolean;
  message: string;
  path?: string;
};

const DREAMINA_CLI_REMOVED_MESSAGE =
  "Dreamina CLI bridge has been removed. Please use the Jimeng / Seedance API path instead.";

export async function isDreaminaCliAvailable(): Promise<boolean> {
  return false;
}

export async function dreaminaCliGetStatus(): Promise<DreaminaCliActionResult> {
  return {
    ok: false,
    installed: false,
    loggedIn: false,
    message: DREAMINA_CLI_REMOVED_MESSAGE,
  };
}

export async function dreaminaCliLogin(): Promise<DreaminaCliActionResult> {
  return {
    ok: false,
    installed: false,
    message: DREAMINA_CLI_REMOVED_MESSAGE,
  };
}

export async function dreaminaCliRelogin(): Promise<DreaminaCliActionResult> {
  return {
    ok: false,
    installed: false,
    message: DREAMINA_CLI_REMOVED_MESSAGE,
  };
}

export async function dreaminaCliGenerateVideo(_params: {
  prompt: string;
  imageUrl?: string;
  duration?: number;
  aspectRatio?: string;
}): Promise<{ task_id: string; status: string; provider: "dreamina-cli" }> {
  throw new Error(DREAMINA_CLI_REMOVED_MESSAGE);
}

export async function dreaminaCliQueryResult(_taskId: string): Promise<{
  status: DreaminaCliStatus;
  video_url?: string;
  state?: string;
  raw?: unknown;
}> {
  throw new Error(DREAMINA_CLI_REMOVED_MESSAGE);
}

export async function dreaminaCliCancelVideo(_taskId: string): Promise<{
  task_id: string;
  status: "cancelled";
  provider: "dreamina-cli";
}> {
  throw new Error(DREAMINA_CLI_REMOVED_MESSAGE);
}

export function getDreaminaCliModelCatalog(): Array<{
  id: string;
  label: string;
  provider: "dreamina-cli";
}> {
  return [];
}

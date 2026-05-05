export function parseSignedUrlDate(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
}

export function getSignedUrlExpiryTime(url: string | undefined): number | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const signedAt = parseSignedUrlDate(
      parsed.searchParams.get("X-Tos-Date") ?? parsed.searchParams.get("X-Amz-Date"),
    );
    const expires = Number(
      parsed.searchParams.get("X-Tos-Expires") ?? parsed.searchParams.get("X-Amz-Expires"),
    );
    if (!signedAt || !Number.isFinite(expires)) return null;
    return signedAt + expires * 1000;
  } catch {
    return null;
  }
}

export function isRemoteHttpUrl(url: string | undefined): boolean {
  return Boolean(url && (url.startsWith("http://") || url.startsWith("https://")));
}

export function isExpiredSignedMediaUrl(
  url: string | undefined,
  now: number = Date.now(),
): boolean {
  const expiresAt = getSignedUrlExpiryTime(url);
  return expiresAt !== null && now >= expiresAt;
}

export function isExpiredRemoteSignedMediaUrl(
  url: string | undefined,
  now: number = Date.now(),
): boolean {
  return isRemoteHttpUrl(url) && isExpiredSignedMediaUrl(url, now);
}

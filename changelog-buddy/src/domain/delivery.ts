export type DigestSourceHealth = {
  lastSuccessAt: number | null;
  consecutiveFailures: number;
};

export function shouldSendDigest(
  changeCount: number,
  sourceHealth: DigestSourceHealth[],
): boolean {
  if (changeCount > 0) return true;
  if (sourceHealth.length === 0) return true;
  return sourceHealth.some(
    (source) => source.lastSuccessAt === null || source.consecutiveFailures > 0,
  );
}

import type { Env } from "../env";

function setting(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(
      `Invalid Slack Buddy sync setting: expected 1–${maximum}, got ${value}`,
    );
  }
  return parsed;
}

export function syncSettings(env: Env) {
  return {
    // At most 20 phases * 50 joins * 3 transport attempts * 2 step attempts
    // = 6,000 external requests, below the Paid default of 10,000.
    phasesPerJob: setting(env.SLACK_BUDDY_JOB_PHASES, 10, 20),
    directoryTtlMs:
      setting(env.SLACK_BUDDY_DIRECTORY_REFRESH_HOURS, 24, 168) * 3_600_000,
    fullScanIntervalMs:
      setting(env.SLACK_BUDDY_FULL_SCAN_DAYS, 7, 30) * 86_400_000,
    lookbackMs: setting(env.SLACK_BUDDY_RECONCILE_HOURS, 48, 720) * 3_600_000,
  };
}

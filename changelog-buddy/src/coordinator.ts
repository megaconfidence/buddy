import { safeId } from "./domain/hash";
import {
  digestWindowForDeliveryDate,
  scanBucket,
  targetDigestDate,
} from "./domain/time";
import type { DigestWorkflowParams, ScanWorkflowParams } from "./domain/types";
import type { Env } from "./env";
import { SOURCES } from "./sources/registry";
import {
  ChangelogRepository,
  type PendingDigestRun,
} from "./storage/repository";

type DigestAction =
  | "before_delivery_time"
  | "waiting_for_baseline"
  | "completed"
  | "created"
  | "running"
  | "restarted";

export async function coordinate(
  env: Env,
  scheduledAt = Date.now(),
): Promise<{
  scansRequested: number;
  digest: DigestAction;
}> {
  const repository = new ChangelogRepository(env.DB);
  await repository.syncSources(SOURCES);
  const dueSourceIds = await repository.dueSourceIds(scheduledAt);
  const scanRequests = dueSourceIds.map((sourceId) => ({
    id: safeId(`scan-${sourceId}-${scanBucket(scheduledAt)}`),
    params: {
      sourceId,
      scheduledAt,
    } satisfies ScanWorkflowParams,
    retention: {
      successRetention: "1 day" as const,
      errorRetention: "3 days" as const,
    },
  }));
  for (const chunk of chunks(scanRequests, 100)) {
    try {
      const instances = await env.SCAN_WORKFLOW.createBatch(chunk);
      for (const instance of instances) disposeRpc(instance);
    } catch {
      // A retry can encounter deterministic IDs created by the first attempt.
    }
  }

  const targetDate = targetDigestDate(
    scheduledAt,
    env.BUDDY_TIMEZONE,
    Number(env.BUDDY_DIGEST_HOUR),
  );
  let currentDigestId: string | null = null;
  let defaultAction: DigestAction = "before_delivery_time";
  if (targetDate) {
    if (await repository.hasBaselinedSource()) {
      const window = digestWindowForDeliveryDate(
        targetDate,
        env.BUDDY_TIMEZONE,
        Number(env.BUDDY_DIGEST_HOUR),
      );
      currentDigestId = safeId(`digest-${targetDate}`);
      await repository.createDigestRun({ id: currentDigestId, window });
      const current = await repository.digestRun(currentDigestId);
      if (current?.status === "completed") defaultAction = "completed";
    } else {
      defaultAction = "waiting_for_baseline";
    }
  }

  const incomplete = await repository.incompleteDigestRuns();
  let recoveredAction: DigestAction | null = null;
  for (const run of incomplete) {
    const action = await ensureDigestWorkflow(env, run);
    if (run.id === currentDigestId) {
      defaultAction = action;
    } else if (action === "restarted" || action === "created") {
      recoveredAction = action;
    }
  }

  return {
    scansRequested: scanRequests.length,
    digest: recoveredAction ?? defaultAction,
  };
}

async function ensureDigestWorkflow(
  env: Env,
  run: PendingDigestRun,
): Promise<"created" | "running" | "restarted"> {
  const params: DigestWorkflowParams = {
    digestId: run.id,
    window: run.window,
  };
  let instance: WorkflowInstance | undefined;
  try {
    const created = await env.DIGEST_WORKFLOW.createBatch([
      {
        id: run.id,
        params,
        retention: {
          successRetention: "1 day",
          errorRetention: "3 days",
        },
      },
    ]);
    instance = created[0];
  } catch {
    // Existing IDs can throw on older Workflow runtimes.
  }
  if (instance) {
    disposeRpc(instance);
    return "created";
  }

  instance = await env.DIGEST_WORKFLOW.get(run.id);
  try {
    const status = await instance.status();
    if (
      status.status === "errored" ||
      status.status === "terminated" ||
      status.status === "complete"
    ) {
      await instance.restart(
        run.hasRenderedEmail
          ? { from: { name: "send email with Resend", type: "do" } }
          : undefined,
      );
      return "restarted";
    }
    return "running";
  } finally {
    disposeRpc(instance);
  }
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function disposeRpc(value: unknown): void {
  const disposable = value as { [Symbol.dispose]?: () => void };
  disposable[Symbol.dispose]?.();
}

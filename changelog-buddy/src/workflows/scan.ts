import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { ScanWorkflowParams, SourceState } from "../domain/types";
import type { Env } from "../env";
import { collectSource } from "../sources";
import { sourceById } from "../sources/registry";
import { ChangelogRepository } from "../storage/repository";

const RETRY = {
  retries: {
    limit: 5,
    delay: "15 seconds" as const,
    backoff: "exponential" as const,
  },
  timeout: "10 minutes" as const,
};

export class SourceScanWorkflow extends WorkflowEntrypoint<
  Env,
  ScanWorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<ScanWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<string> {
    const source = sourceById(event.payload.sourceId);
    const repository = new ChangelogRepository(this.env.DB);

    try {
      const serializedState = await step.do<string>(
        "load source state",
        RETRY,
        async () => JSON.stringify(await repository.sourceState(source.id)),
      );
      const state = JSON.parse(serializedState) as SourceState;
      const serializedCollection = await step.do<string>(
        "collect source",
        RETRY,
        async () => {
          const collection = await collectSource(this.env, source, state);
          if (collection.snapshot) {
            const latestKey = `sources/${source.id}/latest`;
            await this.env.SNAPSHOTS.put(latestKey, collection.snapshot.body, {
              httpMetadata: {
                contentType: collection.snapshot.contentType,
              },
            });
          }
          return JSON.stringify({
            ...collection,
            snapshot: collection.snapshot
              ? {
                  body: "",
                  contentType: collection.snapshot.contentType,
                }
              : undefined,
          });
        },
      );
      const collection = JSON.parse(serializedCollection) as Awaited<
        ReturnType<typeof collectSource>
      >;

      const serializedChanges = await step.do<string>(
        "persist collected items",
        RETRY,
        async () =>
          JSON.stringify(
            await repository.applyCollection(source, state, collection),
          ),
      );
      const changes = JSON.parse(serializedChanges) as {
        created: number;
        updated: number;
      };
      return JSON.stringify({
        sourceId: source.id,
        notModified: collection.notModified,
        ...changes,
      });
    } catch (error) {
      await step.do("record source failure", RETRY, async () => {
        await repository.markSourceFailure(source.id, errorMessage(error));
        return "recorded";
      });
      throw error;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

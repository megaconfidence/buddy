import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { createEditorialDigest, PROMPT_VERSION } from "../ai/editorial";
import { clusterChanges } from "../domain/deduplicate";
import type {
  ChangeEvent,
  DigestWorkflowParams,
  EditorialDigest,
  PreferenceProfile,
} from "../domain/types";
import { renderDigestEmail, type RenderedEmail } from "../email/render";
import { ResendPermanentError, sendDigestEmail } from "../email/resend";
import type { Env } from "../env";
import { ChangelogRepository } from "../storage/repository";

const RETRY = {
  retries: {
    limit: 5,
    delay: "20 seconds" as const,
    backoff: "exponential" as const,
  },
  timeout: "10 minutes" as const,
};

export class DigestWorkflow extends WorkflowEntrypoint<
  Env,
  DigestWorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<DigestWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<string> {
    const input = event.payload;
    const repository = new ChangelogRepository(this.env.DB);

    try {
      await step.do("mark digest running", RETRY, async () => {
        await repository.markDigestRunning(input.digestId);
        return "ok";
      });

      const serializedEvents = await step.do<string>(
        "load change events",
        RETRY,
        async () =>
          JSON.stringify(
            await repository.changesForWindow(
              input.window.startMs,
              input.window.endMs,
            ),
          ),
      );
      const sourceEvents = JSON.parse(serializedEvents) as ChangeEvent[];
      const serializedHealth = await step.do<string>(
        "load source health",
        RETRY,
        async () => JSON.stringify(await repository.sourceHealth()),
      );
      const sourceHealth = JSON.parse(serializedHealth) as Awaited<
        ReturnType<ChangelogRepository["sourceHealth"]>
      >;
      const serializedProfile = await step.do<string>(
        "load editorial preferences",
        RETRY,
        async () => JSON.stringify(await repository.preferenceProfile()),
      );
      const profile = JSON.parse(serializedProfile) as PreferenceProfile;
      const clusters = clusterChanges(sourceEvents);
      const serializedDigest = await step.do<string>(
        "create editorial digest",
        RETRY,
        async () =>
          JSON.stringify(
            await createEditorialDigest(this.env, clusters, profile),
          ),
      );
      const digest = JSON.parse(serializedDigest) as EditorialDigest;
      const serializedEmail = await step.do<string>(
        "render email",
        RETRY,
        async () =>
          JSON.stringify(
            await renderDigestEmail({
              digestId: input.digestId,
              digest,
              events: sourceEvents,
              window: input.window,
              sourceHealth,
              publicBaseUrl: this.env.PUBLIC_BASE_URL,
              feedbackSecret: this.env.FEEDBACK_SECRET,
            }),
          ),
      );
      const rendered = JSON.parse(serializedEmail) as RenderedEmail;

      await step.do("save digest", RETRY, async () => {
        await repository.saveDigest({
          digestId: input.digestId,
          model:
            digest.items.length > 0
              ? `${this.env.MISTRAL_MODEL}:${PROMPT_VERSION}`
              : "not-used",
          subject: rendered.subject,
          digest,
          html: rendered.html,
          text: rendered.text,
        });
        return "ok";
      });

      const providerMessageId = await step.do(
        "send email with Resend",
        RETRY,
        async () => {
          try {
            return await sendDigestEmail(this.env, input.digestId, rendered);
          } catch (error) {
            if (error instanceof ResendPermanentError) {
              throw new NonRetryableError(
                error.message,
                error.code ?? "ResendPermanentError",
              );
            }
            throw error;
          }
        },
      );

      await step.do("mark digest complete", RETRY, async () => {
        await repository.markDigestDelivered(
          input.digestId,
          providerMessageId,
          rendered.eventIds,
          sourceEvents.map((sourceEvent) => sourceEvent.id),
        );
        await repository.deleteExpiredChanges(
          Date.now() - Number(this.env.CHANGE_RETENTION_DAYS) * 86_400_000,
        );
        return "ok";
      });

      return JSON.stringify({
        digestId: input.digestId,
        providerMessageId,
        itemCount: digest.items.length,
      });
    } catch (error) {
      await step.do("record digest failure", RETRY, async () => {
        await repository.markDigestFailed(input.digestId, errorMessage(error));
        return "recorded";
      });
      throw error;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

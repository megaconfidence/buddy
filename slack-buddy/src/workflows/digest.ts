import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { SlackJobParams } from "../domain/jobs";
import type { Env } from "../env";
import { runSlackJob } from "./jobs";

export class SlackBuddyDigestWorkflow extends WorkflowEntrypoint<
  Env,
  SlackJobParams
> {
  async run(
    event: Readonly<WorkflowEvent<SlackJobParams>>,
    step: WorkflowStep,
  ) {
    return runSlackJob(this.env, event.payload, event.instanceId, step);
  }
}

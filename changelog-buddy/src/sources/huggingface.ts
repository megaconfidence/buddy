import { sha256, stableJson } from "../domain/hash";
import type {
  CollectedItem,
  CollectionResult,
  SourceDefinition,
  SourceState,
} from "../domain/types";
import type { Env } from "../env";
import { fetchSource } from "./http";
import { cleanText, parseDate } from "./text";

type HuggingFaceModel = {
  id?: string;
  modelId?: string;
  createdAt?: string;
  lastModified?: string;
  sha?: string;
  tags?: string[];
  pipeline_tag?: string;
  library_name?: string;
  private?: boolean;
  gated?: boolean | string;
  cardData?: {
    license?: string;
    language?: string | string[];
    base_model?: string | string[];
  };
};

export async function collectHuggingFaceModels(
  env: Env,
  source: SourceDefinition,
  state: SourceState,
): Promise<CollectionResult> {
  const response = await fetchSource(env, source.url, state, {
    accept: "application/json",
    maxBytes: 5_000_000,
  });
  if (response.notModified) {
    return {
      notModified: true,
      items: [],
      etag: response.etag ?? state.etag,
      lastModified: response.lastModified ?? state.lastModified,
      cursor: state.cursor,
    };
  }

  const models = JSON.parse(response.body) as HuggingFaceModel[];
  const resolved = await Promise.all(
    models.flatMap((model) => {
      const id = model.id ?? model.modelId;
      if (!id || model.private) return [];
      return [toCollectedModel(source.id, id, model)];
    }),
  );
  const newest = resolved
    .map((item) => item.updatedAt ?? item.publishedAt ?? 0)
    .sort((left, right) => right - left)[0];

  return {
    notModified: false,
    items: resolved,
    etag: response.etag,
    lastModified: response.lastModified,
    cursor: newest ? new Date(newest).toISOString() : state.cursor,
  };
}

async function toCollectedModel(
  sourceId: string,
  id: string,
  model: HuggingFaceModel,
): Promise<CollectedItem> {
  const metadata = {
    modelId: id,
    pipelineTag: model.pipeline_tag ?? null,
    library: model.library_name ?? null,
    license: model.cardData?.license ?? null,
    language: model.cardData?.language ?? null,
    baseModel: model.cardData?.base_model ?? null,
    gated: model.gated ?? false,
    tags: (model.tags ?? [])
      .filter(
        (tag) =>
          tag.startsWith("license:") ||
          tag.startsWith("base_model:") ||
          tag.startsWith("pipeline_tag:") ||
          tag === "transformers" ||
          tag === "safetensors",
      )
      .sort(),
  };
  return {
    sourceId,
    externalId: id,
    canonicalUrl: `https://huggingface.co/${id}`,
    title: id.replace(/^mistralai\//u, ""),
    publishedAt: parseDate(model.createdAt),
    updatedAt: parseDate(model.lastModified),
    content: cleanText(
      `${id} is available on Hugging Face. Pipeline: ${
        model.pipeline_tag ?? "unspecified"
      }. License: ${model.cardData?.license ?? "unspecified"}.`,
    ),
    contentHash: await sha256(stableJson(metadata)),
    artifactKey: `model:${id}`,
    metadata,
  };
}

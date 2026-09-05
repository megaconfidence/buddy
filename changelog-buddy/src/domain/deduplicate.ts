import { normalizedTitle, safeId } from "./hash";
import type { ChangeCluster, ChangeEvent } from "./types";

export function clusterChanges(events: ChangeEvent[]): ChangeCluster[] {
  const groups = new Map<string, ChangeEvent[]>();

  for (const event of events) {
    const key =
      event.artifactKey ??
      `title:${normalizedTitle(event.title).split(" ").slice(0, 12).join(" ")}`;
    const existing = groups.get(key) ?? [];
    existing.push(event);
    groups.set(key, existing);
  }

  return [...groups.entries()]
    .map(([key, grouped]) => {
      const events = [...grouped].sort(
        (left, right) =>
          right.sourceAuthority - left.sourceAuthority ||
          right.detectedAt - left.detectedAt,
      );
      const primary = events[0];
      if (!primary) throw new Error("Cannot create an empty change cluster");
      return {
        id: safeId(`cluster-${key}`, 180),
        title: primary.title,
        artifactKey: primary.artifactKey,
        events,
      };
    })
    .sort((left, right) => {
      const leftEvent = left.events[0];
      const rightEvent = right.events[0];
      return (
        (rightEvent?.sourceAuthority ?? 0) -
          (leftEvent?.sourceAuthority ?? 0) ||
        (rightEvent?.detectedAt ?? 0) - (leftEvent?.detectedAt ?? 0)
      );
    });
}

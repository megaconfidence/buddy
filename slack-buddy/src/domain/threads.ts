import type { SlackMessage, SlackThread } from "./types";

export type MessageWithDisplay = SlackMessage & {
  channelName: string | null;
  userName: string | null;
  isBot: boolean;
};

export type CandidateThread = {
  thread: SlackThread;
  mustShow: boolean;
  heuristicScore: number;
};

const LOW_SIGNAL_ONLY =
  /^(?:thanks|thank you|thx|ty|great|nice|cool|ok(?:ay)?|done|sgtm|lgtm|\+1|👍|🙏|🎉|❤️|ack)[.! ]*$/iu;

const HIGH_SIGNAL =
  /\b(?:breaking|deprecated?|deprecation|incident|outage|launch|release|deadline|blocked?|regression|bug|docs?|documentation|sdk|api|developer|customer|community|event|workshop|conference|tutorial|demo|migration|feedback|confus(?:ed|ing|ion)|error|failing|failure)\b/giu;

export function groupMessagesIntoThreads(
  messages: MessageWithDisplay[],
): SlackThread[] {
  const grouped = new Map<string, SlackThread>();

  for (const message of [...messages].sort(
    (left, right) => left.postedAt - right.postedAt,
  )) {
    if (message.deletedAt !== null) continue;
    const text = message.text.trim();
    if (!text) continue;

    const id = `${message.teamId}:${message.channelId}:${message.threadTs}`;
    const thread = grouped.get(id) ?? {
      id,
      teamId: message.teamId,
      channelId: message.channelId,
      channelName: message.channelName,
      threadTs: message.threadTs,
      startedAt: message.postedAt,
      latestAt: message.postedAt,
      messages: [],
    };

    thread.startedAt = Math.min(thread.startedAt, message.postedAt);
    thread.latestAt = Math.max(thread.latestAt, message.postedAt);
    thread.messages.push({
      messageTs: message.messageTs,
      userId: message.userId,
      userName: message.userName,
      text,
      postedAt: message.postedAt,
    });
    grouped.set(id, thread);
  }

  return [...grouped.values()].sort(
    (left, right) => right.latestAt - left.latestAt,
  );
}

export function scoreCandidateThreads(
  threads: SlackThread[],
  slackUserId: string,
): CandidateThread[] {
  return threads
    .map((thread) => {
      const combined = thread.messages
        .map((message) => message.text)
        .join("\n");
      const directMention = combined.includes(`<@${slackUserId}>`);
      const highSignalMatches = combined.match(HIGH_SIGNAL)?.length ?? 0;
      const multiParticipant =
        new Set(
          thread.messages
            .map((message) => message.userId)
            .filter((userId): userId is string => Boolean(userId)),
        ).size > 1;
      const lowSignal =
        thread.messages.length === 1 && LOW_SIGNAL_ONLY.test(combined);

      let heuristicScore = 0;
      if (directMention) heuristicScore += 100;
      heuristicScore += Math.min(highSignalMatches * 8, 48);
      if (thread.messages.length > 1) heuristicScore += 8;
      if (multiParticipant) heuristicScore += 8;
      if (lowSignal) heuristicScore -= 100;

      return {
        thread,
        mustShow: directMention,
        heuristicScore,
      };
    })
    .filter((candidate) => candidate.mustShow || candidate.heuristicScore > -50)
    .sort((left, right) => {
      if (left.mustShow !== right.mustShow) return left.mustShow ? -1 : 1;
      return right.heuristicScore - left.heuristicScore;
    });
}

export function batchCandidateThreads(
  candidates: CandidateThread[],
  maxCharacters = 80_000,
): CandidateThread[][] {
  const batches: CandidateThread[][] = [];
  let current: CandidateThread[] = [];
  let currentSize = 0;

  for (const candidate of candidates) {
    const size = candidate.thread.messages.reduce(
      (total, message) => total + message.text.length + 100,
      0,
    );

    if (current.length > 0 && currentSize + size > maxCharacters) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }

    current.push(candidate);
    currentSize += size;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

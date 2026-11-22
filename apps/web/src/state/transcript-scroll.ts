export const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 96;

export interface TranscriptScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export function isTranscriptNearBottom(
  metrics: TranscriptScrollMetrics,
  thresholdPx = TRANSCRIPT_BOTTOM_THRESHOLD_PX,
): boolean {
  const distanceFromBottom =
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return distanceFromBottom <= thresholdPx;
}

export interface AutoScrollDecisionInput {
  readonly roomChanged: boolean;
  readonly previousLastMsgId: string | null;
  readonly nextLastMsgId: string | null;
  readonly wasNearBottom: boolean;
  readonly latestMessageIsSelf: boolean;
}

/**
 * Decides whether the transcript container should scroll to the latest message.
 * Preserves manual upward scroll when reading older history unless the user
 * switched rooms, received the initial batch, or sent a message themselves.
 */
export function shouldAutoScrollTranscript(
  input: AutoScrollDecisionInput,
): boolean {
  if (input.nextLastMsgId === null) {
    return false;
  }
  if (input.roomChanged) {
    return true;
  }
  if (input.previousLastMsgId === null) {
    return true;
  }
  if (input.nextLastMsgId !== input.previousLastMsgId) {
    return input.wasNearBottom || input.latestMessageIsSelf;
  }
  return false;
}

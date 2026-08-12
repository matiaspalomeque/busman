import type { PeekedMessage } from "../types";
import { isDeadLetterMessage } from "../utils/messageOperation";
import { compareSequenceNumbers, isCanonicalSequenceNumber } from "../utils/sequenceNumber";

export function computeMaxSeqNums(messages: PeekedMessage[]): { normal: string | null; dlq: string | null } {
  let normal: string | null = null;
  let dlq: string | null = null;
  for (const msg of messages) {
    const sequenceNumber = msg.sequenceNumber;
    if (!isCanonicalSequenceNumber(sequenceNumber)) continue;
    if (isDeadLetterMessage(msg)) {
      if (dlq === null || compareSequenceNumbers(sequenceNumber, dlq) > 0) dlq = sequenceNumber;
    } else {
      if (normal === null || compareSequenceNumbers(sequenceNumber, normal) > 0) normal = sequenceNumber;
    }
  }
  return { normal, dlq };
}

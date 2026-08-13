import { randomUUID } from 'node:crypto';

export const newReviewId = (): string => `rev_${randomUUID()}`;
export const newFindingId = (): string => `finding_${randomUUID()}`;
export const newEventId = (): string => `evt_${randomUUID()}`;

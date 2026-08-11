import { z } from 'zod';
import { isSafeEntityId } from '../entity-id.js';

export const EntityIdSchema = z.string().refine(isSafeEntityId, {
  message: 'must be a portable single-segment entity id',
});
export type EntityId = z.infer<typeof EntityIdSchema>;

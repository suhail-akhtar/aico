/**
 * What the Delivery board knows about its project's connection, handed down to the
 * cards and the drawer without threading a prop through each.
 *
 * WHY a context and not props: the review card needs to know whether landing means
 * "Approve and land" or "Open pull request", the drawer needs the trunk's name for the
 * merge confirmation, and the queue needs the batch wording. Three components, one
 * fact, set once by the board. Props would touch every signature the Scrum work is
 * also editing; a context does not.
 *
 * The default (no provider) is a board with no connection, which reads exactly as
 * Delivery did before ADR 0039: local landing.
 *
 * @module web/components/connections/context
 */

import { createContext, useContext } from 'react';
import type { BoardConnection } from '../../../../shared/connections/types';

export interface BoardConnectionValue {
  /** The project's connection, when it has one (the board carries it). */
  connection?: BoardConnection | undefined;
  /** The branch work lands on, for the merge confirmation. */
  trunk: string;
}

export const BoardConnectionContext = createContext<BoardConnectionValue>({ trunk: 'main' });

export const useBoardConnection = (): BoardConnectionValue => useContext(BoardConnectionContext);

export const COLUMNS = ["backlog", "ready", "doing", "done"] as const;
export const COMPLETED_COLUMN = "completed" as const;

export type BoardColumnId = (typeof COLUMNS)[number];
export type ColumnId = BoardColumnId | typeof COMPLETED_COLUMN;

export interface KanbanCard {
  id: string;
  version: number;
  title: string;
  description: string;
  tags: string[];
  column: ColumnId;
  completedFrom?: BoardColumnId;
  createdAt: string;
  updatedAt: string;
}

export interface BoardData {
  revision: number;
  cards: KanbanCard[];
}

export interface CardFields {
  title: string;
  description: string;
  tags: string[];
  column: ColumnId;
}

interface OperationBase {
  operationId: string;
}

export type BoardOperation =
  | (OperationBase & {
      type: "create-card";
      cardId: string;
      fields: CardFields;
    })
  | (OperationBase & {
      type: "update-card";
      cardId: string;
      expectedVersion: number;
      fields: CardFields;
    })
  | (OperationBase & {
      type: "delete-card";
      cardId: string;
      expectedVersion: number;
    })
  | (OperationBase & {
      type: "move-card";
      cardId: string;
      column: ColumnId;
    })
  | (OperationBase & {
      type: "set-card-completed";
      cardId: string;
      completed: boolean;
    });

export interface BoardUpdatedEvent {
  type: "board-updated";
  operationId?: string;
  board: BoardData;
}

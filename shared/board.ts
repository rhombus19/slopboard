export const COLUMNS = ["backlog", "ready", "doing", "done"] as const;
export const COMPLETED_COLUMN = "completed" as const;

export type BoardColumnId = (typeof COLUMNS)[number];
export type ColumnId = BoardColumnId | typeof COMPLETED_COLUMN;

export interface KanbanCard {
  id: string;
  title: string;
  description: string;
  tags: string[];
  column: ColumnId;
  completedFrom?: BoardColumnId;
  createdAt: string;
  updatedAt: string;
}

export interface BoardData {
  cards: KanbanCard[];
}

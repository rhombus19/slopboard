export const COLUMNS = ["backlog", "doing", "done"] as const;

export type ColumnId = (typeof COLUMNS)[number];

export interface KanbanCard {
  id: string;
  title: string;
  description: string;
  tags: string[];
  column: ColumnId;
  createdAt: string;
  updatedAt: string;
}

export interface BoardData {
  cards: KanbanCard[];
}

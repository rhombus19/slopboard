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

export function placeCardInColumn(
  cards: readonly KanbanCard[],
  placedCard: KanbanCard,
  beforeCardId: string | null,
): KanbanCard[] | null {
  if (beforeCardId === placedCard.id) return null;

  const remainingCards = cards.filter((card) => card.id !== placedCard.id);
  let insertionIndex = remainingCards.length;

  if (beforeCardId) {
    insertionIndex = remainingCards.findIndex(
      (card) => card.id === beforeCardId && card.column === placedCard.column,
    );
    if (insertionIndex === -1) return null;
  } else {
    let lastColumnCardIndex = -1;
    for (let index = remainingCards.length - 1; index >= 0; index -= 1) {
      if (remainingCards[index].column === placedCard.column) {
        lastColumnCardIndex = index;
        break;
      }
    }
    if (lastColumnCardIndex !== -1) insertionIndex = lastColumnCardIndex + 1;
  }

  return [
    ...remainingCards.slice(0, insertionIndex),
    placedCard,
    ...remainingCards.slice(insertionIndex),
  ];
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
      type: "reorder-card";
      cardId: string;
      column: ColumnId;
      beforeCardId: string | null;
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

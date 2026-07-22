import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  CheckIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  CloudCheckIcon,
  CloudOffIcon,
  GripVerticalIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  PlusIcon,
  RotateCcwIcon,
} from "lucide-react";

import {
  COLUMNS,
  COMPLETED_COLUMN,
  type BoardColumnId,
  type BoardData,
  type BoardOperation,
  type BoardUpdatedEvent,
  type CardFields,
  type ColumnId,
  type KanbanCard,
} from "../shared/board";
import { CardEditor, type EditorState } from "./components/card-editor";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { cn, tagColorStyle } from "./lib/utils";

const BOARD_API_URL = new URL("api/board", window.location.href);
const BOARD_EVENTS_URL = new URL("api/board/events", window.location.href);
BOARD_EVENTS_URL.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

type SaveStatus = "idle" | "saving" | "saved" | "error";
type LiveStatus = "connecting" | "connected" | "disconnected";

interface SubmitOperationOptions {
  optimisticUpdate: (board: BoardData) => BoardData;
  onConflict?: (board: BoardData) => void;
  onFailure?: () => void;
}

class BoardOperationError extends Error {
  readonly latestBoard?: BoardData;
  readonly conflict: boolean;

  constructor(message: string, conflict: boolean, latestBoard?: BoardData) {
    super(message);
    this.name = "BoardOperationError";
    this.conflict = conflict;
    this.latestBoard = latestBoard;
  }
}

const ALL_COLUMNS = new Set<unknown>([...COLUMNS, COMPLETED_COLUMN]);
const BOARD_COLUMN_IDS = new Set<unknown>(COLUMNS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isKanbanCard(value: unknown): value is KanbanCard {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.version === "number"
    && Number.isSafeInteger(value.version)
    && value.version > 0
    && typeof value.title === "string"
    && typeof value.description === "string"
    && Array.isArray(value.tags)
    && value.tags.every((tag) => typeof tag === "string")
    && ALL_COLUMNS.has(value.column)
    && (value.completedFrom === undefined || BOARD_COLUMN_IDS.has(value.completedFrom))
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string";
}

function isBoardData(value: unknown): value is BoardData {
  if (!isRecord(value)) return false;
  return typeof value.revision === "number"
    && Number.isSafeInteger(value.revision)
    && value.revision > 0
    && Array.isArray(value.cards)
    && value.cards.every(isKanbanCard);
}

function isBoardUpdatedEvent(value: unknown): value is BoardUpdatedEvent {
  return isRecord(value) && value.type === "board-updated" && isBoardData(value.board);
}

function cardFields(card: KanbanCard): CardFields {
  return {
    title: card.title,
    description: card.description,
    tags: card.tags,
    column: card.column,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function postOperation(operation: BoardOperation): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(BOARD_API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(operation),
      });

      if (response.status < 500 || attempt === 2) return response;
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw error;
    }

    await delay(200 * (2 ** attempt));
  }

  throw lastError instanceof Error ? lastError : new Error("Changes could not be saved.");
}

const COLUMN_META = {
  backlog: {
    label: "Backlog",
    helper: "Anything worth capturing",
    icon: CircleDashedIcon,
    dot: "bg-stone-400",
  },
  ready: {
    label: "Ready for sprint",
    helper: "Work we want to tackle next",
    icon: ListChecksIcon,
    dot: "bg-sky-500",
  },
  doing: {
    label: "Doing",
    helper: "In progress right now",
    icon: CircleDotDashedIcon,
    dot: "bg-amber-500",
  },
  done: {
    label: "Done",
    helper: "Finished in the current sprint",
    icon: CheckCircle2Icon,
    dot: "bg-emerald-500",
  },
} satisfies Record<BoardColumnId, { label: string; helper: string; icon: typeof CircleDashedIcon; dot: string }>;

function createCard(column: ColumnId): KanbanCard {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    version: 1,
    title: "",
    description: "",
    tags: [],
    column,
    createdAt: now,
    updatedAt: now,
  };
}

function moveCardToColumn(card: KanbanCard, column: ColumnId): KanbanCard {
  const updatedAt = new Date().toISOString();

  if (card.column === column) return card;

  if (column === COMPLETED_COLUMN) {
    return {
      ...card,
      version: card.version + 1,
      column,
      completedFrom: card.column === COMPLETED_COLUMN ? card.completedFrom ?? "done" : card.column,
      updatedAt,
    };
  }

  return { ...card, version: card.version + 1, column, completedFrom: undefined, updatedAt };
}

interface TaskCardProps {
  card: KanbanCard;
  onOpen: (card: KanbanCard) => void;
  onToggleCompleted: (cardId: string) => void;
  onDragStart: (event: DragEvent<HTMLElement>, cardId: string) => void;
  onDragEnd: () => void;
}

function TaskCard({ card, onOpen, onToggleCompleted, onDragStart, onDragEnd }: TaskCardProps) {
  const isCompleted = card.column === COMPLETED_COLUMN;

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(card);
    }
  }

  return (
    <article
      draggable
      className={cn(
        "group cursor-grab overflow-hidden rounded-xl border shadow-[0_1px_2px_rgba(28,25,23,0.04)] transition-[border-color,box-shadow,transform,opacity] hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(28,25,23,0.08)] active:cursor-grabbing data-[dragging=true]:opacity-50",
        isCompleted
          ? "border-stone-300/80 bg-stone-200/70 hover:border-stone-400"
          : "border-border/90 bg-card hover:border-stone-300",
      )}
      onDragStart={(event) => onDragStart(event, card.id)}
      onDragEnd={(event) => {
        delete event.currentTarget.dataset.dragging;
        onDragEnd();
      }}
    >
      <div className="flex items-start gap-3 p-4">
        <button
          type="button"
          role="checkbox"
          aria-checked={isCompleted}
          aria-label={isCompleted ? `Mark ${card.title} as active` : `Mark ${card.title} as completed`}
          className={cn(
            "mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border transition-[color,background-color,border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
            isCompleted
              ? "border-stone-500 bg-stone-500 text-white hover:border-stone-600 hover:bg-stone-600"
              : "border-stone-300 bg-white text-emerald-700 hover:border-emerald-500 hover:bg-emerald-50",
          )}
          onClick={() => onToggleCompleted(card.id)}
        >
          <CheckIcon className={cn("size-3.5 transition-opacity", isCompleted ? "opacity-100" : "opacity-0 group-hover:opacity-40")} />
        </button>

        <div
          role="button"
          tabIndex={0}
          aria-label={`Open ${card.title}`}
          className="min-w-0 flex-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          onClick={() => onOpen(card)}
          onKeyDown={handleKeyDown}
        >
          <div className="flex items-start gap-2">
            <h3
              className={cn(
                "min-w-0 flex-1 text-[15px] font-semibold leading-5 tracking-[-0.01em]",
                isCompleted ? "text-stone-500 line-through decoration-stone-400" : "text-card-foreground",
              )}
            >
              {card.title}
            </h3>
            <GripVerticalIcon
              className={cn(
                "-mr-1 mt-0.5 size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100",
                isCompleted ? "text-stone-400" : "text-stone-300",
              )}
            />
          </div>

          {card.description && (
            <p
              className={cn(
                "mt-2 line-clamp-3 whitespace-pre-line text-[13px] leading-5",
                isCompleted ? "text-stone-500" : "text-muted-foreground",
              )}
            >
              {card.description}
            </p>
          )}

          {card.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {card.tags.map((tag) => (
                <Badge
                  key={tag}
                  variant="outline"
                  className={isCompleted ? "opacity-65" : undefined}
                  style={tagColorStyle(tag)}
                >
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

export default function App() {
  const [board, setBoard] = useState<BoardData>({ revision: 0, cards: [] });
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("connecting");
  const [saveError, setSaveError] = useState("");
  const [dropTarget, setDropTarget] = useState<ColumnId | null>(null);
  const [completedExpanded, setCompletedExpanded] = useState(false);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingSaves = useRef(0);

  const acceptServerBoard = useCallback((nextBoard: BoardData) => {
    setBoard((current) => nextBoard.revision >= current.revision ? nextBoard : current);
  }, []);

  const loadBoard = useCallback(async () => {
    setLoading(true);
    setLoadError("");

    try {
      const response = await fetch(BOARD_API_URL, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("The board could not be loaded.");
      const data: unknown = await response.json();
      if (!isBoardData(data)) throw new Error("The server returned invalid board data.");
      acceptServerBoard(data);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "The board could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [acceptServerBoard]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let stopped = false;

    function connect() {
      if (stopped) return;
      setLiveStatus("connecting");
      socket = new WebSocket(BOARD_EVENTS_URL);

      socket.onopen = () => {
        reconnectAttempt = 0;
        setLiveStatus("connected");
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;

        try {
          const payload: unknown = JSON.parse(event.data);
          if (isBoardUpdatedEvent(payload)) acceptServerBoard(payload.board);
        } catch {
          // Ignore malformed messages and keep the last valid board.
        }
      };

      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (stopped) return;
        setLiveStatus("disconnected");
        const delayMs = Math.min(1_000 * (2 ** reconnectAttempt), 15_000);
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(connect, delayMs);
      };
    }

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close(1000, "Page closed.");
    };
  }, [acceptServerBoard]);

  const submitOperation = useCallback((operation: BoardOperation, options: SubmitOperationOptions) => {
    setBoard(options.optimisticUpdate);
    setSaveError("");
    setSaveStatus("saving");
    pendingSaves.current += 1;

    const operationRequest = saveQueue.current.then(async () => {
      const response = await postOperation(operation);
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const errorPayload = isRecord(payload) ? payload : null;
        const latestBoard = errorPayload && isBoardData(errorPayload.board) ? errorPayload.board : undefined;
        throw new BoardOperationError(
          errorPayload && typeof errorPayload.error === "string"
            ? errorPayload.error
            : "Changes could not be saved.",
          response.status === 409,
          latestBoard,
        );
      }

      if (!isBoardData(payload)) throw new Error("The server returned invalid board data.");
      acceptServerBoard(payload);
    });

    saveQueue.current = operationRequest.then(
      () => {
        pendingSaves.current -= 1;
        if (pendingSaves.current === 0) setSaveStatus("saved");
      },
      async (error: unknown) => {
        pendingSaves.current -= 1;
        setSaveStatus("error");
        setSaveError(error instanceof Error ? error.message : "Changes could not be saved.");

        if (error instanceof BoardOperationError && error.latestBoard) {
          acceptServerBoard(error.latestBoard);
        } else {
          try {
            const response = await fetch(BOARD_API_URL, { headers: { accept: "application/json" } });
            const latest: unknown = response.ok ? await response.json() : null;
            if (isBoardData(latest)) acceptServerBoard(latest);
          } catch {
            // Keep the optimistic state visible until the live connection recovers.
          }
        }

        if (error instanceof BoardOperationError && error.conflict && error.latestBoard) {
          options.onConflict?.(error.latestBoard);
        } else {
          options.onFailure?.();
        }
      },
    );
  }, [acceptServerBoard]);

  function openCreate(column: ColumnId) {
    setEditor({ mode: "create", card: createCard(column) });
  }

  function openEdit(card: KanbanCard) {
    setEditor({ mode: "edit", card: { ...card, tags: [...card.tags] } });
  }

  function saveCard(card: KanbanCard, mode: EditorState["mode"]) {
    const operation: BoardOperation = mode === "create"
      ? {
          type: "create-card",
          operationId: crypto.randomUUID(),
          cardId: card.id,
          fields: cardFields(card),
        }
      : {
          type: "update-card",
          operationId: crypto.randomUUID(),
          cardId: card.id,
          expectedVersion: card.version,
          fields: cardFields(card),
        };

    setEditor(null);
    submitOperation(operation, {
      optimisticUpdate: (currentBoard) => {
        const currentCard = currentBoard.cards.find((current) => current.id === card.id);
        const normalizedCard: KanbanCard = {
          ...card,
          version: mode === "create" ? 1 : card.version + 1,
          completedFrom: card.column === COMPLETED_COLUMN
            ? card.completedFrom
              ?? (currentCard && currentCard.column !== COMPLETED_COLUMN ? currentCard.column : "backlog")
            : undefined,
        };

        return {
          ...currentBoard,
          cards: mode === "create"
            ? currentBoard.cards.some((current) => current.id === card.id)
              ? currentBoard.cards
              : [...currentBoard.cards, normalizedCard]
            : currentBoard.cards.map((current) => current.id === card.id ? normalizedCard : current),
        };
      },
      onConflict: (latestBoard) => {
        const latestCard = latestBoard.cards.find((current) => current.id === card.id);
        setEditor(latestCard
          ? {
              mode: "edit",
              card: {
                ...card,
                version: latestCard.version,
                createdAt: latestCard.createdAt,
                updatedAt: latestCard.updatedAt,
              },
            }
          : { mode: "create", card: { ...card, id: crypto.randomUUID(), version: 1 } });
      },
      onFailure: () => setEditor({ mode, card }),
    });
  }

  function deleteCard(cardId: string) {
    const draft = editor?.card.id === cardId ? editor.card : board.cards.find((card) => card.id === cardId);
    if (!draft) return;

    setEditor(null);
    submitOperation({
      type: "delete-card",
      operationId: crypto.randomUUID(),
      cardId,
      expectedVersion: draft.version,
    }, {
      optimisticUpdate: (currentBoard) => ({
        ...currentBoard,
        cards: currentBoard.cards.filter((card) => card.id !== cardId),
      }),
    });
  }

  function toggleCardCompleted(cardId: string) {
    const card = board.cards.find((item) => item.id === cardId);
    if (!card) return;

    const completed = card.column !== COMPLETED_COLUMN;
    submitOperation({
      type: "set-card-completed",
      operationId: crypto.randomUUID(),
      cardId,
      completed,
    }, {
      optimisticUpdate: (currentBoard) => {
        const currentCard = currentBoard.cards.find((item) => item.id === cardId);
        if (!currentCard) return currentBoard;
        const target = completed ? COMPLETED_COLUMN : currentCard.completedFrom ?? "done";
        const updated = moveCardToColumn(currentCard, target);
        return {
          ...currentBoard,
          cards: currentBoard.cards.map((item) => item.id === cardId ? updated : item),
        };
      },
    });
  }

  function handleDragStart(event: DragEvent<HTMLElement>, cardId: string) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", cardId);
    event.currentTarget.dataset.dragging = "true";
  }

  function handleDragEnd() {
    setDropTarget(null);
  }

  function handleDrop(event: DragEvent<HTMLElement>, column: ColumnId) {
    event.preventDefault();
    const cardId = event.dataTransfer.getData("text/plain");
    const card = board.cards.find((item) => item.id === cardId);
    setDropTarget(null);

    if (!card || card.column === column) return;
    submitOperation({
      type: "move-card",
      operationId: crypto.randomUUID(),
      cardId,
      column,
    }, {
      optimisticUpdate: (currentBoard) => {
        const currentCard = currentBoard.cards.find((item) => item.id === cardId);
        if (!currentCard) return currentBoard;
        const updated = moveCardToColumn(currentCard, column);
        return {
          ...currentBoard,
          cards: currentBoard.cards.map((item) => item.id === cardId ? updated : item),
        };
      },
    });
  }

  const completedCards = board.cards.filter((card) => card.column === COMPLETED_COLUMN);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/80 bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex h-[72px] max-w-[1500px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <span className="grid grid-cols-2 gap-[3px]" aria-hidden="true">
                <span className="h-2.5 w-1 rounded-sm bg-current" />
                <span className="h-1.5 w-1 rounded-sm bg-current opacity-65" />
                <span className="h-1.5 w-1 rounded-sm bg-current opacity-65" />
                <span className="h-2.5 w-1 -translate-y-1 rounded-sm bg-current" />
              </span>
            </div>
            <div>
              <h1 className="text-base font-semibold leading-5 tracking-[-0.02em]">Slopboard</h1>
              <p className="text-xs text-muted-foreground">Shared workspace</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
              {saveStatus === "saving" && <LoaderCircleIcon className="size-3.5 animate-spin" />}
              {saveStatus === "error" && <CloudOffIcon className="size-3.5 text-destructive" />}
              {saveStatus !== "saving" && saveStatus !== "error" && liveStatus === "connected" && (
                <CloudCheckIcon className="size-3.5 text-emerald-600" />
              )}
              {saveStatus !== "saving" && saveStatus !== "error" && liveStatus === "connecting" && (
                <LoaderCircleIcon className="size-3.5 animate-spin" />
              )}
              {saveStatus !== "saving" && saveStatus !== "error" && liveStatus === "disconnected" && (
                <CloudOffIcon className="size-3.5" />
              )}
              <span className="hidden sm:inline">
                {saveStatus === "saving"
                  ? "Saving…"
                  : saveStatus === "error"
                    ? "Not saved"
                    : liveStatus === "connected"
                      ? "Live"
                      : "Reconnecting…"}
              </span>
            </div>
            <Button size="sm" aria-label="Add card" onClick={() => openCreate("backlog")}>
              <PlusIcon />
              <span className="hidden sm:inline">Add card</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
        {loading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((column) => (
              <div key={column} className="h-80 animate-pulse rounded-2xl border border-border bg-muted/50" />
            ))}
          </div>
        ) : loadError ? (
          <div className="grid min-h-80 place-items-center rounded-2xl border border-dashed border-border bg-card px-6 text-center">
            <div>
              <CloudOffIcon className="mx-auto mb-3 size-8 text-muted-foreground" />
              <h3 className="font-semibold">Couldn’t open your board</h3>
              <p className="mt-1 text-sm text-muted-foreground">{loadError}</p>
              <Button variant="outline" className="mt-4" onClick={() => void loadBoard()}>
                <RotateCcwIcon />
                Try again
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid items-start gap-4 md:grid-cols-2 lg:grid-cols-4">
            {COLUMNS.map((column) => {
              const meta = COLUMN_META[column];
              const Icon = meta.icon;
              const cards = board.cards.filter((card) => card.column === column);
              const isDropTarget = dropTarget === column;

              return (
                <section
                  key={column}
                  className={cn(
                    "flex min-h-[max(430px,calc(100vh-7.5rem))] flex-col rounded-2xl border border-border bg-column p-2 transition-[border-color,background-color,box-shadow]",
                    isDropTarget && "border-primary/30 bg-primary/[0.035] shadow-[inset_0_0_0_1px_rgba(41,37,36,0.06)]",
                  )}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setDropTarget(column);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(null);
                  }}
                  onDrop={(event) => handleDrop(event, column)}
                >
                  <div className="flex items-center gap-3 px-2 py-2.5">
                    <div className="relative grid size-8 place-items-center rounded-lg border border-border bg-card shadow-xs">
                      <Icon className="size-4 text-muted-foreground" />
                      <span className={cn("absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-card", meta.dot)} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold">{meta.label}</h3>
                        <span className="rounded-md bg-stone-200/70 px-1.5 py-0.5 text-[11px] font-semibold text-stone-500">
                          {cards.length}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">{meta.helper}</p>
                    </div>
                    <Button variant="ghost" size="icon" className="size-8" aria-label={`Add card to ${meta.label}`} onClick={() => openCreate(column)}>
                      <PlusIcon />
                    </Button>
                  </div>

                  <div className="flex flex-1 flex-col gap-2.5 p-1.5">
                    {cards.map((card) => (
                      <TaskCard
                        key={card.id}
                        card={card}
                        onOpen={openEdit}
                        onToggleCompleted={toggleCardCompleted}
                        onDragStart={handleDragStart}
                        onDragEnd={() => handleDragEnd()}
                      />
                    ))}

                    {cards.length === 0 && (
                      <button
                        type="button"
                        className="grid min-h-28 place-items-center rounded-xl border border-dashed border-stone-300/80 px-4 text-center text-xs text-muted-foreground transition-colors hover:border-stone-400 hover:bg-card/60 hover:text-foreground"
                        onClick={() => openCreate(column)}
                      >
                        <span>
                          Drop a card here
                          <span className="mt-1 block text-[11px] text-stone-400">or click to add one</span>
                        </span>
                      </button>
                    )}
                  </div>
                </section>
              );
            })}

            <section
              className={cn(
                "rounded-2xl border border-border bg-column p-2 transition-[border-color,background-color,box-shadow] md:col-span-2 lg:col-span-4",
                dropTarget === COMPLETED_COLUMN && "border-primary/30 bg-primary/[0.035] shadow-[inset_0_0_0_1px_rgba(41,37,36,0.06)]",
              )}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropTarget(COMPLETED_COLUMN);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(null);
              }}
              onDrop={(event) => handleDrop(event, COMPLETED_COLUMN)}
            >
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-stone-200/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                aria-expanded={completedExpanded}
                aria-controls="completed-card-list"
                onClick={() => setCompletedExpanded((expanded) => !expanded)}
              >
                <div className="relative grid size-8 place-items-center rounded-lg border border-border bg-stone-100 shadow-xs">
                  <CheckCircle2Icon className="size-4 text-stone-500" />
                  <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-stone-400 ring-2 ring-stone-100" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold">Completed</h3>
                    <span className="rounded-md bg-stone-200/70 px-1.5 py-0.5 text-[11px] font-semibold text-stone-500">
                      {completedCards.length}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">Cleared from the current sprint</p>
                </div>
                <span className="text-xs font-medium text-muted-foreground">
                  {completedExpanded ? "Hide" : "Show"}
                </span>
                <ChevronDownIcon className={cn("size-4 text-muted-foreground transition-transform", completedExpanded && "rotate-180")} />
              </button>

              <div
                id="completed-card-list"
                hidden={!completedExpanded}
                className={cn(
                  "grid gap-2.5 p-1.5 pt-3 sm:grid-cols-2 lg:grid-cols-4",
                  !completedExpanded && "hidden",
                )}
              >
                {completedCards.map((card) => (
                  <TaskCard
                    key={card.id}
                    card={card}
                    onOpen={openEdit}
                    onToggleCompleted={toggleCardCompleted}
                    onDragStart={handleDragStart}
                    onDragEnd={() => handleDragEnd()}
                  />
                ))}

                {completedCards.length === 0 && (
                  <div className="grid min-h-24 place-items-center rounded-xl border border-dashed border-stone-300/80 px-4 text-center text-xs text-muted-foreground sm:col-span-2 lg:col-span-4">
                    Completed cards will appear here
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </main>

      {saveError && (
        <div className="fixed bottom-4 left-1/2 z-[60] flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 shadow-lg" role="alert">
          <span>{saveError}</span>
          <button className="shrink-0 font-semibold underline underline-offset-2" onClick={() => setSaveError("")}>Dismiss</button>
        </div>
      )}

      {editor && (
        <CardEditor
          key={`${editor.mode}-${editor.card.id}`}
          editor={editor}
          onClose={() => setEditor(null)}
          onSave={saveCard}
          onDelete={deleteCard}
        />
      )}
    </div>
  );
}

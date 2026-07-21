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
  type ColumnId,
  type KanbanCard,
} from "../shared/board";
import { CardEditor, type EditorState } from "./components/card-editor";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";

const BOARD_API_URL = new URL("api/board", window.location.href);

type SaveStatus = "idle" | "saving" | "saved" | "error";

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

function tagClassName(tag: string) {
  const normalized = tag.toLowerCase();
  if (["high", "urgent", "critical"].includes(normalized)) return "border-red-200 bg-red-50 text-red-700";
  if (["medium", "priority"].includes(normalized)) return "border-amber-200 bg-amber-50 text-amber-700";
  if (["low", "done"].includes(normalized)) return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (normalized === "bug") return "border-violet-200 bg-violet-50 text-violet-700";
  return "border-stone-200 bg-stone-100/80 text-stone-600";
}

function createCard(column: ColumnId): KanbanCard {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
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

  if (column === COMPLETED_COLUMN) {
    return {
      ...card,
      column,
      completedFrom: card.column === COMPLETED_COLUMN ? card.completedFrom ?? "done" : card.column,
      updatedAt,
    };
  }

  return { ...card, column, completedFrom: undefined, updatedAt };
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
                  className={isCompleted ? "border-stone-300 bg-stone-100/60 text-stone-500" : tagClassName(tag)}
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
  const [board, setBoard] = useState<BoardData>({ cards: [] });
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState("");
  const [dropTarget, setDropTarget] = useState<ColumnId | null>(null);
  const [completedExpanded, setCompletedExpanded] = useState(false);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingSaves = useRef(0);

  const loadBoard = useCallback(async () => {
    setLoading(true);
    setLoadError("");

    try {
      const response = await fetch(BOARD_API_URL, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("The board could not be loaded.");
      const data = (await response.json()) as BoardData;
      setBoard(data);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "The board could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  const persistBoard = useCallback((nextBoard: BoardData) => {
    setBoard(nextBoard);
    setSaveError("");
    setSaveStatus("saving");
    pendingSaves.current += 1;

    saveQueue.current = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        const response = await fetch(BOARD_API_URL, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(nextBoard),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error || "Changes could not be saved.");
        }
      })
      .then(() => {
        pendingSaves.current -= 1;
        if (pendingSaves.current === 0) setSaveStatus("saved");
      })
      .catch((error: unknown) => {
        pendingSaves.current -= 1;
        setSaveStatus("error");
        setSaveError(error instanceof Error ? error.message : "Changes could not be saved.");
      });
  }, []);

  function openCreate(column: ColumnId) {
    setEditor({ mode: "create", card: createCard(column) });
  }

  function openEdit(card: KanbanCard) {
    setEditor({ mode: "edit", card: { ...card, tags: [...card.tags] } });
  }

  function saveCard(card: KanbanCard, mode: EditorState["mode"]) {
    const existing = mode === "edit" ? board.cards.find((current) => current.id === card.id) : undefined;
    const normalizedCard = card.column === COMPLETED_COLUMN
      ? {
          ...card,
          completedFrom:
            card.completedFrom
            ?? (existing && existing.column !== COMPLETED_COLUMN ? existing.column : "backlog"),
        }
      : { ...card, completedFrom: undefined };
    const cards = mode === "create"
      ? [...board.cards, normalizedCard]
      : board.cards.map((current) => (current.id === card.id ? normalizedCard : current));
    setEditor(null);
    persistBoard({ cards });
  }

  function deleteCard(cardId: string) {
    setEditor(null);
    persistBoard({ cards: board.cards.filter((card) => card.id !== cardId) });
  }

  function toggleCardCompleted(cardId: string) {
    const card = board.cards.find((item) => item.id === cardId);
    if (!card) return;

    const target = card.column === COMPLETED_COLUMN ? card.completedFrom ?? "done" : COMPLETED_COLUMN;
    const updated = moveCardToColumn(card, target);
    persistBoard({
      cards: board.cards.map((item) => (item.id === cardId ? updated : item)),
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
    const updated = moveCardToColumn(card, column);
    persistBoard({
      cards: board.cards.map((item) => (item.id === cardId ? updated : item)),
    });
  }

  const activeCardCount = board.cards.filter((card) => card.column !== COMPLETED_COLUMN).length;
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
              <h1 className="text-base font-semibold leading-5 tracking-[-0.02em]">Paperboard</h1>
              <p className="text-xs text-muted-foreground">Personal workspace</p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
            {saveStatus === "saving" && <LoaderCircleIcon className="size-3.5 animate-spin" />}
            {saveStatus === "saved" && <CloudCheckIcon className="size-3.5 text-emerald-600" />}
            {saveStatus === "error" && <CloudOffIcon className="size-3.5 text-destructive" />}
            <span className="hidden sm:inline">
              {saveStatus === "saving" ? "Saving…" : saveStatus === "error" ? "Not saved" : "Saved to cloud"}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">My board</p>
            <h2 className="text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">Keep work moving.</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {activeCardCount} active {activeCardCount === 1 ? "card" : "cards"} across four simple stages.
            </p>
          </div>
          <Button size="lg" className="w-full sm:w-auto" onClick={() => openCreate("backlog")}>
            <PlusIcon />
            Add card
          </Button>
        </div>

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
                    "flex min-h-[430px] flex-col rounded-2xl border border-border bg-column p-2 transition-[border-color,background-color,box-shadow]",
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
        <div className="fixed bottom-4 left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 shadow-lg" role="alert">
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

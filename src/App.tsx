import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  CloudCheckIcon,
  CloudOffIcon,
  GripVerticalIcon,
  LoaderCircleIcon,
  PlusIcon,
  RotateCcwIcon,
} from "lucide-react";

import { COLUMNS, type BoardData, type ColumnId, type KanbanCard } from "../shared/board";
import { CardEditor, type EditorState } from "./components/card-editor";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";

type SaveStatus = "idle" | "saving" | "saved" | "error";

const COLUMN_META = {
  backlog: {
    label: "Backlog",
    helper: "Ideas and next up",
    icon: CircleDashedIcon,
    dot: "bg-stone-400",
  },
  doing: {
    label: "Doing",
    helper: "Work in motion",
    icon: CircleDotDashedIcon,
    dot: "bg-amber-500",
  },
  done: {
    label: "Done",
    helper: "Finished work",
    icon: CheckCircle2Icon,
    dot: "bg-emerald-500",
  },
} satisfies Record<ColumnId, { label: string; helper: string; icon: typeof CircleDashedIcon; dot: string }>;

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

interface TaskCardProps {
  card: KanbanCard;
  onOpen: (card: KanbanCard) => void;
  onDragStart: (event: DragEvent<HTMLElement>, cardId: string) => void;
  onDragEnd: () => void;
}

function TaskCard({ card, onOpen, onDragStart, onDragEnd }: TaskCardProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(card);
    }
  }

  return (
    <article
      draggable
      role="button"
      tabIndex={0}
      aria-label={`Open ${card.title}`}
      className="group cursor-grab rounded-xl border border-border/90 bg-card p-4 shadow-[0_1px_2px_rgba(28,25,23,0.04)] transition-[border-color,box-shadow,transform,opacity] hover:-translate-y-0.5 hover:border-stone-300 hover:shadow-[0_8px_24px_rgba(28,25,23,0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 active:cursor-grabbing data-[dragging=true]:opacity-50"
      onClick={() => onOpen(card)}
      onKeyDown={handleKeyDown}
      onDragStart={(event) => onDragStart(event, card.id)}
      onDragEnd={(event) => {
        delete event.currentTarget.dataset.dragging;
        onDragEnd();
      }}
    >
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 text-[15px] font-semibold leading-5 tracking-[-0.01em] text-card-foreground">
          {card.title}
        </h3>
        <GripVerticalIcon className="-mr-1 mt-0.5 size-4 shrink-0 text-stone-300 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>

      {card.description && (
        <p className="mt-2 line-clamp-3 whitespace-pre-line text-[13px] leading-5 text-muted-foreground">
          {card.description}
        </p>
      )}

      {card.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {card.tags.map((tag) => (
            <Badge key={tag} variant="outline" className={tagClassName(tag)}>
              {tag}
            </Badge>
          ))}
        </div>
      )}
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
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingSaves = useRef(0);

  const loadBoard = useCallback(async () => {
    setLoading(true);
    setLoadError("");

    try {
      const response = await fetch("/api/board", { headers: { accept: "application/json" } });
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
        const response = await fetch("/api/board", {
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
    const cards = mode === "create"
      ? [...board.cards, card]
      : board.cards.map((current) => (current.id === card.id ? card : current));
    setEditor(null);
    persistBoard({ cards });
  }

  function deleteCard(cardId: string) {
    setEditor(null);
    persistBoard({ cards: board.cards.filter((card) => card.id !== cardId) });
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
    const updated: KanbanCard = { ...card, column, updatedAt: new Date().toISOString() };
    persistBoard({
      cards: board.cards.map((item) => (item.id === cardId ? updated : item)),
    });
  }

  const totalCards = board.cards.length;

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
              {totalCards} {totalCards === 1 ? "card" : "cards"} across three simple stages.
            </p>
          </div>
          <Button size="lg" className="w-full sm:w-auto" onClick={() => openCreate("backlog")}>
            <PlusIcon />
            Add card
          </Button>
        </div>

        {loading ? (
          <div className="grid gap-4 md:grid-cols-3">
            {[0, 1, 2].map((column) => (
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
          <div className="grid items-start gap-4 md:grid-cols-3">
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

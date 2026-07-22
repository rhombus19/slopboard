import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { PlusIcon, TagIcon, Trash2Icon, XIcon } from "lucide-react";

import type { ColumnId, KanbanCard } from "../../shared/board";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";
import { tagColorStyle } from "../lib/utils";

export interface EditorState {
  mode: "create" | "edit";
  card: KanbanCard;
}

interface CardEditorProps {
  editor: EditorState;
  onClose: () => void;
  onSave: (card: KanbanCard, mode: EditorState["mode"]) => void;
  onDelete: (cardId: string) => void;
}

const SUGGESTED_TAGS = ["High", "Medium", "Low", "Feature", "Bug"];
const COLUMN_LABELS: Record<ColumnId, string> = {
  backlog: "Backlog",
  ready: "Ready for sprint",
  doing: "Doing",
  done: "Done",
  completed: "Completed",
};

export function CardEditor({ editor, onClose, onSave, onDelete }: CardEditorProps) {
  const [draft, setDraft] = useState(editor.card);
  const [tagInput, setTagInput] = useState("");
  const [titleError, setTitleError] = useState(false);

  const availableSuggestions = useMemo(
    () => SUGGESTED_TAGS.filter((tag) => !draft.tags.some((current) => current.toLowerCase() === tag.toLowerCase())),
    [draft.tags],
  );

  function addTag(value: string) {
    const tag = value.trim().replace(/,$/, "").slice(0, 24);
    if (!tag || draft.tags.length >= 8) return;
    if (draft.tags.some((current) => current.toLowerCase() === tag.toLowerCase())) {
      setTagInput("");
      return;
    }

    setDraft((current) => ({ ...current, tags: [...current.tags, tag] }));
    setTagInput("");
  }

  function removeTag(tag: string) {
    setDraft((current) => ({ ...current, tags: current.tags.filter((item) => item !== tag) }));
  }

  function handleTagKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTag(tagInput);
    }

    if (event.key === "Backspace" && !tagInput && draft.tags.length) {
      removeTag(draft.tags[draft.tags.length - 1]);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = draft.title.trim();
    if (!title) {
      setTitleError(true);
      return;
    }

    const pendingTag = tagInput.trim().replace(/,$/, "").slice(0, 24);
    const tags = pendingTag && !draft.tags.some((tag) => tag.toLowerCase() === pendingTag.toLowerCase())
      ? [...draft.tags, pendingTag].slice(0, 8)
      : draft.tags;

    onSave(
      {
        ...draft,
        title,
        description: draft.description.trim(),
        tags,
        updatedAt: new Date().toISOString(),
      },
      editor.mode,
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editor.mode === "create" ? "Add a card" : "Edit card"}</DialogTitle>
          <DialogDescription>
            Keep the details light. A clear title, a short note, and a couple of tags are usually enough.
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-5" onSubmit={handleSubmit}>
          <div className="grid gap-2">
            <Label htmlFor="card-title">Title</Label>
            <Input
              id="card-title"
              autoFocus
              maxLength={120}
              placeholder="What needs to happen?"
              value={draft.title}
              aria-invalid={titleError}
              className={titleError ? "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20" : ""}
              onChange={(event) => {
                setDraft((current) => ({ ...current, title: event.target.value }));
                if (event.target.value.trim()) setTitleError(false);
              }}
            />
            {titleError && <p className="text-xs text-destructive">Add a title before saving.</p>}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="card-description">Notes</Label>
            <Textarea
              id="card-description"
              maxLength={5000}
              placeholder="Add context, a checklist, or the next step…"
              value={draft.description}
              onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="card-column">Column</Label>
            <Select
              value={draft.column}
              onValueChange={(column: ColumnId) => setDraft((current) => ({ ...current, column }))}
            >
              <SelectTrigger id="card-column">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(COLUMN_LABELS) as ColumnId[]).map((column) => (
                  <SelectItem key={column} value={column}>
                    {COLUMN_LABELS[column]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="card-tags">Tags</Label>
              <span className="text-xs text-muted-foreground">{draft.tags.length}/8</span>
            </div>

            {draft.tags.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {draft.tags.map((tag) => (
                  <Badge
                    key={tag}
                    variant="outline"
                    className="gap-1.5 py-1 pl-2.5 pr-1.5"
                    style={tagColorStyle(tag)}
                  >
                    {tag}
                    <button
                      type="button"
                      className="rounded-sm p-0.5 text-muted-foreground hover:bg-black/5 hover:text-foreground"
                      aria-label={`Remove ${tag} tag`}
                      onClick={() => removeTag(tag)}
                    >
                      <XIcon className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}

            <div className="relative">
              <TagIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="card-tags"
                className="pl-9"
                maxLength={24}
                placeholder="Type a tag, then press Enter"
                value={tagInput}
                disabled={draft.tags.length >= 8}
                onChange={(event) => setTagInput(event.target.value)}
                onKeyDown={handleTagKeyDown}
                onBlur={() => addTag(tagInput)}
              />
            </div>

            {availableSuggestions.length > 0 && draft.tags.length < 8 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs text-muted-foreground">Try</span>
                {availableSuggestions.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs font-medium transition-[filter] hover:brightness-95"
                    style={tagColorStyle(tag)}
                    onClick={() => addTag(tag)}
                  >
                    <PlusIcon className="size-3" />
                    {tag}
                  </button>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <div>
              {editor.mode === "edit" && (
                <Button type="button" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => onDelete(draft.id)}>
                  <Trash2Icon />
                  Delete
                </Button>
              )}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit">{editor.mode === "create" ? "Add card" : "Save changes"}</Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

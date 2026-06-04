// Session-scoped todo list. The `todo` tool replaces it; the TUI subscribes to it to
// render the live task panel. Kept deliberately tiny — it's just an observable array.

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string; // present-continuous label shown while in_progress
}

export class TodoStore {
  private items: TodoItem[] = [];
  private listeners = new Set<(items: TodoItem[]) => void>();

  get(): TodoItem[] {
    return this.items;
  }

  set(items: TodoItem[]): void {
    this.items = items;
    for (const l of this.listeners) l(items);
  }

  subscribe(fn: (items: TodoItem[]) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

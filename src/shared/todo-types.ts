export type TodoItem = {
  priority?: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
  content: string;
  id: string;
};

export type TodoState = {
  /** 清单所属模式，用于多模式隔离 */
  mode?: "work";
  updatedAt: number;
  todos: TodoItem[];
};

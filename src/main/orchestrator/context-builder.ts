import { memoryScheduler } from "../memory/memory-scheduler";

export function scheduleMemoryWrite(userInput: string, assistantReply: string, conversationId?: string): void {
  const scheduler = memoryScheduler;
  scheduler.scheduleMemoryWrite(userInput, assistantReply, conversationId);
}

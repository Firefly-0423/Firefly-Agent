export class RunEventGate<TEvent extends { runId?: string }> {
  private boundRun: string | undefined;
  private backlog: TEvent[] = [];

  accept(event: TEvent): TEvent[] {
    if (this.boundRun) return event.runId === this.boundRun ? [event] : [];
    this.backlog.push(event);
    return [];
  }

  bind(runId: string): TEvent[] {
    this.boundRun = runId;
    const matching = this.backlog.filter((packet) => packet.runId === runId);
    this.backlog = [];
    return matching;
  }
}

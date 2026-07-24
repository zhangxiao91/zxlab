export class PerKeyQueue {
  private readonly pending = new Map<string, Promise<void>>();

  enqueue(key: string, task: () => Promise<void>): void {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.pending.set(key, current);
    void current.finally(() => {
      if (this.pending.get(key) === current) this.pending.delete(key);
    }).catch(() => undefined);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending.values()]);
  }
}

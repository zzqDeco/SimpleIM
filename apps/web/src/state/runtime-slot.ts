export class RoomRuntimeSlot<T> {
  current: T | null = null;
  generation = 0;

  beginAttempt(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrentAttempt(gen: number): boolean {
    return this.generation === gen;
  }

  installIfCurrent(gen: number, runtime: T): boolean {
    if (this.generation !== gen) {
      return false;
    }
    this.current = runtime;
    return true;
  }

  clearIfOwned(runtime: T | null): boolean {
    if (runtime !== null && this.current === runtime) {
      this.current = null;
      return true;
    }
    return false;
  }

  takeActiveForTeardown(): T | null {
    this.generation += 1;
    const active = this.current;
    this.current = null;
    return active;
  }
}

import type {
  BoundaryLogFields,
  ClockPort,
  LoggerPort,
  LogLevel,
} from "../domain/index.ts";

export class SystemClock implements ClockPort {
  nowMs(): number {
    return Date.now();
  }
}

export interface JsonBoundaryLoggerOptions {
  readonly clock?: ClockPort;
  readonly sink?: (jsonLine: string) => void;
}

export class JsonBoundaryLogger implements LoggerPort {
  private readonly clock: ClockPort;
  private readonly sink: (jsonLine: string) => void;

  constructor(options?: JsonBoundaryLoggerOptions) {
    this.clock = options?.clock ?? new SystemClock();
    this.sink =
      options?.sink ?? ((jsonLine: string) => process.stdout.write(`${jsonLine}\n`));
  }

  info(event: string, fields: BoundaryLogFields): void {
    this.emit("info", event, fields);
  }

  warn(event: string, fields: BoundaryLogFields): void {
    this.emit("warn", event, fields);
  }

  error(event: string, fields: BoundaryLogFields): void {
    this.emit("error", event, fields);
  }

  private emit(
    level: LogLevel,
    event: string,
    fields: BoundaryLogFields,
  ): void {
    const durationMs =
      fields.durationMs !== undefined
        ? Math.max(0, Math.round(fields.durationMs))
        : 0;
    const roomIdPrefix = fields.roomIdPrefix
      ? fields.roomIdPrefix.slice(0, 8)
      : undefined;

    const record: Record<string, string | number> = {
      ts: Math.round(this.clock.nowMs()),
      level,
      event,
      corrId: fields.corrId,
      durationMs,
    };

    if (roomIdPrefix !== undefined) {
      record.roomIdPrefix = roomIdPrefix;
    }
    if (fields.errorCode !== undefined) {
      record.errorCode = fields.errorCode;
    }
    if (fields.status !== undefined) {
      record.status = fields.status;
    }
    if (fields.method !== undefined) {
      record.method = fields.method;
    }
    if (fields.path !== undefined) {
      record.path = fields.path;
    }
    if (fields.peerId !== undefined) {
      record.peerId = fields.peerId;
    }
    if (fields.userId !== undefined) {
      record.userId = fields.userId;
    }
    if (fields.frameType !== undefined) {
      record.frameType = fields.frameType;
    }

    this.sink(JSON.stringify(record));
  }
}

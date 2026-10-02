import { Writable } from "node:stream";
import pino, { type Logger, type LoggerOptions } from "pino";

export class LogRing {
  private readonly lines: string[];
  private next = 0;
  private size = 0;

  constructor(private readonly capacity: number) {
    this.lines = new Array<string>(capacity);
  }

  push(line: string): void {
    this.lines[this.next] = line;
    this.next = (this.next + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  snapshot(): string[] {
    const out: string[] = [];
    const start = (this.next - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i++) {
      const line = this.lines[(start + i) % this.capacity];
      if (line !== undefined) out.push(line);
    }
    return out;
  }
}

export function createLogger(level: string, ring: LogRing, destination?: NodeJS.WritableStream): Logger {
  const ringStream = new Writable({
    write(chunk, _enc, cb) {
      ring.push(chunk.toString().trimEnd());
      cb();
    },
  });
  const options: LoggerOptions = {
    level,
    base: { service: "seat-reservation" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  };
  return pino(
    options,
    pino.multistream([
      { stream: destination ?? process.stdout },
      { stream: ringStream },
    ]),
  );
}

import { Writable } from "node:stream";
import pino, { type Logger, type LoggerOptions } from "pino";

/**
 * Fixed-size circular buffer holding the most recent log lines in memory, served by `GET /logs`.
 * @param capacity - Maximum number of lines kept; the oldest is overwritten first.
 */
export class LogRing {
  private readonly lines: string[];
  private next = 0;
  private size = 0;

  constructor(private readonly capacity: number) {
    this.lines = new Array<string>(capacity);
  }

  /**
   * Adds a line, overwriting the oldest once the buffer is full.
   * @param line - One JSON log line.
   */
  addLine(line: string): void {
    this.lines[this.next] = line;
    this.next = (this.next + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  /**
   * Returns the buffered lines from oldest to newest.
   * @returns A copy, safe to filter or slice.
   */
  getRecentLines(): string[] {
    const out: string[] = [];
    const start = (this.next - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i++) {
      const line = this.lines[(start + i) % this.capacity];
      if (line !== undefined) out.push(line);
    }
    return out;
  }
}

/**
 * Creates the structured JSON logger, writing each line to stdout (collected from the container by the log agent, and shown by the
 * platform's log viewer), into the ring buffer, and to any extra streams (for example the Loki shipper).
 * @param level - Minimum level to emit.
 * @param ring - Buffer that also receives every line.
 * @param destination - Alternative to stdout, for tests.
 * @param extraStreams - Further streams that receive every line.
 */
export function createLogger(
  level: string,
  ring: LogRing,
  destination?: NodeJS.WritableStream,
  extraStreams: NodeJS.WritableStream[] = [],
): Logger {
  const ringStream = new Writable({
    write(chunk, _enc, cb) {
      ring.addLine(chunk.toString().trimEnd());
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
    pino.multistream([{ stream: destination ?? process.stdout }, { stream: ringStream }, ...extraStreams.map((stream) => ({ stream }))]),
  );
}

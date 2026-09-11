import { DatabaseService, DatabaseExecResult, DatabaseRow, DatabaseOpts } from '@/types/database';

interface WasmRunResult {
  changes: number;
  lastInsertRowid: number;
}

interface WasmStatement {
  run(...params: unknown[]): Promise<WasmRunResult>;
  all(...params: unknown[]): Promise<Record<string, unknown>[]>;
}

interface WasmDatabase {
  // Turso's `Database.prepare()` was made async in @readest/turso-database-common
  // (commit a30b6ded4). It still resolves synchronously today, but the package
  // notes the underlying impl may become truly async — accept either shape and
  // always `await` at the call site so we're forward-compatible.
  prepare(sql: string): WasmStatement | Promise<WasmStatement>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * FORK: consecutive-failure circuit breaker. On some browsers/sessions the
 * turso WASM storage layer breaks wholesale — every write panics inside the
 * WASM (`sqlite3_ondisk: wrote != expected`), and since callers write on
 * timers (ReadingStatsTracker flushes while reading), each attempt is another
 * main-thread stall + panic unwind. Firefox then tells the user the page is
 * "slowing down the browser". Once a connection fails this many times in a
 * row, we declare it dead: further calls reject IMMEDIATELY with a plain
 * error, never re-entering the WASM. Consumers already treat db errors as
 * best-effort (stats/caches), so the degradation is silent and cheap.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

export class WebDatabaseService implements DatabaseService {
  private db: WasmDatabase;
  private consecutiveFailures = 0;
  private dead = false;
  private readonly label: string;

  private constructor(db: WasmDatabase, label: string) {
    this.db = db;
    this.label = label;
  }

  static async open(path: string, opts?: DatabaseOpts): Promise<WebDatabaseService> {
    const mod = await import('@readest/turso-database-wasm/webpack');
    const db = (await mod.connect(path, opts)) as unknown as WasmDatabase;
    return new WebDatabaseService(db, path);
  }

  private guard(): void {
    if (this.dead) {
      throw new Error(`WebDatabaseService(${this.label}): disabled after repeated wasm failures`);
    }
  }

  private noteSuccess(): void {
    this.consecutiveFailures = 0;
  }

  private noteFailure(err: unknown): never {
    this.consecutiveFailures += 1;
    if (!this.dead && this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.dead = true;
      console.warn(
        `WebDatabaseService(${this.label}): ${this.consecutiveFailures} consecutive wasm failures — ` +
          'disabling this database for the session to keep the page responsive.',
        err,
      );
    }
    throw err;
  }

  async execute(sql: string, params: unknown[] = []): Promise<DatabaseExecResult> {
    this.guard();
    try {
      const stmt = await this.db.prepare(sql);
      const result = await stmt.run(...params);
      this.noteSuccess();
      return {
        rowsAffected: result.changes,
        lastInsertId: Number(result.lastInsertRowid),
      };
    } catch (err) {
      this.noteFailure(err);
    }
  }

  async select<T extends DatabaseRow = DatabaseRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    this.guard();
    try {
      const stmt = await this.db.prepare(sql);
      const rows = await stmt.all(...params);
      this.noteSuccess();
      return rows as T[];
    } catch (err) {
      this.noteFailure(err);
    }
  }

  async batch(statements: string[]): Promise<void> {
    this.guard();
    try {
      await this.db.exec('BEGIN');
      try {
        for (const sql of statements) {
          await this.db.exec(sql);
        }
        await this.db.exec('COMMIT');
      } catch (error: unknown) {
        await this.db.exec('ROLLBACK');
        throw error;
      }
      this.noteSuccess();
    } catch (err) {
      this.noteFailure(err);
    }
  }

  async close(): Promise<void> {
    if (this.dead) return;
    // Turso is WAL-only with no auto-checkpoint and does not fold the WAL on
    // close by itself; without this the main file never grows past its header
    // and every written byte sits in the -wal sidecar, which file-level copy
    // or sync of the containing directory can miss.
    await this.execute('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {});
    await this.db.close();
  }
}

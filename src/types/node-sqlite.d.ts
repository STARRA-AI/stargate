/**
 * Minimal ambient typings for node:sqlite (built into Node 22.5+/24; the
 * repo's @types/node predates it). Only the surface db.ts uses — extend as
 * needed, never invent beyond the documented API.
 */
declare module "node:sqlite" {
  export class StatementSync {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

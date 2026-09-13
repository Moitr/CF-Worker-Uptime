import { MonitorState, CheckHistory } from './types';

export class Database {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  private async measured<T>(operation: string, query: Promise<D1Result<T>>): Promise<D1Result<T>> {
    const result = await query;
    console.log(JSON.stringify({ event: 'd1_query', operation, rows_read: result.meta.rows_read,
      rows_written: result.meta.rows_written, duration_ms: result.meta.duration }));
    return result;
  }

  async getMonitorState(monitorId: string): Promise<MonitorState | null> {
    const { results } = await this.measured('monitor_state', this.db
      .prepare('SELECT * FROM monitors_state WHERE monitor_id = ?')
      .bind(monitorId).all<MonitorState>());
    return results[0] || null;
  }

  async upsertMonitorState(state: MonitorState): Promise<void> {
    await this.measured('upsert_state', this.db
      .prepare(
        `INSERT INTO monitors_state (monitor_id, status, last_checked_at, last_latency, fail_count, first_fail_time, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(monitor_id) DO UPDATE SET
         status = excluded.status,
         last_checked_at = excluded.last_checked_at,
         last_latency = excluded.last_latency,
         fail_count = excluded.fail_count,
         first_fail_time = excluded.first_fail_time,
         last_error = excluded.last_error`
      )
      .bind(
        state.monitor_id,
        state.status,
        state.last_checked_at,
        state.last_latency,
        state.fail_count,
        state.first_fail_time,
        state.last_error || null
      )
      .run());
  }

  async addCheckHistory(history: CheckHistory): Promise<void> {
    await this.measured('insert_history', this.db
      .prepare('INSERT INTO check_history (monitor_id, timestamp, status, latency, message) VALUES (?, ?, ?, ?, ?)')
      .bind(history.monitor_id, history.timestamp, history.status, history.latency, history.message ?? null)
      .run());
  }

  async cleanupHistory(now = Date.now()): Promise<number> {
    const cutoff = now - 14 * 24 * 60 * 60 * 1000;
    let deleted = 0;
    // Bound each hourly invocation to four batches, so old backlogs drain gradually.
    for (let batch = 0; batch < 4; batch++) {
      const result = await this.measured('cleanup_history', this.db.prepare(
        'DELETE FROM check_history WHERE id IN (SELECT id FROM check_history WHERE timestamp < ? ORDER BY timestamp LIMIT 500)'
      ).bind(cutoff).run());
      deleted += result.meta.changes;
      if (result.meta.changes < 500) break;
    }
    return deleted;
  }

  async getHistory(monitorId: string, limit: number = 50): Promise<CheckHistory[]> {
    const { results } = await this.measured('latency_history', this.db
      .prepare(
        'SELECT * FROM check_history WHERE monitor_id = ? ORDER BY timestamp DESC LIMIT ?'
      )
      .bind(monitorId, limit)
      .all<CheckHistory>());
    return results.reverse(); // Return in chronological order
  }

  async getRecentHistory(limit: number = 60): Promise<CheckHistory[]> {
     const { results } = await this.db
      .prepare(
         `SELECT * FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY monitor_id ORDER BY timestamp DESC) as rn
            FROM check_history
         ) WHERE rn <= ?`
      )
      .bind(limit)
      .all<CheckHistory>();
    return results.sort((a, b) => a.timestamp - b.timestamp);
  }

  // Keep actual check timestamps for the rolling ten-minute frontend buckets.
  async getWindowHistory(since: number): Promise<CheckHistory[]> {
    const { results } = await this.measured('status_history', this.db
      .prepare('SELECT monitor_id, timestamp, status, latency FROM check_history WHERE timestamp >= ? ORDER BY timestamp ASC')
      .bind(since)
      .all<CheckHistory>());
    return results;
  }

  async getHourlyHistory(since: number): Promise<CheckHistory[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM check_history WHERE timestamp >= ? ORDER BY timestamp ASC')
      .bind(since)
      .all<CheckHistory>();
    const buckets = new Map<string, CheckHistory>();
    const rank: Record<string, number> = { UP: 1, DEGRADED: 2, DOWN: 3 };
    for (const item of results) {
      const timestamp = Math.floor(item.timestamp / 3600000) * 3600000;
      const key = `${item.monitor_id}:${timestamp}`;
      const current = buckets.get(key);
      if (!current || rank[item.status] > rank[current.status]) {
        buckets.set(key, { ...item, timestamp });
      } else if (current) {
        current.latency = Math.round((current.latency + item.latency) / 2);
      }
    }
    return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp);
  }

  async getAllMonitorStates(): Promise<MonitorState[]> {
    const { results } = await this.measured('all_monitor_states', this.db
      .prepare('SELECT * FROM monitors_state')
      .all<MonitorState>());
    return results;
  }
}

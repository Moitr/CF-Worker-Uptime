import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { loadConfig } from './config';
import { checkMonitor } from './monitor';
import { Database } from './db';
import { StatusCache, databaseFailure } from './status-cache';
import { sendNotification } from './notifications';
import { MonitorState, Monitor } from './types';
import htmlContent from '../frontend/status.html';

interface Env {
  DB: D1Database;
  RESEND_KEY?: string;
  RESEND_SEND?: string;
  RESEND_RECEIVE?: string;
}

const app = new Hono<{ Bindings: Env }>();

// Helper to strip private info from monitor config
function sanitizeMonitor(monitor: Monitor) {
  const safe = { ...monitor };
  if (!monitor.display?.public_link) {
    delete (safe as any).url;
  }
  return safe;
}

app.use('*', cors({ origin: '*', exposeHeaders: ['X-Status-Updated-At', 'X-Status-Stale', 'X-Status-Cache', 'X-Status-Error', 'Retry-After'] }));
const statusCache = new StatusCache();
const historyCache = new StatusCache();

// --- Frontend ---
app.get('/', (c) => {
  return c.html(htmlContent);
});

// --- API Endpoints ---

app.get('/api/config', (c) => {
  const config = loadConfig();
  // Strip secrets
  const safeConfig = {
    settings: {
      title: config.settings.title,
      tags: config.settings.tags,
      summary_exclusion: config.settings.summary_exclusion,
      // hide callback_url/secret
    },
    groups: config.groups.map(group => ({
      ...group,
      monitors: group.monitors.map(sanitizeMonitor)
    })),
    incidents: config.incidents,
  };
  return c.json(safeConfig);
});

app.get('/api/status', async (c) => {
  const config = loadConfig();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(config)));
  const version = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const key = new URL('/_status-cache/v1?config=' + version, c.req.url).href;
  return statusCache.get(key, caches.default, async () => {
    const db = new Database(c.env.DB);
    const states = await db.getAllMonitorStates();
    const stateMap = new Map(states.map(s => [s.monitor_id, s]));

    // Preserve timestamps for 84 ten-minute capsules; the page anchors each row to its latest check.
    const allHistory = await db.getWindowHistory(Date.now() - 14 * 60 * 60 * 1000);
    const historyMap = new Map<string, any[]>();
  
    allHistory.forEach(h => {
      if (!historyMap.has(h.monitor_id)) {
        historyMap.set(h.monitor_id, []);
      }
      historyMap.get(h.monitor_id)?.push(h);
    });
  
    const result = config.groups.map(group => ({
      ...group,
      monitors: group.monitors.map(monitor => {
        const state = stateMap.get(monitor.id);
        const safeMonitor = sanitizeMonitor(monitor);
        return {
          ...safeMonitor,
          state: state || { status: 'UNKNOWN', last_checked_at: 0, last_latency: 0 },
          recent_checks: historyMap.get(monitor.id) || []
        };
      }),
    }));

    return result;
  });
});

app.get('/api/history/:id', async (c) => {
  const id = c.req.param('id');
  const monitor = loadConfig().groups.flatMap(group => group.monitors).find(m => m.id === id);
  if (!monitor || monitor.display.history === false) return c.json({ error: 'NOT_FOUND' }, 404);
  const key = new URL('/_history-cache/v1?id=' + encodeURIComponent(id), c.req.url).href;
  return historyCache.get(key, caches.default, () => new Database(c.env.DB).getHistory(id));
});

// --- Cron Handler ---

async function handleScheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  const config = loadConfig();
  const db = new Database(env.DB);
  if (event.cron === '7 * * * *') {
    try { await db.cleanupHistory(event.scheduledTime); }
    catch (error) { console.error(JSON.stringify({ event: 'history_cleanup_failed', ...databaseFailure(error) })); }
    return;
  }

  // Flatten monitors
  const monitors: Monitor[] = [];
  config.groups.forEach(g => monitors.push(...g.monitors));

  const results = await Promise.allSettled(monitors.map(async (monitor) => {
    // 1. Get previous state
    const prevState = await db.getMonitorState(monitor.id);
    
    // 2. Perform Check
    console.log(`[Cron] Checking ${monitor.id} (${monitor.url})...`);
    const checkResult = await checkMonitor(monitor);
    const now = Date.now();
    console.log(`[Cron] Result for ${monitor.id}: ${checkResult.status}, Latency: ${checkResult.latency}ms, Msg: ${checkResult.message}`);

    // 3. Determine New State
    let newStatus = checkResult.status;
    let failCount = prevState?.fail_count || 0;
    let firstFailTime = prevState?.first_fail_time || null;

    if (checkResult.status === 'DOWN') {
      failCount++;
      if (!firstFailTime) firstFailTime = now;
      
      // Grace period check
      if (failCount < monitor.grace_period) {
        // Not yet officially DOWN, keep previous status if it was UP/DEGRADED
        // But if it was already DOWN, it stays DOWN.
        // If it was UP, we might want to show it as UP (but failing).
        // For simplicity, if we are in grace period, we report the *previous* visible status
        // unless the previous status was UNKNOWN.
        if (prevState && prevState.status !== 'DOWN') {
          newStatus = prevState.status; 
        } else {
          // If no history, or already down, it's DOWN
           newStatus = 'DOWN';
        }
      } else {
        newStatus = 'DOWN';
      }
    } else {
      // UP or DEGRADED
      failCount = 0;
      firstFailTime = null;
    }

    // 4. Update DB
    const newState: MonitorState = {
      monitor_id: monitor.id,
      status: newStatus,
      last_checked_at: now,
      last_latency: checkResult.latency,
      fail_count: failCount,
      first_fail_time: firstFailTime,
      last_error: checkResult.status === 'DOWN' ? checkResult.message : null,
    };

    await db.upsertMonitorState(newState);
    
    // Retain one check per minute; cleanup runs separately once an hour.
    if (monitor.display.history !== false) {
       await db.addCheckHistory({
         monitor_id: monitor.id,
         timestamp: now,
         status: checkResult.status, // Log the *actual* check result, not the graced status
         latency: checkResult.latency,
         message: checkResult.message
       });
    }

    // 5. Notifications
    if (prevState && prevState.status !== newStatus) {
      // Check notification policy
      const shouldNotify = !config.settings.notification_on_down_only || newStatus === 'DOWN';
      
      if (shouldNotify) {
        await sendNotification(env, config, monitor, newStatus, checkResult.message || 'Status Changed');
      }
    }
  }));
  results.forEach((result, index) => {
    if (result.status === 'rejected') console.error(JSON.stringify({ event: 'monitor_failed', monitor_id: monitors[index].id, ...databaseFailure(result.reason) }));
  });
}

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
};

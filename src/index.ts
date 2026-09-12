import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { loadConfig } from './config';
import { checkMonitor } from './monitor';
import { Database } from './db';
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

app.use('*', cors());

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
  const db = new Database(c.env.DB);
  const states = await db.getAllMonitorStates();
  const stateMap = new Map(states.map(s => [s.monitor_id, s]));

  // Preserve check timestamps: 84 rolling ten-minute intervals end at now.
  const allHistory = await db.getWindowHistory(Date.now() - 14 * 60 * 60 * 1000);
  const historyMap = new Map<string, any[]>();
  
  allHistory.forEach(h => {
    if (!historyMap.has(h.monitor_id)) {
      historyMap.set(h.monitor_id, []);
    }
    historyMap.get(h.monitor_id)?.push(h);
  });
  
  const config = loadConfig();
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

  return c.json(result);
});

app.get('/api/history/:id', async (c) => {
  const id = c.req.param('id');
  const db = new Database(c.env.DB);
  const history = await db.getHistory(id);
  return c.json(history);
});

// --- Cron Handler ---

async function handleScheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  const config = loadConfig();
  const db = new Database(env.DB);

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
    
    // Save history (maybe not every check if we want to save space, but for now every check)
    // To save space, maybe only on change or every N minutes? 
    // User asked for "display delay chart", so we need history.
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
        await sendNotification(config, monitor, newStatus, checkResult.message || 'Status Changed', env);
      }
    }
  }));
}

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
};

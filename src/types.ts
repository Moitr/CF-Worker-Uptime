import { z } from 'zod';

export const MonitorTypeSchema = z.enum(['http', 'tcp']);

export const ValidationSchema = z.object({
  status: z.union([z.number(), z.array(z.number())]).optional(),
  body_match: z.string().optional(), // Regex string
  headers_match: z.record(z.string()).optional(),
});

export const DisplaySchema = z.object({
  chart: z.boolean().default(true),
  history: z.boolean().default(true),
  public_link: z.boolean().default(false),
});

export const TagSchema = z.union([
  z.string(), // Simple string tag "Production"
  z.object({  // Object tag with color
    name: z.string(),
    color: z.string().optional(), // Hex code or CSS color
  })
]);

export const MonitorSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: MonitorTypeSchema,
  url: z.string(),
  method: z.string().default('GET'),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  timeout: z.number().default(5000),
  expected_latency: z.number().default(1000),
  grace_period: z.number().default(3),
  tags: z.array(TagSchema).optional(),
  display: DisplaySchema.default({}),
  validation: ValidationSchema.optional(),
});

export const GroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  monitors: z.array(MonitorSchema),
});

export const TagDefinitionSchema = z.object({
  id: z.string(),
  label: z.string(), // Display name
  color: z.string().optional(),
});

export const IncidentUpdateSchema = z.object({
  timestamp: z.string(),
  message: z.string(),
  status: z.string().optional(),
});

export const IncidentSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.enum(['scheduled', 'routine', 'incident']),
  status: z.enum(['scheduled', 'upcoming', 'in_progress', 'completed', 'investigating', 'identified', 'monitoring', 'resolved']),
  affected_monitors: z.array(z.string()).optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  routine_schedule: z.string().optional(), // For routine maintenance description
  updates: z.array(IncidentUpdateSchema).optional().default([]),
});

export const ConfigSchema = z.object({
  settings: z.object({
    title: z.string(),
    callback_url: z.string().optional(),
    callback_secret: z.string().optional(),
    notification_on_down_only: z.boolean().default(false),
    tags: z.array(TagDefinitionSchema).optional(), // Predefined tags
    summary_exclusion: z.array(z.string()).optional(), // List of group IDs to exclude from summary
  }),
  monitors: z.array(MonitorSchema).optional(), // Support flat structure if needed, but we use groups
  groups: z.array(GroupSchema),
  incidents: z.array(IncidentSchema).optional().default([]),
});

export type Monitor = z.infer<typeof MonitorSchema>;
export type Group = z.infer<typeof GroupSchema>;
export type Config = z.infer<typeof ConfigSchema>;

// Database Types
export interface MonitorState {
  monitor_id: string;
  status: 'UP' | 'DEGRADED' | 'DOWN';
  last_checked_at: number;
  last_latency: number;
  fail_count: number;
  first_fail_time: number | null;
  last_error?: string | null;
}

export interface CheckHistory {
  id?: number;
  monitor_id: string;
  timestamp: number;
  status: 'UP' | 'DEGRADED' | 'DOWN';
  latency: number;
  message: string | null;
}

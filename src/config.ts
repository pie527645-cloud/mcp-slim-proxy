import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SlimConfig } from './types.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const DownstreamServerConfigSchema = z
  .object({
    command: z.string().min(1, 'Server command must be a non-empty string'),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().min(1).optional(),
  })
  .strict();

const SlimConfigSchema = z
  .object({
    mcpServers: z.record(z.string(), DownstreamServerConfigSchema),
  })
  .strict();

export function resolveConfigPath(cliConfigArg?: string, env: NodeJS.ProcessEnv = process.env): string {
  const candidate = cliConfigArg ?? env['MCP_SLIM_CONFIG'];
  if (!candidate || candidate.trim().length === 0) {
    throw new Error(
      'Missing configuration path. Pass --config <file> or set the MCP_SLIM_CONFIG environment variable.'
    );
  }
  return path.resolve(candidate.trim());
}

export function parseSlimConfigObject(raw: unknown): SlimConfig {
  const parsed = SlimConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid slim proxy configuration: ${details}`);
  }

  const serverEntries = Object.entries(parsed.data.mcpServers);
  if (serverEntries.length === 0) {
    throw new Error('Invalid slim proxy configuration: mcpServers must define at least one server.');
  }

  const cleanServers: SlimConfig['mcpServers'] = Object.create(null) as SlimConfig['mcpServers'];
  for (const [serverName, serverCfg] of serverEntries) {
    const trimmed = serverName.trim();
    if (trimmed.length === 0 || FORBIDDEN_KEYS.has(trimmed) || trimmed.includes('.')) {
      throw new Error(
        `Invalid server name "${serverName}". Server names must be non-empty, cannot contain dots, and cannot use reserved prototype keys.`
      );
    }
    cleanServers[trimmed] = serverCfg;
  }

  return { mcpServers: cleanServers };
}

export function loadSlimConfig(configPath: string): SlimConfig {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Configuration file not found: ${resolved}`);
  }

  const rawText = fs.readFileSync(resolved, 'utf8');
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse JSON configuration at ${resolved}: ${message}`);
  }

  return parseSlimConfigObject(parsedJson);
}

export function estimateTokensFromChars(charCount: number): number {
  if (charCount <= 0) {
    return 0;
  }
  return Math.ceil(charCount / 4);
}

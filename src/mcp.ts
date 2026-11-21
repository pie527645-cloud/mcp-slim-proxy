#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadSlimConfig, resolveConfigPath } from './config.js';
import { DEFAULT_TIMEOUT_MS } from './downstream.js';
import { startStdioSlimProxy } from './server.js';

export const VERSION = '0.1.0';

export function isExecutedDirectly(
  importMetaUrl: string,
  argv1: string | undefined = process.argv[1]
): boolean {
  if (!argv1) {
    return false;
  }
  try {
    const moduleRealPath = fs.realpathSync(fileURLToPath(importMetaUrl));
    const invokedRealPath = fs.realpathSync(path.resolve(argv1));
    return moduleRealPath === invokedRealPath;
  } catch {
    try {
      return importMetaUrl === pathToFileURL(path.resolve(argv1)).href;
    } catch {
      return false;
    }
  }
}

export interface ParsedServerFlags {
  help: boolean;
  version: boolean;
  configPath?: string;
  quarantineEnabled: boolean;
  timeoutMs: number;
  format: 'pretty' | 'json';
}

export function parseCommonFlags(argv: readonly string[]): {
  positionals: string[];
  flags: ParsedServerFlags;
} {
  const positionals: string[] = [];
  const flags: ParsedServerFlags = {
    help: false,
    version: false,
    quarantineEnabled: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    format: 'pretty',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      flags.version = true;
      continue;
    }
    if (arg === '--no-quarantine') {
      flags.quarantineEnabled = false;
      continue;
    }
    if (arg === '--quarantine') {
      flags.quarantineEnabled = true;
      continue;
    }
    if (arg === '--json') {
      flags.format = 'json';
      continue;
    }
    if (arg === '--config' || arg === '-c') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('Flag --config requires a file path argument.');
      }
      flags.configPath = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--config=')) {
      flags.configPath = arg.slice('--config='.length);
      continue;
    }
    if (arg === '--timeout') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('Flag --timeout requires a positive integer value in milliseconds.');
      }
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 50 || parsed > 600_000) {
        throw new Error(
          `Invalid --timeout value "${next}". Expected an integer between 50 and 600000 ms.`
        );
      }
      flags.timeoutMs = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith('--timeout=')) {
      const raw = arg.slice('--timeout='.length);
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 50 || parsed > 600_000) {
        throw new Error(
          `Invalid --timeout value "${raw}". Expected an integer between 50 and 600000 ms.`
        );
      }
      flags.timeoutMs = parsed;
      continue;
    }
    if (arg === '--format') {
      const next = argv[i + 1];
      if (next !== 'pretty' && next !== 'json') {
        throw new Error(`Invalid --format "${String(next)}". Expected "pretty" or "json".`);
      }
      flags.format = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--format=')) {
      const val = arg.slice('--format='.length);
      if (val !== 'pretty' && val !== 'json') {
        throw new Error(`Invalid --format "${val}". Expected "pretty" or "json".`);
      }
      flags.format = val;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}". Pass --help for usage information.`);
    }
    positionals.push(arg);
  }

  return { positionals, flags };
}

function formatMcpHelp(): string {
  return [
    'mcp-slim-proxy-server v0.1.0',
    'Zero-bloat stdio MCP multiplexer, lazy BM25 search, pipeline runner, and tool-poisoning firewall.',
    '',
    'Usage:',
    '  node dist/mcp.js --config <path/to/slim-config.json> [--no-quarantine] [--timeout <ms>]',
    '',
    'Environment:',
    '  MCP_SLIM_CONFIG   Fallback path to JSON configuration file when --config is omitted.',
    '',
    'Options:',
    '  --config, -c <file>   Path to standard mcpServers JSON configuration file',
    '  --no-quarantine       Disable automatic quarantine of poisoned tools (quarantine is ON by default)',
    '  --timeout <ms>        Downstream request timeout in milliseconds (default: 30000)',
    '  --help, -h            Print this help message',
    '  --version, -v         Print package version',
  ].join('\n');
}

export async function runMcpEntrypoint(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const { positionals, flags } = parseCommonFlags(argv);

  if (flags.help) {
    process.stdout.write(`${formatMcpHelp()}\n`);
    return;
  }
  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (positionals.length > 0 && positionals[0] !== 'serve') {
    throw new Error(
      `Unexpected positional argument "${positionals[0]}". Use "mcp-slim-proxy" CLI for subcommands like "savings".`
    );
  }

  const resolvedPath = resolveConfigPath(flags.configPath);
  const config = loadSlimConfig(resolvedPath);

  await startStdioSlimProxy({
    config,
    quarantineEnabled: flags.quarantineEnabled,
    timeoutMs: flags.timeoutMs,
  });
}

if (isExecutedDirectly(import.meta.url)) {
  runMcpEntrypoint().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[mcp-slim-proxy-server] Error: ${message}\n`);
    process.exit(1);
  });
}

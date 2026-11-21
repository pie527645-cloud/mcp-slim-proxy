#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { loadSlimConfig, resolveConfigPath } from './config.js';
import { DownstreamManager } from './downstream.js';
import { parseCommonFlags, VERSION } from './mcp.js';
import {
  buildSavingsReport,
  formatPrettySavingsReport,
  startStdioSlimProxy,
} from './server.js';

function formatCliHelp(): string {
  return [
    'mcp-slim-proxy v0.1.0',
    'Zero-bloat MCP multiplexer, lazy BM25 tool search, pipeline runner, and tool-poisoning firewall.',
    '',
    'Usage:',
    '  mcp-slim-proxy serve   --config <file> [--no-quarantine] [--timeout <ms>]',
    '  mcp-slim-proxy savings --config <file> [--no-quarantine] [--timeout <ms>] [--format pretty|json]',
    '',
    'Subcommands:',
    '  serve     Start the stdio MCP multiplexer proxy exposing 4 ultra-lean meta-tools',
    '  savings   Connect to configured downstream servers, audit token savings & poisoned tools, and exit cleanly',
    '',
    'Options:',
    '  --config, -c <file>       Path to mcpServers JSON configuration (or set MCP_SLIM_CONFIG)',
    '  --no-quarantine           Disable automatic quarantine of high/critical poisoned tools (ON by default)',
    '  --timeout <ms>            Per-request timeout for downstream servers in milliseconds (default: 30000)',
    '  --format <pretty|json>    Output format for the savings command (default: pretty)',
    '  --json                    Shorthand for --format json',
    '  --help, -h                Show this help text',
    '  --version, -v             Show CLI version',
  ].join('\n');
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const { positionals, flags } = parseCommonFlags(argv);

  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (flags.help || positionals.length === 0) {
    process.stdout.write(`${formatCliHelp()}\n`);
    if (!flags.help && positionals.length === 0) {
      process.exitCode = 1;
    }
    return;
  }

  const subcommand = positionals[0];
  if (positionals.length > 1) {
    throw new Error(`Unexpected extra positional argument "${positionals[1]}".`);
  }

  if (subcommand === 'serve') {
    const resolvedPath = resolveConfigPath(flags.configPath);
    const config = loadSlimConfig(resolvedPath);
    await startStdioSlimProxy({
      config,
      quarantineEnabled: flags.quarantineEnabled,
      timeoutMs: flags.timeoutMs,
    });
    return;
  }

  if (subcommand === 'savings') {
    const resolvedPath = resolveConfigPath(flags.configPath);
    const config = loadSlimConfig(resolvedPath);
    const manager = new DownstreamManager(config, {
      quarantineEnabled: flags.quarantineEnabled,
      timeoutMs: flags.timeoutMs,
    });

    try {
      await manager.start();
      const report = buildSavingsReport(manager);
      if (flags.format === 'json') {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatPrettySavingsReport(report)}\n`);
      }
    } finally {
      await manager.close();
    }
    return;
  }

  throw new Error(
    `Unknown subcommand "${subcommand}". Expected "serve" or "savings". Pass --help for usage.`
  );
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  runCli().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[mcp-slim-proxy] Error: ${message}\n`);
    process.exit(1);
  });
}

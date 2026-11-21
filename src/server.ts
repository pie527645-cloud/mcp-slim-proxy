import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { DownstreamManager } from './downstream.js';
import { shouldQuarantine } from './firewall.js';
import {
  DescribeToolArgsSchema,
  InvokeToolArgsSchema,
  measureMetaToolsFootprint,
  META_TOOLS,
  RunPipelineArgsSchema,
  SearchToolsArgsSchema,
} from './meta-tools.js';
import { runPipeline } from './pipeline.js';
import type {
  SavingsReport,
  ServerSavingsSummary,
  SlimConfig,
} from './types.js';

export function buildSavingsReport(manager: DownstreamManager): SavingsReport {
  const allTools = manager.getAllTools();
  const byServer = new Map<string, ServerSavingsSummary>();

  let rawSchemaBytes = 0;
  let rawSchemaChars = 0;
  let rawSchemaTokens = 0;
  let healthyToolCount = 0;
  let quarantinedCount = 0;
  let detectedPoisonedCount = 0;

  for (const tool of allTools) {
    let srv = byServer.get(tool.serverName);
    if (!srv) {
      srv = {
        server: tool.serverName,
        totalTools: 0,
        healthyTools: 0,
        quarantinedTools: 0,
        rawSchemaBytes: 0,
        rawSchemaChars: 0,
        rawSchemaTokens: 0,
      };
      byServer.set(tool.serverName, srv);
    }

    srv.totalTools += 1;
    srv.rawSchemaBytes += tool.rawSchemaBytes;
    srv.rawSchemaChars += tool.rawSchemaChars;
    srv.rawSchemaTokens += tool.rawSchemaTokens;

    rawSchemaBytes += tool.rawSchemaBytes;
    rawSchemaChars += tool.rawSchemaChars;
    rawSchemaTokens += tool.rawSchemaTokens;

    if (shouldQuarantine(tool.findings)) {
      detectedPoisonedCount += 1;
    }

    if (tool.quarantined) {
      srv.quarantinedTools += 1;
      quarantinedCount += 1;
    } else {
      srv.healthyTools += 1;
      healthyToolCount += 1;
    }
  }

  const metaFootprint = measureMetaToolsFootprint();
  const tokensSaved = rawSchemaTokens - metaFootprint.tokens;
  const percentSaved =
    rawSchemaTokens > 0
      ? Math.round(((rawSchemaTokens - metaFootprint.tokens) / rawSchemaTokens) * 10000) / 100
      : 0;

  const quarantinedTools = allTools
    .filter((t) => t.quarantined)
    .map((t) => ({
      toolId: t.toolId,
      findings: t.findings,
    }));

  return {
    quarantineEnabled: manager.quarantineEnabled,
    servers: Array.from(byServer.values()),
    totals: {
      downstreamServers: byServer.size,
      rawToolCount: allTools.length,
      healthyToolCount,
      quarantinedCount,
      detectedPoisonedCount,
      rawSchemaBytes,
      rawSchemaChars,
      rawSchemaTokens,
      proxiedMetaToolCount: metaFootprint.count,
      proxiedSchemaBytes: metaFootprint.bytes,
      proxiedSchemaChars: metaFootprint.chars,
      proxiedSchemaTokens: metaFootprint.tokens,
      tokensSaved,
      percentSaved,
    },
    quarantinedTools,
  };
}

export function formatPrettySavingsReport(report: SavingsReport): string {
  const lines: string[] = [];
  lines.push('MCP Slim Proxy - Context Token Savings & Firewall Audit');
  lines.push('='.repeat(56));
  lines.push(
    `Firewall Quarantine : ${report.quarantineEnabled ? 'ENABLED (default)' : 'DISABLED (--no-quarantine)'}`
  );
  lines.push(`Downstream Servers  : ${report.totals.downstreamServers}`);
  lines.push(
    `Discovered Tools    : ${report.totals.rawToolCount} total (${report.totals.healthyToolCount} healthy, ${report.totals.quarantinedCount} quarantined)`
  );
  lines.push('');
  lines.push('Per-Server Breakdown:');
  for (const srv of report.servers) {
    lines.push(
      `  - ${srv.server}: ${srv.totalTools} tools (${srv.healthyTools} healthy, ${srv.quarantinedTools} quarantined) | ${srv.rawSchemaBytes} bytes (~${srv.rawSchemaTokens} tokens)`
    );
  }
  lines.push('');
  lines.push('Token Footprint Comparison:');
  lines.push(
    `  Raw Tool Schemas     : ${report.totals.rawSchemaTokens} tokens (${report.totals.rawSchemaBytes} bytes across ${report.totals.rawToolCount} tools)`
  );
  lines.push(
    `  Proxied Meta-Tools   : ${report.totals.proxiedSchemaTokens} tokens (${report.totals.proxiedSchemaBytes} bytes across ${report.totals.proxiedMetaToolCount} tools)`
  );
  const sign = report.totals.tokensSaved >= 0 ? '' : '';
  lines.push(
    `  Net Savings          : ${sign}${report.totals.tokensSaved} tokens (${report.totals.percentSaved.toFixed(2)}% saved per turn)`
  );

  if (report.quarantinedTools.length > 0) {
    lines.push('');
    lines.push(`Quarantined Poisoned Tools (${report.quarantinedTools.length}):`);
    for (const qt of report.quarantinedTools) {
      const summary = qt.findings
        .map((f) => `[${f.severity.toUpperCase()}:${f.category}] ${f.message}`)
        .join(' | ');
      lines.push(`  - ${qt.toolId}: ${summary}`);
    }
  }

  return lines.join('\n');
}

export function createSlimProxyMcpServer(manager: DownstreamManager): Server {
  const server = new Server(
    {
      name: '@pie527645-cloud/mcp-slim-proxy',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [...META_TOOLS],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const rawArgs = request.params.arguments ?? {};

    try {
      if (toolName === 'search_tools') {
        const parsed = SearchToolsArgsSchema.parse(rawArgs);
        const hits = manager.getSearchIndex().search(parsed.query, {
          server: parsed.server,
          limit: parsed.limit,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                count: hits.length,
                totalHealthyTools: manager.getSearchIndex().getHealthyCount(),
                tools: hits,
              }),
            },
          ],
        };
      }

      if (toolName === 'describe_tool') {
        const parsed = DescribeToolArgsSchema.parse(rawArgs);
        const described = manager.describeHealthyTool(parsed.toolId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(described),
            },
          ],
        };
      }

      if (toolName === 'invoke_tool') {
        const parsed = InvokeToolArgsSchema.parse(rawArgs);
        const downstreamResult = await manager.invokeHealthyTool(
          parsed.toolId,
          parsed.arguments ?? {}
        );
        return {
          content: downstreamResult.content,
          isError: downstreamResult.isError === true ? true : undefined,
        };
      }

      if (toolName === 'run_pipeline') {
        const parsed = RunPipelineArgsSchema.parse(rawArgs);
        const pipelineResult = await runPipeline(parsed.steps, (targetToolId, stepArgs) =>
          manager.invokeHealthyTool(targetToolId, stepArgs)
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(pipelineResult),
            },
          ],
        };
      }

      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Unknown meta-tool "${toolName}". Available meta-tools: search_tools, describe_tool, invoke_tool, run_pipeline.`,
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: message,
          },
        ],
      };
    }
  });

  return server;
}

export interface ServeSlimProxyOptions {
  config: SlimConfig;
  quarantineEnabled?: boolean;
  timeoutMs?: number;
}

export async function startStdioSlimProxy(options: ServeSlimProxyOptions): Promise<{
  server: Server;
  manager: DownstreamManager;
  shutdown: () => Promise<void>;
}> {
  const manager = new DownstreamManager(options.config, {
    quarantineEnabled: options.quarantineEnabled,
    timeoutMs: options.timeoutMs,
  });
  await manager.start();

  const server = createSlimProxyMcpServer(manager);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await server.close();
    } catch {
      // Ignore transport close errors on exit.
    }
    await manager.close();
  };

  transport.onclose = () => {
    void shutdown();
  };

  const onSignal = (): void => {
    void shutdown().finally(() => {
      process.exit(0);
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  await server.connect(transport);
  return { server, manager, shutdown };
}

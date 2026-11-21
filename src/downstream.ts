import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { estimateTokensFromChars } from './config.js';
import {
  detectCrossToolShadowing,
  scanToolForPoisoning,
  shouldQuarantine,
} from './firewall.js';
import { killProcessTree, killProcessTreeSync } from './process-tree.js';
import {
  extractOneLineSummary,
  extractParameterNames,
  ToolSearchIndex,
} from './search.js';
import type {
  DownstreamCallResult,
  DownstreamServerConfig,
  IndexedTool,
  RawDownstreamTool,
  SlimConfig,
} from './types.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
const MCP_PROTOCOL_VERSION = '2024-11-05';
const MAX_STDERR_BUFFER_CHARS = 4096;
const MAX_TOOL_PAGES = 50;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export class DownstreamConnection {
  public readonly serverName: string;
  private readonly config: DownstreamServerConfig;
  private readonly defaultTimeoutMs: number;
  private child: ChildProcess | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stdoutRemainder = '';
  private stderrTail = '';
  private connected = false;
  private closing = false;
  private connectPromise: Promise<void> | null = null;

  constructor(serverName: string, config: DownstreamServerConfig, defaultTimeoutMs: number) {
    this.serverName = serverName;
    this.config = config;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  public getPid(): number | undefined {
    return this.child?.pid;
  }

  public isConnected(): boolean {
    return this.connected && this.child !== null;
  }

  public async ensureConnected(): Promise<void> {
    if (this.isConnected()) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = this.spawnAndInitialize().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async spawnAndInitialize(): Promise<void> {
    this.closing = false;
    this.stdoutRemainder = '';
    this.stderrTail = '';

    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(this.config.env ?? {}),
    };

    const child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: mergedEnv,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    this.child = child;
    const decoder = new StringDecoder('utf8');

    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.child !== child) {
        return;
      }
      this.handleStdoutChunk(decoder.write(chunk));
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (this.child !== child) {
        return;
      }
      const text = chunk.toString('utf8');
      this.stderrTail = (this.stderrTail + text).slice(-MAX_STDERR_BUFFER_CHARS);
    });

    child.once('error', (err: Error) => {
      if (this.child !== child) {
        return;
      }
      this.connected = false;
      this.rejectAllPending(
        new Error(
          `Downstream server "${this.serverName}" process error: ${err.message}${this.formatStderrSuffix()}`
        )
      );
    });

    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.child !== child) {
        return;
      }
      this.connected = false;
      this.child = null;
      if (!this.closing) {
        this.rejectAllPending(
          new Error(
            `Downstream server "${this.serverName}" exited unexpectedly (code=${String(code)}, signal=${String(signal)})${this.formatStderrSuffix()}`
          )
        );
      }
    });

    try {
      await this.sendRequest(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: '@pie527645-cloud/mcp-slim-proxy',
            version: '0.1.0',
          },
        },
        this.defaultTimeoutMs
      );

      this.sendNotification('notifications/initialized');
      this.connected = true;
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  private formatStderrSuffix(): string {
    const trimmed = this.stderrTail.trim();
    if (!trimmed) {
      return '';
    }
    return ` | stderr: ${trimmed.slice(0, 400)}`;
  }

  private handleStdoutChunk(text: string): void {
    const combined = this.stdoutRemainder + text;
    let start = 0;
    while (start < combined.length) {
      const newlineIdx = combined.indexOf('\n', start);
      if (newlineIdx === -1) {
        break;
      }
      const line = combined.slice(start, newlineIdx).replace(/\r$/, '').trim();
      start = newlineIdx + 1;
      if (line.length > 0) {
        this.handleJsonRpcLine(line);
      }
    }
    this.stdoutRemainder = combined.slice(start);
  }

  private handleJsonRpcLine(line: string): void {
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }

    if (typeof parsed !== 'object' || parsed === null || typeof parsed.id !== 'number') {
      return;
    }

    const entry = this.pending.get(parsed.id);
    if (!entry) {
      return;
    }

    this.pending.delete(parsed.id);
    clearTimeout(entry.timer);

    if (parsed.error) {
      const code = parsed.error.code !== undefined ? ` (code ${parsed.error.code})` : '';
      const message = parsed.error.message ?? 'Unknown JSON-RPC error';
      entry.reject(
        new Error(`Downstream "${this.serverName}" ${entry.method} failed${code}: ${message}`)
      );
      return;
    }

    entry.resolve(parsed.result);
  }

  private rejectAllPending(error: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      return;
    }
    const payload =
      params !== undefined
        ? { jsonrpc: '2.0', method, params }
        : { jsonrpc: '2.0', method };
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // Ignore write failures on closing pipe.
    }
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown> {
    const activeChild = this.child;
    if (!activeChild?.stdin || activeChild.stdin.destroyed) {
      return Promise.reject(
        new Error(`Downstream server "${this.serverName}" stdin pipe is not writable.`)
      );
    }

    const id = this.nextRequestId++;
    const message = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.sendNotification('notifications/cancelled', {
          requestId: id,
          reason: `Timed out after ${timeoutMs}ms`,
        });
        // Reap the hung child tree (including any grandchildren) on timeout.
        void this.close().finally(() => {
          reject(
            new Error(
              `Downstream server "${this.serverName}" timed out on "${method}" after ${timeoutMs}ms.`
            )
          );
        });
      }, timeoutMs);
      timer.unref();

      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
      });

      activeChild.stdin!.write(`${message}\n`, (writeErr) => {
        if (writeErr) {
          const existing = this.pending.get(id);
          if (existing) {
            clearTimeout(existing.timer);
            this.pending.delete(id);
            existing.reject(
              new Error(
                `Failed writing "${method}" request to downstream "${this.serverName}": ${writeErr.message}`
              )
            );
          }
        }
      });
    });
  }

  public async listTools(timeoutMs = this.defaultTimeoutMs): Promise<RawDownstreamTool[]> {
    await this.ensureConnected();
    const collected: RawDownstreamTool[] = [];
    let cursor: string | undefined = undefined;

    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const params: Record<string, unknown> = cursor ? { cursor } : {};
      const rawResult = (await this.sendRequest('tools/list', params, timeoutMs)) as {
        tools?: unknown[];
        nextCursor?: unknown;
      } | null;

      if (rawResult && Array.isArray(rawResult.tools)) {
        for (const item of rawResult.tools) {
          if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
            const candidate = item as {
              name: string;
              description?: unknown;
              inputSchema?: unknown;
              annotations?: unknown;
            };
            collected.push({
              name: candidate.name,
              description: typeof candidate.description === 'string' ? candidate.description : undefined,
              inputSchema:
                candidate.inputSchema &&
                typeof candidate.inputSchema === 'object' &&
                !Array.isArray(candidate.inputSchema)
                  ? (candidate.inputSchema as Record<string, unknown>)
                  : { type: 'object', properties: {} },
              annotations:
                candidate.annotations &&
                typeof candidate.annotations === 'object' &&
                !Array.isArray(candidate.annotations)
                  ? (candidate.annotations as Record<string, unknown>)
                  : undefined,
            });
          }
        }
      }

      if (rawResult && typeof rawResult.nextCursor === 'string' && rawResult.nextCursor.length > 0) {
        cursor = rawResult.nextCursor;
      } else {
        break;
      }
    }

    return collected;
  }

  public async callTool(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = this.defaultTimeoutMs
  ): Promise<DownstreamCallResult> {
    await this.ensureConnected();
    const rawResult = (await this.sendRequest(
      'tools/call',
      {
        name: toolName,
        arguments: args,
      },
      timeoutMs
    )) as {
      content?: unknown;
      isError?: unknown;
      structuredContent?: unknown;
    } | null;

    const content = Array.isArray(rawResult?.content)
      ? (rawResult.content as DownstreamCallResult['content'])
      : [];

    return {
      content,
      isError: rawResult?.isError === true,
      structuredContent: rawResult?.structuredContent,
    };
  }

  public killSync(): void {
    this.closing = true;
    this.connected = false;
    const active = this.child;
    this.child = null;
    this.rejectAllPending(new Error(`Downstream server "${this.serverName}" was terminated.`));
    if (active) {
      killProcessTreeSync(active);
    }
  }

  public async close(): Promise<void> {
    this.closing = true;
    this.connected = false;
    const active = this.child;
    this.child = null;
    this.rejectAllPending(new Error(`Downstream server "${this.serverName}" was closed.`));
    if (active) {
      await killProcessTree(active);
    }
  }
}

export interface DownstreamManagerOptions {
  quarantineEnabled?: boolean;
  timeoutMs?: number;
}

export class DownstreamManager {
  private readonly config: SlimConfig;
  public readonly quarantineEnabled: boolean;
  public readonly timeoutMs: number;
  private readonly connections = new Map<string, DownstreamConnection>();
  private tools: IndexedTool[] = [];
  private searchIndex: ToolSearchIndex = new ToolSearchIndex([]);
  private exitHookRegistered = false;
  private readonly boundExitHandler = (): void => {
    this.killAllSync();
  };

  constructor(config: SlimConfig, options?: DownstreamManagerOptions) {
    this.config = config;
    this.quarantineEnabled = options?.quarantineEnabled !== false;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public async start(): Promise<void> {
    this.registerExitHooks();
    const serverEntries = Object.entries(this.config.mcpServers);
    const discovered: IndexedTool[] = [];

    try {
      for (const [serverName, serverCfg] of serverEntries) {
        const conn = new DownstreamConnection(serverName, serverCfg, this.timeoutMs);
        this.connections.set(serverName, conn);
        const rawTools = await conn.listTools(this.timeoutMs);

        for (const rawTool of rawTools) {
          const serialized = JSON.stringify(rawTool);
          const rawSchemaChars = serialized.length;
          const rawSchemaBytes = Buffer.byteLength(serialized, 'utf8');
          const rawSchemaTokens = estimateTokensFromChars(rawSchemaChars);

          const findings = scanToolForPoisoning(rawTool);
          const quarantined = this.quarantineEnabled && shouldQuarantine(findings);
          const toolId = `${serverName}.${rawTool.name}`;
          const schemaObj = rawTool.inputSchema ?? { type: 'object', properties: {} };

          discovered.push({
            toolId,
            serverName,
            toolName: rawTool.name,
            description: rawTool.description ?? '',
            summary: extractOneLineSummary(rawTool.description, toolId),
            parameterNames: extractParameterNames(schemaObj),
            inputSchema: schemaObj,
            rawSchemaBytes,
            rawSchemaChars,
            rawSchemaTokens,
            quarantined,
            findings,
          });
        }
      }

      detectCrossToolShadowing(discovered, this.quarantineEnabled);
      this.tools = discovered;
      this.searchIndex = new ToolSearchIndex(discovered);
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  public getAllTools(): readonly IndexedTool[] {
    return this.tools;
  }

  public getSearchIndex(): ToolSearchIndex {
    return this.searchIndex;
  }

  public getConnectionPids(): Record<string, number | undefined> {
    const out: Record<string, number | undefined> = {};
    for (const [name, conn] of this.connections.entries()) {
      out[name] = conn.getPid();
    }
    return out;
  }

  public describeHealthyTool(toolId: string): {
    toolId: string;
    server: string;
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  } {
    const tool = this.searchIndex.getToolOrThrow(toolId);
    return {
      toolId: tool.toolId,
      server: tool.serverName,
      name: tool.toolName,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
  }

  public async invokeHealthyTool(
    toolId: string,
    args: Record<string, unknown> = {},
    timeoutOverrideMs?: number
  ): Promise<DownstreamCallResult> {
    const tool = this.searchIndex.getToolOrThrow(toolId);
    const conn = this.connections.get(tool.serverName);
    if (!conn) {
      throw new Error(`No downstream connection found for server "${tool.serverName}".`);
    }
    return conn.callTool(tool.toolName, args, timeoutOverrideMs ?? this.timeoutMs);
  }

  private registerExitHooks(): void {
    if (this.exitHookRegistered) {
      return;
    }
    this.exitHookRegistered = true;
    process.on('exit', this.boundExitHandler);
  }

  private unregisterExitHooks(): void {
    if (!this.exitHookRegistered) {
      return;
    }
    this.exitHookRegistered = false;
    process.off('exit', this.boundExitHandler);
  }

  public killAllSync(): void {
    for (const conn of this.connections.values()) {
      conn.killSync();
    }
  }

  public async close(): Promise<void> {
    this.unregisterExitHooks();
    const conns = Array.from(this.connections.values());
    this.connections.clear();
    await Promise.allSettled(conns.map((c) => c.close()));
  }
}

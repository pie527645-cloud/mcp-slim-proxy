import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { killProcessTree } from '../src/process-tree.js';
import type { SavingsReport } from '../src/types.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const distCliPath = path.join(repoRoot, 'dist', 'cli.js');
const distMcpPath = path.join(repoRoot, 'dist', 'mcp.js');
const cleanServerScript = fileURLToPath(
  new URL('./fixtures/mock-clean-server.js', import.meta.url)
);
const poisonedServerScript = fileURLToPath(
  new URL('./fixtures/mock-poisoned-server.js', import.meta.url)
);

function execNodeCli(
  scriptPath: string,
  args: string[],
  envExtra?: Record<string, string>
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...(envExtra ?? {}) },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe('CLI & Live Stdio MCP Server End-to-End', () => {
  it('prints help and version cleanly on dist/cli.js and dist/mcp.js', async () => {
    const cliHelp = await execNodeCli(distCliPath, ['--help']);
    assert.equal(cliHelp.code, 0);
    assert.match(cliHelp.stdout, /mcp-slim-proxy v0\.1\.0/);
    assert.match(cliHelp.stdout, /savings/);

    const mcpHelp = await execNodeCli(distMcpPath, ['--help']);
    assert.equal(mcpHelp.code, 0);
    assert.match(mcpHelp.stdout, /mcp-slim-proxy-server v0\.1\.0/);

    const ver = await execNodeCli(distCliPath, ['--version']);
    assert.equal(ver.code, 0);
    assert.equal(ver.stdout.trim(), '0.1.0');
  });

  it('runs mcp-slim-proxy savings in both json and pretty formats and exits cleanly', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slim-cli-savings-'));
    const cfgPath = path.join(tmpDir, 'slim-config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        mcpServers: {
          commerce: { command: process.execPath, args: [cleanServerScript] },
          external: { command: process.execPath, args: [poisonedServerScript] },
        },
      }),
      'utf8'
    );

    try {
      const jsonRun = await execNodeCli(distCliPath, [
        'savings',
        '--config',
        cfgPath,
        '--format',
        'json',
      ]);
      assert.equal(jsonRun.code, 0, `stderr: ${jsonRun.stderr}`);
      const report = JSON.parse(jsonRun.stdout) as SavingsReport;
      assert.equal(report.totals.rawToolCount, 18);
      assert.equal(report.totals.quarantinedCount, 5);
      assert.equal(report.totals.proxiedMetaToolCount, 4);
      assert.ok(report.totals.percentSaved > 55);

      const prettyRun = await execNodeCli(
        distCliPath,
        ['savings', '--format', 'pretty'],
        { MCP_SLIM_CONFIG: cfgPath }
      );
      assert.equal(prettyRun.code, 0, `stderr: ${prettyRun.stderr}`);
      assert.match(prettyRun.stdout, /Context Token Savings & Firewall Audit/);
      assert.match(prettyRun.stdout, /Quarantined Poisoned Tools \(5\)/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('serves all 4 meta-tools over live stdio on dist/mcp.js including end-to-end run_pipeline', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slim-mcp-stdio-'));
    const cfgPath = path.join(tmpDir, 'slim-config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        mcpServers: {
          commerce: { command: process.execPath, args: [cleanServerScript] },
          external: { command: process.execPath, args: [poisonedServerScript] },
        },
      }),
      'utf8'
    );

    const proxyProc = spawn(process.execPath, [distMcpPath, '--config', cfgPath], {
      cwd: repoRoot,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    const pending = new Map<number, (msg: Record<string, unknown>) => void>();
    const decoder = new StringDecoder('utf8');
    let buffer = '';

    proxyProc.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '').trim();
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (typeof parsed['id'] === 'number') {
            const resolver = pending.get(parsed['id']);
            if (resolver) {
              pending.delete(parsed['id']);
              resolver(parsed);
            }
          }
        }
        idx = buffer.indexOf('\n');
      }
    });

    let nextId = 1;
    const rpcCall = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC ${method} timed out`));
        }, 10_000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        proxyProc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    };

    try {
      const initRes = await rpcCall('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'e2e-test-client', version: '1.0.0' },
      });
      assert.ok(initRes['result']);
      proxyProc.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
      );

      // 1. tools/list returns strictly the 4 ultra-lean meta-tools
      const listRes = (await rpcCall('tools/list', {})) as {
        result: { tools: Array<{ name: string }> };
      };
      const toolNames = listRes.result.tools.map((t) => t.name);
      assert.deepEqual(toolNames, [
        'search_tools',
        'describe_tool',
        'invoke_tool',
        'run_pipeline',
      ]);

      // 2. search_tools finds healthy tools via BM25
      const searchRes = (await rpcCall('tools/call', {
        name: 'search_tools',
        arguments: { query: 'invoice order customer', limit: 5 },
      })) as { result: { content: Array<{ text: string }> } };
      const searchPayload = JSON.parse(searchRes.result.content[0]!.text) as {
        totalHealthyTools: number;
        tools: Array<{ toolId: string }>;
      };
      assert.equal(searchPayload.totalHealthyTools, 13);
      assert.ok(searchPayload.tools.some((t) => t.toolId === 'commerce.format_invoice'));

      // 3. describe_tool returns full schema lazily
      const descRes = (await rpcCall('tools/call', {
        name: 'describe_tool',
        arguments: { toolId: 'commerce.format_invoice' },
      })) as { result: { content: Array<{ text: string }> } };
      const descPayload = JSON.parse(descRes.result.content[0]!.text) as {
        toolId: string;
        inputSchema: Record<string, unknown>;
      };
      assert.equal(descPayload.toolId, 'commerce.format_invoice');
      assert.equal(descPayload.inputSchema['type'], 'object');

      // 4. run_pipeline chains 3 tools across JSON outputs outside LLM context
      const pipeRes = (await rpcCall('tools/call', {
        name: 'run_pipeline',
        arguments: {
          steps: [
            {
              id: 'ord',
              toolId: 'commerce.fetch_order',
              arguments: { orderId: 'ORD-5500' },
            },
            {
              id: 'cust',
              toolId: 'commerce.fetch_customer',
              arguments: { customerId: '${steps.0.json.customer.id}' },
            },
            {
              toolId: 'commerce.format_invoice',
              arguments: {
                orderId: '${steps.ord.json.orderId}',
                customerId: '${steps.0.json.customer.id}',
                region: '${steps.1.json.region}',
                discountPct: '${steps.cust.json.discountPct}',
                firstSku: '${steps.0.json.items.0.sku}',
              },
            },
          ],
        },
      })) as { result: { isError?: boolean; content: Array<{ text: string }> } };

      assert.notEqual(pipeRes.result.isError, true);
      const pipePayload = JSON.parse(pipeRes.result.content[0]!.text) as {
        stepsExecuted: number;
        finalOutput: { text: string };
      };
      assert.equal(pipePayload.stepsExecuted, 3);
      assert.match(pipePayload.finalOutput.text, /Invoice for ORD-5500/);
      assert.match(pipePayload.finalOutput.text, /Customer=CUST-42/);
      assert.match(pipePayload.finalOutput.text, /Region=APAC/);
      assert.match(pipePayload.finalOutput.text, /Discount=15%/);
      assert.match(pipePayload.finalOutput.text, /PrimarySKU=SKU-LAPTOP-14/);

      // 5. Quarantined tool call via invoke_tool returns isError: true
      const blockedRes = (await rpcCall('tools/call', {
        name: 'invoke_tool',
        arguments: {
          toolId: 'external.override_directive_tool',
          arguments: { content: 'hello' },
        },
      })) as { result: { isError?: boolean; content: Array<{ text: string }> } };
      assert.equal(blockedRes.result.isError, true);
      assert.match(blockedRes.result.content[0]!.text, /quarantined/i);
    } finally {
      await killProcessTree(proxyProc);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DownstreamManager } from '../src/downstream.js';
import { extractTextFromCallResult } from '../src/pipeline.js';
import { buildSavingsReport } from '../src/server.js';
import type { SlimConfig } from '../src/types.js';

const cleanServerScript = fileURLToPath(
  new URL('./fixtures/mock-clean-server.js', import.meta.url)
);
const poisonedServerScript = fileURLToPath(
  new URL('./fixtures/mock-poisoned-server.js', import.meta.url)
);

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidDead(pid: number, maxWaitMs = 3000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return !isPidAlive(pid);
}

describe('DownstreamManager Multiplexer, Quarantine, Savings & Tree Reaping', () => {
  it('multiplexes servers, quarantines all 5 poisoned tools, supports lazy describe/invoke, and computes accurate savings', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slim-proxy-test-'));
    const startupPidFile = path.join(tmpDir, 'startup-pids.json');

    const config: SlimConfig = {
      mcpServers: {
        commerce: {
          command: process.execPath,
          args: [cleanServerScript],
          env: { MOCK_PID_FILE: startupPidFile },
        },
        external: {
          command: process.execPath,
          args: [poisonedServerScript],
        },
      },
    };

    const manager = new DownstreamManager(config, {
      quarantineEnabled: true,
      timeoutMs: 8000,
    });

    try {
      await manager.start();

      // 12 clean tools on commerce + 8 tools on external (1 healthy + 7 poisoned) = 20 total
      const report = buildSavingsReport(manager);
      assert.equal(report.totals.downstreamServers, 2);
      assert.equal(report.totals.rawToolCount, 20);
      assert.equal(report.totals.quarantinedCount, 7);
      assert.equal(report.totals.healthyToolCount, 13);
      assert.ok(
        report.totals.rawSchemaTokens > report.totals.proxiedSchemaTokens,
        `Expected raw tokens (${report.totals.rawSchemaTokens}) > proxied tokens (${report.totals.proxiedSchemaTokens})`
      );
      assert.ok(report.totals.percentSaved > 55);

      // Healthy search works and excludes all quarantined tools (including padded/deep bypass attempts)
      const hits = manager.getSearchIndex().search('order customer');
      assert.ok(hits.some((h) => h.toolId === 'commerce.fetch_order'));
      assert.equal(
        hits.some((h) => h.toolId === 'external.shadow_order_interceptor'),
        false
      );
      const allHealthyHits = manager.getSearchIndex().search('*', { limit: 50 });
      assert.equal(
        allHealthyHits.some((h) => h.toolId === 'external.padded_650_props_tool'),
        false
      );
      assert.equal(
        allHealthyHits.some((h) => h.toolId === 'external.deep_nested_20_tool'),
        false
      );

      // Lazy describe_tool works on healthy tools
      const desc = manager.describeHealthyTool('commerce.fetch_order');
      assert.equal(desc.server, 'commerce');
      assert.equal(desc.name, 'fetch_order');
      assert.ok('orderId' in (desc.inputSchema['properties'] as Record<string, unknown>));

      // Healthy invoke_tool works on both servers
      const orderRes = await manager.invokeHealthyTool('commerce.fetch_order', {
        orderId: 'ORD-1234',
      });
      const orderJson = JSON.parse(extractTextFromCallResult(orderRes)) as { orderId: string };
      assert.equal(orderJson.orderId, 'ORD-1234');

      const pingRes = await manager.invokeHealthyTool('external.ping_status', {});
      assert.deepEqual(JSON.parse(extractTextFromCallResult(pingRes)), { status: 'healthy' });

      // Quarantined tools (including oversized >1000-node and depth >16 schemas) are strictly blocked on both describe and invoke
      const quarantinedIds = [
        'external.unicode_smuggled_note',
        'external.comment_hidden_tool',
        'external.override_directive_tool',
        'external.sensitive_path_tool',
        'external.shadow_order_interceptor',
        'external.padded_650_props_tool',
        'external.deep_nested_20_tool',
      ];
      for (const qId of quarantinedIds) {
        assert.throws(() => manager.describeHealthyTool(qId), /quarantined/i);
        await assert.rejects(() => manager.invokeHealthyTool(qId, {}), /quarantined/i);
      }
    } finally {
      await manager.close();
    }

    // Verify both child and startup grandchild were reaped cleanly on manager.close()
    assert.equal(fs.existsSync(startupPidFile), true);
    const startupPids = JSON.parse(fs.readFileSync(startupPidFile, 'utf8')) as {
      serverPid: number;
      grandchildPid: number;
    };
    assert.equal(await waitForPidDead(startupPids.serverPid), true, 'Server child PID should be reaped');
    assert.equal(
      await waitForPidDead(startupPids.grandchildPid),
      true,
      'Server grandchild PID should be reaped'
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('allows disabling quarantine via quarantineEnabled: false while still recording detectedPoisonedCount', async () => {
    const config: SlimConfig = {
      mcpServers: {
        external: {
          command: process.execPath,
          args: [poisonedServerScript],
        },
      },
    };

    const manager = new DownstreamManager(config, {
      quarantineEnabled: false,
      timeoutMs: 8000,
    });

    try {
      await manager.start();
      const report = buildSavingsReport(manager);
      assert.equal(report.quarantineEnabled, false);
      assert.equal(report.totals.quarantinedCount, 0);
      assert.ok(report.totals.detectedPoisonedCount >= 6);
      assert.equal(report.totals.healthyToolCount, 8);
    } finally {
      await manager.close();
    }
  });

  it('reaps hung downstream child + grandchild on request timeout and recovers cleanly on next call', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slim-timeout-test-'));
    const hangPidFile = path.join(tmpDir, 'hang-pids.json');

    const config: SlimConfig = {
      mcpServers: {
        commerce: {
          command: process.execPath,
          args: [cleanServerScript],
        },
      },
    };

    const manager = new DownstreamManager(config, {
      quarantineEnabled: true,
      timeoutMs: 450,
    });

    try {
      await manager.start();

      await assert.rejects(
        () =>
          manager.invokeHealthyTool('commerce.slow_hang_with_grandchild', {
            pidFile: hangPidFile,
          }),
        /timed out/i
      );

      assert.equal(fs.existsSync(hangPidFile), true);
      const pids = JSON.parse(fs.readFileSync(hangPidFile, 'utf8')) as {
        serverPid: number;
        grandchildPid: number;
      };

      assert.equal(
        await waitForPidDead(pids.serverPid),
        true,
        'Timed-out child server should be reaped'
      );
      assert.equal(
        await waitForPidDead(pids.grandchildPid),
        true,
        'Timed-out grandchild process should be reaped'
      );

      // Verify automatic lazy reconnection works for subsequent healthy calls
      const recovered = await manager.invokeHealthyTool(
        'commerce.fetch_customer',
        { customerId: 'CUST-RECOVERED' },
        5000
      );
      const parsed = JSON.parse(extractTextFromCallResult(recovered)) as { customerId: string };
      assert.equal(parsed.customerId, 'CUST-RECOVERED');
    } finally {
      await manager.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('preserves multi-byte UTF-8 across split stdout and stderr pipe chunks', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slim-utf8-test-'));
    const splitServerScript = path.join(tmpDir, 'split-utf8-server.mjs');

    const scriptSource = `
import readline from 'node:readline';

const mode = process.argv[2];
if (mode === 'stderr-crash') {
  const errBytes = Buffer.from('初期化失敗🚀詳細ログ\\n', 'utf8');
  const rocketIdx = errBytes.indexOf(0xf0);
  process.stderr.write(errBytes.subarray(0, rocketIdx + 2));
  setTimeout(() => {
    process.stderr.write(errBytes.subarray(rocketIdx + 2), () => {
      process.exit(1);
    });
  }, 25);
} else {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'utf8-mock', version: '0.1.0' }
        }
      }) + '\\n');
    } else if (msg.method === 'tools/list') {
      const payload = Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [{
            name: 'utf8_echo',
            description: 'マルチバイト🚀説明文',
            inputSchema: { type: 'object', properties: {} }
          }]
        }
      }) + '\\n', 'utf8');
      const rocketIdx = payload.indexOf(0xf0);
      process.stdout.write(payload.subarray(0, rocketIdx + 2));
      setTimeout(() => {
        process.stdout.write(payload.subarray(rocketIdx + 2));
      }, 25);
    }
  });
  setInterval(() => {}, 10000);
}
`;
    fs.writeFileSync(splitServerScript, scriptSource, 'utf8');

    const crashManager = new DownstreamManager(
      {
        mcpServers: {
          broken: {
            command: process.execPath,
            args: [splitServerScript, 'stderr-crash'],
          },
        },
      },
      { timeoutMs: 5000 }
    );

    const healthyManager = new DownstreamManager(
      {
        mcpServers: {
          utf8srv: {
            command: process.execPath,
            args: [splitServerScript, 'stdout-ok'],
          },
        },
      },
      { timeoutMs: 5000 }
    );

    try {
      await assert.rejects(
        () => crashManager.start(),
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          assert.ok(message.includes('初期化失敗🚀詳細ログ'), `Unexpected error message: ${message}`);
          assert.equal(message.includes('\uFFFD'), false);
          return true;
        }
      );

      await healthyManager.start();
      const desc = healthyManager.describeHealthyTool('utf8srv.utf8_echo');
      assert.equal(desc.description, 'マルチバイト🚀説明文');
      assert.equal(desc.description.includes('\uFFFD'), false);
    } finally {
      await crashManager.close();
      await healthyManager.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

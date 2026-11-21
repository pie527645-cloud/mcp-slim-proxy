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

      // 12 clean tools on commerce + 6 tools on external (1 healthy + 5 poisoned) = 18 total
      const report = buildSavingsReport(manager);
      assert.equal(report.totals.downstreamServers, 2);
      assert.equal(report.totals.rawToolCount, 18);
      assert.equal(report.totals.quarantinedCount, 5);
      assert.equal(report.totals.healthyToolCount, 13);
      assert.ok(
        report.totals.rawSchemaTokens > report.totals.proxiedSchemaTokens,
        `Expected raw tokens (${report.totals.rawSchemaTokens}) > proxied tokens (${report.totals.proxiedSchemaTokens})`
      );
      assert.ok(report.totals.percentSaved > 55);

      // Healthy search works
      const hits = manager.getSearchIndex().search('order customer');
      assert.ok(hits.some((h) => h.toolId === 'commerce.fetch_order'));
      assert.equal(
        hits.some((h) => h.toolId === 'external.shadow_order_interceptor'),
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

      // Quarantined tools are strictly blocked on both describe and invoke
      const quarantinedIds = [
        'external.unicode_smuggled_note',
        'external.comment_hidden_tool',
        'external.override_directive_tool',
        'external.sensitive_path_tool',
        'external.shadow_order_interceptor',
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
      assert.ok(report.totals.detectedPoisonedCount >= 4);
      assert.equal(report.totals.healthyToolCount, 6);
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
});

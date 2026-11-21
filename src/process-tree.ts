import { spawn, type ChildProcess } from 'node:child_process';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runWindowsTaskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        try {
          killer.kill();
        } catch {
          // Ignore secondary errors while cleaning up taskkill.
        }
        finish();
      }, 3000);
      timer.unref();

      killer.once('error', () => {
        clearTimeout(timer);
        finish();
      });
      killer.once('close', () => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      finish();
    }
  });
}

export function killProcessTreeSync(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      });
      killer.unref();
    } catch {
      // Fallback to direct kill below.
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // Process already exited.
    }
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Process already exited.
    }
  }
}

export async function killProcessTree(child: ChildProcess, graceMs = 150): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }

  try {
    child.stdin?.end();
  } catch {
    // Ignore closed stdin pipe.
  }

  if (process.platform === 'win32') {
    await runWindowsTaskkill(pid);
    if (isPidAlive(pid)) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore if already dead.
      }
    }
    return;
  }

  // POSIX: spawned with detached: true so pid is a process group leader.
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && isPidAlive(pid)) {
    await sleep(25);
  }

  if (isPidAlive(pid)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore if already dead.
      }
    }
  }
}

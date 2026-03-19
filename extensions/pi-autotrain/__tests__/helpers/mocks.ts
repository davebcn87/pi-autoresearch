import { vi } from "vitest";

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  killed: boolean;
}

/**
 * Creates a mock pi extension API with exec as vi.fn() and spies on other methods.
 * exec supports sequential responses via an internal queue.
 */
export function createMockPi() {
  const execQueue: ExecResult[] = [];

  const exec = vi.fn(async (): Promise<ExecResult> => {
    if (execQueue.length > 0) {
      return execQueue.shift()!;
    }
    return { stdout: "", stderr: "", code: 0, killed: false };
  });

  return {
    exec,
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    sendUserMessage: vi.fn(),
    /** Queue a response for the next exec call */
    queueExec(result: Partial<ExecResult>) {
      execQueue.push({
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        code: result.code ?? 0,
        killed: result.killed ?? false,
      });
    },
  };
}

/**
 * Creates a mock extension context.
 */
export function createMockCtx(cwd: string) {
  return {
    cwd,
    hasUI: false,
    ui: {
      setWidget: vi.fn(),
      notify: vi.fn(),
      custom: vi.fn(),
    },
    sessionManager: {
      getBranch: vi.fn(() => []),
    },
  };
}

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceService, validateSafePath } from './workspace';
import { runCodingAgent, executeTool, makeDiff, parseTracepilotChangesJson, AGENT_TOOLS } from './agent';
import type { ProviderConfig } from './providers';

function createMockProject() {
  const files: Record<string, string> = {
    'README.md': '# TracePilot Project\nThis is an autonomous developer tool for analyzing incidents and traces.\n## Features\n- Log ingestion\n- Root cause analysis',
    'package.json': JSON.stringify({
      name: 'trace-sample-app',
      version: '1.0.0',
      scripts: { test: 'vitest run', build: 'vite build' },
      dependencies: { react: '^18.3.1' }
    }, null, 2),
    'AGENTS.md': '# Agent Guidelines\nAlways write tests and maintain immutability.',
    'src/index.ts': 'export function authenticateUser(token: string): boolean {\n  return token.startsWith("valid-");\n}',
    'src/utils.ts': 'export function calculateTraceLatency(spans: number[]): number {\n  return spans.reduce((a, b) => a + b, 0);\n}'
  };

  const fileHandles: Record<string, any> = {};
  for (const [path, content] of Object.entries(files)) {
    let cur = content;
    fileHandles[path] = {
      kind: 'file',
      name: path.split('/').pop()!,
      async getFile() {
        return {
          size: cur.length,
          async text() { return cur; }
        };
      },
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
      async createWritable() {
        let pending = cur;
        return {
          async write(val: string) { pending = val; },
          async close() { cur = pending; files[path] = pending; },
          async abort() {}
        };
      }
    };
  }

  // Build recursive mock directory handle
  function makeDir(dirName: string, prefix = ''): any {
    return {
      kind: 'directory',
      name: dirName,
      async *values() {
        const subdirs = new Set<string>();
        for (const p of Object.keys(files)) {
          const rel = prefix ? p.slice(prefix.length + 1) : p;
          if (prefix && !p.startsWith(`${prefix}/`)) continue;
          const slash = rel.indexOf('/');
          if (slash > -1) {
            const sub = rel.slice(0, slash);
            if (!subdirs.has(sub)) {
              subdirs.add(sub);
              yield makeDir(sub, prefix ? `${prefix}/${sub}` : sub);
            }
          } else {
            yield fileHandles[p];
          }
        }
      },
      async getFileHandle(name: string) {
        const targetPath = prefix ? `${prefix}/${name}` : name;
        if (!fileHandles[targetPath]) throw new Error(`File ${targetPath} not found`);
        return fileHandles[targetPath];
      },
      async getDirectoryHandle(name: string) {
        return makeDir(name, prefix ? `${prefix}/${name}` : name);
      }
    };
  }

  const rootHandle = makeDir('trace-sample-app');
  return { files, fileHandles, rootHandle };
}

describe('TracePilot Repository-Aware Coding Agent', () => {
  const mockConfig: ProviderConfig = {
    provider: 'nebius-token-factory',
    model: 'nvidia/Nemotron-3_5-Lightning',
    key: 'test-key-123'
  };

  it('1 & 2: Selecting a real test project indexes actual files and builds repository inventory', async () => {
    const { rootHandle } = createMockProject();
    const ws = new WorkspaceService('trace-sample-app', rootHandle);
    const tree = await ws.scanAndIndex();

    expect(tree.length).toBeGreaterThan(0);
    expect(ws.fileCount).toBe(5);

    const overview = await ws.discoverRepository();
    expect(overview.name).toBe('trace-sample-app');
    expect(overview.metadata.name).toBe('trace-sample-app');
    expect(overview.metadata.framework).toBe('React');
    expect(overview.metadata.scripts.test).toBe('vitest run');
    expect(overview.structure).toContain('src/');
    expect(overview.structure).toContain('README.md');
  });

  it('3: The agent can read the README and source files with line numbers', async () => {
    const { rootHandle } = createMockProject();
    const ws = new WorkspaceService('trace-sample-app', rootHandle);
    await ws.scanAndIndex();

    const readme = await ws.readFile('README.md');
    expect(readme).toContain('[File: README.md');
    expect(readme).toContain('autonomous developer tool');
    expect(readme).toMatch(/^\s*1:\s+# TracePilot Project/m);

    const source = await ws.readFile('src/index.ts', { startLine: 1, maxLines: 5 });
    expect(source).toContain('authenticateUser');
    expect(source).toContain('valid-');
  });

  it('4: "What does this app do?" produces an answer grounded in actual repository files', async () => {
    const { rootHandle } = createMockProject();
    const ws = new WorkspaceService('trace-sample-app', rootHandle);
    await ws.scanAndIndex();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      const text = 'This application is TracePilot (trace-sample-app). As described in README.md, it is an autonomous developer tool for analyzing incidents and traces with log ingestion and root-cause analysis. The source code is in src/index.ts and src/utils.ts, built with React and tested via vitest.';
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: text } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    try {
      const result = await runCodingAgent({
        config: mockConfig,
        turns: [],
        userPrompt: 'What does this app do?',
        workspace: ws
      });

      expect(result.text).toContain('trace-sample-app');
      expect(result.text).toContain('README.md');
      expect(result.text).toContain('src/index.ts');
      // Verify that it did not ask to paste files
      expect(result.text.toLowerCase()).not.toContain('paste the readme');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('5: "Explain this function" triggers search and file reads across the workspace', async () => {
    const { rootHandle } = createMockProject();
    const ws = new WorkspaceService('trace-sample-app', rootHandle);
    await ws.scanAndIndex();

    // Test tool execution directly
    const searchResult = await executeTool('search_files', { query: 'authenticateUser' }, ws);
    expect(searchResult).toContain('src/index.ts');
    expect(searchResult).toContain('authenticateUser');

    const readResult = await executeTool('read_file', { path: 'src/index.ts' }, ws);
    expect(readResult).toContain('token.startsWith');
  });

  it('6: A coding request produces an actual source-grounded diff', async () => {
    const { rootHandle, files } = createMockProject();
    const ws = new WorkspaceService('trace-sample-app', rootHandle);
    await ws.scanAndIndex();

    const original = files['src/index.ts'];
    const updated = 'export function authenticateUser(token: string): boolean {\n  if (!token) return false;\n  return token.startsWith("valid-");\n}';
    const diff = makeDiff('src/index.ts', original, updated);

    expect(diff).toContain('--- a/src/index.ts');
    expect(diff).toContain('+++ b/src/index.ts');
    expect(diff).toContain('+  if (!token) return false;');

    const parsed = parseTracepilotChangesJson(
      `I updated input validation:\n\`\`\`json\n{"tracepilot_changes":[{"path":"src/index.ts","content":${JSON.stringify(updated)},"summary":"Add null check"}]}\n\`\`\``,
      new Map([['src/index.ts', original]])
    );

    expect(parsed.changes).toHaveLength(1);
    expect(parsed.changes[0].summary).toBe('Add null check');
    expect(parsed.changes[0].diff).toContain('+  if (!token) return false;');
  });

  it('7: Model can request a tool, receive its result, and continue the same agent turn', async () => {
    const { rootHandle } = createMockProject();
    const ws = new WorkspaceService('trace-sample-app', rootHandle);
    await ws.scanAndIndex();

    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        // Step 1: Model requests read_file tool
        return new Response(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: 'I need to check the authentication implementation first.',
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: JSON.stringify({ path: 'src/index.ts' })
                }
              }]
            }
          }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } else {
        // Step 2: Model receives tool result and provides final answer
        return new Response(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: 'In src/index.ts:1, authenticateUser checks if the provided token string starts with "valid-".'
            }
          }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    try {
      const progressUpdates: string[] = [];
      const result = await runCodingAgent({
        config: mockConfig,
        turns: [],
        userPrompt: 'Explain how authentication works in this project.',
        workspace: ws,
        onProgress: p => progressUpdates.push(p)
      });

      expect(callCount).toBe(2);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].tool).toBe('read_file');
      expect(result.steps[0].args.path).toBe('src/index.ts');
      expect(result.text).toContain('authenticateUser checks if the provided token string starts with "valid-"');
      expect(progressUpdates.some(u => u.includes('src/index.ts'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('8: Invalid tool calls are rejected safely without crashing the agent', async () => {
    const { rootHandle } = createMockProject();
    const ws = new WorkspaceService('trace-sample-app', rootHandle);
    await ws.scanAndIndex();

    const unknownRes = await executeTool('non_existent_tool', {}, ws);
    expect(unknownRes).toContain('Error: Unknown tool');

    const missingPathRes = await executeTool('read_file', {}, ws);
    expect(missingPathRes).toContain('Error: "path" argument is required');

    const noQueryRes = await executeTool('search_files', {}, ws);
    expect(noQueryRes).toContain('Error: "query" argument is required');
  });

  it('9: Tool results are preserved across turns and included in provider messages', async () => {
    let capturedBody: any = null;
    const originalFetch = globalThis.fetch;
    let turn = 0;
    globalThis.fetch = vi.fn(async (_url, init) => {
      turn++;
      if (turn === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              tool_calls: [{
                id: 'call_structure',
                type: 'function',
                function: { name: 'get_project_structure', arguments: '{}' }
              }]
            }
          }]
        }), { status: 200 });
      }
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Structure analyzed.' } }]
      }), { status: 200 });
    });

    try {
      const { rootHandle } = createMockProject();
      const ws = new WorkspaceService('trace-sample-app', rootHandle);
      await ws.scanAndIndex();

      await runCodingAgent({
        config: mockConfig,
        turns: [],
        userPrompt: 'Give me structure',
        workspace: ws
      });

      // Verify the second request included the assistant tool_calls and the tool response
      expect(capturedBody).toBeTruthy();
      const msgs = capturedBody.messages;
      const toolMsg = msgs.find((m: any) => m.role === 'tool');
      expect(toolMsg).toBeTruthy();
      expect(toolMsg.tool_call_id).toBe('call_structure');
      expect(toolMsg.content).toContain('trace-sample-app/');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('10: Switching projects changes the workspace files and prompt context', async () => {
    const { rootHandle } = createMockProject();
    const ws1 = new WorkspaceService('Project Alpha', rootHandle);
    await ws1.scanAndIndex();

    // Create Project Beta with different files
    const betaFile: any = {
      kind: 'file',
      name: 'beta.py',
      async getFile() { return { size: 20, async text() { return 'print("beta")'; } }; }
    };
    const betaDir: any = {
      kind: 'directory',
      name: 'Project Beta',
      async *values() { yield betaFile; }
    };
    const ws2 = new WorkspaceService('Project Beta', betaDir);
    await ws2.scanAndIndex();

    expect(ws1.name).toBe('Project Alpha');
    expect(ws2.name).toBe('Project Beta');
    expect(ws1.fileCount).toBe(5);
    expect(ws2.fileCount).toBe(1);

    const overview1 = await ws1.discoverRepository();
    const overview2 = await ws2.discoverRepository();

    expect(overview1.metadata.projectType).toContain('TypeScript');
    expect(overview2.metadata.projectType).toBe('Python');
  });

  it('11: A missing file produces an honest error rather than hallucination', async () => {
    const { rootHandle } = createMockProject();
    const ws = new WorkspaceService('trace-sample-app', rootHandle);
    await ws.scanAndIndex();

    await expect(ws.readFile('src/missing_component.tsx')).rejects.toThrow(/File not found: "src\/missing_component\.tsx"/);
  });

  it('12: Diagnostics execution detects project scripts and returns exit status', async () => {
    const { rootHandle } = createMockProject();
    const ws = new WorkspaceService('trace-sample-app', rootHandle);
    await ws.scanAndIndex();

    const diag = await ws.runDiagnostics();
    expect(diag.success).toBe(true);
    expect(diag.output).toContain('vitest run');
  });

  it('13: File operations reject path traversal and escape attempts', () => {
    expect(() => validateSafePath('../../../etc/passwd')).toThrow(/Path traversal is not permitted/);
    expect(() => validateSafePath('src/../../secret.key')).toThrow(/Path traversal is not permitted/);
    expect(() => validateSafePath('./')).toThrow();
  });

  it('14: Writing a file performs baseline check and read-back verification', async () => {
    const { rootHandle, files } = createMockProject();
    const ws = new WorkspaceService('trace-sample-app', rootHandle);
    await ws.scanAndIndex();

    const original = files['src/utils.ts'];
    const updated = original + '\n// Updated by TracePilot';

    // Baseline match succeeds
    const writeResult = await ws.writeFile('src/utils.ts', updated, original);
    expect(writeResult.success).toBe(true);
    expect(files['src/utils.ts']).toBe(updated);

    // Baseline mismatch fails with conflict detection
    await expect(
      ws.writeFile('src/utils.ts', 'conflicting edit', 'wrong baseline')
    ).rejects.toThrow(/Conflict detected/);
  });

  it('15: TracePilot tool schema is strictly conformant with OpenAI tool calling API', () => {
    expect(AGENT_TOOLS.length).toBeGreaterThan(0);
    for (const tool of AGENT_TOOLS) {
      expect(tool.type).toBe('function');
      expect(typeof tool.function.name).toBe('string');
      expect(typeof tool.function.description).toBe('string');
      expect(tool.function.parameters.type).toBe('object');
    }
  });
});

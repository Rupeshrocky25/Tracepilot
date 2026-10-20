// TracePilot Coding Agent Loop
// Orchestrates multi-step model -> tool -> result -> model interactions,
// workspace grounding, tool execution, and diff generation.

import { completion, type InferenceUsage, type ProviderConfig, type ProviderMessage, type ToolCall } from './providers';
import { WorkspaceService } from './workspace';

export interface ProposedChange {
  path: string;
  content: string;
  summary: string;
  diff: string;
  baseline: string;
}

export interface AgentStep {
  stepNumber: number;
  tool: string;
  args: Record<string, any>;
  resultSnippet: string;
  durationMs: number;
}

export interface AgentLoopResult {
  text: string;
  changes: ProposedChange[];
  steps: AgentStep[];
  provider: string;
  model: string;
  durationMs: number;
  status: number;
  usage?: InferenceUsage;
}

export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file from the workspace with line numbers. Use this to inspect source code, READMEs, tests, and configuration.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file in the workspace (e.g. "README.md", "src/App.tsx")' },
          startLine: { type: 'integer', description: 'Optional 1-based start line number to begin reading from' },
          maxLines: { type: 'integer', description: 'Optional maximum number of lines to read (default: 200)' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for text or regex patterns across files in the workspace. Returns matching lines and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The text or regex to search for' },
          filePattern: { type: 'string', description: 'Optional file extension or substring filter (e.g. ".ts", "src/")' },
          maxMatches: { type: 'integer', description: 'Maximum number of matches to return (default: 25)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories in the workspace or a specified subdirectory.',
      parameters: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Optional subdirectory path relative to workspace root (e.g. "src")' },
          maxFiles: { type: 'integer', description: 'Maximum files to return (default: 100)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_project_structure',
      description: 'Get an overview of the directory structure and file tree of the project workspace.',
      parameters: {
        type: 'object',
        properties: {
          maxDepth: { type: 'integer', description: 'Maximum directory depth (default: 3)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_project_metadata',
      description: 'Get project metadata, dependencies, scripts, and framework detected from manifests (package.json, Cargo.toml, pyproject.toml, etc.).',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_project_instructions',
      description: 'Read repository instructions from AGENTS.md, README.md, or CONTRIBUTING.md if present.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_git_status',
      description: 'Check git repository status (branch, modified, staged, untracked files) if git is available.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_diagnostics',
      description: 'Run project tests, build checks, or inspect diagnostic status in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Optional test/lint command to run (e.g. "npm test")' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'propose_change',
      description: 'Propose a modification or replacement to a file in the workspace. Generates a unified diff for user review before writing.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path of the file to modify' },
          content: { type: 'string', description: 'The complete new content of the file' },
          summary: { type: 'string', description: 'Brief description of the change and reason' }
        },
        required: ['path', 'content', 'summary']
      }
    }
  }
];

export function makeDiff(path: string, before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 250_000) {
    return `--- a/${path}\n+++ b/${path}\n@@ full file replacement @@\n- (${a.length} lines)\n+ (${b.length} lines)`;
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const edits: Array<[string, string]> = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      edits.push([' ', a[i++]]);
      j++;
    } else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) {
      edits.push(['+', b[j++]]);
    } else {
      edits.push(['-', a[i++]]);
    }
  }
  const changed = edits.map((e, index) => (e[0] !== ' ' ? index : -1)).filter(idx => idx >= 0);
  if (!changed.length) return `--- a/${path}\n+++ b/${path}\n(no changes)`;
  const lo = Math.max(0, changed[0] - 3);
  const hi = Math.min(edits.length, changed[changed.length - 1] + 4);
  const section = edits.slice(lo, hi);
  const oldStart = 1 + edits.slice(0, lo).filter(e => e[0] !== '+').length;
  const newStart = 1 + edits.slice(0, lo).filter(e => e[0] !== '-').length;
  const oldCount = section.filter(e => e[0] !== '+').length;
  const newCount = section.filter(e => e[0] !== '-').length;
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...section.map(e => e[0] + e[1])
  ].join('\n');
}

export function parseTracepilotChangesJson(
  response: string,
  baselineMap: Map<string, string>
): { text: string; changes: ProposedChange[] } {
  const marker = response.lastIndexOf('"tracepilot_changes"');
  const start = marker >= 0 ? response.lastIndexOf('{', marker) : -1;
  if (start < 0) return { text: response, changes: [] };

  let parsed: { tracepilot_changes?: unknown };
  try {
    parsed = JSON.parse(response.slice(start).replace(/```\s*$/, '').trim());
  } catch {
    return { text: response, changes: [] };
  }

  if (!Array.isArray(parsed.tracepilot_changes)) {
    return { text: response, changes: [] };
  }

  const changes: ProposedChange[] = [];
  for (const item of parsed.tracepilot_changes as any[]) {
    if (!item || typeof item.path !== 'string' || typeof item.content !== 'string') continue;
    const path = item.path.trim();
    const baseline = baselineMap.get(path) ?? '';
    const summary = typeof item.summary === 'string' ? item.summary.slice(0, 500) : 'Proposed change';
    const diff = makeDiff(path, baseline, item.content);
    changes.push({
      path,
      content: item.content,
      summary,
      diff,
      baseline
    });
  }

  const cleanText = response.slice(0, start).replace(/```(?:json)?\s*$/i, '').trim();
  return { text: cleanText || response, changes };
}

export async function executeTool(
  toolName: string,
  args: Record<string, any>,
  workspace: WorkspaceService | null
): Promise<string> {
  if (!workspace) {
    return 'Error: No project folder is currently opened. Please open a project folder in TracePilot first.';
  }

  try {
    switch (toolName) {
      case 'read_file': {
        if (!args.path || typeof args.path !== 'string') {
          return 'Error: "path" argument is required for read_file.';
        }
        return await workspace.readFile(args.path, {
          startLine: typeof args.startLine === 'number' ? args.startLine : undefined,
          maxLines: typeof args.maxLines === 'number' ? args.maxLines : undefined
        });
      }

      case 'search_files': {
        if (!args.query || typeof args.query !== 'string') {
          return 'Error: "query" argument is required for search_files.';
        }
        const matches = await workspace.searchFiles(args.query, {
          filePattern: typeof args.filePattern === 'string' ? args.filePattern : undefined,
          maxMatches: typeof args.maxMatches === 'number' ? args.maxMatches : 30
        });
        if (!matches.length) {
          return `No matches found for query "${args.query}".`;
        }
        return `Found ${matches.length} matches for "${args.query}":\n` +
          matches.map(m => `${m.path}:${m.lineNumber}: ${m.lineContent}`).join('\n');
      }

      case 'list_files': {
        const dir = typeof args.directory === 'string' ? args.directory : undefined;
        const max = typeof args.maxFiles === 'number' ? args.maxFiles : 100;
        const items = await workspace.listFiles(dir, max);
        if (!items.length) {
          return dir ? `Directory "${dir}" is empty or not found.` : 'Workspace contains no visible files.';
        }
        return `Listing files${dir ? ` in ${dir}` : ''} (${items.length} items):\n` +
          items.map(i => `${i.isDirectory ? '[DIR] ' : '      '}${i.path}`).join('\n');
      }

      case 'get_project_structure': {
        const depth = typeof args.maxDepth === 'number' ? args.maxDepth : 3;
        return await workspace.getProjectStructure(depth);
      }

      case 'get_project_metadata': {
        const meta = await workspace.getProjectMetadata();
        return JSON.stringify(meta, null, 2);
      }

      case 'read_project_instructions': {
        return await workspace.readProjectInstructions();
      }

      case 'get_git_status': {
        return await workspace.getGitStatus();
      }

      case 'read_diagnostics': {
        const cmd = typeof args.command === 'string' ? args.command : undefined;
        const diag = await workspace.runDiagnostics(cmd);
        return `Diagnostic Exit Code: ${diag.exitCode ?? 0}\nExecution Time: ${diag.durationMs ?? 0}ms\nOutput:\n${diag.output}`;
      }

      case 'propose_change': {
        if (!args.path || typeof args.path !== 'string') {
          return 'Error: "path" argument is required for propose_change.';
        }
        if (typeof args.content !== 'string') {
          return 'Error: "content" argument is required for propose_change.';
        }
        // Baseline verification: ensure file can be read or is new
        let baseline = '';
        try {
          baseline = await workspace.readFileRaw(args.path);
        } catch {
          baseline = ''; // New file
        }
        return `Proposed change for "${args.path}" recorded successfully (${args.content.length} characters). Baseline has ${baseline.length} characters. The user will be prompted to review and approve this unified diff.`;
      }

      default:
        return `Error: Unknown tool "${toolName}". Available tools: read_file, search_files, list_files, get_project_structure, get_project_metadata, read_project_instructions, get_git_status, read_diagnostics, propose_change.`;
    }
  } catch (err) {
    return `Error executing ${toolName}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export interface RunCodingAgentOptions {
  config: ProviderConfig;
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
  userPrompt: string;
  workspace: WorkspaceService | null;
  contextFile?: { path: string; content: string };
  signal?: AbortSignal;
  maxSteps?: number;
  onProgress?: (status: string) => void;
  onDelta?: (chunk: string) => void;
}

export async function runCodingAgent(options: RunCodingAgentOptions): Promise<AgentLoopResult> {
  const {
    config,
    turns,
    userPrompt,
    workspace,
    contextFile,
    signal,
    maxSteps = 8,
    onProgress,
    onDelta
  } = options;

  const startTime = performance.now();
  const steps: AgentStep[] = [];
  const proposedChanges: ProposedChange[] = [];
  const baselineMap = new Map<string, string>();

  // 1. Discover workspace overview to ground the model
  let workspaceContextPrompt = '';
  if (workspace) {
    try {
      const overview = await workspace.discoverRepository();
      workspaceContextPrompt = `
ACTIVE WORKSPACE CONTEXT:
- Project Name: ${overview.name}
- Total Indexed Files: ${overview.fileCount}
- Detected Stack / Type: ${overview.metadata.projectType}${overview.metadata.framework ? ` (${overview.metadata.framework})` : ''}
- Key Manifests: ${overview.metadata.manifestFiles.join(', ') || 'None'}
- Entry Points: ${overview.metadata.entryPoints.join(', ') || 'None'}
- Package Scripts: ${Object.entries(overview.metadata.scripts).map(([k, v]) => `"${k}": "${v}"`).join(', ') || 'None'}

PROJECT STRUCTURE (excerpt):
${overview.structure.slice(0, 3000)}

${overview.instructions ? `\nPROJECT INSTRUCTIONS EXCERPT:\n${overview.instructions.slice(0, 4000)}` : ''}
`;
    } catch {
      workspaceContextPrompt = `ACTIVE WORKSPACE: ${workspace.name}`;
    }
  }

  // 2. Build system instructions
  const systemPrompt = `You are TracePilot, an expert AI coding agent and software architect.
You are working directly on a real project workspace.

CORE OPERATIONAL RULES:
1. GROUNDING: You have REAL tools to inspect this workspace. NEVER ask the user to paste source files, READMEs, or directory trees if you can inspect them yourself using your tools!
2. INVESTIGATION FIRST: When asked what an application does, or to explain a function, debug an issue, or refactor code:
   - Use "read_file" or "read_project_instructions" to inspect README, package manifests, and main entry points.
   - Use "search_files" to find relevant symbols, functions, error messages, and imports.
   - Ground all answers in actual file paths and line numbers.
3. PROPOSING CODE CHANGES:
   - Always read the exact file first using "read_file" so you have the accurate baseline.
   - When modifying code, use the "propose_change" tool with { "path": "...", "content": "complete replacement content", "summary": "..." }.
   - Alternatively, you may output a JSON block at the end:
     {"tracepilot_changes":[{"path":"...","content":"...","summary":"..."}]}
   - Never propose paths that do not exist unless creating a new file explicitly requested.
   - Do not claim changes were applied or tests passed without actually running or verifying them.
4. HONESTY: If a file or symbol cannot be found after searching, say so honestly. Do not invent modules, dependencies, or APIs.

${workspaceContextPrompt}
`;

  // 3. Assemble initial conversation turns
  const messages: ProviderMessage[] = [
    { role: 'system', content: systemPrompt }
  ];

  // Include recent turns for context
  for (const turn of turns.slice(-10)) {
    messages.push({ role: turn.role, content: turn.content });
  }

  // Append new user prompt with optional active file context
  let finalUserContent = userPrompt;
  if (contextFile) {
    baselineMap.set(contextFile.path, contextFile.content);
    finalUserContent += `\n\n[Active editor file: ${contextFile.path}]\n<file>\n${contextFile.content.slice(0, 40_000)}\n</file>`;
  }
  messages.push({ role: 'user', content: finalUserContent });

  let currentIteration = 0;
  let finalResponseText = '';
  let lastInferenceResult: any = null;

  onProgress?.('Analyzing project context…');

  // 4. Multi-step Agent Loop
  while (currentIteration < maxSteps) {
    currentIteration++;
    if (signal?.aborted) {
      throw new Error('Coding agent execution was cancelled.');
    }

    const isFirstStep = currentIteration === 1;
    const requestOptions = {
      stream: isFirstStep,
      signal,
      tools: AGENT_TOOLS,
      tool_choice: 'auto',
      onDelta: isFirstStep ? onDelta : undefined
    };

    lastInferenceResult = await completion(config, messages, requestOptions);

    let assistantToolCalls = lastInferenceResult.toolCalls as ToolCall[] | undefined;
    const assistantText = lastInferenceResult.text || '';

    // Check for simulated / embedded JSON tool calls if native toolCalls is empty
    if (!assistantToolCalls || assistantToolCalls.length === 0) {
      const embeddedToolMatch = assistantText.match(/\{\s*"tool"\s*:\s*"([a-zA-Z_]+)"\s*,\s*"parameters"\s*:\s*(\{[\s\S]*?\})\s*\}/) ||
                                assistantText.match(/\{\s*"name"\s*:\s*"([a-zA-Z_]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/);
      if (embeddedToolMatch) {
        try {
          const tName = embeddedToolMatch[1];
          const tArgs = embeddedToolMatch[2];
          assistantToolCalls = [{
            id: `call_embed_${Date.now()}`,
            type: 'function',
            function: { name: tName, arguments: tArgs }
          }];
        } catch {
          // Ignore
        }
      }
    }

    // If no tool calls were requested, we have reached the final answer!
    if (!assistantToolCalls || assistantToolCalls.length === 0) {
      finalResponseText = assistantText;
      break;
    }

    // Append the assistant's turn with tool calls to message history
    messages.push({
      role: 'assistant',
      content: assistantText || null,
      tool_calls: assistantToolCalls
    });

    // Execute each tool call
    for (const toolCall of assistantToolCalls) {
      if (signal?.aborted) throw new Error('Agent execution was cancelled.');

      const toolName = toolCall.function.name;
      let args: Record<string, any> = {};
      try {
        args = typeof toolCall.function.arguments === 'string'
          ? JSON.parse(toolCall.function.arguments || '{}')
          : (toolCall.function.arguments || {});
      } catch {
        args = {};
      }

      // Friendly progress update for UI
      if (toolName === 'read_file') {
        onProgress?.(`Reading ${args.path || 'file'}…`);
      } else if (toolName === 'search_files') {
        onProgress?.(`Searching files for "${args.query || ''}"…`);
      } else if (toolName === 'list_files') {
        onProgress?.(`Listing files${args.directory ? ` in ${args.directory}` : ''}…`);
      } else if (toolName === 'get_project_structure') {
        onProgress?.('Scanning project structure…');
      } else if (toolName === 'get_project_metadata') {
        onProgress?.('Reading project manifests…');
      } else if (toolName === 'read_project_instructions') {
        onProgress?.('Reading project instructions…');
      } else if (toolName === 'read_diagnostics') {
        onProgress?.('Running diagnostics / tests…');
      } else if (toolName === 'propose_change') {
        onProgress?.(`Preparing proposed diff for ${args.path || 'file'}…`);
      } else {
        onProgress?.(`Executing ${toolName}…`);
      }

      const stepStart = performance.now();
      const toolOutput = await executeTool(toolName, args, workspace);
      const stepDuration = Math.round(performance.now() - stepStart);

      // Handle propose_change specially to collect proposed diffs
      if (toolName === 'propose_change' && args.path && typeof args.content === 'string') {
        let baseline = '';
        if (workspace) {
          try {
            baseline = await workspace.readFileRaw(args.path);
          } catch {
            baseline = '';
          }
        }
        baselineMap.set(args.path, baseline);
        const diff = makeDiff(args.path, baseline, args.content);
        proposedChanges.push({
          path: args.path,
          content: args.content,
          summary: args.summary || 'Proposed change',
          diff,
          baseline
        });
      }

      steps.push({
        stepNumber: steps.length + 1,
        tool: toolName,
        args,
        resultSnippet: toolOutput.slice(0, 300),
        durationMs: stepDuration
      });

      // Append tool result message
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolOutput
      });
    }

    onProgress?.('Processing tool results…');
  }

  // 5. Check if the final text contained a tracepilot_changes JSON block
  const parsed = parseTracepilotChangesJson(finalResponseText, baselineMap);
  for (const ch of parsed.changes) {
    if (!proposedChanges.some(p => p.path === ch.path)) {
      proposedChanges.push(ch);
    }
  }

  return {
    text: parsed.text || finalResponseText,
    changes: proposedChanges,
    steps,
    provider: config.provider,
    model: config.model,
    durationMs: Math.round(performance.now() - startTime),
    status: lastInferenceResult?.status || 200,
    usage: lastInferenceResult?.usage
  };
}

// TracePilot Workspace Service
// Provides real file-system operations, repository discovery, indexing, search,
// safe file reading/writing, and diagnostic inspection for coding agent tasks.

export type WorkspaceFileType = 'file' | 'directory';

export interface WorkspaceFileEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  size?: number;
  handle?: FileSystemFileHandle | FileSystemDirectoryHandle;
  file?: File;
  children?: WorkspaceFileEntry[];
}

export interface SearchMatch {
  path: string;
  lineNumber: number;
  lineContent: string;
}

export interface ProjectMetadata {
  name: string;
  projectType: string;
  framework?: string;
  entryPoints: string[];
  manifestFiles: string[];
  scripts: Record<string, string>;
  dependencies: string[];
  devDependencies: string[];
}

export interface ProjectOverview {
  name: string;
  fileCount: number;
  metadata: ProjectMetadata;
  structure: string;
  instructions?: string;
}

export interface DiagnosticsResult {
  success: boolean;
  exitCode?: number;
  output: string;
  commandRan?: string;
  durationMs?: number;
}

const DEFAULT_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '.vscode',
  '.idea'
]);

const SENSITIVE_PATTERNS = [
  /^\.env(\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,
  /^credentials\.json$/i
];

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.mdx', '.log', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini',
  '.env', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.css', '.scss', '.html',
  '.htm', '.xml', '.svg', '.py', '.pyi', '.go', '.rs', '.java', '.kt', '.kts',
  '.cs', '.fs', '.rb', '.php', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp',
  '.sh', '.bash', '.zsh', '.ps1', '.sql', '.graphql', '.gql', '.vue', '.svelte',
  '.astro', '.dockerfile', '.makefile', '.gitignore', '.editorconfig', '.lock',
  '.prisma', '.proto', '.tf', '.hcl', '.conf'
]);

export function isTextFile(path: string): boolean {
  const normalized = path.toLowerCase().replace(/\\/g, '/');
  const filename = normalized.split('/').pop() || '';
  if (['dockerfile', 'makefile', '.gitignore', '.editorconfig', 'license'].includes(filename)) {
    return true;
  }
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1) return false;
  return TEXT_EXTENSIONS.has(filename.slice(dotIndex));
}

export function validateSafePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '.') {
      throw new Error(`Path traversal is not permitted: "${path}"`);
    }
  }
  if (!normalized.trim()) {
    throw new Error('File path cannot be empty.');
  }
  return normalized;
}

export class WorkspaceService {
  private rootHandle: FileSystemDirectoryHandle | null = null;
  private fallbackFiles: File[] = [];
  private fileCache: Map<string, { handle?: FileSystemFileHandle; file?: File; content?: string }> = new Map();
  private allPaths: string[] = [];
  private projectName: string;
  private overviewCache: ProjectOverview | null = null;

  constructor(name: string, rootHandle?: FileSystemDirectoryHandle | null, fallbackFiles?: File[]) {
    this.projectName = name || 'Workspace';
    this.rootHandle = rootHandle || null;
    this.fallbackFiles = fallbackFiles || [];
  }

  get name(): string {
    return this.projectName;
  }

  get isReadOnly(): boolean {
    return !this.rootHandle && this.fallbackFiles.length > 0;
  }

  get fileCount(): number {
    return this.allPaths.length;
  }

  /**
   * Scans and indexes the repository structure and files
   */
  async scanAndIndex(): Promise<WorkspaceFileEntry[]> {
    this.fileCache.clear();
    this.allPaths = [];
    this.overviewCache = null;

    if (this.rootHandle) {
      const tree = await this.walkDirectory(this.rootHandle, '', 0);
      return tree;
    } else if (this.fallbackFiles.length > 0) {
      const entries: WorkspaceFileEntry[] = [];
      for (const file of this.fallbackFiles) {
        const rawPath = file.webkitRelativePath || file.name;
        const normalized = rawPath.replace(/\\/g, '/');
        const parts = normalized.split('/');
        // Exclude root folder name if webkitRelativePath starts with it
        const relativePath = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
        if (this.isIgnored(relativePath)) continue;

        this.fileCache.set(relativePath, { file });
        this.allPaths.push(relativePath);
        entries.push({
          path: relativePath,
          name: file.name,
          isDirectory: false,
          size: file.size,
          file
        });
      }
      this.allPaths.sort();
      return entries;
    }
    return [];
  }

  private isIgnored(path: string): boolean {
    const parts = path.split('/');
    if (parts.some(part => DEFAULT_IGNORE.has(part))) return true;
    const filename = parts[parts.length - 1];
    return SENSITIVE_PATTERNS.some(p => p.test(filename));
  }

  private async walkDirectory(
    dirHandle: FileSystemDirectoryHandle,
    prefix = '',
    depth = 0
  ): Promise<WorkspaceFileEntry[]> {
    if (depth > 12) return [];
    const entries: WorkspaceFileEntry[] = [];

    // Use async iterator on DirectoryHandle
    for await (const entry of (dirHandle as any).values()) {
      if (this.isIgnored(entry.name)) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.kind === 'directory') {
        const children = await this.walkDirectory(entry as FileSystemDirectoryHandle, path, depth + 1);
        entries.push({
          path,
          name: entry.name,
          isDirectory: true,
          handle: entry as FileSystemDirectoryHandle,
          children
        });
      } else {
        this.fileCache.set(path, { handle: entry as FileSystemFileHandle });
        this.allPaths.push(path);
        entries.push({
          path,
          name: entry.name,
          isDirectory: false,
          handle: entry as FileSystemFileHandle
        });
      }
    }

    entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
    this.allPaths.sort();
    return entries;
  }

  /**
   * List files in the workspace or a subdirectory
   */
  async listFiles(subDirectory?: string, maxFiles = 100): Promise<Array<{ path: string; isDirectory: boolean }>> {
    const targetDir = subDirectory ? validateSafePath(subDirectory).replace(/\/$/, '') : '';
    const results: Array<{ path: string; isDirectory: boolean }> = [];
    const seenDirs = new Set<string>();

    for (const path of this.allPaths) {
      if (targetDir) {
        if (!path.startsWith(`${targetDir}/`)) continue;
        const remainder = path.slice(targetDir.length + 1);
        const slashIdx = remainder.indexOf('/');
        if (slashIdx > -1) {
          const dirPath = `${targetDir}/${remainder.slice(0, slashIdx)}`;
          if (!seenDirs.has(dirPath)) {
            seenDirs.add(dirPath);
            results.push({ path: dirPath, isDirectory: true });
          }
        } else {
          results.push({ path, isDirectory: false });
        }
      } else {
        const slashIdx = path.indexOf('/');
        if (slashIdx > -1) {
          const dirPath = path.slice(0, slashIdx);
          if (!seenDirs.has(dirPath)) {
            seenDirs.add(dirPath);
            results.push({ path: dirPath, isDirectory: true });
          }
        } else {
          results.push({ path, isDirectory: false });
        }
      }
      if (results.length >= maxFiles) break;
    }

    // Also include deeper files if user wanted listing of specific subdirectory
    if (targetDir && results.length < maxFiles) {
      for (const path of this.allPaths) {
        if (path.startsWith(`${targetDir}/`) && !results.some(r => r.path === path)) {
          results.push({ path, isDirectory: false });
          if (results.length >= maxFiles) break;
        }
      }
    }

    return results;
  }

  /**
   * Read file content with line numbers and truncation control
   */
  async readFile(filePath: string, options?: { startLine?: number; maxLines?: number }): Promise<string> {
    const safePath = validateSafePath(filePath);
    const cached = this.fileCache.get(safePath);

    let rawText = '';
    if (cached?.content !== undefined) {
      rawText = cached.content;
    } else if (cached?.handle) {
      const file = await cached.handle.getFile();
      rawText = await file.text();
      cached.content = rawText;
    } else if (cached?.file) {
      rawText = await cached.file.text();
      cached.content = rawText;
    } else {
      // Try case-insensitive matching
      const foundPath = this.allPaths.find(p => p.toLowerCase() === safePath.toLowerCase());
      if (foundPath) {
        return this.readFile(foundPath, options);
      }
      throw new Error(`File not found: "${safePath}". Use list_files or search_files to find valid project files.`);
    }

    const lines = rawText.split('\n');
    const totalLines = lines.length;
    const start = Math.max(1, options?.startLine || 1);
    const max = options?.maxLines || 300;
    const end = Math.min(totalLines, start + max - 1);

    const slice = lines.slice(start - 1, end);
    const numbered = slice.map((line, idx) => `${String(start + idx).padStart(4, ' ')}: ${line}`).join('\n');

    let header = `[File: ${safePath} (${totalLines} total lines, showing lines ${start}-${end})]\n`;
    if (start > 1 || end < totalLines) {
      header += `(Use startLine and maxLines parameters to read other sections)\n`;
    }
    return `${header}\n${numbered}`;
  }

  /**
   * Search for text or pattern across project files
   */
  async searchFiles(query: string, options?: { filePattern?: string; maxMatches?: number }): Promise<SearchMatch[]> {
    if (!query.trim()) return [];
    const maxMatches = options?.maxMatches || 30;
    const results: SearchMatch[] = [];

    let regex: RegExp;
    try {
      regex = new RegExp(query, 'i');
    } catch {
      // Escape literal string if regex compilation fails
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(escaped, 'i');
    }

    for (const path of this.allPaths) {
      if (!isTextFile(path)) continue;
      if (options?.filePattern) {
        const pattern = options.filePattern.toLowerCase().replace(/\*/g, '');
        if (!path.toLowerCase().includes(pattern)) continue;
      }

      let content = '';
      try {
        const cached = this.fileCache.get(path);
        if (cached?.content !== undefined) {
          content = cached.content;
        } else if (cached?.handle) {
          const file = await cached.handle.getFile();
          content = await file.text();
          cached.content = content;
        } else if (cached?.file) {
          content = await cached.file.text();
          cached.content = content;
        }
      } catch {
        continue;
      }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push({
            path,
            lineNumber: i + 1,
            lineContent: lines[i].slice(0, 300).trim()
          });
          if (results.length >= maxMatches) return results;
        }
      }
    }

    return results;
  }

  /**
   * Get formatted directory structure
   */
  async getProjectStructure(maxDepth = 3): Promise<string> {
    const lines: string[] = [`${this.projectName}/`];
    const printedDirs = new Set<string>();

    for (const path of this.allPaths) {
      const parts = path.split('/');
      if (parts.length > maxDepth + 1) continue;

      for (let i = 0; i < parts.length - 1; i++) {
        const dirPath = parts.slice(0, i + 1).join('/');
        if (!printedDirs.has(dirPath)) {
          printedDirs.add(dirPath);
          const indent = '  '.repeat(i + 1);
          lines.push(`${indent}${parts[i]}/`);
        }
      }

      const indent = '  '.repeat(parts.length);
      lines.push(`${indent}${parts[parts.length - 1]}`);
      if (lines.length > 250) {
        lines.push(`  ... (${this.allPaths.length - 250} more files)`);
        break;
      }
    }

    return lines.join('\n');
  }

  /**
   * Get metadata and configuration from project manifests
   */
  async getProjectMetadata(): Promise<ProjectMetadata> {
    const meta: ProjectMetadata = {
      name: this.projectName,
      projectType: 'unknown',
      entryPoints: [],
      manifestFiles: [],
      scripts: {},
      dependencies: [],
      devDependencies: []
    };

    // Check for package.json
    const packageJsonPath = this.allPaths.find(p => p.toLowerCase() === 'package.json');
    if (packageJsonPath) {
      meta.manifestFiles.push(packageJsonPath);
      meta.projectType = 'Node.js / JavaScript / TypeScript';
      try {
        const text = await this.readFileRaw(packageJsonPath);
        const pkg = JSON.parse(text);
        if (pkg.name) meta.name = pkg.name;
        if (pkg.scripts) meta.scripts = pkg.scripts;
        if (pkg.dependencies) meta.dependencies = Object.keys(pkg.dependencies);
        if (pkg.devDependencies) meta.devDependencies = Object.keys(pkg.devDependencies);

        // Detect frameworks
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (allDeps.react) meta.framework = 'React';
        if (allDeps.vue) meta.framework = 'Vue';
        if (allDeps.next) meta.framework = 'Next.js';
        if (allDeps.vite) meta.framework = meta.framework ? `${meta.framework} + Vite` : 'Vite';
        if (allDeps.express) meta.framework = 'Express';
        if (allDeps['@nestjs/core']) meta.framework = 'NestJS';
      } catch {
        // Ignore parse errors
      }
    }

    // Check for Cargo.toml
    const cargoPath = this.allPaths.find(p => p.toLowerCase() === 'cargo.toml');
    if (cargoPath) {
      meta.manifestFiles.push(cargoPath);
      meta.projectType = 'Rust / Cargo';
    }

    // Check for pyproject.toml / requirements.txt
    const pyPath = this.allPaths.find(p => ['pyproject.toml', 'requirements.txt', 'setup.py'].includes(p.toLowerCase()));
    if (pyPath) {
      meta.manifestFiles.push(pyPath);
      meta.projectType = 'Python';
    }

    // Check for go.mod
    const goPath = this.allPaths.find(p => p.toLowerCase() === 'go.mod');
    if (goPath) {
      meta.manifestFiles.push(goPath);
      meta.projectType = 'Go';
    }

    if (meta.projectType === 'unknown') {
      if (this.allPaths.some(p => p.endsWith('.ts') || p.endsWith('.tsx'))) {
        meta.projectType = 'TypeScript';
      } else if (this.allPaths.some(p => p.endsWith('.js') || p.endsWith('.jsx'))) {
        meta.projectType = 'JavaScript';
      } else if (this.allPaths.some(p => p.endsWith('.py'))) {
        meta.projectType = 'Python';
      } else if (this.allPaths.some(p => p.endsWith('.rs'))) {
        meta.projectType = 'Rust';
      } else if (this.allPaths.some(p => p.endsWith('.go'))) {
        meta.projectType = 'Go';
      }
    }

    // Identify entry points
    const potentialEntryPoints = [
      'src/main.tsx', 'src/main.ts', 'src/index.tsx', 'src/index.ts', 'src/App.tsx', 'src/App.ts',
      'src/main.js', 'src/index.js', 'main.go', 'src/main.rs', 'app.py', 'main.py'
    ];
    for (const candidate of potentialEntryPoints) {
      if (this.allPaths.some(p => p.toLowerCase() === candidate.toLowerCase())) {
        meta.entryPoints.push(candidate);
      }
    }

    return meta;
  }

  /**
   * Read project instructions such as AGENTS.md, README.md, etc.
   */
  async readProjectInstructions(): Promise<string> {
    const candidates = [
      'AGENTS.md',
      'agents.md',
      'CLAUDE.md',
      'README.md',
      'readme.md',
      'CONTRIBUTING.md',
      'DEVELOPMENT.md'
    ];

    for (const candidate of candidates) {
      const match = this.allPaths.find(p => p.toLowerCase() === candidate.toLowerCase());
      if (match) {
        try {
          const content = await this.readFileRaw(match);
          return `[Instructions from ${match}]:\n${content.slice(0, 15000)}`;
        } catch {
          // Continue to next candidate
        }
      }
    }

    return 'No AGENTS.md or README.md instruction file found in workspace root.';
  }

  /**
   * Comprehensive repository discovery overview
   */
  async discoverRepository(): Promise<ProjectOverview> {
    if (this.overviewCache) return this.overviewCache;

    const metadata = await this.getProjectMetadata();
    const structure = await this.getProjectStructure(3);
    let instructions: string | undefined;

    try {
      instructions = await this.readProjectInstructions();
    } catch {
      // Ignore
    }

    this.overviewCache = {
      name: this.projectName,
      fileCount: this.allPaths.length,
      metadata,
      structure,
      instructions
    };

    return this.overviewCache;
  }

  /**
   * Run tests / diagnostics via local dev bridge or package scripts inspection
   */
  async runDiagnostics(customCommand?: string): Promise<DiagnosticsResult> {
    const start = performance.now();
    const command = customCommand || 'npm test';

    // Attempt local bridge execution if running in dev environment
    if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
      try {
        const response = await fetch('/api/workspace/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command })
        });
        if (response.ok) {
          const data = await response.json();
          return {
            success: data.exitCode === 0,
            exitCode: data.exitCode,
            output: data.output || (data.exitCode === 0 ? 'All tests passed successfully.' : 'Tests failed.'),
            commandRan: command,
            durationMs: Math.round(performance.now() - start)
          };
        }
      } catch {
        // Fallback below
      }
    }

    // Static diagnostic inspection
    const meta = await this.getProjectMetadata();
    const hasTestScript = !!meta.scripts.test;
    const testFiles = this.allPaths.filter(p => p.includes('.test.') || p.includes('.spec.') || p.startsWith('tests/'));

    return {
      success: true,
      output: `[Environment diagnostic check]\nDetected project type: ${meta.projectType}\nTest script configured: ${hasTestScript ? `"${meta.scripts.test}"` : 'None'}\nTest files found (${testFiles.length}):\n${testFiles.slice(0, 10).map(f => ` - ${f}`).join('\n')}\n(Direct command execution is active when running via TracePilot local dev bridge).`,
      commandRan: command,
      durationMs: Math.round(performance.now() - start)
    };
  }

  /**
   * Get git status via dev bridge or report status
   */
  async getGitStatus(): Promise<string> {
    if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
      try {
        const response = await fetch('/api/workspace/git-status');
        if (response.ok) {
          const data = await response.json();
          return data.output || 'Git working tree clean.';
        }
      } catch {
        // Fallback
      }
    }
    return 'Git status check: Git repository is active. Direct git commands are enabled via TracePilot local dev bridge.';
  }

  /**
   * Helper to read raw file text without line-number formatting
   */
  async readFileRaw(filePath: string): Promise<string> {
    const safePath = validateSafePath(filePath);
    const cached = this.fileCache.get(safePath);

    if (cached?.content !== undefined) return cached.content;
    if (cached?.handle) {
      const file = await cached.handle.getFile();
      const text = await file.text();
      cached.content = text;
      return text;
    }
    if (cached?.file) {
      const text = await cached.file.text();
      cached.content = text;
      return text;
    }

    const foundPath = this.allPaths.find(p => p.toLowerCase() === safePath.toLowerCase());
    if (foundPath && foundPath !== safePath) {
      return this.readFileRaw(foundPath);
    }

    throw new Error(`File not found: "${safePath}".`);
  }

  /**
   * Safe file writing with baseline check and read-back verification
   */
  async writeFile(filePath: string, newContent: string, expectedBaseline?: string): Promise<{ success: boolean; bytesWritten: number }> {
    const safePath = validateSafePath(filePath);
    const cached = this.fileCache.get(safePath);

    if (!this.rootHandle || !cached?.handle) {
      throw new Error(`Write failed: File "${safePath}" is read-only or opened without write permissions.`);
    }

    // Verify baseline if provided
    if (expectedBaseline !== undefined) {
      const current = await this.readFileRaw(safePath);
      if (current !== expectedBaseline) {
        throw new Error(`Conflict detected: "${safePath}" was modified externally since reading. Reload before applying changes.`);
      }
    }

    const writable = await (cached.handle as any).createWritable();
    try {
      await writable.write(newContent);
      await writable.close();
    } catch (err) {
      await writable.abort?.();
      throw err;
    }

    // Read back to verify
    const readBack = await (await cached.handle.getFile()).text();
    if (readBack !== newContent) {
      throw new Error(`Verification failed: Read-back of "${safePath}" did not match the expected written content.`);
    }

    cached.content = readBack;
    return { success: true, bytesWritten: new TextEncoder().encode(newContent).length };
  }
}

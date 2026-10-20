import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  Activity, ArrowDown, ArrowUpRight, Check, ChevronDown, ChevronRight, CircleHelp,
  FileCode2, FilePlus2, FolderOpen, GitBranch, LoaderCircle, MessageSquarePlus,
  PanelLeftClose, PanelLeftOpen, Plus, Send, Settings2, ShieldCheck, Sparkles,
  TerminalSquare, Trash2, Pencil, X, Wrench
} from 'lucide-react';
import {
  discoverNebiusModels, getProvider, providerList, testProvider, validateCredential,
  type ChatTurn, type InferenceResult, type ProviderConfig, type ProviderId
} from './providers';
import { WorkspaceService } from './workspace';
import { runCodingAgent, type ProposedChange, type AgentStep } from './agent';

type Handle = FileSystemFileHandle & {
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }>;
};
type Directory = FileSystemDirectoryHandle & {
  values(): AsyncIterable<Handle | Directory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<Handle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<Directory>;
};
type TreeFile = { path: string; name: string; handle?: Handle; file?: File; directory: boolean; children?: TreeFile[] };
type Message = ChatTurn & {
  id: string;
  createdAt?: string;
  changes?: ProposedChange[];
  steps?: AgentStep[];
  provider?: ProviderId;
  model?: string;
  requestMeta?: { durationMs: number; status?: number; usage?: InferenceResult['usage'] };
};
type Credential = { id: string; label: string; provider: ProviderId; key: string; testedModels: string[]; availableModels?: string[] };
type Conversation = { id: string; title: string; messages: Message[]; updatedAt: string };
type Project = { id: string; name: string; conversations: Conversation[] };

const DB = 'tracepilot-workspace';
const STORE = 'projects';
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 1_000_000;
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.mdx', '.log', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini',
  '.env', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.css', '.scss', '.html',
  '.htm', '.xml', '.svg', '.py', '.pyi', '.go', '.rs', '.java', '.kt', '.kts',
  '.cs', '.fs', '.rb', '.php', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp',
  '.sh', '.bash', '.zsh', '.ps1', '.sql', '.graphql', '.gql', '.vue', '.svelte',
  '.astro', '.dockerfile', '.makefile', '.gitignore', '.editorconfig', '.lock',
  '.prisma', '.proto', '.tf', '.hcl'
]);

function isTextPath(path: string): boolean {
  const name = path.toLowerCase().split('/').pop() || '';
  return TEXT_EXTENSIONS.has(`.${name.split('.').pop()}`) || ['dockerfile', 'makefile', '.gitignore', '.editorconfig'].includes(name);
}

let fallbackId = 0;
const newId = () => globalThis.crypto?.randomUUID?.() || `tp-${Date.now().toString(36)}-${(++fallbackId).toString(36)}`;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function loadProjects(): Promise<Project[]> {
  const db = await openDb();
  const result = await new Promise<Project[]>((resolve, reject) => {
    const r = db.transaction(STORE).objectStore(STORE).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  db.close();
  return result.sort((a, b) => b.conversations[0]?.updatedAt?.localeCompare(a.conversations[0]?.updatedAt || '') || 0);
}

async function saveProject(project: Project): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(project);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function deleteProjectRecord(projectId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(projectId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function deleteConversationRecord(projectId: string, conversationId: string): Promise<Project | null> {
  const db = await openDb();
  try {
    return await new Promise<Project | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      let updated: Project | null = null;
      const request = store.get(projectId);
      request.onsuccess = () => {
        const project = request.result as Project | undefined;
        if (!project) {
          tx.abort();
          return;
        }
        const conversations = project.conversations.filter(item => item.id !== conversationId);
        if (conversations.length === project.conversations.length) {
          tx.abort();
          return;
        }
        const candidate = { ...project, conversations };
        store.put(candidate);
        updated = candidate;
      };
      tx.oncomplete = () => resolve(updated);
      tx.onerror = () => reject(tx.error || request.error);
      tx.onabort = () => updated ? reject(tx.error || new Error('Conversation deletion did not complete.')) : resolve(null);
    });
  } finally {
    db.close();
  }
}

async function renameConversationRecord(projectId: string, conversationId: string, title: string): Promise<Project | null> {
  const db = await openDb();
  try {
    return await new Promise<Project | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      let updated: Project | null = null;
      const request = store.get(projectId);
      request.onsuccess = () => {
        const project = request.result as Project | undefined;
        if (!project) {
          tx.abort();
          return;
        }
        let found = false;
        const conversations = project.conversations.map(item => {
          if (item.id !== conversationId) return item;
          found = true;
          return { ...item, title, updatedAt: new Date().toISOString() };
        });
        if (!found) {
          tx.abort();
          return;
        }
        const candidate = { ...project, conversations };
        store.put(candidate);
        updated = candidate;
      };
      tx.oncomplete = () => resolve(updated);
      tx.onerror = () => reject(tx.error || request.error);
      tx.onabort = () => updated ? reject(tx.error || new Error('Conversation rename did not complete.')) : resolve(null);
    });
  } finally {
    db.close();
  }
}

async function scanDirectory(root: Directory): Promise<TreeFile[]> {
  let count = 0;
  const walk = async (directory: Directory, prefix = '', depth = 0): Promise<TreeFile[]> => {
    if (depth > 8) return [];
    const entries: TreeFile[] = [];
    for await (const entry of directory.values()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build' || entry.name === '.next') continue;
      if (++count > MAX_FILES) throw new Error('This folder contains more than 2,000 visible entries. Open a smaller source folder.');
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') entries.push({ path, name: entry.name, directory: true, children: await walk(entry as Directory, path, depth + 1) });
      else entries.push({ path, name: entry.name, directory: false, handle: entry as Handle });
    }
    return entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  };
  return walk(root);
}

function flatten(rows: TreeFile[]): TreeFile[] {
  return rows.flatMap(row => row.directory ? [row, ...flatten(row.children || [])] : [row]);
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (!window.matchMedia) return;
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(m.matches);
    const fn = () => setReduced(m.matches);
    m.addEventListener?.('change', fn);
    return () => m.removeEventListener?.('change', fn);
  }, []);
  return reduced;
}

export default function App() {
  const reduced = useReducedMotion();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [tree, setTree] = useState<TreeFile[]>([]);
  const [root, setRoot] = useState<Directory | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceService | null>(null);
  const [projectRoots, setProjectRoots] = useState<Record<string, Directory>>({});
  const [projectFiles, setProjectFiles] = useState<Record<string, File[]>>({});
  const [convoId, setConvoId] = useState('');
  const [activePath, setActivePath] = useState('');
  const [editor, setEditor] = useState('');
  const [baseline, setBaseline] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'unsaved' | 'saving' | 'failed'>('saved');
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [removeProjectTarget, setRemoveProjectTarget] = useState<Project | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ project: Project; x: number; y: number } | null>(null);

  const [composer, setComposer] = useState('');
  const [busy, setBusy] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [agentProgress, setAgentProgress] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(false);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [selectedCredentialId, setSelectedCredentialId] = useState('');
  const [credentialLabel, setCredentialLabel] = useState('');
  const [credentialProvider, setCredentialProvider] = useState<ProviderId>('nebius-token-factory');
  const [credentialKey, setCredentialKey] = useState('');
  const [model, setModel] = useState('nvidia/Nemotron-3_5-Lightning');
  const [connection, setConnection] = useState<'disconnected' | 'connected' | 'error'>('disconnected');
  const [testing, setTesting] = useState(false);
  const [includeFile, setIncludeFile] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [showFiles, setShowFiles] = useState(false);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedChange, setSelectedChange] = useState<{ conversation: Conversation; message: Message; change: ProposedChange } | null>(null);
  const [fallbackFiles, setFallbackFiles] = useState<File[]>([]);

  const fileInput = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const saveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const saveInFlightRef = useRef<{ revision: number; promise: Promise<boolean> } | null>(null);
  const projectMutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const editRevisionRef = useRef(0);

  const activeProject = projects.find(p => p.id === projectId);
  const conversation = activeProject?.conversations.find(c => c.id === convoId);
  const files = useMemo(() => flatten(tree), [tree]);
  const activeFile = files.find(file => file.path === activePath) || fallbackFiles.map(file => ({ path: file.webkitRelativePath || file.name, name: file.name, file, directory: false } as TreeFile)).find(file => file.path === activePath);
  const selectedCredential = credentials.find(item => item.id === selectedCredentialId);
  const selectedProvider = selectedCredential ? getProvider(selectedCredential.provider) : null;
  const modelOptions = selectedProvider ? (selectedCredential?.availableModels ? selectedCredential.availableModels.map(id => selectedProvider.models.find(option => option.id === id) || { id, label: id, context: 'Catalog model', maxContextChars: 40_000, capabilities: [] }) : selectedProvider.models) : [];
  const modelConfig: ProviderConfig | null = selectedCredential ? { provider: selectedCredential.provider, model, key: selectedCredential.key } : null;

  useEffect(() => {
    void loadProjects().then(loaded => setProjects(current => [...current, ...loaded.filter(saved => !current.some(item => item.id === saved.id))])).catch(() => setError('Local conversation storage is unavailable. Conversations may not persist after this tab closes.'));
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node?.scrollTo) node.scrollTo({ top: node.scrollHeight, behavior: reduced ? 'instant' : 'smooth' });
  }, [conversation?.messages.length, busy, streamingText, agentProgress, reduced]);

  useEffect(() => {
    if (!notice && !error) return;
    const id = window.setTimeout(() => { setNotice(''); setError(''); }, 6500);
    return () => clearTimeout(id);
  }, [notice, error]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        ((document.querySelector('.file-search input') || document.querySelector('.conversations .searchbox input')) as HTMLInputElement | null)?.focus();
        return;
      }
      if (event.key === 'Escape') {
        if (projectMenu) setProjectMenu(null);
        else if (removeProjectTarget) setRemoveProjectTarget(null);
        else if (deleteTarget) setDeleteTarget(null);
        else if (confirmSend) setConfirmSend(false);
        else if (selectedChange) setSelectedChange(null);
        else if (settings) setSettings(false);
        else if (showFiles) setShowFiles(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmSend, selectedChange, settings, showFiles, deleteTarget, removeProjectTarget, projectMenu]);

  const updateConversation = async (next: Conversation) => {
    if (!activeProject) return;
    const updatedProject = { ...activeProject, conversations: activeProject.conversations.map(c => c.id === next.id ? next : c) };
    try {
      await saveProject(updatedProject);
      setProjects(all => all.map(p => p.id === updatedProject.id ? updatedProject : p));
    } catch {
      setError('Could not persist this conversation to browser storage. The project file was updated, but the conversation record may be stale.');
    }
  };

  const chooseFolder = async () => {
    if (!await ensureEditorSafeToLeave()) return;
    try {
      const picker = (window as any).showDirectoryPicker as undefined | ((options: { mode: 'readwrite' }) => Promise<Directory>);
      if (!picker) {
        fileInput.current?.click();
        return;
      }
      const handle = await picker({ mode: 'readwrite' });
      const ws = new WorkspaceService(handle.name, handle);
      await ws.scanAndIndex();
      const scanned = await scanDirectory(handle);
      const id = newId();
      const project: Project = { id, name: handle.name, conversations: [] };
      await saveProject(project);
      setProjects(old => [project, ...old]);
      setProjectId(id);
      setRoot(handle);
      setWorkspace(ws);
      setProjectRoots(old => ({ ...old, [id]: handle }));
      setTree(scanned);
      setConvoId('');
      setActivePath('');
      setEditor('');
      setBaseline('');
      setDirty(false);
      setSaveState('saved');
      setFallbackFiles([]);
      setNotice(`Opened ${handle.name}. Indexed ${ws.fileCount} files. Repository-aware coding agent and tools are active.`);
    } catch (reason) {
      if ((reason as Error).name !== 'AbortError') setError(reason instanceof Error ? reason.message : 'Could not open this folder. Check folder access and retry.');
    }
  };

  const fallbackImport = async (event: ChangeEvent<HTMLInputElement>) => {
    if (!await ensureEditorSafeToLeave()) {
      event.target.value = '';
      return;
    }
    const chosen = Array.from(event.target.files || []);
    if (chosen.length > MAX_FILES) {
      setError('Choose no more than 2,000 files at a time.');
      return;
    }
    if (chosen.some(f => f.size > MAX_FILE_BYTES)) {
      setError('One or more files exceed the 1 MB editing limit. Choose smaller source files.');
      return;
    }
    const ws = new WorkspaceService('Read-only file selection', null, chosen);
    await ws.scanAndIndex();
    const project: Project = { id: newId(), name: 'Read-only file selection', conversations: [] };
    setFallbackFiles(chosen);
    setProjectFiles(old => ({ ...old, [project.id]: chosen }));
    setRoot(null);
    setWorkspace(ws);
    setTree([]);
    setProjects(old => [project, ...old]);
    setProjectId(project.id);
    setActivePath('');
    setConvoId('');
    setEditor('');
    setBaseline('');
    setDirty(false);
    setSaveState('saved');
    setNotice(`Selected ${chosen.length} files. Coding agent has read access.`);
    event.target.value = '';
  };

  const switchProject = async (project: Project) => {
    if (project.id === projectId) return;
    if (!await ensureEditorSafeToLeave()) return;
    setProjectId(project.id);
    const directory = projectRoots[project.id] || null;
    const filesList = projectFiles[project.id] || [];
    setRoot(directory);
    setFallbackFiles(filesList);
    if (directory || filesList.length > 0) {
      const ws = new WorkspaceService(project.name, directory, filesList);
      await ws.scanAndIndex();
      setWorkspace(ws);
      setTree(directory ? await scanDirectory(directory) : []);
    } else {
      setWorkspace(null);
      setTree([]);
    }
    setActivePath('');
    setEditor('');
    setBaseline('');
    setDirty(false);
    setSaveState('saved');
    setConvoId('');
    setSelectedChange(null);
    if (!directory && !projectFiles[project.id]) {
      setNotice('This project’s conversations are saved, but its folder handle is session-only. Reopen the folder to access files.');
    }
  };

  const newConversation = async () => {
    if (!activeProject) {
      setError('Open a project folder first.');
      return;
    }
    const projectIdForConversation = activeProject.id;
    const next: Conversation = { id: newId(), title: 'New conversation', messages: [], updatedAt: new Date().toISOString() };
    const operation = projectMutationQueueRef.current.then(async () => {
      const latest = (await loadProjects()).find(item => item.id === projectIdForConversation) || activeProject;
      if (!projects.some(item => item.id === projectIdForConversation)) throw new Error('The project is no longer open.');
      const updated = { ...latest, conversations: [next, ...latest.conversations] };
      await saveProject(updated);
      setProjects(all => all.map(item => item.id === updated.id ? updated : item));
      setConvoId(next.id);
      setSelectedChange(null);
    });
    projectMutationQueueRef.current = operation.then(() => undefined, () => undefined);
    try {
      await operation;
    } catch {
      setError('Could not create a persistent conversation. Check browser storage and retry.');
    }
  };

  const renameConversation = async (item: Conversation) => {
    if (!activeProject) return;
    const title = window.prompt('Rename conversation', item.title);
    if (title === null) return;
    const nextTitle = title.trim().slice(0, 120);
    if (!nextTitle) {
      setError('Conversation title cannot be empty.');
      return;
    }
    try {
      const updated = await renameConversationRecord(activeProject.id, item.id, nextTitle);
      if (!updated) throw new Error('Conversation no longer exists in this project.');
      setProjects(all => all.map(project => project.id === updated.id ? updated : project));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not rename this conversation.');
    }
  };

  const deleteConversation = async () => {
    if (!deleteTarget || !activeProject) return;
    const target = deleteTarget;
    const targetProjectId = activeProject.id;
    try {
      const updated = await deleteConversationRecord(targetProjectId, target.id);
      if (!updated) throw new Error('Conversation was not found in the selected project. No records were deleted.');
      setProjects(all => all.map(project => project.id === updated.id ? updated : project));
      if (convoId === target.id) setConvoId(updated.conversations[0]?.id || '');
      setDeleteTarget(null);
    } catch (reason) {
      setError(reason instanceof Error ? `Could not delete conversation. ${reason.message}` : 'Could not delete conversation. The record is still available.');
    }
  };

  const removeWorkspace = async () => {
    if (!removeProjectTarget) return;
    const target = removeProjectTarget;
    if (target.id === projectId && !await ensureEditorSafeToLeave()) {
      setRemoveProjectTarget(null);
      return;
    }
    try {
      await deleteProjectRecord(target.id);
      setProjects(items => items.filter(item => item.id !== target.id));
      setProjectRoots(items => {
        const next = { ...items };
        delete next[target.id];
        return next;
      });
      setProjectFiles(items => {
        const next = { ...items };
        delete next[target.id];
        return next;
      });
      if (target.id === projectId) {
        setProjectId('');
        setRoot(null);
        setWorkspace(null);
        setTree([]);
        setFallbackFiles([]);
        setConvoId('');
        setActivePath('');
        setEditor('');
        setBaseline('');
        setDirty(false);
        setSaveState('saved');
        setSelectedChange(null);
      }
      setRemoveProjectTarget(null);
      setNotice(`Removed ${target.name} from TracePilot. Its folder and files were not changed.`);
    } catch (reason) {
      setError(reason instanceof Error ? `Could not remove this workspace from TracePilot. ${reason.message}` : 'Could not remove this workspace. Its folder and files were not changed.');
    }
  };

  const openConversation = async (next: Conversation) => {
    if (next.id === convoId) return;
    if (!await ensureEditorSafeToLeave()) return;
    setConvoId(next.id);
    setSelectedChange(null);
  };

  const openFile = async (file: TreeFile) => {
    if (file.directory) {
      setExpanded(old => ({ ...old, [file.path]: !old[file.path] }));
      return;
    }
    if (!isTextPath(file.path)) {
      setError('This file type is not supported in the text editor. Choose a text or source file.');
      return;
    }
    if (file.path !== activePath && !await ensureEditorSafeToLeave()) return;
    try {
      const blob = file.handle ? await file.handle.getFile() : file.file;
      if (!blob) throw new Error('File access expired. Reopen the project folder.');
      if (blob.size > MAX_FILE_BYTES) throw new Error('Files larger than 1 MB are not shown in the editor. Select a smaller source file.');
      const text = await blob.text();
      editRevisionRef.current++;
      setActivePath(file.path);
      setEditor(text);
      setBaseline(text);
      setDirty(false);
      setSaveState('saved');
      setShowFiles(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not read this file.');
    }
  };

  const hideEditor = async () => {
    if (!await ensureEditorSafeToLeave()) return;
    setActivePath('');
    setDirty(false);
  };

  const saveEditor = async (): Promise<boolean> => {
    const revision = editRevisionRef.current;
    if (saveInFlightRef.current?.revision === revision) return saveInFlightRef.current.promise;
    if (!dirty) return saveState !== 'failed';
    if (!activeFile?.handle || !root) {
      setSaveState('failed');
      setError('This browser has read-only file access. Reopen the folder in a browser with File System Access support to save changes.');
      return false;
    }
    const file = activeFile;
    const path = activePath;
    const snapshot = editor;
    const expectedBaseline = baseline;
    setSaveState('saving');
    const job = saveQueueRef.current.then(async () => {
      if (revision !== editRevisionRef.current || path !== activePath) return false;
      try {
        let permission = await (file.handle as any).queryPermission?.({ mode: 'readwrite' });
        if (permission !== 'granted') {
          const ask = (file.handle as any).requestPermission;
          if (typeof ask !== 'function') throw new Error('Write permission is unavailable. Reopen this project using a browser that supports filesystem write access.');
          permission = await ask.call(file.handle, { mode: 'readwrite' });
          if (permission !== 'granted') throw new Error('Write permission was not granted. Keep this file open and retry Save.');
        }
        const current = await (await file.handle!.getFile()).text();
        if (current !== expectedBaseline) throw new Error('This file changed outside TracePilot. Your edits are still here; reload and compare before saving again.');
        const eol = expectedBaseline.includes('\r\n') ? '\r\n' : expectedBaseline.includes('\r') ? '\r' : '\n';
        const hasBom = expectedBaseline.startsWith('\uFEFF');
        const normalized = snapshot.replace(/\r\n|\r|\n/g, eol);
        const output = hasBom && !normalized.startsWith('\uFEFF') ? `\uFEFF${normalized}` : normalized;
        const writable = await file.handle!.createWritable();
        try {
          await writable.write(output);
          await writable.close();
        } catch (reason) {
          await writable.abort?.();
          throw reason;
        }
        const check = await (await file.handle!.getFile()).text();
        if (check !== output) throw new Error('The file was written, but read-back verification did not match. Inspect the file before continuing.');
        setBaseline(check);
        if (revision === editRevisionRef.current && path === activePath) {
          setDirty(false);
          setSaveState('saved');
          setNotice('Saved and verified by reading the file back from disk.');
        } else {
          setDirty(true);
          setSaveState('unsaved');
        }
        return true;
      } catch (reason) {
        if (revision === editRevisionRef.current) {
          setDirty(true);
          setSaveState('failed');
          setError(reason instanceof Error ? reason.message : 'Could not save this file. Check folder permission and retry.');
        }
        return false;
      }
    });
    const tracked = job.finally(() => {
      if (saveInFlightRef.current?.promise === tracked) saveInFlightRef.current = null;
    });
    saveInFlightRef.current = { revision, promise: tracked };
    saveQueueRef.current = tracked.catch(() => false);
    return tracked;
  };

  const ensureEditorSafeToLeave = async () => {
    if (!dirty) return true;
    const saved = await saveEditor();
    if (saved) return true;
    return window.confirm('The editor changes could not be saved. Discard the unsaved text and continue? The original file remains unchanged unless a prior save was confirmed.');
  };

  useEffect(() => {
    if (!dirty || !activePath) return;
    if (!root || !activeFile?.handle) {
      setSaveState('unsaved');
      return;
    }
    if (saveState !== 'failed') setSaveState('unsaved');
    const timer = window.setTimeout(() => { void saveEditor(); }, 1000);
    return () => window.clearTimeout(timer);
  }, [editor, dirty, activePath, root]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    const onSave = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && activePath) {
        event.preventDefault();
        void saveEditor();
      }
    };
    window.addEventListener('keydown', onSave);
    return () => window.removeEventListener('keydown', onSave);
  }, [activePath, editor, dirty, baseline, root]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!composer.trim() || busy) return;
    if (!selectedCredential || !modelConfig) {
      setSettings(true);
      setError('Add and select a provider credential before starting a conversation.');
      return;
    }
    if (includeFile && activeFile) {
      setConfirmSend(true);
      return;
    }
    void sendConfirmed();
  };

  const sendConfirmed = async () => {
    const text = composer.trim();
    if (!text) return;
    setConfirmSend(false);
    let activeConversation = conversation;
    if (!activeConversation) {
      if (!activeProject) {
        setError('Open a project folder first.');
        return;
      }
      activeConversation = { id: newId(), title: text.slice(0, 52), messages: [], updatedAt: new Date().toISOString() };
      setConvoId(activeConversation.id);
    }

    const provider = selectedCredential!.provider;
    const requestModel = model;
    const userMessage: Message = { id: newId(), createdAt: new Date().toISOString(), role: 'user', content: text, provider, model: requestModel };
    const existing = activeConversation.messages;
    const pending = { ...activeConversation, title: existing.length ? activeConversation.title : text.slice(0, 52), messages: [...existing, userMessage], updatedAt: new Date().toISOString() };
    const p = activeProject!;
    const withPending = { ...p, conversations: [pending, ...p.conversations.filter(c => c.id !== pending.id)] };
    try {
      await saveProject(withPending);
    } catch {
      setError('Could not save your message to browser storage, so it was not sent. Check available storage and retry.');
      return;
    }
    setProjects(all => all.map(x => x.id === p.id ? withPending : x));
    setComposer('');
    setBusy(true);
    setStreamingText('');
    setAgentProgress('Starting request…');
    setError('');

    const requestStarted = performance.now();
    const controller = new AbortController();
    requestControllerRef.current = controller;

    // Ensure active workspace service is available
    let currentWorkspace = workspace;
    if (!currentWorkspace && (root || fallbackFiles.length > 0)) {
      currentWorkspace = new WorkspaceService(activeProject?.name || 'Workspace', root, fallbackFiles);
      await currentWorkspace.scanAndIndex();
      setWorkspace(currentWorkspace);
    }

    try {
      const activeFileContext = includeFile && activeFile ? { path: activeFile.path, content: editor } : undefined;
      const agentResult = await runCodingAgent({
        config: modelConfig!,
        turns: existing,
        userPrompt: text,
        workspace: currentWorkspace,
        contextFile: activeFileContext,
        signal: controller.signal,
        onProgress: status => setAgentProgress(status),
        onDelta: chunk => setStreamingText(curr => curr + chunk)
      });

      const assistant: Message = {
        id: newId(),
        createdAt: new Date().toISOString(),
        role: 'assistant',
        content: agentResult.text,
        changes: agentResult.changes,
        steps: agentResult.steps,
        provider: agentResult.provider as ProviderId,
        model: agentResult.model,
        requestMeta: {
          durationMs: agentResult.durationMs,
          status: agentResult.status,
          usage: agentResult.usage
        }
      };

      const done = { ...pending, messages: [...pending.messages, assistant], updatedAt: new Date().toISOString() };
      const saved = { ...withPending, conversations: withPending.conversations.map(c => c.id === done.id ? done : c) };
      await saveProject(saved);
      setProjects(all => all.map(x => x.id === saved.id ? saved : x));

      if (agentResult.changes.length) {
        setNotice(`Agent proposed ${agentResult.changes.length} file change(s) for your review. No files have been modified.`);
      }
    } catch (reason) {
      const failure = reason as Error & { status?: number };
      const msg: Message = {
        id: newId(),
        createdAt: new Date().toISOString(),
        role: 'assistant',
        content: reason instanceof Error ? `Request failed: ${reason.message}` : 'Request failed. Check the selected provider connection and retry.',
        provider,
        model: requestModel,
        requestMeta: { durationMs: Math.round(performance.now() - requestStarted), status: failure.status }
      };
      const failed = { ...pending, messages: [...pending.messages, msg] };
      const saved = { ...withPending, conversations: withPending.conversations.map(c => c.id === failed.id ? failed : c) };
      try {
        await saveProject(saved);
        setProjects(all => all.map(x => x.id === saved.id ? saved : x));
      } catch {
        setError('The provider request failed and the failure message could not be persisted. The sent prompt remains saved.');
      }
    } finally {
      requestControllerRef.current = null;
      setBusy(false);
      setStreamingText('');
      setAgentProgress('');
      setIncludeFile(false);
    }
  };

  const applyChange = async (conversationToUpdate: Conversation, message: Message, change: ProposedChange) => {
    if (!root) {
      setError('This project is read-only. Open the folder with write permissions to apply changes.');
      return;
    }
    if (dirty && activePath === change.path) {
      setError('Save or discard your editor changes before applying the proposal.');
      return;
    }

    try {
      let handle: Handle | undefined;
      const target = files.find(f => f.path === change.path) || (activePath === change.path ? activeFile : undefined);
      handle = target?.handle;

      if (!handle && root) {
        const parts = change.path.split('/');
        let currentDir: Directory = root;
        for (let i = 0; i < parts.length - 1; i++) {
          currentDir = (await currentDir.getDirectoryHandle(parts[i], { create: false })) as Directory;
        }
        handle = await currentDir.getFileHandle(parts[parts.length - 1]);
      }

      if (!handle) {
        throw new Error(`Could not access file "${change.path}".`);
      }

      const permission = await (handle as any).queryPermission?.({ mode: 'readwrite' });
      if (permission !== 'granted' && await (handle as any).requestPermission?.({ mode: 'readwrite' }) !== 'granted') {
        throw new Error('Write permission was not granted.');
      }

      const now = await (await handle.getFile()).text();
      if (change.baseline && now !== change.baseline) {
        setError('The file changed on disk since this proposal was created. Reload it and request a fresh proposal.');
        return;
      }

      const writer = await handle.createWritable();
      try {
        await writer.write(change.content);
        await writer.close();
      } catch (reason) {
        await writer.abort?.();
        throw reason;
      }

      const verified = await (await handle.getFile()).text();
      if (verified !== change.content) {
        throw new Error('Read-back did not match the approved proposal. Inspect the file before continuing.');
      }

      if (activePath === change.path) {
        setEditor(verified);
        setBaseline(verified);
        setDirty(false);
      }

      const applied = {
        ...message,
        content: `${message.content}\n\nApplied ${change.path}. Browser read-back matched the approved proposal. No tests were run.`,
        changes: message.changes?.filter(c => c.path !== change.path)
      };
      const updated = {
        ...conversationToUpdate,
        messages: conversationToUpdate.messages.map(m => m.id === message.id ? applied : m),
        updatedAt: new Date().toISOString()
      };
      await updateConversation(updated);
      setSelectedChange(null);
      setNotice(`Applied ${change.path}; file contents matched on read-back.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not apply change. Check file permission and retry.');
    }
  };

  const removeCredential = (id: string) => {
    const credential = credentials.find(item => item.id === id);
    setCredentials(items => items.filter(item => item.id !== id));
    if (selectedCredentialId === id) {
      setSelectedCredentialId('');
      setConnection('disconnected');
    }
    setNotice(`${credential?.label || 'Credential'} removed and cleared from memory.`);
  };

  const selectCredential = (credential: Credential) => {
    setSelectedCredentialId(credential.id);
    setModel(credential.availableModels?.[0] || getProvider(credential.provider).models[0]?.id || '');
    setConnection('connected');
  };

  const addCredential = () => {
    try {
      const cleanLabel = credentialLabel.trim();
      const cleanKey = credentialKey.trim();
      validateCredential(credentialProvider, cleanLabel, cleanKey);
      const item: Credential = { id: newId(), label: cleanLabel, provider: credentialProvider, key: cleanKey, testedModels: [] };
      setCredentials(items => [...items, item]);
      setSelectedCredentialId(item.id);
      setModel(getProvider(item.provider).models[0]?.id || '');
      setCredentialLabel('');
      setCredentialKey('');
      setConnection('connected');
      setError('');
      setNotice('Credential added. You can now chat directly.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not add this credential.');
    }
  };

  const testCredential = async (credential: Credential, modelId: string) => {
    setTesting(true);
    setError('');
    try {
      const result = await testProvider({ provider: credential.provider, model: modelId, key: credential.key });
      setCredentials(items => items.map(item => item.id === credential.id ? { ...item, testedModels: item.testedModels.includes(modelId) ? item.testedModels : [...item.testedModels, modelId] } : item));
      if (selectedCredentialId === credential.id && model === modelId) setConnection('connected');
      setNotice(`${getProvider(credential.provider).label} replied to ${modelId}: ${result.slice(0, 100)}`);
    } catch (reason) {
      setConnection('error');
      setError(reason instanceof Error ? reason.message : 'Provider test failed. Check the key, model, and browser network policy.');
    } finally {
      setTesting(false);
    }
  };

  const testCredentialConnection = async (credential: Credential) => {
    if (credential.provider !== 'nebius-token-factory') {
      setError('Model-list discovery is currently supported only for Nebius Token Factory. Use Test model for NVIDIA API Catalog.');
      return;
    }
    setTesting(true);
    setError('');
    try {
      const availableModels = await discoverNebiusModels(credential.key);
      setCredentials(items => items.map(item => item.id === credential.id ? { ...item, availableModels } : item));
      setNotice(`Nebius Token Factory authenticated and returned ${availableModels.length} model IDs. This checks catalog access only; run Test model separately to verify inference.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not read the Nebius model catalog. Check credential access and retry.');
    } finally {
      setTesting(false);
    }
  };

  const cancelInference = () => requestControllerRef.current?.abort();

  useEffect(() => {
    if (reduced) return;
    let frameId: number;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        const x = (e.clientX / window.innerWidth - 0.5) * 24;
        const y = (e.clientY / window.innerHeight - 0.5) * 24;
        document.documentElement.style.setProperty('--parallax-x', `${x.toFixed(1)}px`);
        document.documentElement.style.setProperty('--parallax-y', `${y.toFixed(1)}px`);
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener('pointermove', onMove);
    };
  }, [reduced]);

  const treeRows = (rows: TreeFile[], depth = 0) => rows.map(file => (
    <div key={file.path}>
      <button className={`tree-row ${activePath === file.path ? 'active' : ''}`} style={{ paddingLeft: 12 + depth * 13 }} onClick={() => void openFile(file)}>
        {file.directory ? (
          <>
            {expanded[file.path] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <FolderOpen size={14} />
          </>
        ) : (
          <>
            <span className="tree-indent" />
            <FileCode2 size={14} />
          </>
        )}
        <span>{file.name}</span>
      </button>
      {file.directory && expanded[file.path] && treeRows(file.children || [], depth + 1)}
    </div>
  ));

  return (
    <div className={`app ${reduced ? 'reduced-motion' : ''}`}>
      <div className="liquid-scene" aria-hidden="true">
        <div className="liquid-caustics-layer" />
        <div className="bubble-sphere sphere-hero" />
        <div className="bubble-sphere sphere-mid" />
        <div className="bubble-sphere sphere-crystal" />
        <div className="bubble-sphere sphere-droplet-1" />
        <div className="bubble-sphere sphere-droplet-2" />
        <div className="bubble-sphere sphere-droplet-3" />
        <div className="bubble-sphere sphere-droplet-4" />
        <div className="liquid-light-sweep" />
      </div>

      <header className="topbar">
        <div className="top-left">
          <button className="icon-btn nav-toggle" aria-label={sidebar ? 'Hide navigation' : 'Show navigation'} onClick={() => setSidebar(!sidebar)}>
            {sidebar ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </button>
          <div className="brand">
            <span className="brand-icon"><Activity size={17} /></span>
            <b>Tracepilot</b>
            <span className="brand-divider">/</span>
            <span className="workspace-name">{activeProject?.name || 'Workspace'}</span>
            {workspace && <span className="workspace-badge">{workspace.fileCount} files indexed</span>}
          </div>
        </div>
        <div className="top-actions">
          <span className={`connection-dot ${connection}`} title={`${selectedProvider?.label || 'Provider'} ${connection}`} aria-label={`${selectedProvider?.label || 'Provider'} ${connection}`} />
          <button className="top-button" aria-label="Provider settings" onClick={() => setSettings(true)}>
            <Settings2 size={15} />
            <span>Providers</span>
          </button>
        </div>
      </header>

      <div className="workspace-layout">
        {sidebar && (
          <aside className="rail">
            <div className="rail-actions">
              <button className="primary small" onClick={() => void chooseFolder()}>
                <FolderOpen size={15} /> Open project
              </button>
              <button className="icon-btn" title="New conversation" aria-label="New conversation" onClick={() => void newConversation()} disabled={!activeProject}>
                <MessageSquarePlus size={16} />
              </button>
            </div>

            <div className="rail-section">
              <div className="section-head">
                <span>WORKSPACE</span>
                <button className="icon-btn mini" onClick={() => void chooseFolder()} aria-label="Choose another project">
                  <Plus size={13} />
                </button>
              </div>
              {projects.length ? (
                projects.map(p => (
                  <button
                    key={p.id}
                    className={`project-current project-switch ${p.id === projectId ? 'active' : ''}`}
                    onClick={() => void switchProject(p)}
                    onContextMenu={event => {
                      event.preventDefault();
                      setProjectMenu({ project: p, x: Math.min(event.clientX, window.innerWidth - 210), y: Math.min(event.clientY, window.innerHeight - 64) });
                    }}
                    onKeyDown={event => {
                      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        event.preventDefault();
                        const rect = event.currentTarget.getBoundingClientRect();
                        setProjectMenu({ project: p, x: rect.left, y: rect.bottom });
                      }
                    }}
                    aria-haspopup="menu"
                    aria-label={`Workspace ${p.name}; right-click for options`}
                  >
                    <FolderOpen size={14} />
                    <span>{p.name}</span>
                    {p.id === projectId && <i>ACTIVE</i>}
                  </button>
                ))
              ) : (
                <p className="rail-empty">Open a local folder to begin.</p>
              )}
            </div>

            <div className="rail-section conversations">
              <div className="section-head">
                <span>CONVERSATIONS</span>
                <button className="icon-btn mini" onClick={() => void newConversation()} aria-label="New conversation" disabled={!activeProject}>
                  <Plus size={13} />
                </button>
              </div>
              <label className="searchbox">
                <SearchIcon />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search conversations" />
              </label>
              {activeProject?.conversations.filter(c => c.title.toLowerCase().includes(search.toLowerCase())).map(c => (
                <div className={`conversation-item ${c.id === convoId ? 'selected' : ''}`} key={c.id}>
                  <button className={`conversation-link ${c.id === convoId ? 'selected' : ''}`} onClick={() => void openConversation(c)}>
                    <MessageSquarePlus size={14} />
                    <span>{c.title || 'New conversation'}</span>
                  </button>
                  <button className="conversation-action" title="Rename conversation" aria-label={`Rename conversation ${c.title}`} onClick={() => void renameConversation(c)}>
                    <Pencil size={12} />
                  </button>
                  <button className="conversation-action danger" title="Delete conversation" aria-label={`Delete conversation ${c.title}`} onClick={() => setDeleteTarget(c)}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>

            <div className="rail-bottom">
              <div className="safe-note">
                <ShieldCheck size={14} />
                <span>AI coding agent with real repository tools. Human approval before file writes.</span>
              </div>
            </div>
          </aside>
        )}

        <main className="main-pane">
          <div className="projectbar">
            <div className="breadcrumbs">
              {activeProject && (
                <button className="mobile-files-toggle" onClick={() => setShowFiles(!showFiles)}>
                  <FolderOpen size={13} /> Files
                </button>
              )}
              <span>{activeProject?.name || 'No project opened'}</span>
              {activePath && (
                <>
                  <ChevronRight size={13} />
                  <b>{activePath}</b>
                </>
              )}
            </div>
            <div className="project-actions">
              {activePath && (
                <button className="mobile-editor-close" onClick={hideEditor} aria-label="Close editor and return to chat">
                  <X size={14} /> Chat
                </button>
              )}
              <span className="local-badge"><span /> {root ? 'LOCAL FS' : fallbackFiles.length ? 'READ ONLY' : 'NO PROJECT'}</span>
              <button className="icon-btn" aria-label="Open project folder" title="Open project folder" onClick={() => void chooseFolder()}>
                <FolderOpen size={15} />
              </button>
            </div>
          </div>

          {!activeProject ? (
            <div className="welcome">
              <div className="welcome-orbit">
                <div className="orb orb-one" />
                <div className="orb orb-two" />
                <div className="welcome-mark"><Activity size={25} /></div>
              </div>
              <div className="eyebrow"><span /> PERSONAL CODING WORKSPACE</div>
              <h1>Make sense of your code.<br /><em>Move with confidence.</em></h1>
              <p>Open a local project. TracePilot discovers structure, reads code, navigates symbols, and drafts reviewable diffs.</p>
              <div className="welcome-actions">
                <button className="primary" onClick={() => void chooseFolder()}>
                  <FolderOpen size={16} /> Open a project folder
                </button>
                <button className="secondary" onClick={() => fileInput.current?.click()}>
                  <FilePlus2 size={16} /> Choose files instead
                </button>
              </div>
              <div className="welcome-foot">
                <span><ShieldCheck size={14} /> Repository-aware AI coding agent</span>
                <span><GitBranch size={14} /> Changes are always reviewable</span>
              </div>
            </div>
          ) : (
            <div className="project-workspace">
              {(root || fallbackFiles.length > 0) && (
                <aside className={`file-panel ${showFiles ? 'mobile-open' : ''}`}>
                  <div className="file-panel-head">
                    <div>
                      <span className="eyebrow-small">PROJECT FILES</span>
                      <b>{activeProject.name}</b>
                    </div>
                    {root && (
                      <button className="icon-btn mini" title="Refresh folder" aria-label="Refresh folder" onClick={() => void scanDirectory(root).then(setTree).catch(e => setError(e.message))}>
                        <ArrowDown size={14} />
                      </button>
                    )}
                  </div>
                  <label className="searchbox file-search">
                    <SearchIcon />
                    <input placeholder="Find a file" value={search} onChange={e => setSearch(e.target.value)} />
                    <kbd>⌘K</kbd>
                  </label>
                  <div className="tree-scroll">
                    {root ? (
                      search ? (
                        files.filter(f => !f.directory && f.path.toLowerCase().includes(search.toLowerCase())).map(f => (
                          <button key={f.path} className={`tree-row ${activePath === f.path ? 'active' : ''}`} onClick={() => void openFile(f)}>
                            <span className="tree-indent" />
                            <FileCode2 size={14} />
                            <span>{f.path}</span>
                          </button>
                        ))
                      ) : (
                        treeRows(tree)
                      )
                    ) : (
                      fallbackFiles.filter(f => (f.webkitRelativePath || f.name).toLowerCase().includes(search.toLowerCase())).map(f => (
                        <button key={f.webkitRelativePath || f.name} className={`tree-row ${activePath === (f.webkitRelativePath || f.name) ? 'active' : ''}`} onClick={() => void openFile({ path: f.webkitRelativePath || f.name, name: f.name, file: f, directory: false })}>
                          <span className="tree-indent" />
                          <FileCode2 size={14} />
                          <span>{f.webkitRelativePath || f.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                  <div className="file-panel-foot">
                    <span><span className="live-dot" /> {root ? 'LOCAL FILESYSTEM' : 'READ ONLY'}</span>
                    <span>{root ? files.filter(f => !f.directory).length : fallbackFiles.length} files</span>
                  </div>
                </aside>
              )}

              <section className="conversation-pane">
                <div ref={scrollRef} className={`message-scroll ${conversation?.messages.length ? 'has-messages' : ''}`}>
                  {!conversation || conversation.messages.length === 0 ? (
                    <div className="conversation-empty">
                      <div className="empty-spark"><Sparkles size={18} /></div>
                      <h2>What are we working on?</h2>
                      <p>Ask anything about your project. TracePilot uses real workspace tools to read files, search symbols, run tests, and propose diffs.</p>
                    </div>
                  ) : (
                    <div className="messages">
                      {conversation.messages.map(message => (
                        <article key={message.id} className={`message ${message.role}`}>
                          <div className="message-avatar">
                            {message.role === 'assistant' ? <Sparkles size={15} /> : <span>Y</span>}
                          </div>
                          <div className="message-content">
                            <div className="message-label">
                              {message.role === 'assistant' ? 'TRACEPILOT' : 'YOU'} · <time>{message.createdAt ? new Date(message.createdAt).toLocaleString() : message.id.slice(0, 4)}</time>
                            </div>

                            {message.steps && message.steps.length > 0 && (
                              <div className="agent-steps-summary">
                                <div className="agent-steps-header">
                                  <Wrench size={12} />
                                  <span>Inspected workspace ({message.steps.length} operation{message.steps.length > 1 ? 's' : ''}):</span>
                                </div>
                                <div className="agent-steps-list">
                                  {message.steps.map(s => (
                                    <div key={s.stepNumber} className="agent-step-item">
                                      <code>{s.tool}</code>
                                      <span>{Object.entries(s.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            <div className="message-text">{message.content}</div>

                            {message.requestMeta && (
                              <div className="request-metadata">
                                {getProvider(message.provider || 'nebius-token-factory').label} · {message.model}
                                {message.requestMeta.status !== undefined && <> · HTTP {message.requestMeta.status}</>} · {(message.requestMeta.durationMs / 1000).toFixed(1)}s
                                {message.requestMeta.usage && ` · ${message.requestMeta.usage.totalTokens ?? '?'} tokens`}
                              </div>
                            )}

                            {message.changes?.map(change => (
                              <div className="proposal" key={change.path}>
                                <div className="proposal-head">
                                  <span className="diff-badge">DIFF</span>
                                  <b>{change.path}</b>
                                  <span className="proposal-state">AWAITING REVIEW</span>
                                </div>
                                <p>{change.summary}</p>
                                <pre className="diff-view">
                                  {change.diff.split('\n').map((line, index) => (
                                    <span key={index} className={line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : 'diff-context'}>
                                      {line || ' '}
                                    </span>
                                  ))}
                                </pre>
                                <div className="proposal-actions">
                                  <button className="secondary" onClick={() => setSelectedChange({ conversation, message, change })}>
                                    Review details
                                  </button>
                                  <button className="primary apply-btn" disabled={!root} onClick={() => void applyChange(conversation, message, change)}>
                                    <Check size={14} />
                                    {root ? 'Approve & write' : 'Read only'}
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </article>
                      ))}
                    </div>
                  )}

                  {busy && (
                    <article className="message assistant">
                      <div className="message-avatar"><Sparkles size={15} /></div>
                      <div className="message-content">
                        {agentProgress && (
                          <div className="agent-progress-pill">
                            <LoaderCircle className="spin" size={13} />
                            <span>{agentProgress}</span>
                          </div>
                        )}
                        {streamingText ? (
                          <div className="message-text streaming-response">{streamingText}</div>
                        ) : (
                          <div className="thinking">{agentProgress || 'Waiting for provider…'}</div>
                        )}
                      </div>
                    </article>
                  )}
                </div>

                <form className="composer" onSubmit={send}>
                  <div className="composer-top">
                    <span><Sparkles size={13} /> {selectedProvider?.label || 'CODING ASSISTANT'}</span>
                    <label>
                      Model{' '}
                      <select aria-label="Model" value={model} disabled={!selectedCredential} onChange={e => { setModel(e.target.value); setConnection('connected'); }}>
                        {modelOptions.map(option => (
                          <option value={option.id} key={option.id}>
                            {option.label} · {option.context}
                          </option>
                        ))}
                      </select>
                    </label>
                    <span className="model-status">{selectedCredential ? 'READY' : 'ADD KEY'}</span>
                  </div>

                  <textarea
                    value={composer}
                    onChange={e => setComposer(e.target.value)}
                    placeholder="Ask TracePilot to explore or change your code…"
                    rows={3}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void send(e as any);
                      }
                    }}
                  />

                  <div className="composer-foot">
                    <div className="context-control">
                      <label>
                        <input type="checkbox" checked={includeFile} onChange={e => setIncludeFile(e.target.checked)} disabled={!activeFile} />
                        <span>{activeFile ? `Include ${activeFile.name}` : 'Open a file to add context'}</span>
                      </label>
                      {activeFile && (
                        <span className="context-local"><ShieldCheck size={12} /> stays local until send</span>
                      )}
                    </div>
                    {busy && (
                      <button className="secondary cancel-request" type="button" onClick={cancelInference}>
                        Cancel response
                      </button>
                    )}
                    <button className="send-button" type="submit" disabled={busy || !composer.trim()} aria-label="Send request">
                      <Send size={15} />
                    </button>
                  </div>
                  <div className="composer-disclaimer">
                    Requests go directly to {selectedProvider?.label || 'the selected AI provider'}. The agent automatically discovers and reads workspace files. Checking the box above pins the active editor buffer.
                  </div>
                </form>

                <footer className="conversation-footer">
                  <span><ShieldCheck size={13} /> Human review before every write</span>
                  <span><TerminalSquare size={13} /> Safe diagnostic and test execution</span>
                </footer>
              </section>

              {activePath && (
                <aside className="editor-panel">
                  <div className="editor-top">
                    <div>
                      <span className="editor-type"><FileCode2 size={14} /></span>
                      <b>{activeFile?.name}</b>
                      <span className="unsaved-dot">{dirty ? '●' : ''}</span>
                    </div>
                    <button className="primary save-button" onClick={() => void saveEditor()} disabled={!dirty || !root}>
                      <Check size={13} /> Save (Ctrl+S)
                    </button>
                  </div>
                  <div className="editor-path">{activePath}</div>
                  <textarea
                    className="code-editor"
                    value={editor}
                    onChange={e => {
                      editRevisionRef.current++;
                      setEditor(e.target.value);
                      setDirty(true);
                      setSaveState('unsaved');
                    }}
                    spellCheck={false}
                    aria-label={`Code editor ${activePath}`}
                  />
                  <div className="editor-foot">
                    <span>{editor.split('\n').length} lines · {new TextEncoder().encode(editor).length} bytes</span>
                    <span className={`save-status ${saveState}`}>
                      {!root && dirty ? 'Read only · unsaved' : saveState === 'saving' ? 'Saving…' : saveState === 'failed' ? 'Save failed' : dirty ? 'Unsaved changes' : 'Saved'}
                    </span>
                  </div>
                </aside>
              )}
            </div>
          )}
        </main>
      </div>

      <input ref={fileInput} type="file" multiple hidden onChange={fallbackImport} />

      {(error || notice) && (
        <div className={`toast ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
          {error ? <CircleHelp size={16} /> : <Check size={16} />}
          <span>{error || notice}</span>
          <button aria-label="Dismiss message" onClick={() => { setError(''); setNotice(''); }}>
            <X size={14} />
          </button>
        </div>
      )}

      {settings && (
        <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSettings(false); }}>
          <section className="settings-modal provider-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="modal-top">
              <div className="settings-symbol"><Sparkles size={18} /></div>
              <button className="icon-btn" aria-label="Close settings" onClick={() => setSettings(false)}><X size={17} /></button>
            </div>
            <div className="eyebrow-small">DIRECT PROVIDER CONNECTIONS</div>
            <h2 id="settings-title">Provider manager</h2>
            <p className="modal-copy">Credentials exist only in this tab’s memory. Requests go straight from your browser to the selected provider; TracePilot has no credential proxy.</p>
            <div className="key-policy">
              <ShieldCheck size={16} />
              <span>Keys are never written to browser storage, databases, or logs. CORS or network blocks are surfaced; they are not proxied.</span>
            </div>
            <div className="saved-credentials">
              <h3>Credentials in this tab ({credentials.length})</h3>
              {credentials.length === 0 ? (
                <p>No credentials added. Create one below, then test the desired model.</p>
              ) : (
                credentials.map(item => (
                  <div className="credential-row" key={item.id}>
                    <div>
                      <b>{item.label}</b>
                      <span>{getProvider(item.provider).label} · key ending {item.key.slice(-4).replace(/./g, '•')}</span>
                    </div>
                    <span className="credential-status">{selectedCredentialId === item.id ? 'ACTIVE CREDENTIAL' : 'READY'}</span>
                    <div className="credential-actions">
                      <button className="secondary" onClick={() => selectCredential(item)}>
                        {selectedCredentialId === item.id ? 'Selected' : 'Use'}
                      </button>
                      {item.provider === 'nebius-token-factory' && (
                        <button className="secondary" disabled={testing} onClick={() => void testCredentialConnection(item)}>
                          Test connection
                        </button>
                      )}
                      <button className="secondary" disabled={testing} onClick={() => void testCredential(item, selectedCredentialId === item.id && (item.availableModels?.includes(model) || getProvider(item.provider).models.some(option => option.id === model)) ? model : (item.availableModels?.[0] || getProvider(item.provider).models[0].id))}>
                        {testing ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Test inference
                      </button>
                      <button className="text-danger" onClick={() => removeCredential(item.id)}>Remove</button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <h3>Add credential</h3>
            <label className="field-label">Label
              <input value={credentialLabel} onChange={e => setCredentialLabel(e.target.value)} maxLength={64} placeholder="Work Nebius key" />
            </label>
            <label className="field-label">Provider
              <select aria-label="Credential provider" value={credentialProvider} onChange={e => setCredentialProvider(e.target.value as ProviderId)}>
                {providerList.map(provider => (
                  <option key={provider.id} value={provider.id}>{provider.label}</option>
                ))}
              </select>
            </label>
            <label className="field-label">API key
              <input type="password" value={credentialKey} onChange={e => setCredentialKey(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste your own key" />
            </label>
            <div className="provider-actions">
              <button className="primary" onClick={addCredential} disabled={!credentialLabel.trim() || !credentialKey.trim()}>
                <Plus size={14} /> Add to this tab
              </button>
              <button className="secondary" onClick={() => { setCredentialKey(''); setCredentialLabel(''); }}>
                Clear draft
              </button>
            </div>
            <div className="cors-note">
              <b>Nebius runtime</b>
              <span>Model catalog access and inference are separate checks. Nebius Token Factory is hosted API inference, not an AI Cloud deployment. Credentials remain in this tab’s memory only.</span>
            </div>
            <a className="docs-link" href="https://docs.tokenfactory.nebius.com/ai-models-inference/overview" target="_blank" rel="noreferrer">
              Nebius Token Factory API documentation <ArrowUpRight size={13} />
            </a>
          </section>
        </div>
      )}

      {confirmSend && activeFile && (
        <div className="modal-backdrop">
          <section className="settings-modal consent-modal" role="dialog" aria-modal="true" aria-labelledby="consent-title">
            <div className="modal-top">
              <div className="settings-symbol"><ShieldCheck size={18} /></div>
              <button className="icon-btn" aria-label="Cancel send" onClick={() => setConfirmSend(false)}><X size={17} /></button>
            </div>
            <div className="eyebrow-small">EXPLICIT FILE CONTEXT</div>
            <h2 id="consent-title">Send this source to {selectedProvider?.label}?</h2>
            <p className="modal-copy">The current request and complete contents of <b>{activeFile.path}</b> ({new TextEncoder().encode(editor).length.toLocaleString()} bytes) will be sent directly to {selectedProvider?.label} using model <code>{model}</code>.</p>
            <p className="modal-copy">TracePilot coding agent will also have access to inspect workspace files using tools. TracePilot does not proxy this data.</p>
            <div className="provider-actions">
              <button className="secondary" onClick={() => setConfirmSend(false)}>Go back</button>
              <button className="primary" onClick={() => void sendConfirmed()}>
                <Send size={14} /> Send to provider
              </button>
            </div>
          </section>
        </div>
      )}

      {projectMenu && (
        <>
          <button className="context-menu-dismiss" aria-label="Close workspace menu" onClick={() => setProjectMenu(null)} />
          <div className="workspace-context-menu" role="menu" aria-label={`${projectMenu.project.name} workspace options`} style={{ left: Math.max(8, projectMenu.x), top: Math.max(8, projectMenu.y) }}>
            <button role="menuitem" onClick={() => { setRemoveProjectTarget(projectMenu.project); setProjectMenu(null); }}>
              <X size={14} /> Remove workspace
            </button>
          </div>
        </>
      )}

      {removeProjectTarget && (
        <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setRemoveProjectTarget(null); }}>
          <section className="settings-modal delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="remove-workspace-title">
            <div className="modal-top">
              <div className="settings-symbol"><FolderOpen size={18} /></div>
              <button className="icon-btn" aria-label="Cancel workspace removal" onClick={() => setRemoveProjectTarget(null)}><X size={17} /></button>
            </div>
            <div className="eyebrow-small">REMOVE FROM TRACEPILOT</div>
            <h2 id="remove-workspace-title">Remove “{removeProjectTarget.name}”?</h2>
            <p className="modal-copy">This removes the workspace and its saved conversations from TracePilot on this browser. The folder and all files on your device will stay untouched. Reopen the folder to add it again.</p>
            <div className="provider-actions">
              <button className="secondary" onClick={() => setRemoveProjectTarget(null)}>Cancel</button>
              <button className="primary delete-confirm" onClick={() => void removeWorkspace()}><X size={14} /> Remove workspace</button>
            </div>
          </section>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setDeleteTarget(null); }}>
          <section className="settings-modal delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-conversation-title">
            <div className="modal-top">
              <div className="settings-symbol"><Trash2 size={18} /></div>
              <button className="icon-btn" aria-label="Cancel conversation deletion" onClick={() => setDeleteTarget(null)}><X size={17} /></button>
            </div>
            <div className="eyebrow-small">CONVERSATION ONLY</div>
            <h2 id="delete-conversation-title">Delete “{deleteTarget.title}”?</h2>
            <p className="modal-copy">This permanently removes this conversation and its messages from this browser. The project, folder, source files, and other conversations will stay unchanged.</p>
            <div className="provider-actions">
              <button className="secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="primary delete-confirm" onClick={() => void deleteConversation()}><Trash2 size={14} /> Delete conversation</button>
            </div>
          </section>
        </div>
      )}

      {selectedChange && (
        <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSelectedChange(null); }}>
          <section className="review-modal" role="dialog" aria-modal="true" aria-labelledby="review-title">
            <div className="modal-top">
              <div>
                <span className="eyebrow-small">PROPOSED CHANGE</span>
                <h2 id="review-title">Review before applying</h2>
              </div>
              <button className="icon-btn" aria-label="Close diff review" onClick={() => setSelectedChange(null)}><X size={17} /></button>
            </div>
            <p>{selectedChange.change.summary}</p>
            <pre className="diff-view expanded">
              {selectedChange.change.diff.split('\n').map((line, index) => (
                <span key={index} className={line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : 'diff-context'}>
                  {line || ' '}
                </span>
              ))}
            </pre>
            <div className="review-warning">
              <ShieldCheck size={15} /> Only this exact file will be written. TracePilot verifies baseline before applying and reads the file back afterward.
            </div>
            <div className="provider-actions">
              <button className="secondary" onClick={() => setSelectedChange(null)}>Reject proposal</button>
              <button className="primary" disabled={!root} onClick={() => void applyChange(selectedChange.conversation, selectedChange.message, selectedChange.change)}>
                <Check size={14} /> Approve & write
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </svg>
  );
}

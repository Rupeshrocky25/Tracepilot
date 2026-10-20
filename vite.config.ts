import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

function workspaceBridgePlugin(): Plugin {
  return {
    name: 'tracepilot-workspace-bridge',
    configureServer(server) {
      server.middlewares.use('/api/workspace/test', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body || '{}');
            const cmd = (parsed.command || 'npm test').trim();
            // Restrict allowed commands for security
            if (!/^(npm|npx|node|git|pnpm|yarn|cargo|pytest|go|vitest)(\s+[\w\-\.\/:]+)*$/.test(cmd)) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Command not permitted by TracePilot workspace security policy.' }));
              return;
            }
            const { stdout, stderr } = await execAsync(cmd, { cwd: process.cwd(), timeout: 30000 });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ exitCode: 0, output: (stdout + '\n' + stderr).trim() }));
          } catch (err: any) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              exitCode: err.code || 1,
              output: ((err.stdout || '') + '\n' + (err.stderr || '') + '\n' + (err.message || '')).trim()
            }));
          }
        });
      });

      server.middlewares.use('/api/workspace/git-status', async (_req, res) => {
        try {
          const { stdout } = await execAsync('git status --short --branch', { cwd: process.cwd(), timeout: 10000 });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ exitCode: 0, output: stdout.trim() }));
        } catch (err: any) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ exitCode: err.code || 1, output: err.message || 'Git not available.' }));
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), workspaceBridgePlugin()],
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api-proxy/nebius': {
        target: 'https://api.tokenfactory.nebius.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-proxy\/nebius/, '')
      },
      '/api-proxy/nvidia': {
        target: 'https://integrate.api.nvidia.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-proxy\/nvidia/, '')
      }
    }
  }
});

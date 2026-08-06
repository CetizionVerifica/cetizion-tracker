#!/usr/bin/env node
/**
 * Run the API and the web app together, with prefixed output, and stop
 * both when either one exits or you press Ctrl-C.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  { name: 'api', colour: '[36m', cwd: join(root, 'server'), args: ['run', 'dev'] },
  { name: 'web', colour: '[35m', cwd: join(root, 'web'), args: ['run', 'dev'] },
];

const children = [];
let stopping = false;

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 200);
}

for (const target of TARGETS) {
  const child = spawn('npm', target.args, { cwd: target.cwd, shell: false });
  children.push(child);

  const prefix = `${target.colour}[${target.name}][0m `;
  const forward = (stream, out) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (!stopping) {
      console.log(`${prefix}exited with code ${code}`);
      stopAll(code ?? 0);
    }
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stopAll(0));

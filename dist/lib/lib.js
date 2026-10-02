'use strict';

const { spawn } = require('node:child_process');

/* Subprocess execution */

function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const stdin = options.input !== undefined ? 'pipe' : 'ignore';
    const stdout = options.capture ? 'pipe' : options.silent ? 'ignore' : 'inherit';
    const stderr = options.capture ? 'ignore' : 'inherit';

    const output = [];

    const child = spawn(command, args, {
      stdio: [stdin, stdout, stderr],
      env: process.env,
    });

    if (options.capture)
      child.stdout.on('data', chunk => output.push(chunk));

    if (options.input !== undefined) {
      child.stdin.on('error', reject);
      child.stdin.end(options.input);
    }

    child.on('error', reject);
    child.on('close', code => {
      if (code === 0 || options.allowFailure)
        resolve({ code, stdout: Buffer.concat(output).toString(options.encoding || 'utf8') });
      else
        reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

/* Write a file as root */

async function writeRootFile(path, contents, mode = '600') {
  const result = await run('sudo', ['mktemp', `${path}.XXXXXX`], { capture: true });
  const temp = result.stdout.trim();
  try {
    await run('sudo', ['tee', temp], { input: contents, silent: true });
    await run('sudo', ['chmod', mode, temp]);
    await run('sudo', ['mv', '-T', '--', temp, path]);
  } finally {
    await run('sudo', ['rm', '-f', '--', temp], { allowFailure: true });
  }
}

/* Module exports */

module.exports = { run, writeRootFile };

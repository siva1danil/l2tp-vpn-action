'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const common = require('./common');

function create() {
  const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'l2tp-ipsec-'));

  fs.chmodSync(root, 0o700);
  for (const dir of ['ipsec', 'l2tp', 'ppp', 'routes'])
    fs.mkdirSync(path.join(root, dir), { mode: 0o700 });

  const rt = {
    root,
    statePath: path.join(root, 'state.json'),
    state: {
      instanceId: crypto.randomBytes(3).toString('hex'),
      routes: [],
      endpointRoute: null,
    },
  };
  save(rt);

  return rt;
}

function open(root) {
  return {
    root,
    statePath: path.join(root, 'state.json'),
    state: JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')),
  };
}

async function remove(rt) {
  await common.run('sudo', ['rm', '-rf', '--', rt.root], { allowFailure: true });
}

function exists(root) {
  return fs.existsSync(path.join(root, 'state.json'));
}

function save(rt) {
  const temp = `${rt.statePath}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(rt.state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, rt.statePath);
}

function resolve(rt, ...parts) {
  return path.join(rt.root, ...parts);
}

function write(rt, relativePath, contents, mode = 0o600) {
  const target = resolve(rt, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode });
  return target;
}

module.exports = { create, open, remove, exists, save, resolve, write };

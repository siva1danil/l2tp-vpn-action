'use strict';

const fs = require('node:fs');
const common = require('./common');
const runtime = require('./runtime');

function prepare(rt, { address, pppOptionsPath }) {
  rt.state.l2tp = {
    lacName: `gha-${rt.state.instanceId}`,
    configPath: runtime.resolve(rt, 'l2tp', 'xl2tpd.conf'),
    pidPath: runtime.resolve(rt, 'l2tp', 'xl2tpd.pid'),
    controlPath: runtime.resolve(rt, 'l2tp', 'control'),
  };
  runtime.save(rt);

  runtime.write(rt, 'l2tp/xl2tpd.conf', `
[global]
port = 1701

[lac ${rt.state.l2tp.lacName}]
lns = ${address}
pppoptfile = ${pppOptionsPath}
length bit = yes
redial = no
autodial = no
`.trimStart());
}

async function start(rt) {
  process.stdout.write('Starting xl2tpd...\n');
  await common.exec('sudo', ['xl2tpd', '-c', rt.state.l2tp.configPath, '-p', rt.state.l2tp.pidPath, '-C', rt.state.l2tp.controlPath]);
}

async function waitStarted(rt, timeout) {
  const expiresAt = Date.now() + timeout;
  while (Date.now() < expiresAt) {
    if (fs.existsSync(rt.state.l2tp.pidPath) && fs.existsSync(rt.state.l2tp.controlPath)) {
      const pid = fs.readFileSync(rt.state.l2tp.pidPath, 'utf8').trim();
      if (/^\d+$/.test(pid) && (await common.exec('sudo', ['kill', '-0', pid], { allowFailure: true })).code === 0)
        return;
    }
    await common.sleep(250);
  }
  throw new Error('xl2tpd daemon did not become ready before timeout');
}

async function connect(rt) {
  process.stdout.write('Establishing L2TP...\n');
  const resultDir = '/var/run/xl2tpd';
  if (!fs.existsSync(resultDir)) {
    await common.exec('sudo', ['install', '-d', '-m', '700', resultDir]);
    rt.state.l2tp.resultDirCreated = true;
    runtime.save(rt);
  }
  await common.exec('sudo', ['xl2tpd-control', '-c', rt.state.l2tp.controlPath, 'connect-lac', rt.state.l2tp.lacName]);
}

async function disconnect(rt) {
  if (!rt.state.l2tp || !fs.existsSync(rt.state.l2tp.controlPath))
    return;
  await common.exec('sudo', ['xl2tpd-control', '-c', rt.state.l2tp.controlPath, 'disconnect-lac', rt.state.l2tp.lacName], { allowFailure: true });
}

async function stop(rt) {
  if (!rt.state.l2tp)
    return;

  try {
    if (!fs.existsSync(rt.state.l2tp.pidPath))
      return;

    const pid = fs.readFileSync(rt.state.l2tp.pidPath, 'utf8').trim();
    if (!/^\d+$/.test(pid))
      return;

    await common.exec('sudo', ['kill', '-TERM', pid], { allowFailure: true });
    for (let i = 0; i < 20; i++) {
      if ((await common.exec('sudo', ['kill', '-0', pid], { allowFailure: true })).code !== 0)
        return;
      await common.sleep(100);
    }
    await common.exec('sudo', ['kill', '-KILL', pid], { allowFailure: true });
  } finally {
    if (rt.state.l2tp.resultDirCreated)
      await common.exec('sudo', ['rmdir', '--', '/var/run/xl2tpd'], { allowFailure: true });
  }
}

module.exports = { prepare, start, wait: waitStarted, connect, disconnect, stop };

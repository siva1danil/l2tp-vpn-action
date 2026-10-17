'use strict';

const fs = require('node:fs');
const common = require('./common');
const runtime = require('./runtime');

function command(rt, args, options = {}) {
  return common.exec('sudo', [
    'env',
    `IPSEC_CONFDIR=${rt.state.ipsec.configDir}`,
    `IPSEC_PIDDIR=${rt.state.ipsec.pidDir}`,
    'ipsec',
    ...args,
  ], options);
}

function prepare(rt, { address, psk }) {
  rt.state.ipsec = {
    name: `gha-${rt.state.instanceId}`,
    configDir: runtime.resolve(rt, 'ipsec'),
    pidDir: runtime.resolve(rt, 'ipsec', 'run'),
  };
  runtime.save(rt);

  fs.mkdirSync(rt.state.ipsec.pidDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(runtime.resolve(rt, 'ipsec', 'ipsec.d'), { recursive: true, mode: 0o700 });

  runtime.write(rt, 'ipsec/ipsec.conf', `
config setup
    uniqueids=no

conn ${rt.state.ipsec.name}
    keyexchange=ikev1
    authby=secret
    type=transport
    left=%defaultroute
    leftprotoport=17/1701
    right=${address}
    rightprotoport=17/1701
    forceencaps=yes
    ike=aes256-sha1-modp2048,aes128-sha1-modp2048,aes256-sha1-modp1024,aes128-sha1-modp1024,3des-sha1-modp1024
    esp=aes256-sha1,aes128-sha1,3des-sha1
    dpdaction=clear
    dpddelay=30s
    dpdtimeout=120s
    keyingtries=3
    auto=add
`.trimStart());

  runtime.write(rt, 'ipsec/ipsec.secrets', `: PSK "${psk.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`);
}

async function start(rt) {
  process.stdout.write('Starting strongSwan...\n');
  await command(rt, ['start']);
}

async function waitStarted(rt, timeout) {
  const expiresAt = Date.now() + timeout;
  while (Date.now() < expiresAt) {
    if ((await command(rt, ['status'], { allowFailure: true })).code === 0)
      return;
    await common.sleep(250);
  }
  throw new Error('strongSwan daemon did not become ready before timeout');
}

async function establish(rt, timeout) {
  process.stdout.write('Establishing IPsec...\n');
  await command(rt, ['up', rt.state.ipsec.name], { timeout });
}

async function waitEstablished(rt, timeout) {
  const expiresAt = Date.now() + timeout;
  while (Date.now() < expiresAt) {
    const status = await command(rt, ['status', rt.state.ipsec.name], { allowFailure: true });
    if (status.code === 0 && /\bESTABLISHED\b/.test(status.stdout) && /\bINSTALLED\b/.test(status.stdout))
      return;
    await common.sleep(250);
  }
  throw new Error('IPsec did not reach ESTABLISHED/INSTALLED state before timeout');
}

async function disconnect(rt) {
  if (rt.state.ipsec)
    await command(rt, ['down', rt.state.ipsec.name], { allowFailure: true });
}

async function stop(rt) {
  if (rt.state.ipsec)
    await command(rt, ['stop'], { allowFailure: true });
}

async function diagnostics(rt) {
  if (!rt.state.ipsec)
    return;
  const result = await command(rt, ['statusall'], { allowFailure: true });
  if (result.stdout)
    process.stderr.write(`\nstrongSwan status:\n${result.stdout}\n`);
}

module.exports = { prepare, start, waitStarted, establish, waitEstablished, disconnect, stop, diagnostics };

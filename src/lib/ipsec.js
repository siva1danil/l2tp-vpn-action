'use strict';

const fs = require('node:fs');
const path = require('node:path');
const common = require('./common');
const runtime = require('./runtime');

function command(rt, args, options = {}) {
  return common.exec('sudo', [
    'env',
    `STRONGSWAN_CONF=${rt.state.ipsec.settingsPath}`,
    'ipsec',
    ...args,
  ], options);
}

function prepare(rt, { address, psk }) {
  rt.state.ipsec = {
    name: `gha-${rt.state.instanceId}`,
    configPath: runtime.resolve(rt, 'ipsec', 'ipsec.conf'),
    secretsPath: runtime.resolve(rt, 'ipsec', 'ipsec.secrets'),
    settingsPath: runtime.resolve(rt, 'ipsec', 'strongswan.conf'),
    startAttempted: false,
  };
  runtime.save(rt);

  runtime.write(rt, 'ipsec/strongswan.conf', `starter {
    config_file = ${rt.state.ipsec.configPath}
}
charon {
    plugins {
        stroke {
            secrets_file = ${rt.state.ipsec.secretsPath}
        }
    }
}
`);

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
  const pidDir = (await command(rt, ['--piddir'])).stdout.trim();
  if (!pidDir)
    throw new Error('Could not determine strongSwan PID directory');

  const starterPidPath = path.join(pidDir, 'starter.charon.pid');
  const charonPidPath = path.join(pidDir, 'charon.pid');
  const daemons = new Set(['starter', 'charon', 'charon-systemd']);
  const processRunning = fs.readdirSync('/proc').some(pid => {
    if (!/^\d+$/.test(pid))
      return false;
    try {
      return daemons.has(fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim());
    } catch {
      return false;
    }
  });
  if (fs.existsSync(starterPidPath) || fs.existsSync(charonPidPath) || processRunning)
    throw new Error('An existing strongSwan instance is running on this runner');

  rt.state.ipsec.starterPidPath = starterPidPath;
  rt.state.ipsec.startAttempted = true;
  runtime.save(rt);

  process.stdout.write('Starting strongSwan...\n');
  await command(rt, ['start', '--conf', rt.state.ipsec.configPath]);
}

async function waitStarted(rt, timeout) {
  const expiresAt = Date.now() + timeout;
  const startupGracePeriod = Date.now() + 2000;
  while (Date.now() < expiresAt) {
    if ((await command(rt, ['stroke', 'status'], { allowFailure: true })).code === 0)
      return;
    if (Date.now() >= startupGracePeriod && !fs.existsSync(rt.state.ipsec.starterPidPath))
      throw new Error('strongSwan starter exited before the daemon became ready; check the runner journal');
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
  if (rt.state.ipsec?.startAttempted)
    await command(rt, ['down', rt.state.ipsec.name], { allowFailure: true });
}

async function stop(rt) {
  if (!rt.state.ipsec?.startAttempted)
    return;

  const pidPath = rt.state.ipsec.starterPidPath;
  if (!pidPath || !fs.existsSync(pidPath))
    return;

  const pid = fs.readFileSync(pidPath, 'utf8').trim();
  if (!/^\d+$/.test(pid))
    return;

  let args;
  try {
    args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  } catch {
    return;
  }
  if (!args.includes('--conf') || !args.includes(rt.state.ipsec.configPath))
    return;

  await command(rt, ['stop'], { allowFailure: true });
}

async function diagnostics(rt) {
  if (!rt.state.ipsec?.startAttempted)
    return;
  const result = await command(rt, ['statusall'], { allowFailure: true });
  if (result.stdout)
    process.stderr.write(`\nstrongSwan status:\n${result.stdout}\n`);
}

module.exports = { prepare, start, waitStarted, establish, waitEstablished, disconnect, stop, diagnostics };

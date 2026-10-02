'use strict';

const fs = require('node:fs');
const { isIP } = require('node:net');
const { CHAP_SECRETS, CONNECTION_NAME, IPSEC_CONFIG, IPSEC_SECRETS, PPP_CONFIG, PPP_OPTIONS, XL2TP_CONFIG } = require('./lib/configs');
const { run, writeRootFile } = require('./lib/lib');

/* Cleanup state */

function saveState(name, value) {
  if (process.env.GITHUB_STATE)
    fs.appendFileSync(process.env.GITHUB_STATE, `${name}=${value}\n`);
}

/* Input parameters */

function getHost() {
  const value = (process.env.INPUT_HOST || '').trim();
  if (!value)
    throw new Error("Input 'host' is required");
  if (value.length > 253 || !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|[0-9a-fA-F:]+)$/.test(value))
    throw new Error("Input 'host' must be a hostname or IP address");

  return value;
}

function getUsername() {
  const value = (process.env.INPUT_USERNAME || '').trim();
  if (!value)
    throw new Error("Input 'username' is required");
  if (/[\x00-\x1f\x7f]/.test(value))
    throw new Error("Input 'username' contains control characters");

  process.stdout.write(`::add-mask::${value}\n`);
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getPassword() {
  const value = process.env.INPUT_PASSWORD || '';
  if (!value)
    throw new Error("Input 'password' is required");
  if (/[\x00-\x1f\x7f]/.test(value))
    throw new Error("Input 'password' contains control characters");

  process.stdout.write(`::add-mask::${value}\n`);
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getPsk() {
  const value = process.env.INPUT_PSK || '';
  if (!value)
    throw new Error("Input 'psk' is required");
  if (/[\x00-\x1f\x7f]/.test(value))
    throw new Error("Input 'psk' contains control characters");

  process.stdout.write(`::add-mask::${value}\n`);
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getTimeout() {
  const raw = (process.env.INPUT_TIMEOUT || '45').trim();
  if (!/^\d+$/.test(raw))
    throw new Error("Input 'timeout' must be an integer");

  const value = Number(raw);
  if (value < 5 || value > 300)
    throw new Error("Input 'timeout' must be between 5 and 300 seconds");

  return value;
}

function getRoutes() {
  const routes = (process.env.INPUT_ROUTES || '')
    .split(/[\n,]/)
    .map(value => value.trim())
    .filter(Boolean);

  const normalized = routes.map(route => {
    const match = route.match(/^(.+)\/(\d{1,2})$/);
    if (!match || isIP(match[1]) !== 4 || Number(match[2]) > 32)
      throw new Error(`Invalid route '${route}'; routes must be IPv4 CIDRs`);

    const prefix = Number(match[2]);
    const network = match[1]
      .split('.')
      .map((octet, index) => {
        const networkBits = Math.max(0, Math.min(8, prefix - index * 8));
        const blockSize = 2 ** (8 - networkBits);
        return Math.floor(Number(octet) / blockSize) * blockSize;
      })
      .join('.');

    const start = network.split('.')
      .reduce((address, octet) => address * 256 + Number(octet), 0);

    return { cidr: `${network}/${prefix}`, prefix, start, size: 2 ** (32 - prefix) };
  });

  const filtered = normalized
    .filter((route, index) => normalized.findIndex(other => other.cidr === route.cidr) === index)
    .filter(route => !normalized.some(other =>
      other.prefix < route.prefix &&
      route.start >= other.start &&
      route.start < other.start + other.size))
    .map(route => route.cidr);

  return filtered;
}

/* VPN readiness checks */

async function waitCharon(timeoutSeconds) {
  const deadline = Date.now() + Math.min(timeoutSeconds, 20) * 1000;
  while (Date.now() < deadline) {
    const result = await run('pgrep', ['-x', 'charon'], { capture: true, allowFailure: true });
    if (result.code === 0)
      return;

    process.stdout.write('Waiting for strongSwan charon daemon to start...\n');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('strongSwan charon daemon did not start');
}

async function waitTunnel(timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const [status, links] = await Promise.all([
      run('sudo', ['ipsec', 'status', CONNECTION_NAME], { capture: true, allowFailure: true }),
      run('ip', ['-o', 'link', 'show'], { capture: true, allowFailure: true }),
    ]);

    if (status.code === 0 && /ESTABLISHED/.test(status.stdout) && links.code === 0) {
      const names = [...links.stdout.matchAll(/\d+: (ppp\d+):/g)].map(match => match[1]);
      for (const name of names) {
        const address = await run('ip', ['-4', '-o', 'address', 'show', 'dev', name, 'scope', 'global'], { capture: true, allowFailure: true });
        if (address.code === 0 && /\binet\s/.test(address.stdout))
          return name;
      }
    }

    process.stdout.write('Waiting for IPsec and PPP to become ready...\n');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`VPN did not become ready within ${timeoutSeconds} seconds`);
}

async function waitXl2tpControl(timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const result = await run('sudo', ['test', '-e', '/run/xl2tpd/l2tp-control'], { capture: true, allowFailure: true });
    if (result.code === 0)
      return;

    process.stdout.write('Waiting for xl2tpd control file to appear...\n');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('xl2tpd control file did not appear');
}

/* VPN routing */

async function resolveAddress(host) {
  if (isIP(host) === 4)
    return host;

  const result = await run('getent', ['ahostsv4', host], { capture: true, allowFailure: true });
  const address = result.stdout.trim().split(/\s+/)[0] || '';
  if (result.code !== 0 || isIP(address) !== 4)
    throw new Error(`Could not resolve an IPv4 address for VPN server '${host}'`);

  return address;
}

async function protectVpnServerRoute(address) {
  const exact = await run('ip', ['route', 'show', 'exact', `${address}/32`], { capture: true, allowFailure: true });
  if (exact.stdout.trim())
    return;

  const lookup = await run('ip', ['-j', 'route', 'get', address], { capture: true, allowFailure: true });
  if (lookup.code !== 0)
    throw new Error(`Could not determine the original route to VPN server ${address}`);

  const [route] = JSON.parse(lookup.stdout);
  if (!route?.dev)
    throw new Error(`Original route to VPN server ${address} has no network device`);

  const args = ['ip', 'route', 'add', `${address}/32`];
  if (route.gateway)
    args.push('via', route.gateway);
  args.push('dev', route.dev);
  await run('sudo', args);

  saveState('vpn_server_route', `${address}/32`);
}

async function addDefaultRoute(device) {
  const original = await run('sudo', ['ip', '-4', 'route', 'save', 'table', 'main', 'default'], {
    capture: true,
    encoding: 'base64',
  });
  saveState('original_default_route', original.stdout);
  saveState('vpn_interface', device);

  await run('sudo', ['ip', '-4', 'route', 'replace', 'default', 'dev', device, 'metric', '0']);
}

/* Connection diagnostics */

async function diagnostics() {
  process.stdout.write('VPN diagnostics:\n');
  await run('ip', ['address'], { allowFailure: true });
  await run('ip', ['route'], { allowFailure: true });
  await run('sudo', ['ipsec', 'statusall'], { allowFailure: true });
  await run('sudo', ['journalctl', '-u', 'strongswan-starter', '-u', 'xl2tpd', '--no-pager', '-n', '150'], { allowFailure: true });
}

/* VPN setup */

async function main() {
  if (process.platform !== 'linux')
    throw new Error('This action supports Linux runners only');

  const host = getHost();
  const username = getUsername();
  const password = getPassword();
  const psk = getPsk();
  const routes = getRoutes();
  const timeout = getTimeout();

  const address = await resolveAddress(host);
  if (routes.includes(`${address}/32`))
    throw new Error(`Route '${address}/32' conflicts with the direct route to the VPN server`);

  await protectVpnServerRoute(address);
  await run('sudo', ['apt-get', 'update']);
  await run('sudo', ['apt-get', 'install', '-y', '--no-install-recommends', 'strongswan', 'xl2tpd', 'ppp']);
  await checkBinaries(['ipsec', 'xl2tpd', 'pppd'], true);
  await run('sudo', ['systemctl', 'stop', 'strongswan-starter', 'xl2tpd'], { allowFailure: true });

  await writeRootFile('/etc/ipsec.conf', IPSEC_CONFIG(address), '644');
  await writeRootFile('/etc/ipsec.secrets', IPSEC_SECRETS(psk));
  await writeRootFile('/etc/xl2tpd/xl2tpd.conf', XL2TP_CONFIG(address), '644');
  await writeRootFile(PPP_OPTIONS, PPP_CONFIG(username));
  await writeRootFile('/etc/ppp/chap-secrets', CHAP_SECRETS(username, password));

  process.stdout.write('Starting IPsec...\n');
  saveState('vpn_started', 'true');
  await run('sudo', ['systemctl', 'restart', 'strongswan-starter']);
  await waitCharon(timeout);
  await run('sudo', ['timeout', `${timeout}s`, 'ipsec', 'up', CONNECTION_NAME]);

  process.stdout.write('Starting L2TP and PPP...\n');
  await run('sudo', ['systemctl', 'restart', 'xl2tpd']);
  await waitXl2tpControl(timeout);
  await run('sudo', ['tee', '/run/xl2tpd/l2tp-control'], { input: `c ${CONNECTION_NAME}\n`, silent: true });

  const device = await waitTunnel(timeout);
  if (routes[0] === '0.0.0.0/0')
    await addDefaultRoute(device);
  else
    for (const route of routes)
      await run('sudo', ['ip', 'route', 'replace', route, 'dev', device]);

  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `interface=${device}\n`);

  process.stdout.write(`VPN is ready on ${device}\n`);
}

/* Entry point */

main().catch(async error => {
  process.stderr.write(`::error::${error.message}\n`);
  await diagnostics().catch(() => { });
  process.exitCode = 1;
});

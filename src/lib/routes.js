'use strict';

const fs = require('node:fs');
const common = require('./common');
const runtime = require('./runtime');

const PROTOCOL = '242';

async function backupSnapshot(cidr, backupPath) {
  const result = await common.run('ip', ['-4', 'route', 'save', 'table', 'main', 'exact', cidr]);
  fs.writeFileSync(backupPath, result.stdout, { mode: 0o600 });
}

async function restoreSnapshot(backupPath) {
  if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size === 0)
    return;
  const result = await common.run('sudo', ['ip', '-4', 'route', 'restore'], {
    input: fs.readFileSync(backupPath),
    allowFailure: true,
  });
  if (result.code !== 0)
    common.warning(`Could not restore route snapshot '${backupPath}'`);
}

async function protectEndpoint(rt, address, requestedRoutes) {
  if (!requestedRoutes.some(route => common.cidrContains(route, address)))
    return;

  const cidr = `${address}/32`;
  const backupPath = runtime.resolve(rt, 'routes', 'endpoint.route');
  await backupSnapshot(cidr, backupPath);

  const [route] = JSON.parse((await common.exec('ip', ['-4', '-j', 'route', 'get', address])).stdout);
  if (!route?.dev)
    throw new Error(`Could not determine original route to VPN server ${address}`);

  rt.state.endpointRoute = { cidr, backupPath, interfaceName: route.dev, installed: false };;
  runtime.save(rt);

  const args = ['ip', '-4', 'route', 'replace', cidr];
  if (route.gateway)
    args.push('via', route.gateway);
  args.push('dev', route.dev, 'proto', PROTOCOL);
  if (route.prefsrc)
    args.push('src', route.prefsrc);
  await common.exec('sudo', args);

  rt.state.endpointRoute.installed = true;
  runtime.save(rt);
}

async function install(rt, requestedRoutes, interfaceName) {
  for (let i = 0; i < requestedRoutes.length; i++) {
    const cidr = requestedRoutes[i];
    const backupPath = runtime.resolve(rt, 'routes', `${String(i).padStart(3, '0')}.route`);
    await backupSnapshot(cidr, backupPath);

    const entry = { cidr, backupPath, interfaceName, installed: false };
    rt.state.routes.push(entry);
    runtime.save(rt);

    await common.exec('sudo', ['ip', '-4', 'route', 'replace', cidr, 'dev', interfaceName, 'proto', PROTOCOL]);
    entry.installed = true;
    runtime.save(rt);
  }
}

async function uninstall(rt) {
  for (const route of [...(rt.state.routes || [])].reverse()) {
    if (route.installed)
      await common.exec('sudo', ['ip', '-4', 'route', 'del', route.cidr, 'dev', route.interfaceName, 'proto', PROTOCOL], { allowFailure: true });
    await restoreSnapshot(route.backupPath);
  }

  const endpoint = rt.state.endpointRoute;
  if (endpoint) {
    if (endpoint.installed)
      await common.exec('sudo', ['ip', '-4', 'route', 'del', endpoint.cidr, 'dev', endpoint.interfaceName, 'proto', PROTOCOL], { allowFailure: true });
    await restoreSnapshot(endpoint.backupPath);
  }
}

module.exports = { protectEndpoint, install, uninstall };

'use strict';

const net = require('node:net');
const common = require('./lib/common');
const ipsec = require('./lib/ipsec');
const l2tp = require('./lib/l2tp');
const ppp = require('./lib/ppp');
const routes = require('./lib/routes');
const runtime = require('./lib/runtime');

function input() {
  const host = (process.env.INPUT_HOST || '').trim();
  if (!host)
    throw new Error("Input 'host' is required");
  if (net.isIP(host) !== 4 && !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(host))
    throw new Error("Input 'host' must be an IPv4 address or hostname");

  const psk = process.env.INPUT_PSK || '';
  if (!psk)
    throw new Error("Input 'psk' is required");
  if (/[\x00-\x1f\x7f]/.test(psk))
    throw new Error("Input 'psk' contains control characters");
  common.mask(psk);

  const username = process.env.INPUT_USERNAME || '';
  if (!username)
    throw new Error("Input 'username' is required");
  if (/[\x00-\x1f\x7f]/.test(username))
    throw new Error("Input 'username' contains control characters");
  common.mask(username);

  const password = process.env.INPUT_PASSWORD || '';
  if (!password)
    throw new Error("Input 'password' is required");
  if (/[\x00-\x1f\x7f]/.test(password))
    throw new Error("Input 'password' contains control characters");
  common.mask(password);

  const routes = [...new Set((process.env.INPUT_ROUTES || '')
    .split(/[\n,]/)
    .map(value => value.trim())
    .filter(Boolean)
    .map(common.normalizeCidr))];
  if (routes.includes('0.0.0.0/0'))
    throw new Error("Route '0.0.0.0/0' is not supported in v2");

  const rawTimeout = (process.env.INPUT_TIMEOUT || '60').trim();
  if (!/^\d+$/.test(rawTimeout))
    throw new Error("Input 'timeout' must be an integer");
  const timeout = Number(rawTimeout);
  if (timeout < 1 || timeout > 300)
    throw new Error("Input 'timeout' must be between 1 and 300 seconds");

  return { host, psk, username, password, routes, timeout };
}

async function main() {
  const inputs = input();

  const packages = await common.checkDependencies();
  await common.installDependencies(packages);

  const rt = runtime.create();
  common.state('runtime_dir', rt.root);

  try {
    const address = await common.resolveIpv4(inputs.host);
    rt.state.host = inputs.host;
    rt.state.address = address;
    runtime.save(rt);

    const pppConfig = ppp.prepare(rt, { username: inputs.username, password: inputs.password });
    ipsec.prepare(rt, { address, psk: inputs.psk });
    l2tp.prepare(rt, { address, pppOptionsPath: pppConfig.optionsPath });

    const deadline = Date.now() + inputs.timeout * 1000;

    await ipsec.start(rt);
    await ipsec.waitStarted(rt, deadline - Date.now());
    await ipsec.establish(rt, deadline - Date.now());
    await ipsec.waitEstablished(rt, deadline - Date.now());

    await l2tp.start(rt);
    await l2tp.wait(rt, deadline - Date.now());
    await l2tp.connect(rt);

    const connection = await ppp.wait(rt, deadline - Date.now());

    await routes.protectEndpoint(rt, address, inputs.routes);
    await routes.install(rt, inputs.routes, connection.interface);

    common.output('interface', connection.interface);
    common.output('local-ip', connection.localIp);
    common.output('peer-ip', connection.peerIp);
    process.stdout.write(`VPN is ready on ${connection.interface} (${connection.localIp})\n`);
  } catch (cause) {
    await ipsec.diagnostics(rt).catch(() => { });
    await routes.uninstall(rt).catch(error => common.warning(`Route cleanup failed: ${error.message}`));
    await l2tp.disconnect(rt).catch(error => common.warning(`L2TP disconnect failed: ${error.message}`));
    await l2tp.stop(rt).catch(error => common.warning(`xl2tpd cleanup failed: ${error.message}`));
    await ipsec.disconnect(rt).catch(error => common.warning(`IPsec disconnect failed: ${error.message}`));
    await ipsec.stop(rt).catch(error => common.warning(`strongSwan cleanup failed: ${error.message}`));
    await runtime.remove(rt);
    throw cause;
  }
}

main().catch(cause => {
  common.error(cause.message);
  process.exitCode = 1;
});

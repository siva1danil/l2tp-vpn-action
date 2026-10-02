'use strict';

const { run } = require('./lib/lib');
const { CONNECTION_NAME } = require('./lib/configs');

/* VPN cleanup */

async function main() {
  process.stdout.write('Disconnecting L2TP/IPsec VPN...\n');

  const device = process.env.STATE_vpn_interface;
  const original = process.env.STATE_original_default_route;
  if (original && device) {
    await run('sudo', ['ip', '-4', 'route', 'del', 'default', 'dev', device, 'metric', '0'], { allowFailure: true });
    const restored = await run('sudo', ['ip', '-4', 'route', 'restore'], { input: Buffer.from(original, 'base64'), allowFailure: true });
    if (restored.code !== 0)
      process.stderr.write('::warning::Could not restore the original default route\n');
  }

  if (process.env.STATE_vpn_server_route)
    await run('sudo', ['ip', '-4', 'route', 'del', process.env.STATE_vpn_server_route], { allowFailure: true });

  if (process.env.STATE_vpn_started === 'true') {
    await run('sudo', ['ipsec', 'down', CONNECTION_NAME], { allowFailure: true });
    await run('sudo', ['systemctl', 'stop', 'xl2tpd'], { allowFailure: true });
  }
}

/* Entry point */

main().catch(error => process.stderr.write(`::warning::VPN cleanup failed: ${error.message}\n`));

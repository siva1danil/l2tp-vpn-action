'use strict';

const common = require('./lib/common');
const ipsec = require('./lib/ipsec');
const l2tp = require('./lib/l2tp');
const routes = require('./lib/routes');
const runtime = require('./lib/runtime');

async function main() {
  const root = process.env.STATE_runtime_dir;
  if (!root)
    return;

  if (!runtime.exists(root)) {
    await runtime.remove({ root });
    return;
  }

  process.stdout.write('Disconnecting L2TP/IPsec VPN...\n');
  const rt = runtime.open(root);

  await routes.restore(rt).catch(error => common.warning(`Route cleanup failed: ${error.message}`));
  await l2tp.disconnect(rt).catch(error => common.warning(`L2TP disconnect failed: ${error.message}`));
  await l2tp.stop(rt).catch(error => common.warning(`xl2tpd cleanup failed: ${error.message}`));
  await ipsec.disconnect(rt).catch(error => common.warning(`IPsec disconnect failed: ${error.message}`));
  await ipsec.stop(rt).catch(error => common.warning(`strongSwan cleanup failed: ${error.message}`));
  await runtime.remove(rt);
}

main().catch(cause => common.warning(`VPN cleanup failed: ${cause.message}`));

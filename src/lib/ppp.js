'use strict';

const common = require('./common');
const runtime = require('./runtime');

function prepare(rt, { username, password }) {
  rt.state.ppp = {
    interfaceName: `gha-l2tp-${rt.state.instanceId}`,
    optionsPath: runtime.resolve(rt, 'ppp', 'options'),
    logPath: runtime.resolve(rt, 'ppp', 'pppd.log'),
  };
  runtime.save(rt);

  runtime.write(rt, 'ppp/options', `
logfile "${rt.state.ppp.logPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
name "${username.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
password "${password.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
ifname ${rt.state.ppp.interfaceName}
ipcp-accept-local
ipcp-accept-remote
noauth
noipdefault
nodefaultroute
refuse-eap
refuse-pap
refuse-chap
refuse-mschap
mtu 1400
mru 1400
lock
`.trimStart());

  return rt.state.ppp;
}

async function wait(rt, timeout) {
  process.stdout.write('Waiting for PPP...\n');

  const expiresAt = Date.now() + timeout;
  while (Date.now() < expiresAt) {
    const result = await common.exec('ip', ['-4', '-j', 'address', 'show', 'dev', rt.state.ppp.interfaceName], { allowFailure: true });
    if (result.code === 0 && result.stdout.trim()) {
      try {
        const [link] = JSON.parse(result.stdout);
        const address = link?.addr_info?.find(item => item.family === 'inet' && item.local);
        if (address)
          return { interface: rt.state.ppp.interfaceName, localIp: address.local, peerIp: address.peer || '' };
      } catch {
        // Continue to wait if JSON parsing or address extraction fails
      }
    }
    await common.sleep(250);
  }

  throw new Error('PPP interface did not become online before timeout');
}

async function diagnostics(rt) {
  if (!rt.state.ppp?.logPath)
    return;

  const result = await common.exec('sudo', ['tail', '-n', '50', '--', rt.state.ppp.logPath], { allowFailure: true });
  if (result.code === 0 && result.stdout.trim())
    process.stderr.write(`\npppd log:\n${result.stdout}\n`);
}

module.exports = { prepare, wait, diagnostics };

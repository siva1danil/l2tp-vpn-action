'use strict';

const dns = require('node:dns').promises;
const fs = require('node:fs');
const net = require('node:net');
const child_process = require('node:child_process');

/* Process execution */

function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env || process.env,
      cwd: options.cwd,
    });

    const timers = [];
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.stdin.end(options.input ?? '');

    child.on('error', reject);
    child.on('close', code => {
      timers.forEach(clearTimeout);
      const result = { code: code ?? 128, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (result.code === 0 || options.allowFailure)
        return resolve(result);
      else
        return reject(new Error(`${command} exited with code=${result.code}, stdout=${result.stdout.toString('utf8').trim()}, stderr=${result.stderr.toString('utf8').trim()}`));
    });

    if (options.timeout !== undefined)
      timers.push(setTimeout(() => child.kill('SIGTERM'), options.timeout), setTimeout(() => child.kill('SIGKILL'), options.timeout + 2000));
  });
}

async function exec(command, args = [], options = {}) {
  const result = await run(command, args, options);
  return { ...result, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') };
}

async function which(command) {
  const result = await exec('which', [command], { allowFailure: true });
  return result.code === 0 ? result.stdout.trim() || null : null;
}

/* Timing */

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* GitHub Actions integration */

function mask(value) {
  if (value)
    process.stdout.write(`::add-mask::${value}\n`);
}

function warning(message) {
  process.stderr.write(`::warning::${message}\n`);
}

function error(message) {
  process.stderr.write(`::error::${message}\n`);
}

function state(name, value) {
  if (process.env.GITHUB_STATE)
    fs.appendFileSync(process.env.GITHUB_STATE, `${name}=${value}\n`);
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/* IPv4 addresses and networks */

function ipv4ToInt(address) {
  return address.split('.').reduce((value, octet) => (value * 256 + Number(octet)) >>> 0, 0) >>> 0;
}

function intToIpv4(value) {
  return [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.');
}

function normalizeCidr(value) {
  const match = value.match(/^([^/]+)\/(\d{1,2})$/);
  if (!match || net.isIP(match[1]) !== 4)
    throw new Error(`Invalid route '${value}'; expected an IPv4 CIDR`);

  const prefix = Number(match[2]);
  if (prefix < 0 || prefix > 32)
    throw new Error(`Invalid route '${value}'; prefix must be between 0 and 32`);

  const ip = ipv4ToInt(match[1]);
  const maskValue = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return `${intToIpv4(ip & maskValue)}/${prefix}`;
}

function cidrContains(cidr, address) {
  const [network, prefixRaw] = cidr.split('/');
  const prefix = Number(prefixRaw);
  const maskValue = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToInt(network) & maskValue) === (ipv4ToInt(address) & maskValue);
}

async function resolveIpv4(host) {
  if (net.isIP(host) === 4)
    return host;

  return dns.lookup(host, { family: 4 })
    .then(result => result.address)
    .catch(cause => { throw new Error(`Could not resolve IPv4 address for '${host}': ${cause.message}`); });
}

/* Dependency management */

async function checkDependencies() {
  const platforms = ['linux'];
  const critical = ['sudo'];
  const required = [
    ['ip', 'iproute2'],
    ['ipsec', 'strongswan-starter'],
    ['xl2tpd', 'xl2tpd'],
    ['xl2tpd-control', 'xl2tpd'],
    ['pppd', 'ppp'],
  ];

  if (!platforms.includes(process.platform))
    throw new Error('This action only supports ' + platforms.join(', ') + ' platforms');

  for (const command of critical)
    if (!await which(command))
      throw new Error(`Command '${command}' is required`);

  const missing = new Set();
  for (const [command, pkg] of required)
    if (!await which(command))
      missing.add(pkg);

  return missing;
}

async function installDependencies(packages) {
  if (packages.size === 0)
    return;

  if (!await which('apt-get'))
    throw new Error(`Missing dependencies [${[...packages].join(', ')}] and 'apt-get' is not available`);

  process.stdout.write(`Installing missing dependencies: ${[...packages].join(', ')}\n`);

  const policy = '/usr/sbin/policy-rc.d';
  const shouldManagePolicy = !fs.existsSync(policy);
  try {
    if (shouldManagePolicy) {
      await run('sudo', ['tee', policy], { input: '#!/bin/sh\nexit 101\n' });
      await run('sudo', ['chmod', '755', policy]);
    }
    await run('sudo', ['apt-get', 'update']);
    await run('sudo', ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '--no-install-recommends', ...packages]);
  } finally {
    if (shouldManagePolicy)
      await run('sudo', ['rm', '-f', '--', policy], { allowFailure: true });
  }
}

module.exports = {
  /* Process execution */
  run,
  exec,
  which,
  /* Timing */
  sleep,
  /* GitHub Actions integration */
  mask,
  warning,
  error,
  state,
  output,
  /* IPv4 addresses and networks */
  ipv4ToInt,
  intToIpv4,
  normalizeCidr,
  cidrContains,
  resolveIpv4,
  /* Dependency management */
  checkDependencies,
  installDependencies,
};

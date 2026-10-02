'use strict';

/* VPN connection name */

const CONNECTION_NAME = 'github-actions-l2tp';

/* PPP options file path */

const PPP_OPTIONS = '/etc/ppp/options.github-actions-l2tp';

/* IPsec configuration */

const IPSEC_CONFIG = host => `
config setup
    uniqueids=no

conn ${CONNECTION_NAME}
    keyexchange=ikev1
    authby=secret
    left=%defaultroute
    leftprotoport=17/1701
    right=${host}
    rightprotoport=17/1701
    type=transport
    forceencaps=yes
    ike=aes256-sha1-modp2048,aes128-sha1-modp2048,aes256-sha1-modp1024,aes128-sha1-modp1024,3des-sha1-modp1024
    esp=aes256-sha1,aes128-sha1,3des-sha1
    dpdaction=clear
    dpddelay=30s
    dpdtimeout=120s
    keyingtries=3
    auto=add
`.trimStart();

/* IPsec secrets */

const IPSEC_SECRETS = psk => `
: PSK "${psk}"
`.trimStart();

/* XL2TP configuration */

const XL2TP_CONFIG = host => `
[global]
port = 1701

[lac ${CONNECTION_NAME}]
lns = ${host}
pppoptfile = ${PPP_OPTIONS}
length bit = yes
redial = no
autodial = no
`.trimStart();

/* PPP configuration */

const PPP_CONFIG = username => `
name "${username}"
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
`.trimStart();

/* CHAP secrets */

const CHAP_SECRETS = (username, password) => `
"${username}" * "${password}" *
`.trimStart();

/* Module exports */

module.exports = { CHAP_SECRETS, CONNECTION_NAME, IPSEC_CONFIG, IPSEC_SECRETS, PPP_CONFIG, PPP_OPTIONS, XL2TP_CONFIG };

# L2TP/IPsec VPN Action

Access private network resources from GitHub Actions through an L2TP/IPsec VPN.

## Usage

```yaml
- name: Connect VPN
  id: vpn
  uses: siva1danil/l2tp-vpn-action@v2
  with:
    host: ${{ secrets.VPN_HOST }}
    psk: ${{ secrets.VPN_PSK }}
    username: ${{ secrets.VPN_USERNAME }}
    password: ${{ secrets.VPN_PASSWORD }}
    routes: |
      10.20.0.0/16
      192.168.50.0/24
    timeout: 60

- run: ping -c 3 192.168.50.1
```

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `host` | yes | — | VPN server address or hostname |
| `psk` | yes | — | IPsec pre-shared key |
| `username` | yes | — | PPP username |
| `password` | yes | — | PPP password |
| `routes` | no | empty | VPN CIDRs, separated by commas or newlines |
| `timeout` | no | `60` | Connection timeout in seconds (1–300) |

## Outputs

| Output | Description |
| --- | --- |
| `interface` | VPN PPP interface |
| `local-ip` | Assigned local IPv4 address |
| `peer-ip` | Peer IPv4 address, when available |

## Requirements

| Requirement | Value |
| --- | --- |
| Runner | Linux; Ubuntu/Debian for automatic package installation via `apt-get` |
| Privileges | Passwordless `sudo` |
| VPN | L2TP/IPsec with PSK, IPv4 only |
| Routing | Split routes only; `0.0.0.0/0` is currently not supported |
| Concurrency | One VPN connection per runner; no existing strongSwan/xl2tpd instance |

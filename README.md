# L2TP/IPsec VPN Action

Access private services from GitHub Actions through an existing L2TP/IPsec VPN.
Use it for deployments, integration tests, and maintenance jobs that need access
to your internal network. The connection is available to subsequent steps and
closes during job cleanup.

## Requirements

| Requirement | Value |
| --- | --- |
| Runner | Linux runner (Ubuntu recommended) |
| Services | `systemd` |
| Package manager | `apt-get` |
| Privileges | Passwordless `sudo` |
| VPN | L2TP over IPsec with PSK |
| Network | IPv4 only, server hostname must resolve to IPv4 |

IPv6 traffic keeps the runner's existing routes. Installed packages and
overwritten VPN configuration remain after cleanup. The original default routes are restored.

## Parameters

| Parameter | Required | Default | Description |
| --- | --- | --- | --- |
| `host` | Yes | — | Server address or hostname |
| `username` | Yes | — | PPP username |
| `password` | Yes | — | PPP password |
| `psk` | Yes | — | IPsec pre-shared key |
| `routes` | No | — | Comma/newline-separated CIDRs; `0.0.0.0/0` for default routing |
| `timeout` | No | `45` | Connection timeout in seconds (`5`–`300`) |

## Usage

```yaml
- uses: siva1danil/l2tp-vpn-action@v1
  id: vpn
  with:
    host: ${{ secrets.VPN_HOST }}
    username: ${{ secrets.VPN_USERNAME }}
    password: ${{ secrets.VPN_PASSWORD }}
    psk: ${{ secrets.VPN_PSK }}
    routes: 192.168.1.0/24

- run: ping -c 3 192.168.1.1
```

The PPP interface is available as `${{ steps.vpn.outputs.interface }}`.

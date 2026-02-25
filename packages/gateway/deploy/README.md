# Gateway Deploy Scripts

## `manual-install.sh`

Installs gateway on an existing Linux host (systemd):

```bash
sudo ./manual-install.sh \
  --binary-source /path/to/chatcode-gateway \
  --gateway-id gw_xxx \
  --gateway-auth-token tok_xxx \
  --cp-url wss://cp.staging.chatcode.dev/gw/connect
```

What it does:
- creates `vibe` user (if missing)
- prepares `~vibe/.ssh/authorized_keys` and `~/workspace`
- installs binary to `/usr/local/bin/chatcode-gateway`
- writes `/etc/chatcode/gateway.env`
- installs `chatcode-gateway.service` and starts it

## `gateway-cleanup.sh`

Removes gateway install artifacts. Destructive by default:

```bash
sudo ./gateway-cleanup.sh --yes
```

By default it removes:
- `chatcode-gateway` systemd service
- `/usr/local/bin/chatcode-gateway`
- `/etc/chatcode`
- `/tmp/chatcode` and `/opt/chatcode`
- `vibe` sudoers entry
- `vibe` user and home directory

Optional safety flags:
- `--keep-user` keep `vibe` user/home
- `--keep-workspace` keep `~/workspace` (requires `--keep-user`)

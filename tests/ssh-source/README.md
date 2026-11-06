# SSH import test source (#83)

A throwaway WordPress server for the first real run of the SSH import (`deploy/import.sh` with `SSH=`, PR #83). It takes **no inbound traffic**. SSH reaches it only through a Cloudflare Tunnel (outbound from the box), behind Cloudflare Access with a service token. There is no IP allowlist. Design: #31, comment 6681505234. DNS record: CR #101.

## What it makes

- A Vultr box (`vc2-1c-1gb`, Ubuntu 24.04, billed by the hour) with MariaDB, PHP CLI, WP-CLI and a small WordPress site: 5 posts, 1 image, the Hello Dolly plugin active. It has no web server.
- A Vultr firewall group with one rule that matches nothing. A group with no rules allows all inbound (measured in `deploy/mysql`).
- On the box, `ufw` denies all inbound, and `sshd` listens on `127.0.0.1` only, with keys only.
- The user `importer`, with your public key. It can read the site (group `www-data`, files 640, folders 750) and cannot write it.
- A tunnel (`ssh://localhost:22` for the hostname, 404 for anything else), its proxied DNS record, an Access app, and a policy that admits only one service token (24 h).

## Apply (the lead)

```sh
cd tests/ssh-source
export CLOUDFLARE_API_TOKEN=... VULTR_API_KEY=...
cat > run.tfvars <<VARS          # ignored by git
account_id     = "<account id>"
zone_id        = "<zone id of skyphusion.net>"
hostname       = "wp-ssh-src.skyphusion.net"
ssh_public_key = "<your ssh public key line>"
VARS
terraform init && terraform apply -var-file=run.tfvars
terraform output -raw ssh_config >> ~/.ssh/config
```

The token needs: Cloudflare Tunnel edit, Access apps and policies edit, Access service tokens edit, and DNS edit on the zone. The box takes a few minutes after the apply (cloud-init). It is ready when `/var/lib/ssh-source-ready` exists.

## Run

1. `./check.sh before` checks, from the laptop:
   - port 22 on the box's public address is closed;
   - SSH through the tunnel works with the service token;
   - SSH is refused without the token;
   - then it writes the marker for the read-only check.
2. The import, with the token in cloudflared's own variables (never in an argument):

   ```sh
   export TUNNEL_SERVICE_TOKEN_ID=$(terraform output -raw access_client_id)
   export TUNNEL_SERVICE_TOKEN_SECRET=$(terraform output -raw access_client_secret)
   SSH=importer@wp-ssh-src.skyphusion.net SSH_WP=/var/www/wordpress URL=<a b-dosql site> NAME=<its name> ../../deploy/import.sh
   ```

   Run it twice. First with WP-CLI on the box. Then with WP-CLI moved away (`ssh` to the box as the default user and `sudo mv /usr/local/bin/wp /root/`), which takes the `mysqldump` path that reads `DB_*` from `wp-config.php`.
3. `./check.sh after`: no file in the site, `/tmp`, `/var/tmp` or the importer's home is newer than the marker. **Not checked:** MariaDB's own files. The user `importer` cannot read `/var/lib/mysql`, and the dump only reads, with `--single-transaction`.

## Teardown

```sh
terraform destroy -var-file=run.tfvars
```

It removes the box, the firewall group, the tunnel, the DNS record, the Access app, the policy and the service token. Then `dig +short wp-ssh-src.skyphusion.net` must be empty, and the tunnel and the box must be gone from their lists. Remove the `Host wp-ssh-src.skyphusion.net` block from `~/.ssh/config`.

## Secrets

`run.tfvars` and the state are ignored by git. The state holds the service token, the database and admin passwords, and the tunnel token. The tunnel token and the database password are also in the box's user data (cloud-init). That is acceptable for a box with test data only, which lives for hours.

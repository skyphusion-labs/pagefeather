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

## The variant-a MariaDB import route (CR #141)

The box runs MariaDB for the #83 import source. CR #141 reuses that MariaDB as the live target for the #31 variant-`a` round trip, reached through **the same tunnel** on a second route. It is off by default (`enable_mysql_import = false`), so an SSH-only apply makes none of it and the SSH route is unchanged.

Set `enable_mysql_import = true` to add, alongside the SSH route:

- a TCP **3306** ingress rule on the tunnel, on hostname `mysql-import-a.skyphusion.org` (`mysql_import_hostname`), reaching `tcp://localhost:3306` on the box. The SSH rule stays first; the 3306 rule goes between it and the 404 catch-all.
- a proxied CNAME for that hostname to the tunnel, in the `skyphusion.org` zone (`mysql_import_zone_id`).
- its **own** Access service token (`wp-mysql-import-a`, not the SSH token), a policy that admits only that token (`non_identity`), and an Access application scoped to exactly that hostname.

There is no inbound port and no IP allowlist: this is the proven `tests/a/terraform` pattern (CR #27), never the `deploy/mysql` model (a Vultr firewall opening 3306 to Cloudflare ranges).

### The import run (the lead applies and verifies live)

1. Apply with `enable_mysql_import = true`. Hyperdrive for the variant-`a` site is made by `deploy.sh`, from these outputs:

   ```sh
   export MYSQL_HOST=$(terraform output -raw mysql_import_hostname)
   export MYSQL_PASSWORD=$(terraform output -raw db_password)
   export MYSQL_ACCESS_CLIENT_ID=$(terraform output -raw mysql_import_access_client_id)
   export MYSQL_ACCESS_CLIENT_SECRET=$(terraform output -raw mysql_import_access_client_secret)
   # MYSQL_USER defaults to wp and MYSQL_DATABASE to wordpress (the cloud-init grant).
   ```

2. **Prove the gate before the import** (add and prove before you remove): a TCP connection to `mysql-import-a.skyphusion.org:3306` carrying **no** service token must be refused by Access. Then confirm Hyperdrive, which holds the token, connects. A proof that only used the token has proven nothing about the gate.
3. `VARIANT=a MYSQL=external NAME=... deploy/deploy.sh`, then `VARIANT=a URL=... deploy/import.sh` for the round trip (the a2 mysqldump is a valid source).
4. `URL=<the variant-a site> SPIKE_TOKEN=... tests/a/id-zero.sh`: id 0 kept with the hint, renumbered to 1 under `NO_HINT=1` (the red control).

### Teardown (same day)

`terraform destroy` here removes the 3306 route, the import CNAME, the Access application, the policy and the service token along with the box; `deploy/destroy.sh` (or `terraform destroy` in `deploy/terraform` for the site) removes the Hyperdrive config. Then `dig +short mysql-import-a.skyphusion.org` must be empty.

## Secrets

`run.tfvars` and the state are ignored by git. The state holds the service token, the database and admin passwords, and the tunnel token. The tunnel token and the database password are also in the box's user data (cloud-init). That is acceptable for a box with test data only, which lives for hours.

# A benchmark runner at Vultr: one fixed vantage, so numbers from different
# days and different sites compare. The laptop is not one (home network, load,
# builds in parallel). See ../README.md.
#
# The runner has no inbound path at all. It pulls jobs from an R2 bucket and
# writes results back to it, so there is nothing to connect to.

# ---- Job bucket and its key -------------------------------------------------

resource "cloudflare_r2_bucket" "jobs" {
  account_id = var.account_id
  name       = var.bucket
}

# The runner's only credential: read and write objects in the job bucket.
# R2's S3 API takes the token id as the access key id and the SHA-256 of the
# token value as the secret (outputs.tf).
resource "cloudflare_account_token" "runner" {
  account_id = var.account_id
  name       = "${var.bucket}-runner"
  policies = [{
    effect = "allow"
    permission_groups = [
      { id = "6a018a9f2fc74eb6b293b0c548f38b39" }, # Workers R2 Storage Bucket Item Read
      { id = "2efd5506f9c8494dacb1fa10a3e7d5b6" }, # Workers R2 Storage Bucket Item Write
    ]
    resources = jsonencode({
      "com.cloudflare.edge.r2.bucket.${var.account_id}_default_${cloudflare_r2_bucket.jobs.name}" = "*"
    })
  }]
}

locals {
  r2_endpoint = "https://${var.account_id}.r2.cloudflarestorage.com"
  r2_secret   = sha256(cloudflare_account_token.runner.value)
}

# ---- The box ----------------------------------------------------------------

# A Vultr firewall group with no rules allows ALL inbound. The sentinel rule
# (port 1 from a documentation address) makes it deny everything else. There
# is no other rule: no SSH, no allowlist.
resource "vultr_firewall_group" "runner" {
  description = "bench-runner: no inbound (sentinel rule only)"
}

resource "vultr_firewall_rule" "sentinel" {
  firewall_group_id = vultr_firewall_group.runner.id
  ip_type           = "v4"
  protocol          = "tcp"
  subnet            = "192.0.2.1"
  subnet_size       = 32
  port              = "1"
  notes             = "sentinel: a group with no rules allows all"
}

# The R2 key is in user_data (and so in the Vultr instance metadata and in the
# state). The box is ours, short-lived, and the key reaches only the job
# bucket. See ../README.md.
resource "vultr_instance" "runner" {
  region            = var.region
  plan              = var.plan
  os_id             = 2284 # Ubuntu 24.04 LTS x64
  label             = "bench-runner"
  hostname          = "bench-runner"
  enable_ipv6       = false
  backups           = "disabled"
  activation_email  = false
  firewall_group_id = vultr_firewall_group.runner.id
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    repo        = var.repo
    branch      = var.branch
    region      = var.region
    plan        = var.plan
    r2_endpoint = local.r2_endpoint
    r2_bucket   = cloudflare_r2_bucket.jobs.name
    r2_key_id   = cloudflare_account_token.runner.id
    r2_secret   = local.r2_secret
    runner_sh   = base64encode(file("${path.module}/../box/bench-runner.sh"))
    runjob_py   = base64encode(file("${path.module}/../box/runjob.py"))
    unit        = base64encode(file("${path.module}/../box/bench-runner.service"))
  })
  depends_on = [vultr_firewall_rule.sentinel]
}

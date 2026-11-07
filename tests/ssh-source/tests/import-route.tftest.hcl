# Offline render checks of the CR #141 import route, with no live Cloudflare or
# Vultr account: mock_provider answers every API call, so `terraform test`
# plans the module without credentials. Run: terraform init && terraform test
# (from tests/ssh-source). Terraform >= 1.7.
#
# They assert the three things CR #141 names: the SSH route is untouched, the
# 3306 ingress and the token-only policy render, and nothing of the route is
# made when the switch is off.

mock_provider "cloudflare" {}
mock_provider "vultr" {}
mock_provider "random" {}

variables {
  account_id     = "0000000000000000account0000000000"
  zone_id        = "0000000000000000sshzone00000000000"
  hostname       = "wp-ssh-src.skyphusion.net"
  ssh_public_key = "ssh-ed25519 AAAATESTKEYONLY operator@test"
}

# Switch off: the box is the #83 SSH source and nothing of the import route
# exists. The ingress is SSH then the 404 catch-all, in that order.
run "import_off_leaves_ssh_only" {
  command = plan

  variables {
    enable_mysql_import = false
  }

  assert {
    condition     = length(cloudflare_zero_trust_tunnel_cloudflared_config.src.config.ingress) == 2
    error_message = "with the switch off the ingress must be SSH plus the 404 catch-all only"
  }
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared_config.src.config.ingress[0].service == "ssh://localhost:22"
    error_message = "the SSH ingress must be first"
  }
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared_config.src.config.ingress[1].service == "http_status:404"
    error_message = "the 404 catch-all must be last"
  }
  assert {
    condition     = length(cloudflare_zero_trust_access_application.mysql_import) == 0
    error_message = "with the switch off no import Access application is made"
  }
  assert {
    condition     = length(cloudflare_zero_trust_access_service_token.mysql_import) == 0
    error_message = "with the switch off no import service token is made"
  }
  assert {
    condition     = length(cloudflare_dns_record.mysql_import) == 0
    error_message = "with the switch off no import DNS record is made"
  }
}

# Switch on: the 3306 route is added ALONGSIDE the SSH route. SSH is still
# first and unchanged, the 3306 rule is in the middle, the 404 is still last,
# and the policy admits only the service token.
run "import_on_adds_3306_alongside_ssh" {
  command = plan

  variables {
    enable_mysql_import   = true
    mysql_import_hostname = "mysql-import-a.skyphusion.org"
    mysql_import_zone_id  = "0000000000000000orgzone00000000000"
  }

  # The SSH route is untouched.
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared_config.src.config.ingress[0].hostname == "wp-ssh-src.skyphusion.net"
    error_message = "the SSH ingress hostname must be unchanged and first"
  }
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared_config.src.config.ingress[0].service == "ssh://localhost:22"
    error_message = "the SSH ingress service must be unchanged and first"
  }

  # The 3306 route is added in the middle, pointing at localhost:3306.
  assert {
    condition     = length(cloudflare_zero_trust_tunnel_cloudflared_config.src.config.ingress) == 3
    error_message = "with the switch on the ingress must be SSH, 3306, then the 404 catch-all"
  }
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared_config.src.config.ingress[1].service == "tcp://localhost:3306"
    error_message = "the 3306 ingress must reach tcp://localhost:3306"
  }
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared_config.src.config.ingress[1].hostname == "mysql-import-a.skyphusion.org"
    error_message = "the 3306 ingress must be on the import hostname"
  }
  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared_config.src.config.ingress[2].service == "http_status:404"
    error_message = "the 404 catch-all must still be last"
  }

  # The policy admits only the service token (no identity login).
  assert {
    condition     = cloudflare_zero_trust_access_policy.mysql_import_only[0].decision == "non_identity"
    error_message = "the import policy must be non_identity (service token only)"
  }
  assert {
    condition     = length(cloudflare_zero_trust_access_policy.mysql_import_only[0].include) == 1
    error_message = "the import policy must have exactly one include rule"
  }
  assert {
    condition     = one(cloudflare_zero_trust_access_policy.mysql_import_only[0].include).service_token != null
    error_message = "the import policy's only include rule must be a service token"
  }

  # The Access application is scoped to exactly the import hostname.
  assert {
    condition     = cloudflare_zero_trust_access_application.mysql_import[0].domain == "mysql-import-a.skyphusion.org"
    error_message = "the import Access application must be scoped to the import hostname"
  }

  # The import CNAME points at the same tunnel as the SSH route.
  assert {
    condition     = cloudflare_dns_record.mysql_import[0].type == "CNAME"
    error_message = "the import DNS record must be a CNAME to the tunnel"
  }
  assert {
    condition     = cloudflare_dns_record.mysql_import[0].proxied == true
    error_message = "the import DNS record must be proxied"
  }
}

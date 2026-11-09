# deploy/wfp, optional identity-gated WordPress admin (issue #246). A per-site,
# opt-in Cloudflare Access (Zero Trust) application that gates /wp-admin and
# wp-login.php behind operator identity, while leaving the paths the platform
# itself needs OPEN so checkout, cron, REST and front-end AJAX keep working.
#
# CR AUTHORITY: #246 is the approved change-request for this live change, so this
# IS its owed IaC PR. The repo rule "no live infra change without a CR issue plus
# the IaC PR that implements it" is satisfied by #246.
#
# NEW RESOURCES, NOT IMPORT-FIRST. Unlike saas-home.tf (which codified already
# hand-applied resources and therefore imports), nothing here exists on the
# account yet. A first `apply` CREATES these resources; there is nothing to
# import. The lead applies (deploy gate); this PR delivers the code, the expected
# plan and the stranger-vantage test only.
#
# OPT-IN. var.access_enabled defaults to false, so a plain `apply` of shared/
# creates ZERO Access resources and changes nothing. A site opts in by setting
# access_enabled = true plus tenant_hostname plus an identity source.
#
# ----------------------------------------------------------------------------
# WHY THE EXCEPTIONS ARE THE WHOLE RISK, AND HOW THIS FILE HANDLES THEM
# ----------------------------------------------------------------------------
# Cloudflare Access selects the application whose destination path is the MOST
# SPECIFIC match for the request, then evaluates that app's policy. Grounded in
# https://developers.cloudflare.com/cloudflare-one/policies/access/app-paths/ :
#   - "When multiple rules are set for a common root path, the more specific rule
#     takes precedence." So a Bypass app on a longer path overrides the protect
#     app on the shorter path. This is how we punch holes in the gate.
#   - "Using a wildcard in the Path field does not cover the parent path."
#     So /wp-admin/* matches /wp-admin/edit.php but NOT /wp-admin itself; we must
#     list BOTH wp-admin and wp-admin/* to cover the index and the sub-paths.
#   - "Query strings (such as ?foo=bar) are not supported in Access application
#     paths." So ?rest_route= CANNOT be expressed as an Access path, and does not
#     need to be: it rides on /index.php or /, which this gate never covers.
#
# The gate protects ONLY /wp-admin, /wp-admin/* and /wp-login.php. Everything
# below is enumerated so the exempt set is explicit and auditable.
#
# LOAD-BEARING EXEMPTIONS (collide with the gate; an ACTIVE bypass app is built):
#   wp-admin/admin-ajax.php   Front-end AJAX (WooCommerce add-to-cart, countless
#                             plugins) POSTs here. It lives UNDER /wp-admin/*, so
#                             without a more-specific bypass the gate would
#                             challenge it and break the storefront. THIS is the
#                             "checkout breaks" vector for a /wp-admin gate.
#   wp-admin/admin-post.php   Front-end form handler (Contact Form 7, payment
#                             return handlers, etc.) POSTs here, same class as
#                             admin-ajax.php and also UNDER /wp-admin/*.
#   (These two are var.admin_bypass_paths; edit that list to adjust the holes.)
#
# OPEN BY CONSTRUCTION (NOT under the gated prefix, so Access never sees them;
# no bypass app is needed and none is created. Listed so any future widening of
# the gate -- e.g. to the whole hostname -- re-adds each as an explicit bypass):
#   /wp-json/*                WordPress + app-client REST. Not under /wp-admin.
#   /index.php?rest_route=    REST alias via query string. Base path /index.php
#                             or / is not gated; query strings are not Access
#                             paths anyway (see note above).
#   /wp-cron.php              WP-Cron trigger (external cron or front-end spawn).
#                             Not under /wp-admin.
#   /wp-json/wc/v3/*          WooCommerce REST API (store management).
#   /wp-json/wc/store/*       WooCommerce Store API (headless cart/checkout).
#   /wc-api/* and /?wc-api=   Legacy Woo payment-gateway webhook/IPN callbacks
#                             (e.g. gateway return URLs). Not under /wp-admin;
#                             the /?wc-api= form is a query string, not a path.
# ----------------------------------------------------------------------------

# account_id is declared in main.tf (same module); this file reuses var.account_id.
# Access apps and reusable policies are account-scoped so one app matches the
# tenant custom hostname regardless of which zone it lives in.

variable "access_enabled" {
  type        = bool
  default     = false
  description = "Per-site opt-in. false (default) creates NO Access resources; a plain apply is a no-op. Set true (with tenant_hostname and an identity source) to gate this site's admin."
}

variable "tenant_hostname" {
  type        = string
  default     = ""
  description = "The tenant custom hostname whose /wp-admin is gated, e.g. shop.example.com. Access is account-scoped and matches on this hostname plus path. Required when access_enabled is true."
}

variable "operator_emails" {
  type        = list(string)
  default     = []
  description = "Operator email allowlist. Each becomes an Access include rule (OR semantics: any one match admits). Combine with operator_email_domain or leave empty to use the domain alone."
}

variable "operator_email_domain" {
  type        = string
  default     = ""
  description = "Optional operator email-domain allowlist (e.g. skyphusion.org). Admits any identity whose verified email is at this domain. Set this and/or operator_emails; at least one is required when access_enabled is true (enforced by a precondition below)."
}

variable "session_duration" {
  type        = string
  default     = "24h"
  description = "How long an Access session stays valid before re-authentication. Format like 24h or 2h45m."
}

variable "admin_bypass_paths" {
  type        = list(string)
  default     = ["wp-admin/admin-ajax.php", "wp-admin/admin-post.php"]
  description = "Paths UNDER the gated /wp-admin prefix that must stay open to unauthenticated front-end traffic. Each gets a more-specific Access application with a Bypass policy, which takes precedence over the protect app. These are the load-bearing exemptions; paths NOT under /wp-admin (REST, cron, Woo webhooks) need no entry here because the gate never covers them."
}

locals {
  # Operator allow-policy include rules. Email rules and an optional domain rule
  # are concatenated into one OR set (Access include = any-of). concat of the two
  # shapes yields a tuple that conforms to the policy's include attribute.
  email_rules  = [for e in var.operator_emails : { email = { email = e } }]
  domain_rules = var.operator_email_domain == "" ? [] : [{ email_domain = { domain = var.operator_email_domain } }]

  operator_include = concat(local.email_rules, local.domain_rules)
}

# Reusable allow policy: admits the operator identity. Account-scoped so it can be
# referenced by the protect app (and reused across sites if desired).
resource "cloudflare_zero_trust_access_policy" "operator_allow" {
  count            = var.access_enabled ? 1 : 0
  account_id       = var.account_id
  name             = "wp-admin operator allow (${var.tenant_hostname})"
  decision         = "allow"
  include          = local.operator_include
  session_duration = var.session_duration

  lifecycle {
    precondition {
      # An allow policy with no include rule admits nobody and locks the operator
      # out of their own admin. Fail the plan instead of shipping that.
      condition     = length(local.operator_include) > 0
      error_message = "Set operator_emails and/or operator_email_domain: an allow policy with no include rule would lock everyone out of wp-admin."
    }
  }
}

# Reusable bypass policy: matches everyone, so a request hitting an app that uses
# it is served straight to the origin with no Access challenge. One policy is
# shared by every admin_bypass_paths app.
resource "cloudflare_zero_trust_access_policy" "public_bypass" {
  count      = var.access_enabled ? 1 : 0
  account_id = var.account_id
  name       = "wp platform path bypass (${var.tenant_hostname})"
  decision   = "bypass"
  include    = [{ everyone = {} }]
}

# THE PROTECT APP. Gates /wp-admin (index), /wp-admin/* (every sub-path) and
# /wp-login.php behind the operator allow policy. Both wp-admin and wp-admin/*
# are listed because a wildcard does not cover its parent path (see header).
resource "cloudflare_zero_trust_access_application" "wp_admin" {
  count                = var.access_enabled ? 1 : 0
  account_id           = var.account_id
  name                 = "WordPress admin (${var.tenant_hostname})"
  type                 = "self_hosted"
  session_duration     = var.session_duration
  app_launcher_visible = false

  destinations = [
    { type = "public", uri = "${var.tenant_hostname}/wp-admin" },
    { type = "public", uri = "${var.tenant_hostname}/wp-admin/*" },
    { type = "public", uri = "${var.tenant_hostname}/wp-login.php" },
  ]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.operator_allow[0].id
    precedence = 1
  }]
}

# THE BYPASS APPS. One per admin_bypass_paths entry. Each matches a longer, more
# specific path than the protect app's wp-admin/*, so Access selects it first and
# its everyone-bypass policy lets the request through unauthenticated. This is
# what keeps the storefront (admin-ajax.php) and front-end forms (admin-post.php)
# working while /wp-admin stays gated.
resource "cloudflare_zero_trust_access_application" "admin_bypass" {
  for_each             = var.access_enabled ? toset(var.admin_bypass_paths) : toset([])
  account_id           = var.account_id
  name                 = "WordPress bypass /${each.value} (${var.tenant_hostname})"
  type                 = "self_hosted"
  session_duration     = var.session_duration
  app_launcher_visible = false

  destinations = [
    { type = "public", uri = "${var.tenant_hostname}/${each.value}" },
  ]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.public_bypass[0].id
    precedence = 1
  }]
}

output "wp_admin_access_app_id" {
  value       = var.access_enabled ? cloudflare_zero_trust_access_application.wp_admin[0].id : null
  description = "UUID of the protect application (null when access_enabled is false)."
}

output "wp_admin_access_app_aud" {
  value       = var.access_enabled ? cloudflare_zero_trust_access_application.wp_admin[0].aud : null
  description = "Audience (AUD) tag of the protect application, for JWT verification at the origin if ever needed."
}

output "wp_admin_bypass_app_ids" {
  value       = { for k, a in cloudflare_zero_trust_access_application.admin_bypass : k => a.id }
  description = "Map of bypassed path -> Access application UUID."
}

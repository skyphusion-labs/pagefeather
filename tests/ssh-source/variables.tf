variable "account_id" {
  description = "Cloudflare account id (the tunnel, the Access app and the service token)."
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone of the SSH hostname (CR #101)."
  type        = string
}

variable "hostname" {
  description = "The SSH hostname, in that zone (CR #101: wp-ssh-src.skyphusion.net)."
  type        = string
}

variable "ssh_public_key" {
  description = "Public key of the operator for the user importer (one OpenSSH line)."
  type        = string
}

variable "region" {
  description = "Vultr region."
  type        = string
  default     = "ord"
}

variable "plan" {
  description = "Vultr plan. vc2-1c-1gb: 1 vCPU, 1 GB, billed by the hour."
  type        = string
  default     = "vc2-1c-1gb"
}

# ---- The live variant-a MariaDB import route (CR #141) -----------------------
# Off by default: with enable_mysql_import = false the box is the SSH source of
# #83 and nothing below is made, so the SSH route is exactly as it was. Set it
# true to add, ALONGSIDE the SSH route, a TCP 3306 route on its own hostname,
# behind its own Access service token, for the #31 live round trip.

variable "enable_mysql_import" {
  description = "Add the CR #141 TCP 3306 import route (hostname, tunnel ingress, Access app, policy and service token) alongside the SSH route. The SSH route is untouched either way."
  type        = bool
  default     = false
}

variable "mysql_import_hostname" {
  description = "The 3306 import hostname (CR #141: mysql-import-a.skyphusion.org). Used only when enable_mysql_import is true."
  type        = string
  default     = "mysql-import-a.skyphusion.org"
}

variable "mysql_import_zone_id" {
  description = "Cloudflare zone of mysql_import_hostname (skyphusion.org: 3b58b52bd324332fb56b3ab685588c76). Used only when enable_mysql_import is true."
  type        = string
  default     = "3b58b52bd324332fb56b3ab685588c76"
}

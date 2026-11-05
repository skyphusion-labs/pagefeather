variable "free_hyperdrive_token" {
  description = "Free test account token with Hyperdrive Read and Write (file /Users/conrad/.cf-testing-hyperdrive.token)"
  type        = string
  sensitive   = true
}

variable "free_admin_token" {
  description = "Free test account general token (file /Users/conrad/.cf-testing.token)"
  type        = string
  sensitive   = true
}

variable "region" {
  description = "Vultr region. Chicago: approach B's D1 primary measured near Chicago (docs/approach-b.md 8g)."
  type        = string
  default     = "ord"
}

variable "plan" {
  description = "Vultr plan: 1 vCPU, 2 GB, $10 a month, billed by the hour."
  type        = string
  default     = "vc2-1c-2gb"
}

variable "public_mysql" {
  description = <<-EOT
    Also open MariaDB to the internet (port 3306, SSL required for the remote user),
    for HostlessWP's documented path: Hyperdrive to a public MySQL over SSL. Conrad,
    2026-11-05: "test the public sql with ssl path ... i want to give this an honest
    look". This box only; it departs from the tunnel-only estate standard on purpose
    and goes away with terraform destroy.
  EOT
  type        = bool
  default     = true
}

variable "public_mysql_sources" {
  description = "Who may reach port 3306 when public_mysql is on. Cloudflare IPv4 ranges, read from https://www.cloudflare.com/ips-v4 on 2026-11-05."
  type        = list(string)
  default = [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
    "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
    "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  ]
}

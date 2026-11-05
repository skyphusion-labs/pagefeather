variable "name" {
  description = "Site name. The box is named <name>-mysql."
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone that gets the database host name (Hyperdrive needs a name: by IP address it measured 6 times slower per query)."
  type        = string
}

variable "hostname" {
  description = "Database host name in that zone, for example mysql-mysite.example.com."
  type        = string
}

variable "region" {
  description = "Vultr region. Put it near the Worker's placement region (ord is Chicago)."
  type        = string
  default     = "ord"
}

variable "plan" {
  description = "Vultr plan. vc2-1c-2gb: 1 vCPU, 2 GB, $10 a month, billed by the hour."
  type        = string
  default     = "vc2-1c-2gb"
}

variable "sources" {
  description = "Who may reach port 3306: Cloudflare's IPv4 ranges (https://www.cloudflare.com/ips-v4, read 2026-11-05). Hyperdrive connects from them (measured 2026-11-05)."
  type        = list(string)
  default = [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
    "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
    "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  ]
}

variable "account_id" {
  description = "Cloudflare account id."
  type        = string
}

variable "name" {
  description = "Site name. The Worker, the D1 database and the bucket are named from it."
  type        = string
}

variable "variant" {
  description = <<-EOT
    What runs where:
      b-do  WordPress in PHP (WebAssembly) in a Durable Object, database on D1.
            Runs on Workers Free: the Worker stays under the 10 ms CPU limit and
            the object has the CPU for PHP.
      a     WordPress in PHP in the Worker, database on MySQL outside Cloudflare
            through Hyperdrive (docs/approach-a.md). Workers Paid: on Free the
            Worker stops at the CPU limit. Give mysql_* (deploy/mysql makes a
            box, or use your own MySQL with SSL).
      c1    WordPress and WooCommerce in one Cloudflare Container, SQLite on the
            container disk, Litestream to an R2 bucket. Workers Paid only
            (Containers). See c1.tf and docs/approach-c1.md.
  EOT
  type        = string
  default     = "b-do"
  validation {
    condition     = contains(["b-do", "a", "c1"], var.variant)
    error_message = "Supported variants: b-do, a, c1."
  }
}

variable "location" {
  description = <<-EOT
    Location hint for the D1 primary AND the PHP object. The same hint puts them
    in the same region: 14 to 20 ms per statement measured, against 38 to 60 ms
    when they differ (tests/do/probe, 2026-11-05). One of: enam, wnam, weur,
    eeur, apac, oc.
  EOT
  type        = string
  default     = "enam"
}

variable "media" {
  description = "Make an R2 bucket for the media library. R2 must be turned on for the account first."
  type        = bool
  default     = false
}

# Variant "a" only: the MySQL server. Give the host NAME, not the IP address:
# Hyperdrive by IP measured about 44 ms per query, by name about 7 ms
# (2026-11-05, same Worker, same database).
variable "mysql_host" {
  type    = string
  default = ""
}

variable "mysql_port" {
  type    = number
  default = 3306
}

variable "mysql_database" {
  type    = string
  default = "wordpress"
}

variable "mysql_user" {
  type    = string
  default = "wp"
}

variable "mysql_password" {
  type      = string
  default   = ""
  sensitive = true
}

variable "teardown" {
  description = "destroy.sh only (c1): give the Litestream key the media bucket too, so destroy.sh can empty both buckets before Terraform deletes them."
  type        = bool
  default     = false
}

variable "account_id" {
  description = "Cloudflare account id (the tunnel, the Access app and the service token)."
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone of the hostname (CR #101)."
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

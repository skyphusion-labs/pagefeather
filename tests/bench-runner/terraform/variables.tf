variable "account_id" {
  description = "Cloudflare account that holds the job bucket (Skyphusion Labs, Workers Paid)."
  type        = string
  default     = "fabcb25d9c7eb087110ec474a03e50d2"
}

variable "region" {
  description = "Vultr region of the runner. ord is Chicago."
  type        = string
  default     = "ord"
}

variable "plan" {
  description = "Vultr plan. vc2-2c-4gb: 2 vCPU, 4 GB, $20 a month, billed by the hour. At 1 vCPU the load test client was the limit at 50 users (load 1.23 on 1 CPU, 2026-11-05)."
  type        = string
  default     = "vc2-2c-4gb"
}

variable "repo" {
  description = "Git repository the runner clones (bench.py, e2e.sh, summarize.py)."
  type        = string
  default     = "https://github.com/skyphusion-labs/wordpress-on-cloudflare"
}

variable "branch" {
  description = "Branch the runner pulls before each job, unless the job names one."
  type        = string
  default     = "do28-deploy"
  validation {
    condition     = can(regex("^[A-Za-z0-9._/-]+$", var.branch))
    error_message = "A branch name has letters, digits, dot, slash, underscore and dash only."
  }
}

variable "bucket" {
  description = "R2 bucket for jobs/ and results/."
  type        = string
  default     = "bench-runner"
}

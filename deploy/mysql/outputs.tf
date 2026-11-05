output "host" { value = var.hostname }
output "port" { value = 3306 }
output "database" { value = "wordpress" }
output "user" { value = "wp" }
output "ip" { value = vultr_instance.mysql.main_ip }

output "password" {
  value     = random_password.db.result
  sensitive = true
}

#!/bin/bash
# Write the local env files the test scripts read, from terraform outputs
# (mode 600, never printed):
#   /Users/conrad/.wp-a-mysql.env       HOST DB_NAME DB_USER DB_PASSWORD ACCESS_CLIENT_ID ACCESS_CLIENT_SECRET
#   /Users/conrad/.hostlesswp-s3.env    HOSTLESSWP_S3_ACCESS_KEY_ID HOSTLESSWP_S3_SECRET_ACCESS_KEY
#   /Users/conrad/.hostlesswp-paid.token, /Users/conrad/.hostlesswp-free.token
set -euo pipefail
cd "$(dirname "$0")"
umask 077
./tf.sh output -json | python3 -c '
import json, sys
o = {k: v["value"] for k, v in json.load(sys.stdin).items()}
open("/Users/conrad/.wp-a-mysql.env", "w").write(
    "HOST=%s\nDB_NAME=wordpress\nDB_USER=wp\nDB_PASSWORD=%s\nACCESS_CLIENT_ID=%s\nACCESS_CLIENT_SECRET=%s\n"
    % (o["host"], o["db_password"], o["access_client_id"], o["access_client_secret"]))
open("/Users/conrad/.hostlesswp-s3.env", "w").write(
    "HOSTLESSWP_S3_ACCESS_KEY_ID=%s\nHOSTLESSWP_S3_SECRET_ACCESS_KEY=%s\n" % (o["hwp_s3_access_key_id"], o["hwp_s3_secret_access_key"]))
open("/Users/conrad/.hostlesswp-paid.token", "w").write(o["hwp_deploy_token_paid"])
open("/Users/conrad/.hostlesswp-free.token", "w").write(o["hwp_deploy_token_free"])
print("env files written")'

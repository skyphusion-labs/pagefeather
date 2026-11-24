#!/bin/bash
# Write the local env files the test scripts read, from terraform outputs
# (mode 600, never printed). Defaults under $HOME. Override with ENV_DIR
# (directory that holds the files) when they live elsewhere.
#   $ENV_DIR/.wp-a-mysql.env       HOST DB_NAME DB_USER DB_PASSWORD ACCESS_CLIENT_ID ACCESS_CLIENT_SECRET
#   $ENV_DIR/.hostlesswp-s3.env    HOSTLESSWP_S3_ACCESS_KEY_ID HOSTLESSWP_S3_SECRET_ACCESS_KEY
#   $ENV_DIR/.hostlesswp-paid.token, $ENV_DIR/.hostlesswp-free.token
set -euo pipefail
cd "$(dirname "$0")"
ENV_DIR="${ENV_DIR:-$HOME}"
umask 077
./tf.sh output -json | ENV_DIR="$ENV_DIR" python3 -c '
import json, os, sys
d = os.environ["ENV_DIR"]
o = {k: v["value"] for k, v in json.load(sys.stdin).items()}
open(os.path.join(d, ".wp-a-mysql.env"), "w").write(
    "HOST=%s\nDB_NAME=wordpress\nDB_USER=wp\nDB_PASSWORD=%s\nACCESS_CLIENT_ID=%s\nACCESS_CLIENT_SECRET=%s\n"
    % (o["host"], o["db_password"], o["access_client_id"], o["access_client_secret"]))
open(os.path.join(d, ".hostlesswp-s3.env"), "w").write(
    "HOSTLESSWP_S3_ACCESS_KEY_ID=%s\nHOSTLESSWP_S3_SECRET_ACCESS_KEY=%s\n" % (o["hwp_s3_access_key_id"], o["hwp_s3_secret_access_key"]))
open(os.path.join(d, ".hostlesswp-paid.token"), "w").write(o["hwp_deploy_token_paid"])
open(os.path.join(d, ".hostlesswp-free.token"), "w").write(o["hwp_deploy_token_free"])
print("env files written under", d)'

# Import seed (issue #31, deploy/import.sh). Sourced by entrypoint.sh after
# the Litestream restore. POSIX sh.
#
# With SEED_SHA256 and no database yet (no replica at REPLICA_PATH), the
# database is the object <REPLICA_PATH>.seed.sqlite in the replica bucket,
# made from an existing site's dump. Litestream then replicates it, so a later
# start restores it like any other database. The file must have that SHA-256.
# If the download or the check fails, the start stops (exit 1): the container
# never installs an empty site over an import.
#
# SEED_DATA (default /data), SEED_RUN (default /run), SEED_COUNTS (default
# /opt/wp/seed-counts.php) and SEED_OUT (default /tmp/c1-seed.json, which
# stats.php reads) exist for deploy/import/tests/run.sh.
seed_load() {
	data=${SEED_DATA:-/data}
	[ ! -f "$data/wordpress.sqlite" ] || return 0
	[ -n "${SEED_SHA256:-}" ] || return 0
	echo "no replica at $REPLICA_PATH: loading the seed"
	conf=${SEED_RUN:-/run}/seed.curl
	old=$(umask); umask 077
	printf 'user = "%s:%s"\n' "$LITESTREAM_ACCESS_KEY_ID" "$LITESTREAM_SECRET_ACCESS_KEY" > "$conf"
	umask "$old"
	if ! curl -sSf --retry 3 -K "$conf" --aws-sigv4 "aws:amz:auto:s3" -o "$data/seed.part" "$R2_ENDPOINT/$R2_BUCKET/$REPLICA_PATH.seed.sqlite"; then
		rm -f "$conf" "$data/seed.part"
		echo "seed: download failed: stopping" >&2
		exit 1
	fi
	rm -f "$conf"
	if [ "$(sha256sum "$data/seed.part" | cut -d' ' -f1)" != "$SEED_SHA256" ]; then
		rm -f "$data/seed.part"
		echo "seed: SHA-256 does not match SEED_SHA256: stopping" >&2
		exit 1
	fi
	mv "$data/seed.part" "$data/wordpress.sqlite"
	# The rows of each table as loaded, before PHP runs: deploy/import.sh
	# compares them with the seed it sent (stats.php what=seed).
	php "${SEED_COUNTS:-/opt/wp/seed-counts.php}" "$data/wordpress.sqlite" "$SEED_SHA256" "$REPLICA_PATH" > "${SEED_OUT:-/tmp/c1-seed.json}"
	echo "seed: loaded ($(wc -c < "$data/wordpress.sqlite") bytes)"
}

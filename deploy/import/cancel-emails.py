#!/usr/bin/env python3
"""Cancel the source site's pending order emails in an import (issue #364).

WooCommerce defers its order emails to Action Scheduler: one action per email, hook
woocommerce_send_queued_transactional_email, group woocommerce-emails. An import carries the
source site's PENDING ones. They belong to the source site, so the new site would send them late,
or a second time if the source already sent them. The sample store carries 900.

  cancel-emails.py <site.sqlite> [--keep] [--dry-run]

Sets status = 'canceled' on every pending action in the woocommerce-emails group, and writes one
Action Scheduler log row for each, so the admin's Scheduled Actions screen says why. Nothing is
deleted, so the row counts that import.sh checks after the load do not change. --keep
(IMPORT_KEEP_PENDING_EMAILS=1) and --dry-run change nothing. The last line of output is the
count: "pending emails: <n> canceled", "... kept", or "... would be canceled". A database without
the Action Scheduler tables or the group has none, and says so.
"""
import sqlite3
import sys
import time

GROUP = "woocommerce-emails"
MESSAGE = "action canceled by the site import: a pending email of the source site (issue #364)"


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    flags = {a for a in argv[1:] if a.startswith("--")}
    unknown = flags - {"--keep", "--dry-run"}
    if len(args) != 1 or unknown:
        print("usage: cancel-emails.py <site.sqlite> [--keep] [--dry-run]", file=sys.stderr)
        return 2
    db = sqlite3.connect(args[0])
    try:
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        if not {"wp_actionscheduler_actions", "wp_actionscheduler_groups"} <= tables:
            print("pending emails: 0 (no Action Scheduler tables)")
            return 0
        where = (
            "status = 'pending' AND group_id IN "
            "(SELECT group_id FROM wp_actionscheduler_groups WHERE slug = ?)"
        )
        ids = [r[0] for r in db.execute("SELECT action_id FROM wp_actionscheduler_actions WHERE " + where + " ORDER BY action_id", (GROUP,))]
        n = len(ids)
        if "--keep" in flags:
            print("pending emails: %d kept (IMPORT_KEEP_PENDING_EMAILS=1)" % n)
            return 0
        if "--dry-run" in flags:
            print("pending emails: %d would be canceled" % n)
            return 0
        with db:
            db.execute("UPDATE wp_actionscheduler_actions SET status = 'canceled' WHERE " + where, (GROUP,))
            if "wp_actionscheduler_logs" in tables and ids:
                now = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
                db.executemany(
                    "INSERT INTO wp_actionscheduler_logs (action_id, message, log_date_gmt, log_date_local) VALUES (?, ?, ?, ?)",
                    [(i, MESSAGE, now, now) for i in ids],
                )
        left = db.execute("SELECT COUNT(*) FROM wp_actionscheduler_actions WHERE " + where, (GROUP,)).fetchone()[0]
        if left:
            print("pending emails: %d still pending after the cancel" % left, file=sys.stderr)
            return 1
        print("pending emails: %d canceled" % n)
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main(sys.argv))

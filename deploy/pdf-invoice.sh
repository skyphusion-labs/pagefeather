# shellcheck shell=bash
# PDF_INVOICE (#765): PDF order invoices (spikes/b2-wordpress/php/pdf-invoice.php, #227) on deploy/deploy.sh, as on
# one-click (the pdf-invoices descriptor) and deploy/wfp (lib.sh render_user). "on" binds Browser Rendering
# (BROWSER) and gives the site its own download-signing secret INVOICE_TOKEN, from the Terraform workspace: without
# it the PDF is stored but no link is made (index.js). b-dosql only: index.js pdfInvoiceEnabled() needs the PHP and
# database objects. Off or unset renders nothing, so every other site stays byte-identical. Browser Rendering is
# metered: opt-in. Test: deploy/tests/pdf-invoice-wiring-test.sh.

# pdf_invoice_check <variant>: exit 2 and the reason on stderr when refused; 0 when allowed or unset.
pdf_invoice_check() {
  case "${PDF_INVOICE:-}" in
    ""|off) return 0 ;;
    on) [ "${1:-}" = b-dosql ] || { echo "PDF_INVOICE is for variant b-dosql (the invoice render needs the PHP and database objects), not ${1:-unset}" >&2; return 2; } ;;
    *) echo "PDF_INVOICE must be on, off or unset, not ${PDF_INVOICE}" >&2; return 2 ;;
  esac
}

# pdf_invoice_binding: the [browser] table when on, nothing otherwise. Call pdf_invoice_check first.
pdf_invoice_binding() {
  [ "${PDF_INVOICE:-}" != on ] || { echo '[browser]'; echo 'binding = "BROWSER"'; }
}

# deploy_secrets_json <out file>: deploy.sh's `wrangler secret bulk` JSON from `terraform output -json` on stdin:
# WP_SALT and SPIKE_TOKEN, plus INVOICE_TOKEN when PDF_INVOICE=on (refused if the workspace has none: a PDF with
# no link is not a working invoice). Values go from stdin to the mode-600 file only, never to argv or stdout.
deploy_secrets_json() {
  python3 -I -c 'import json, os, sys
o = {k: v["value"] for k, v in json.load(sys.stdin).items()}
s = {"WP_SALT": o["wp_salt"], "SPIKE_TOKEN": o["spike_token"]}
if os.environ.get("PDF_INVOICE") == "on":
    if not o.get("invoice_token"):
        sys.stderr.write("PDF_INVOICE=on but the Terraform workspace has no invoice_token output (apply it first)\n")
        sys.exit(2)
    s["INVOICE_TOKEN"] = o["invoice_token"]
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(s, f)' "$1"
}

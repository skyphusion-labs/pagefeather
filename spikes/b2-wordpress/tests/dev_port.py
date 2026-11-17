"""The port run.sh bound (#839). Same rule as server_port in ../port.sh.

PORT if set, else the .dev-port run.sh wrote beside port.sh, else exit 1.
There is no default port. base_url() keeps an explicit B, and otherwise
builds http://localhost:<that port>.
"""
import os
import sys

_SPIKE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def server_port():
    port = os.environ.get("PORT")
    if port:
        return port
    path = os.path.join(_SPIKE, ".dev-port")
    if not os.path.isfile(path):
        sys.stderr.write(
            "no PORT and no .dev-port in %s: run.sh did not record the port it bound\n"
            % _SPIKE
        )
        sys.exit(1)
    with open(path, "r") as fh:
        raw = fh.read()
    p = "".join(raw.split())
    if (not p.isdigit()) or len(p) > 5:
        sys.stderr.write("no PORT and .dev-port in %s is not a port\n" % _SPIKE)
        sys.exit(1)
    n = int(p)
    if n < 1 or n > 65535:
        sys.stderr.write("no PORT and .dev-port in %s is not a port\n" % _SPIKE)
        sys.exit(1)
    return str(n)


def base_url():
    b = os.environ.get("B", "").strip()
    if b:
        return b.rstrip("/")
    return "http://localhost:%s" % server_port()

"""An unknown key in a recorded settings record (#1285).

deploy.sh and deploy/wfp both call guard. An unknown key stops the deploy
and names the key. The caller must not write the record again without that
key. REPLACE_INPUTS=1 drops those keys and names each one. A known key is
left for the caller, which keeps it as before.
"""
import sys


def guard(recorded_keys, known_keys, replace, out=None):
    """Name every recorded key this build does not know.

    Return (code, names). names is sorted.
    code 0 and names empty: every key is known.
    code 0 and names not empty: replace is true. out names each dropped key.
    The caller may write a new record that omits those keys.
    code 2: replace is false. out names each key. The caller must not write
    the record.

    out is the stream for the lines. It defaults to stderr.
    """
    if out is None:
        out = sys.stderr
    known = set(known_keys)
    names = sorted(set(k for k in recorded_keys if k not in known))
    if not names:
        return 0, []
    if replace:
        for key in names:
            print("REPLACE_INPUTS=1: dropped unknown setting %s" % key, file=out)
        return 0, names
    for key in names:
        print("refused: the record has %s, which is not a known setting" % key, file=out)
    print("Nothing was changed. REPLACE_INPUTS=1 drops unknown settings on purpose.", file=out)
    return 2, names

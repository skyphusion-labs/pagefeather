"""#1205: the stylesheets plugin and theme blocks name in block.json, which the PHP tree must keep.

Core registers a non-core block's style, editorStyle and viewStyle ("file:./x.css") with realpath() of that file on the
PHP side (register_block_style_handle, wp-includes/blocks.php). If the file is not in the PHP tree, the handle gets an
EMPTY src: no link and no inline copy. prune-php-tree.sh keeps every path this prints (one per line, "./" relative to
the WordPress root), and each file's -rtl sibling (core loads it on an RTL site). A block.json that is not JSON is
skipped; a path that leaves wp-content is ignored.

    python3 -I block-css-keep.py                              (run from the WordPress root): the paths to keep
    python3 -I block-css-keep.py --check <php tree> <public>  the build guard: rc 1 and the names if any is missing
"""
import glob
import json
import os

FIELDS = ('style', 'editorStyle', 'viewStyle')


def keep_paths(root='.'):
    keep = set()
    pattern_roots = (os.path.join(root, 'wp-content', 'plugins'), os.path.join(root, 'wp-content', 'themes'))
    for base in pattern_roots:
        for bj in glob.glob(os.path.join(base, '**', 'block.json'), recursive=True):
            try:
                with open(bj, encoding='utf-8') as f:
                    data = json.load(f)
            except (OSError, ValueError):
                continue
            if not isinstance(data, dict):
                continue
            for field in FIELDS:
                value = data.get(field)
                for ref in value if isinstance(value, list) else [value]:
                    if not (isinstance(ref, str) and ref.startswith('file:') and ref.endswith('.css')):
                        continue
                    rel = os.path.normpath(os.path.relpath(os.path.join(os.path.dirname(bj), ref[5:]), root))
                    if not rel.startswith('wp-content' + os.sep):
                        continue
                    keep.add('./' + rel)
                    keep.add('./' + rel[:-4] + '-rtl.css')
    return sorted(keep)


import re
import sys

READ = re.compile(r'\b(file_get_contents|readfile|fopen|file)\s*\(')
BASE = re.compile(r'^\s*(?:\(string\)\s*)?(__DIR__|dirname\s*\(\s*__FILE__\s*\))')
PART = re.compile(r'^\s*\.\s*(?:\'([^\'\\]*)\'|"([^"\\$]*)"|(?:self|static)::([A-Za-z_][A-Za-z0-9_]*))')
CONST = re.compile(r'\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\'([^\'\\]*)\'\s*;')


def _resolve(expr, consts):
    """The path a read expression names, when it is __DIR__ or dirname(__FILE__) followed only by literals and class
    constants; else None."""
    m = BASE.match(expr)
    if not m:
        return None
    rest, out = expr[m.end():], ''
    while True:
        m = PART.match(rest)
        if not m:
            break
        lit = m.group(1) if m.group(1) is not None else m.group(2)
        if lit is None:
            lit = consts.get(m.group(3))
            if lit is None:
                return None
        out += lit
        rest = rest[m.end():]
    nxt = rest.lstrip()
    if not out or (nxt and nxt[0] not in ',)'):
        return None
    return out


def plugin_css_reads(root='.'):
    """#1208: stylesheets plugin PHP reads from disk (file_get_contents( __DIR__ . '/x.css' ) and the like; WooCommerce
    11.2.1's email editor reads content.css and content-shared.css when it renders an email). Returns the "./" paths a
    read names statically, and notes (file:line) for the reads the build cannot resolve."""
    keep, notes = set(), []
    base = os.path.join(root, 'wp-content', 'plugins')
    for dirpath, _, files in os.walk(base):
        for f in files:
            if not f.endswith('.php'):
                continue
            path = os.path.join(dirpath, f)
            try:
                with open(path, encoding='utf-8', errors='replace') as fh:
                    text = fh.read()
            except OSError:
                continue
            if '.css' not in text:
                continue
            consts = dict(CONST.findall(text))
            for no, line in enumerate(text.splitlines(), 1):
                # A class constant may carry the .css name (WooCommerce: self::CONTENT_STYLES_FILE): the resolver decides.
                if not READ.search(line) or ('.css' not in line and '::' not in line):
                    continue
                for m in READ.finditer(line):
                    expr = line[m.end():]
                    target = _resolve(expr, consts)
                    rel = os.path.relpath(path, root)
                    if target is None:
                        if re.search(r'\.css\b', expr.split(';')[0]) and '.min.css' not in expr.split(';')[0]:
                            notes.append(rel + ':' + str(no))
                        continue
                    if not target.endswith('.css') or target.endswith('.min.css'):
                        continue
                    p = os.path.normpath(os.path.relpath(os.path.join(dirpath, target.lstrip('/')), root))
                    if p.startswith('wp-content' + os.sep):
                        keep.add('./' + p)
    return sorted(keep), notes


def theme_css(public_root):
    """#1208: every .css under a theme in the static copy ("./"-relative): PHP reads theme stylesheets from disk
    (style.css's header; add_editor_style files, inlined into the editor by get_block_editor_theme_styles)."""
    out = []
    base = os.path.join(public_root, 'wp-content', 'themes')
    for root, _, files in os.walk(base):
        for f in files:
            if f.endswith('.css'):
                out.append('./' + os.path.relpath(os.path.join(root, f), public_root))
    return sorted(out)


def check(wp_root, public_root):
    """The #1205 and #1208 guard: the stylesheets PHP reads from disk (the PHP tree's block.json "file:" styles and
    every theme stylesheet) that the static copy ships but the PHP tree lacks. A block.json file missing from both is
    the plugin's own defect."""
    missing = []
    for p in sorted(set(keep_paths(wp_root)) | set(theme_css(public_root)) | set(plugin_css_reads(wp_root)[0])):
        rel = p[2:]
        if os.path.isfile(os.path.join(public_root, rel)) and not os.path.isfile(os.path.join(wp_root, rel)):
            missing.append(rel)
    return missing


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--check':
        gone = check(sys.argv[2], sys.argv[3])
        reads = set(plugin_css_reads(sys.argv[2])[0])
        for rel in gone:
            if rel.startswith('wp-content/themes/'):
                why = 'a theme stylesheet, which PHP reads from disk (style.css, add_editor_style): its editor styles would be dropped (#1208)'
            elif './' + rel in reads:
                why = 'plugin PHP reads it from disk (file_get_contents and the like): the read would come back empty (#1208)'
            else:
                why = 'named in a block.json: core would register its style with an empty src (#1205)'
            print('block-css-keep: ' + rel + ' is shipped in the static copy but missing from the PHP tree: ' + why, file=sys.stderr)
        sys.exit(1 if gone else 0)
    reads, notes = plugin_css_reads()
    for n in notes:
        print('block-css-keep: note: ' + n + ' reads a .css file by a path the build cannot resolve; if PHP needs that '
              'file it is missing from the PHP tree (#1208, docs/support-matrix.md)', file=sys.stderr)
    print('\n'.join(sorted(set(keep_paths()) | set(reads))))

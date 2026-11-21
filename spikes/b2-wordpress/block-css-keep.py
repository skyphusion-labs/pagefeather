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

# #1208: the calls that read a file from disk. #1221: and the calls that PROBE one (file_exists and the like): WooCommerce
# 11.2.1 shows "development version, files must be built" on every admin page when file_exists( WC()->plugin_path() .
# '/assets/css/admin.css' ) is false (class-woocommerce.php:1392). copy and getimagesize read too (the placeholder image).
READ = re.compile(r'\b(file_get_contents|readfile|fopen|file|file_exists|is_file|is_readable|filesize|filemtime|realpath|md5_file|sha1_file|stat|copy|getimagesize)\s*\(')
BASE = re.compile(r'^\s*(?:\(string\)\s*)?(__DIR__|dirname\s*\(\s*__FILE__\s*\))')
PART = re.compile(r'^\s*\.\s*(?:\'([^\'\\]*)\'|"([^"\\$]*)"|(?:self|static)::([A-Za-z_][A-Za-z0-9_]*))')
CONST = re.compile(r'\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\'([^\'\\]*)\'\s*;')
# #1221: what prune-php-tree.sh removes from the PHP tree (a .min.css is never removed).
PRUNED = re.compile(r'\.(?:css|js|map|png|jpe?g|gif|svg|webp|woff2?|ttf|eot|mo|po|zip|txt|scss|md)$')
LIT = re.compile(r'\'([^\'\\$]*)\'|"([^"\\$]*)"')


def _pruned(path, kind):
    """True when prune-php-tree.sh removes such a file from the PHP tree: a plugin keeps its .js and .svg, a theme keeps
    every .css, and a .min.css always stays."""
    if not PRUNED.search(path) or path.endswith('.min.css'):
        return False
    if kind == 'plugins' and (path.endswith('.js') or path.endswith('.svg')):
        return False
    if kind == 'themes' and path.endswith('.css'):
        return False
    return True


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


def _first_arg(expr):
    """The call's first argument, up to its comma or closing parenthesis at depth 0 (strings skipped)."""
    depth, out, q = 0, [], None
    for ch in expr:
        if q:
            out.append(ch)
            if ch == q:
                q = None
            continue
        if ch in '\'"':
            q = ch
        elif ch == '(':
            depth += 1
        elif ch == ')':
            if depth == 0:
                break
            depth -= 1
        elif ch == ',' and depth == 0:
            break
        out.append(ch)
    return ''.join(out)


class _Files:
    """#1221: the files under one plugin or theme directory, for a suffix match (listed once, from files_root)."""
    def __init__(self, files_root):
        self.root, self.cache = files_root, {}

    def under(self, top):
        if top not in self.cache:
            found = []
            for d, _, fs in os.walk(os.path.join(self.root, top)):
                for f in fs:
                    found.append(os.path.relpath(os.path.join(d, f), self.root).replace(os.sep, '/'))
            self.cache[top] = found
        return self.cache[top]


def plugin_css_reads(root='.', files_root=None):
    """#1208: the files plugin and theme PHP reads from disk; #1221: or probes (file_exists, is_readable and the like),
    of any type the prune removes. A path from __DIR__ or dirname(__FILE__) and literals resolves exactly. A path whose
    base the build cannot follow (WC()->plugin_path() . '/assets/css/admin.css') is matched by its literal suffix
    against the files of the same plugin or theme in files_root (the full tree; default root), and every match is kept,
    which errs toward keeping. Returns the "./" paths, and notes (file:line) for the rest."""
    files = _Files(files_root or root)
    keep, notes = set(), []
    for kind in ('plugins', 'themes'):
        base = os.path.join(root, 'wp-content', kind)
        for dirpath, _, fs in os.walk(base):
            for f in fs:
                if not f.endswith('.php'):
                    continue
                path = os.path.join(dirpath, f)
                try:
                    with open(path, encoding='utf-8', errors='replace') as fh:
                        text = fh.read()
                except OSError:
                    continue
                if not READ.search(text):
                    continue
                rel = os.path.relpath(path, root)
                top = '/'.join(rel.replace(os.sep, '/').split('/')[:3])  # wp-content/<kind>/<slug>
                consts = dict(CONST.findall(text))
                for no, line in enumerate(text.splitlines(), 1):
                    if not READ.search(line):
                        continue
                    for m in READ.finditer(line):
                        arg = _first_arg(line[m.end():])
                        target = _resolve(arg, consts)
                        if target is not None:
                            if _pruned(target, kind):
                                p = os.path.normpath(os.path.relpath(os.path.join(dirpath, target.lstrip('/')), root))
                                if p.startswith('wp-content' + os.sep):
                                    keep.add('./' + p.replace(os.sep, '/'))
                            continue
                        lits = [a if a else b for a, b in LIT.findall(arg)]
                        tail = lits[-1] if lits else ''
                        if not _pruned(tail, kind):
                            continue
                        want = '/' + tail.lstrip('/')
                        # Only a literal with a directory names WHERE the file is (/assets/css/admin.css); a bare name
                        # ('dynamic.css' after a variable) would be a guess, so it is noted instead (#1208).
                        hits = [h for h in files.under(top) if ('/' + h).endswith(want)] if '/' in tail.strip('/') else []
                        if hits:
                            keep.update('./' + h for h in hits)
                        else:
                            notes.append(rel + ':' + str(no))
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
    for p in sorted(set(keep_paths(wp_root)) | set(theme_css(public_root)) | set(plugin_css_reads(wp_root, public_root)[0])):
        rel = p[2:]
        if os.path.isfile(os.path.join(public_root, rel)) and not os.path.isfile(os.path.join(wp_root, rel)):
            missing.append(rel)
    return missing


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--check':
        gone = check(sys.argv[2], sys.argv[3])
        reads = set(plugin_css_reads(sys.argv[2], sys.argv[3])[0])
        for rel in gone:
            if rel.startswith('wp-content/themes/') and rel.endswith('.css'):
                why = 'a theme stylesheet, which PHP reads from disk (style.css, add_editor_style): its editor styles would be dropped (#1208)'
            elif './' + rel in reads:
                why = 'plugin or theme PHP reads or probes it from disk (file_get_contents, file_exists and the like): the read would come back empty, or the probe false (#1208, #1221)'
            else:
                why = 'named in a block.json: core would register its style with an empty src (#1205)'
            print('block-css-keep: ' + rel + ' is shipped in the static copy but missing from the PHP tree: ' + why, file=sys.stderr)
        sys.exit(1 if gone else 0)
    reads, notes = plugin_css_reads()
    for n in notes:
        print('block-css-keep: note: ' + n + ' reads or probes a file the prune removes, by a path the build cannot '
              'resolve; if PHP needs that file it is missing from the PHP tree (#1208, #1221, docs/support-matrix.md)', file=sys.stderr)
    print('\n'.join(sorted(set(keep_paths()) | set(reads))))

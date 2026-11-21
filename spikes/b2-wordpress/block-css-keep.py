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


def check(wp_root, public_root):
    """The #1205 guard: the stylesheets the PHP tree's block.json files name that the static copy ships but the PHP
    tree lacks (core would register them with an empty src). A file missing from both is the plugin's own defect."""
    missing = []
    for p in keep_paths(wp_root):
        rel = p[2:]
        if os.path.isfile(os.path.join(public_root, rel)) and not os.path.isfile(os.path.join(wp_root, rel)):
            missing.append(rel)
    return missing


if __name__ == '__main__':
    import sys
    if len(sys.argv) == 4 and sys.argv[1] == '--check':
        gone = check(sys.argv[2], sys.argv[3])
        for rel in gone:
            print('block-css-keep: ' + rel + ' is named in a block.json and shipped in the static copy, but missing from '
                  'the PHP tree: core would register its style with an empty src (#1205)', file=sys.stderr)
        sys.exit(1 if gone else 0)
    print('\n'.join(keep_paths()))

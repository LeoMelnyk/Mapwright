#!/usr/bin/env python3
"""Remove manual offset-shadow drawing commands from prop files.

A manual shadow in my props looks like:
    # Shadow
    ellipse X,Y rx,ry fill #1a1008 0.X
    ... possibly one more ellipse/rect with similar fill

From true top-down perspective, an offset ellipse south of the prop
is wrong. The prop renderer adds proper shadows via `shadow: yes`
in the header.

Strategy: for each file in the given list, walk through lines. When we
hit a comment matching /^#\s*(Shadow|Drop shadow|Shadow base)\b/, drop
that line and any immediately following lines that look like shadow
draw commands (ellipse/rect with fill of a dark colour at low opacity).
Stop consuming as soon as we see a non-shadow line.
"""

import re
import sys
from pathlib import Path

SHADOW_COMMENT = re.compile(r'^#\s*(Shadow|Drop\s+shadow|Ground\s+shadow|Shadow\s+base|Shadow\s+pool|Shadow\s+beneath|Base\s+shadow)\b', re.IGNORECASE)

# A shadow-ish ellipse/rect: dark fill + low-ish opacity
SHADOW_FILL_RE = re.compile(r'^(ellipse|rect)\b.*fill\s+#(1a1008|0a0400|0a0404|0a0800|000000|1a0f00|1a0800|2a1400)\b.*\s+0\.[0-6]\d*', re.IGNORECASE)


def process(path: Path) -> int:
    text = path.read_text(encoding='utf-8').splitlines()
    out = []
    i = 0
    removed = 0
    while i < len(text):
        line = text[i]
        if SHADOW_COMMENT.match(line.strip()):
            # Drop the comment
            removed += 1
            i += 1
            # Drop up to 2 immediately following shadow-like lines
            for _ in range(2):
                if i < len(text) and SHADOW_FILL_RE.search(text[i].strip()):
                    removed += 1
                    i += 1
                else:
                    break
            continue
        out.append(line)
        i += 1
    if removed:
        path.write_text('\n'.join(out) + '\n', encoding='utf-8')
    return removed


def main():
    files = sys.argv[1:]
    if not files:
        print('usage: remove-manual-shadows.py <file> ...', file=sys.stderr)
        return 1
    total = 0
    changed = 0
    for f in files:
        p = Path(f)
        if not p.exists():
            continue
        n = process(p)
        if n:
            changed += 1
            total += n
            print(f'{p.name}: removed {n} lines')
    print(f'--- changed {changed} files, removed {total} lines total')
    return 0


if __name__ == '__main__':
    sys.exit(main())

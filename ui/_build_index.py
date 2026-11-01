"""Checks every inventory ID is designed exactly once and writes index.html."""
import re, html, pathlib, sys

ROOT = pathlib.Path(__file__).parent
AREAS = [
    ("shell.html", "Shell and states"), ("auth.html", "Sign-in"), ("work.html", "Work queue"),
    ("claims.html", "Claims and patients"), ("money.html", "Money in"), ("clients.html", "Clients and setup"),
    ("admin.html", "Reports and admin"), ("outputs.html", "Emails and PDFs"), ("website.html", "Website"),
]

def rng(prefix, a, b): return [f"{prefix}-{i:02d}" for i in range(a, b + 1)]
EXPECTED = (rng("G", 1, 15) + rng("G", 20, 25) + rng("A", 1, 9) + rng("W", 1, 24) + rng("C", 1, 17) + rng("P", 1, 6)
            + rng("R", 1, 9) + rng("D", 1, 4) + rng("M", 1, 3) + rng("CL", 1, 11) + rng("O", 1, 11) + rng("I", 1, 5)
            + rng("RP", 1, 7) + rng("S", 1, 14) + rng("OP", 1, 4) + rng("CP", 1, 2) + rng("E", 1, 7) + rng("F", 1, 3)
            + rng("WEB", 1, 13))

found, entries, problems = {}, {}, []
for fname, area in AREAS:
    p = ROOT / fname
    if not p.exists():
        problems.append(f"missing file {fname}"); continue
    s = p.read_text()
    for m in re.finditer(r'<section class="ref-view" id="([A-Z]+-\d+)">(.*?)</section>', s, re.S):
        vid, body = m.group(1), m.group(2)
        t = re.search(r"<h2>(.*?)</h2>", body, re.S)
        title = re.sub(r"<.*?>", "", t.group(1)).strip() if t else vid
        tags = re.findall(r'<span class="tag">(.*?)</span>', body[:1500])
        for k in ("Purpose", "Data", "Actions", "States", "Rules"):
            if f"<dt>{k}</dt>" not in body: problems.append(f"{vid}: spec missing {k}")
        if vid in found: problems.append(f"{vid}: duplicate in {fname} and {found[vid]}")
        found[vid] = fname
        entries.setdefault(fname, []).append((vid, title, tags[:2]))

missing = [i for i in EXPECTED if i not in found]
extra = [i for i in found if i not in EXPECTED]
print(f"designed {len(found)} of {len(EXPECTED)}; missing: {missing or 'none'}; extra: {extra or 'none'}")
for pr in problems: print("problem:", pr)

cards = []
for fname, area in AREAS:
    items = "".join(f'<li><a href="{fname}#{v}"><span class="code">{v}</span>{html.escape(t)}</a> <span class="subtle">{html.escape(" · ".join(tg))}</span></li>' for v, t, tg in entries.get(fname, []))
    cards.append(f'<div class="card"><div class="card-head"><h2><a href="{fname}">{area}</a></h2><span class="count-badge">{len(entries.get(fname, []))}</span></div><div class="card-body"><ul>{items}</ul></div></div>')

nav = "".join(f'<a href="{f}">{a}</a>' for f, a in AREAS)
page = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="claude:viewport-fit-sides" content="cover">
<title>Cleanpost UI Reference</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@600;700&family=Public+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="assets/tokens.css">
<link rel="stylesheet" href="assets/components.css">
<link rel="stylesheet" href="assets/reference.css">
</head>
<body>
<header class="ref-top"><a class="brand" href="index.html"><span data-mark></span>Cleanpost UI</a><nav aria-label="Areas">{nav}</nav><button type="button" class="btn btn-secondary btn-sm" id="theme-toggle" style="margin-left:auto"><i data-lucide="moon"></i>Theme</button></header>
<div class="ref-body">
<div class="ref-intro">
<h1>Cleanpost UI reference</h1>
<p>{len(found)} designs for the Cleanpost app, its emails and PDFs, and the marketing website. Each design sits beside its spec: purpose, data, actions, states and rules. IDs match the Cleanpost View Inventory. All patient and practice data is synthetic.</p>
<p>Built from the Cleanpost Design System tokens (assets/tokens.css) and one component stylesheet (assets/components.css). Use the Theme button to check dark mode.</p>
</div>
<div class="ref-index">{"".join(cards)}</div>
</div>
<script src="assets/vendor/lucide.min.js"></script>
<script src="assets/shell.js"></script>
</body>
</html>
'''
(ROOT / "index.html").write_text(page)
sys.exit(1 if missing or problems else 0)

"""Merge labeling-agent output into research/heldout-findings.json.

Usage: python3 -I research/scripts/ingest_heldout.py research/heldout-raw/*.json
Each raw file: {"repo","file","claims":[{line,quote,claim,verdict,severity,evidence}]} plus optional
"reviewed": {"<line>": "confirmed"|"rejected"} written after hand-verifying the stale claims.
Stale claims are only labeled stale once confirmed; rejected ones become false-positive traps.
"""
import json
import sys

OUT = 'research/heldout-findings.json'
d = json.load(open(OUT))
# Post-run adjudications are recorded only in OUT; keep them across re-ingests.
adjudicated = [x for x in d['stale'] if x.get('adjudicated')]
d['stale'], d['not_stale'] = [], []
pending = 0
for path in sys.argv[1:]:
    raw = json.load(open(path))
    reviewed = raw.get('reviewed', {})
    for c in raw['claims']:
        base = {'repo': raw['repo'], 'file': raw['file'], 'line': c['line'], 'claim': c['claim']}
        if c['verdict'] == 'true':
            d['not_stale'].append({**base, 'trap': 'verified_true', 'why_rejected': c['evidence']})
        elif c['verdict'] == 'stale':
            status = reviewed.get(str(c['line']))
            if status == 'confirmed':
                d['stale'].append({**base, 'severity': c['severity'], 'verified_by': 'claude', 'evidence': c['evidence']})
            elif status == 'rejected':
                d['not_stale'].append({**base, 'trap': 'agent_false_positive', 'why_rejected': c['evidence']})
            else:
                pending += 1
key = lambda x: (x['repo'], x['file'], x['line'])
d['stale'] += adjudicated
d['not_stale'] = [x for x in d['not_stale'] if key(x) not in {key(a) for a in adjudicated}]
json.dump(d, open(OUT, 'w'), indent=1)
print(f"{len(d['stale'])} stale, {len(d['not_stale'])} not_stale, {pending} stale claims still unreviewed")

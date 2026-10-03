#!/usr/bin/env python3
"""Validate the manually reviewed architecture model and detect stale inputs.

This does not extract semantics or certify correctness. Refresh claims by source
review before updating model.json; never automatically restamp stale hashes.
"""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def test_path(test):
    # Bare names are the old stubbed handler tests beside the handlers; a path
    # is repo-relative (the live E2E flows under core/verifier/flows/).
    return test if '/' in test else 'core/supabase/functions/api/' + test

def validate(root=ROOT):
    model = json.loads((root / 'docs/architecture/model.json').read_text())
    errors = []
    sources = model['snapshot']['sources']
    for name, digest in sources.items():
        source = root / name
        if not source.is_file():
            errors.append(f'Missing reviewed source: {name}')
        elif hashlib.sha256(source.read_bytes()).hexdigest() != digest:
            errors.append(f'Source changed; review affected architecture claims: {name}')
    for key, node in model['nodes'].items():
        if node['stage'] not in model['groups']:
            errors.append(f'{key}: unknown enclosing process')
        if not model['internals'].get(key):
            errors.append(f'{key}: missing implementation decomposition')
        for name, line in [(node['file'], node['line']),
                           (test_path(node['test']), node['testline'])]:
            if name not in sources:
                errors.append(f'{key}: source not fingerprinted: {name}')
            path = root / name
            if path.is_file() and not 1 <= line <= len(path.read_text().splitlines()):
                errors.append(f'{key}: invalid source line: {name}:{line}')
    for group in model['groups'].values():
        if group['selected'] not in model['nodes']:
            errors.append('Process refers to missing focus node')
    return errors

if __name__ == '__main__':
    problems = validate()
    if problems:
        print('\n'.join(problems))
        raise SystemExit(1)
    print('Architecture model valid; reviewed source fingerprints match. Semantic correctness requires human review.')

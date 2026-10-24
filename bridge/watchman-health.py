#!/usr/bin/env python3
"""Read-only health evidence from hook JSONL. Never prints payloads or secrets."""
import json
import math
import sys
import time

FETCH_OK = {'no_new_messages', 'new_wechat_message'}

def objects(value):
    if isinstance(value, dict):
        yield value
    elif isinstance(value, list):
        for child in value:
            yield from objects(child)
    elif isinstance(value, str) and value.startswith('{'):
        try:
            decoded = json.loads(value)
            if isinstance(decoded, dict):
                yield decoded
        except (ValueError, RecursionError):
            pass

def analyze(records, now=None):
    now = time.time() if now is None else now
    rows = []
    duties = {}
    malformed = 0
    for record in records:
        try:
            d = json.loads(record) if isinstance(record, str) else record
            times = (d['started_at_ms'], d.get('finished_at_ms', d['started_at_ms']))
            if not all(type(t) in (int, float) and math.isfinite(t) for t in times):
                raise ValueError('invalid time type')
            start, end = (t / 1000 for t in times)
            if not all(0 < t <= now + 5 for t in (start, end)) or end < start:
                raise ValueError('invalid time')
            if end < now - 1800:
                # Keep invocation freshness but do not let an ancient failed
                # hook with no terminal reason poison every future inspection.
                rows.append((start, end, None))
                continue
            # Terminal reason is normally in result; support older top-level
            # reason. Do not mistake a script-log reason for a terminal result.
            reason = d.get('reason')
            for key in ('result', 'hook_result', 'output'):
                value = d.get(key)
                if isinstance(value, str):
                    try: value = json.loads(value)
                    except ValueError: value = None
                if isinstance(value, dict):
                    reason = value.get('reason', value.get('data', {}).get('reason') if isinstance(value.get('data'), dict) else None) or reason
            for event in objects(d.get('script_logs', [])):
                if event.get('event', event.get('message')) == 'duty_success':
                    # Hook runtime flattens log(message, data) into one object.
                    # Retain support for explicit event/data fixtures/readers.
                    data = event.get('data', event)
                    if isinstance(data, str):
                        try: data = json.loads(data)
                        except ValueError: data = {}
                    if data.get('duty') in ('fetch', 'sync_watchdog', 'codex_probe'):
                        duties[data['duty']] = max(duties.get(data['duty'], 0), end)
            if not isinstance(reason, str) or not reason:
                raise ValueError('missing terminal outcome')
            rows.append((start, end, reason))
        except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError):
            malformed += 1
    rows.sort()
    if not rows:
        return {'status': 'unknown', 'reason': 'no_valid_invocation_evidence', 'malformed': malformed}
    if malformed:
        # A corrupt/unrecognized row might be a newer invocation or a fetch
        # success. It cannot be silently removed to manufacture a failure streak.
        return {'status': 'unknown', 'reason': 'incomplete_or_invalid_evidence', 'malformed': malformed}
    latest = rows[-1][0]
    success = [r[1] for r in rows if r[2] in FETCH_OK]
    if duties.get('fetch'):
        success.append(duties['fetch'])
    last_success = max(success, default=None)
    failures = [r for r in rows if r[2] and r[2] not in FETCH_OK and
                (last_success is None or r[1] > last_success)]
    # A recent successful fetch resets the whole failure streak. A truncated
    # history without ten minutes of failed terminals is insufficient evidence.
    failure_since = min((r[1] for r in failures), default=None)
    continuous_failure = (failure_since is not None and now - failure_since >= 600 and
                          (last_success is None or now - last_success >= 600))
    stopped = now - latest > 600
    return {'status': 'stopped' if stopped else 'alive_failing' if continuous_failure else
            'healthy' if last_success is not None and now - last_success < 600 else 'unknown',
            'invocation_age_seconds': now - latest,
            'last_fetch_success': last_success,
            'failure_since': failure_since,
            'failure_reasons': sorted({r[2] for r in failures}),
            'duty_last_success': duties, 'malformed': malformed}

if __name__ == '__main__':
    try:
        with open(sys.argv[1], encoding='utf8') as f:
            print(json.dumps(analyze(f)))
    except OSError as e:
        print(json.dumps({'status': 'unknown', 'reason': e.__class__.__name__}))

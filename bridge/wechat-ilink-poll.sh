#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ "${1:-}" != --backup-recover && "${1:-}" != --backup-keepalive && "${1:-}" != --backup-probe && "${1:-}" != --keepalive-worker ]]; then
  source "$HATCH_HOOK_RUNTIME"
fi

# Filesystem key shared by queue/ack and handoff identity validation.
ACCOUNT_ALIAS="<BOT_ACCOUNT>"

BRIDGE_DIR="$HOME/workspace/custom-connectors/wechat-ilink-bridge"
export WX_STATE_DIR="${WX_STATE_DIR:-$HOME/workspace/custom-connectors/wechat-ilink/state}"

# Keep dry-run before helpers, locks, temporary files, and all bridge calls.
if [ "${HATCH_HOOK_DRY_RUN:-0}" = "1" ]; then
  if [ -f "$WX_STATE_DIR/accounts/${ACCOUNT_ALIAS}.json" ] || ls "$WX_STATE_DIR/accounts/"*.json >/dev/null 2>&1; then
    log "dry_run" '{"account_present":true}'
    silent "dry_run_ok" '{"account_present":true}'
  else
    log "dry_run" '{"account_present":false}'
    silent "dry_run_no_account" '{"account_present":false}'
  fi
  exit 0
fi

# An override is one executable path (not a shell command). Default unchanged.
bridge_unbounded() {
  if [ -n "${WX_BRIDGE_CLI:-}" ]; then
    "$WX_BRIDGE_CLI" "$@"
  else
    node "$BRIDGE_DIR/src/cli/index.js" "$@"
  fi
}

# New structure is opt-in. A single worker owns each complete budget; children
# remain in that worker's process group so timeout cannot strand a sender.
bounded_worker() {
  python3 - "$WX_STATE_DIR" "$1" "$2" "${BASH_SOURCE[0]}" <<'PYBUDGET'
import fcntl, json, os, signal, subprocess, sys
state, mode, budget, script = sys.argv[1:]
lock = None
if mode == '--keepalive-worker':
    lock = os.open(os.path.join(state, '.codex-keepalive.mutex'),
                   os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: sys.exit(75)
env = os.environ.copy()
env['WX_BUDGET_WORKER'] = mode
# Keep mutex in the worker and its helpers, even if this supervisor dies.
p = subprocess.Popen(['bash', script, mode], env=env, start_new_session=True,
                     pass_fds=(() if lock is None else (lock,)))
try:
    rc = p.wait(timeout=float(budget))
except subprocess.TimeoutExpired:
    os.killpg(p.pid, signal.SIGKILL)
    p.wait()
    # The supervised child is now dead, including send descendants. Release
    # only its own lease via the UNCHANGED PYLOCK release protocol; never clear
    # a foreign owner or weaken stale-lock age/boot evidence.
    if mode == '--wechat-budget-worker':
        try:
            owner = json.load(open(os.path.join(state, '.outbox.lock', 'owner.json')))
            if owner['pid'] == p.pid and owner['script'] == os.path.realpath(script):
                source = open(script).read()
                program = source.split("<<'PYLOCK'\n", 1)[1].split('\nPYLOCK\n', 1)[0]
                subprocess.run(['python3', '-c', program, state,
                    os.environ.get('WX_LOCK_PROC_DIR', '/proc'), str(p.pid), script,
                    'release', owner['token']], timeout=2, stdout=subprocess.DEVNULL)
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            pass  # leave foreign/uncertain leases to the existing recovery rules
    rc = 124
sys.exit(rc if 0 <= rc <= 255 else 125)
PYBUDGET
}
bridge() {
  if [ "${WX_BUDGET_WORKER:-}" != --wechat-budget-worker ]; then
    bridge_unbounded "$@"
    return
  fi
  # Per-duty deadline, nested inside the 65-second total WeChat budget.
  local remaining=$((DUTY_END - SECONDS))
  [ "$remaining" -gt 0 ] || return 124
  if [ -n "${WX_BRIDGE_CLI:-}" ]; then
    timeout --foreground --signal=KILL "${remaining}s" "$WX_BRIDGE_CLI" "$@"
  else
    timeout --foreground --signal=KILL "${remaining}s" node "$BRIDGE_DIR/src/cli/index.js" "$@"
  fi
}

# Shared JSON/file operations. Callers hold .outbox.lock through the whole poll,
# including watchdog decisions and fetch. Queue writes go through bridge account transactions.
state_op() {
  python3 - "$WX_STATE_DIR" "$@" <<'PY'
import fcntl, hashlib, json, math, os, subprocess, sys, tempfile, time
state, op, *args = sys.argv[1:]
# Both keepalive lines and all poll state operations reuse the stable directory
# guard for read/modify/rename. Never hold it across probe/launch or poll_lock.
if os.path.isfile(os.path.join(state, 'keepalive-decoupled.enabled')):
    guard = os.open(state, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fcntl.flock(guard, fcntl.LOCK_EX)
now = time.time()
lpath = os.path.join(state, '.sent-ledger.json')

def read_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)

def atomic(path, data):
    fd, tmp = tempfile.mkstemp(prefix='.poll-json-', dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

def ledger():
    try:
        data = read_json(lpath)
        return {h: t for h, t in data.items()
                if isinstance(h, str) and len(h) == 64
                and isinstance(t, (int, float)) and not isinstance(t, bool)
                and math.isfinite(t) and 0 <= now - t <= 86400}
    except (OSError, ValueError, TypeError, AttributeError):
        return {}

def queue():
    envelope = read_json(args[-1])
    if envelope.get('ok') is not True:
        raise ValueError('invalid snapshot')
    data = envelope['data']
    if data.get('queue_error'):
        raise ValueError('queue unavailable')
    return data

def entry(item, expired=False):
    error = item.get('lastError')
    error = error.get('code') if isinstance(error, dict) else None
    return {'id': str(item.get('id') or hashlib.sha256(
                (str(item.get('userId', '')) + '\0' + str(item.get('text', ''))).encode()).hexdigest()),
            'error': 'EXPIRED_DROPPED' if expired else (error or 'QUEUED'),
            'head': '[content omitted]',
            'textHash': hashlib.sha256(str(item.get('text', '')).encode()).hexdigest(),
            'userId': str(item.get('userId', ''))}

if op == 'prune':
    result = json.loads(args[0])
    atomic(lpath, ledger())
    print(json.dumps(result, ensure_ascii=False))
elif op == 'preflight':
    path, text = args[:2]
    if now - os.stat(path).st_mtime > 1800:
        print('expired_dropped')
    elif hashlib.sha256(text.encode()).hexdigest() in ledger():
        print('dedup_skip_ledger')
    else:
        try:
            print('dedup_skip_queue' if any(it.get('text') == text for it in queue()['items']) else 'send')
        except (OSError, ValueError, TypeError):
            print('queue_unreadable')  # defer rather than risk duplicating unseen text
elif op == 'record':
    data = ledger()
    data[hashlib.sha256(args[0].encode()).hexdigest()] = int(now)
    atomic(lpath, data)
elif op == 'send_result':
    result = 'unknown' if os.path.isfile(os.path.join(state, 'segmented-retry.enabled')) else 'failed'
    try:
        data = read_json(args[0])
        # Only result fields, never recursive search into error.details.
        if not isinstance(data, dict) or data.get('ok') is not True:
            raise ValueError('failed response')
        d = data.get('data', data)
        if not isinstance(d, dict):
            raise ValueError('invalid result')
        if 'deliveryStatus' in d:
            helper = os.path.join(os.path.expanduser('~'), 'workspace', 'custom-connectors',
                                  'wechat-ilink-bridge', 'scripts', 'classify-send-result.py')
            print(subprocess.check_output(['python3', helper, args[0]], text=True).strip())
            sys.exit(0)
        # sendText success has chunkCount/sent, without a delivered field.
        # Queue ownership takes precedence even if sent fields are present.
        if d.get('voided') is True:
            result = 'voided'
        elif d.get('queued') is True:
            result = 'queued'
        else:
            count, sent = d.get('chunkCount'), d.get('sent')
            if (isinstance(count, int) and not isinstance(count, bool)
                    and count >= 1 and isinstance(sent, list) and len(sent) == count):
                result = 'delivered'
    except (OSError, ValueError, TypeError):
        pass
    print(result)
elif op == 'file_log':
    print(json.dumps({'file': os.path.basename(args[0])}, ensure_ascii=False))
elif op == 'attempt':
    path = args[0] + '.attempts'
    try:
        with open(path) as f:
            n = int(f.read())
        if n < 0:
            n = 0
    except (OSError, ValueError):
        n = 0
    n += 1
    with open(path, 'w') as f:
        f.write(str(n))
    print(n)
elif op in ('alert_observe', 'alert_notify', 'fetch_gate', 'fetch_outcome', 'cleanup_due'):
    path = os.path.join(state, '.anomaly-alerts.json')
    try:
        data = read_json(path)
        if not isinstance(data, dict): raise ValueError('invalid alerts')
    except (OSError, ValueError, TypeError):
        data = {}
    def alert(kind):
        d = data.get(kind, {})
        if not isinstance(d, dict): d = {}
        for key in ('since', 'count', 'last_wake', 'next_attempt'):
            v = d.get(key, 0)
            if type(v) not in (int, float) or not math.isfinite(v) or v < 0: v = 0
            d[key] = v
        return d
    if op == 'alert_observe':
        kind, active = args
        d = alert(kind)
        if active == '1':
            if not d['since']: d['since'] = now
            d['count'] += 1
        else:
            d = dict(since=0, count=0, last_wake=0, next_attempt=0, signature='')
        data[kind] = d
    elif op == 'alert_notify':
        kind = args[0]
        d = alert(kind)
        ready = (d['since'] > 0 and
                 (kind == 'session' or kind == 'unknown' and now - d['since'] >= 1800
                  or kind == 'fetch' and d['count'] >= 5))
        if ready and (not d['last_wake'] or now - d['last_wake'] >= 1800):
            d.update(last_wake=now, signature=kind)
            print('WAKE')
        else: print('SILENT')
        data[kind] = d
    elif op == 'fetch_gate':
        d = alert('fetch')
        print('WAIT' if now < d['next_attempt'] else 'TRY')
    elif op == 'fetch_outcome':
        kind = args[0]
        if kind == 'healthy':
            data['fetch'] = data['session'] = dict(since=0, count=0, last_wake=0, next_attempt=0, signature='')
        elif kind == 'session':
            d = alert('session')
            if not d['since']: d['since'] = now
            d['count'] += 1
            data['session'] = d
            data['fetch'] = dict(since=0, count=0, last_wake=0, next_attempt=0, signature='')
        else:
            d = alert('fetch')
            if not d['since']: d['since'] = now
            d['count'] += 1
            if d['count'] >= 5:
                d['next_attempt'] = now + min(1800, 60 * 2 ** min(5, int(d['count']) - 5))
            data['fetch'] = d
    else:
        last = data.get('cleanup_at', 0)
        if type(last) not in (int, float) or not math.isfinite(last): last = now
        if now - last >= 86400:
            data['cleanup_at'] = now  # reserve before calling bridge; at most once/day including failures
            print('TRY')
        else: print('WAIT')
    atomic(path, data)
elif op.startswith('remote_'):
    path = os.path.join(state, '.codex-remote.json')
    try:
        data = read_json(path)
        if not isinstance(data, dict):
            raise ValueError('invalid remote state')
        for key in ('last_attempt', 'last_wake', 'failures'):
            value = data[key]
            if (not isinstance(value, (int, float)) or isinstance(value, bool)
                    or not math.isfinite(value) or value < 0):
                raise ValueError('invalid remote field')
        if (not isinstance(data['failures'], int) or data['failures'] > 3
                or data['signature'] not in ('', 'codex_remote_down')):
            raise ValueError('invalid signature')
    except (OSError, ValueError, TypeError, KeyError):
        # Unknown cooldown after corruption: wait a full interval before retry.
        data = dict(last_attempt=now, last_wake=now, failures=0, signature='')
        if not os.path.exists(path):
            data['last_attempt'] = data['last_wake'] = 0
    if op == 'remote_healthy':
        data.update(failures=0, signature='')
    elif op == 'remote_reserve':
        if now - data.get('last_attempt', 0) >= 600:
            data['last_attempt'] = now  # persist BEFORE invoking the launcher
            print('TRY')
        else:
            print('WAIT')
    elif op == 'remote_failed':
        data['failures'] = min(3, int(data.get('failures', 0)) + 1)
    elif op == 'remote_notify':
        sig = 'codex_remote_down'
        if (data.get('failures', 0) >= 3 and data.get('signature', '') != sig
                and now - data.get('last_wake', 0) >= 300):
            data.update(signature=sig, last_wake=now)
            print('WAKE')
        else:
            print('SILENT')
    atomic(path, data)
elif op == 'watchdog_commit':
    check = json.loads(args[0])
    atomic(os.path.join(state, '.sync-watchdog.json'), {'signature': check['signature'], 'last_wake': int(now)})
elif op == 'watchdog_retry':
    atomic(os.path.join(state, '.sync-watchdog.json'), {'signature': '', 'last_wake': 0})
elif op == 'watchdog':
    maintenance = json.loads(args[0])
    stuck = []
    queue_error = bool(maintenance.get('queue_error'))
    try:
        document = queue()
        receipts = document.get('voids', {})
        stuck.extend(entry(it) for it in document['items']
                     if not receipts.get(entry(it)['id'], {}).get('reportedAt')
                     and it.get('segmented', {}).get('deliveryStatus') not in ('partial', 'unknown', 'delivered'))
    except (OSError, ValueError, TypeError):
        receipts = {}
        queue_error = True
    fdir = os.path.join(state, 'outbox', 'failed')
    if os.path.isdir(fdir):
        stuck.extend({'id': 'failed:' + n, 'error': 'OUTBOX_GAVE_UP', 'head': n}
                     for n in sorted(os.listdir(fdir)) if n.endswith('.txt')
                     and not receipts.get('failed:' + n, {}).get('reportedAt'))
    # Pending durable void receipts survive reporter death and queue removal.
    # They are supplied by the bridge, whose account lock protects all writes.
    known = {it['id'] for it in stuck}
    expired = maintenance['expired']
    expired_ids = {it['id'] for it in expired}
    for it in json.loads(args[1]).get('items', []):
        if it['id'] not in known and it['id'] not in expired_ids:
            stuck.append({k: it.get(k) for k in ('id', 'error', 'head', 'textHash', 'userId')})
    remaining = len(stuck)
    stuck.extend(expired)  # report drops once, even if pruning emptied the queue
    sig = json.dumps(sorted((it['id'], it['error'] == 'EXPIRED_DROPPED') for it in stuck)) if stuck else ''
    check = {'count': len(stuck), 'remaining_count': remaining,
             'expired_dropped': sum(it.get('error') == 'EXPIRED_DROPPED' for it in stuck), 'signature': sig, 'items': stuck, 'queue_error': queue_error}
    path = os.path.join(state, '.sync-watchdog.json')
    try:
        prev = read_json(path)
        last_wake = float(prev.get('last_wake', 0))
        if not math.isfinite(last_wake):
            raise ValueError('invalid time')
    except (OSError, ValueError, TypeError, AttributeError):
        prev, last_wake = {}, 0
    decision = 'SILENT'
    if not stuck:
        if prev.get('signature'):
            atomic(path, {'signature': '', 'last_wake': last_wake})
    elif (sig != prev.get('signature') or json.loads(args[1]).get('items')) and now - last_wake >= 300:
        # Reserve only after the bridge has durably voided these items.
        decision = 'WAKE'
    print(decision)
    print(json.dumps(check, ensure_ascii=False))
PY
}

# Bound all external keepalive commands, including their descendant processes.
remote_command() {
  python3 - "$@" <<'PYREMOTE'
import os, signal, subprocess, sys
try:
    p = subprocess.Popen(sys.argv[1:], stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL,
                         start_new_session=os.environ.get("WX_BUDGET_WORKER") != "--keepalive-worker")
    try:
        rc = p.wait(timeout=20)
    except subprocess.TimeoutExpired:
        if os.environ.get("WX_BUDGET_WORKER") == "--keepalive-worker": p.kill()
        else: os.killpg(p.pid, signal.SIGKILL)
        p.wait()
        rc = 124
except OSError:
    rc = 125
sys.exit(rc if 0 <= rc <= 255 else 125)
PYREMOTE
}

remote_probe() {
  if [ -n "${WX_CODEX_PROBE_BIN:-}" ]; then
    remote_command "$WX_CODEX_PROBE_BIN"
    return
  fi
  # daemon.pid identifies the managed app-server, not the updater socket owner.
  # The CLI may be a Node wrapper; only the daemon package identifies its exe.
  python3 - "${WX_CODEX_DAEMON_DIR:-$HOME/.codex/app-server-daemon}" \
    "$HOME/.codex/packages/app-server-daemon" "${WX_CODEX_PROC_DIR:-/proc}" <<'PYPROBE'
import json, os, sys
base, packages, proc_root = sys.argv[1:]
pidfile = os.path.join(base, 'daemon.pid')

def identity():
    with open(pidfile) as f:
        data = json.load(f)
    pid = data['pid']
    ticks = data['processIdentity']['startTicks']
    boot = data['processIdentity'].get('bootId')
    if (type(pid) is not int or pid <= 0 or type(ticks) is not int or ticks <= 0
            or (boot is not None and (not isinstance(boot, str) or not boot))):
        raise ValueError('invalid process identity')
    return pid, ticks, boot

def start_time(proc, pid):
    with open(os.path.join(proc, 'stat')) as f:
        stat = f.read()
    # comm may contain spaces and parentheses; field 22 follows the last ')'.
    head, tail = stat.rsplit(')', 1)
    if int(head.split('(', 1)[0]) != pid:
        raise ValueError('invalid stat pid')
    fields = tail.split()
    return int(fields[19]), fields[0]

try:
    if not os.path.isdir(proc_root):
        sys.exit(2)
    expected = identity()
    pid, ticks, boot = expected
    if boot is not None:
        with open(os.path.join(proc_root, 'sys/kernel/random/boot_id')) as f:
            if f.read().strip() != boot:
                sys.exit(1)
    proc = os.path.join(proc_root, str(pid))
    try:
        actual, state = start_time(proc, pid)
        if actual != ticks or state in ('Z', 'X', 'x'):
            sys.exit(1)
        exe = os.readlink(os.path.join(proc, 'exe'))
        # Require an absolute native release path, not a CLI wrapper or sibling
        # directory with the same prefix. Deleted executables do not qualify.
        release = os.path.join(os.path.realpath(packages), 'releases')
        parts = os.path.relpath(exe, release).split(os.sep)
        if (not os.path.isabs(exe) or len(parts) != 3 or parts[0] in ('.', '..')
                or parts[1:] != ['bin', 'codex'] or exe.endswith(' (deleted)')):
            sys.exit(1)
        with open(os.path.join(proc, 'cmdline'), 'rb') as f:
            args = f.read().split(b'\0')
        if (b'app-server' not in args or b'--managed-daemon' not in args
                or b'--remote-control' not in args or b'pid-update-loop' in args):
            sys.exit(1)
        # Recheck after inspection to reject exit/reuse and concurrent pid updates.
        final_ticks, final_state = start_time(proc, pid)
        if final_ticks != ticks or final_state in ('Z', 'X', 'x'):
            sys.exit(2)
    except FileNotFoundError:
        sys.exit(1)
    if identity() != expected:
        sys.exit(2)
except (OSError, ValueError, TypeError, KeyError, IndexError, AttributeError):
    # Missing/corrupt metadata or unreadable proc data cannot establish absence.
    sys.exit(2)
sys.exit(0)
PYPROBE
}

codex_keepalive() {
  local rc=0 decision
  remote_probe || rc=$?
  if [ "$rc" -eq 0 ]; then
    state_op remote_healthy
    state_op alert_observe unknown 0
    log "duty_success" '{"duty":"codex_probe"}'
    return
  fi
  if [ "$rc" -ne 1 ]; then
    state_op alert_observe unknown 1
    log "codex_remote_probe_unknown" "{\"rc\":$rc}"
    return
  fi
  state_op alert_observe unknown 0
  decision="$(state_op remote_reserve)"
  [ "$decision" = TRY ] || return 0
  rc=0
  remote_command "${WX_UNSHARE_BIN:-unshare}" --uts --fork bash -c \
    'hostname Muse && cd "$HOME" && exec "$1" remote-control start --json' \
    bash "${WX_CODEX_BIN:-$HOME/workspace/tools/codex-cli/bin/codex}" || rc=$?
  log "codex_remote_start" "{\"rc\":$rc}"
  if remote_probe; then
    state_op remote_healthy
    log "duty_success" '{"duty":"codex_probe"}'
  else
    state_op remote_failed
  fi
}

# Serialize every lock mutation on the stable state-directory inode. This kernel
# mutex is released on helper death; it is never an unlinkable guard file.
poll_lock() {
  python3 - "$WX_STATE_DIR" "${WX_LOCK_PROC_DIR:-/proc}" "$$" \
    "${BASH_SOURCE[0]}" "$@" <<'PYLOCK'
import fcntl, json, math, os, stat, sys, time, uuid
state, proc, pid, script, op, *args = sys.argv[1:]
pid = int(pid)
script = os.path.realpath(script)
lock = os.path.join(state, '.outbox.lock')
owner = os.path.join(lock, 'owner.json')

def emit(event, **data):
    print(event)
    print(json.dumps(data, ensure_ascii=False))

def ticks(p):
    with open(os.path.join(proc, str(p), 'stat')) as f:
        head, tail = f.read().rsplit(')', 1)
    fields = tail.split()
    if int(head.split('(', 1)[0]) != p or int(fields[19]) <= 0:
        raise ValueError('invalid stat')
    return int(fields[19])

def command(p):
    with open(os.path.join(proc, str(p), 'cmdline'), 'rb') as f:
        argv = f.read().split(b'\0')
    if not argv or not any(argv):
        raise ValueError('unreadable cmdline')
    # Bash executes the script as a complete argv element. Resolve relative
    # arguments against that process's cwd, never our own cwd.
    for value in argv[1:]:
        value = os.fsdecode(value)
        if value and not value.startswith('-'):
            if not os.path.isabs(value):
                value = os.path.join(os.readlink(os.path.join(proc, str(p), 'cwd')), value)
            if os.path.realpath(value) == script:
                return True
    return False

def clock():
    with open(os.path.join(proc, 'sys/kernel/random/boot_id')) as f:
        boot = f.read().strip()
    with open(os.path.join(proc, 'uptime')) as f:
        up = float(f.read().split()[0])
    if not boot or not math.isfinite(up) or up < 0:
        raise ValueError('invalid boot/uptime')
    return boot, up, time.time()

def read_owner():
    try:
        if not stat.S_ISREG(os.lstat(owner).st_mode):
            raise ValueError('owner is not a regular file')
        with open(owner) as f:
            d = json.load(f)
        for k in ('pid', 'startTicks'):
            if type(d[k]) is not int or d[k] <= 0:
                raise ValueError('invalid identity')
        for k in ('acquired_at', 'uptime'):
            if type(d[k]) not in (int, float) or not math.isfinite(d[k]) or d[k] < 0:
                raise ValueError('invalid time')
        if d['script'] != script or not isinstance(d['bootId'], str) or not d['bootId']:
            raise ValueError('foreign script/boot')
        if not isinstance(d['token'], str) or not d['token']:
            raise ValueError('missing token')
        return d
    except (OverflowError, RecursionError):
        raise ValueError('malformed_owner') from None

try:
    guard = os.open(state, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    # Acquisition never waits behind another helper. Release may wait briefly.
    fcntl.flock(guard, fcntl.LOCK_EX | (fcntl.LOCK_NB if op == 'acquire' else 0))
    if op == 'release':
        d = read_owner()
        if d['pid'] == pid and d['token'] == args[0]:
            os.unlink(owner)
            os.rmdir(lock)
        sys.exit(0)
    broken = None
    if op == 'recover' and not os.path.lexists(lock):
        emit('lock_absent')
        sys.exit(0)
    try:
        os.mkdir(lock, 0o700)
    except FileExistsError:
        lock_stat = os.lstat(lock)
        if not stat.S_ISDIR(lock_stat.st_mode):
            raise ValueError('lock is not a directory')
        if not os.listdir(lock):
            # mkdir and owner publication hold this same guard. An empty lock
            # seen here cannot be a cooperating acquisition in progress. Unlink
            # refreshes directory mtime; wait a full grace period after that.
            boot, up, now = clock()
            age = now - lock_stat.st_mtime
            if not math.isfinite(age):
                raise ValueError('invalid_lock_mtime')
            if age < 0:
                raise ValueError('future_lock_mtime')
            if age <= 900:
                raise ValueError('ownerless_lock_too_young')
            broken = dict(age_seconds=age, reason='ownerless_empty')
        else:
            d = read_owner()
            boot, up, now = clock()
            age = now - d['acquired_at']
            if boot != d['bootId']:
                # A process cannot survive a boot change. Uptime across boots is
                # incomparable; retain the wall-clock grace period before removal.
                if age < 0:
                    raise ValueError('future_acquired_at')
                if age <= 900:
                    raise ValueError('lock_too_young')
                reason = 'previous_boot'
            else:
                elapsed = up - d['uptime']
                if min(age, elapsed) < 0 or abs(age - elapsed) > 5:
                    raise ValueError('clock_or_boot_changed')
                reason = None
                try:
                    actual = ticks(d['pid'])
                except FileNotFoundError:
                    # Missing stat alone is insufficient: the PID directory must vanish.
                    try:
                        os.stat(os.path.join(proc, str(d['pid'])))
                    except FileNotFoundError:
                        reason = 'pid_absent'
                    else:
                        raise ValueError('stat_missing_for_existing_pid')
                else:
                    matches = command(d['pid'])
                    if ticks(d['pid']) != actual:
                        raise ValueError('process_changed_during_check')
                    if actual != d['startTicks']:
                        reason = 'pid_reused_original_startTicks_gone'
                    else:
                        raise ValueError('owner_alive' if matches else 'cmdline_mismatch')
                if age <= 900 or elapsed <= 900:
                    raise ValueError('lock_too_young')
            # Refuse unknown contents. All cooperating mutations hold the guard.
            if os.listdir(lock) != ['owner.json']:
                raise ValueError('unexpected_lock_contents')
            os.unlink(owner)
            broken = dict(age_seconds=age, pid=d['pid'], reason=reason)
        os.rmdir(lock)  # also atomically refuses any newly added contents
        # Evidence is emitted immediately, even if subsequent acquisition fails.
        emit('stale_lock_broken', **broken)
        if op == 'recover':
            sys.exit(0)
        os.mkdir(lock, 0o700)  # standard exclusive acquisition, never assume ownership
    try:
        boot, up, now = clock()
        start = ticks(pid)
        if not command(pid) or ticks(pid) != start:
            raise ValueError('cannot_identify_self')
        token = uuid.uuid4().hex
        d = dict(pid=pid, startTicks=start, acquired_at=now, uptime=up,
                 bootId=boot, script=script, token=token)
        tmp = os.path.join(lock, '.owner-tmp')
        with open(tmp, 'x') as f:
            json.dump(d, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, owner)
        emit('acquired', token=token)
    except Exception:
        # No work began. Only remove files created by this acquisition.
        for path in (os.path.join(lock, '.owner-tmp'), owner):
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
        os.rmdir(lock)
        raise
except (OSError, ValueError, TypeError, KeyError, IndexError, AttributeError) as e:
    emit('lock_unavailable', reason=str(e))
    sys.exit(1)
PYLOCK
}

OUTBOX_DIR="$WX_STATE_DIR/outbox"
OWNER_ID="<OWNER_ID>"
if [ "${1:-}" = --backup-probe ]; then
  rc=0
  remote_probe || rc=$?
  printf '{"probe_rc":%s}\n' "$rc"
  exit "$rc"
fi
# Second line reuses precisely the same evidence/guard implementation. It never
# acquires a poll owner or runs sends/fetches in these local maintenance modes.
if [ "${1:-}" = --backup-recover ]; then
  poll_lock recover
  exit $?
fi
if [[ "${1:-}" = --keepalive-worker || "${1:-}" = --wechat-budget-worker ]]; then
  [ "${WX_BUDGET_WORKER:-}" = "$1" ] || exit 125
fi
if [ "${1:-}" = --keepalive-worker ]; then
  log() { printf 'HATCH_HOOK_LOG:{"message":"%s","data":%s}\n' "$1" "$2" >&2; }
  codex_keepalive
  exit 0
fi
# Run BEFORE acquiring the sending owner. No bridge call or receive loop is
# introduced here. The backup entry uses exactly this same mutex and cooldown.
if [ -f "$WX_STATE_DIR/keepalive-decoupled.enabled" ] && [ "${1:-}" != --wechat-budget-worker ]; then
  mkdir -p -m 700 "$WX_STATE_DIR"
  if [ "${1:-}" = --backup-keepalive ]; then
    log() { printf '%s %s\n' "$1" "$2"; }
  fi
  KEEPALIVE_RC=0
  bounded_worker --keepalive-worker 15 || KEEPALIVE_RC=$?
  log "keepalive_slot" "{\"rc\":$KEEPALIVE_RC,\"budget_seconds\":15}"
  if [ "${1:-}" = --backup-keepalive ]; then exit "$KEEPALIVE_RC"; fi
  WECHAT_RC=0
  bounded_worker --wechat-budget-worker 65 || WECHAT_RC=$?
  if [ "$WECHAT_RC" -ne 0 ]; then
    silent "wechat_budget_exhausted" "{\"rc\":$WECHAT_RC,\"budget_seconds\":65}"
  fi
  exit 0
fi
if [ "${1:-}" = --backup-keepalive ]; then
  # A valid poll owner excludes the first line while reserving the SAME 600s
  # cooldown. This also gives .codex-remote.json a single writer at a time.
  log() { printf '%s %s\n' "$1" "$2"; }
  LOCK_RESULT="$(poll_lock acquire)" || true
  LOCK_TOKEN="$(printf '%s\n' "$LOCK_RESULT" | python3 -c 'import sys,json; a=sys.stdin.read().splitlines(); print(next((json.loads(a[i+1])["token"] for i in range(0,len(a)-1,2) if a[i]=="acquired"), ""))')"
  if [ -z "$LOCK_TOKEN" ]; then printf '%s\n' "$LOCK_RESULT"; exit 1; fi
  trap 'poll_lock release "$LOCK_TOKEN" >/dev/null 2>&1 || true' EXIT
  codex_keepalive
  exit 0
fi
mkdir -p -m 700 "$WX_STATE_DIR"
LOCK_RESULT="$(poll_lock acquire)" || true
LOCK_TOKEN=''
while IFS= read -r event && IFS= read -r detail; do
  if [ "$event" = acquired ]; then
    LOCK_TOKEN="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["token"])' "$detail")"
  else
    log "$event" "$detail"
  fi
done <<< "$LOCK_RESULT"
if [ -z "$LOCK_TOKEN" ]; then
  silent "poll_locked" '{}'
  exit 0
fi
QUEUE_OUT=''
SEND_OUT=''
OUT_FILE=''
ERR_FILE=''
TERMINAL=0
finish_silent() { TERMINAL=1; silent "$@"; }
finish_wake() { TERMINAL=1; wake "$@"; }
cleanup() {
  local status=$?
  [ -z "$QUEUE_OUT" ] || rm -f "$QUEUE_OUT"
  [ -z "$SEND_OUT" ] || rm -f "$SEND_OUT"
  [ -z "$OUT_FILE" ] || rm -f "$OUT_FILE"
  [ -z "$ERR_FILE" ] || rm -f "$ERR_FILE"
  poll_lock release "$LOCK_TOKEN" >/dev/null 2>&1 || true
  if [ "$TERMINAL" -eq 0 ]; then
    log "poll_failed" "{\"rc\":$status}"
    finish_silent "poll_failed" "{\"rc\":$status}"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Prune BEFORE any CLI call: send/fetch might flush the bridge queue itself.
QUEUE_OUT="$(mktemp "$WX_STATE_DIR/.poll-queue-XXXXXX")"
# Account-lock errors are classified for send, maintenance and fetch alike.
account_lock_diagnostic() {
  local detail
  detail="$(python3 - "$@" <<'PYDIAG'
import json, sys
for path in sys.argv[1:]:
    try:
        d = json.load(open(path)).get('error', {})
        code = d.get('code', '')
        if code.startswith('STATE_LOCK_'):
            status = d.get('details', {}).get('ownerStatus', 'unknown')
            print(json.dumps({'code': code, 'ownerStatus': status,
                  'suspected_stale': status != 'alive'}))
            break
    except (OSError, ValueError, TypeError, AttributeError):
        pass
PYDIAG
)"
  if [ -n "$detail" ]; then
    log "bridge_account_lock" "$detail"
    if [[ "$detail" != *'"suspected_stale": false'* ]]; then
      ACCOUNT_LOCK_ALERT="$detail"
    fi
  fi
}
ACCOUNT_LOCK_ALERT=''
queue_snapshot() {
  # Keep potentially large queue bodies in the private CLI result file. Passing
  # the whole document as one argv element would hit Linux MAX_ARG_STRLEN.
  QUEUE_SNAPSHOT="$QUEUE_OUT"
  if ! bridge queue snapshot --account "$ACCOUNT_ALIAS" --json >"$QUEUE_OUT"; then
    account_lock_diagnostic "$QUEUE_OUT"
    printf '%s\n' '{"ok":true,"data":{"items":[],"queue_error":true}}' >"$QUEUE_OUT"
  fi
}

DUTY_END=$((SECONDS + 3))
if bridge queue prune --account "$ACCOUNT_ALIAS" --json >"$QUEUE_OUT"; then
  QUEUE_MAINTENANCE="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("ok") is True; print(json.dumps(d["data"]))' "$QUEUE_OUT")"
else
  account_lock_diagnostic "$QUEUE_OUT"
  QUEUE_MAINTENANCE='{"expired":[],"queue_error":true}'
fi
MAINTENANCE="$(state_op prune "$QUEUE_MAINTENANCE")"
log "sync_queue_check" "$MAINTENANCE"

# --- Outbox flush -------------------------------------------------------
DUTY_END=$((SECONDS + 8))
OUTBOX_CONFIRMATION=''
if [ -d "$OUTBOX_DIR" ]; then
  for f in "$OUTBOX_DIR"/*.txt; do
    [ -f "$f" ] || continue
    if [ "${WX_BUDGET_WORKER:-}" = --wechat-budget-worker ] && [ "$SECONDS" -ge "$DUTY_END" ]; then
      log "outbox_budget_exhausted" '{}'
      break
    fi
    # read preserves trailing newlines, unlike $(cat ...); hash exactly CLI text.
    TEXT=''
    IFS= read -r -d '' TEXT < "$f" || true
    FILE_JSON="$(state_op file_log "$f")"
    queue_snapshot
    ACTION="$(state_op preflight "$f" "$TEXT" "$QUEUE_SNAPSHOT")"
    if [ "$ACTION" = expired_dropped ]; then
      # Persist fact AND content tombstone before deletion, even during cooldown.
      if ! bridge queue expire-outbox --account "$ACCOUNT_ALIAS" --file "${f##*/}" --json >"$QUEUE_OUT"; then
        account_lock_diagnostic "$QUEUE_OUT"
        log "expiry_persist_failed" '{}'
        continue
      fi
    fi
    case "$ACTION" in
      expired_dropped|dedup_skip_ledger|dedup_skip_queue)
        rm -f "$f" "$f.attempts"
        log "$ACTION" "$FILE_JSON"
        continue ;;
    esac
    if [ -z "$TEXT" ]; then
      rm -f "$f" "$f.attempts"
      continue
    fi
    SEND_RESULT=failed
    if [ "$ACTION" = send ]; then
      SEND_OUT="$(mktemp "$WX_STATE_DIR/.poll-send-XXXXXX")"
      if bridge send --user "$OWNER_ID" --text "$TEXT" --delivery-id "outbox:${f##*/}" --json >"$SEND_OUT" 2>/dev/null; then
        SEND_RESULT="$(state_op send_result "$SEND_OUT")"
      elif [ -f "$WX_STATE_DIR/segmented-retry.enabled" ]; then
        # Killed/invalid responses may follow a successful dispatch. Retain the
        # source and let the journal fence it; never move it to full-text retry.
        SEND_RESULT=unknown
      fi
      account_lock_diagnostic "$SEND_OUT"
    else
      log "queue_unreadable" "$FILE_JSON"
    fi
    case "$SEND_RESULT" in
      delivered)
        # Commit ledger before deleting the outbox copy.
        state_op record "$TEXT"
        rm -f "$f" "$f.attempts"
        log "outbox_sent" "$FILE_JSON" ;;
      voided)
        rm -f "$f" "$f.attempts"
        log "outbox_voided" "$FILE_JSON" ;;
      partial|unknown)
        if [ "$SEND_RESULT" = unknown ]; then
          OUTBOX_CONFIRMATION="$(python3 - "$SEND_OUT" "${f##*/}" <<'PYCONFIRM'
import json, sys
result = {'file': sys.argv[2], 'deliveryStatus': 'unknown',
          'reportProtocol': '仅在主对话报告，不重发、不写 outbox。实际报告且取得 deliveryId 后，调用 queue send-report-ack --account <accountId> --ids <deliveryId 的 JSON 数组>；只确认报告，不解除暂停。响应缺失时先用 queue send-reports 核对。'}
try:
    data = json.load(open(sys.argv[1])).get('data', {})
    if data.get('reportAcknowledged') is True: sys.exit(0)
    for key in ('accountId', 'deliveryId', 'confirmedChunks', 'unknownChunks', 'pendingChunks', 'reason'):
        if key in data: result[key] = data[key]
except (OSError, ValueError, TypeError, AttributeError):
    result['reason'] = 'SEND_RESULT_UNAVAILABLE_CHECK_JOURNAL'
print(json.dumps(result, ensure_ascii=False))
PYCONFIRM
)"
        fi
        log "outbox_${SEND_RESULT}" "$FILE_JSON"
        # Keep the only source. The bridge journal decides continuation/pause;
        # do not increment legacy attempts or park/recreate the whole message.
        ;;
      queued)
        rm -f "$f" "$f.attempts"
        log "outbox_queued_not_sent" "$FILE_JSON" ;;
      *)
        ATTEMPTS="$(state_op attempt "$f")"
        log "outbox_send_failed" "${FILE_JSON%\}},\"attempts\":$ATTEMPTS}"
        if [ "$ATTEMPTS" -ge 10 ]; then
          mkdir -p "$OUTBOX_DIR/failed"
          mv "$f" "$OUTBOX_DIR/failed/"
          rm -f "$f.attempts"
          log "outbox_gave_up" "$FILE_JSON"
        fi ;;
    esac
    [ -z "$SEND_OUT" ] || rm -f "$SEND_OUT"
    SEND_OUT=''
  done
fi

DUTY_END=$((SECONDS + 2))
# Low-frequency automatic retention; bridge cleanup takes the account lock.
if [ "$(state_op cleanup_due)" = TRY ]; then
  if bridge cleanup --account "$ACCOUNT_ALIAS" --message-retention-days 30 --attachment-retention-days 30 --max-history-messages 10000 --json >"$QUEUE_OUT" 2>/dev/null; then
    log "retention_cleanup" '{"ok":true}'
  else
    account_lock_diagnostic "$QUEUE_OUT"
    log "retention_cleanup" '{"ok":false}'
  fi
fi

# --- Codex keepalive: runs even when the sync watchdog will wake. --------
if [ "${WX_BUDGET_WORKER:-}" != --wechat-budget-worker ]; then codex_keepalive; fi

DUTY_END=$((SECONDS + 5))
if [ -n "$OUTBOX_CONFIRMATION" ]; then
  finish_wake "wechat_delivery_confirmation_required" "$OUTBOX_CONFIRMATION"
  exit 0
fi
# Paused segment evidence is a separate read-only report, never a void request.
# Leave the journal intact so a wake lost before delivery is safely replayable.
if { [ -f "$WX_STATE_DIR/segmented-retry.enabled" ] || [ -f "$WX_STATE_DIR/accounts/${ACCOUNT_ALIAS}.segmented-send.ledger" ]; } && bridge queue send-reports --account "$ACCOUNT_ALIAS" --json >"$QUEUE_OUT"; then
  SEGMENT_REPORT="$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["data"]))' "$QUEUE_OUT")"
  if python3 -c 'import json,sys; sys.exit(0 if json.loads(sys.argv[1]).get("items") else 1)' "$SEGMENT_REPORT"; then
    finish_wake "wechat_delivery_confirmation_required" "$SEGMENT_REPORT"
    exit 0
  fi
fi
# --- Sync self-check (watchdog) -----------------------------------------
PENDING_REPORTS='{"items":[]}'
SYNC_SCAN_OK=1
if bridge queue reports --account "$ACCOUNT_ALIAS" --json >"$QUEUE_OUT"; then
  PENDING_REPORTS="$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["data"]))' "$QUEUE_OUT")"
else
  SYNC_SCAN_OK=0
  account_lock_diagnostic "$QUEUE_OUT"
fi
queue_snapshot
WD_RESULT="$(state_op watchdog "$MAINTENANCE" "$PENDING_REPORTS" "$QUEUE_SNAPSHOT")"
WD_DECISION="${WD_RESULT%%$'\n'*}"
SYNC_CHECK="${WD_RESULT#*$'\n'}"
if [ "$SYNC_SCAN_OK" = 1 ] && [[ "$MAINTENANCE" != *'"queue_error": true'* && "$SYNC_CHECK" != *'"queue_error": true'* ]]; then
  log "duty_success" '{"duty":"sync_watchdog"}'
else
  log "duty_failed" '{"duty":"sync_watchdog","reason":"queue_unreadable_or_locked"}'
fi
if [ "$WD_DECISION" = WAKE ]; then
  # This shared transaction MUST commit before any stuck-item report is woken.
  if bridge queue void --account "$ACCOUNT_ALIAS" --items "$SYNC_CHECK" --json >"$QUEUE_OUT"; then
    SYNC_CHECK="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("ok") is True and d["data"].get("voided") is True; print(json.dumps(d["data"]))' "$QUEUE_OUT")"
    state_op watchdog_commit "$SYNC_CHECK"
    finish_wake "wechat_sync_stuck" "$SYNC_CHECK"
  else
    account_lock_diagnostic "$QUEUE_OUT"
    state_op watchdog_retry
    finish_wake "sync_void_failed" '{"reason":"Could not persist void state; no stuck-item report is authorized. Inspect bridge account lock/state."}'
  fi
  exit 0
fi

if [ -n "$ACCOUNT_LOCK_ALERT" ]; then
  finish_wake "bridge_account_lock_stale" "$ACCOUNT_LOCK_ALERT"
  exit 0
fi

# Commit the remote notification only after sync has declined its priority.
REMOTE_DECISION="$(state_op remote_notify)"
if [ "$REMOTE_DECISION" = WAKE ]; then
  finish_wake "codex_remote_down" '{"reason":"Codex daemon still down after 3 restart attempts","failures":3}'
  exit 0
fi

if [ "$(state_op alert_notify unknown)" = WAKE ]; then
  finish_wake "codex_remote_probe_unknown" '{"reason":"Codex identity evidence unknown for at least 30 minutes; no blind restart attempted."}'
  exit 0
fi
if [ "$(state_op alert_notify fetch)" = WAKE ]; then
  finish_wake "wechat_fetch_failed" '{"reason":"At least five consecutive fetch failures; retries use capped backoff."}'
  exit 0
fi
if [ "$(state_op fetch_gate)" = WAIT ]; then
  finish_silent "fetch_failed_transient" '{"backoff":true}'
  exit 0
fi

# --- Fetch: retain original wake/silent behavior and priority ------------
DUTY_END=$((SECONDS + 42))
OUT_FILE="$(mktemp "$WX_STATE_DIR/.poll-fetch-XXXXXX")"
ERR_FILE="$(mktemp "$WX_STATE_DIR/.poll-error-XXXXXX")"
RC=0
# Deferred ack is opt-in: after installing the receiver prompt, create the
# empty regular file "$WX_STATE_DIR/inbound-defer-ack.enabled". Absent = off.
# Snapshot once per poll so fetch and ack use the same mode. To disable after
# activation, pause/drain the hook and inbox requeue BEFORE removing the file.
INBOUND_DEFER_ACK=0
FETCH_ACK_ARGS=()
if [ -f "$WX_STATE_DIR/inbound-defer-ack.enabled" ]; then
  INBOUND_DEFER_ACK=1
  FETCH_ACK_ARGS+=(--defer-ack)
fi
bridge fetch --handoff --owner "$OWNER_ID" --timeout 40000 --max-attempts 1 --download-media "${FETCH_ACK_ARGS[@]}" --json >"$OUT_FILE" 2>"$ERR_FILE" || RC=$?
if [ "$RC" -ne 0 ]; then
  log "fetch_failed" "{\"rc\":$RC}"
  account_lock_diagnostic "$OUT_FILE" "$ERR_FILE"
  if [ -n "$ACCOUNT_LOCK_ALERT" ]; then
    finish_wake "bridge_account_lock_stale" "$ACCOUNT_LOCK_ALERT"
    exit 0
  fi
  if python3 - "$OUT_FILE" <<'PY'
import sys
with open(sys.argv[1], encoding='utf-8', errors='replace') as f:
    text = f.read().lower()
sys.exit(0 if any(s in text for s in ('session_expired', 'session expired', '-14')) else 1)
PY
  then
    state_op fetch_outcome session
    if [ "$(state_op alert_notify session)" = WAKE ]; then
      finish_wake "wechat_session_expired" '{"reason":"iLink session appears expired; user needs to re-scan a login QR code."}'
    else
      finish_silent "fetch_failed_transient" '{"session_expired":true,"throttled":true}'
    fi
  else
    state_op fetch_outcome failed
    if [ "$(state_op alert_notify fetch)" = WAKE ]; then
      finish_wake "wechat_fetch_failed" '{"reason":"At least five consecutive fetch failures; retries use capped backoff."}'
    else
      finish_silent "fetch_failed_transient" "{\"rc\":$RC}"
    fi
  fi
  exit 0
fi
RESULT="$(python3 - "$OUT_FILE" "$OWNER_ID" "$ACCOUNT_ALIAS" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding='utf-8') as f:
        data = json.load(f)
    if not isinstance(data, dict) or data.get('ok') is False:
        raise ValueError('invalid fetch result')
    d = data.get('data')
    if d is None:
        d = {}
    if not isinstance(d, dict):
        raise ValueError('invalid fetch data')
    count = d.get('newMessageCount') or 0
    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
        raise ValueError('invalid count')
    msgs = []
    rejected = d.get('rejectedMessageCount', 0)
    for m in d.get('messages') or []:
        # Defensive boundary for legacy responses; production handoff fetch
        # additionally rejects missing sender IDs before any persistence.
        if m.get('fromUserId') is not None and m.get('fromUserId') != sys.argv[2]:
            rejected += 1
            continue
        entry = {k: m.get(k) for k in ('fromUserId', 'type', 'text', 'timestamp')}
        if m.get('id'): entry['id'] = m['id']
        atts = [{k: a.get(k) for k in ('kind', 'path', 'mimeType')}
                for a in m.get('attachments') or []]
        if atts:
            entry['attachments'] = atts
        voice_trans = []
        if isinstance(m.get('items'), list):
            for it in m['items']:
                if (isinstance(it, dict) and it.get('kind') == 'voice'
                        and isinstance(it.get('transcription'), str)
                        and it['transcription'].strip()):
                    voice_trans.append({'kind': 'voice', 'transcription': it['transcription']})
        if voice_trans:
            entry['items'] = voice_trans
        msgs.append(entry)
    result = {'count': len(msgs) if rejected else count, 'messages': msgs, 'rejected_count': rejected}
    if 'handoff' in d:
        h = d['handoff']
        ids = [m['id'] for m in msgs]
        # Accept the configured filesystem alias and its canonical iLink ID only.
        # Do not sanitize arbitrary characters: malformed IDs must fail closed.
        account_alias = sys.argv[3]
        if (h.get('accountId') not in (account_alias, account_alias.replace('_', '@', 1))
                or h.get('ids') != ids
                or len(ids) != count or any(m.get('fromUserId') != sys.argv[2] for m in msgs)):
            raise ValueError('invalid handoff envelope')
        result['handoff'] = h
    print(json.dumps(result, ensure_ascii=False))
except (OSError, ValueError, TypeError, AttributeError):
    print('PARSE_ERROR')
PY
)"
if [ "$RESULT" = PARSE_ERROR ]; then
  log "parse_error" '{}'
  state_op fetch_outcome failed
  if [ "$(state_op alert_notify fetch)" = WAKE ]; then
    finish_wake "wechat_fetch_failed" '{"reason":"At least five consecutive invalid/failed fetches."}'
  else
    finish_silent "parse_error" '{}'
  fi
  exit 0
fi
COUNT="$(printf '%s' "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('count',0))")"
state_op fetch_outcome healthy
REJECTED="$(printf '%s' "$RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["rejected_count"])')"
if [ "$REJECTED" -gt 0 ]; then log "non_owner_rejected" "{\"count\":$REJECTED}"; fi
log "duty_success" '{"duty":"fetch"}'
log "poll" "{\"newMessageCount\":$COUNT}"
if [ "$COUNT" -gt 0 ]; then
  # Fail closed if an older bridge ignored --defer-ack. Never run the legacy
  # consumer under the assumption that the receiver protocol is installed.
  if [ "$INBOUND_DEFER_ACK" = "1" ] && ! printf '%s' "$RESULT" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("handoff",{}).get("ackMode") == "receiver" else 1)'; then
    finish_silent "inbound_receiver_required" '{}'
    exit 0
  fi
  # wake exits internally. Only legacy mode acknowledges local output success;
  # deferred mode leaves ack to inbox receive after durable receiver acceptance.
  TERMINAL=1
  if ( wake "new_wechat_message" "$RESULT" ); then
    if [ "$INBOUND_DEFER_ACK" != "1" ]; then
      HANDOFF_IDS="$(printf '%s' "$RESULT" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin).get("handoff",{}).get("ids",[])))')"
      if [ "$HANDOFF_IDS" != '[]' ]; then
        if ! bridge inbox ack --account "$ACCOUNT_ALIAS" --ids "$HANDOFF_IDS" --json >"$QUEUE_OUT"; then
          log "inbound_ack_failed" '{}'
        fi
      fi
    fi
  else
    log "inbound_handoff_failed" '{}'
  fi
else
  finish_silent "no_new_messages" '{}'
fi

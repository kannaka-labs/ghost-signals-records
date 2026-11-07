#!/usr/bin/env python3
"""gsr_cover_runner: paints Ghost Signals Records order covers with kannaka-art on a qBraid GPU.

Runs on debain2 from cron (gsr-cover-tick.sh, every 10 min under flock). debain2 cannot ssh to
the store's box, so everything goes over HTTPS: lease jobs, POST the PNGs back. One tick:

  0. finish any batch an earlier tick generated but did not upload (crash, store down)
  1. preflight BEFORE leasing: pods provisioned today < cap, no qBraid instance live, credits >= floor
  2. lease up to 8 jobs (none -> heartbeat and exit: no pod without work)
  3. plan 2 candidates per job with kannaka_art.build_plan, ONE JOB AT A TIME (a refused
     subject fails that job only), under this runner's own `gsr` template and an episode
     number from a counter in the 9000s
  4. kannaka-art's qbraid_run.sh, MODE=base, profiles 4090 -> L4 -> A10. The script's log is
     read, not its exit code: it exits 1 when ANY image misses its size gate even though the
     rest were made and copied back, so rc != 0 is never a reason to boot a second pod.
       REFUSED / rc 3        busy (another job holds the account) -> release, next tick
       no BILLING_START      boot or capacity failure, nothing billed -> next profile
       BILLING_START         the pod ran -> never fall back; gate and upload what is there
  5. per job: upload the first candidate that passes (>= 1024 px, >= 60 KB); a job with none
     -> /fail (an attempt); busy / no capacity / credits -> /release (no attempt)
  6. heartbeat to Gatus (notice_gsr-cover-runner), with a reason when something needs a person

Pod hygiene: qbraid_run.sh terminates only its own instance (EXIT trap) and never sweeps
strays. This runner never kills it on a clock (a SIGKILL would skip that trap); flock stops
overlap. After each run it checks TERMINATE_ERROR, its own id in STRAYS, and CUTOFF 10 60,
and pages with the instance id if any is wrong. Every provisioned id is appended to
~/gsr-covers/pods-created.txt ("<id> gsr-covers <time>").

Secrets: the store token is read from ~/.gsr-cover-token and the Gatus token from
~/.gatus-push.token, both sent in-process (never on a command line), never printed.
Python stdlib only; qbraid_core is imported inside the one function that reads credits.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HOME = os.path.expanduser("~")
HERE = os.path.dirname(os.path.abspath(__file__))
UA = "gsr-cover-runner/1 (+https://records.ninja-portal.com)"
RATES = {"gpu-rtx-4090": "1.45", "gpu-l4": "0.8167", "gpu-a10": "0"}  # RATE only labels cost_credits
EPISODE_FLOOR = 9000
CANDIDATES = ("a", "b")
KEEP_DAYS = 7


def env(k, d):
    v = os.environ.get(k)
    return d if v is None or v == "" else v


def settings():
    state = env("GSR_COVER_STATE", os.path.join(HOME, "gsr-covers"))
    return {
        "base": env("GSR_URL", "https://records.ninja-portal.com").rstrip("/"),
        "state": state,
        "ka_dir": env("KANNAKA_ART_DIR", os.path.join(HOME, "kannaka-art")),
        "template": env("GSR_COVER_TEMPLATE", os.path.join(HERE, "gsr.json")),
        "token_file": env("GSR_COVER_TOKEN_FILE", os.path.join(HOME, ".gsr-cover-token")),
        "min_credits": float(env("GSR_COVER_MIN_CREDITS", "150")),
        "max_pods_day": int(env("GSR_COVER_MAX_PODS_DAY", "8")),
        "profiles": [p for p in env("GSR_COVER_PROFILES", "gpu-rtx-4090,gpu-l4,gpu-a10").split(",") if p],
        "max_jobs": max(1, min(8, int(env("GSR_COVER_MAX_JOBS", "8")))),
        "min_bytes": int(env("GSR_COVER_MIN_BYTES", "60000")),
        "gatus_key": env("GSR_COVER_GATUS_KEY", "notice_gsr-cover-runner"),
        "gatus_url": env("GATUS_PUSH_URL", "https://staff.ninja-portal.com/gatus-push"),
        "gatus_token_file": env("GATUS_TOKEN_FILE", os.path.join(HOME, ".gatus-push.token")),
        "venv_python": env("QBRAID_PY", os.path.join(HOME, "qbraid-venv2", "bin", "python")),
    }


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg):
    print(f"[gsr-covers {now_iso()}] {msg}", flush=True)


def read_secret(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def write_json(path, obj):
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


# ---------------------------------------------------------------- the store's API

class Api:
    """The store's /internal/covers/* routes. Raises OSError on a network failure."""

    def __init__(self, base, token, timeout=90):
        self.base, self.token, self.timeout = base, token, timeout

    def _call(self, method, path, body=None, headers=None):
        h = {"Authorization": f"Bearer {self.token}", "User-Agent": UA, "Accept": "application/json"}
        h.update(headers or {})
        req = urllib.request.Request(self.base + path, data=body, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                status, text = r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            status, text = e.code, e.read().decode("utf-8", "replace")
        try:
            return status, json.loads(text)
        except ValueError:
            return status, {"raw": text[:200]}

    def lease(self, n):
        s, j = self._call("GET", f"/internal/covers/lease?max={int(n)}")
        if s != 200:
            raise OSError(f"lease answered {s}: {j}")
        return j.get("jobs") or []

    def upload(self, job_id, gen, data, meta):
        return self._call("POST", f"/internal/covers/{job_id}", data,
                          {"Content-Type": "image/png", "X-Cover-Gen": str(gen), "X-Cover-Meta": meta})

    def fail(self, job, reason, size_only=False):
        body = json.dumps({"gen": job["gen"], "leaseId": job["leaseId"], "reason": reason[:200], "sizeOnly": bool(size_only)}).encode()
        return self._call("POST", f"/internal/covers/{job['jobId']}/fail", body, {"Content-Type": "application/json"})

    def release(self, job):
        body = json.dumps({"gen": job["gen"], "leaseId": job["leaseId"]}).encode()
        return self._call("POST", f"/internal/covers/{job['jobId']}/release", body, {"Content-Type": "application/json"})


def gatus_ping(cfg, ok, msg=""):
    """Heartbeat. Never raises, never prints the token."""
    tok = read_secret(cfg["gatus_token_file"])
    if not tok:
        log("gatus: no token file; heartbeat skipped")
        return False
    q = "success=true" if ok else "success=false&error=" + urllib.parse.quote(re.sub(r"[^A-Za-z0-9._-]", "-", msg or "failed")[:80])
    req = urllib.request.Request(f"{cfg['gatus_url']}/{cfg['gatus_key']}/external?{q}", data=b"", method="POST",
                                 headers={"Authorization": f"Bearer {tok}", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return 200 <= r.status < 300
    except Exception as e:  # noqa: BLE001 - a heartbeat never fails the tick
        log(f"gatus: {type(e).__name__}")
        return False


# ---------------------------------------------------------------- kannaka-art

def load_ka(ka_dir):
    """Import kannaka_art from its deployed directory. Stdlib at import; torch only in gen."""
    if ka_dir not in sys.path:
        sys.path.insert(0, ka_dir)
    import kannaka_art  # noqa: PLC0415
    return kannaka_art


def load_template(path):
    with open(path, encoding="utf-8") as f:
        t = json.load(f)
    for k in ("show", "tail", "negative", "rules"):
        if k not in t:
            raise ValueError(f"{path} lacks {k!r}")
    if not re.match(r"^[a-z]+$", t["show"]):
        raise ValueError("show must be [a-z]+ so kannaka_art parses its file names")
    return t


def slugs_for(job):
    j8 = re.sub(r"[^a-z0-9]", "", str(job["jobId"]).lower())[:8]
    return [f"gsr-{j8}-g{int(job['gen'])}a{int(job.get('attempt') or 0)}{c}" for c in CANDIDATES]


def plan_batch(ka, template, episode, jobs, extra=None):
    """(plan, planned_jobs, bad). Each job is planned on its own so one refused subject costs
    that job, not the batch. `extra` = [{slug, subject}] planned too (house sleeves), and a
    refusal there is an error (those subjects are ours)."""
    show = template["show"]
    merged, planned, bad = [], [], []
    for job in jobs:
        hits = ka.forbidden_words(job.get("subject") or "")
        if hits:
            bad.append((job, f"subject has {','.join(hits)}"))
            continue
        try:
            p = ka.build_plan(show, episode, [{"slug": s, "subject": job["subject"]} for s in slugs_for(job)], template)
        except ka.ArtError as e:
            bad.append((job, f"plan: {str(e)[:150]}"))
            continue
        merged.extend(p["jobs"])
        planned.append({**job, "slugs": slugs_for(job)})
    if extra:
        merged.extend(ka.build_plan(show, episode, extra, template)["jobs"])
    plan = {"show": show, "episode": episode, "template_sha256": ka.sha256_text(ka.canonical_json(template)),
            "tail": template["tail"], "negative": template["negative"], "rules": template["rules"], "jobs": merged}
    return plan, planned, bad


def next_episode(state):
    """A monotonic counter in the 9000s, written BEFORE planning so seeds never repeat."""
    path = os.path.join(state, "episode-counter")
    try:
        with open(path, encoding="utf-8") as fh:
            n = int(fh.read().strip())
    except (OSError, ValueError):
        n = EPISODE_FLOOR
    n = max(n, EPISODE_FLOOR) + 1
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(f"{n}\n")
    os.replace(tmp, path)
    return n


# ---------------------------------------------------------------- qBraid

def qbraid_status(cfg):
    """(credits, live instance ids), read in the qBraid venv. Prints numbers and ids only."""
    code = ("from qbraid_core.services.compute import ComputeClient\n"
            "import json\nc=ComputeClient()\n"
            "live=[i.instance_id for i in c.list_bma_instances() if 'TERMINATED' not in str(i.status).upper()]\n"
            "print(json.dumps({'credits': c.get_credits_balance()['qbraidCredits'], 'live': live}))\n")
    r = subprocess.run([cfg["venv_python"], "-c", code], capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        raise OSError(f"qbraid status rc={r.returncode}")
    j = json.loads(r.stdout.strip().splitlines()[-1])
    return float(j["credits"]), list(j["live"])


def pods_today(state):
    day = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    try:
        with open(os.path.join(state, "pods-created.txt"), encoding="utf-8") as f:
            return sum(1 for line in f if f" gsr-covers {day}" in line)
    except OSError:
        return 0


def register_pod(state, iid):
    with open(os.path.join(state, "pods-created.txt"), "a", encoding="utf-8") as f:
        f.write(f"{iid} gsr-covers {now_iso()}\n")


def classify(rc, text):
    """Read qbraid_run.sh's log, not its exit code. Returns a dict:
    outcome busy|noboot|ran, iid, alarms[], credits_before, credits_after."""
    iid_m = re.search(r"^PROVISIONED (\S+)", text, re.M)
    iid = iid_m.group(1) if iid_m else None
    if "BILLING_START" in text:
        outcome = "ran"
    elif rc == 3 or (re.search(r"^REFUSED", text, re.M) and not iid):
        outcome = "busy"
    else:
        outcome = "noboot"
    alarms = []
    if "TERMINATE_ERROR" in text:
        alarms.append(f"terminate-error-{iid}")
    strays = re.findall(r"^STRAYS (.*)$", text, re.M)
    if iid and strays and iid in strays[-1]:
        alarms.append(f"own-pod-not-terminated-{iid}")
    if iid:
        cut = re.search(r"^CUTOFF (\S+) (\S+)", text, re.M)
        if not cut or (cut.group(1), cut.group(2)) != ("10", "60"):
            alarms.append(f"cutoff-not-60-{iid}")
        if not strays:
            alarms.append(f"no-terminate-report-{iid}")
    num = lambda k: (lambda m: float(m.group(1)) if m else None)(re.search(rf"^{k} ([0-9.]+)", text, re.M))  # noqa: E731
    return {"outcome": outcome, "iid": iid, "alarms": alarms,
            "credits_before": num("CREDITS_BEFORE"), "credits_after": num("CREDITS_AFTER")}


def run_pod(cfg, batch, profile):
    """One qbraid_run.sh session. No timeout here on purpose (see the module docstring)."""
    logf = os.path.join(batch, f"qbraid-{profile}.log")
    e = dict(os.environ, MODE="base", SLUG=profile, RATE=RATES.get(profile, "0"), LOG=logf)
    with open(os.path.join(batch, f"run-{profile}.out"), "w", encoding="utf-8") as out:
        rc = subprocess.call(["bash", os.path.join(cfg["ka_dir"], "qbraid_run.sh"),
                              os.path.join(batch, "jobs.json"), os.path.join(batch, "out")],
                             stdout=out, stderr=subprocess.STDOUT, env=e)
    time.sleep(3)  # the script's tee may still be flushing its EXIT-trap lines
    text = ""
    for f in (logf, os.path.join(batch, f"run-{profile}.out")):
        try:
            with open(f, encoding="utf-8", errors="replace") as fh:
                t = fh.read()
            text = t if len(t) > len(text) else text
        except OSError:
            pass
    return rc, text


# ---------------------------------------------------------------- gate + upload

def png_wh(path):
    with open(path, "rb") as f:
        head = f.read(24)
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
        return None
    return int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")


def candidates(batch_state, job):
    """[(path, prompt_sha, seed)] for a job's candidates, in slug order."""
    out = []
    byslug = {j["slug"]: j for j in batch_state["plan_jobs"]}
    for s in job["slugs"]:
        pj = byslug.get(s)
        if not pj:
            continue
        name = pj["file"][:-4] + "-base.png" if not pj["file"].endswith("-base.png") else pj["file"]
        out.append((os.path.join(batch_state["dir"], "out", name), pj["prompt_sha256"], pj["seed"]))
    return out


def upload_batch(api, batch, min_bytes, ledger=None):
    """Upload what a pod made. Returns True when every job is settled (uploaded, failed or
    refused by the store), False when the store could not be reached (try next tick)."""
    st = read_json(os.path.join(batch, "batch.json"))
    st["dir"] = batch
    settled = st.setdefault("settled", {})
    complete = True
    for job in st["jobs"]:
        if job["jobId"] in settled:
            continue
        cands = candidates(st, job)
        made = [c for c in cands if os.path.exists(c[0])]
        size_only, outcome = bool(made), None
        try:
            for path, psha, seed in made:
                wh = png_wh(path)
                nbytes = os.path.getsize(path)
                if not wh or min(wh) < 1024:
                    size_only = False
                    continue
                if nbytes < min_bytes:
                    continue
                with open(path, "rb") as fh:
                    data = fh.read()
                status, body = api.upload(job["jobId"], job["gen"], data, f"{psha[:16]}|{seed}|{st.get('profile', '')}")
                if status == 200:
                    outcome = "uploaded"
                    if ledger:
                        with open(ledger, "a", encoding="utf-8") as f:
                            f.write(json.dumps({"ts": now_iso(), "jobId": job["jobId"], "gen": job["gen"], "episode": st["episode"],
                                                "file": os.path.basename(path), "seed": seed, "prompt_sha256": psha,
                                                "file_sha256": hashlib.sha256(data).hexdigest(), "profile": st.get("profile")}) + "\n")
                    break
                if status == 409:
                    outcome = f"refused-{body.get('reason')}"
                    break
                if status == 400:
                    size_only = size_only and body.get("reason") == "too_small"
                    continue
                raise OSError(f"upload answered {status}")
            if outcome is None:
                reason = "no passing candidate" if made else "pod made no image for this job"
                status, _ = api.fail(job, reason, size_only=size_only)
                outcome = f"failed-{status}{'-size' if size_only else ''}"
        except OSError as e:
            log(f"job {job['jobId'][:8]}: store unreachable ({str(e)[:80]}); kept for the next tick")
            complete = False
            break
        settled[job["jobId"]] = outcome
        log(f"job {job['jobId'][:8]} g{job['gen']}: {outcome}")
        st.pop("dir", None)
        write_json(os.path.join(batch, "batch.json"), st)
        st["dir"] = batch
    st.pop("dir", None)
    if complete:
        st["phase"] = "uploaded"
    write_json(os.path.join(batch, "batch.json"), st)
    return complete


def release_all(api, jobs):
    for j in jobs:
        try:
            api.release(j)
        except OSError as e:
            log(f"release {j['jobId'][:8]}: {e}")  # the lease simply expires


# ---------------------------------------------------------------- the tick

def batches(state):
    d = os.path.join(state, "batches")
    os.makedirs(d, exist_ok=True)
    return sorted(os.path.join(d, n) for n in os.listdir(d) if os.path.isdir(os.path.join(d, n)))


def resume(api, cfg):
    """Upload batches an earlier tick generated; release a crashed tick's leases. Returns False
    when something is still pending (no new work this tick)."""
    ok = True
    for b in batches(cfg["state"]):
        st = read_json(os.path.join(b, "batch.json"), {})
        phase = st.get("phase")
        if phase in ("running", "planned"):
            outdir = os.path.join(b, "out")
            if os.path.isdir(outdir) and any(n.endswith(".png") for n in os.listdir(outdir)):
                st["phase"] = "generated"
                write_json(os.path.join(b, "batch.json"), st)
                phase = "generated"
            else:
                log(f"batch {os.path.basename(b)} died before a pod made anything; releasing")
                release_all(api, st.get("jobs", []))
                st["phase"] = "released"
                write_json(os.path.join(b, "batch.json"), st)
        if phase == "generated":
            ok = upload_batch(api, b, cfg["min_bytes"], os.path.join(cfg["state"], "ledger.jsonl")) and ok
    return ok


def prune(cfg, now=None):
    """Batch dirs hold buyers' themes: keep a week, then delete (settled ones only)."""
    cutoff = (now or time.time()) - KEEP_DAYS * 86400
    for b in batches(cfg["state"]):
        st = read_json(os.path.join(b, "batch.json"), {})
        if st.get("phase") in ("uploaded", "released", "house-only") and os.path.getmtime(b) < cutoff:
            shutil.rmtree(b, ignore_errors=True)


def tick(cfg, api, status_fn=qbraid_status, pod_fn=run_pod, ka=None, extra=None):
    """One tick. Returns (ok, message) for the heartbeat."""
    os.makedirs(cfg["state"], exist_ok=True)
    if not resume(api, cfg):
        return False, "upload-pending"
    prune(cfg)
    n = pods_today(cfg["state"])
    if n >= cfg["max_pods_day"]:
        return False, f"day-cap-{n}-pods"
    credits, live = status_fn(cfg)
    log(f"CREDITS_BEFORE {credits:.2f} live {len(live)}")
    if live:
        return True, "busy"  # someone else's pod; the queue-age probe watches for starvation
    if credits < cfg["min_credits"]:
        return False, f"credits-{int(credits)}-under-{int(cfg['min_credits'])}"
    jobs = api.lease(cfg["max_jobs"])
    if not jobs and not extra:
        return True, "idle"
    ka = ka or load_ka(cfg["ka_dir"])
    template = load_template(cfg["template"])
    episode = next_episode(cfg["state"])
    plan, planned, bad = plan_batch(ka, template, episode, jobs, extra)
    for job, why in bad:
        log(f"job {job['jobId'][:8]} refused at planning: {why}")
        api.fail(job, why)
    if not plan["jobs"]:
        return True, "nothing-plannable"
    batch = os.path.join(cfg["state"], "batches", str(episode))
    os.makedirs(os.path.join(batch, "out"), exist_ok=True)
    ka.dump_json(os.path.join(batch, "jobs.json"), plan)
    st = {"episode": episode, "phase": "running", "jobs": planned, "plan_jobs": plan["jobs"], "started": now_iso(),
          "extra": [e["slug"] for e in (extra or [])]}
    write_json(os.path.join(batch, "batch.json"), st)
    log(f"batch {episode}: {len(planned)} job(s), {len(plan['jobs'])} image(s)")
    alarms, ran = [], None
    for profile in cfg["profiles"]:
        rc, text = pod_fn(cfg, batch, profile)
        c = classify(rc, text)
        if c["iid"]:
            register_pod(cfg["state"], c["iid"])
        alarms += c["alarms"]
        log(f"{profile}: rc={rc} outcome={c['outcome']} pod={c['iid']} credits {c['credits_before']} -> {c['credits_after']}")
        if c["outcome"] == "busy":
            release_all(api, planned)
            st["phase"] = "released"
            write_json(os.path.join(batch, "batch.json"), st)
            return (False, alarms[0]) if alarms else (True, "busy")
        if c["outcome"] == "ran":
            ran = profile
            break
    if not ran:
        release_all(api, planned)
        st["phase"] = "released"
        write_json(os.path.join(batch, "batch.json"), st)
        return (False, alarms[0]) if alarms else (True, "no-capacity")
    st["phase"], st["profile"] = "generated", ran
    write_json(os.path.join(batch, "batch.json"), st)
    complete = upload_batch(api, batch, cfg["min_bytes"], os.path.join(cfg["state"], "ledger.jsonl"))
    if alarms:
        return False, alarms[0]
    return (True, f"painted-{len(planned)}") if complete else (False, "upload-pending")


def dry_run(cfg, fixture, out):
    """Plan from a fixture of leased jobs (or one sample job), write jobs.json, print the
    command a tick would run. No lease, no pod, no upload."""
    ka = load_ka(cfg["ka_dir"])
    jobs = read_json(fixture) if fixture else [{"jobId": "0123456789abcdef", "gen": 0, "leaseId": "dry", "attempt": 0,
                                                 "subject": "ink and gold leaf on dark paper, a lighthouse at dusk, any figure seen from behind or as a faceless silhouette"}]
    plan, planned, bad = plan_batch(ka, load_template(cfg["template"]), EPISODE_FLOOR, jobs)
    os.makedirs(out, exist_ok=True)
    ka.dump_json(os.path.join(out, "jobs.json"), plan)
    for job, why in bad:
        print(f"REFUSED {job['jobId'][:8]}: {why}")
    for j in plan["jobs"]:
        print(f"PLAN {j['slug']} seed {j['seed']} -> {j['file'][:-4]}-base.png")
    for p in cfg["profiles"]:
        print(f"WOULD RUN: MODE=base SLUG={p} RATE={RATES.get(p, '0')} LOG={out}/qbraid-{p}.log "
              f"bash {cfg['ka_dir']}/qbraid_run.sh {out}/jobs.json {out}/out")
    print(f"dry-run: {len(planned)} job(s), {len(plan['jobs'])} image(s), {len(bad)} refused; nothing leased, no pod")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="gsr_cover_runner.py", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("tick", help="one cron tick")
    t.add_argument("--extra", help="JSON [{slug, subject}] painted in the same session, not uploaded (house sleeves)")
    d = sub.add_parser("dry-run", help="plan only; prints the qbraid command")
    d.add_argument("--fixture", help="JSON list of leased jobs")
    d.add_argument("--out", default=os.path.join(HOME, "gsr-covers", "dry"))
    p = sub.add_parser("ping", help="heartbeat only (the cron wrapper, when the lock is held)")
    p.add_argument("status", choices=("ok", "fail"))
    p.add_argument("message", nargs="?", default="")
    u = sub.add_parser("upload", help="upload one generated batch dir")
    u.add_argument("batch")
    a = ap.parse_args(argv)
    cfg = settings()
    if a.cmd == "dry-run":
        return dry_run(cfg, a.fixture, a.out)
    if a.cmd == "ping":
        gatus_ping(cfg, a.status == "ok", a.message)
        return 0
    token = read_secret(cfg["token_file"])
    if not token:
        log(f"no token in {cfg['token_file']}")
        gatus_ping(cfg, False, "no-store-token")
        return 2
    api = Api(cfg["base"], token)
    if a.cmd == "upload":
        return 0 if upload_batch(api, a.batch, cfg["min_bytes"], os.path.join(cfg["state"], "ledger.jsonl")) else 1
    extra = read_json(a.extra) if a.extra else None
    try:
        ok, msg = tick(cfg, api, extra=extra)
    except Exception as e:  # noqa: BLE001 - report, then fail the tick
        log(f"tick crashed: {type(e).__name__}: {str(e)[:200]}")
        gatus_ping(cfg, False, f"crash-{type(e).__name__}")
        return 1
    log(f"tick: {'ok' if ok else 'FAIL'} {msg}")
    gatus_ping(cfg, ok, msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())

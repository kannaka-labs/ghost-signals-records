"""Tests for gsr_cover_runner.py. Run: python -m unittest discover -s ops/cover-runner -v

The planner tests import the REAL kannaka_art.py (KANNAKA_ART_DIR, or a kannaka-radio checkout
beside this repo); they are skipped when neither is present. Everything else uses fakes: no
network, no pod, no credits."""
import json
import os
import struct
import sys
import tempfile
import unittest
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gsr_cover_runner as R  # noqa: E402


def find_ka():
    for d in (os.environ.get("KANNAKA_ART_DIR"), os.path.join(HERE, "..", "..", "..", "kannaka-radio", "scripts", "kannaka-art")):
        if d and os.path.exists(os.path.join(d, "kannaka_art.py")):
            return R.load_ka(os.path.abspath(d))
    return None


KA = find_ka()


def png(w, h, noise=True):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += os.urandom(w) if noise else bytes(w)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(raw), 1)) + chunk(b"IEND", b"")


BIG = png(1024, 1024)
SMALL_BYTES = png(1024, 1024, noise=False)


class FakeKa:
    """The planner surface the runner uses, for tests without kannaka-art."""
    class ArtError(Exception):
        pass

    import re as _re
    _F = _re.compile(r"\b(texts?|logos?|letters?|words?|signs?|signage|signposts?)\b", _re.I)

    def forbidden_words(self, s):
        return sorted({w.lower() for w in self._F.findall(s)})

    def build_plan(self, show, episode, subjects, template):
        jobs = []
        for i, s in enumerate(subjects):
            if self.forbidden_words(s["subject"]):
                raise self.ArtError("refusing")
            seed = 1000 + episode + i + len(s["slug"])
            jobs.append({"show": show, "episode": episode, "slug": s["slug"], "subject": s["subject"], "prompt": s["subject"] + ", tail",
                         "prompt_sha256": "ab" * 32, "negative": template["negative"], "seed": seed,
                         "file": f"{show}-e{episode:03d}-{s['slug']}-s{seed}.png"})
        return {"jobs": jobs}

    def sha256_text(self, s):
        return "00"

    def canonical_json(self, o):
        return json.dumps(o, sort_keys=True)

    def dump_json(self, path, obj):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f)


class FakeApi:
    def __init__(self, jobs, upload_status=200):
        self.jobs, self.upload_status = list(jobs), upload_status
        self.uploads, self.fails, self.releases, self.leases = [], [], [], 0

    def lease(self, n):
        self.leases += 1
        out, self.jobs = self.jobs[:n], self.jobs[n:]
        return out

    def upload(self, job_id, gen, data, meta):
        st = self.upload_status(job_id) if callable(self.upload_status) else self.upload_status
        if isinstance(st, Exception):
            raise st
        self.uploads.append((job_id, gen, len(data), meta))
        return st, {"ok": st == 200}

    def fail(self, job, reason, size_only=False):
        self.fails.append((job["jobId"], reason, size_only))
        return 200, {"ok": True}

    def release(self, job):
        self.releases.append(job["jobId"])
        return 200, {"ok": True}


def jobs(n, subject="ink and gold leaf on dark paper, a harbour at night, any figure seen from behind or as a faceless silhouette"):
    return [{"jobId": f"{i:02d}" + "ab" * 7, "gen": 0, "leaseId": f"L{i}", "attempt": 0, "subject": subject} for i in range(n)]


GOOD_LOG = """CREDITS_BEFORE 500.5
PREFLIGHT_INSTANCES []
PROVISIONED bma-pr-gpu-l4-1234abcd 2026-11-07T00:00:00Z
CUTOFF 10 60
BILLING_START 2026-11-07T00:05:00Z
=== GEN_DONE gen_rc=1 fetch_rc=0
=== TERMINATE bma-pr-gpu-l4-1234abcd
terminated ok
STRAYS []
CREDITS_AFTER 495.1 2026-11-07T00:12:00Z
"""


def pod_writes(make=lambda slug: BIG, rc=1, log=GOOD_LOG):
    """A fake qbraid_run.sh: writes one base-mode PNG per plan job, returns its log."""
    calls = []

    def fn(cfg, batch, profile):
        calls.append(profile)
        with open(os.path.join(batch, "jobs.json"), encoding="utf-8") as fh:
            plan = json.load(fh)
        for j in plan["jobs"]:
            data = make(j["slug"])
            if data is not None:
                with open(os.path.join(batch, "out", j["file"][:-4] + "-base.png"), "wb") as f:
                    f.write(data)
        return rc, log
    fn.calls = calls
    return fn


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="gsr-runner-")
        self.cfg = dict(R.settings(), state=self.tmp, max_jobs=8, min_bytes=60000, min_credits=150, max_pods_day=8,
                        profiles=["gpu-rtx-4090", "gpu-l4", "gpu-a10"], template=os.path.join(HERE, "gsr.json"))
        self.status = lambda cfg: (500.0, [])

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestClassify(unittest.TestCase):
    def test_a_pod_that_ran_is_ran_whatever_the_exit_code(self):
        c = R.classify(1, GOOD_LOG)
        self.assertEqual(c["outcome"], "ran")
        self.assertEqual(c["iid"], "bma-pr-gpu-l4-1234abcd")
        self.assertEqual(c["alarms"], [])
        self.assertEqual((c["credits_before"], c["credits_after"]), (500.5, 495.1))

    def test_busy_and_noboot(self):
        self.assertEqual(R.classify(3, "CREDITS_BEFORE 1\nPREFLIGHT_INSTANCES [('x','RUNNING')]\nREFUSED: instance(s) not TERMINATED\n")["outcome"], "busy")
        nb = R.classify(1, "PROVISIONED bma-1 t\nCUTOFF 10 60\nRUNNING never\n=== TERMINATE bma-1\nSTRAYS []\n")
        self.assertEqual(nb["outcome"], "noboot")
        self.assertEqual(nb["alarms"], [])

    def test_pod_hygiene_alarms_name_the_instance(self):
        bad = GOOD_LOG.replace("terminated ok", "TERMINATE_ERROR boom").replace("STRAYS []", "STRAYS [('bma-pr-gpu-l4-1234abcd', 'RUNNING')]").replace("CUTOFF 10 60", "CUTOFF None None")
        a = R.classify(1, bad)["alarms"]
        self.assertTrue(any("terminate-error-bma-pr-gpu-l4-1234abcd" == x for x in a))
        self.assertTrue(any(x.startswith("own-pod-not-terminated") for x in a))
        self.assertTrue(any(x.startswith("cutoff-not-60") for x in a))


class TestTick(Base):
    def test_batches_n_jobs_into_one_session_and_uploads_each_once(self):
        api, pod = FakeApi(jobs(3)), pod_writes()
        ok, msg = R.tick(self.cfg, api, status_fn=self.status, pod_fn=pod, ka=FakeKa())
        self.assertTrue(ok, msg)
        self.assertEqual(pod.calls, ["gpu-rtx-4090"], "one pod for the batch, and rc=1 did not boot a second")
        self.assertEqual(len(api.uploads), 3, "the first passing candidate of each job, once")
        self.assertEqual(api.fails, [])
        with open(os.path.join(self.tmp, "pods-created.txt")) as fh:
            reg = fh.read()
        self.assertIn("bma-pr-gpu-l4-1234abcd gsr-covers ", reg)
        # The next tick has nothing new: no lease handed out, no pod.
        ok, msg = R.tick(self.cfg, api, status_fn=self.status, pod_fn=pod, ka=FakeKa())
        self.assertEqual((ok, msg), (True, "idle"))
        self.assertEqual(pod.calls, ["gpu-rtx-4090"])
        self.assertEqual(len(api.uploads), 3, "idempotent: nothing re-uploaded")

    def test_no_work_no_pod(self):
        pod = pod_writes()
        self.assertEqual(R.tick(self.cfg, FakeApi([]), status_fn=self.status, pod_fn=pod, ka=FakeKa()), (True, "idle"))
        self.assertEqual(pod.calls, [])

    def test_preflight_comes_before_leasing(self):
        api = FakeApi(jobs(2))
        ok, msg = R.tick(self.cfg, api, status_fn=lambda c: (500.0, ["someone-elses-pod"]), pod_fn=pod_writes(), ka=FakeKa())
        self.assertEqual((ok, msg), (True, "busy"))
        ok, msg = R.tick(self.cfg, api, status_fn=lambda c: (90.0, []), pod_fn=pod_writes(), ka=FakeKa())
        self.assertFalse(ok); self.assertTrue(msg.startswith("credits-90"))
        self.assertEqual(api.leases, 0, "nothing leased while the account is busy or low")

    def test_no_capacity_tries_the_next_profile_then_releases_without_an_attempt(self):
        api = FakeApi(jobs(2))
        calls = []

        def noboot(cfg, batch, profile):
            calls.append(profile)
            return 1, f"PROVISIONED bma-{profile} t\nCUTOFF 10 60\n=== TERMINATE bma-{profile}\nSTRAYS []\n"
        ok, msg = R.tick(self.cfg, api, status_fn=self.status, pod_fn=noboot, ka=FakeKa())
        self.assertEqual((ok, msg), (True, "no-capacity"))
        self.assertEqual(calls, ["gpu-rtx-4090", "gpu-l4", "gpu-a10"])
        self.assertEqual(sorted(api.releases), sorted(j["jobId"] for j in jobs(2)))
        self.assertEqual(api.fails, [], "no attempt spent on capacity")
        self.assertEqual(R.pods_today(self.tmp), 3, "the day cap counts provisioned pods, not ticks")

    def test_busy_at_the_script_releases(self):
        api = FakeApi(jobs(1))
        ok, msg = R.tick(self.cfg, api, status_fn=self.status, pod_fn=lambda c, b, p: (3, "REFUSED: instance(s) not TERMINATED\n"), ka=FakeKa())
        self.assertEqual((ok, msg), (True, "busy"))
        self.assertEqual(len(api.releases), 1)

    def test_day_cap(self):
        with open(os.path.join(self.tmp, "pods-created.txt"), "w") as f:
            for i in range(8):
                f.write(f"bma-{i} gsr-covers {R.now_iso()}\n")
        api = FakeApi(jobs(1))
        ok, msg = R.tick(self.cfg, api, status_fn=self.status, pod_fn=pod_writes(), ka=FakeKa())
        self.assertFalse(ok); self.assertEqual(msg, "day-cap-8-pods"); self.assertEqual(api.leases, 0)

    def test_a_job_with_no_passing_candidate_fails_and_too_small_is_marked(self):
        api = FakeApi(jobs(2))
        first = jobs(2)[0]["jobId"][:8]
        pod = pod_writes(make=lambda slug: SMALL_BYTES if first in slug else BIG)
        ok, _ = R.tick(self.cfg, api, status_fn=self.status, pod_fn=pod, ka=FakeKa())
        self.assertTrue(ok)
        self.assertEqual(len(api.uploads), 1)
        self.assertEqual(api.fails, [(jobs(2)[0]["jobId"], "no passing candidate", True)])

    def test_a_missing_image_fails_that_job_only(self):
        api = FakeApi(jobs(2))
        first = jobs(2)[0]["jobId"][:8]
        R.tick(self.cfg, api, status_fn=self.status, pod_fn=pod_writes(make=lambda slug: None if first in slug else BIG), ka=FakeKa())
        self.assertEqual([f[1] for f in api.fails], ["pod made no image for this job"])
        self.assertEqual(len(api.uploads), 1)

    def test_store_down_after_the_pod_keeps_the_images_and_the_next_tick_uploads_first(self):
        down = OSError("connection refused")
        api = FakeApi(jobs(2), upload_status=down)
        pod = pod_writes()
        ok, msg = R.tick(self.cfg, api, status_fn=self.status, pod_fn=pod, ka=FakeKa())
        self.assertEqual((ok, msg), (False, "upload-pending"))
        api.upload_status = 200
        ok, msg = R.tick(self.cfg, api, status_fn=self.status, pod_fn=pod, ka=FakeKa())
        self.assertEqual(len(api.uploads), 2)
        self.assertEqual(pod.calls, ["gpu-rtx-4090"], "no second pod for work already painted")

    def test_a_crashed_tick_before_any_image_releases_its_leases(self):
        b = os.path.join(self.tmp, "batches", "9001")
        os.makedirs(os.path.join(b, "out"))
        R.write_json(os.path.join(b, "batch.json"), {"episode": 9001, "phase": "running", "jobs": jobs(1), "plan_jobs": []})
        api = FakeApi([])
        R.tick(self.cfg, api, status_fn=self.status, pod_fn=pod_writes(), ka=FakeKa())
        self.assertEqual(api.releases, [jobs(1)[0]["jobId"]])

    def test_pod_alarm_fails_the_heartbeat(self):
        api = FakeApi(jobs(1))
        bad = GOOD_LOG.replace("STRAYS []", "STRAYS [('bma-pr-gpu-l4-1234abcd', 'RUNNING')]")
        ok, msg = R.tick(self.cfg, api, status_fn=self.status, pod_fn=pod_writes(log=bad), ka=FakeKa())
        self.assertFalse(ok); self.assertIn("bma-pr-gpu-l4-1234abcd", msg)

    def test_episode_counter_is_monotonic_and_in_the_9000s(self):
        a, b = R.next_episode(self.tmp), R.next_episode(self.tmp)
        self.assertEqual((a, b), (9001, 9002))

    def test_slugs_are_planner_safe(self):
        import re
        for s in R.slugs_for({"jobId": "9F_a-Bc0123456789", "gen": 3, "attempt": 2}):
            self.assertRegex(s, r"^[a-z0-9][a-z0-9-]*$")
        self.assertEqual(R.slugs_for({"jobId": "0123456789abcdef", "gen": 1, "attempt": 0}), ["gsr-01234567-g1a0a", "gsr-01234567-g1a0b"])
        del re


class TestReviewFixes(Base):
    def test_a_setup_refusal_is_a_failure_not_busy(self):
        self.assertEqual(R.classify(2, "REFUSED: no jobs file /x\n")["outcome"], "refused")
        api = FakeApi(jobs(1))
        ok, msg = R.tick(self.cfg, api, status_fn=self.status, pod_fn=lambda c, b, p: (2, "REFUSED: /k/kannaka_art.py missing\n"), ka=FakeKa())
        self.assertFalse(ok); self.assertEqual(msg, "script-refused-gpu-rtx-4090")
        self.assertEqual(len(api.releases), 1)

    def test_a_failed_preflight_is_not_no_capacity(self):
        api = FakeApi(jobs(1))
        calls = []

        def pf(c, b, p):
            calls.append(p)
            return 1, "=== START\nTraceback: auth\n=== preflight failed rc=1; nothing provisioned\n"
        ok, msg = R.tick(self.cfg, api, status_fn=self.status, pod_fn=pf, ka=FakeKa())
        self.assertFalse(ok); self.assertEqual(msg, "script-preflight-failed-gpu-rtx-4090")
        self.assertEqual(calls, ["gpu-rtx-4090"], "no second profile after a preflight failure")
        # Provisioning that raised (capacity) still falls through to the next profile.
        nb = R.classify(1, "CREDITS_BEFORE 1\nPREFLIGHT_INSTANCES []\nNO IID; abort\nSTRAYS []\n")
        self.assertEqual(nb["outcome"], "noboot")

    def test_the_day_cap_is_rechecked_before_each_pod(self):
        with open(os.path.join(self.tmp, "pods-created.txt"), "w") as f:
            for i in range(7):
                f.write(f"bma-{i} gsr-covers {R.now_iso()}\n")
        calls = []

        def noboot(cfg, batch, profile):
            calls.append(profile)
            return 1, f"PREFLIGHT_INSTANCES []\nPROVISIONED bma-{profile} t\nCUTOFF 10 60\nSTRAYS []\n"
        api = FakeApi(jobs(1))
        ok, msg = R.tick(self.cfg, api, status_fn=self.status, pod_fn=noboot, ka=FakeKa())
        self.assertEqual(calls, ["gpu-rtx-4090"])
        self.assertEqual((ok, msg), (False, "day-cap-8-pods"))
        self.assertEqual(R.pods_today(self.tmp), 8)
        self.assertEqual(len(api.releases), 1)

    def test_daily_credit_budget(self):
        api = FakeApi(jobs(2))
        credits = [500.0]
        st = lambda c: (credits[0], [])  # noqa: E731
        self.assertTrue(R.tick(self.cfg, api, status_fn=st, pod_fn=pod_writes(), ka=FakeKa())[0])
        credits[0] = 455.0
        ok, msg = R.tick(self.cfg, api, status_fn=st, pod_fn=pod_writes(), ka=FakeKa())
        self.assertEqual((ok, msg), (False, "day-budget-45-of-40"))
        self.assertEqual(api.leases, 1, "nothing leased over budget")

    def test_a_404_upload_settles_instead_of_wedging(self):
        api = FakeApi(jobs(2), upload_status=404)
        ok, msg = R.tick(self.cfg, api, status_fn=self.status, pod_fn=pod_writes(), ka=FakeKa())
        self.assertTrue(ok, msg)
        api.jobs = jobs(1)
        api.upload_status = 200
        ok, msg = R.tick(self.cfg, api, status_fn=self.status, pod_fn=pod_writes(), ka=FakeKa())
        self.assertTrue(ok, msg); self.assertEqual(msg, "painted-1")

    def test_watch_pages_on_a_wrong_cutoff_and_a_long_session(self):
        cfg = dict(self.cfg, held_max_min=90)
        self.assertIsNone(R.watch_check("CREDITS_BEFORE 1\n", 9999, cfg))
        self.assertIsNone(R.watch_check("PROVISIONED bma-x t\n", 30, cfg), "cutoff line not written yet")
        self.assertEqual(R.watch_check("PROVISIONED bma-x t\nCUTOFF None 1440\n", 30, cfg), "cutoff-not-60-bma-x")
        self.assertEqual(R.watch_check("PROVISIONED bma-x t\nget err boom\nIID=bma-x\n", 30, cfg), "cutoff-not-60-bma-x")
        self.assertIsNone(R.watch_check("PROVISIONED bma-x t\nCUTOFF 10 60\nBILLING_START t\n", 600, cfg))
        self.assertEqual(R.watch_check("PROVISIONED bma-x t\nCUTOFF 10 60\n", 91 * 60, cfg), "pod-over-90min-bma-x")

    def test_held_lock_turns_red_when_the_pod_is_old_or_alarmed(self):
        cfg = dict(self.cfg, held_max_min=90)
        self.assertEqual(R.held_status(cfg), (True, "held"))
        R.write_json(R.held_path(cfg), {"t0": 1000.0, "iid": "bma-x", "alarm": None, "profile": "gpu-l4"})
        self.assertEqual(R.held_status(cfg, now=1000.0 + 60 * 30), (True, "held"))
        self.assertEqual(R.held_status(cfg, now=1000.0 + 60 * 121), (False, "held-121min-bma-x"))
        R.write_json(R.held_path(cfg), {"t0": 1000.0, "iid": "bma-x", "alarm": "cutoff-not-60-bma-x"})
        self.assertEqual(R.held_status(cfg, now=1001.0), (False, "cutoff-not-60-bma-x"))


@unittest.skipUnless(KA, "kannaka_art.py not found (set KANNAKA_ART_DIR)")
class TestRealPlanner(Base):
    def test_one_bad_subject_costs_one_job_not_the_batch(self):
        tmpl = R.load_template(os.path.join(HERE, "gsr.json"))
        js = jobs(3)
        js[1] = dict(js[1], subject="a neon sign over a diner")
        plan, planned, bad = R.plan_batch(KA, tmpl, 9001, js)
        self.assertEqual(len(planned), 2)
        self.assertEqual(len(plan["jobs"]), 4)
        self.assertEqual([b[0]["jobId"] for b in bad], [js[1]["jobId"]])
        for j in plan["jobs"]:
            self.assertEqual(j["show"], "gsr")
            p = KA.parse_image_name(j["file"][:-4] + "-base.png")
            self.assertEqual((p["show"], p["episode"], p["slug"], p["mode"]), ("gsr", 9001, j["slug"], "base"))
            self.assertIn("nudity", j["negative"])

    def test_seeds_differ_between_batches_and_candidates(self):
        tmpl = R.load_template(os.path.join(HERE, "gsr.json"))
        a = R.plan_batch(KA, tmpl, 9001, jobs(1))[0]["jobs"]
        b = R.plan_batch(KA, tmpl, 9002, jobs(1))[0]["jobs"]
        self.assertEqual(len({j["seed"] for j in a + b}), 4)

    def test_the_store_subject_passes_the_planner(self):
        # The store builds subjects in server/art.js; one typical output must plan as is.
        s = "ink and gold leaf on dark paper, a lighthouse keeper who stops writing to his sister, any figure seen from behind or as a faceless silhouette"
        self.assertEqual(KA.forbidden_words(s), [])
        plan, planned, bad = R.plan_batch(KA, R.load_template(os.path.join(HERE, "gsr.json")), 9003, jobs(1, s))
        self.assertEqual(bad, [])

    def test_a_real_tick_with_the_real_planner_and_a_fake_pod(self):
        api = FakeApi(jobs(2))
        ok, msg = R.tick(self.cfg, api, status_fn=self.status, pod_fn=pod_writes(), ka=KA)
        self.assertTrue(ok, msg)
        self.assertEqual(len(api.uploads), 2)


if __name__ == "__main__":
    unittest.main()

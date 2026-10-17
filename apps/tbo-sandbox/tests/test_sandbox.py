"""The runner's and the relay's own logic, without Docker, SSH or AWS (python3 -m unittest)."""

import base64
import datetime
import io
import json
import os
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import relay  # noqa: E402
import runner  # noqa: E402


def tar_of(files: dict[str, str]) -> str:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, text in files.items():
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return base64.b64encode(buffer.getvalue()).decode()


class Root(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        patcher = mock.patch.object(runner, "ROOT", self.root)
        patcher.start()
        self.addCleanup(patcher.stop)


class TheCode(Root):
    def test_it_lands_in_place_so_a_running_container_sees_it(self):
        target = self.root / "code" / "demo_app"
        (target / "old_dir").mkdir(parents=True)
        (target / "gone.py").write_text("x")
        (target / "kept.py").write_text("old")
        inode = target.stat().st_ino
        runner.unpack({"app": "demo_app", "tar": tar_of({"kept.py": "new", "pkg/new.py": "y"})}, target)
        self.assertEqual(target.stat().st_ino, inode)
        self.assertEqual((target / "kept.py").read_text(), "new")
        self.assertTrue((target / "pkg" / "new.py").exists())
        self.assertFalse((target / "gone.py").exists() or (target / "old_dir").exists())

    def test_a_path_out_of_the_folder_is_refused(self):
        with self.assertRaises(Exception):
            runner.unpack({"app": "demo_app", "tar": tar_of({"../escape.py": "x"})}, self.root / "code" / "demo_app")
        self.assertFalse((self.root / "code" / "escape.py").exists())

    def test_only_an_app_name(self):
        with self.assertRaises(runner.Refused):
            runner.unpack({"app": "../etc", "tar": tar_of({"a": "b"})}, self.root / "x")

    def test_the_relay_packs_what_the_runner_unpacks_without_git(self):
        clone = self.root / "clone"
        (clone / ".git").mkdir(parents=True)
        (clone / ".git" / "HEAD").write_text("ref")
        (clone / "demo_app").mkdir()
        (clone / "demo_app" / "margin.py").write_text("def f(): pass\n")
        code = relay.pack("demo_app", clone)
        runner.unpack(code, self.root / "code" / "demo_app")
        self.assertTrue((self.root / "code" / "demo_app" / "demo_app" / "margin.py").exists())
        self.assertFalse((self.root / "code" / "demo_app" / ".git").exists())

    def test_the_fingerprint_moves_when_a_file_changes(self):
        clone = self.root / "clone"
        clone.mkdir()
        (clone / "a.py").write_text("1")
        before = relay.fingerprint(clone)
        os.utime(clone / "a.py", ns=(1, 1))
        self.assertNotEqual(relay.fingerprint(clone), before)


class TheApps(unittest.TestCase):
    def test_frappe_and_erpnext_come_from_the_image(self):
        apps = runner.app_set({"apps": [
            {"app": "frappe", "commit": "62fa5cc"},
            {"app": "erpnext"},
            {"app": "zeta", "repository": "https://github.com/acme/zeta.git", "commit": "a" * 40},
            {"app": "alpha", "repository": "https://github.com/acme/alpha", "commit": "b" * 12},
        ]})
        self.assertEqual([a["app"] for a in apps], ["alpha", "zeta"])
        self.assertEqual(apps[1]["repository"], "https://github.com/acme/zeta")

    def test_a_custom_app_needs_its_repository_and_commit(self):
        for bad in ({"app": "x", "repository": "https://evil.example/x", "commit": "a" * 7}, {"app": "x", "repository": "https://github.com/a/x"}):
            with self.assertRaises(runner.Refused):
                runner.app_set({"apps": [bad]})

    def test_the_snapshot_key_follows_the_apps(self):
        a = [{"app": "x", "repository": "https://github.com/a/x", "commit": "a" * 7}]
        self.assertEqual(runner.key_of("img:1", a), runner.key_of("img:1", list(a)))
        self.assertNotEqual(runner.key_of("img:1", a), runner.key_of("img:2", a))


class TheTests(Root):
    def classify(self, run, report):
        with mock.patch.object(runner, "run_bench", return_value=run), mock.patch.object(runner, "junit", return_value=report):
            return runner.tested("sbx-000000000000", ["bench"], 10)

    def test_a_failed_assertion_is_one(self):
        self.assertEqual(self.classify({"ok": False, "exit_code": 1}, {"tests": 2, "failures": 1, "errors": 0})["failure"], "assertion")

    def test_an_error_or_no_report_is_an_error(self):
        self.assertEqual(self.classify({"ok": False, "exit_code": 1}, {"tests": 1, "failures": 1, "errors": 1})["failure"], "error")
        self.assertEqual(self.classify({"ok": False, "exit_code": 1}, {})["failure"], "error")

    def test_a_pass_and_nothing_to_run(self):
        self.assertTrue(self.classify({"ok": True, "exit_code": 0}, {"tests": 3, "failures": 0, "errors": 0})["ok"])
        self.assertTrue(self.classify({"ok": False, "exit_code": 1}, {"tests": 0, "failures": 0, "errors": 0})["skipped"])


class TheRequests(Root):
    def test_only_the_listed_operations(self):
        with self.assertRaises(runner.Refused):
            runner.handle({"op": "exec", "command": "rm -rf /"})

    def test_a_check_runs_a_module_of_its_own_app(self):
        (self.root / "runs" / "sbx-0123456789ab").mkdir(parents=True)
        with self.assertRaises(runner.Refused):
            runner.op_check({"id": "sbx-0123456789ab", "app": "demo_app", "module": "frappe.tests.test_x"})

    def test_a_sandbox_id_is_checked(self):
        with self.assertRaises(runner.Refused):
            runner.run_dir("../../etc")

    def test_main_answers_one_json_line_even_on_nonsense(self):
        out = io.StringIO()
        with mock.patch.object(sys, "stdin", io.TextIOWrapper(io.BytesIO(b"not json\n"))), mock.patch.object(sys, "stdout", out):
            runner.main()
        self.assertFalse(json.loads(out.getvalue())["ok"])


class TheRelay(Root):
    def config(self):
        return {"paths": {"/data": str(self.root)}, "timeout": 10, "instance_id": "i-1", "host": "10.0.0.1"}

    def test_container_paths_map_to_the_server(self):
        self.assertEqual(relay.host_path("/data/runs/R1/app", {"/data": "/var/lib/tbo-worker"}), Path("/var/lib/tbo-worker/runs/R1/app"))
        self.assertEqual(relay.host_path("/database/x", {"/data": "/var/lib/tbo-worker"}), Path("/database/x"))

    def test_the_signature_is_aws_v4(self):
        headers = relay.signed("ap-south-1", "Action=StartInstances", "AKIDEXAMPLE", "secret", "token",
                               datetime.datetime(2026, 10, 17, 9, 0, tzinfo=datetime.timezone.utc))
        self.assertEqual(headers["host"], "ec2.ap-south-1.amazonaws.com")
        self.assertTrue(headers["authorization"].startswith(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261017/ap-south-1/ec2/aws4_request, "
            "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature="))

    def test_start_sends_the_code_and_later_only_a_change(self):
        clone = self.root / "runs" / "R1" / "demo_app"
        clone.mkdir(parents=True)
        (clone / "a.py").write_text("1")
        sent = []
        hub = relay.Relay(self.config())
        hub.ensure_on = lambda: None
        hub.runner = lambda request, timeout=None: (sent.append(request), {"ok": True, "result": {"id": "sbx-0123456789ab"} if request["op"] == "start" else {}})[1]
        hub.handle({"op": "start", "spec": {"mount": {"app": "demo_app", "dir": "/data/runs/R1/demo_app"}}})
        hub.handle({"op": "check", "id": "sbx-0123456789ab", "app": "demo_app", "module": "demo_app.tests.t"})
        (clone / "a.py").write_text("22")
        hub.handle({"op": "check", "id": "sbx-0123456789ab", "app": "demo_app", "module": "demo_app.tests.t"})
        self.assertIn("code", sent[0])
        self.assertNotIn("code", sent[1])
        self.assertIn("code", sent[2])
        hub.handle({"op": "stop", "id": "sbx-0123456789ab"})
        self.assertEqual(hub.open, {})


if __name__ == "__main__":
    unittest.main()

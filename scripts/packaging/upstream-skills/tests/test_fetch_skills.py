"""Offline behavioural tests. All upstream data here is synthetic, not fetched skills."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('fetch_skills', ROOT / 'fetch_skills.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


def blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()


class FakeClient:
    def __init__(self, files, corrupt=None, truncated=False, mode=None):
        self.files = files
        self.corrupt = corrupt
        self.truncated = truncated
        self.mode = mode or {}
        self.requests = []

    def tree(self, source):
        self.requests.append(('tree', source['repo'], source['commit']))
        return {'truncated': self.truncated, 'tree': [
            {'path': p, 'type': 'blob', 'mode': self.mode.get(p, '100644'),
             'size': len(d), 'sha': blob(d)} for p, d in self.files.items()]}

    def raw(self, source, path):
        self.requests.append(('raw', source['repo'], path))
        return b'corrupted content' if path == self.corrupt else self.files[path]


def fixture():
    lic = b'MIT License\nCopyright fixture author\nPermission is hereby granted...\n'
    files = {
        'LICENSE': lic,
        'skills/example/SKILL.md': b'---\nname: example\ndescription: Fixture only.\n---\nRead [guide](references/guide.md).\n',
        'skills/example/references/guide.md': b'Fixture guide; no external code is run.\n',
        'skills/example/scripts/dont-run.py': b'raise RuntimeError("MUST NOT RUN")\n',
        'skills/not-requested/SKILL.md': b'Not requested.\n',
    }
    source = {'repo': 'fixture/upstream', 'commit': 'a'*40, 'scope': '',
              'license': 'MIT', 'license_path': 'LICENSE', 'license_blob_sha': blob(lic)}
    entries = [
        {'id': 'example', 'source': 'fixture', 'path': 'skills/example', 'status': 'ready', 'relation': 'upstream-refresh'},
        {'id': 'office-candidate', 'source': 'fixture', 'path': 'skills/candidate', 'status': 'candidate', 'relation': 'candidate-not-equivalent'},
        {'id': 'unresolved', 'status': 'unresolved', 'reason': 'No independently verified upstream.'},
    ]
    return {'schema_version': 1, 'expected_count': 3, 'sources': {'fixture': source}, 'skills': entries}, files


class FetchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.project = Path(self.tmp.name) / 'Firefly'
        self.project.mkdir()
        (self.project / 'package.json').write_text('{"name":"fixture"}')
        scanner = self.project / 'src/main/skills/skill-scanner.ts'
        scanner.parent.mkdir(parents=True)
        scanner.write_text('// synthetic project marker')
        self.original = self.project / 'vendor/firefly-skills/skills-snapshot.zip'
        self.original.parent.mkdir(parents=True)
        self.original.write_bytes(b'original snapshot: must not change')
        self.settings = self.project / 'skills-enabled.json'
        self.settings.write_text('{"example":true}')
        self.manifest, self.files = fixture()

    def run_fetch(self, client=None, **kwargs):
        return M.acquire(self.manifest, self.project, client or FakeClient(self.files), **kwargs)

    def test_fetches_verified_bytes_preserves_sources_and_never_executes_scripts(self):
        report, destination = self.run_fetch()
        self.assertEqual(report['counts']['downloaded'], 1)
        out = destination / 'sources/fixture/skills/example/SKILL.md'
        self.assertEqual(out.read_bytes(), self.files['skills/example/SKILL.md'])
        self.assertFalse((destination / 'sources/fixture/skills/not-requested').exists())
        self.assertEqual(self.original.read_bytes(), b'original snapshot: must not change')
        self.assertEqual(self.settings.read_text(), '{"example":true}')
        self.assertFalse(report['runtime_installed'])
        self.assertEqual(M.verify(destination), [])

    def test_blocked_and_candidate_rows_are_not_downloaded_by_default(self):
        c = FakeClient(self.files)
        report, _ = self.run_fetch(c)
        states = {s['id']: s['status'] for s in report['skills']}
        self.assertEqual(states['office-candidate'], 'candidate_not_selected')
        self.assertEqual(states['unresolved'], 'unresolved')
        self.assertFalse(any('candidate' in r[-1] for r in c.requests))
        self.assertFalse(report['complete'])

    def test_explicit_candidate_flag_stages_but_does_not_activate_it(self):
        self.files['skills/candidate/SKILL.md'] = b'---\nname: candidate\n---\nFixture.'
        report, _ = self.run_fetch(include_candidates=True)
        self.assertEqual(report['counts']['downloaded'], 2)
        self.assertFalse(report['runtime_installed'])
        self.assertEqual(report['counts']['unresolved'], 1)

    def test_corrupt_blob_cannot_be_published(self):
        report, dest = self.run_fetch(FakeClient(self.files, corrupt='skills/example/SKILL.md'))
        self.assertEqual(report['counts']['failed'], 1)
        self.assertFalse((dest / 'sources/fixture/skills/example').exists())

    def test_wrong_license_hash_blocks_package_before_skill_fetch(self):
        self.manifest['sources']['fixture']['license_blob_sha'] = '0'*40
        c = FakeClient(self.files)
        report, dest = self.run_fetch(c)
        self.assertEqual(report['counts']['failed'], 1)
        self.assertFalse(any(r[0] == 'raw' and 'SKILL.md' in r[-1] for r in c.requests))
        self.assertFalse((dest / 'sources/fixture/skills/example').exists())

    def test_nested_unreviewed_license_blocks_package(self):
        self.files['skills/example/LICENSE.txt'] = b'All rights reserved.'
        report, dest = self.run_fetch()
        self.assertEqual(report['counts']['failed'], 1)
        self.assertFalse((dest / 'sources/fixture/skills/example').exists())

    def test_truncated_tree_is_failure_not_partial_success(self):
        report, _ = self.run_fetch(FakeClient(self.files, truncated=True))
        self.assertEqual(report['counts']['failed'], 1)

    def test_explicitly_reviewed_nested_license_requires_its_exact_blob(self):
        license_path = 'skills/example/LICENSE.txt'
        self.files[license_path] = b'MIT License\nCopyright separately reviewed author\n'
        self.manifest['sources']['fixture']['reviewed_license_blobs'] = {license_path: blob(self.files[license_path])}
        report, dest = self.run_fetch()
        self.assertEqual(report['counts']['downloaded'], 1)
        self.assertEqual((dest / 'sources/fixture' / license_path).read_bytes(), self.files[license_path])
        self.files[license_path] = b'Unexpected different license'
        report, _ = self.run_fetch()
        self.assertEqual(report['counts']['failed'], 1)

    def test_symlink_blob_in_source_is_rejected(self):
        report, dest = self.run_fetch(FakeClient(self.files, mode={'skills/example/references/guide.md': '120000'}))
        self.assertEqual(report['counts']['failed'], 1)
        self.assertFalse((dest / 'sources/fixture/skills/example').exists())

    def test_missing_entry_is_not_reported_downloaded(self):
        del self.files['skills/example/SKILL.md']
        report, _ = self.run_fetch()
        self.assertEqual(report['counts']['failed'], 1)

    def test_project_vendor_symlink_cannot_escape_project(self):
        outside = Path(self.tmp.name) / 'outside'
        outside.mkdir()
        link = self.project / 'vendor/firefly-upstream'
        try:
            link.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest('Symlinks unavailable on this platform')
        with self.assertRaises(M.FetchError):
            self.run_fetch()
        self.assertEqual(list(outside.iterdir()), [])

    def test_tampered_download_is_detected_by_verification(self):
        _, dest = self.run_fetch()
        (dest / 'sources/fixture/skills/example/SKILL.md').write_text('tampered')
        self.assertTrue(any('hash' in e.lower() for e in M.verify(dest)))

    def test_extra_payload_file_is_detected(self):
        _, dest = self.run_fetch()
        (dest / 'sources/fixture/extra.txt').write_text('unexpected')
        self.assertTrue(any('unexpected' in e.lower() for e in M.verify(dest)))

    def test_second_run_uses_new_directory_and_preserves_first(self):
        _, a = self.run_fetch()
        before = (a / 'receipt.json').read_bytes()
        _, b = self.run_fetch()
        self.assertNotEqual(a, b)
        self.assertEqual((a / 'receipt.json').read_bytes(), before)

    def test_missing_project_marker_fails_without_writes(self):
        (self.project / 'src/main/skills/skill-scanner.ts').unlink()
        with self.assertRaises(M.FetchError):
            self.run_fetch()
        self.assertFalse((self.project / 'vendor/firefly-upstream').exists())

    def test_manifest_rejects_floating_ref_duplicate_and_escaping_path(self):
        for change in ('floating', 'duplicate', 'path', 'repository', 'unknown_status'):
            m = copy.deepcopy(self.manifest)
            if change == 'floating': m['sources']['fixture']['commit'] = 'main'
            elif change == 'duplicate': m['skills'][1]['id'] = 'example'
            elif change == 'path': m['skills'][0]['path'] = '../outside'
            elif change == 'repository': m['sources']['fixture']['repo'] = 'https://evil.invalid/repo'
            else: m['skills'][0]['status'] = 'approved-trust-me'
            with self.subTest(change=change), self.assertRaises(M.FetchError):
                M.validate_manifest(m)

    def test_windows_paths_and_reserved_names_are_rejected(self):
        for p in ('../escape','/absolute','C:/escape','skills/CON/file','skills/hello.','skills/x:y','skills/a\\b','skills//double','skills/./dot'):
            with self.subTest(p=p), self.assertRaises(M.FetchError):
                M.safe_relative(p)


    def test_network_token_goes_to_api_only_never_to_raw_host(self):
        class Response:
            headers = {}
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return b'content'
        class Opener:
            def __init__(self): self.seen = []
            def open(self, req, timeout):
                self.seen.append(req)
                return Response()
        client = M.GitHubClient('synthetic-test-token')
        client.opener = Opener()
        client.get('https://api.github.com/repos/fixture/upstream', 100)
        client.get('https://raw.githubusercontent.com/fixture/upstream/a/SKILL.md', 100)
        self.assertTrue(client.opener.seen[0].get_header('Authorization'))
        self.assertIsNone(client.opener.seen[1].get_header('Authorization'))

    def test_network_rejects_unapproved_host_without_opening_connection(self):
        client = M.GitHubClient('synthetic-test-token')
        with self.assertRaises(M.FetchError):
            client.get('https://not-github.invalid/collect', 100)

    def test_redirect_is_not_followed(self):
        with self.assertRaises(M.FetchError):
            M.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://not-github.invalid/')

    def test_download_size_limit_is_enforced(self):
        class Response:
            headers = {}
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return b'x' * limit
        class Opener:
            def open(self, req, timeout): return Response()
        client = M.GitHubClient()
        client.opener = Opener()
        with self.assertRaises(M.FetchError):
            client.get('https://raw.githubusercontent.com/fixture/upstream/a/file', 10)

    def test_http_403_is_not_retried_or_bypassed(self):
        from urllib.error import HTTPError
        class Opener:
            calls = 0
            def open(self, req, timeout):
                self.calls += 1
                raise HTTPError(req.full_url, 403, 'Forbidden', {}, None)
        client = M.GitHubClient()
        client.opener = Opener()
        with self.assertRaises(M.FetchError):
            client.get('https://api.github.com/repos/fixture/upstream', 100)
        self.assertEqual(client.opener.calls, 1)


    def test_git_lfs_pointer_is_not_reported_as_complete_asset(self):
        self.files['skills/example/assets/template.bin'] = b'version https://git-lfs.github.com/spec/v1\noid sha256:0000\nsize 4000\n'
        report, dest = self.run_fetch()
        self.assertEqual(report['counts']['failed'], 1)
        self.assertFalse((dest / 'sources/fixture/skills/example').exists())

    def test_case_collisions_fail_before_package_write(self):
        self.files['skills/example/readme.md'] = b'first'
        self.files['skills/example/README.md'] = b'second'
        report, dest = self.run_fetch()
        self.assertEqual(report['counts']['failed'], 1)
        self.assertFalse((dest / 'sources/fixture/skills/example').exists())

    def test_actual_catalog_covers_37_unique_ids_with_optional_candidates(self):
        path = ROOT / 'sources.json'
        if not path.exists():
            self.fail('The actual source catalog is not implemented')
        m = json.loads(path.read_text())
        M.validate_manifest(m)
        self.assertEqual(len(m['skills']), 37)
        self.assertEqual(sum(s['status'] == 'ready' for s in m['skills']), 35)
        self.assertEqual(sum(s['status'] == 'candidate' for s in m['skills']), 2)
        self.assertEqual(sum(s['status'] == 'unresolved' for s in m['skills']), 0)


if __name__ == '__main__':
    unittest.main()

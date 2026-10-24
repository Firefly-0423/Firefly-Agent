#!/usr/bin/env python3
"""Fetch pinned, individually selected upstream skill source into a NEW staging dir.

Python 3.10+, standard library only. Does not install/execute skills, hooks or tools.
No access to existing snapshots, user skill folders, enabled state or main branch.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile
import time
from typing import Any
from urllib import error, parse, request
import uuid

MAX_FILE = 8 * 1024 * 1024
MAX_TREE = 32 * 1024 * 1024
MAX_SKILL = 64 * 1024 * 1024
MAX_FILES = 4000
NAME = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')
HEX40 = re.compile(r'^[0-9a-f]{40}$')
REPO = re.compile(r'^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')
LICENSE_NAMES = {'license', 'license.txt', 'license.md', 'licence', 'licence.txt',
                 'licence.md', 'copying', 'copying.txt', 'copyright', 'copyright.txt'}
NOTICE_NAMES = {'notice', 'notice.txt', 'notice.md', 'credits.md', 'third_party_notices.md'}
RESERVED = {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(1, 10)),
            *(f'LPT{i}' for i in range(1, 10))}


class FetchError(Exception):
    """A controlled acquisition, evidence, or filesystem boundary failure."""


def safe_relative(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or '\\' in value:
        raise FetchError('Unsafe relative path')
    pieces = value.split('/')
    if any(p in ('', '.', '..') or p.endswith(('.', ' ')) or
           p.split('.')[0].upper() in RESERVED or
           any(ord(c) < 32 or c in '<>:"|?*' for c in p) for p in pieces):
        raise FetchError(f'Unsafe relative path: {value!r}')
    return PurePosixPath(value)


def in_scope(path: str, prefix: str) -> bool:
    return not prefix or path == prefix or path.startswith(prefix + '/')


def git_blob_sha(data: bytes) -> str:
    return hashlib.sha1(b'blob ' + str(len(data)).encode('ascii') + b'\0' + data).hexdigest()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def validate_manifest(manifest: dict[str, Any]) -> None:
    if manifest.get('schema_version') != 1:
        raise FetchError('Unsupported catalog schema')
    entries = manifest.get('skills')
    sources = manifest.get('sources')
    if not isinstance(entries, list) or not isinstance(sources, dict):
        raise FetchError('Catalog must contain skills and sources')
    if len(entries) != manifest.get('expected_count'):
        raise FetchError('Catalog count does not match expected_count')
    seen = set()
    for key, source in sources.items():
        if not NAME.fullmatch(key) or not REPO.fullmatch(source.get('repo', '')):
            raise FetchError('Invalid source key or owner/repository')
        if not HEX40.fullmatch(source.get('commit', '')):
            raise FetchError('An immutable 40-character commit SHA is required')
        if not HEX40.fullmatch(source.get('license_blob_sha', '')):
            raise FetchError('An audited license Git blob SHA is required')
        if source.get('license') not in ('MIT', 'Apache-2.0'):
            raise FetchError('Source license needs explicit manual review')
        scope = source.get('scope', '')
        if scope:
            safe_relative(scope)
        safe_relative(source.get('license_path', ''))
        if not in_scope(source['license_path'], scope):
            raise FetchError('License lies outside its declared scope')
        reviewed = source.get('reviewed_license_blobs', {})
        if not isinstance(reviewed, dict):
            raise FetchError('Reviewed license hashes must be a mapping')
        for license_path, license_hash in reviewed.items():
            safe_relative(license_path)
            if not in_scope(license_path, scope) or not HEX40.fullmatch(license_hash):
                raise FetchError('Invalid reviewed license scope/hash')
    for entry in entries:
        id_ = entry.get('id', '')
        if not NAME.fullmatch(id_) or id_ in seen:
            raise FetchError('Invalid or duplicate skill ID')
        seen.add(id_)
        state = entry.get('status')
        if state not in ('ready', 'candidate', 'unresolved'):
            raise FetchError('Unknown catalog status')
        if state == 'unresolved':
            if not entry.get('reason'):
                raise FetchError('Unresolved entry needs a reason')
            continue
        if entry.get('source') not in sources:
            raise FetchError('Unknown source key')
        safe_relative(entry.get('path', ''))
        if not in_scope(entry['path'], sources[entry['source']].get('scope', '')):
            raise FetchError('Skill path outside reviewed source scope')


class NoRedirect(request.HTTPRedirectHandler):
    # Never forward an optional API token to another endpoint or owner via redirect.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise FetchError(f'Unexpected HTTP redirect ({code}); review the pinned source')


class GitHubClient:
    def __init__(self, token: str | None = None):
        self.token = token
        self.opener = request.build_opener(NoRedirect())

    def get(self, url: str, limit: int) -> bytes:
        host = parse.urlsplit(url).hostname
        if host not in ('api.github.com', 'raw.githubusercontent.com') or not url.startswith('https://'):
            raise FetchError('Unapproved download host')
        headers = {'User-Agent': 'Firefly-Upstream-Fetch/1.0', 'Accept': 'application/vnd.github+json'}
        if host == 'api.github.com' and self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        for attempt in range(3):
            try:
                with self.opener.open(request.Request(url, headers=headers), timeout=25) as response:
                    length = response.headers.get('Content-Length')
                    if length and int(length) > limit:
                        raise FetchError('Response exceeds download limit')
                    data = response.read(limit + 1)
                    if len(data) > limit:
                        raise FetchError('Response exceeds download limit')
                    return data
            except error.HTTPError as exc:
                if exc.code in (429, 500, 502, 503, 504) and attempt < 2:
                    time.sleep(1 + attempt)
                    continue
                if exc.code == 403:
                    raise FetchError('HTTP 403: GitHub permission/rate limit; no bypass attempted') from None
                raise FetchError(f'HTTP {exc.code} from {host}') from None
            except (error.URLError, TimeoutError, OSError) as exc:
                if attempt < 2:
                    time.sleep(1 + attempt)
                    continue
                raise FetchError(f'Network request failed at {host}: {type(exc).__name__}') from None
        raise FetchError('Download attempts exhausted')

    def tree(self, source: dict[str, Any]) -> dict[str, Any]:
        url = f"https://api.github.com/repos/{source['repo']}/git/trees/{source['commit']}?recursive=1"
        try:
            result = json.loads(self.get(url, MAX_TREE))
        except (ValueError, UnicodeError):
            raise FetchError('GitHub returned an invalid tree document') from None
        if not isinstance(result, dict):
            raise FetchError('GitHub tree is not an object')
        return result

    def raw(self, source: dict[str, Any], path: str) -> bytes:
        safe_relative(path)
        url = f"https://raw.githubusercontent.com/{source['repo']}/{source['commit']}/{parse.quote(path, safe='/')}"
        return self.get(url, MAX_FILE)


def is_link_or_reparse(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(metadata.st_mode) or bool(getattr(metadata, 'st_file_attributes', 0) & 0x400)


def ensure_stage_parent(project: Path) -> Path:
    project = project.resolve(strict=True)
    for marker in ('package.json', 'src/main/skills/skill-scanner.ts'):
        if not (project / marker).is_file():
            raise FetchError(f'Not a recognized Firefly project: missing {marker}')
    current = project
    for part in ('vendor', 'firefly-upstream'):
        current = current / part
        if is_link_or_reparse(current):
            raise FetchError('Staging parent is a symlink/junction/reparse point')
        if current.exists() and not current.is_dir():
            raise FetchError('Staging parent exists but is not a directory')
        current.mkdir(exist_ok=True)
        if is_link_or_reparse(current) or not current.resolve().is_relative_to(project):
            raise FetchError('Staging directory escapes project')
    return current


def validate_node(node: dict[str, Any]) -> None:
    safe_relative(node['path'])
    if node.get('type') != 'blob' or node.get('mode') not in ('100644', '100755'):
        raise FetchError(f"Unsupported source entry type/mode: {node['path']}")
    if not HEX40.fullmatch(node.get('sha', '')):
        raise FetchError('Missing Git blob hash')
    size = node.get('size')
    if not isinstance(size, int) or size < 0 or size > MAX_FILE:
        raise FetchError(f"Invalid/oversized file: {node['path']}")


def check_bytes(node: dict[str, Any], data: bytes) -> None:
    if len(data) != node['size'] or git_blob_sha(data) != node['sha']:
        raise FetchError(f"Git blob hash/length mismatch: {node['path']}")


def get_source_tree(client, source):
    tree = client.tree(source)
    if tree.get('truncated') is not False or not isinstance(tree.get('tree'), list):
        raise FetchError('Truncated or malformed Git tree; no partial tree accepted')
    entries = {}
    for node in tree['tree']:
        if not isinstance(node, dict) or not isinstance(node.get('path'), str):
            raise FetchError('Malformed Git tree entry')
        if node['path'] in entries:
            raise FetchError('Duplicate Git tree path')
        entries[node['path']] = node
    license_path = source['license_path']
    node = entries.get(license_path)
    if not node:
        raise FetchError('Reviewed license file is missing')
    validate_node(node)
    if node['sha'] != source['license_blob_sha']:
        raise FetchError('License hash changed or does not match pinned evidence')
    data = client.raw(source, license_path)
    check_bytes(node, data)
    return entries, {license_path: data}


def select_package(entry, source, tree):
    prefix = entry['path']
    paths = {p for p, n in tree.items() if in_scope(p, prefix) and n.get('type') != 'tree'}
    if prefix + '/SKILL.md' not in paths:
        raise FetchError('Requested upstream SKILL.md is missing')
    paths.add(source['license_path'])
    # Carry copyright notices at each ancestor, without assuming a root license
    # overrides a more specific license. Unknown nested license hashes fail closed.
    ancestors = set()
    p = PurePosixPath(prefix)
    while str(p) != '.':
        ancestors.add(str(p))
        p = p.parent
    ancestors.add('')
    for path in tree:
        parent = str(PurePosixPath(path).parent)
        parent = '' if parent == '.' else parent
        name = PurePosixPath(path).name.lower()
        if parent in ancestors and in_scope(path, source.get('scope', '')) and name in LICENSE_NAMES | NOTICE_NAMES:
            paths.add(path)
    seen = set()
    for path in sorted(paths):
        node = tree[path]
        validate_node(node)
        folded = path.casefold()
        if folded in seen:
            raise FetchError('Case-colliding filenames cannot be staged safely on Windows')
        seen.add(folded)
        approved_license_hash = source.get('reviewed_license_blobs', {}).get(path, source['license_blob_sha'])
        if PurePosixPath(path).name.lower() in LICENSE_NAMES and node['sha'] != approved_license_hash:
            raise FetchError(f'Unreviewed nested/ancestor license: {path}')
    if len(paths) > MAX_FILES or sum(tree[p]['size'] for p in paths) > MAX_SKILL:
        raise FetchError('Skill source exceeds size/file-count limits')
    return sorted(paths)


def save_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def find_relative_link_gaps(source_root: Path) -> list[dict[str, str]]:
    """Best-effort Markdown link audit, not a parser or behaviour/dependency proof."""
    issues = []
    for md in sorted(source_root.rglob('*.md')):
        text = md.read_text(encoding='utf-8', errors='replace')
        for match in re.finditer(r'(?<!!)\[[^\]\n]*\]\(([^)\n]+)\)', text):
            raw = match.group(1).strip().split(' "')[0].strip('<>')
            target = parse.unquote(raw.split('#', 1)[0].split('?', 1)[0])
            try:
                external = bool(parse.urlsplit(target).scheme)
            except ValueError:
                issues.append({'file': md.relative_to(source_root).as_posix(), 'target': raw, 'issue': 'unparseable link'})
                continue
            if not target or external or target.startswith('//'):
                continue
            resolved = (md.parent / target).resolve()
            if not resolved.is_relative_to(source_root.resolve()) or not resolved.exists():
                issues.append({'file': md.relative_to(source_root).as_posix(), 'target': raw})
    return issues


def acquire(manifest: dict[str, Any], project: Path, client=None, *, include_candidates=False):
    validate_manifest(manifest)
    client = client or GitHubClient(os.environ.get('GITHUB_TOKEN'))
    parent = ensure_stage_parent(Path(project))
    work = Path(tempfile.mkdtemp(prefix='.fetch-', dir=parent))
    report = {'schema_version': 1, 'created_utc': datetime.now(timezone.utc).isoformat(),
              'catalog_count': len(manifest['skills']), 'runtime_installed': False,
              'hooks_executed': False, 'model_behaviour_tested': False,
              'skills': [], 'files': [], 'sources': manifest['sources'],
              'notes': ['Source acquisition only. No adaptation, automatic registration, settings changes or permission grants.',
                        'A clean hash audit proves byte integrity, not licence completeness, security or runtime compatibility.']}
    source_cache = {}
    source_errors = {}
    file_records = {}
    try:
        for entry in manifest['skills']:
            row = {'id': entry['id'], 'catalog_status': entry['status'],
                   'relation': entry.get('relation'), 'reason': entry.get('reason', entry.get('note'))}
            report['skills'].append(row)
            if entry['status'] == 'unresolved':
                row['status'] = 'unresolved'
                continue
            if entry['status'] == 'candidate' and not include_candidates:
                row['status'] = 'candidate_not_selected'
                continue
            key = entry['source']
            source = manifest['sources'][key]
            row.update({'source': key, 'upstream_path': entry['path'],
                        'commit': source['commit'], 'upstream_name': entry.get('upstream_name')})
            try:
                if key in source_errors:
                    raise FetchError(source_errors[key])
                if key not in source_cache:
                    try:
                        source_cache[key] = get_source_tree(client, source)
                    except (FetchError, OSError, ValueError) as exc:
                        source_errors[key] = str(exc)
                        raise
                tree, cache = source_cache[key]
                paths = select_package(entry, source, tree)
                # All bytes for this skill must verify before any package payload is written.
                payload = {}
                for path in paths:
                    data = cache.get(path)
                    if data is None:
                        data = client.raw(source, path)
                    check_bytes(tree[path], data)
                    if data.startswith(b'version https://git-lfs.github.com/spec/v1'):
                        raise FetchError('Git LFS pointer needs separate asset retrieval: ' + path)
                    cache[path] = data
                    payload[path] = data
                for path, data in payload.items():
                    relative = f'sources/{key}/{path}'
                    destination = work / Path(*safe_relative(relative).parts)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    if not destination.exists():
                        destination.write_bytes(data)
                    elif destination.read_bytes() != data:
                        raise FetchError('Conflicting source bytes in staging')
                    file_records[relative] = {'path': relative, 'bytes': len(data),
                                              'sha256': sha256(data), 'git_blob_sha': tree[path]['sha'],
                                              'source_mode': tree[path]['mode']}
                row.update({'status': 'downloaded', 'file_count': len(paths),
                            'staged_entry': f"sources/{key}/{entry['path']}/SKILL.md"})
            except (FetchError, OSError, ValueError) as exc:
                row.update({'status': 'failed', 'error': str(exc)})
        counts = Counter(s['status'] for s in report['skills'])
        report['counts'] = {k: counts[k] for k in ('downloaded', 'failed', 'unresolved', 'candidate_not_selected')}
        report['complete'] = counts['downloaded'] == len(manifest['skills'])
        report['files'] = sorted(file_records.values(), key=lambda f: f['path'])
        report['relative_markdown_link_gaps'] = find_relative_link_gaps(work / 'sources') if (work / 'sources').exists() else []
        save_json(work / 'catalog.json', manifest)
        report['catalog_sha256'] = sha256((work / 'catalog.json').read_bytes())
        save_json(work / 'receipt.json', report)
        (work / 'NOT_INSTALLED.txt').write_text(
            'Upstream sources only. Nothing has been registered in Firefly or enabled.\n'
            'Read receipt.json for individual failures, missing sources and link gaps.\n', encoding='utf-8')
        final = parent / ('staging-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:12])
        if final.exists():
            raise FetchError('New staging directory unexpectedly exists')
        work.rename(final)
        return report, final
    except BaseException:
        # Remove only our private, randomly created temporary directory.
        shutil.rmtree(work, ignore_errors=True)
        raise


def verify(directory: Path) -> list[str]:
    directory = Path(directory).resolve(strict=True)
    errors = []
    try:
        receipt = json.loads((directory / 'receipt.json').read_text(encoding='utf-8'))
        catalog = directory / 'catalog.json'
        if sha256(catalog.read_bytes()) != receipt['catalog_sha256']:
            errors.append('Catalog hash mismatch')
        expected = {}
        for record in receipt['files']:
            relative = record['path']
            safe_relative(relative)
            if not relative.startswith('sources/') or relative in expected:
                raise FetchError('Invalid/duplicate receipt payload path')
            expected[relative] = record
            file = directory / Path(*PurePosixPath(relative).parts)
            if is_link_or_reparse(file) or not file.resolve().is_relative_to(directory) or not file.is_file():
                errors.append('Missing or unsafe file: ' + relative)
                continue
            data = file.read_bytes()
            if len(data) != record['bytes'] or sha256(data) != record['sha256'] or git_blob_sha(data) != record['git_blob_sha']:
                errors.append('File hash mismatch: ' + relative)
        payload_root = directory / 'sources'
        if payload_root.exists():
            for file in payload_root.rglob('*'):
                if is_link_or_reparse(file):
                    errors.append('Unexpected symlink/reparse point: ' + file.relative_to(directory).as_posix())
                elif file.is_file() and file.relative_to(directory).as_posix() not in expected:
                    errors.append('Unexpected payload file: ' + file.relative_to(directory).as_posix())
        # Receipt is a local integrity record, not a signed authenticity statement.
        return errors
    except (OSError, ValueError, KeyError, TypeError, FetchError) as exc:
        return ['Invalid verification record: ' + str(exc)]


def load_catalog(path: Path):
    try:
        catalog = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise FetchError('Cannot read source catalog: ' + str(exc)) from None
    validate_manifest(catalog)
    return catalog


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, help='Existing Firefly repository root (required with --fetch)')
    parser.add_argument('--fetch', action='store_true', help='Download to a NEW vendor/firefly-upstream/staging-* directory')
    parser.add_argument('--plan', action='store_true', help='Print source plan without network or writes (default)')
    parser.add_argument('--include-office-candidates', action='store_true', help='Also STAGE MiniMax PDF/XLSX candidates; does not activate them')
    parser.add_argument('--verify', type=Path, help='Offline byte-integrity verification of a completed staging directory')
    args = parser.parse_args(argv)
    try:
        if args.verify:
            if args.fetch or args.project or args.plan or args.include_office_candidates:
                raise FetchError('--verify cannot be combined with acquisition options')
            errors = verify(args.verify)
            print(json.dumps({'integrity_ok': not errors, 'errors': errors, 'runtime_tested': False}, ensure_ascii=False, indent=2))
            return 1 if errors else 0
        if args.plan and args.fetch:
            raise FetchError('Choose --plan or --fetch, not both')
        catalog = load_catalog(Path(__file__).with_name('sources.json'))
        if not args.fetch:
            for item in catalog['skills']:
                source = catalog['sources'].get(item.get('source', ''), {})
                print(f"{item['id']:<40} {item['status']:<10} {source.get('repo', '-')} {item.get('path', '')}")
            counts = Counter(item['status'] for item in catalog['skills'])
            print(f"No network requests or project writes. {len(catalog['skills'])} catalog entries; {counts['ready']} ready, {counts['candidate']} optional office candidates, {counts['unresolved']} unresolved.")
            return 0
        if args.project is None:
            raise FetchError('--project is required; implicit user/global installation is not supported')
        report, destination = acquire(catalog, args.project, include_candidates=args.include_office_candidates)
        print(json.dumps({'staging_directory': str(destination), 'counts': report['counts'],
                          'all_catalog_entries_acquired': report['complete'], 'runtime_installed': False,
                          'relative_link_gaps': len(report['relative_markdown_link_gaps'])}, ensure_ascii=False, indent=2))
        # Nonzero intentionally: downloaded candidates are not a completed Skill installation.
        return 1 if report['counts']['failed'] else (0 if report['complete'] else 2)
    except (FetchError, OSError) as exc:
        print('ERROR: ' + str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

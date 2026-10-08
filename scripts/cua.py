#!/usr/bin/env python3
"""Prepare and compile Eido's pinned Cua Driver source adaptation offline."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / '.local'
CHECKOUT = LOCAL / 'upstream/cua'
MANIFEST = ROOT / 'native/cua/upstream.json'
OVERLAY = ROOT / 'native/cua/overlay'
RECORD = LOCAL / 'cua-build.json'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inputs():
    manifest = json.loads(MANIFEST.read_text())
    if not (CHECKOUT / '.git').exists():
        raise RuntimeError('Cua source is missing. Clone https://github.com/trycua/cua.git at the tag in native/cua/upstream.json into .local/upstream/cua.')
    revision = subprocess.check_output(['git', '-C', CHECKOUT, 'rev-parse', 'HEAD'], text=True).strip()
    if revision != manifest['commit']:
        raise RuntimeError('Cua checkout does not match native/cua/upstream.json')
    files = {}
    for path in sorted(OVERLAY.rglob('*')):
        if path.is_symlink():
            raise RuntimeError('Cua source links are not supported')
        if path.is_file():
            files[path.relative_to(OVERLAY).as_posix()] = digest(path)
    return manifest, files


def prepare():
    manifest, files = inputs()
    workspace = CHECKOUT / manifest['workspace']
    state_file = LOCAL / 'cua-applied.json'
    previous = json.loads(state_file.read_text()) if state_file.exists() else {}
    # Refuse unrelated edits rather than resetting the developer's checkout.
    changes = subprocess.check_output(['git', '-C', CHECKOUT, 'diff', '--name-only', 'HEAD'], text=True).splitlines()
    unknown = subprocess.check_output(['git', '-C', CHECKOUT, 'ls-files', '--others', '--exclude-standard'], text=True).splitlines()
    allowed = {manifest['workspace'] + '/' + name for name in files}
    if set(changes + unknown) - allowed:
        raise RuntimeError('Cua checkout contains changes outside the maintained source overlay')
    for name, expected in files.items():
        destination = workspace / name
        baseline = subprocess.run(['git', '-C', CHECKOUT, 'show', manifest['commit'] + ':' + manifest['workspace'] + '/' + name], capture_output=True)
        permitted = {expected, previous.get(name)}
        if baseline.returncode == 0:
            permitted.add(hashlib.sha256(baseline.stdout).hexdigest())
        if destination.exists() and digest(destination) not in permitted:
            raise RuntimeError('Unpreserved Cua source edits: ' + name)
    for name in files:
        destination = workspace / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(OVERLAY / name, destination)
    state_file.write_text(json.dumps(files, indent=2))


def fingerprint():
    manifest, files = inputs()
    workspace = CHECKOUT / manifest['workspace']
    if any(not (workspace / name).is_file() or digest(workspace / name) != expected for name, expected in files.items()):
        raise RuntimeError('Cua source differs from the overlay; run npm run cua:prepare')
    # Include the lockfile and all tracked workspace/build inputs, not just edits.
    names = subprocess.check_output(['git', '-C', CHECKOUT, 'ls-files', manifest['workspace']], text=True).splitlines()
    baseline = {name: digest(CHECKOUT / name) for name in names if (CHECKOUT / name).is_file()}
    return hashlib.sha256(json.dumps({'manifest': digest(MANIFEST), 'files': files, 'workspace': baseline}, sort_keys=True).encode()).hexdigest()


def verified_binary():
    binary = LOCAL / 'cua-target/debug/cua-driver'
    record = json.loads(RECORD.read_text())
    if record['sourceFingerprint'] != fingerprint() or record['binarySha256'] != digest(binary):
        raise RuntimeError('No verified Cua build for current source; run npm run cua:build')
    return binary


def main():
    command = argparse.ArgumentParser()
    command.add_argument('operation', choices=['prepare', 'build', 'test'])
    operation = command.parse_args().operation
    prepare()
    if operation == 'prepare':
        return
    spec = importlib.util.spec_from_file_location('eido_native', ROOT / 'scripts/native.py')
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    env = native.environment()
    env['CARGO_TARGET_DIR'] = str(LOCAL / 'cua-target')
    env['CARGO_NET_OFFLINE'] = 'true'
    manifest = json.loads(MANIFEST.read_text())
    args = ['cargo', 'test' if operation == 'test' else 'build', '--offline', '--locked']
    args += ['-p', 'cua-driver-core', '-p', 'platform-macos'] if operation == 'test' else ['-p', 'cua-driver']
    expected = fingerprint()
    subprocess.run(args, cwd=CHECKOUT / manifest['workspace'], env=env, check=True)
    if operation == 'build':
        if fingerprint() != expected:
            raise RuntimeError('Cua source changed during compilation')
        RECORD.write_text(json.dumps({'sourceFingerprint': expected, 'binarySha256': digest(LOCAL / 'cua-target/debug/cua-driver'), 'upstream': manifest}, indent=2))


if __name__ == '__main__':
    main()

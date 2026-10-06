#!/usr/bin/env python3
"""Build an offline, self-contained macOS preview from verified product outputs.

Only this build tool sees the checkout. Its own code, tests, development tools,
credentials and private documentation are never installed in the application.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
SCRIPT_NAMES = (
    'browser-config.mjs', 'browser-server.mjs', 'pi-component-terminal.mjs',
    'pi-extensions.mjs', 'pi-http-settings.mjs', 'pi-mcp-auth.mjs',
    'pi-mcp-status.mjs', 'pi-mcp.mjs', 'pi-runtime-settings.mjs',
    'pi-settings.mjs', 'preview-server.mjs', 'project-command.mjs',
    'project-preview.mjs', 'runtime-paths.mjs',
)
EXCLUDED = {'test', 'tests', '__tests__', '__mocks__', 'fixtures', '__fixtures__',
            'examples', 'example', 'bench', 'benchmark', 'benchmarks', 'coverage',
            '.git', '.github', '.local', 'local-docs', 'test-results'}
LEGAL = re.compile(r'^(licen[cs]e|copying|copyright|notice|authors|third[-_]?party)', re.I)
TEST_FILE = re.compile(r'(^|[._-])(test|spec|fixture)([._-]|$)', re.I)


def run(args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def copy_file(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def digest(file):
    value = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def dependency_filter(path):
    if any(part in EXCLUDED for part in path.parts) or TEST_FILE.search(path.name):
        return False
    if LEGAL.match(path.name):
        return True
    if path.name == '.manifest.json' and 'pi-ai' in path.parts and 'providers' in path.parts:
        return True
    if path.name.startswith('.') or path.suffix in {'.map', '.ts', '.mts', '.cts', '.py', '.rs', '.cc', '.cpp', '.h'}:
        return False
    if path.suffix.lower() in {'.md', '.markdown'}:
        # pi reads these public documents for /changelog and extension help.
        return '@earendil-works' in path.parts and 'pi-coding-agent' in path.parts and ('docs' in path.parts or path.name in {'README.md', 'CHANGELOG.md'})
    return True


def copy_tree(source, target, accept=lambda path: True, prefix=Path(), skip_modules=False):
    for current, directories, files in os.walk(source, followlinks=False):
        relative = Path(current).relative_to(source)
        directories[:] = [name for name in directories if name not in EXCLUDED and not name.startswith('.')
                          and not (skip_modules and name == 'node_modules')]
        for name in files:
            local = relative / name
            if not accept(prefix / local):
                continue
            file = source / local
            if file.is_symlink():
                resolved = file.resolve()
                if not resolved.is_relative_to(source.resolve()):
                    raise RuntimeError(f'Dependency symlink escapes its package: {file}')
            copy_file(file, target / local)


def copy_dependencies(source, target):
    lock = json.loads((source / 'package-lock.json').read_text())
    count = 0
    for path, entry in sorted(lock['packages'].items()):
        if not path or entry.get('dev') or not path.startswith('node_modules/'):
            continue
        package = source / path
        if not package.exists():
            if entry.get('optional'):
                continue
            raise RuntimeError(f'Missing production dependency: {package}')
        if package.is_symlink():
            raise RuntimeError(f'Linked production dependency is not reproducible: {package}')
        copy_tree(package, target / path, dependency_filter, Path(path), skip_modules=True)
        count += 1
    # Recreate only bins whose production package and target survived filtering.
    for package_file in target.glob('node_modules/**/package.json'):
        package = json.loads(package_file.read_text())
        bins = package.get('bin', {})
        if isinstance(bins, str):
            bins = {package['name'].split('/')[-1]: bins}
        parent = package_file.parent
        modules = next((p for p in parent.parents if p.name == 'node_modules'), None)
        if modules is None:
            continue
        for name, file in bins.items():
            if '/' in name or name in {'.', '..'}:
                raise RuntimeError('Invalid package executable name')
            executable = parent / file
            if executable.is_file():
                link = modules / '.bin' / name
                link.parent.mkdir(exist_ok=True)
                if not link.exists():
                    link.symlink_to(os.path.relpath(executable, link.parent))
                    executable.chmod(executable.stat().st_mode | 0o111)
    return count


def audit(bundle):
    files = []
    runtime = bundle / 'Contents/Resources/runtime'
    for file in sorted(bundle.rglob('*')):
        if file.is_dir():
            continue
        local = file.relative_to(bundle)
        if any(part in EXCLUDED for part in local.parts) or TEST_FILE.search(file.name):
            raise RuntimeError(f'Non-production file in application: {local}')
        if file.is_symlink():
            if not file.resolve().is_relative_to(bundle.resolve()) or not file.exists():
                raise RuntimeError(f'Invalid application symlink: {local}')
            continue
        if file.suffix in {'.ts', '.mts', '.cts', '.map', '.py', '.rs'}:
            raise RuntimeError(f'Development source in application: {local}')
        if file.is_relative_to(runtime / 'scripts') and file.name not in SCRIPT_NAMES:
            raise RuntimeError(f'Unlisted runtime script: {local}')
        if file.is_relative_to(runtime) and file.suffix in {'.js', '.mjs', '.cjs'}:
            text = file.read_text(errors='replace')
            if str(ROOT) in text:
                raise RuntimeError(f'Checkout path in runtime: {local}')
        files.append({'path': str(local), 'bytes': file.stat().st_size,
                      'sha256': digest(file)})
    return files


def build():
    spec = importlib.util.spec_from_file_location('eido_native', ROOT / 'scripts/native.py')
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    record = json.loads((ROOT / '.local/native-build.json').read_text())
    executable = ROOT / '.local/native-target/debug/eido'
    if record['sourceFingerprint'] != native.source_fingerprint() or record['binarySha256'] != native.digest(executable):
        raise RuntimeError('Build the current native product with npm run native:build first')
    stage = ROOT / '.local/package-stage'
    if stage.exists():
        shutil.rmtree(stage)
    bundle = stage / 'Eido.app'
    contents = bundle / 'Contents'
    resources = contents / 'Resources'
    runtime = resources / 'runtime'
    runtime.mkdir(parents=True)
    node = Path(shutil.which('node')).resolve()
    # Refuse a runtime that depends on a developer's Homebrew/local libraries.
    for library in subprocess.check_output(['otool', '-L', node], text=True).splitlines()[1:]:
        path = library.strip().split(' (')[0]
        if not path.startswith(('/usr/lib/', '/System/Library/')):
            raise RuntimeError(f'Node has a non-system dynamic dependency: {path}')
    run([node, ROOT / 'node_modules/typescript/bin/tsc', '-p', ROOT / 'tsconfig.runtime.json', '--outDir', runtime], cwd=ROOT)
    copy_file(ROOT / 'packages/acp/package.json', runtime / 'packages/acp/package.json')
    (runtime / 'package.json').write_text(json.dumps({'name': 'eido-runtime', 'private': True, 'type': 'module'}))
    for name in SCRIPT_NAMES:
        copy_file(ROOT / 'scripts' / name, runtime / 'scripts' / name)
    count = copy_dependencies(ROOT, runtime) + copy_dependencies(ROOT / 'packages/acp', runtime / 'packages/acp')
    copy_file(ROOT / 'native/appearance.json', runtime / 'native/appearance.json')
    copy_file(node, contents / 'Helpers/node')
    npm = Path(shutil.which('npm')).resolve().parent.parent
    if json.loads((npm / 'package.json').read_text())['name'] != 'npm':
        raise RuntimeError('Cannot locate installed npm runtime')
    copy_tree(npm, resources / 'npm', dependency_filter)
    for name in ('npm', 'npx'):
        wrapper = contents / 'Helpers' / name
        wrapper.write_text('#!/bin/sh\nHERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$HERE/node" "$HERE/../Resources/npm/bin/' + name + '-cli.js" "$@"\n')
        wrapper.chmod(0o755)
    source = ROOT / '.local/upstream/zed'
    for directory in ('fonts', 'icons', 'images', 'themes', 'sounds', 'prompts', 'settings', 'keymaps'):
        copy_tree(source / 'assets' / directory, resources / 'editor/assets' / directory,
                  lambda path: 'src' not in path.parts and path.name != '.DS_Store')
    copy_tree(source / 'crates/grammars/src', resources / 'editor/crates/grammars/src', lambda p: p.suffix in {'.scm', '.toml', '.json'})
    copy_tree(source / 'crates/agent/src/templates', resources / 'editor/crates/agent/src/templates', lambda p: p.suffix == '.hbs')
    browsers = ROOT / '.local/browsers'
    revisions = json.loads((runtime / 'node_modules/playwright-core/browsers.json').read_text())['browsers']
    for browser in revisions:
        if browser['name'] not in {'chromium', 'chromium-headless-shell', 'ffmpeg'}:
            continue
        directory = browser['name'].replace('-', '_') + '-' + browser['revision']
        if not (browsers / directory).is_dir():
            raise RuntimeError(f'Local browser missing: {directory}. No automatic downloads are performed.')
        # Preserve browser framework symlinks and executable modes.
        shutil.copytree(browsers / directory, resources / 'browsers' / directory, symlinks=True)
    copy_file(executable, contents / 'MacOS/eido')
    run(['strip', '-S', contents / 'MacOS/eido'])
    copy_file(ROOT / 'native/branding/Eido.icns', resources / 'Eido.icns')
    for file in (ROOT / 'native').glob('LICENSE*'):
        copy_file(file, resources / 'licenses' / file.name)
    for file in source.glob('*'):
        if file.is_file() and LEGAL.match(file.name):
            copy_file(file, resources / 'licenses/zed' / file.name)
    version = json.loads((ROOT / 'package.json').read_text())['version']
    (runtime / 'eido-runtime.json').write_text(json.dumps({'version': 1, 'pi': '1.0.2', 'acp': '0.9.4',
        'productVersion': version, 'nativeProfile': 'dev', 'testFeatures': False,
        'productionPackages': count, 'sourceFingerprint': record['sourceFingerprint']}))
    with (contents / 'Info.plist').open('wb') as stream:
        plistlib.dump({'CFBundleExecutable': 'eido', 'CFBundleIdentifier': 'dev.eido.app',
            'CFBundleName': 'Eido', 'CFBundleDisplayName': 'Eido', 'CFBundleIconFile': 'Eido.icns',
            'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': version, 'CFBundleVersion': '1',
            'NSHighResolutionCapable': True, 'NSPrincipalClass': 'NSApplication',
            'NSCameraUsageDescription': 'Eido uses the camera only when an enabled tool requests it.',
            'NSMicrophoneUsageDescription': 'Eido uses the microphone only when an enabled tool requests it.'}, stream)
    # Local ad-hoc signature; this is not an Apple-notarized distribution.
    run(['codesign', '--force', '--deep', '--sign', '-', bundle])
    run(['codesign', '--verify', '--deep', '--strict', bundle])
    files = audit(bundle)
    (stage / 'production-manifest.json').write_text(json.dumps({'files': files}, indent=2))
    print(f'Prepared {bundle}: {len(files)} production files; no test/dev payloads.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--audit', type=Path)
    args = parser.parse_args()
    if args.audit:
        files = audit(args.audit)
        print(f'Validated {len(files)} production files.')
    else:
        build()


if __name__ == '__main__':
    main()

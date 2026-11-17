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
import tempfile

ROOT = Path(__file__).resolve().parent.parent
RUNTIME_FILES = (
    'packages/runtime/package.json',
    'packages/runtime/src/lifecycle.mjs', 'packages/runtime/src/paths.mjs',
    'packages/runtime/src/computer.mjs',
    'packages/runtime/src/research/config.mjs', 'packages/runtime/src/research/store.mjs',
    'packages/runtime/src/research/usage.mjs', 'packages/runtime/src/research/client.mjs',
    'packages/runtime/src/research/ocr.mjs',
    'packages/runtime/src/browser/config.mjs', 'packages/runtime/src/browser/server.mjs',
    'packages/runtime/src/browser/text-model.mjs',
    'packages/runtime/src/browser/ultrafast/agent.js', 'packages/runtime/src/browser/ultrafast/browser.js', 'packages/runtime/src/browser/ultrafast/model.js', 'packages/runtime/src/browser/ultrafast/types.js', 'packages/runtime/src/browser/ultrafast/transport.js', 'packages/runtime/src/browser/ultrafast/questions.js', 'packages/runtime/src/browser/ultrafast/scripts.js', 'packages/runtime/src/browser/ultrafast/snapshot.js', 'packages/runtime/src/browser/ultrafast/LICENSE',
    'packages/runtime/src/browser/ultrafast/render.js',
    'packages/runtime/src/browser/ultrafast/index.js', 'packages/runtime/src/browser/ultrafast/recording.js',
    'packages/runtime/src/browser/ultrafast/json.js', 'packages/runtime/src/browser/ultrafast/inspector.js', 'packages/runtime/src/browser/ultrafast/verification.js',
    'packages/runtime/src/browser/ultrafast/static/index.html', 'packages/runtime/src/browser/ultrafast/static/app.js', 'packages/runtime/src/browser/ultrafast/static/style.css', 'packages/runtime/src/browser/ultrafast/static/scenarios.html',
    'packages/runtime/src/pi/settings.mjs', 'packages/runtime/src/pi/custom-models.mjs', 'packages/runtime/src/pi/extensions.mjs',
    'packages/runtime/src/pi/http-settings.mjs', 'packages/runtime/src/pi/runtime-settings.mjs',
    'packages/runtime/src/pi/model-catalog.mjs', 'packages/runtime/src/pi/bundled-one-code.mjs',
    'packages/runtime/src/mcp/config.mjs', 'packages/runtime/src/mcp/status.mjs',
    'packages/runtime/src/mcp/poki.mjs',
    'packages/runtime/bin/pi-settings.mjs', 'packages/runtime/bin/pi-extensions.mjs',
    'packages/runtime/bin/browser-agent.mjs',
    'packages/runtime/bin/poki-connect.mjs',
    'packages/runtime/bin/mcp-auth.mjs', 'packages/runtime/bin/browser-server.mjs',
    'packages/acp/bin/component-terminal.mjs',
    'packages/acp/helpers/preview/server.mjs', 'packages/acp/helpers/preview/command.mjs',
    'packages/acp/helpers/preview/project.mjs',
)
RUNTIME_COMPILED = tuple(name for name in RUNTIME_FILES if '/ultrafast/' in name and name.endswith('.js') and not name.endswith('/snapshot.js') and '/static/' not in name)
RUNTIME_MODULE_ROOTS = ('packages/runtime', 'packages/acp/bin', 'packages/acp/helpers')
EXCLUDED = {'test', 'tests', '__tests__', '__mocks__', 'fixtures', '__fixtures__',
            'examples', 'example', 'bench', 'benchmark', 'benchmarks', 'coverage',
            '.git', '.github', '.local', 'local-docs', 'test-results',
            'test-support', 'browser-test', 'system-test'}
LEGAL = re.compile(r'^(licen[cs]e|copying|copyright|notice|authors|third[-_]?party)', re.I)
# "spec" also means dependency specifier and protocol specification in production.
TEST_FILE = re.compile(r'(^|[._-])(test|fixture)([._-]|$)|\.spec\.[cm]?[jt]sx?$', re.I)
PRODUCTION_TEST_ENTRYPOINTS = (
    'npm/lib/commands/test.js', 'npm/lib/commands/install-test.js',
    'npm/lib/commands/install-ci-test.js',
    'node_modules/playwright/test.js', 'node_modules/playwright/test.mjs',
    'node_modules/playwright/lib/mcp/test/testBackend.js',
    'node_modules/playwright/lib/mcp/test/testContext.js',
    'node_modules/playwright/lib/mcp/test/testTool.js',
    'node_modules/playwright/lib/mcp/test/testTools.js',
)


def is_test_payload(path):
    if not TEST_FILE.search(path.name):
        return False
    name = path.as_posix()
    # copy_tree(npm, ...) receives paths relative to npm; audit sees the full bundle.
    if name in {'lib/commands/test.js', 'lib/commands/install-test.js', 'lib/commands/install-ci-test.js'}:
        return False
    return not any(name == entry or name.endswith('/' + entry) for entry in PRODUCTION_TEST_ENTRYPOINTS)


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


ONE_CODE_RUNTIME = 'packages/acp/bundled/one-code/'


def is_one_code_runtime(path):
    name = path.as_posix()
    marker = ONE_CODE_RUNTIME
    if marker not in name:
        return False
    prefix, relative = name.split(marker, 1)
    if prefix not in ('', 'Contents/Resources/runtime/'):
        return False
    local = Path(relative)
    if has_excluded_part(local) or is_test_payload(local) or local.suffix in {'.map', '.py', '.rs'}:
        return False
    if relative in {'package.json', 'LICENSE', 'eido-manifest.json'}:
        return True
    return (relative.startswith(('extensions/', 'eido/')) and local.suffix in {'.ts', '.mjs', '.js', '.json', '.wasm'}
            or relative.startswith(('profile/', 'docs/guide/')) and local.suffix in {'.ts', '.mjs', '.js', '.json', '.md', '.png', '.svg', '.txt', '.css', '.html', '.wasm'})


def dependency_filter(path):
    if is_one_code_runtime(path):
        return True
    # The canonical executable copy is bundled/one-code, never npm autoload.
    if 'one-code-extension' in path.parts:
        return path.parts[path.parts.index('one-code-extension') + 1:] in {('package.json',), ('LICENSE',)}
    if has_excluded_part(path) or is_test_payload(path):
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


def has_excluded_part(path):
    parts = path.parts
    return any(part in EXCLUDED and not (part == 'test' and
        parts[max(0, i - 4):i + 1] == ('node_modules', 'playwright', 'lib', 'mcp', 'test'))
        for i, part in enumerate(parts))


def copy_tree(source, target, accept=lambda path: True, prefix=Path(), skip_modules=False):
    for current, directories, files in os.walk(source, followlinks=False):
        relative = Path(current).relative_to(source)
        directories[:] = [name for name in directories if (name not in EXCLUDED or name == 'test' and (prefix / relative / name).as_posix() == 'node_modules/playwright/lib/mcp/test') and not name.startswith('.')
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
        if has_excluded_part(local) or is_test_payload(local):
            raise RuntimeError(f'Non-production file in application: {local}')
        if file.is_symlink():
            if not file.resolve().is_relative_to(bundle.resolve()) or not file.exists():
                raise RuntimeError(f'Invalid application symlink: {local}')
            continue
        if file.suffix in {'.ts', '.mts', '.cts', '.map', '.py', '.rs'} and not is_one_code_runtime(local):
            raise RuntimeError(f'Development source in application: {local}')
        if file.is_relative_to(runtime / 'scripts'):
            raise RuntimeError(f'Development script in application: {local}')
        if any(file.is_relative_to(runtime / root) for root in RUNTIME_MODULE_ROOTS):
            if str(file.relative_to(runtime)) not in RUNTIME_FILES:
                raise RuntimeError(f'Unlisted runtime module: {local}')
        if file.is_relative_to(runtime) and file.suffix in {'.js', '.mjs', '.cjs', '.ts'}:
            text = file.read_text(errors='replace')
            if str(ROOT) in text:
                raise RuntimeError(f'Checkout path in runtime: {local}')
        files.append({'path': str(local), 'bytes': file.stat().st_size,
                      'sha256': digest(file)})
    return files


def verified_native_bundle(bundle, source_fingerprint):
    bundle = bundle.expanduser().resolve()
    with (bundle / 'Contents/Info.plist').open('rb') as stream:
        if plistlib.load(stream).get('CFBundleIdentifier') != 'dev.eido.app':
            raise RuntimeError('The native bundle must be an audited Eido application')
    previous = json.loads((bundle / 'Contents/Resources/runtime/eido-runtime.json').read_text())
    if previous.get('sourceFingerprint') != source_fingerprint or previous.get('testFeatures') is not False:
        raise RuntimeError('The native bundle does not match the current production source')
    manifest = json.loads((bundle.parent / 'production-manifest.json').read_text())
    if audit(bundle) != manifest.get('files'):
        raise RuntimeError('The native bundle differs from its production manifest')
    return bundle / 'Contents/MacOS/eido'


def build(native_bundle=None):
    spec = importlib.util.spec_from_file_location('eido_native', ROOT / 'scripts/native.py')
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    record = json.loads((ROOT / '.local/native-build.json').read_text())
    executable = ROOT / '.local/native-target/debug/eido'
    source_fingerprint = native.source_fingerprint()
    if record['sourceFingerprint'] != source_fingerprint:
        raise RuntimeError('Build the current native product with npm run native:build first')
    with tempfile.TemporaryDirectory(prefix='eido-package-native-', dir=ROOT / '.local') as temporary:
        if native_bundle is not None:
            previous = verified_native_bundle(native_bundle, source_fingerprint)
            run(['codesign', '--verify', '--deep', '--strict', native_bundle])
            # Preserve the verified binary before replacing the staging folder.
            executable = Path(temporary) / 'eido'
            copy_file(previous, executable)
            print('Reusing the audited native editor; rebuilding the application runtime.')
        elif not executable.is_file() or record['binarySha256'] != native.digest(executable):
            raise RuntimeError('Build the current native product with npm run native:build first')
        build_payload(native, record, executable)


def build_payload(native, record, executable):
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
    copy_tree(ROOT / 'packages/acp/adapter', runtime / 'packages/acp/adapter',
              lambda path: path.suffix == '.js' or path.name in {'package.json', 'LICENSE'})
    (runtime / 'package.json').write_text(json.dumps({'name': 'eido-runtime', 'private': True, 'type': 'module',
                                                  'license': 'GPL-3.0-or-later'}))
    for name in RUNTIME_FILES:
        if name in RUNTIME_COMPILED:
            if not (runtime / name).is_file():
                raise RuntimeError(f'Missing compiled browser module: {name}')
            continue
        copy_file(ROOT / name, runtime / name)
    for name in RUNTIME_FILES:
        if name.endswith('.mjs'):
            module = runtime / name
            module.write_text(re.sub(r"(ultrafast/[a-z]+)\.ts", r"\1.js", module.read_text()))
    count = copy_dependencies(ROOT, runtime) + copy_dependencies(ROOT / 'packages/acp', runtime / 'packages/acp')
    with tempfile.TemporaryDirectory(prefix='eido-one-code-package-') as directory:
        generated = Path(directory) / 'one-code'
        run([node, ROOT / 'scripts/setup/one-code.mjs', generated, '--production'], cwd=ROOT)
        one_code = json.loads((generated / 'eido-manifest.json').read_text())
        copy_tree(generated, runtime / 'packages/acp/bundled/one-code', dependency_filter, Path('packages/acp/bundled/one-code'))
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
    spec = importlib.util.spec_from_file_location('eido_cua', ROOT / 'scripts/cua.py')
    cua = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cua)
    copy_file(cua.verified_binary(), contents / 'Helpers/cua-driver-local')
    run(['strip', '-S', contents / 'Helpers/cua-driver-local'])
    copy_file(ROOT / 'native/cua/LICENSE-MIT', resources / 'licenses/cua/LICENSE-MIT')
    copy_file(ROOT / 'native/branding/Eido.icns', resources / 'Eido.icns')
    for name in ('LICENSE', 'NOTICE'):
        copy_file(ROOT / name, resources / 'licenses' / name)
    for file in (ROOT / 'native').glob('LICENSE*'):
        copy_file(file, resources / 'licenses' / file.name)
    for file in source.glob('*'):
        if file.is_file() and LEGAL.match(file.name):
            copy_file(file, resources / 'licenses/zed' / file.name)
    version = json.loads((ROOT / 'package.json').read_text())['version']
    (runtime / 'eido-runtime.json').write_text(json.dumps({'version': 1, 'pi': '1.5.2', 'acp': '0.9.4',
        'oneCode': {'upstreamVersion': one_code['upstreamVersion'], 'compatibilityRevision': one_code['compatibilityRevision'], 'integrity': one_code['integrity']},
        'productVersion': version, 'nativeProfile': 'dev', 'testFeatures': False,
        'productionPackages': count, 'sourceFingerprint': record['sourceFingerprint'],
        'computerDriver': json.loads(cua.RECORD.read_text())}))
    with (contents / 'Info.plist').open('wb') as stream:
        plistlib.dump({'CFBundleExecutable': 'eido', 'CFBundleIdentifier': 'dev.eido.app',
            'CFBundleName': 'Eido', 'CFBundleDisplayName': 'Eido', 'CFBundleIconFile': 'Eido.icns',
            'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': version.split('-')[0], 'CFBundleVersion': version.split('-')[0],
            'NSHighResolutionCapable': True, 'NSPrincipalClass': 'NSApplication',
            'NSCameraUsageDescription': 'Eido uses the camera only when an enabled tool requests it.',
            'NSMicrophoneUsageDescription': 'Eido uses the microphone only when an enabled tool requests it.',
            'NSScreenCaptureUsageDescription': 'Eido captures the selected application window when you enable Computer Use.',
            'NSAppleEventsUsageDescription': 'Eido controls applications only when you enable Computer Use.'}, stream)
    # Local ad-hoc signature; this is not an Apple-notarized distribution.
    run(['codesign', '--force', '--deep', '--sign', '-', bundle])
    run(['codesign', '--verify', '--deep', '--strict', bundle])
    # Exercise the native bundle bootstrap too: ACP smoke checks alone cannot
    # detect a native manifest/version mismatch that prevents the app opening.
    with tempfile.TemporaryDirectory(prefix='eido-package-startup-') as temporary:
        env = {**os.environ, 'EIDO_USER_DATA_DIR': temporary,
               'EIDO_PI_CONFIG_DIR': str(Path(temporary) / 'pi')}
        subprocess.run([str(contents / 'MacOS/eido'), '--help'],
                       env=env, check=True, timeout=30)
    files = audit(bundle)
    (stage / 'production-manifest.json').write_text(json.dumps({'files': files}, indent=2))
    print(f'Prepared {bundle}: {len(files)} production files; no test/dev payloads.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--audit', type=Path)
    parser.add_argument('--native-bundle', type=Path,
                        help='Reuse an audited native editor with unchanged source and a matching production manifest')
    args = parser.parse_args()
    if args.audit:
        files = audit(args.audit)
        print(f'Validated {len(files)} production files.')
    else:
        build(args.native_bundle)


if __name__ == '__main__':
    main()

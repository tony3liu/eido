import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('package_app', Path(__file__).resolve().parents[1] / 'package-app.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class ProductionPackageTests(unittest.TestCase):
    def test_filtered_playwright_cli_keeps_its_production_mcp_modules(self):
        with tempfile.TemporaryDirectory(prefix='eido-package-playwright-') as directory:
            root = Path(directory)
            for name in ('playwright', 'playwright-core'):
                package.copy_tree(package.ROOT / 'node_modules' / name, root / 'node_modules' / name,
                                  package.dependency_filter, Path('node_modules') / name)
            result = subprocess.run([shutil.which('node'), root / 'node_modules/playwright/cli.js', '--version'],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('Version', result.stdout)
            self.assertFalse(package.dependency_filter(Path('node_modules/playwright/lib/mcp/test/fixtures/private.js')))

    def test_runtime_modules_are_complete_and_development_scripts_are_excluded(self):
        expected = set()
        for root in package.RUNTIME_MODULE_ROOTS:
            expected.update(str(path.relative_to(package.ROOT))
                            for path in (package.ROOT / root).rglob('*.mjs')
                            if 'test' not in path.parts)
        expected.add('packages/runtime/package.json')
        self.assertEqual(set(package.RUNTIME_FILES), expected)
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / 'Eido.app'
            runtime = bundle / 'Contents/Resources/runtime'
            for name in package.RUNTIME_FILES:
                package.copy_file(package.ROOT / name, runtime / name)
            self.assertEqual(len(package.audit(bundle)), len(expected))
            for name, error in [('scripts/setup/acp.mjs', 'Development script'),
                                ('packages/runtime/src/accidental.mjs', 'Unlisted runtime module')]:
                file = runtime / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('export {};')
                with self.assertRaisesRegex(RuntimeError, error):
                    package.audit(bundle)
                file.unlink()

    def test_runtime_manifest_and_licenses_survive_without_test_sources(self):
        self.assertTrue(package.dependency_filter(Path('node_modules/@earendil-works/pi-ai/dist/providers/data/.manifest.json')))
        self.assertTrue(package.dependency_filter(Path('node_modules/library/LICENSE.md')))
        self.assertTrue(package.dependency_filter(Path('node_modules/@npmcli/metavuln-calculator/lib/get-dep-spec.js')))
        self.assertTrue(package.dependency_filter(Path('node_modules/@npmcli/arborist/lib/spec-from-lock.js')))
        self.assertTrue(package.dependency_filter(Path('node_modules/@modelcontextprotocol/sdk/dist/esm/spec.types.js')))
        self.assertTrue(package.dependency_filter(Path('lib/commands/test.js')))
        self.assertTrue(package.dependency_filter(Path('node_modules/playwright/test.mjs')))
        for path in ('test/run.js', 'dist/client.test.js', 'dist/client.spec.js', 'src/a.ts', 'dist/a.js.map', '.env', 'local-docs/plan.md',
                     'node_modules/library/test.js', 'dist/test-support/agent.js', 'dist/browser-test/runner.js',
                     'node_modules/library/test-core-js.js', 'dist/system-test/test.install.js'):
            self.assertFalse(package.dependency_filter(Path(path)), path)

    def test_filtered_npm_can_install_an_offline_local_package(self):
        npm = Path(shutil.which('npm')).resolve().parent.parent
        self.assertEqual(json.loads((npm / 'package.json').read_text())['name'], 'npm')
        with tempfile.TemporaryDirectory(prefix='eido-package-npm-') as directory:
            root = Path(directory)
            package.copy_tree(npm, root / 'npm', package.dependency_filter)
            fixture = root / 'fixture'
            fixture.mkdir()
            (fixture / 'package.json').write_text(json.dumps({'name': 'eido-local-package-check', 'version': '1.0.0'}))
            (fixture / 'index.js').write_text('module.exports = 42;')
            project = root / 'project'
            project.mkdir()
            (project / 'package.json').write_text('{"private":true}')
            for name in ('user.npmrc', 'global.npmrc'):
                (root / name).write_text('')
            result = subprocess.run([
                shutil.which('node'), root / 'npm/bin/npm-cli.js', 'install', '--offline',
                '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--install-links',
                '--cache', str(root / 'cache'), '--userconfig', str(root / 'user.npmrc'),
                '--globalconfig', str(root / 'global.npmrc'),
                str(fixture),
            ], cwd=project, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((project / 'node_modules/eido-local-package-check/index.js').read_text(), 'module.exports = 42;')

    def test_lockfile_selects_only_production_packages_and_bins(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'source', Path(directory) / 'target'
            source.mkdir()
            for name in ('production', 'development'):
                root = source / 'node_modules' / name
                (root / 'tests').mkdir(parents=True)
                (root / 'package.json').write_text(json.dumps({'name': name, 'bin': {'tool': 'index.js'}}))
                (root / 'index.js').write_text('export {};')
                (root / 'tests/private.test.js').write_text('never install')
            (source / 'package-lock.json').write_text(json.dumps({'packages': {
                '': {}, 'node_modules/production': {}, 'node_modules/development': {'dev': True},
            }}))
            self.assertEqual(package.copy_dependencies(source, target), 1)
            self.assertFalse((target / 'node_modules/development').exists())
            self.assertFalse((target / 'node_modules/production/tests').exists())
            self.assertEqual((target / 'node_modules/.bin/tool').resolve(), (target / 'node_modules/production/index.js').resolve())

    def test_audit_rejects_private_payloads_and_escaping_links(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / 'Eido.app'
            payload = bundle / 'Contents/Resources/local-docs/plan.md'
            payload.parent.mkdir(parents=True)
            payload.write_text('private')
            with self.assertRaisesRegex(RuntimeError, 'Non-production'):
                package.audit(bundle)
            payload.unlink()
            link = bundle / 'Contents/outside'
            link.symlink_to('/etc/hosts')
            with self.assertRaisesRegex(RuntimeError, 'Invalid application symlink'):
                package.audit(bundle)


if __name__ == '__main__':
    unittest.main()

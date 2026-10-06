import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('package_app', Path(__file__).resolve().parents[1] / 'package-app.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class ProductionPackageTests(unittest.TestCase):
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
        for path in ('test/run.js', 'dist/client.test.js', 'src/a.ts', 'dist/a.js.map', '.env', 'local-docs/plan.md'):
            self.assertFalse(package.dependency_filter(Path(path)), path)

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

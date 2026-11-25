"""Exercise untrusted model archives without downloading or changing user models."""
import importlib.util
import pathlib
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('model_data', pathlib.Path(__file__).with_name('install-model-data.py'))
model_data = importlib.util.module_from_spec(spec)
spec.loader.exec_module(model_data)


class ModelDataTests(unittest.TestCase):
    def archive(self, directory, entries):
        path = directory / 'model.zip'
        with zipfile.ZipFile(path, 'w') as archive:
            for name, data in entries:
                archive.writestr(name, data)
        return path

    def test_translation_weights_are_kept(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive = self.archive(root, [('translate/model.bin', b'weights'), ('translate/metadata.json', b'{}'), ('translate/tokenizer.model', b'tokens')])
            model_data.extract(archive, root / 'models')
            self.assertEqual((root / 'models/translate/model.bin').read_bytes(), b'weights')

    def test_invalid_archive_writes_no_partial_model(self):
        for name, data in [('../escaped', b'x'), ('/absolute', b'x'), ('model/run.py', b'print(1)'), ('model/library.bin', b'\x7fELFcode'), ('C:\\outside', b'x')]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                archive = self.archive(root, [('model/metadata.json', b'{}'), (name, data)])
                with self.assertRaises(ValueError):
                    model_data.extract(archive, root / 'models')
                self.assertFalse(list((root / 'models').rglob('*')))

    def test_existing_symlink_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            destination = root / 'models'
            destination.mkdir()
            outside = root / 'outside'
            outside.write_bytes(b'preserved')
            (destination / 'model.bin').symlink_to(outside)
            archive = self.archive(root, [('model.bin', b'bad')])
            with self.assertRaises(ValueError):
                model_data.extract(archive, destination)
            self.assertEqual(outside.read_bytes(), b'preserved')

    def test_archive_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            entry = zipfile.ZipInfo('model/link')
            entry.create_system = 3
            entry.external_attr = 0o120777 << 16
            archive = self.archive(root, [(entry, b'../outside')])
            with self.assertRaises(ValueError):
                model_data.extract(archive, root / 'models')


if __name__ == '__main__':
    unittest.main()

"""Run with Python 3.10+: tests adapter routing without installing musicdl."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

path = Path(__file__).resolve().parents[1] / 'src/music/musicdl-worker.py'
tree = ast.parse(path.read_text(encoding='utf8'), filename=str(path))
# Load only definitions and imports, excluding the production RPC/initialization loop.
definitions = [item for item in tree.body if isinstance(item, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.ClassDef))]
scope = {'PROTOCOL_OUT': None, 'CLIENTS': {}, 'NAMES': {}}
exec(compile(ast.Module(body=definitions, type_ignores=[]), str(path), 'exec'), scope)
scope['emit'] = Mock()

def song(identifier='123', valid=True):
    return SimpleNamespace(identifier=identifier, raw_data={'search': {'id': identifier}}, download_url='https://music.example/full.flac', protocol='HTTP', with_valid_download_url=valid, default_download_headers={}, default_download_cookies={})

def client(cookie=None):
    return SimpleNamespace(default_parse_headers={}, default_parse_cookies=cookie or {}, _parsewiththirdpartapis=Mock(return_value=song()), _parsewithofficialapiv1=Mock(return_value=song()))

class AdapterTests(unittest.TestCase):
    track = {'platform': 'netease', 'externalId': '123'}

    def test_guest_alternate_precedes_official_preview(self):
        provider = client()
        result = scope['resolve_exact'](self.track, provider)
        self.assertEqual(result['url'], 'https://music.example/full.flac')
        provider._parsewiththirdpartapis.assert_called_once()
        provider._parsewithofficialapiv1.assert_not_called()

    def test_invalid_alternate_falls_back_to_same_official_id(self):
        provider = client()
        provider._parsewiththirdpartapis.return_value = song(valid=False)
        scope['resolve_exact'](self.track, provider)
        self.assertEqual(provider._parsewithofficialapiv1.call_args.kwargs['search_result']['id'], '123')

    def test_login_credentials_never_sent_to_public_alternate(self):
        provider = client({'MUSIC_U': 'test-login'})
        scope['resolve_exact'](self.track, provider)
        provider._parsewiththirdpartapis.assert_not_called()
        provider._parsewithofficialapiv1.assert_called_once()

    def test_mismatched_id_rejected(self):
        provider = client()
        provider._parsewiththirdpartapis.return_value = song('456')
        with self.assertRaisesRegex(ValueError, 'ID'):
            scope['resolve_exact'](self.track, provider)

    def test_alternate_exception_reported_and_official_still_called(self):
        provider = client()
        provider._parsewiththirdpartapis.side_effect = TimeoutError('unavailable')
        scope['resolve_exact'](self.track, provider)
        provider._parsewithofficialapiv1.assert_called_once()
        self.assertEqual(scope['emit'].call_args.args[0]['event'], 'musicdl.alternate.failed')

if __name__ == '__main__':
    unittest.main()

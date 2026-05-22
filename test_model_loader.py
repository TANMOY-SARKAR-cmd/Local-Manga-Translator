import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.append('server')
import model_loader

class TestTranslationEngine(unittest.TestCase):
    def test_lock_initialization(self):
        engine = model_loader.TranslationEngine()
        self.assertTrue(hasattr(engine, 'lock'))
        self.assertEqual(type(engine.lock), type(model_loader.threading.Lock()))

if __name__ == '__main__':
    unittest.main()

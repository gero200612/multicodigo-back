"""Las reglas puras de mc-autodeploy.py. Correr: python3 -m unittest docs/vps/test_mc_autodeploy.py"""
import importlib.util
import os
import unittest

_ruta = os.path.join(os.path.dirname(__file__), 'mc-autodeploy.py')
_spec = importlib.util.spec_from_file_location('mc_autodeploy', _ruta)
m = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(m)


class Reglas(unittest.TestCase):
    def test_vigila_solo_las_de_fuente_publica(self):
        self.assertTrue(m.es_de_fuente_publica({'git_repository': 'https://github.com/gero200612/multicodigo-back', 'source_id': 0}))
        self.assertFalse(m.es_de_fuente_publica({'git_repository': 'Sincro-arg/TallerPro-back', 'source_id': 3}))
        self.assertFalse(m.es_de_fuente_publica({'git_repository': None, 'source_id': 0}))

    def test_repo_desde_la_url(self):
        self.assertEqual(m.repo_de({'git_repository': 'https://github.com/gero200612/multicodigo-back.git'}), 'gero200612/multicodigo-back')
        self.assertEqual(m.repo_de({'git_repository': 'gero200612/sincro-web'}), 'gero200612/sincro-web')

    def test_sincro_wa_solo_con_cambios_en_su_carpeta(self):
        carpeta = m.carpeta_de({'base_directory': '/sincro-wa'})
        self.assertEqual(carpeta, 'sincro-wa/')
        self.assertTrue(m.toca_la_carpeta(['bridge/src/vps.ts', 'sincro-wa/src/db.ts'], carpeta))
        self.assertFalse(m.toca_la_carpeta(['bridge/src/vps.ts', 'homero/src/api.ts'], carpeta))
        # "sincro-wa-otra/" no es "sincro-wa/".
        self.assertFalse(m.toca_la_carpeta(['sincro-wa-otra/x'], carpeta))

    def test_una_app_que_es_el_repo_entero_se_despliega_con_cualquier_cambio(self):
        self.assertEqual(m.carpeta_de({'base_directory': '/'}), '')
        self.assertTrue(m.toca_la_carpeta(['index.html'], ''))

    def test_sha_de_ls_remote(self):
        salida = 'abc123\trefs/heads/main\ndef456\trefs/heads/mainline\n'
        self.assertEqual(m.sha_de_ls_remote(salida, 'main'), 'abc123')
        self.assertIsNone(m.sha_de_ls_remote(salida, 'dev'))


if __name__ == '__main__':
    unittest.main()
